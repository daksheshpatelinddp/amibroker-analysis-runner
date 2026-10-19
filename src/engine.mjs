// Loads the app's own analysis engine (the js/ folder of amibroker-web-engine), so the server computes exactly what the phone would.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadEngine(dir = process.env.ENGINE_DIR || './engine') {
  const imp = (f) => import(pathToFileURL(path.resolve(dir, 'js', f)).href);
  const [core, range, ind, settings] = await Promise.all([imp('analysis-core.js'), imp('range-engine.js'), imp('indicators.js'), imp('analysis-settings.js')]);
  return { core, RangeEngine: range.RangeEngine, barsToArrays: ind.barsToArrays, defaultSettings: settings.defaultSettings };
}

/** Bars of any symbol from the R2 "pack" files, the same way the app reads them. */
export async function makeLoader(engine, dataset) {
  const range = new engine.RangeEngine({ id: dataset.id || 'nse', baseUrl: dataset.baseUrl, firstYear: dataset.firstYear || 2000, currency: dataset.currency || 'INR' });
  range.onProgress = () => {};
  await range.init();
  if (range.mode !== 'pack') throw new Error('The runner needs the "pack" layout on R2 (manifest.json with packs + recent.json). Run the convert step of your data workflow.');
  const loadBars = async (sym) => { const rows = await range.getBars(sym); return rows && rows.length ? engine.barsToArrays(rows) : null; };
  return { loadBars, range };
}
