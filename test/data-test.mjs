// Run: ENGINE_DIR=/path/to/amibroker-web-engine node --import ./src/register.mjs test/data-test.mjs
// The data is fetched ONCE into a folder; after that no request goes to the data host (R2 / Release), however many machines and runs read it.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { loadEngine, makeLoader } from '../src/engine.mjs'; import { dataKey, syncData, fileUrl, serveDir } from '../src/data.mjs';
import { buildFakeR2, serve } from './fake-r2.mjs';
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const engine = await loadEngine(process.env.ENGINE_DIR || '../amibroker-web-engine');
const syms = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'], dir = buildFakeR2(syms), { server, hits, url } = await serve(dir);
const dataset = { id: 'nse', baseUrl: url }, quiet = () => {};
// key: 2 small requests, stable until the data changes
const k1 = await dataKey(dataset); ok(/^data-nse-fp1-/.test(k1), 'key: ' + k1); ok(hits.length === 2, 'key needs 2 requests: ' + hits.join(', '));
ok(await dataKey(dataset) === k1, 'same data, same key');
// sync once
hits.length = 0; const data = fs.mkdtempSync(path.join(os.tmpdir(), 'data-'));
const info = await syncData(dataset, data, { log: quiet }); ok(info.files.length >= 4 && info.files.every((f) => fs.existsSync(path.join(data, f))), 'files downloaded: ' + info.files);
const first = hits.length; ok(first > 0 && first <= info.files.length + 2, 'one download of every file: ' + first + ' requests');
// a second sync and a loader on the folder: zero requests to the data host
hits.length = 0; await syncData(dataset, data, { log: quiet });
const loader = await makeLoader(engine, dataset, { dataDir: data, log: quiet });
for (const s of syms) { const b = await loader.loadBars(s); ok(b && b.t.length === 500, `bars of ${s} from the local folder`); }
ok(hits.length === 0, 'no request to the data host while reading: ' + hits.length);
// a second loader (another shard in the same process) still no request
const loader2 = await makeLoader(engine, dataset, { dataDir: data, log: quiet }); await loader2.loadBars('BBB'); ok(hits.length === 0, 'second loader no requests');
// a whole job with 3 machines reads only the folder
{
  const { FsStore } = await import('../src/store.mjs'); const { planJob, runShard, mergeJob } = await import('../src/jobs.mjs');
  const store = new FsStore(fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'))); process.env.DATA_DIR = data; hits.length = 0;
  await store.put('jobs/j1/job.json', { v: 1, mode: 'optimize', formulaName: 't', code: 'a = Optimize("a", 5, 5, 9, 1); Buy = Cross(MA(C, a), MA(C, 20)); Sell = Cross(MA(C, 20), MA(C, a));', symbols: syms, interval: 'D', range: { mode: 'all' }, settings: engine.defaultSettings(), metric: 'netProfit', engine: 'exhaustive', maxEval: 20, runs: 1, keep: 0, shards: 3, dataset });
  const { shards } = await planJob(store, 'j1'); for (const i of shards) await runShard(store, engine, 'j1', i, { progressMs: 50 });
  const m = await mergeJob(store, engine, 'j1'); ok(m.state === 'done', 'job done: ' + m.state); ok(hits.length === 0, 'a whole 3-machine job made ' + hits.length + ' requests to the data host');
  delete process.env.DATA_DIR;
}
// data changed -> new key, force sync downloads again
await new Promise((r) => setTimeout(r, 20)); fs.writeFileSync(path.join(dir, 'recent.json'), fs.readFileSync(path.join(dir, 'recent.json'), 'utf8').replace('"t1"', '"t2"'));
ok(await dataKey(dataset) !== k1, 'recent pack changed: new key');
// a release host: flat names
ok(fileUrl({ baseUrl: 'https://r2/x' }, 'packs/b0.pack', 'https://github.com/o/r/releases/download/data/') === 'https://github.com/o/r/releases/download/data/packs__b0.pack', 'release file names are flat');
ok(fileUrl({ baseUrl: 'https://r2/x/' }, 'manifest.json', '') === 'https://r2/x/manifest.json', 'R2 file names');
// local server answers ranges like R2
const s = await serveDir(data); const r = await fetch(s.url + '/recent.json', { headers: { Range: 'bytes=0-9' } }); ok(r.status === 206 && (await r.text()).length === 10, 'range answered'); const nf = await fetch(s.url + '/nope'); ok(nf.status === 404, '404 for a missing file'); const esc = await fetch(s.url + '/..%2f..%2fetc%2fpasswd'); ok(esc.status === 404, 'no path escape'); await s.close();
server.close(); console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
