import { describe, expect, it } from "vitest";
import { canonicalizeJson, parseJsonStrict } from "../src/canonical-json.js";

describe("RFC 8785 canonical JSON", () => {
  it("orders keys by UTF-16 and preserves supplementary Unicode without normalization", () => {
    const value = parseJsonStrict('{"z":333333333.33333329,"a":"€","😀":"😃","1":4,"n":-0.0}');
    expect(canonicalizeJson(value)).toBe('{"1":4,"a":"€","n":0,"z":333333333.3333333,"😀":"😃"}');
  });

  it("uses ECMAScript number serialization at JCS exponent boundaries", () => {
    const value = [1e-7, 1e-6, 1e20, 1e21, 9007199254740991];
    expect(canonicalizeJson(value)).toBe('[1e-7,0.000001,100000000000000000000,1e+21,9007199254740991]');
  });

  it("rejects duplicate keys and invalid Unicode scalars", () => {
    expect(() => parseJsonStrict('{"page":1,"page":2}')).toThrow(/duplicata/u);
    expect(() => parseJsonStrict('"\\ud800"')).toThrow(/UTF-16/u);
    expect(() => canonicalizeJson("\ud800")).toThrow(/UTF-16/u);
  });

  it("rejects malformed JSON and invalid UTF-8 before hashing", () => {
    expect(() => parseJsonStrict('{"value":01}')).toThrow(/Numero JSON non valido/u);
    expect(() => parseJsonStrict(new Uint8Array([0xc3, 0x28]))).toThrow();
  });
});
