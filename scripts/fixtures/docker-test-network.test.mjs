import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestNetwork } from "./docker-test-network.mjs";

test("la rete di prova si crea senza sottorete quando Docker ne ha", () => {
  const calls = [];
  const made = createTestNetwork((extra) => {
    calls.push(extra);
    return "id";
  });
  assert.equal(made, "id");
  assert.deepEqual(calls, [[]]);
});

test("finite le sottoreti di Docker, la rete ne chiede una sua e cambia quando è presa", () => {
  const calls = [];
  const picks = [7, 3, 9, 0];
  createTestNetwork(
    (extra) => {
      calls.push(extra);
      if (calls.length < 3) throw new Error("rifiutata");
      return "id";
    },
    () => picks.shift(),
  );
  assert.deepEqual(calls, [[], ["--subnet", "10.252.7.48/28"], ["--subnet", "10.252.9.0/28"]]);
});

test("se nessuna sottorete va, resta il primo rifiuto", () => {
  let count = 0;
  assert.throws(
    () =>
      createTestNetwork((extra) => {
        count += 1;
        throw new Error(extra.length ? "presa" : "primo rifiuto");
      }),
    /primo rifiuto/u,
  );
  assert.equal(count, 9);
});
