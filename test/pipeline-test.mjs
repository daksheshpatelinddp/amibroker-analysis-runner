// Run: ENGINE_DIR=/path/to/amibroker-web-engine npm test   -- a whole job through plan / shards / merge, compared with one machine doing it all
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { FsStore } from '../src/store.mjs'; import { loadEngine, makeLoader } from '../src/engine.mjs'; import { planJob, runShard, mergeJob } from '../src/jobs.mjs';
import { buildFakeR2, serve } from './fake-r2.mjs';
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const engine = await loadEngine(process.env.ENGINE_DIR || '../amibroker-web-engine'), core = engine.core;
const syms = ['AAA', 'BBB', 'CCC', 'DDD']; const dir = buildFakeR2(syms), { server, url } = await serve(dir);
const dataset = { id: 'nse', baseUrl: url };
const code = `a = Optimize("a", 5, 5, 12, 1); b = Optimize("b", 20, 20, 40, 5); Buy = Cross(MA(C, a), MA(C, b)); Sell = Cross(MA(C, b), MA(C, a));`;
const settings = engine.defaultSettings();
const loader = await makeLoader(engine, dataset); ok(loader.range.mode === 'pack', 'pack layout is read');
const bars = await loader.loadBars('AAA'); ok(bars && bars.t.length === 500 && bars.t[0] === '2023-01-02', 'bars come through the pack reader: ' + (bars && bars.t.length));

const job = (extra) => ({ v: 1, formulaName: 't', code, symbols: syms, interval: 'D', range: { mode: 'all' }, settings, metric: 'netProfit', engine: 'exhaustive', maxEval: 20, runs: 1, keep: 0, shards: 3, dataset, wf: { isLength: 6, isUnit: 'months', oosLength: 2, oosUnit: 'months', anchored: false, start: '', last: '' }, ...extra });
const newStore = () => new FsStore(fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-')));
const runAll = async (store, id, o = {}) => { for (let round = 0; round < 10; round++) { const { shards } = await planJob(store, id); for (const i of shards) await runShard(store, engine, id, i, { progressMs: 50, ...(round === 0 ? o : {}) }); const r = await mergeJob(store, engine, id); if (r.state !== 'continue') return r; } return { state: 'never' }; };

let res1 = null;
// optimize in 3 shards = one machine
{
  const store = newStore(); await store.put('jobs/o1/job.json', job({ mode: 'optimize' }));
  const r = await runAll(store, 'o1'); ok(r.state === 'done', 'optimize job finishes: ' + r.state);
  const res = (await store.get('jobs/o1/result.json')).result; res1 = res;
  const one = await core.optimize({ code, symbols: syms, session: core.makeSession(loader.loadBars, 'D'), range: { mode: 'all' }, settings, metric: 'netProfit', keep: 0 });
  ok(res.combinations === one.combinations && res.rows.length === one.rows.length, `all ${one.combinations} combinations counted once`);
  ok(JSON.stringify(res.rows[0].values) === JSON.stringify(one.rows[0].values) && res.rows[0].stats.netProfit === one.rows[0].stats.netProfit, 'same best row as one machine');
  ok(res.completed === true && (await store.get('jobs/o1/status.json')).state === 'done', 'status says done');
  const pr = await store.get('jobs/o1/progress-0.json'); ok(pr && pr.state === 'done' && pr.total > 0, 'progress file written');
}
// paused by the time limit, continued by the next run, same answer
{
  const store = newStore(); await store.put('jobs/o2/job.json', job({ mode: 'optimize' }));
  const { shards } = await planJob(store, 'o2'); for (const i of shards) await runShard(store, engine, 'o2', i, { deadlineMs: 1, progressMs: 50 });
  const s0 = await store.get('jobs/o2/shard-0.json'); ok(s0.state === 'paused' && s0.resume.next >= 1, 'shard pauses at its time limit (' + s0.state + ')');
  const m = await mergeJob(store, engine, 'o2'); ok(m.state === 'continue' && (await store.get('jobs/o2/status.json')).state === 'continuing', 'merge asks for another run');
  const r = await runAll(store, 'o2'); ok(r.state === 'done', 'second run finishes');
  const a = (await store.get('jobs/o2/result.json')).result, b = res1;
  ok(JSON.stringify(a.rows.map((x) => x.values)) === JSON.stringify(b.rows.map((x) => x.values)) && (await store.get('jobs/o2/status.json')).run === 2, 'paused + continued = uninterrupted (run 2)');
}
// walk-forward in 3 shards = one machine
{
  const store = newStore(); await store.put('jobs/w1/job.json', job({ mode: 'walk' }));
  const r = await runAll(store, 'w1'); ok(r.state === 'done', 'walk-forward job finishes: ' + r.state);
  const res = (await store.get('jobs/w1/result.json')).result;
  const one = await core.walkForward({ code, symbols: syms, session: core.makeSession(loader.loadBars, 'D'), settings, wf: job().wf, metric: 'netProfit' });
  ok(res.steps.length > 1 && JSON.stringify(res.steps.map((s) => s.values)) === JSON.stringify(one.steps.map((s) => s.values)) && res.stats.netProfit === one.stats.netProfit, 'walk-forward: same chosen values and result as one machine');
}
// problems are reported, not hidden
{
  const store = newStore(); await store.put('jobs/n1/job.json', job({ mode: 'optimize', code: 'Buy = Cross(C, MA(C, 10)); Sell = Cross(MA(C, 10), C);' }));
  const r = await runAll(store, 'n1'); const res = (await store.get('jobs/n1/result.json')).result;
  ok(r.state === 'done' && res.rows.length === 0 && /Optimize\(\)/.test(res.errors[0]), 'a formula without Optimize() gives a clear message');
  const bad = newStore(); await bad.put('jobs/i1/job.json', job({ mode: 'optimize', interval: '5m' })); let msg = ''; try { await planJob(bad, 'i1'); } catch (e) { msg = e.message; }
  ok(/Intraday/.test(msg), 'intraday is refused with a reason');
  const sm = newStore(); await sm.put('jobs/s1/job.json', job({ mode: 'optimize', engine: 'smart', maxEval: 15 })); const rr = await runAll(sm, 's1'); const rs = (await sm.get('jobs/s1/result.json')).result;
  ok(rr.state === 'done' && rs.rows.length > 0 && rs.engine === 'smart', 'smart search job works');
}
server.close(); console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
