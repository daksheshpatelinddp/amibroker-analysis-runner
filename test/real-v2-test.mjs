// Run: ENGINE_DIR=/path/to/amibroker-web-engine node --import ./src/register.mjs test/real-v2-test.mjs
// Data written by the REAL converter (nse-data-engine/backend/convert.py, pack format v2): download into the local copy, read bars, run an analysis.
// Fixture made with nse-data-engine/tests/make_fake_r2.py (12 stocks x 900 bars).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { loadEngine, makeLoader } from '../src/engine.mjs'; import { syncData, dataKey } from '../src/data.mjs';
import { serve } from './fake-r2.mjs';
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/real-v2'), exp = JSON.parse(fs.readFileSync(path.join(fx, 'expected.json')));
const engine = await loadEngine(process.env.ENGINE_DIR || '../amibroker-web-engine');
const { server, url } = await serve(fx); const dataset = { id: 'nse', baseUrl: url + '/nse' };
const key = await dataKey(dataset); ok(/^data-nse-/.test(key), 'data key: ' + key);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-')); const info = await syncData(dataset, dir, { log: () => {} }); ok(info.files.length >= 4, 'files downloaded: ' + info.files.length);
const { loadBars, range } = await makeLoader(engine, dataset, { dataDir: dir, log: () => {} }); ok(range.mode === 'pack', 'pack layout');
let bad = 0; for (const [s, e] of Object.entries(exp)) { const b = await loadBars(s); let sum = 0; for (let i = 0; i < b.c.length; i++) sum += b.c[i]; if (!b || b.t.length !== e.n || Math.abs(sum - e.sumClose) > 1e-6 || b.c[b.c.length - 1] !== e.lastClose) bad++; }
ok(bad === 0, `all ${Object.keys(exp).length} stocks read correctly from the v2 packs (${bad} wrong)`);
const r = await engine.core.scan({ code: 'Buy = Cross(MA(C, 10), MA(C, 30)); Sell = Cross(MA(C, 30), MA(C, 10));', symbols: Object.keys(exp), session: engine.core.makeSession(loadBars, 'D'), range: { mode: 'all' }, lastBars: 300 });
ok(r.rows.length > 5 && r.errors.length === 0, 'an analysis runs on it: ' + r.rows.length + ' signals');
server.close(); console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
