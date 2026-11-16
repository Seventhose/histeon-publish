import { describe, expect, it } from "vitest";
import { scanFiles } from "../src/index.js";

/**
 * The e-mail rule of the publishing scanner (round 7, B2): the same addresses as before, at the same line, and a time
 * that grows with the text, not with its square. Before, 100 KB of `%2F%2F…` (a percent-encoded SVG or query) took
 * 9 s and a 20 MiB file hours, since the run was read again from each word boundary inside it.
 */

function emailLine(text: string): number | null {
  const finding = scanFiles([{ path: "index.html", size: Buffer.byteLength(text), contents: Buffer.from(text) }]).find((item) => item.code === "email-address");
  if (!finding) return null;
  expect(finding).toMatchObject({ severity: "warn", message: "Il contenuto include un indirizzo email." });
  return finding.line ?? 0;
}

describe("indirizzi email nel contenuto pubblicato", () => {
  it.each([
    ["semplice", "<p>Scrivi a info@example.it</p>"],
    ["con punti e più", "<p>mario.rossi+news@sub.dominio.co.uk</p>"],
    ["in un mailto", '<a href="mailto:a_b-c@x-y.org">x</a>'],
    ["dominio in punycode", "<p>nome@xn--citt-5qa.it</p>"],
    ["maiuscole", "<p>INFO@EXAMPLE.IT</p>"],
    ["dopo una sequenza codificata", "<p>%2F%2F a.b@example.com</p>"],
    // Round 8 (B2): as the old rule found them (round 7 lost these).
    ["nome di più di 64 caratteri", `<p>${"a".repeat(100)}@example.it</p>`],
    ["un trattino dopo il dominio", "<p>9@x.com-com</p>"],
    ["un trattino dopo il dominio, alla fine della parola", "<p>scrivi a info@example.it-</p>"],
    ["due punti di fila nel dominio", "<p>a@b..cd</p>"],
  ])("trova: %s", (_name, text) => {
    expect(emailLine(text)).toBe(1);
  });

  it.each([
    ["senza dominio di primo livello", "<p>foo@bar</p>"],
    ["senza nome", "<p>@example.com</p>"],
    ["dominio di primo livello di una lettera", "<p>a@b.c</p>"],
    ["un @ in un nome utente", "<p>@autore su medium</p>"],
    // Round 8 (B2): a local part with no letter, digit or `_` was never one (round 7 found it).
    ["un nome di soli segni", "<p>\n.+.+@x.eyJB</p>"],
    ["un dominio seguito da _", "<p>a@x.com_x</p>"],
  ])("non trova: %s", (_name, text) => {
    expect(emailLine(text)).toBeNull();
  });

  it("alla riga dove è scritto", () => {
    expect(emailLine("<p>uno</p>\n<p>due</p>\n<p>tre@example.it</p>")).toBe(3);
  });

  it("trova quello che trovava la regola di prima, alla stessa riga, su testi casuali (round 8)", () => {
    const old = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
    const parts = ["a", "B", "9", "_", "-", ".", "+", "%", "@", "com", "it", "x.", ".com-com", "a".repeat(40), " ", "\n", "é", '"', "/", "..", "ſ", "K"];
    let seed = 7;
    const next = (n: number): number => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed % n;
    };
    for (let round = 0; round < 20_000; round += 1) {
      let text = "";
      for (let count = 1 + next(25); count > 0; count -= 1) text += parts[next(parts.length)];
      const match = old.exec(text);
      expect(emailLine(text), JSON.stringify(text)).toBe(match ? text.slice(0, match.index).split("\n").length : null);
    }
  });

  it("su testi lunghi fatti per rallentarlo, in un tempo lineare", () => {
    const started = Date.now();
    for (const unit of ["%2F", "a.", "1-", "@a.", "x@aa.aa1"]) {
      expect(emailLine(unit.repeat(Math.floor((2 * 1024 * 1024) / unit.length)))).toBeNull();
    }
    expect(emailLine(`${"%2F".repeat(700_000)} chi@example.it`)).toBe(1);
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
