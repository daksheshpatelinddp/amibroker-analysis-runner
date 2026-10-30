// The three steps of a job: plan (how many shards), shard (one machine's share of the combinations), merge (join the shares, or ask for another run).
import { makeLoader } from './engine.mjs';
import { nfEncode, nfDecode, gzPack, gzUnpack } from './nf.mjs';

const P = (id, f) => `jobs/${id}/${f}`;
const now = () => Date.now();
const MAX_RUNS = 30;                       // a job continues itself across runs of at most ~6 hours; 30 runs is far more than ever needed

const MODES = ['optimize', 'walk', 'scan', 'explore', 'backtest'];
const SPLIT = new Set(['scan', 'explore']);          // one symbol is independent of the others: the symbols are shared out over the machines
const MAX_RESULT_BYTES = 80e6;                        // the result as JSON text: the phone has to parse it (a bigger one could crash the tab)
const MAX_EXPLORE_ROWS = 20000;                       // rows of the sorted exploration table that are kept in the result (the summary rows cover ALL rows)
const KEEP_XY_POINTS = 20000;
const SHARD_EXPLORE_ROWS = 200000;                    // rows one machine collects before the join (memory)
const minPerShard = () => Number(process.env.MIN_PER_SHARD) || 100;   // a machine needs ~1-2 minutes to start: not worth it for fewer symbols

/** How many machines a job really uses. Optimize / Walk-Forward: as many as asked (1-20). Scan / Explore: at most one per 100 symbols.
 *  Backtest: one (a portfolio backtest needs all symbols together). The app has the same rule (js/remote-analysis.js, jobShards). */
export function jobShards(mode, nSymbols, wanted) {
  const w = Math.max(1, Math.min(20, Math.floor(wanted) || 1));
  if (mode === 'backtest') return 1;
  if (SPLIT.has(mode)) return Math.max(1, Math.min(w, Math.ceil(nSymbols / minPerShard())));
  return w;
}

export async function readJob(store, id) {
  const job = await store.get(P(id, 'job.json'));
  if (!job) throw new Error(`jobs/${id}/job.json not found`);
  if (!MODES.includes(job.mode)) throw new Error(`Unknown job type "${job.mode}"`);
  if (/^\d+[mh]$/.test(String(job.interval || 'D'))) throw new Error('Intraday time frames are not supported on the server (end-of-day data only).');
  job.shards = jobShards(job.mode, (job.symbols || []).length, job.shards);
  return job;
}

export async function planJob(store, id) {
  const job = await readJob(store, id);
  const prev = await store.get(P(id, 'status.json'));
  if (prev && prev.state === 'done') return { shards: [0], job, already: true };
  const st = { state: 'running', shards: job.shards, mode: job.mode, run: (prev && prev.run || 0) + 1, startedAt: prev && prev.startedAt || now(), stalls: prev && prev.stalls || 0, updatedAt: now(), message: '' };
  if (st.run > MAX_RUNS) { await store.put(P(id, 'status.json'), { ...st, state: 'failed', message: `Stopped after ${MAX_RUNS} runs.` }); throw new Error('too many runs'); }
  await store.put(P(id, 'status.json'), st);
  return { shards: Array.from({ length: job.shards }, (_, i) => i), job };
}

const SESSION = (engine, loader, job) => engine.core.makeSession(loader.loadBars, job.interval || 'D');

/** One shard. opts: { deadlineMs (stop and save before the runner's time limit), checkpointMs, progressMs } */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function runShard(store, engine, id, index, { deadlineMs = 330 * 60 * 1000, checkpointMs = 10 * 60 * 1000, progressMs = 180 * 1000, log = console.log } = {}) {
  const job = await readJob(store, id), core = engine.core;
  const status = await store.get(P(id, 'status.json'));
  if (status && status.state === 'done') return { state: 'done' };
  const prior = await store.get(P(id, `shard-${index}.json`));
  if (prior && prior.state === 'done') { log(`shard ${index}: already done`); return { state: 'done' }; }
  const started = now(), deadline = started + deadlineMs, cancel = { stop: false };
  const loader = await makeLoader(engine, job.dataset), session = SESSION(engine, loader, job);
  const prog = { shard: index, state: 'running', stage: 'start', done: 0, total: 0, label: '', startedAt: started, updatedAt: started, run: status ? status.run : 1 };
  let dirty = true; const flush = async () => { prog.updatedAt = now(); await store.put(P(id, `progress-${index}.json`), prog); dirty = false; };
  await sleep(Math.floor(Math.random() * 20000) * (process.env.NO_JITTER ? 0 : 1));   // shards start together: spread their first commits
  await flush();
  const timer = setInterval(() => { if (dirty) flush().catch((e) => log('progress not saved:', e.message)); }, progressMs);
  const onProgress = (i, n, label, stage) => {
    prog.stage = stage || 'run'; prog.done = Math.floor(i); prog.total = n; prog.label = String(label || '').slice(0, 120); dirty = true;
    if (!cancel.stop && stage === 'run' && now() > deadline) { cancel.stop = true; log(`shard ${index}: time limit near, saving and stopping`); }
  };
  const common = { code: job.code, symbols: job.symbols, session, settings: job.settings, metric: job.metric, engine: job.engine, maxEval: job.maxEval, shard: { index, count: job.shards }, onProgress, cancel, checkpointEvery: checkpointMs };
  const save = (state, extra) => store.put(P(id, `shard-${index}.json`), { state, mode: job.mode, shard: index, updatedAt: now(), ...extra });
  const mine = SPLIT.has(job.mode) ? job.symbols.filter((_, i) => i % job.shards === index) : job.symbols;   // round-robin: balanced shares
  const guard = () => { if (cancel.stop) throw new Error('The time limit of this machine was reached before the job finished. Send fewer symbols or use more machines.'); };
  try {
    let out;
    if (job.mode === 'scan') {
      const r = await core.scan({ code: job.code, symbols: mine, session, range: job.range, lastBars: job.lastBars || 1, onProgress, cancel }); guard();
      out = { state: 'done', result: gzPack(nfEncode({ rows: r.rows, errors: r.errors })) };
    } else if (job.mode === 'explore') {
      const raw = await core.exploreCollect({ code: job.code, symbols: mine, session, range: job.range, maxRows: SHARD_EXPLORE_ROWS, onProgress, cancel }); guard();
      out = { state: 'done', result: gzPack(nfEncode(raw)) };
    } else if (job.mode === 'backtest') {
      const r = await core.backtest({ code: job.code, symbols: mine, session, range: job.range, settings: job.settings, mode: job.btMode || 'portfolio', onProgress, cancel }); guard();
      const { runs, ...slim } = r;                  // `runs` holds every bar of every symbol: far too big, and the result views do not need it
      out = { state: 'done', result: gzPack(nfEncode(slim)) };
    } else if (job.mode === 'optimize') {
      const r = await core.optimize({ ...common, range: job.range, runs: job.runs, keep: job.keep, resume: prior && prior.resume || null,
        onCheckpoint: (state) => save('running', { resume: state }) });
      const smart = r.engine === 'smart';
      if (!(r.optParams && r.optParams.length)) out = { state: 'done', result: { rows: [], optParams: [], errors: r.errors || [], engine: r.engine, combinations: 0, gridTotal: 0 } };
      else if (!r.completed && !smart) out = { state: 'paused', resume: { next: r.next, rows: r.rows } };
      else out = { state: 'done', result: { rows: r.rows, optParams: r.optParams, errors: r.errors || [], engine: r.engine, combinations: r.combinations, gridTotal: r.gridTotal || r.combinations } };
    } else {
      const r = await core.walkForward({ ...common, wf: job.wf, searchOnly: true, resume: prior && prior.resume || null, onCheckpoint: (state) => save('running', { resume: state }) });
      if (r.errors && r.errors.length && !r.searchDone) out = { state: 'done', result: { errors: r.errors, steps: [] } };
      else if (!r.completed && job.engine !== 'smart') out = { state: 'paused', resume: { next: r.next, best: r.best } };
      else out = { state: 'done', result: { best: r.best, optParams: r.optParams, errors: r.errors || [], segments: r.segments, total: r.total, gridTotal: r.gridTotal } };
    }
    prog.state = out.state; prog.stage = out.state; if (out.state === 'done') { prog.done = prog.total = Math.max(prog.total, 1); }
    await save(out.state, out.state === 'done' ? { result: out.result } : { resume: out.resume });
    await flush();
    return out;
  } catch (e) {
    prog.state = 'failed'; prog.label = String(e.message || e).slice(0, 200); await flush().catch(() => {});
    await save('failed', { error: String(e.stack || e).slice(0, 2000) }).catch(() => {});
    throw e;
  } finally { clearInterval(timer); }
}

/** Joins the shards. Returns { state: 'done' | 'continue' | 'failed' }. */
export async function mergeJob(store, engine, id, { log = console.log } = {}) {
  const job = await readJob(store, id), core = engine.core;
  const status = await store.get(P(id, 'status.json')) || { run: 1, startedAt: now() };
  if (status.state === 'done') return { state: 'done' };
  const shards = []; for (let i = 0; i < job.shards; i++) shards.push(await store.get(P(id, `shard-${i}.json`)));
  const failed = shards.find((s) => s && s.state === 'failed');
  if (failed) { await store.put(P(id, 'status.json'), { ...status, state: 'failed', updatedAt: now(), message: `Shard ${failed.shard} failed: ${String(failed.error || '').split('\n')[0]}` }); return { state: 'failed' }; }
  if (shards.some((s) => !s || s.state !== 'done')) {
    const left = shards.filter((s) => !s || s.state !== 'done').length;
    // A shard with no saved file at all crashed before it could save (a working shard always saves 'paused' or 'done'). Do not loop on that.
    const crashed = shards.filter((s) => !s).length, stalls = crashed ? (status.stalls || 0) + 1 : 0;
    if (stalls >= 2) { await store.put(P(id, 'status.json'), { ...status, state: 'failed', stalls, updatedAt: now(), message: `${crashed} shard(s) crashed twice without saving (see the shard log in Actions). Stopped.` }); return { state: 'failed' }; }
    await store.put(P(id, 'status.json'), { ...status, state: 'continuing', stalls, updatedAt: now(), message: `${left} of ${job.shards} shards not finished: another run continues from the saved progress.` });
    return { state: 'continue' };
  }
  const results = shards.map((s) => gzUnpack(s.result));
  let result;
  const order = new Map((job.symbols || []).map((s, i) => [s, i])), byOrder = (a, b) => (order.get(a.symbol) ?? 0) - (order.get(b.symbol) ?? 0);   // original symbol order
  if (job.mode === 'scan') {
    result = nfEncode({ rows: nfDecode(results.flatMap((r) => r.rows || [])).sort(byOrder), errors: results.flatMap((r) => r.errors || []) });
  } else if (job.mode === 'explore') {
    const parts = results.map((r) => nfDecode(r)), keep = job.maxRows || MAX_EXPLORE_ROWS;
    const rows = parts.flatMap((p) => p.rows || []).sort(byOrder);
    const xy = {}; for (const p of parts) for (const [name, c] of Object.entries(p.xy || {})) { const t = (xy[name] = xy[name] || { points: [], xLabel: c.xLabel, yLabel: c.yLabel }); for (const pt of c.points) t.points.push(pt); }
    for (const t of Object.values(xy)) if (t.points.length > KEEP_XY_POINTS) t.points.length = KEEP_XY_POINTS;
    const withMeta = parts.filter((p) => p.meta), last = withMeta[withMeta.length - 1] || {}, colNames = [];
    for (const p of parts) for (const c of p.colNames || []) if (!colNames.includes(c)) colNames.push(c);
    const fin = core.exploreFinish({ rows, errors: parts.flatMap((p) => p.errors || []), xy, colNames, meta: (withMeta[0] || {}).meta || null, noDefault: !!last.noDefault, sortCols: last.sortCols || [], summary: last.summary || null });
    const total = fin.table.rows.length;                    // sorted, ranked and summarised over ALL rows; only the first `keep` are stored
    result = nfEncode({ table: { head: fin.table.head, cols: fin.table.cols, rows: fin.table.rows.slice(0, keep), summary: fin.table.summary }, rows: fin.rows.slice(0, keep).map((r) => ({ symbol: r.symbol, date: r.date })), xy: fin.xy, errors: fin.errors, columns: fin.columns, truncated: total > keep ? total : 0 });
  } else if (job.mode === 'backtest') {
    result = results[0];
  } else if (job.mode === 'optimize') {
    const dir = (core.METRICS[job.metric] || core.METRICS.carMdd)[1];
    const rows = results.flatMap((r) => r.rows || []).sort((x, y) => dir * (y.stats[job.metric] - x.stats[job.metric]));
    if (job.keep > 0 && rows.length > job.keep) rows.length = job.keep;
    const first = results.find((r) => r.optParams && r.optParams.length) || results[0];
    const smart = results.some((r) => r.engine === 'smart');
    result = { rows, optParams: first.optParams || [], errors: rows.length ? [] : (first.errors && first.errors.length ? first.errors : ['No combination produced trades']), engine: first.engine, tested: rows.length,
      combinations: smart ? results.reduce((t, r) => t + (r.combinations || 0), 0) : (first.gridTotal || results.reduce((t, r) => t + (r.combinations || 0), 0)), next: 0, completed: true, metric: job.metric };
    result.next = result.combinations;
  } else {
    if (results.every((r) => r.errors && r.errors.length && !r.best)) result = { steps: [], errors: results[0].errors };
    else {
      const dir = 1, score = (b) => (b && b.score !== null && b.score !== undefined ? b.score : -Infinity);
      const base = results.find((r) => r.best);
      const best = base.best.map((_, k) => results.filter((r) => r.best).map((r) => r.best[k]).reduce((a, b) => (score(b) * dir > score(a) * dir ? b : a)));
      const loader = await makeLoader(engine, job.dataset), session = SESSION(engine, loader, job);
      result = await core.walkForward({ code: job.code, symbols: job.symbols, session, settings: job.settings, wf: job.wf, metric: job.metric, engine: job.engine, maxEval: job.maxEval, bestIn: best });
    }
  }
  const finished = now();
  // Scan / Explore / Backtest results are stored compressed ({ gz: ... }) when they are big: JSON of rows shrinks ~10x, so the repo stays small and the phone downloads little.
  const packed = job.mode === 'scan' || job.mode === 'explore' || job.mode === 'backtest';
  const rawLen = JSON.stringify(result).length;                    // what the phone has to parse after unpacking
  if (rawLen > MAX_RESULT_BYTES) {
    await store.put(P(id, 'status.json'), { ...status, state: 'failed', updatedAt: finished, message: 'The result is too big for the phone to open (over 80 MB). Send fewer symbols or a shorter date range.' }); return { state: 'failed' };
  }
  if (packed) result = gzPack(result);
  await store.put(P(id, 'result.json'), { v: 1, mode: job.mode, finishedAt: finished, elapsedMs: finished - (status.startedAt || finished), result });
  await store.put(P(id, 'status.json'), { ...status, state: 'done', updatedAt: finished, message: '' });
  return { state: 'done' };
}
