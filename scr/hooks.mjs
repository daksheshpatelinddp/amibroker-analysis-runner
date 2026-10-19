const STUB = 'data:text/javascript,' + encodeURIComponent('const no = () => { throw new Error("parquet is not used by the analysis runner (pack layout only)"); }; export const parquetMetadataAsync = no, parquetRead = no, parquetReadObjects = no; export default {};');
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('https://')) return { url: STUB, shortCircuit: true };
  return next(specifier, context);
}
