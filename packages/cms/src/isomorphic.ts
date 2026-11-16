/**
 * What the converter of doc 18 needs from Node, written for any JavaScript runtime (doc 18 §5, F6): the same code runs
 * in Histeon Publish and in the WordPress administrator's browser, so its core uses neither `Buffer` nor `node:crypto`.
 * SHA-256 is synchronous here because the conversion is: the Web Crypto API only hashes asynchronously.
 */

const encoder = new TextEncoder();

/** The bytes of a text in UTF-8. */
export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** How many bytes a text takes in UTF-8. Long texts are measured by the runtime's encoder, which is native. */
export function utf8Length(text: string): number {
  if (text.length > 4096) return encoder.encode(text).length;
  let length = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      length += 4;
      index++;
    } else length += 3;
  }
  return length;
}

const ROUND = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of a text (as UTF-8) or of bytes, in lower-case hex: the same digest as `createHash("sha256")`. */
export function sha256Hex(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? utf8Bytes(data) : data;
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 9 + 63) >> 6) << 6));
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15] as number;
      const b = words[index - 2] as number;
      const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
      const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
      words[index] = ((words[index - 16] as number) + s0 + (words[index - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash as unknown as [number, number, number, number, number, number, number, number];
    for (let index = 0; index < 64; index++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + (ROUND[index] as number) + (words[index] as number)) >>> 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    hash[0] = ((hash[0] as number) + a) >>> 0;
    hash[1] = ((hash[1] as number) + b) >>> 0;
    hash[2] = ((hash[2] as number) + c) >>> 0;
    hash[3] = ((hash[3] as number) + d) >>> 0;
    hash[4] = ((hash[4] as number) + e) >>> 0;
    hash[5] = ((hash[5] as number) + f) >>> 0;
    hash[6] = ((hash[6] as number) + g) >>> 0;
    hash[7] = ((hash[7] as number) + h) >>> 0;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, "0")).join("");
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The runtime's own base64 functions (browsers and Node 16+), native and much faster than the code below. */
const nativeBtoa = typeof globalThis.btoa === "function" ? globalThis.btoa.bind(globalThis) : null;
const nativeAtob = typeof globalThis.atob === "function" ? globalThis.atob.bind(globalThis) : null;

/** Bytes as base64 (standard alphabet, with padding). */
export function base64FromBytes(bytes: Uint8Array): string {
  if (nativeBtoa) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return nativeBtoa(binary);
  }
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] as number;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += BASE64[(triple >> 18) & 63] as string;
    out += BASE64[(triple >> 12) & 63] as string;
    out += b === undefined ? "=" : (BASE64[(triple >> 6) & 63] as string);
    out += c === undefined ? "=" : (BASE64[triple & 63] as string);
  }
  return out;
}

/** The bytes of base64 text (whitespace ignored); null when it is not base64. */
export function bytesFromBase64(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/gu, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(clean) || clean.length % 4 === 1) return null;
  if (nativeAtob) {
    const binary = nativeAtob(clean);
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
    return out;
  }
  const body = clean.replace(/=+$/u, "");
  const out = new Uint8Array(Math.floor((body.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let position = 0;
  for (const char of body) {
    value = (value << 6) | BASE64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[position++] = (value >> bits) & 0xff;
    }
  }
  return out.subarray(0, position);
}

/** Bytes read as Latin-1 (one character per byte), for the magic numbers of file formats. */
export function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/** SHA-1 of bytes, as bytes: only for the stable identities of the transfer (page-transfer.ts), never for security. */
export function sha1Bytes(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 9 + 63) >> 6) << 6));
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const hash = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const words = new Uint32Array(80);
  const rotate = (value: number, bits: number) => (value << bits) | (value >>> (32 - bits));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 80; index++) words[index] = rotate((words[index - 3] as number) ^ (words[index - 8] as number) ^ (words[index - 14] as number) ^ (words[index - 16] as number), 1) >>> 0;
    let [a, b, c, d, e] = hash as [number, number, number, number, number];
    for (let index = 0; index < 80; index++) {
      const [f, k] = index < 20 ? [(b & c) | (~b & d), 0x5a827999] : index < 40 ? [b ^ c ^ d, 0x6ed9eba1] : index < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const next = (rotate(a, 5) + f + e + k + (words[index] as number)) >>> 0;
      e = d;
      d = c;
      c = rotate(b, 30) >>> 0;
      b = a;
      a = next;
    }
    hash[0] = ((hash[0] as number) + a) >>> 0;
    hash[1] = ((hash[1] as number) + b) >>> 0;
    hash[2] = ((hash[2] as number) + c) >>> 0;
    hash[3] = ((hash[3] as number) + d) >>> 0;
    hash[4] = ((hash[4] as number) + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  for (const [index, word] of hash.entries()) outView.setUint32(index * 4, word);
  return out;
}

/** SHA-256 of bytes, as bytes. */
export function sha256Bytes(data: string | Uint8Array): Uint8Array {
  const hex = sha256Hex(data);
  const out = new Uint8Array(32);
  for (let index = 0; index < 32; index++) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
}
