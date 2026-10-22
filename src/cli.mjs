// node --import ./src/register.mjs src/cli.mjs plan|datakey|sync|shard|merge <jobId> [shardIndex]      (GitHub Actions)
// node --import ./src/register.mjs src/cli.mjs local <folder> <jobId>                      (a whole job on one computer; also used by the tests)
import fs from 'node:fs';
import { GhStore, FsStore } from './store.mjs';
import { loadEngine } from './engine.mjs';
import { planJob, runShard, mergeJob, readJob } from './jobs.mjs';
import { dataKey, syncData } from './data.mjs';

const [cmd, a, b, c] = process.argv.slice(2);
const out = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); console.log(`${k}=${v}`); };
const gh = () => new GhStore({ repo: process.env.REPO, token: process.env.GITHUB_TOKEN, branch: process.env.BRANCH || 'main' });

try {
  if (cmd === 'plan') { const r = await planJob(gh(), a); out('shards', JSON.stringify(r.shards)); }
  else if (cmd === 'datakey') { const job = await readJob(gh(), a); out('key', await dataKey(job.dataset)); }
  else if (cmd === 'sync') { const job = await readJob(gh(), a); await syncData(job.dataset, process.env.DATA_DIR || 'data'); }
  else if (cmd === 'shard') { await runShard(gh(), await loadEngine(), a, Number(b), { deadlineMs: (Number(process.env.DEADLINE_MIN) || 330) * 60000 }); }
  else if (cmd === 'merge') {
    const store = gh(), r = await mergeJob(store, await loadEngine(), a);
    if (r.state === 'continue') { await store.dispatch({ job: a }); console.log('Started the next run of this job.'); }
  } else if (cmd === 'local') {            // local <folder> <jobId>: plan, run every shard one after the other, merge (repeat while the merge asks for more)
    const store = new FsStore(a), engine = await loadEngine();
    for (let round = 0; round < 30; round++) {
      const { shards } = await planJob(store, b);
      for (const i of shards) await runShard(store, engine, b, i, { deadlineMs: (Number(process.env.DEADLINE_MIN) || 330) * 60000, progressMs: 5000 });
      const r = await mergeJob(store, engine, b); if (r.state !== 'continue') { console.log('Job', r.state); break; }
    }
  } else { console.error('usage: plan|shard|merge <jobId> [shard]  |  local <folder> <jobId>'); process.exit(2); }
} catch (e) { console.error(e.stack || e); process.exit(1); }
