import { describe, expect, it } from "vitest";
import { scanFiles } from "../src/index.js";

/**
 * The JSON Web Token and WordPress nonce rules of the publishing scanner (round 7, B2): the same findings as before,
 * in a time that grows with the text, not with its square. Before, 100 KB of `eyJ-eyJ-…` took 4 s and 100 KB of
 * `<input <input …` 5 s; a 20 MiB file, hours.
 */

function line(text: string, code: string): number | null {
  const finding = scanFiles([{ path: "index.html", size: Buffer.byteLength(text), contents: Buffer.from(text) }]).find((item) => item.code === code);
  if (!finding) return null;
  expect(finding.severity).toBe("block");
  return finding.line ?? 0;
}

const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

describe("token JWT nel contenuto pubblicato", () => {
  it.each([
    ["da solo", `<p>${JWT}</p>`],
    ["dopo Bearer", `<script>fetch(u, { headers: { Authorization: "Bearer ${JWT}" } })</script>`],
    ["dopo un trattino", `<p>id-${JWT}</p>`],
    ["dopo un punto", `<p>x.${JWT}</p>`],
    ["dopo un'altra sequenza puntata", `<p>aaaaaaaaaaaaaaaaaaaaaaaaaaaaa.${JWT}</p>`],
    ["in una query", `<a href="https://www.example.com/?t=${JWT}">x</a>`],
  ])("trova: %s", (_name, text) => {
    expect(line(text, "secret-pattern")).toBe(1);
  });

  it.each([
    ["eyJ dentro una parola", `<p>x${JWT}</p>`],
    ["primo segmento troppo corto", "<p>eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fw</p>"],
    ["solo due segmenti", "<p>eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0</p>"],
    ["nessun eyJ", "<p>abcdefghijklmnopqrstuvwxyz.abcdefghijkl.abcdefghijkl</p>"],
  ])("non trova: %s", (_name, text) => {
    expect(line(text, "secret-pattern")).toBeNull();
  });

  it("alla riga dove è scritto, dopo una lunga fila di eyJ-, in un tempo lineare", () => {
    const started = Date.now();
    expect(line("eyJ-".repeat(500_000), "secret-pattern")).toBeNull();
    expect(line(`${"eyJ-".repeat(500_000)}\n<p>${JWT}</p>`, "secret-pattern")).toBe(2);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("una fila di 20 MiB senza punti non fa fallire il controllo (round 9)", () => {
    // Before: a run of about 5 MiB threw RangeError (Maximum call stack size exceeded) from the token's pattern.
    const size = 20 * 1024 * 1024;
    const started = Date.now();
    for (const unit of ["x", "-eyJ"]) expect(line(unit.repeat(size / unit.length), "secret-pattern")).toBeNull();
    expect(line(`${"eyJ".repeat(size / 4)}.${"a".repeat(size / 4)}.${"b".repeat(9)}\n<p>${JWT}</p>`, "secret-pattern")).toBe(2);
    expect(line(`${"a".repeat(size / 2)}-${JWT}`, "secret-pattern")).toBe(1);
    // About 1 s each alone; the budget leaves room for a loaded machine, not for a pattern that reads runs again.
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);
});

describe("nonce WordPress nel contenuto pubblicato", () => {
  it("il campo nascosto del nonce, anche con altri attributi; il riferimento senza valore no", () => {
    expect(line('<form><input type="hidden" id="_wpnonce" name="_wpnonce" value="0123456789"></form>', "wordpress-nonce")).toBe(1);
    expect(line('<form>\n<input value="abcdef0123" type="hidden" name="_wpnonce" /></form>', "wordpress-nonce")).toBe(2);
    expect(line('<input type="hidden" name="_wp_http_referer" value="/x/">', "wordpress-nonce")).toBeNull();
  });

  it("su una lunga fila di <input senza >, in un tempo lineare", () => {
    const started = Date.now();
    expect(line("<input ".repeat(300_000), "wordpress-nonce")).toBeNull();
    expect(line(`${"<input ".repeat(300_000)}\n<input type="hidden" name="_wpnonce" value="0123456789">`, "wordpress-nonce")).toBe(2);
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});

/**
 * Round 10 (B2): the other key rules and the REST nonce header, read by hand like the token's. Their patterns threw
 * RangeError (Maximum call stack size exceeded) on a run of about 6 MiB after the prefix, and publishing failed with it.
 */
describe("chiavi e nonce su file di 20 MiB (round 10)", () => {
  const run = "a".repeat(20 * 1024 * 1024);

  it.each([
    ["sk_live_", `sk_live_${run}`],
    ["ghp_", `ghp_${run}`],
    ["xoxb- dopo un trattino", `x-xoxb-${run}`],
    ["AIza", `AIza${run}`],
  ])("trova la chiave dopo %s senza fallire", (_name, text) => {
    expect(line(text, "secret-pattern")).toBe(1);
  }, 60_000);

  it("una lunga fila prima della chiave, e il nonce dell'intestazione con o senza la virgoletta di chiusura", () => {
    expect(line(`${run}\nsk_test_0123456789`, "secret-pattern")).toBe(2);
    expect(line(`"X-WP-Nonce":"${run}"`, "wordpress-nonce")).toBe(1);
    expect(line(`"X-WP-Nonce":"${run}`, "wordpress-nonce")).toBeNull();
  }, 60_000);
});

/**
 * Round 10 (B2): the same findings as the patterns they replace, at the same lines, on random texts made of their
 * prefixes, base64url runs and separators (a differential fuzz; the inputs are small, where the patterns do not throw).
 */
describe("le regole scritte a mano trovano quello che trovavano i pattern (round 10)", () => {
  const SECRET_PATTERNS = [
    /\b(?:sk_live_|sk_test_|rk_live_|AKIA|ghp_|xox[baprs]-)[A-Za-z0-9_-]{8,}/u,
    /AIza[0-9A-Za-z_-]{30,}/u,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u,
  ];
  const WP_NONCE =
    /(?:_wpnonce\s*[=:]\s*["']?[0-9a-f]{10}\b|<input\b(?=[^<>]*\bname=["']_wpnonce["'])(?=[^<>]*\bvalue=["'][0-9a-f]{10}["'])[^<>]*|["']?(?:nonce|ajax_nonce|restNonce|security)["']?\s*[:=]\s*["'][0-9a-f]{10}["']|["']?X-WP-Nonce["']?\s*:\s*["'][A-Za-z0-9_-]{10,}["'])/iu;
  const PIECES = ["sk_live_", "sk_test_", "rk_live_", "AKIA", "ghp_", "xoxb-", "xoxs-", "xoxq-", "AIza", "AIz", "X-WP-Nonce", "x-wp-nonce", "nonce", "a", "B", "7", "_", "-", "-", ".", " ", "\t", " ", "\n", "é", "ſ", "K", '"', "'", ":", "=", "0123456789"];
  const linesOf = (text: string, indexes: number[]) => [...new Set(indexes.filter((index) => index >= 0).map((index) => text.slice(0, index).split("\n").length))].sort((a, b) => a - b);
  const found = (text: string, code: string) =>
    scanFiles([{ path: "index.html", size: Buffer.byteLength(text), contents: Buffer.from(text) }])
      .filter((item) => item.code === code)
      .map((item) => item.line ?? 0)
      .sort((a, b) => a - b);

  it("su 4.000 testi casuali, con le stesse righe", () => {
    let seed = 10;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    let hits = 0;
    for (let sample = 0; sample < 4_000; sample += 1) {
      let text = "";
      for (let count = Math.floor(random() * 60); count > 0; count -= 1) text += random() < 0.15 ? "a".repeat(Math.floor(random() * 40)) : PIECES[Math.floor(random() * PIECES.length)];
      const secrets = linesOf(text, SECRET_PATTERNS.map((pattern) => pattern.exec(text)?.index ?? -1));
      const nonce = linesOf(text, [WP_NONCE.exec(text)?.index ?? -1]);
      hits += secrets.length + nonce.length;
      expect([text, found(text, "secret-pattern"), found(text, "wordpress-nonce")]).toEqual([text, secrets, nonce]);
    }
    expect(hits).toBeGreaterThan(1_000);
  }, 60_000);
});
