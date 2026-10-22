// A shard that crashes before saving must not make the job re-start itself 30 times.
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import { FsStore } from '../src/store.mjs'; import { planJob, mergeJob } from '../src/jobs.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-')); const st = new FsStore(dir);
await st.put('jobs/x/job.json', { mode: 'optimize', shards: 3, interval: 'D' });
let ok = 0, bad = 0; const t = (c, m) => { c ? ok++ : (bad++, console.log('FAIL', m)); };
await planJob(st, 'x'); let r = await mergeJob(st, { core: {} }, 'x'); t(r.state === 'continue', 'first crash continues once');
await planJob(st, 'x'); r = await mergeJob(st, { core: {} }, 'x'); t(r.state === 'failed', 'second crash stops');
t((await st.get('jobs/x/status.json')).state === 'failed', 'status failed');
console.log(`${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
