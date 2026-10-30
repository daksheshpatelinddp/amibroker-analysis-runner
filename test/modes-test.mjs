// Run: ENGINE_DIR=/path/to/amibroker-web-engine node --import ./src/register.mjs test/modes-test.mjs
// Scan / Explore / Backtest through plan / shards / merge (machines share the symbols) = the same answer as one machine running the core directly.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { FsStore } from '../src/store.mjs'; import { loadEngine, makeLoader } from '../src/engine.mjs'; import { planJob, runShard, mergeJob, readJob, jobShards } from '../src/jobs.mjs';
import { nfDecode, gzUnpack } from '../src/nf.mjs';
const readResult = async (store, id) => { const d = await store.get(`jobs/${id}/result.json`); return d && { ...d, result: gzUnpack(d.result) }; };   // a big result is stored compressed
import { buildFakeR2, serve } from './fake-r2.mjs';
process.env.MIN_PER_SHARD = '3';                   // so that 10 symbols are shared out (the real value is 100)
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const engine = await loadEngine(process.env.ENGINE_DIR || '../amibroker-web-engine'), core = engine.core;
const syms = Array.from({ length: 10 }, (_, i) => 'S' + String(i).padStart(2, '0')); const dir = buildFakeR2(syms), { server, url } = await serve(dir);
const dataset = { id: 'nse', baseUrl: url }, settings = engine.defaultSettings();
const loader = await makeLoader(engine, dataset), session = () => core.makeSession(loader.loadBars, 'D');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const newStore = () => new FsStore(fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-')));
const job = (extra) => ({ v: 1, formulaName: 't', symbols: syms, interval: 'D', range: { mode: 'all' }, settings, shards: 4, dataset, ...extra });
async function run(store, id) { for (let round = 0; round < 5; round++) { const { shards } = await planJob(store, id); for (const i of shards) await runShard(store, engine, id, i, { progressMs: 50 }); const r = await mergeJob(store, engine, id); if (r.state !== 'continue') return r; } }

ok(jobShards('backtest', 3000, 8) === 1 && jobShards('scan', 3000, 8) === 8 && jobShards('scan', 7, 8) === 3 && jobShards('explore', 2, 8) === 1 && jobShards('optimize', 10, 8) === 8 && jobShards('optimize', 10, 99) === 20, 'machines per job type (backtest 1, scan/explore few symbols per machine, optimize as asked up to 20)');
{ process.env.MIN_PER_SHARD = ''; ok(jobShards('scan', 250, 8) === 3 && jobShards('explore', 50, 8) === 1 && jobShards('scan', 1000, 8) === 8, 'with the real value: at most one machine per 100 symbols'); process.env.MIN_PER_SHARD = '3'; }

// ---- SCAN
{
  const code = 'Buy = Cross(MA(C, 10), MA(C, 30)); Sell = Cross(MA(C, 30), MA(C, 10));';
  const store = newStore(); await store.put('jobs/sc/job.json', job({ mode: 'scan', code, lastBars: 400 }));
  const r = await run(store, 'sc'); ok(r.state === 'done', 'scan job finishes: ' + r.state);
  const st = await store.get('jobs/sc/status.json'); ok(st.shards === 4, 'scan used 4 machines: ' + st.shards);
  const res = (await readResult(store, 'sc')).result;
  const one = await core.scan({ code, symbols: syms, session: session(), range: { mode: 'all' }, lastBars: 400 });
  ok(one.rows.length > 10 && same(res.rows, one.rows) && same(res.errors, one.errors), `scan: ${one.rows.length} rows, same rows in the same order as one machine`);
  const sh = []; for (let i = 0; i < 4; i++) sh.push((await store.get(`jobs/sc/shard-${i}.json`)).result.rows.length); ok(sh.every((n) => n > 0) && sh.reduce((a, b) => a + b, 0) === one.rows.length, 'every machine got a share: ' + sh);
}
// ---- EXPLORE (with a column that is NaN on early bars, a sort and summary rows)
{
  const code = 'Filter = C > MA(C, 20); AddColumn(C, "Close", 1.2); AddColumn(Ref(C, -30), "C30", 1.2); AddColumn(RSI(14), "RSI", 1.2); SetSortColumns(-3, 1); AddSummaryRows(1 + 8, 1.2);';
  const store = newStore(); await store.put('jobs/ex/job.json', job({ mode: 'explore', code }));
  const r = await run(store, 'ex'); ok(r.state === 'done', 'explore job finishes: ' + r.state);
  const raw = await readResult(store, 'ex'), txt = JSON.stringify(raw); const res = nfDecode(raw.result);
  const one = await core.explore({ code, symbols: syms, session: session(), range: { mode: 'all' } });
  ok(one.table.rows.length > 100, 'explore: ' + one.table.rows.length + ' rows');
  ok(same(res.table.head, one.table.head) && res.table.rows.length === one.table.rows.length, 'explore: same columns and number of rows');
  const norm = (rows) => JSON.stringify(rows, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v));
  ok(norm(res.table.rows) === norm(one.table.rows), 'explore: the same table, row for row, NaN included');
  ok(norm(res.table.summary) === norm(one.table.summary) && one.table.summary.length === 2, 'explore: the same summary rows');
  ok(res.rows.length === one.rows.length && res.rows[0].symbol === one.rows[0].symbol && res.rows[0].date === one.rows[0].date, 'explore: hit list for the chart arrows');
  ok(/"__nf"/.test(txt) && !/"v":null/.test(txt), 'explore: NaN is stored in a form JSON keeps (not as null)');
}
// ---- EXPLORE with more rows than are kept: the table is sorted over ALL rows first, then the best rows are kept; big results are stored compressed
{
  const code = 'Filter = C > MA(C, 20); AddColumn(C, "Close", 1.2); AddColumn(RSI(14), "RSI", 1.2); SetSortColumns(-3, 1); AddSummaryRows(1 + 8, 1.2);';
  const store = newStore(); await store.put('jobs/tr/job.json', job({ mode: 'explore', code, maxRows: 40 }));
  const r = await run(store, 'tr'); ok(r.state === 'done', 'truncated explore finishes');
  const res = nfDecode((await readResult(store, 'tr')).result);
  const one = await core.explore({ code, symbols: syms, session: session(), range: { mode: 'all' } });
  const norm = (rows) => JSON.stringify(rows, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v));
  ok(res.table.rows.length === 40 && res.truncated === one.table.rows.length, `explore: the best 40 of ${res.truncated} sorted rows are kept`);
  ok(norm(res.table.rows) === norm(one.table.rows.slice(0, 40)), 'explore: those are the top rows in the sort order, not the first symbols');
  ok(norm(res.table.summary) === norm(one.table.summary), 'explore: summary rows still cover ALL rows');
  ok(res.rows.length === 40, 'explore: hit list matches the kept rows');
  ok(fs.existsSync(path.join(store.dir, 'jobs/tr/result.json')), 'a result file exists');
  // a big result is stored compressed inside result.json (and every shard file too), and reads back the same
  const big = newStore(); await big.put('jobs/bg/job.json', job({ mode: 'explore', code: 'Filter = 1; AddColumn(C, "Close", 1.2); AddColumn(O, "Open", 1.2); AddColumn(H, "High", 1.2); AddColumn(L, "Low", 1.2);', maxRows: 20000 }));
  await run(big, 'bg'); const fileSize = fs.statSync(path.join(big.dir, 'jobs/bg/result.json')).size, shardSize = fs.statSync(path.join(big.dir, 'jobs/bg/shard-0.json')).size;
  const stored = JSON.parse(fs.readFileSync(path.join(big.dir, 'jobs/bg/result.json'), 'utf8'));
  ok(typeof stored.result.gz === 'string' && stored.result.raw > 1e6 && fileSize < stored.result.raw / 4, `a big result is stored compressed: ${(stored.result.raw / 1e6).toFixed(1)} MB of rows in a ${(fileSize / 1e6).toFixed(2)} MB file`);
  ok(JSON.parse(fs.readFileSync(path.join(big.dir, 'jobs/bg/shard-0.json'), 'utf8')).result.gz && shardSize < 2e6, 'a shard file with many rows is compressed too: ' + (shardSize / 1e6).toFixed(2) + ' MB');
  const back = await readResult(big, 'bg'); ok(back && back.result.table.rows.length >= 5000, 'the compressed result reads back: ' + back.result.table.rows.length + ' rows');
}
// ---- BACKTEST (one machine; portfolio and individual)
for (const btMode of ['portfolio', 'individual']) {
  const code = 'SetPositionSize(20, spsPercentOfEquity); SetOption("MaxOpenPositions", 4); Buy = Cross(MA(C, 10), MA(C, 30)); Sell = Cross(MA(C, 30), MA(C, 10));';
  const store = newStore(); await store.put('jobs/bt/job.json', job({ mode: 'backtest', code, btMode }));
  const r = await run(store, 'bt'); ok(r.state === 'done', `backtest (${btMode}) finishes: ` + r.state);
  const st = await store.get('jobs/bt/status.json'); ok(st.shards === 1, 'backtest used 1 machine');
  const raw = await readResult(store, 'bt'), size = JSON.stringify(raw).length, res = nfDecode(raw.result);
  const one = await core.backtest({ code, symbols: syms, session: session(), range: { mode: 'all' }, settings, mode: btMode });
  const norm = (x) => JSON.stringify(x, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : ArrayBuffer.isView(v) ? Array.from(v) : v));
  ok(one.trades.length > 5 && res.trades.length === one.trades.length, `backtest (${btMode}): ${one.trades.length} trades`);
  ok(norm(res.trades) === norm(one.trades) && norm(res.equityCurve) === norm(one.equityCurve) && norm(res.stats) === norm(one.stats), `backtest (${btMode}): same trades, equity curve and statistics`);
  ok(norm(res.info && { symbols: res.info.symbols, bars: res.info.bars }) === norm({ symbols: one.info.symbols, bars: one.info.bars }) && !('runs' in res), 'backtest: info kept, bar data of the symbols not stored');
  if (btMode === 'individual') ok(res.perSymbol && one.perSymbol && res.perSymbol.length === one.perSymbol.length, 'backtest: per-symbol table');
  ok(size < 3e6, 'backtest result is small: ' + size + ' bytes');
}
// ---- problems are reported
{
  const store = newStore(); await store.put('jobs/er/job.json', job({ mode: 'backtest', code: 'Foo = Bar(' }));
  const r = await run(store, 'er'); const res = await readResult(store, 'er'); ok(r.state === 'done' && res.result.stats === null && res.result.errors.length > 0, 'a formula with an error gives a result with the message, not a crash');
  const bad = newStore(); await bad.put('jobs/x/job.json', job({ mode: 'sort' })); let msg = ''; try { await planJob(bad, 'x'); } catch (e) { msg = e.message; } ok(/Unknown job type/.test(msg), 'unknown job type refused');
}
server.close(); console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
