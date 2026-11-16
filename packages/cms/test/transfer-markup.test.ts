import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INLINE_FORMAT, type XbBlock } from "../.generated/histos-dsl/index.js";
import {
  blocksUseSvgText,
  checkTransferBlock,
  checkTransferChildren,
  checkTransferElement,
  checkTransferText,
  childContext,
  inlineStyleLoadsResources,
  isSafeFormAction,
  parseTransferSrcset,
  textareaText,
  TRANSFER_BLOCKED_ATTRIBUTES,
  TRANSFER_BLOCKED_PREFIXES,
  TRANSFER_CONTENT_BLOCKED_PARENTS,
  TRANSFER_ELEMENT_ATTRIBUTES,
  TRANSFER_ELEMENTS_WITHOUT_GLOBAL_ATTRIBUTES,
  TRANSFER_ENUMS,
  TRANSFER_FORM_ONLY_ATTRIBUTES,
  TRANSFER_GLOBAL_ATTRIBUTE_PREFIXES,
  TRANSFER_GLOBAL_ATTRIBUTES,
  TRANSFER_GRAMMARS,
  TRANSFER_LEGACY_REFERENCES,
  TRANSFER_HTML_VALUE_RULES,
  TRANSFER_INLINE_TAGS,
  TRANSFER_MARKUP_ID,
  TRANSFER_MARKUP_REASONS,
  TRANSFER_MARKUP_V1_TAGS,
  TRANSFER_NEW_HTML_TAGS,
  TRANSFER_ROOT_CONTEXT,
  TRANSFER_SVG_ATTRIBUTE_PREFIXES,
  TRANSFER_SVG_ATTRIBUTES,
  TRANSFER_SVG_CAMEL_CASE_ATTRIBUTES,
  TRANSFER_SVG_COMMON_ATTRIBUTES,
  TRANSFER_SVG_TAGS,
  TRANSFER_SVG_TAGS_WITH_COMMON_ATTRIBUTES,
  TRANSFER_SVG_TEXT_ATTRIBUTES,
  TRANSFER_SVG_TEXT_PARENTS,
  TRANSFER_SVG_TEXT_TAGS,
  TRANSFER_SVG_VALUE_RULES,
  TRANSFER_TAGS,
  TRANSFER_URL_ATTRIBUTES,
  TRANSFER_URL_SCHEMES,
  TRANSFER_VOID_TAGS,
  TransferMarkupError,
  transferMarkupIssues,
  transferSvgSubset,
  transferHtmlAttributeAllowed,
  transferUrlIsSafe,
  type TransferMarkupContext,
} from "../src/transfer-markup.js";

/**
 * Pinned in both repositories (Publish here, Histeon WordPress in TransferMarkupVectorsTest.php): any change of the
 * shared fixture shows up as an edit on both sides.
 */
const FIXTURE_SHA256 = "f01eba9667cc68ed616403060c61a7433b9508e92b9ca337f0c332a7adcbfc47";
const fixtureBytes = readFileSync(new URL("../../histos-contract/fixtures/histos-transfer-markup-v1.json", import.meta.url));

type Expect = "accept" | TransferMarkupError["reason"];
interface Fixture {
  version: number;
  id: string;
  lists: Record<string, unknown>;
  elements: Array<{ tag: string; attributes: Record<string, string | true>; ctx: TransferMarkupContext; expect: Expect; note?: string }>;
  children: Array<{ tag: string; kinds: string[]; expect: Expect }>;
  texts: Array<{ content: string; verbatim: boolean; ctx: TransferMarkupContext; expect: Expect }>;
  blocks: Array<{ name: string; ctx: TransferMarkupContext; expect: Expect }>;
}
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as Fixture;

function outcome(run: () => void): string {
  try {
    run();
    return "accept";
  } catch (error) {
    if (error instanceof TransferMarkupError) return error.reason;
    throw error;
  }
}

const describeVector = (vector: { expect: string; note?: string }, what: string) => `${what} → ${vector.expect}${vector.note ? ` (${vector.note})` : ""}`;

describe("histos-transfer-markup-v1: fixture condivisa con Histeon su WordPress", () => {
  it("è la fixture fissata nei due repository", () => {
    expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(FIXTURE_SHA256);
    expect(fixture).toMatchObject({ version: 1, id: TRANSFER_MARKUP_ID });
  });

  it("ha gli stessi elenchi del modulo, del DSL e le stesse grammatiche", () => {
    const lists = fixture.lists;
    expect(lists.htmlTags).toEqual([...TRANSFER_TAGS]);
    expect(lists.newHtmlTags).toEqual([...TRANSFER_NEW_HTML_TAGS]);
    expect(lists.svgTags).toEqual([...TRANSFER_SVG_TAGS]);
    expect(lists.voidTags).toEqual([...TRANSFER_VOID_TAGS]);
    expect(lists.markupV1Tags).toEqual([...TRANSFER_MARKUP_V1_TAGS]);
    expect(lists.inlineTags).toEqual(Object.fromEntries(TRANSFER_INLINE_TAGS));
    expect(lists.inlineTags).toEqual(Object.fromEntries([...INLINE_FORMAT].map(([tag, attributes]) => [tag, [...attributes]])));
    expect(lists.globalAttributes).toEqual(TRANSFER_GLOBAL_ATTRIBUTES);
    expect(lists.globalAttributePrefixes).toEqual(TRANSFER_GLOBAL_ATTRIBUTE_PREFIXES);
    expect(lists.elementAttributes).toEqual(TRANSFER_ELEMENT_ATTRIBUTES);
    expect(lists.elementsWithoutGlobalAttributes).toEqual(TRANSFER_ELEMENTS_WITHOUT_GLOBAL_ATTRIBUTES);
    expect(lists.svgCommonAttributes).toEqual(TRANSFER_SVG_COMMON_ATTRIBUTES);
    expect(lists.svgTagsWithCommonAttributes).toEqual(TRANSFER_SVG_TAGS_WITH_COMMON_ATTRIBUTES);
    expect(lists.svgAttributes).toEqual(TRANSFER_SVG_ATTRIBUTES);
    expect(lists.svgCamelCaseAttributes).toEqual(TRANSFER_SVG_CAMEL_CASE_ATTRIBUTES);
    expect(lists.svgTextTags).toEqual(TRANSFER_SVG_TEXT_TAGS);
    expect(lists.svgTextAttributes).toEqual(TRANSFER_SVG_TEXT_ATTRIBUTES);
    expect(lists.svgAttributePrefixes).toEqual(TRANSFER_SVG_ATTRIBUTE_PREFIXES);
    expect(lists.svgTextParents).toEqual(TRANSFER_SVG_TEXT_PARENTS);
    expect(lists.blockedAttributes).toEqual(TRANSFER_BLOCKED_ATTRIBUTES);
    expect(lists.formOnlyAttributes).toEqual(TRANSFER_FORM_ONLY_ATTRIBUTES);
    expect(lists.blockedPrefixes).toEqual(TRANSFER_BLOCKED_PREFIXES);
    expect(lists.urlAttributes).toEqual(TRANSFER_URL_ATTRIBUTES);
    expect(lists.urlSchemes).toEqual(TRANSFER_URL_SCHEMES);
    expect(lists.contentBlockedParents).toEqual(TRANSFER_CONTENT_BLOCKED_PARENTS);
    expect(lists.enums).toEqual(TRANSFER_ENUMS);
    expect(lists.htmlValueRules).toEqual(TRANSFER_HTML_VALUE_RULES);
    expect(lists.svgValueRules).toEqual(TRANSFER_SVG_VALUE_RULES);
    expect(lists.grammars).toEqual(TRANSFER_GRAMMARS);
    expect(lists.legacyReferences).toEqual(TRANSFER_LEGACY_REFERENCES);
    expect(Object.keys(lists).sort()).toEqual([
      "blockedAttributes", "blockedPrefixes", "contentBlockedParents", "elementAttributes", "elementsWithoutGlobalAttributes", "enums",
      "formOnlyAttributes", "globalAttributePrefixes", "globalAttributes", "grammars", "htmlTags", "htmlValueRules", "inlineTags", "legacyReferences",
      "markupV1Tags", "newHtmlTags", "svgAttributePrefixes", "svgAttributes", "svgCamelCaseAttributes", "svgCommonAttributes", "svgTags",
      "svgTagsWithCommonAttributes", "svgTextAttributes", "svgTextParents", "svgTextTags", "svgValueRules", "urlAttributes", "urlSchemes", "voidTags",
    ]);
  });

  it("usa grammatiche che compilano con il flag u, solo classi ASCII scritte per esteso e regole che puntano a voci esistenti", () => {
    for (const [name, source] of Object.entries(TRANSFER_GRAMMARS)) {
      expect(() => new RegExp(source, "u"), name).not.toThrow();
      expect(source, name).not.toMatch(/\\[sdwSDW]/u);
    }
    for (const rule of Object.values(TRANSFER_HTML_VALUE_RULES)) {
      if (rule.enum) expect(TRANSFER_ENUMS[rule.enum], rule.enum).toBeDefined();
      if (rule.grammar) expect(TRANSFER_GRAMMARS[rule.grammar], rule.grammar).toBeDefined();
    }
    for (const grammar of Object.values(TRANSFER_SVG_VALUE_RULES)) expect(TRANSFER_GRAMMARS[grammar], grammar).toBeDefined();
    for (const [tag, attributes] of Object.entries(TRANSFER_SVG_ATTRIBUTES)) {
      for (const attribute of [...attributes, ...(TRANSFER_SVG_TAGS_WITH_COMMON_ATTRIBUTES.includes(tag) ? [...TRANSFER_SVG_COMMON_ATTRIBUTES, ...TRANSFER_SVG_TEXT_ATTRIBUTES] : [])]) {
        expect(TRANSFER_SVG_VALUE_RULES[`${tag}.${attribute}`] ?? TRANSFER_SVG_VALUE_RULES[attribute], `${tag}.${attribute}`).toBeDefined();
      }
    }
    for (const prefix of TRANSFER_SVG_ATTRIBUTE_PREFIXES) expect(TRANSFER_SVG_VALUE_RULES[`${prefix}*`], prefix).toBeDefined();
    // Every SVG element has its own list, and the elements of histos-svg-text-v1 are SVG elements with the common attributes.
    expect(Object.keys(TRANSFER_SVG_ATTRIBUTES).sort()).toEqual([...TRANSFER_SVG_TAGS].sort());
    for (const tag of TRANSFER_SVG_TEXT_TAGS) expect(TRANSFER_SVG_TAGS_WITH_COMMON_ATTRIBUTES, tag).toContain(tag);
  });

  it("usa solo codici di motivo noti", () => {
    const reasons = new Set<string>(["accept", ...TRANSFER_MARKUP_REASONS]);
    for (const group of [fixture.elements, fixture.children, fixture.texts, fixture.blocks]) for (const vector of group) expect(reasons.has(vector.expect)).toBe(true);
  });

  it.each(fixture.elements.map((vector) => [describeVector(vector, `<${vector.tag}> ${JSON.stringify(vector.attributes).slice(0, 80)} in ${vector.ctx.parent ?? "radice"}`), vector] as const))("elemento %s", (_name, vector) => {
    expect(outcome(() => checkTransferElement(vector.tag, vector.attributes, vector.ctx))).toBe(vector.expect);
  });

  it.each(fixture.children.map((vector) => [describeVector(vector, `<${vector.tag}> [${vector.kinds.join(", ")}]`), vector] as const))("figli %s", (_name, vector) => {
    expect(outcome(() => checkTransferChildren(vector.tag, vector.kinds))).toBe(vector.expect);
  });

  it.each(fixture.texts.map((vector) => [describeVector(vector, `${JSON.stringify(vector.content).slice(0, 60)}${vector.verbatim ? " letterale" : ""} in ${vector.ctx.parent ?? "radice"}`), vector] as const))("testo %s", (_name, vector) => {
    expect(outcome(() => checkTransferText(vector.content, vector.verbatim, vector.ctx))).toBe(vector.expect);
  });

  it.each(fixture.blocks.map((vector) => [describeVector(vector, `${vector.name} in ${vector.ctx.parent ?? "radice"}${vector.ctx.svg ? " (svg)" : ""}`), vector] as const))("blocco %s", (_name, vector) => {
    expect(outcome(() => checkTransferBlock(vector.name, vector.ctx))).toBe(vector.expect);
  });
});

describe("histos-transfer-markup-v1: elenchi chiusi di attributi per ogni tag HTML (doc 23, voce 172)", () => {
  it("ha un elenco per ogni tag HTML, vecchio e nuovo, e nessuno per tag che non esistono", () => {
    expect(Object.keys(TRANSFER_ELEMENT_ATTRIBUTES).sort()).toEqual([...TRANSFER_TAGS].sort());
  });

  it("ammette ciò che scrivono i campi del pannello Proprietà, l'importazione di siti statici e i comportamenti di Histeon", () => {
    const written: Array<[string, string]> = [
      ["a", "href"], ["a", "target"], ["a", "rel"], ["a", "title"], ["a", "aria-label"], ["a", "aria-current"], ["a", "id"],
      ["img", "src"], ["img", "alt"], ["img", "width"], ["img", "height"], ["img", "loading"], ["img", "srcset"], ["img", "sizes"],
      ["ol", "start"], ["ol", "reversed"], ["time", "datetime"], ["td", "colspan"], ["td", "rowspan"], ["th", "scope"], ["blockquote", "cite"], ["q", "cite"],
      ["div", "data-xb-tabs"], ["div", "data-xb-toggle"], ["section", "data-xb-reveal"], ["figure", "data-xb-video"], ["div", "data-xb-map"],
      ["div", "data-histos-dialog"], ["section", "data-histos-js"], ["div", "role"], ["div", "aria-labelledby"], ["div", "hidden"], ["li", "data-index"],
    ];
    for (const [tag, name] of written) expect(transferHtmlAttributeAllowed(tag, name), `${tag}.${name}`).toBe(true);
  });

  it("rifiuta i nomi fuori dall'elenco e i data-* che le librerie leggono come codice", () => {
    for (const [tag, name] of [["div", "up-target"], ["div", "script"], ["p", "align"], ["img", "usemap"], ["div", "data-text"], ["a", "data-method"], ["div", "data-dojo-type"], ["div", "data-xb-uid"], ["source", "data-x"]]) {
      expect(transferHtmlAttributeAllowed(tag as string, name as string), `${tag}.${name}`).toBe(false);
    }
  });
});

describe("histos-transfer-markup-v1: funzioni condivise con il renderer", () => {
  it("passa il contesto ai figli: svg, form e button restano veri sotto il loro elemento", () => {
    const inSvg = childContext(TRANSFER_ROOT_CONTEXT, "svg");
    expect(inSvg).toEqual({ parent: "svg", svg: true, form: false, button: false });
    expect(childContext(childContext(childContext(TRANSFER_ROOT_CONTEXT, "form"), "button"), "span")).toEqual({ parent: "span", svg: false, form: true, button: true });
  });

  it("controlla schemi URL e CSS sul valore decodificato", () => {
    expect(transferUrlIsSafe("/x?a=1&b=2")).toBe(true);
    expect(transferUrlIsSafe("{item.url}")).toBe(true);
    expect(transferUrlIsSafe("java\nscript:alert(1)")).toBe(false);
    expect(transferUrlIsSafe("ftp://example.org/")).toBe(false);
    expect(inlineStyleLoadsResources("background: cross-fade(a, b)")).toBe(true);
    expect(inlineStyleLoadsResources("background: \\000075rl(x)")).toBe(true);
    expect(inlineStyleLoadsResources("color: var(--xb-primary)")).toBe(false);
    expect(isSafeFormAction("/cerca/")).toBe(true);
    expect(isSafeFormAction("https://forms.example/invio")).toBe(true);
    expect(isSafeFormAction("https://forms.example/invio\u0085")).toBe(false);
  });

  it("legge srcset solo nella forma condivisa e stampa il testo di una textarea come esc_textarea", () => {
    expect(parseTransferSrcset("a.png 1x,  b.png 2x")).toEqual([{ url: "a.png", descriptor: "1x" }, { url: "b.png", descriptor: "2x" }]);
    expect(parseTransferSrcset("a.png 1x 2x")).toBeNull();
    expect(parseTransferSrcset("")).toBeNull();
    expect(textareaText(`Dì "ciao" > 'tu' & <b>`)).toBe("Dì &quot;ciao&quot; &gt; &#039;tu&#039; &amp; &lt;b&gt;");
  });
});

describe("histos-transfer-markup-v1: SVG incollato nel builder locale (P2)", () => {
  let uid = 0;
  const el = (tag: string, attributes: Record<string, string | true> = {}, children: XbBlock[] = []): XbBlock =>
    ({ name: "xb/element", attrs: { uid: `s${++uid}`, tag, ...(Object.keys(attributes).length ? { attributes } : {}) }, children });
  const text = (content: string): XbBlock => ({ name: "xb/text", attrs: { uid: `s${++uid}`, content } });

  it("toglie in silenzio le dichiarazioni di namespace e tiene ciò che il trasferimento accetta, byte per byte", () => {
    const pasted = el("svg", { xmlns: "http://www.w3.org/2000/svg", "xmlns:xlink": "http://www.w3.org/1999/xlink", viewBox: "0 0 24 24", width: "24", fill: "none", stroke: "currentColor", "aria-hidden": "true" }, [
      el("title", {}, [text("Cerca")]),
      el("g", { "stroke-width": "2" }, [el("circle", { cx: "11", cy: "11", r: "7" }), el("path", { d: "m21 21-4.3-4.3", "stroke-linecap": "round" })]),
    ]);
    const { block, dropped } = transferSvgSubset(pasted);
    expect(dropped).toEqual([]);
    expect(block).toMatchObject({ attrs: { tag: "svg", attributes: { viewBox: "0 0 24 24", width: "24", fill: "none", stroke: "currentColor", "aria-hidden": "true" } } });
    expect(Object.keys((block as Extract<XbBlock, { name: "xb/element" }>).attrs.attributes ?? {})).not.toContain("xmlns");
    expect(transferMarkupIssues([block as XbBlock])).toEqual([]);
  });

  it("lascia fuori, e nomina, elementi, attributi e testo che il trasferimento rifiuta", () => {
    const pasted = el("svg", { viewBox: "0 0 10 10", style: "color:url(x)", tabindex: "0" }, [
      el("clipPath", { id: "c" }, [el("rect", { width: "1", height: "1" })]),
      el("use", { href: "#icona" }),
      el("text", { x: "1", rotate: "45" }, [el("a", { href: "/x" }, [text("link")])]),
      el("rect", { width: "10", height: "10", fill: "url(https://esempio.test/g.svg#g)", rx: "\\{props.r\\}" }),
      el("g", {}, [text("testo vagante"), el("circle", { r: "2", onclick: "x()" })]),
    ]);
    const { block, dropped } = transferSvgSubset(pasted);
    expect(dropped).toEqual(expect.arrayContaining(["style", "tabindex", "<clipPath>", "<use>", "<a>", "rotate", "fill", "rx", "testo", "onclick"]));
    expect(block).toMatchObject({ attrs: { attributes: { viewBox: "0 0 10 10" } }, children: [{ attrs: { tag: "text", attributes: { x: "1" } }, children: [] }, { attrs: { tag: "rect", attributes: { width: "10", height: "10" } } }, { attrs: { tag: "g" }, children: [{ attrs: { tag: "circle", attributes: { r: "2" } } }] }] });
    expect(transferMarkupIssues([block as XbBlock])).toEqual([]);
    const tags = JSON.stringify(block).match(/"tag":"[A-Za-z]+"/gu);
    expect(tags).toEqual(['"tag":"svg"', '"tag":"text"', '"tag":"rect"', '"tag":"g"', '"tag":"circle"']);
  });

  it("tiene testo, sfumature, stile e stati (histos-svg-text-v1), e sa dire che servono a un sito aggiornato", () => {
    const pasted = el("svg", { viewBox: "0 0 10 10", style: "--mc:#d4a843", "data-impasto": "classico" }, [
      el("defs", {}, [el("linearGradient", { id: "g", gradientUnits: "userSpaceOnUse" }, [el("stop", { offset: "0", "stop-color": "#fff" })])]),
      el("rect", { width: "10", height: "10", fill: "url(#g)" }),
      el("g", { "font-family": "'GFS Didot', serif", "text-anchor": "middle", lang: "el", "aria-pressed": "true" }, [
        el("text", { x: "5", y: "5" }, [text("Πα "), el("tspan", { style: "--k:0" }, [text("A")])]),
      ]),
    ]);
    const { block, dropped } = transferSvgSubset(pasted);
    expect(dropped).toEqual([]);
    expect(block).toEqual(pasted);
    expect(transferMarkupIssues([block as XbBlock])).toEqual([]);
    expect(blocksUseSvgText([pasted])).toBe(true);
    // Each of these alone needs the capability; an icon of the older subset does not.
    for (const one of [
      el("svg", {}, [el("text", {}, [])]),
      el("svg", {}, [el("defs")]),
      el("svg", { style: "color:red" }),
      el("svg", { "data-x": "1" }),
      el("svg", {}, [el("g", { "aria-pressed": "true" })]),
      el("svg", {}, [el("path", { d: "M0 0", fill: "url(#g)" })]),
      el("svg", {}, [el("path", { d: "M0 0", stroke: "url(#g)" })]),
      el("div", {}, [el("svg", {}, [el("g", { lang: "el" })])]),
    ]) expect(blocksUseSvgText([one]), JSON.stringify(one)).toBe(true);
    const icon = el("svg", { viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true", "aria-label": "Cerca", role: "img" }, [el("title", {}, [text("Cerca")]), el("path", { d: "M0 0", fill: "var(--xb-primary)" })]);
    expect(blocksUseSvgText([icon, el("div", { style: "color:red", "data-x": "1", lang: "el" })])).toBe(false);
  });

  it("non trasforma in SVG ciò che non lo è, né un svg annidato", () => {
    expect(transferSvgSubset(el("div")).block).toBeNull();
    const nested = transferSvgSubset(el("svg", { viewBox: "0 0 1 1" }, [el("svg", { viewBox: "0 0 1 1" })]));
    expect(nested.dropped).toEqual(["<svg>"]);
    expect(transferSvgSubset(el("svg"), childContext(TRANSFER_ROOT_CONTEXT, "picture")).block).toBeNull();
  });
});
