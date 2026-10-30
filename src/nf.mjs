import zlib from 'node:zlib';
// JSON cannot hold NaN, Infinity or -Infinity (they turn into null). Results of Scan / Explore / Backtest can contain them (an exploration column
// without a value, a profit factor with no losing trade), so they are written as { "__nf": "NaN" } and put back by the app (js/json-nan.js, same code).
export function nfEncode(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : { __nf: Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity' };
  if (Array.isArray(v)) { const o = new Array(v.length); for (let i = 0; i < v.length; i++) o[i] = nfEncode(v[i]); return o; }
  if (v && typeof v === 'object') {
    if (ArrayBuffer.isView(v)) return nfEncode(Array.from(v));
    const o = {}; for (const k of Object.keys(v)) { const x = v[k]; if (x !== undefined && typeof x !== 'function') o[k] = nfEncode(x); } return o;
  }
  return v;
}
export function nfDecode(v) {
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = nfDecode(v[i]); return v; }
  if (v && typeof v === 'object') {
    if (typeof v.__nf === 'string' && Object.keys(v).length === 1) return v.__nf === 'NaN' ? NaN : v.__nf === 'Infinity' ? Infinity : -Infinity;
    for (const k of Object.keys(v)) v[k] = nfDecode(v[k]);
  }
  return v;
}

// Big results are stored compressed: { gz: <base64 of gzip of the JSON>, raw: <bytes before compression> }. JSON of rows compresses ~10x, so the repo
// stays small and the phone downloads little. The app (js/json-nan.js, gzUnpack) opens both forms.
export const PACK_MIN = 200000;
export function gzPack(enc) {
  const text = JSON.stringify(enc);
  if (text.length < PACK_MIN) return enc;
  return { gz: zlib.gzipSync(text, { level: 6 }).toString('base64'), raw: text.length };
}
export function gzUnpack(x) { return x && typeof x.gz === 'string' ? JSON.parse(zlib.gunzipSync(Buffer.from(x.gz, 'base64')).toString('utf8')) : x; }
