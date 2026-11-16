import { describe, expect, it } from "vitest";
import { validateExternalFrameworkConfiguration } from "../src/framework-config.js";

describe("configurazioni grezze dei framework esterni", () => {
  it("mantiene esattamente il testo UTF-8 fornito dall'utente", () => {
    const data = '{\n  "design": "spazi e ordine restano invariati 🌱"\n}\n';
    expect(validateExternalFrameworkConfiguration({ format: "opaque-utf8-v1", data })).toEqual({ format: "opaque-utf8-v1", data });
  });

  it("rifiuta formati inattesi, UTF-16 non valido, byte nullo e file oltre il limite", () => {
    expect(() => validateExternalFrameworkConfiguration({ format: "json-v2", data: "{}" })).toThrow();
    expect(() => validateExternalFrameworkConfiguration({ format: "opaque-utf8-v1", data: "\ud800" })).toThrow(/UTF-8/u);
    expect(() => validateExternalFrameworkConfiguration({ format: "opaque-utf8-v1", data: "\0" })).toThrow(/nullo/u);
    expect(() => validateExternalFrameworkConfiguration({ format: "opaque-utf8-v1", data: "🌱".repeat(262_145) })).toThrow(/1 MiB/u);
  });
});
