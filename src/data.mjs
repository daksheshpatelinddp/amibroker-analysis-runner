// The market data for a job: downloaded ONCE per data version into a folder (kept by GitHub's Actions cache), then every machine of every
// job reads that folder through a tiny local web server. R2 (or the GitHub Release you publish) is only touched when the data changed.
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
import { Readable } from 'node:stream'; import { pipeline } from 'node:stream/promises';

const MARK = '.sync.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Where a file of the dataset lives: the R2 folder, or flat names in a GitHub Release (a "/" in the name becomes "__"). */
export function fileUrl(dataset, rel, releaseUrl = process.env.DATA_RELEASE_URL || dataset.releaseUrl || '') {
  if (releaseUrl) return `${releaseUrl.replace(/\/+$/, '')}/${rel.replace(/\//g, '__')}`;
  return `${dataset.baseUrl.replace(/\/+$/, '')}/${rel}`;
}

/** Files of the pack layout: manifest.json, recent.json, the recent pack and one pack per history bucket. */
export function packFiles(manifest, recent) {
  if (!manifest || !manifest.packs) throw new Error('The data has no "pack" layout (manifest.json with packs). Run the convert step of your data workflow.');
  return ['manifest.json', 'recent.json', recent.file, ...Object.keys(manifest.packs.buckets).map((b) => `${manifest.packs.path}/${b}.pack`)];
}

const getJson = async (f, url) => { const r = await f(url, { cache: 'no-store' }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); };

/** A short name of the current data version: changes when the history is rebuilt or the recent pack changes. Two small requests. */
export async function dataKey(dataset, { fetchFn = fetch } = {}) {
  const manifest = await getJson(fetchFn, fileUrl(dataset, 'manifest.json'));
  let tag = '';
  try { const h = await fetchFn(fileUrl(dataset, 'recent.json'), { method: 'HEAD' }); tag = [h.headers.get('etag'), h.headers.get('content-length'), h.headers.get('last-modified')].filter(Boolean).join('|'); } catch (e) { /* below */ }
  if (!tag) { const rec = await getJson(fetchFn, fileUrl(dataset, 'recent.json')); tag = rec.token || ''; }
  return `data-${String(dataset.id || 'nse')}-${manifest.fingerprint || 'x'}-${tag}`.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
}

async function download(fetchFn, url, dest, log) {
  let last = '';
  for (let t = 0; t < 4; t++) {
    try {
      const r = await fetchFn(url); if (!r.ok) { last = `HTTP ${r.status}`; if (r.status === 404) break; await sleep(1500 * (t + 1)); continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest + '.part')); fs.renameSync(dest + '.part', dest); return;
    } catch (e) { last = e.message; await sleep(1500 * (t + 1)); }
  }
  throw new Error(`could not download ${url}: ${last}`);
}

/** Makes sure `dir` holds the current data. Does nothing (and no request) when a complete copy is there already. */
export async function syncData(dataset, dir, { fetchFn = fetch, log = console.log, force = false } = {}) {
  const mark = path.join(dir, MARK);
  if (!force && fs.existsSync(mark)) {
    try { const m = JSON.parse(fs.readFileSync(mark, 'utf8')); if (m.files && m.files.every((f) => fs.existsSync(path.join(dir, f)))) { log(`data: using the copy in ${dir} (${m.files.length} files)`); return m; } } catch (e) { /* download again */ }
  }
  const manifest = await getJson(fetchFn, fileUrl(dataset, 'manifest.json')), recent = await getJson(fetchFn, fileUrl(dataset, 'recent.json'));
  const files = packFiles(manifest, recent); fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(mark, { force: true });
  let bytes = 0;
  for (const f of files) { const dest = path.join(dir, f); await download(fetchFn, fileUrl(dataset, f), dest, log); bytes += fs.statSync(dest).size; }
  const info = { files, fingerprint: manifest.fingerprint, token: recent.token, at: Date.now(), bytes };
  fs.writeFileSync(mark, JSON.stringify(info)); log(`data: downloaded ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB`);
  return info;
}

/** A static web server for the folder with Range support (what the app's reader needs). Returns { url, close }. */
export function serveDir(dirIn) {
  const dir = path.resolve(dirIn);   // the workflow passes a relative folder ("data")
  const server = http.createServer((q, r) => {
    const rel = decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, ''), f = path.join(dir, rel);
    if (!(f === dir || f.startsWith(dir + path.sep)) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { r.writeHead(404); r.end(); return; }
    const size = fs.statSync(f).size, m = /bytes=(\d*)-(\d*)/.exec(q.headers.range || '');
    if (m && (m[1] || m[2])) {
      let a = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]), b = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
      if (a > b || a >= size) { r.writeHead(416, { 'content-range': `bytes */${size}` }); r.end(); return; }
      r.writeHead(206, { 'content-length': b - a + 1, 'content-range': `bytes ${a}-${b}/${size}`, 'accept-ranges': 'bytes' }); fs.createReadStream(f, { start: a, end: b }).pipe(r);
    } else { r.writeHead(200, { 'content-length': size, 'accept-ranges': 'bytes' }); fs.createReadStream(f).pipe(r); }
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => { server.unref(); res({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((x) => server.close(x)) }); }));
}
