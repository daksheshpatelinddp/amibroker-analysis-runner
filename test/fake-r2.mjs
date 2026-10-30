// A small stand-in for the R2 bucket in the "pack" layout (what convert.py writes), served over HTTP with Range support.
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import zlib from 'node:zlib'; import os from 'node:os';

// pack format v2 (what convert.py writes now): int32 volume / delivery (-1 = unknown), the 7*n int32 values regrouped into 4 byte-planes
function encodeBlockV2(days, o, h, l, c, v) {
  const n = days.length, scale = 100;
  const cs = c.map((x) => Math.round(x * scale));
  const dd = days.map((d, i) => d - (i ? days[i - 1] : 0)), cd = cs.map((x, i) => x - (i ? cs[i - 1] : 0));
  const oc = o.map((x, i) => Math.round(x * scale) - cs[i]), hc = h.map((x, i) => Math.round(x * scale) - cs[i]), lc = l.map((x, i) => Math.round(x * scale) - cs[i]);
  const words = Buffer.from(Int32Array.from([...dd, ...cd, ...oc, ...hc, ...lc, ...v.map((x) => Math.round(x)), ...new Array(n).fill(-1)]).buffer);
  const planes = Buffer.alloc(words.length); const W = words.length / 4;
  for (let i = 0; i < W; i++) for (let k = 0; k < 4; k++) planes[k * W + i] = words[i * 4 + k];
  const head = Buffer.alloc(12); head[0] = 0x41; head[1] = 0x42; head[2] = 2; head[3] = 1; head.writeUInt32LE(n, 4); head.writeInt32LE(scale, 8);
  return zlib.deflateSync(Buffer.concat([head, planes]));
}

function encodeBlock(days, o, h, l, c, v) {
  if (process.env.PACK_VERSION === '2') return encodeBlockV2(days, o, h, l, c, v);
  const n = days.length, scale = 100, i32 = (arr) => Buffer.from(Int32Array.from(arr).buffer);
  const cs = c.map((x) => Math.round(x * scale));
  const dd = days.map((d, i) => d - (i ? days[i - 1] : 0)), cd = cs.map((x, i) => x - (i ? cs[i - 1] : 0));
  const oc = o.map((x, i) => Math.round(x * scale) - cs[i]), hc = h.map((x, i) => Math.round(x * scale) - cs[i]), lc = l.map((x, i) => Math.round(x * scale) - cs[i]);
  const head = Buffer.alloc(12); head[0] = 0x41; head[1] = 0x42; head[2] = 1; head[3] = 1; head.writeUInt32LE(n, 4); head.writeInt32LE(scale, 8);
  let body = Buffer.concat([head, i32(dd), i32(cd), i32(oc), i32(hc), i32(lc)]);
  const pad = (8 - (body.length % 8)) % 8; body = Buffer.concat([body, Buffer.alloc(pad), Buffer.from(Float64Array.from(v).buffer), Buffer.from(new Float64Array(n).fill(NaN).buffer)]);
  return zlib.deflateSync(body);
}

export function makeBars(k, N = 500) {
  const days = Array.from({ length: N }, (_, i) => Math.floor(Date.UTC(2023, 0, 2) / 86400000) + i + Math.floor(i / 5) * 2);   // weekdays-ish
  const c = Array.from({ length: N }, (_, i) => 100 + k * 3 + Math.sin(i / 9 + k) * 10 + Math.sin(i / 40) * 15 + i * 0.05);
  return { days, o: c.map((x) => x - 0.4), h: c.map((x) => x + 1), l: c.map((x) => x - 1), c, v: c.map((_, i) => 1000 + i) };
}

export function buildFakeR2(symbols, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-r2-'))) {
  fs.mkdirSync(path.join(dir, 'packs'), { recursive: true });
  const hist = [], recent = []; let hOff = 0, rOff = 0; const hIdx = {}, rIdx = {};
  symbols.forEach((s, k) => {
    const b = makeBars(k), n = b.days.length, cut = n - 60;
    const hb = encodeBlock(b.days.slice(0, cut), b.o.slice(0, cut), b.h.slice(0, cut), b.l.slice(0, cut), b.c.slice(0, cut), b.v.slice(0, cut));
    const rb = encodeBlock(b.days.slice(cut - 5), b.o.slice(cut - 5), b.h.slice(cut - 5), b.l.slice(cut - 5), b.c.slice(cut - 5), b.v.slice(cut - 5));   // overlaps 5 bars: the recent block wins
    hIdx[s] = [hOff, hb.length, cut]; hist.push(hb); hOff += hb.length; rIdx[s] = [rOff, rb.length, 65]; recent.push(rb); rOff += rb.length;
  });
  fs.writeFileSync(path.join(dir, 'packs', 'b0.pack'), Buffer.concat(hist)); fs.writeFileSync(path.join(dir, 'recent.pack'), Buffer.concat(recent));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ format: 2, fingerprint: 'fp1', firstYear: 2000, histThrough: 2024, currentYear: 2025, histPath: 'hist', buckets: { b0: { symbols } }, packs: { path: 'packs', buckets: { b0: { idx: hIdx } } }, aliases: {} }));
  fs.writeFileSync(path.join(dir, 'recent.json'), JSON.stringify({ format: 1, file: 'recent.pack', token: 't1', bars: 65, idx: rIdx }));
  return dir;
}

export function serve(dir) {
  const hits = [];
  const server = http.createServer((q, r) => {
    hits.push(q.method + ' ' + q.url.split('?')[0]);
    const f = path.join(dir, decodeURIComponent(q.url.split('?')[0]));
    fs.readFile(f, (e, buf) => {
      if (e) { r.writeHead(404); r.end(); return; }
      const m = /bytes=(\d+)-(\d+)/.exec(q.headers.range || '');
      const st = fs.statSync(f), tagh = { etag: `"${st.size}-${Math.round(st.mtimeMs)}"` };
      if (m) { r.writeHead(206, { 'content-length': +m[2] - +m[1] + 1, ...tagh }); r.end(buf.subarray(+m[1], +m[2] + 1)); } else { r.writeHead(200, { 'content-length': buf.length, ...tagh }); r.end(buf); }
    });
  }).listen(0);
  return new Promise((res) => server.once('listening', () => res({ server, hits, url: `http://localhost:${server.address().port}` })));
}
