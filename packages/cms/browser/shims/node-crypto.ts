import { Buffer } from "buffer";
import { sha1Bytes, sha256Bytes } from "../../src/isomorphic.js";

/**
 * `node:crypto` in the browser bundle of the importer (doc 18 F6): the two digests the project store and the transfer
 * use, and random UUIDs from the browser's own generator. Anything else is refused, never imitated.
 */
type Input = string | Uint8Array;

class Hash {
  private readonly parts: Uint8Array[] = [];
  constructor(private readonly algorithm: "sha256" | "sha1") {}
  update(data: Input, encoding?: string): this {
    if (typeof data === "string" && encoding !== undefined && encoding !== "utf8" && encoding !== "utf-8") throw new TypeError(`Codifica non supportata nel browser: ${encoding}`);
    this.parts.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
    return this;
  }
  digest(encoding?: "hex" | "base64"): string | Buffer {
    const total = new Uint8Array(this.parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of this.parts) {
      total.set(part, offset);
      offset += part.length;
    }
    const bytes = Buffer.from(this.algorithm === "sha1" ? sha1Bytes(total) : sha256Bytes(total));
    return encoding ? bytes.toString(encoding) : bytes;
  }
}

export function createHash(algorithm: string): Hash {
  if (algorithm !== "sha256" && algorithm !== "sha1") throw new TypeError(`Algoritmo non disponibile nel browser: ${algorithm}`);
  return new Hash(algorithm);
}

export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

export default { createHash, randomUUID };
