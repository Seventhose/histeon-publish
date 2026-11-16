import { describe, expect, it } from "vitest";
import { inertPreviewLinks } from "../src/preview-links.js";

const page = (body: string, css = "") => `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>T</title><style>${css}</style></head><body>${body}</body></html>`;

describe("link inerti nelle anteprime (A4)", () => {
  it("ogni link punta a un frammento e tiene l'indirizzo a parte; il resto della pagina resta identico byte per byte", () => {
    const before = page('<p>Uno &amp; due</p><a class="x" href="/contatti/?a=1&amp;b=2" ping="https://evil.example/p" target="_blank" download>Contatti</a><pre>\n\nrientro</pre><textarea>\nx</textarea>');
    const after = inertPreviewLinks(before);
    expect(after).toMatch(/<a href="#histos-preview-link" data-histos-href="\/contatti\/\?a=1&amp;b=2"\s+class="x"\s+target="_blank" download>Contatti<\/a>/u);
    expect(after).not.toContain("ping=");
    // Everything outside the link's tag is untouched: the blank lines of <pre> and <textarea> too.
    const tag = /<a [^>]*>/u;
    expect(after.replace(tag, "")).toBe(before.replace(tag, ""));
    expect(inertPreviewLinks(page("<p>Nessun link</p>"))).toBe(page("<p>Nessun link</p>"));
  });

  it("i selettori CSS su href seguono l'indirizzo spostato", () => {
    const after = inertPreviewLinks(page('<a href="https://example.com/">Fuori</a>', 'a[href^="http"]::after{content:"↗"} a:not([ href ]){color:inherit} [*|href]{x:y} .href{a:b}'));
    expect(after).toContain('a[data-histos-href^="http"]::after{content:"↗"} a:not([ data-histos-href ]){color:inherit} [*|data-histos-href]{x:y} .href{a:b}');
  });

  it("nessuna via d'uscita: SVG, noscript, template, animazioni, nomi che coprono i metodi", () => {
    const after = inertPreviewLinks(page([
      '<svg><a xlink:href="https://s1.example/"><text>1</text></a><a href="https://s2.example/" xlink:href="https://s3.example/"><text>2</text></a>',
      '<set attributeName="href" to="https://s4.example/"/><animate attributeName="xlink:href" values="https://s5.example/"/></svg>',
      '<noscript><a href="https://n.example/">n</a></noscript>',
      '<template><a href="https://t.example/">t</a></template>',
      '<a/href="https://slash.example/">barra</a>',
      '<img name="addEventListener" src="x.png" alt="">',
      '<a xlink:href="https://html.example/">non è un link in HTML</a>',
    ].join("")));
    // Every address is aside.
    for (const host of ["s1", "s2", "n", "t", "slash"]) expect(after).toContain(`data-histos-href="https://${host}.example/"`);
    expect(after).not.toMatch(/<a [^>]*?(?<!data-histos-)href="https:\/\/(?:s1|s2|s3|n|t|slash)\.example\/"/u);
    expect(after).not.toContain("s3.example");
    expect(after).not.toContain("s4.example");
    expect(after).not.toContain("s5.example");
    expect(after).not.toContain('name="addEventListener"');
    expect(after).toContain('<a xlink:href="https://html.example/">');
  });

  it("un link che il parser ricrea (un blocco dentro <p><a>) si riscrive una volta sola", () => {
    const after = inertPreviewLinks(page('<p><a href="/contatti/">Scrivimi<div>blocco</div></a></p><ul><li><b><a href="/a/">x<h2>t</h2></a></b></li></ul>'));
    expect(after.match(/data-histos-href="\/contatti\/"/gu)).toHaveLength(1);
    expect(after.match(/data-histos-href="\/a\/"/gu)).toHaveLength(1);
  });

  it("rifiuta ciò che il renderer non scrive e potrebbe nascondere un indirizzo; spegne le radici shadow dichiarative", () => {
    expect(() => inertPreviewLinks(page('<a href="#ok" href="https://d.example/">due href</a>'))).toThrow(/attributo ripetuto/u);
    expect(() => inertPreviewLinks(page('<a href="/x" ping="a" PING="b">x</a>'))).toThrow(/attributo ripetuto/u);
    expect(() => inertPreviewLinks(page('<select><a href="https://e.example/">s</a></select>'))).toThrow(/<select> non è ammesso/u);
    const shadow = inertPreviewLinks(page('<div><template shadowrootmode="closed"><a href="https://s.example/">s</a></template></div>'));
    expect(shadow).not.toContain("shadowrootmode");
    expect(shadow).toContain('data-histos-href="https://s.example/"');
    expect(() => inertPreviewLinks(page('<a href="/x"ping="p">x</a>'))).toThrow(/senza spazio/u);
    // MathML, and HTML inside SVG, where parse5 and browsers close elements differently.
    expect(() => inertPreviewLinks(page('<math><mi href="https://m.example/">m</mi></math>'))).toThrow(/MathML/u);
    expect(() => inertPreviewLinks(page('<svg><title><b></title><a href="https://e.example/">x</a></b></title></svg>'))).toThrow(/<b> dentro un SVG/u);
    // After "/" a space stays, so "/>" never turns into a self-closing tag; elsewhere nothing stays.
    expect(inertPreviewLinks(page('<svg><a href="/x"/ping="p"><text>t</text></a></svg>'))).not.toMatch(/\/>/u);
    // The last attribute takes the white space before it: no CR is left just before ">" (Chromium would drop the "\n").
    expect(inertPreviewLinks(page('<a x="1"\rping="p">\ntesto</a>'))).toContain('x="1">\ntesto');
    expect(inertPreviewLinks(page('<pre><a x \rhref="/a">\nriga</a></pre>'))).toContain(' x>\nriga');
    // A valueless attribute followed by "=" takes the "=" with it, however far; one with a value never takes another.
    expect(inertPreviewLinks(page(`<a href="/x" ping${" ".repeat(100)}=>x</a>`))).not.toMatch(/\s=>/u);
    expect(inertPreviewLinks(page('<a href="/x" ping="p" =>x</a>'))).toContain(" =>x</a>");
  });

  it("regge pagine con moltissimi elementi fratelli senza esaurire lo stack", () => {
    const many = Array.from({ length: 200_000 }, () => "<span>x</span>").join("");
    const after = inertPreviewLinks(page(`<a href="/a/">a</a><div>${many}</div>`));
    expect(after).toContain('data-histos-href="/a/"');
  });
});
