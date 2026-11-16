import { describe, expect, it } from "vitest";
import { scanFiles } from "../src/index.js";

/**
 * The insecure-http-link rule of the publishing scanner (doc 17, item 3): the W3C namespace URIs of an `xmlns`
 * declaration are not links, so Histeon CSS's list icon (a data: URI with `xmlns='http://www.w3.org/2000/svg'`) no
 * longer warns on every page that loads it. Any other `http://`, the same URI outside a declaration included, still does.
 */

function httpLine(text: string): number | null {
  const finding = scanFiles([{ path: "index.html", size: Buffer.byteLength(text), contents: Buffer.from(text) }]).find((item) => item.code === "insecure-http-link");
  if (!finding) return null;
  expect(finding).toMatchObject({ severity: "warn", message: "Il contenuto include un collegamento HTTP non cifrato." });
  return finding.line ?? 0;
}

describe("collegamenti HTTP e namespace", () => {
  it.each([
    ["l'icona degli elenchi di Histeon CSS", `:root { --xb-list-icon-mask: url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27%3E%3C/svg%3E"); }`],
    ["spazio codificato prima di xmlns", `url("data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%3E%3C/svg%3E")`],
    ["svg in linea", '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg>'],
    ["xhtml e xml", "<html xmlns='http://www.w3.org/1999/xhtml' xmlns:xml='http://www.w3.org/XML/1998/namespace'></html>"],
    ["stringa CSS con virgolette escape", `.a { background: url('data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\'></svg>'); }`],
    ["riferimento a carattere", "<div data-svg=\"&lt;svg xmlns=&quot;http://www.w3.org/2000/svg&quot;&gt;\"></div>"],
    ["solo https", '<a href="https://example.it">x</a>'],
  ])("non segnala: %s", (_name, text) => {
    expect(httpLine(text)).toBeNull();
  });

  it.each([
    ["un link vero", '<a href="http://example.it">x</a>', 1],
    ["un link dopo l'icona", `<svg xmlns="http://www.w3.org/2000/svg"></svg>\n<a href="http://example.it">x</a>`, 2],
    ["il namespace come link", '<a href="http://www.w3.org/2000/svg">x</a>', 1],
    ["il namespace in uno script", 'document.createElementNS("http://www.w3.org/2000/svg", "svg");', 1],
    ["xmlns senza virgolette", "<svg xmlns=http://www.w3.org/2000/svg></svg>", 1],
    ["virgolette diverse", `<svg xmlns="http://www.w3.org/2000/svg'></svg>`, 1],
    ["un percorso dopo il namespace", '<svg xmlns="http://www.w3.org/2000/svg/../x"></svg>', 1],
    ["un altro indirizzo in xmlns", '<svg xmlns="http://example.it/ns"></svg>', 1],
    ["un namespace scritto in maiuscolo", '<svg xmlns="http://WWW.W3.ORG/2000/SVG"></svg>', 1],
  ])("segnala: %s", (_name, text, line) => {
    expect(httpLine(text)).toBe(line);
  });
});
