import { utf8Length } from "./isomorphic.js";

/** The most JavaScript a document holds, in UTF-8 bytes: WordPress's `Scripts::MAX_BYTES` (doc 18 §6.6). */
export const DOCUMENT_SCRIPT_MAX_BYTES = 100_000;

/** A document's JavaScript: a string within the limit, without NUL characters. */
export function assertDocumentScript(script: unknown): asserts script is string {
  if (typeof script !== "string") throw new TypeError("Il JavaScript del documento deve essere testo.");
  if (utf8Length(script) > DOCUMENT_SCRIPT_MAX_BYTES) throw new RangeError(`Il JavaScript del documento supera ${DOCUMENT_SCRIPT_MAX_BYTES / 1000} kB.`);
  if (script.includes("\u0000")) throw new TypeError("Il JavaScript del documento contiene un carattere NUL.");
}
