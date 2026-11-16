import { Unzlib } from "fflate";

/**
 * `node:zlib` in the browser bundle (doc 18 F6): inflateSync of a zlib stream (header and checksum checked, as Node
 * does) with Node's `maxOutputLength`, which stops a small stream that would grow without end. Only what the importer
 * uses.
 */
export function inflateSync(data: Uint8Array, options: { maxOutputLength?: number } = {}): Uint8Array {
  const limit = options.maxOutputLength ?? Number.MAX_SAFE_INTEGER;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let ended = false;
  const stream = new Unzlib((chunk, final) => {
    total += chunk.length;
    if (total > limit) throw new RangeError("Dati decompressi oltre il limite.");
    chunks.push(chunk);
    if (final) ended = true;
  });
  stream.push(data, true);
  if (!ended) throw new RangeError("Flusso compresso incompleto.");
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
export default { inflateSync };
