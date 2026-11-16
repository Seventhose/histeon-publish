import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { staticInlineSvg } from "../src/css-inline-svg.js";
import { buildPrototypeProfile, parsePrototype } from "../src/prototype-import.js";
import { staticSiteToPrototype, type StaticSiteFile } from "../src/static-site-prototype.js";

/**
 * «Uguale all'originale»: what the conversion adds to a page, or takes from it, must not move anything a browser
 * shows. Each test is one cause found by measuring real proposals against their imported site, on invented markup.
 */

const text = (value: string) => new TextEncoder().encode(value);
const ID = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";

/** A real PNG of the given size (one grey row repeated), so the size read from the file is not 1 × 1. */
function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc((width + 1) * height, 0x80))), chunk("IEND", Buffer.alloc(0))]);
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** The real check of the import: the converted prototype must pass it as it is. */
async function accepted(html: string): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-fidelity-"));
  roots.push(root);
  const catalog = new CmsProjectCatalog(root);
  await catalog.initialize();
  const built = await buildPrototypeProfile(parsePrototype(html), catalog);
  expect(built.profile).toBeDefined();
}

function convert(body: string, css = "", files: StaticSiteFile[] = []) {
  return staticSiteToPrototype({ projectId: ID, name: "Prova", files: [{ path: "index.html", bytes: text(`<!doctype html><html lang="it"><head><title>Prova</title><style>${css}</style></head><body>${body}</body></html>`) }, ...files] });
}

describe("immagini: le misure aggiunte non cambiano la pagina", () => {
  const files = [{ path: "img/larga.png", bytes: png(400, 200) }];

  it("un'immagine senza misure prende quelle del file, segnate, e una regola senza peso le lascia al CSS", async () => {
    const converted = convert('<main><img class="foto" src="img/larga.png" alt="Una foto"></main>', ".foto{width:100%}", files);
    expect(converted.html).toContain('<img class="foto" src="asset:larga" alt="Una foto" width="400" height="200" data-histos-sized="width height">');
    // Zero specificity, first of the sheets: any rule of the site about width or height wins, as it did over nothing.
    const globals = [...converted.html.matchAll(/<style data-histos="global"[^>]*>\n([\s\S]*?)\n<\/style>/gu)].map((match) => match[1] ?? "");
    expect(globals[0]?.replace(/\s+/gu, "")).toBe(':where(img[data-histos-sized~="width"]){width:auto}:where(img[data-histos-sized~="height"]){height:auto}');
    expect(converted.html.indexOf("data-histos-sized~=")).toBeLessThan(converted.html.indexOf(".foto"));
    await accepted(converted.html);
  });

  it("un'immagine con le sue misure non è toccata, e senza immagini segnate la regola non c'è", () => {
    const converted = convert('<img src="img/larga.png" alt="" width="120" height="40">', "", files);
    expect(converted.html).toContain('<img src="asset:larga" alt="" width="120" height="40">');
    expect(converted.html).not.toContain("data-histos-sized");
  });

  it("la misura che la pagina dà resta la sua: l'altra viene dalle proporzioni del file, ed è la sola segnata", () => {
    const wide = convert('<img src="img/larga.png" alt="" width="300">', "", files);
    expect(wide.html).toContain('<img src="asset:larga" alt="" width="300" height="150" data-histos-sized="height">');
    const tall = convert('<img src="img/larga.png" alt="" height="50">', "", files);
    expect(tall.html).toContain('<img src="asset:larga" alt="" height="50" width="100" data-histos-sized="width">');
    const none = convert('<img src="img/larga.png" alt="" width="0">', "", files);
    expect(none.html).toContain('<img src="asset:larga" alt="" width="0">');
  });
});

describe("link: restano link", () => {
  it("un # nudo resta, e una rotta che solo uno script leggeva diventa un # con una nota", async () => {
    const converted = convert('<nav><a class="voce" href="#">Menu</a> <a class="voce" href="#/menu/pizze">Pizze</a> <a class="voce" href="#contatti">Contatti</a> <a class="voce" href="javascript:void(0)">No</a></nav><p id="contatti">Contatti</p>', ".voce{color:red}");
    expect(converted.html).toContain('<a class="voce" href="#">Menu</a>');
    expect(converted.html).toContain('<a class="voce" href="#">Pizze</a>');
    expect(converted.html).toContain('<a class="voce" href="#contatti">Contatti</a>');
    expect(converted.html).toContain('<a class="voce">No</a>');
    expect(converted.report.notes).toEqual(expect.arrayContaining(["link a una rotta di uno script (#/…) tenuto come link vuoto (#): collegalo alla sua pagina", "link non portabile tolto"]));
    await accepted(converted.html);
  });

  it("target e rel restano con i soli valori noti, e una scheda nuova non dà mai la finestra a chi la apre", async () => {
    const converted = convert('<p>Si va <a href="https://example.org/" target="_blank">Fuori</a> oppure <a href="https://example.org/a" target="_blank" rel="opener nofollow">Due</a> o <a href="https://example.org/b" target="cornice" rel="x&quot;y external">Tre</a> o <a href="https://example.org/c" rel="NoReferrer">Quattro</a>, a scelta.</p>');
    expect(converted.html).toContain('<a href="https://example.org/" target="_blank" rel="noopener">Fuori</a>');
    expect(converted.html).toContain('<a href="https://example.org/a" target="_blank" rel="nofollow noopener">Due</a>');
    expect(converted.html).toContain('<a href="https://example.org/b" rel="external">Tre</a>');
    expect(converted.html).toContain('<a href="https://example.org/c" rel="noreferrer">Quattro</a>');
    await accepted(converted.html);
  });

  it("loading e decoding delle immagini restano con i soli valori noti", () => {
    const converted = convert('<img src="img/a.png" alt="" width="4" height="2" loading="LAZY" decoding="async"><img src="img/a.png" alt="" width="4" height="2" loading="presto" decoding="x">', "", [{ path: "img/a.png", bytes: png(4, 2) }]);
    expect(converted.html).toContain('<img src="asset:a" alt="" width="4" height="2" loading="lazy" decoding="async"><img src="asset:a" alt="" width="4" height="2">');
  });
});

describe("sfondi: un disegno SVG incorporato nel CSS resta", () => {
  const svg = (inner: string, attributes = "") => `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'${attributes}>${inner}</svg>`;
  const dataUrl = (text: string) => `data:image/svg+xml,${text.replaceAll("%", "%25").replaceAll("<", "%3C").replaceAll(">", "%3E").replaceAll("#", "%23")}`;
  const grain = svg("<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='2'/></filter><rect width='100%' height='100%' filter='url(#n)' opacity='.2'/>");

  it("statico resta, riscritto in una forma sola; l'import lo accetta", async () => {
    const converted = convert('<main class="carta"><p class="onda">Testo</p></main>', `.carta{background:#f4efe6 url("${dataUrl(grain)}") repeat}\n.onda{mask-image:url(data:image/svg+xml;base64,${Buffer.from(svg("<path d='M0 12 Q80 0 160 12'/>")).toString("base64")})}`);
    const kept = staticInlineSvg(dataUrl(grain));
    expect(kept).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg%20xmlns%3D%27http[A-Za-z0-9%._~-]+%3C%2Fsvg%3E$/u);
    expect(decodeURIComponent((kept ?? "").split(",")[1] ?? "")).toBe(grain);
    expect(converted.html).toContain(`url("${kept}")`);
    expect(converted.html).toMatch(/mask-image:\s*url\("data:image\/svg\+xml;charset=utf-8,%3Csvg[^"]+%3Cpath%20d%3D/u);
    expect(converted.report.notes.join("\n")).toContain("2 × disegno SVG incorporato nel CSS tenuto");
    expect(converted.report.notes.join("\n")).not.toContain("sostituito con none");
    await accepted(converted.html);
  });

  it("con uno script, un evento, un'immagine, un link, un documento dentro o qualcosa da fuori non resta", () => {
    const refused = [
      svg("<script>alert(1)</script>"),
      svg("<rect width='1' height='1'/>", " onload='alert(1)'"),
      svg("<image href='https://example.org/x.png'/>"),
      svg("<a href='https://example.org/'><rect width='1' height='1'/></a>"),
      svg("<foreignObject><p>x</p></foreignObject>"),
      svg("<use href='https://example.org/y.svg#a'/>"),
      svg("<use xmlns:xlink='http://www.w3.org/1999/xlink' xlink:href='//example.org/y.svg#a'/>"),
      svg("<rect width='1' height='1' fill='url(https://example.org/p.svg#a)'/>"),
      svg("<rect width='1' height='1' style='fill:url(\"https://example.org/p.svg#a\")'/>"),
      svg("<style>rect{fill:red}</style><rect width='1' height='1'/>"),
      svg("<animate attributeName='x' to='1'/>"),
      svg("<set attributeName='href' to='javascript:alert(1)'/>"),
      svg("<rect width='1' height='1'/></svg><p>fuori</p><svg>"),
      svg("<!-- nota --><rect width='1' height='1'/>"),
      `<!DOCTYPE svg [<!ENTITY a "b">]>${svg("<text>&a;</text>")}`,
      `<?xml-stylesheet href="https://example.org/x.css"?>${svg("")}`,
      svg("<rect width='1' height='1'/>").replace("http://www.w3.org/2000/svg", "http://www.w3.org/1999/xhtml"),
      svg(`<title>${"x".repeat(70_000)}</title>`),
      "<p>non è un disegno</p>",
    ];
    for (const text of refused) expect(staticInlineSvg(dataUrl(text)), text.slice(0, 90)).toBeNull();
    expect(staticInlineSvg("data:image/svg+xml,%E0%A4%A")).toBeNull();
    expect(staticInlineSvg("data:text/html,<svg></svg>")).toBeNull();
    const converted = convert('<main class="carta">Testo</main>', `.carta{background:url("${dataUrl(refused[0] ?? "")}")}`);
    expect(converted.html).toMatch(/\.carta \{\s*background:\s*none/u);
    expect(converted.html).not.toContain("alert");
    expect(converted.report.notes).toContain("riferimento url() del CSS non portabile, sostituito con none");
  });
});

describe("disegni SVG: testo, sfumature e stile restano (histos-svg-text-v1)", () => {
  const drawing = '<main><svg class="ruota" viewBox="0 0 100 100" data-impasto="classico"><defs><linearGradient id="sfuma" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#16224a"></stop><stop offset="1" stop-color="#05070f" stop-opacity=".45"></stop></linearGradient></defs>'
    + '<rect width="100" height="100" fill="url(#sfuma)"></rect><g font-family=\'"Didot", serif\' font-size="11" text-anchor="middle" lang="el" aria-pressed="true" tabindex="0">'
    + '<text x="50" y="40" class="ruota__nota">Πα <tspan class="ruota__lettera">A</tspan> <tspan class="ruota__lettera">B</tspan></text></g>'
    + '<text x="1" y="2">resta <a href="/x">via</a></text><use href="#sfuma"></use><clipPath id="c"><rect width="1" height="1"></rect></clipPath></svg></main>';

  it("le righe di testo, i tspan e i loro spazi, le sfumature e gli stati passano com'erano", async () => {
    const converted = convert(drawing, ".ruota{width:10rem}.ruota__nota{fill:#e9e4d6}.ruota__lettera{font-weight:700}");
    expect(converted.html).toContain('<defs><linearGradient id="sfuma" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#16224a"></stop><stop offset="1" stop-color="#05070f" stop-opacity=".45"></stop></linearGradient></defs>');
    expect(converted.html).toContain('<rect width="100" height="100" fill="url(#sfuma)"></rect>');
    // A family name in double quotes is written in single ones; the space between two tspan is a space of the line.
    expect(converted.html).toMatch(/<g font-family="'Didot', serif" font-size="11" text-anchor="middle" lang="el" aria-pressed="true"[^>]*><text x="50" y="40" class="ruota__nota">Πα <tspan class="ruota__lettera">A<\/tspan> <tspan class="ruota__lettera">B<\/tspan><\/text><\/g>/u);
    expect(converted.html).toMatch(/<svg class="[^"]*ruota[^"]*" viewBox="0 0 100 100" data-impasto="classico">/u);
    await accepted(converted.html);
  });

  it("ciò che il trasferimento non porta va via con una nota: link nel testo, forme riusate, ritagli, tabindex", () => {
    const converted = convert(drawing);
    expect(converted.html).toContain('<text x="1" y="2">resta </text>');
    expect(converted.html).not.toMatch(/<use|<clipPath|tabindex/u);
    for (const note of ["<a> di un SVG tolto", "<use> di un SVG tolto", "<clipPath> di un SVG tolto", "attributo tabindex di <g> tolto"]) {
      expect(converted.report.notes.some((item) => item.includes(note)), note).toBe(true);
    }
  });
});
