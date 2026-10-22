// Loads the app's own analysis engine (the js/ folder of amibroker-web-engine), so the server computes exactly what the phone would.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { syncData, serveDir } from './data.mjs';

export async function loadEngine(dir = process.env.ENGINE_DIR || './engine') {
  const imp = (f) => import(pathToFileURL(path.resolve(dir, 'js', f)).href);
  const [core, range, ind, settings] = await Promise.all([imp('analysis-core.js'), imp('range-engine.js'), imp('indicators.js'), imp('analysis-settings.js')]);
  return { core, RangeEngine: range.RangeEngine, barsToArrays: ind.barsToArrays, defaultSettings: settings.defaultSettings };
}

const servers = new Map();   // data folder -> local server (one per process)

/** Bars of any symbol from the "pack" files, the same way the app reads them.
 *  With DATA_DIR (or opts.dataDir) the files come from that folder (downloaded once, kept by the Actions cache), not from R2 on every run. */
export async function makeLoader(engine, dataset, { dataDir = process.env.DATA_DIR, log = console.log } = {}) {
  let base = dataset.baseUrl;
  if (dataDir) {
    await syncData(dataset, dataDir, { log });
    if (!servers.has(dataDir)) servers.set(dataDir, await serveDir(dataDir));
    base = servers.get(dataDir).url;
  }
  const range = new engine.RangeEngine({ id: dataset.id || 'nse', baseUrl: base, firstYear: dataset.firstYear || 2000, currency: dataset.currency || 'INR' });
  range.onProgress = () => {};
  await range.init();
  if (range.mode !== 'pack') throw new Error('The runner needs the "pack" layout (manifest.json with packs + recent.json). Run the convert step of your data workflow.');
  const loadBars = async (sym) => { const rows = await range.getBars(sym); return rows && rows.length ? engine.barsToArrays(rows) : null; };
  return { loadBars, range };
}
