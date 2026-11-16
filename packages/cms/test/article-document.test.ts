import { describe, expect, it } from "vitest";
import { parseXb, serializeXb, type XbBlock } from "../.generated/histos-dsl/index.js";
import { ARTICLE_LIBRARY } from "../src/article-cards.js";
import { readArticle, writeArticle, type ArticleBlock } from "../src/article-document.js";
import { documentSegments } from "../src/translation-segments.js";

const options = { mediaBase: "/__cms-media/p" };
const element = (uid: string, tag: string, attributes: Record<string, string>, children: XbBlock[]): XbBlock => ({ name: "xb/element", attrs: { uid, tag, ...(Object.keys(attributes).length ? { attributes } : {}) }, children }) as XbBlock;
const text = (uid: string, content: string): XbBlock => ({ name: "xb/text", attrs: { uid, content } }) as XbBlock;
const article = serializeXb([
  element("u636f766572", "figure", { class: "articolo__figura" }, [element("uimage0001", "img", { class: "articolo__immagine", src: "/__cms-media/p/a", alt: "Copertina", width: "560", height: "361" }, [])]),
  element("u70726f7361", "div", { class: "prosa" }, [
    element("u756e6f0000", "p", {}, [text("u756e6f2d74", "Uno <strong>forte</strong> &amp; <a href=\"https://esempio.it/?a=1&amp;b=2\">link</a>")]),
    text("u76756f746f", " "),
    element("u7469746f6c", "h2", {}, [text("utitolotxt", "Un titolo")]),
    element("u6c69737461", "ul", {}, [element("u6c69310000", "li", {}, [text("u6c69312d74", "Primo")]), element("u6c69320000", "li", {}, [text("u6c69322d74", "Secondo")])]),
    element("u6369740000", "blockquote", {}, [element("u6369743100", "p", {}, [text("u636974312d", "Parole")])]),
  ]),
  element("u646f637300", "section", { class: "documenti", "aria-label": "Documenti allegati" }, [element("u646f63732d", "h2", {}, [text("xxxxxxxxxx", "Documenti")])]),
  element("u666f6e7465", "p", { class: "articolo__fonte" }, [element("ulinkfonte", "a", { href: "https://esempio.it" }, [text("yyyyyyyyyy", "Fonte")])]),
]);
const blocksOf = (content: string): ArticleBlock[] => JSON.parse(JSON.stringify(readArticle(content).blocks)) as ArticleBlock[];
const clean = (content: string): string => {
  const strip = (blocks: XbBlock[]): XbBlock[] => blocks.filter((block) => !(block.name === "xb/text" && !block.attrs.content.trim())).map((block) => ("children" in block && block.children ? { ...block, children: strip(block.children as XbBlock[]) } : block) as XbBlock);
  return serializeXb(strip(parseXb(content).blocks));
};

describe("articolo a blocchi (doc 21 §13)", () => {
  it("legge testo, immagini e parti protette, con il contenitore intorno", () => {
    const { blocks, containers } = readArticle(article);
    expect(blocks.map((block) => block.type)).toEqual(["image", "paragraph", "heading", "list", "quote", "kept", "kept"]);
    expect(containers).toEqual([{ uid: "u70726f7361", tag: "div", className: "prosa" }]);
    expect(blocks[1]).toMatchObject({ container: "u70726f7361", html: "Uno <strong>forte</strong> &amp; <a href=\"https://esempio.it/?a=1&amp;b=2\">link</a>" });
    expect(blocks[5]).toMatchObject({ type: "kept", label: "Documenti allegati" });
    expect(blocks[6]).toMatchObject({ type: "kept", label: "fonte", summary: "Fonte" });
  });

  it("senza modifiche restituisce lo stesso contenuto", () => {
    expect(clean(writeArticle(article, blocksOf(article), options))).toBe(clean(article));
  });

  it("cambiando un paragrafo tutto il resto resta com'era, e il testo tiene il suo id per le traduzioni", () => {
    const blocks = blocksOf(article);
    (blocks[1] as { html: string }).html = "Nuovo";
    const out = writeArticle(article, blocks, options);
    expect(out).toContain("\"uid\":\"u756e6f2d74\"");
    expect(readArticle(out).blocks.slice(2)).toEqual(readArticle(article).blocks.slice(2));
    expect(readArticle(out).blocks[0]).toEqual(readArticle(article).blocks[0]);
  });

  it("una graffa scritta è testo, non un'espressione, e torna tale", () => {
    const blocks = blocksOf(article);
    (blocks[1] as { html: string }).html = "Prezzo {x} e <em>{y}</em>";
    const out = writeArticle(article, blocks, options);
    expect(out).toContain("Prezzo \\\\{x\\\\}");
    expect(readArticle(out).blocks[1]).toMatchObject({ html: "Prezzo {x} e <em>{y}</em>" });
  });

  it("un testo con un'espressione o un tag sconosciuto resta protetto", () => {
    const content = serializeXb([element("aaaaaaaaaa", "p", {}, [text("tttttttttt", "Ciao {page.title}")]), element("bbbbbbbbbb", "p", {}, [text("uuuuuuuuuu", "<mark>x</mark>")])]);
    expect(readArticle(content).blocks.map((block) => block.type)).toEqual(["kept", "kept"]);
  });

  it("rifiuta markup e link pericolosi dall'editor", () => {
    const send = (html: string) => writeArticle("", [{ type: "paragraph", html }], options);
    expect(() => send("<script>alert(1)</script>")).toThrow("non ammesso");
    expect(() => send("<img src=x onerror=alert(1)>")).toThrow("non ammesso");
    expect(() => send("<a href=\"javascript:alert(1)\">x</a>")).toThrow("non ammesso");
    expect(() => send("<a href=\"//altro.it\">x</a>")).toThrow("non ammesso");
    expect(() => send("<strong>aperto")).toThrow("non ammesso");
    expect(() => send("<em onclick=\"x\">y</em>")).toThrow("non ammesso");
    expect(send("a &lt;script&gt; b")).toContain("a \\u0026lt;script\\u0026gt; b");
  });

  it("un blocco protetto si sposta o si toglie, ma non si inventa e non si riscrive", () => {
    const blocks = blocksOf(article);
    const moved = [blocks[6]!, ...blocks.slice(0, 6)];
    const out = readArticle(writeArticle(article, moved, options)).blocks;
    expect(out[0]).toMatchObject({ type: "kept", label: "fonte" });
    const forged = [{ type: "kept", uid: "falso", label: "<script>" }, { type: "kept", uid: "u756e6f0000" }];
    expect(readArticle(writeArticle(article, forged, options)).blocks).toEqual([]);
    expect(writeArticle(article, [{ type: "kept", uid: "u666f6e7465", label: "<b>altro</b>" }], options)).toContain("articolo__fonte");
  });

  it("un'immagine nuova viene solo dai media del progetto; una che c'era tiene il suo indirizzo", () => {
    expect(() => writeArticle("", [{ type: "image", src: "https://altro.it/x.png", alt: "" }], options)).toThrow("non valida");
    expect(() => writeArticle("", [{ type: "image", src: "javascript:alert(1)", alt: "" }], options)).toThrow("non valida");
    const out = writeArticle("", [{ type: "image", src: "/__cms-media/p/b", alt: "Foto", width: 10, height: 20, caption: "Una <em>foto</em>" }], options);
    expect(readArticle(out).blocks[0]).toMatchObject({ type: "image", src: "/__cms-media/p/b", alt: "Foto", width: 10, height: 20, caption: "Una <em>foto</em>" });
    const old = serializeXb([element("iiiiiiiiii", "img", { src: "https://esterno.it/a.jpg", alt: "" }, [])]);
    expect(readArticle(writeArticle(old, readArticle(old).blocks, options)).blocks[0]).toMatchObject({ src: "https://esterno.it/a.jpg" });
  });

  it("due blocchi con lo stesso id, come dopo un Invio, ne hanno due distinti", () => {
    const blocks = blocksOf(article);
    const first = blocks[1] as { uid: string; html: string };
    const out = writeArticle(article, [...blocks.slice(0, 2), { type: "paragraph", uid: first.uid, html: "Copia", container: "u70726f7361" }, ...blocks.slice(2)], options);
    const ids = readArticle(out).blocks.map((block) => block.uid);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("il primo testo di un articolo va nel contenitore degli altri articoli", () => {
    const out = writeArticle("", [{ type: "paragraph", html: "Ciao" }], { ...options, fallback: { tag: "div", className: "prosa" } });
    expect(readArticle(out)).toMatchObject({ containers: [{ tag: "div", className: "prosa" }] });
  });

  it("una riga vuota non diventa un paragrafo", () => {
    expect(writeArticle("", [{ type: "paragraph", html: "" }, { type: "paragraph", html: "<br>" }], options)).toBe("");
  });

  it("una tabella semplice si legge e si riscrive; una con celle unite resta protetta", () => {
    const table = serializeXb([element("utabella01", "table", {}, [element("uthead0001", "thead", {}, [element("urow000001", "tr", {}, [element("ucell00001", "th", {}, [text("utext00001", "Nome")]), element("ucell00002", "th", {}, [text("utext00002", "Età")])])]), element("utbody0001", "tbody", {}, [element("urow000002", "tr", {}, [element("ucell00003", "td", {}, [text("utext00003", "Ada")]), element("ucell00004", "td", {}, [text("utext00004", "<em>36</em>")])])])])]);
    const [block] = readArticle(table).blocks;
    expect(block).toMatchObject({ type: "table", header: true, rows: [["Nome", "Età"], ["Ada", "<em>36</em>"]] });
    expect(clean(writeArticle(table, readArticle(table).blocks, options))).toBe(clean(table));
    const changed = writeArticle(table, [{ ...block, rows: [["Nome", "Età"], ["Ada", "37"], ["Bea", ""]] }], options);
    expect(readArticle(changed).blocks[0]).toMatchObject({ type: "table", rows: [["Nome", "Età"], ["Ada", "37"], ["Bea", ""]] });
    const joined = serializeXb([element("utabella02", "table", {}, [element("urow000003", "tr", {}, [element("ucell00005", "td", { colspan: "2" }, [text("utext00005", "x")])])])]);
    expect(readArticle(joined).blocks[0]).toMatchObject({ type: "kept" });
    expect(() => writeArticle("", [{ type: "table", rows: [["<script>x</script>"]] }], options)).toThrow("non ammesso");
    expect(() => writeArticle("", [{ type: "table", rows: [["a"], ["b", "c"]] }], options)).toThrow("lunghezze diverse");
  });

  const rulesOf = (ref: string) => ARTICLE_LIBRARY.find((entry) => entry.ref === ref) ?? null;
  const withCards = { ...options, rulesOf };

  it("i blocchi per chi scrive sono componenti: si scrivono e si rileggono con le loro props", () => {
    const cards = [
      { ref: "articolo/riquadro", props: { variant: "avviso", title: "Attenzione", text: "Testo {con} <strong>graffe</strong> &amp; &lt;segni&gt;" } },
      { ref: "articolo/citazione", props: { text: "Una frase", author: "Calvino" } },
      { ref: "articolo/libro", props: { image: "/__cms-media/p/a", title: "Il barone", link: "https://esempio.it/libro", linkLabel: "Scheda" } },
      { ref: "articolo/galleria", props: {}, entries: [{ props: { src: "/__cms-media/p/a", alt: "Uno" } }, { props: { src: "/__cms-media/p/b", alt: "Due" } }] },
    ].map((card) => ({ type: "card", ...card }));
    const written = writeArticle("", cards, withCards);
    const parsed = parseXb(written).blocks;
    expect(parsed.map((block) => block.name)).toEqual(["xb/component", "xb/component", "xb/component", "xb/component"]);
    const read = readArticle(written).blocks;
    expect(read[0]).toMatchObject({ type: "card", ref: "articolo/riquadro", props: { variant: "avviso", text: "Testo {con} <strong>graffe</strong> &amp; &lt;segni&gt;" } });
    expect(read[3]).toMatchObject({ entries: [{ props: { src: "/__cms-media/p/a", alt: "Uno" } }, { props: { src: "/__cms-media/p/b", alt: "Due" } }] });
    expect(written).toContain("articolo/foto");
    expect(writeArticle(written, read, withCards)).toBe(written);
  });

  it("un blocco con dati fuori dalla definizione si rifiuta, e un'istanza del builder resta protetta", () => {
    const card = (ref: string, props: Record<string, unknown>) => [{ type: "card", ref, props }];
    expect(() => writeArticle("", card("articolo/libro", { title: "x", link: "javascript:alert(1)" }), withCards)).toThrow("collegamento");
    expect(() => writeArticle("", card("articolo/libro", { image: "https://altro.it/a.png" }), withCards)).toThrow("media del sito");
    expect(() => writeArticle("", card("articolo/riquadro", { variant: "altro" }), withCards)).toThrow("scelta");
    expect(() => writeArticle("", card("articolo/inventato", {}), withCards)).toThrow("sconosciuto");
    expect(() => writeArticle("", card("site/testata", {}), withCards)).toThrow("sconosciuto");
    expect(readArticle(writeArticle("", card("articolo/riquadro", { text: "x", nonEsiste: "y" }), withCards)).blocks[0]).toMatchObject({ props: { text: "x" } });
    const dynamic = serializeXb([{ name: "xb/component", attrs: { uid: "ucompone1", ref: "articolo/riquadro", props: { text: { expr: "page.title" } } }, children: [] } as XbBlock]);
    expect(readArticle(dynamic).blocks[0]?.type).toBe("kept");
  });

  it("le traduzioni vedono i testi dei blocchi, righe comprese, e non gli indirizzi", () => {
    const written = writeArticle("", [
      { type: "card", ref: "articolo/libro", props: { title: "Il barone", link: "https://esempio.it/x", linkLabel: "Scheda" }, entries: [] },
      { type: "card", ref: "articolo/domande", props: {}, entries: [{ props: { question: "Perché?", answer: "Perché sì." } }] },
    ], withCards);
    const textProp = (ref: string, name: string) => ["string", "rich-text"].includes(ARTICLE_LIBRARY.find((entry) => entry.ref === ref)?.schema.props[name]?.type ?? "");
    expect(documentSegments(written, textProp).map((segment) => segment.text)).toEqual(["Il barone", "Scheda", "Perché?", "Perché sì."]);
  });

  it("un testo con formati in un blocco accetta solo quelli, e l'indice nasce dai titoli", () => {
    expect(() => writeArticle("", [{ type: "card", ref: "articolo/riquadro", props: { text: '<img src="x" onerror="y">' }, entries: [] }], withCards)).toThrow("non ammesso");
    const written = writeArticle("", [
      { type: "card", ref: "articolo/indice", props: {}, entries: [] },
      { type: "heading", level: 2, html: "Perché <em>così</em>" },
      { type: "paragraph", html: "Testo" },
      { type: "heading", level: 3, html: "Perché così" },
    ], withCards);
    const read = readArticle(written).blocks;
    expect(read[0]).toMatchObject({ entries: [{ props: { title: "Perché così", link: "#perche-cosi" } }, { props: { title: "Perché così", link: "#perche-cosi-2" } }] });
    expect(read[1]).toMatchObject({ anchor: "perche-cosi" });
    const again = writeArticle(written, read.map(({ anchor: _anchor, ...block }: ArticleBlock & { anchor?: string }) => block), withCards);
    expect(again).toBe(written);
    const without = writeArticle(written, read.filter((block) => block.type !== "card"), withCards);
    expect(without).not.toContain('"id"');
  });

  it("di un blocco protetto cambiano i testi e gli indirizzi, non la struttura", () => {
    const source = serializeXb([element("ufonte001", "p", { class: "articolo__fonte" }, [element("ulink0001", "a", { href: "https://vecchio.it/a" }, [{ name: "xb/text", attrs: { uid: "utesto001", content: "Leggi {qui}".replace("{", "\\{").replace("}", "\\}") } } as XbBlock])])]);
    const [kept] = readArticle(source).blocks;
    expect(kept).toMatchObject({ type: "kept", fields: [{ uid: "ulink0001", kind: "link", value: "https://vecchio.it/a" }, { uid: "utesto001", kind: "text", value: "Leggi {qui}" }] });
    expect(writeArticle(source, [kept], options)).toBe(source);
    const written = writeArticle(source, [{ ...kept, fields: [{ uid: "ulink0001", kind: "link", value: "https://nuovo.it/b" }, { uid: "utesto001", kind: "text", value: "Vai <subito>" }] }], options);
    expect(written).toContain("https://nuovo.it/b");
    expect(written).toContain('class\":\"articolo__fonte');
    expect(readArticle(written).blocks[0]).toMatchObject({ fields: [{ value: "https://nuovo.it/b" }, { value: "Vai <subito>" }] });
    expect(() => writeArticle(source, [{ ...kept, fields: [{ uid: "ulink0001", kind: "link", value: "javascript:x" }] }], options)).toThrow("collegamento");
  });

  it("le note sono testo: ogni riga ha l'indirizzo del suo numero, e cambiarne una tiene ferme le altre", () => {
    const written = writeArticle("", [
      { type: "paragraph", html: 'Testo<a href="#nota-1"><sup>1</sup></a>' },
      { type: "list", notes: true, items: [{ html: "Prima <em>nota</em>" }, { html: "Seconda" }] },
    ], withCards);
    expect(written).toContain('"id":"nota-2"');
    expect(written).toContain('"id":"rif-1"');
    expect(written).toContain("#rif-1");
    // The way back is not text: it does not come back to the editor, and is written once however often one saves.
    const again = readArticle(written);
    expect(JSON.stringify(again.blocks)).not.toContain("rif-");
    expect(writeArticle(written, again.blocks, { mediaBase: "/__cms-media/p" }).match(/↩/gu)?.length).toBe(written.match(/↩/gu)?.length);
    const read = readArticle(written).blocks;
    expect(read[1]).toMatchObject({ type: "list", notes: true, items: [{ html: "Prima <em>nota</em>" }, { html: "Seconda" }] });
    expect(writeArticle(written, read, withCards)).toBe(written);
    const odd = serializeXb([element("unote0001", "ol", { class: "xb-art-note" }, [element("unote0002", "li", { id: "altro" }, [])])]);
    expect(readArticle(odd).blocks[0]?.type).toBe("kept");
  });
});

describe("documenti allegati e riga della fonte nei blocchi nuovi (doc 23, voce 111)", () => {
  const link = (uid: string, href: string, label: string, hint: string): XbBlock => element(uid, "a", { class: "documenti__link", href }, [text(`${uid}t`, label), element(`${uid}s`, "span", { class: "sr" }, [text(`${uid}h`, hint)])]);
  const old = serializeXb([
    element("udocs000001", "section", { class: "documenti", "aria-label": "Documenti allegati" }, [
      element("udocs000002", "h2", { class: "documenti__titolo" }, [text("udocs000003", "Documenti")]),
      element("udocs000004", "ul", { class: "documenti__lista" }, [
        element("udocs000005", "li", { class: "documenti__voce" }, [link("udocs000006", "https://esempio.it/a.pdf", "Scarica il pdf dell’evento", " (PDF, sito ufficiale)")]),
        element("udocs000007", "li", { class: "documenti__voce" }, [link("udocs000008", "https://esempio.it/b.pdf", "Il programma &amp; le date", " (PDF)")]),
      ]),
    ]),
    element("ufonte00001", "p", { class: "articolo__fonte" }, [element("ufonte00002", "a", { href: "https://esempio.it/articolo/" }, [text("ufonte00003", "Leggi l'articolo sul sito ufficiale"), element("ufonte00004", "span", { class: "sr" }, [text("ufonte00005", " (sito esterno)")])])]),
  ]);

  it("propone i blocchi nuovi, senza cambiare nulla finché non si sceglie", () => {
    const [documents, source] = readArticle(old).blocks;
    expect(documents).toMatchObject({ type: "kept", label: "Documenti allegati" });
    expect(documents?.type === "kept" && documents.convert).toEqual([
      { type: "heading", uid: "udocs000001-titolo", level: 2, html: "Documenti" },
      { type: "card", uid: "udocs000001-doc1", ref: "articolo/documento", props: { label: "Scarica il pdf dell’evento", href: "https://esempio.it/a.pdf" }, entries: [] },
      { type: "card", uid: "udocs000001-doc2", ref: "articolo/documento", props: { label: "Il programma & le date", href: "https://esempio.it/b.pdf" }, entries: [] },
    ]);
    expect(source?.type === "kept" && source.convert).toEqual([{ type: "card", uid: "ufonte00001-fonte", ref: "articolo/fonte", props: { label: "Leggi l'articolo sul sito ufficiale", link: "https://esempio.it/articolo/" }, entries: [] }]);
    // Sent back as they are, they stay as they are.
    expect(writeArticle(old, readArticle(old).blocks, options)).toBe(old);
  });

  it("scritti al loro posto diventano i componenti dei blocchi", () => {
    const blocks = readArticle(old).blocks.flatMap((block) => (block.type === "kept" && block.convert ? block.convert : [block]));
    const rulesOf = (ref: string) => ARTICLE_LIBRARY.find((entry) => entry.ref === ref) ?? null;
    const written = writeArticle(old, blocks, { ...options, rulesOf });
    expect(written).not.toContain("documenti__lista");
    expect(written).not.toContain("articolo__fonte");
    const again = readArticle(written).blocks;
    expect(again.map((block) => (block.type === "card" ? block.ref : block.type))).toEqual(["heading", "articolo/documento", "articolo/documento", "articolo/fonte"]);
    expect(again[3]).toMatchObject({ props: { label: "Leggi l'articolo sul sito ufficiale", link: "https://esempio.it/articolo/" } });
  });

  it("non converte ciò che ha altra forma o indirizzi non sicuri", () => {
    const shapes = [
      element("ux000000001", "p", { class: "articolo__fonte" }, [text("ux000000002", "Solo testo")]),
      element("ux000000003", "p", { class: "articolo__fonte" }, [element("ux000000004", "a", { href: "javascript:alert(1)" }, [text("ux000000005", "Via")])]),
      element("ux000000006", "section", { class: "documenti", "aria-label": "Documenti allegati" }, [element("ux000000007", "ul", {}, [element("ux000000008", "li", {}, [text("ux000000009", "Niente link")])])]),
      element("ux000000010", "section", { class: "documenti", "aria-label": "Documenti allegati" }, [element("ux000000011", "ul", {}, [element("ux000000012", "li", {}, [element("ux000000013", "a", { href: "https://esempio.it/x.pdf", onclick: "x()" }, [text("ux000000014", "File")])])])]),
    ];
    for (const block of readArticle(serializeXb(shapes)).blocks) expect(block.type === "kept" ? block.convert : "non kept", JSON.stringify(block)).toBeUndefined();
  });
});
