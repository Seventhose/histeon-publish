import { readFile, stat } from "node:fs/promises";

/**
 * The checks the WordPress round-trip tests share: a disposable histos-cms-* Docker stack, and a pairing code that
 * only its owner can read, for a WordPress on localhost, allowed to read and write but not to publish.
 */
export const TEST_CONTAINER = /^histos-cms-[a-z0-9-]+-wordpress-1$/u;
const prefix = "histos-cms-1:";

export async function readPairingCode(filePath) {
  const file = await stat(filePath);
  if ((file.mode & 0o077) !== 0) {
    throw new TypeError("Il file del codice di collegamento deve essere accessibile solo al proprietario (permessi 0600 o più restrittivi).");
  }
  const code = (await readFile(filePath, "utf8")).trim();
  if (!code.startsWith(prefix)) throw new TypeError("Il file non contiene un codice di collegamento Histeon.");
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(code.slice(prefix.length), "base64url").toString("utf8"));
  } catch {
    throw new TypeError("Il codice di collegamento Histeon non è leggibile.");
  }
  const target = new URL(parsed.url);
  if (!new Set(["localhost", "127.0.0.1", "::1"]).has(target.hostname) || !["http:", "https:"].includes(target.protocol)) {
    throw new TypeError("La prova è limitata a WordPress locali raggiungibili da localhost.");
  }
  if (parsed.scopes?.read !== true || parsed.scopes?.write !== true || parsed.scopes?.publish === true) {
    throw new TypeError("Il codice deve autorizzare lettura e scrittura, ma non la pubblicazione.");
  }
  return { code, target };
}
