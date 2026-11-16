import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateCmsExpression } from "../src/static-renderer.js";

// Histeon's own expression vectors (packages/spec/vectors/expressions.json, vendored) through Publish's renderer: the
// same values on WP and on a site Publish builds (doc 23 item 118 added groupBy to both).
const vectors = JSON.parse(readFileSync(new URL("../vendor/histos/packages/spec/vectors/expressions.json", import.meta.url), "utf8")) as { eval: Array<{ source: string; scope: Record<string, unknown>; result?: unknown; error?: string }> };

describe("vettori delle espressioni di Histeon nel motore di Publish", () => {
  for (const vector of vectors.eval) {
    it(vector.source, () => {
      if (vector.error !== undefined) {
        // An error on both sides; Publish words it as its own capability error.
        expect(() => evaluateCmsExpression(vector.source, vector.scope)).toThrow();
        return;
      }
      let value: unknown;
      try {
        value = evaluateCmsExpression(vector.source, vector.scope);
      } catch {
        value = null; // Histeon gives null for an evaluation error.
      }
      expect(JSON.parse(JSON.stringify(value ?? null))).toEqual(vector.result);
    });
  }
});
