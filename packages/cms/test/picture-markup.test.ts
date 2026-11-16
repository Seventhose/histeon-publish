import { describe, expect, it } from "vitest";
import { pageWideImageRules, pictureImages, readsAsImageDimension, wrapPictures, type PictureSource } from "../src/picture-markup.js";

/**
 * Queue B6: an <img> of the build's media becomes a <picture> only where the page cannot change. The page's CSS is
 * matched against the image and everything around it as written and as it would be; anything that could select
 * something else keeps the image as it is.
 */

const SHA = "a".repeat(64);
const SRC = `/media/${SHA}.jpg`;
const img = (extra = "") => `<img src="${SRC}" width="800" height="600" alt=""${extra}>`;
const page = (css: string, body: string) => `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>T</title><style>${css}</style></head><body>${body}</body></html>`;
const sources: PictureSource[] = [
  { type: "image/jxl", candidates: [{ url: "/media/b.jxl", width: 480 }, { url: "/media/c.jxl", width: 800 }] },
  { type: "image/avif", candidates: [{ url: "/media/d.avif", width: 480 }, { url: "/media/e.avif", width: 800 }] },
  { type: "image/webp", candidates: [{ url: "/media/f.webp", width: 480 }, { url: "/media/g.webp", width: 800 }] },
];

/** Whether the image would be wrapped, or why not. */
function verdict(css: string, body: string): string {
  const checked = pictureImages(page(css, body));
  if (checked.images.length) return "sì";
  const skipped = checked.skipped[0];
  return skipped ? `${skipped.reason}${skipped.detail ? `: ${skipped.detail}` : ""}` : "nessuna immagine";
}

describe("<picture> solo dove la pagina non cambia (B6)", () => {
  it("avvolge l'<img> e lascia il resto della pagina byte per byte", () => {
    const html = page("img{max-width:100%;height:auto}", `<main><p>Prima</p>${img(' loading="lazy" class="foto"')}<p>Dopo</p></main>`);
    const result = wrapPictures(pictureImages(html), () => sources);
    expect(result.wrapped).toEqual([{ src: SRC }]);
    const tag = img(' loading="lazy" class="foto"');
    expect(result.html).toBe(html.replace(tag, `<picture style="display:contents"><source type="image/jxl" srcset="/media/b.jxl 480w, /media/c.jxl 800w" sizes="100vw" hidden><source type="image/avif" srcset="/media/d.avif 480w, /media/e.avif 800w" sizes="100vw" hidden><source type="image/webp" srcset="/media/f.webp 480w, /media/g.webp 800w" sizes="100vw" hidden>${tag}</picture>`));
    // An image with no sources, or not of the build's media, stays as it is.
    expect(wrapPictures(pictureImages(html), () => undefined).html).toBe(html);
    expect(pictureImages(page("", '<img src="/other/x.jpg" width="1" height="1">')).images).toEqual([]);
  });

  it("i <source> non hanno un box: in una griglia o in un flex l'immagine resta il primo elemento (doc 23, voce 183)", () => {
    // Before: an empty <source> in a display:contents <picture> was a grid item, with a track and a gap above the image.
    const html = page(".scheda{display:grid;gap:1rem}", `<article class="scheda">${img()}<h2>Titolo</h2></article>`);
    const wrapped = wrapPictures(pictureImages(html), () => sources).html;
    expect([...wrapped.matchAll(/<source [^>]*>/gu)].map((match) => match[0].endsWith(" hidden>"))).toEqual([true, true, true]);
    // A reset that hides [hidden] does what the attribute does; a rule that shows them again keeps the image as it is.
    expect(verdict("[hidden]{display:none!important}", img())).toBe("sì");
    expect(verdict("[hidden]{display:block}", img())).toBe("css: [hidden]");
  });

  it("usa il sizes dell'autore, con i caratteri dell'attributo protetti", () => {
    const html = page("", img(' sizes="(min-width: 60em) 33vw, 100vw"'));
    expect(wrapPictures(pictureImages(html), () => sources.slice(2)).html).toContain('<source type="image/webp" srcset="/media/f.webp 480w, /media/g.webp 800w" sizes="(min-width: 60em) 33vw, 100vw" hidden>');
  });

  it("lascia stare un <picture> dell'autore, un srcset dell'autore e le immagini senza le due misure", () => {
    expect(verdict("", `<picture><source srcset="/media/x.webp" type="image/webp">${img()}</picture>`)).toBe("picture");
    expect(verdict("", img(' srcset="/x.jpg 2x"'))).toBe("srcset");
    expect(verdict("", `<img src="${SRC}" alt="">`)).toBe("unsized");
    expect(verdict("", `<img src="${SRC}" width="100%" height="200" alt="">`)).toBe("unsized");
    expect(verdict("", `<img src="${SRC}" width="320px" height="200" alt="">`)).toBe("sì");
    expect(readsAsImageDimension(" 12.5")).toBe(true);
    expect(readsAsImageDimension("auto")).toBe(false);
    expect(readsAsImageDimension("")).toBe(false);
  });

  it("le regole che dipendono dal genitore o dai fratelli dell'immagine la lasciano com'è", () => {
    expect(verdict(".card > img{width:100%}", `<div class="card">${img()}</div>`)).toBe("css: .card > img");
    // A rule nested in its block's selector (as the import writes them) is named whole, nesting resolved.
    expect(verdict(".card{& > img{width:100%}}", `<div class="card">${img()}</div>`)).toBe("css: .card > img");
    expect(verdict(".card, .tile{> img{width:100%}}", `<div class="card">${img()}</div>`)).toBe("css: :is(.card, .tile) > img");
    expect(verdict("img + p{margin:0}", `<div>${img()}<p>x</p></div>`)).toBe("css: img + p");
    expect(verdict("h2 ~ img{float:left}", `<div><h2>T</h2>${img()}</div>`)).toBe("css: h2 ~ img");
    expect(verdict("img:first-child{display:block}", `<div>${img()}</div>`)).toBe("css: img:first-child");
    expect(verdict(".g img:nth-of-type(2){x:y}", `<div class="g">${img()}${img()}</div>`)).toBe("css: .g img:nth-of-type(2)");
    // The flow of Histeon CSS around an image that follows something: its margin would go to the <picture>.
    expect(verdict(".xb-flow > * + *{margin-block-start:1rem}", `<div class="xb-flow"><p>a</p>${img()}</div>`)).toBe("css: .xb-flow > * + *");
    // An image first in the flow, or outside it, keeps the same rules (the paragraph after it follows the <picture>).
    expect(verdict(".xb-flow > * + *{margin-block-start:1rem}", `<div class="xb-flow">${img()}<p>a</p></div>`)).toBe("sì");
    expect(verdict(".xb-flow > * + *{margin-block-start:1rem}", `<div class="altro"><p>a</p>${img()}</div>`)).toBe("sì");
    // A descendant selector does not see the <picture>.
    expect(verdict(".card img{border-radius:1rem} a:hover img{opacity:.8}", `<a class="card" href="/">${img()}</a>`)).toBe("sì");
  });

  it("risolve l'annidamento CSS e le liste di :is, :where e :not", () => {
    expect(verdict(".xb-flow { & > * + * { margin-top: 1rem } }", `<div class="xb-flow"><p>a</p>${img()}</div>`)).toBe("css: .xb-flow > * + *");
    expect(verdict(".xb-flow { & > * + * { margin-top: 1rem } }", `<div class="altro"><p>a</p>${img()}</div>`)).toBe("sì");
    expect(verdict(".card { > img { width: 100% } }", `<div class="card">${img()}</div>`)).toBe("css: .card > img");
    expect(verdict(":where(.card) > :where(img){x:y}", `<div class="altro">${img()}</div>`)).toBe("sì");
    expect(verdict(":is(.card, .box) > img{x:y}", `<div class="box">${img()}</div>`)).toBe("css: :is(.card, .box) > img");
    expect(verdict("img:not(:only-child){x:y}", `<div>${img()}</div>`)).toBe("css: img:not(:only-child)");
    // Dynamic states are tried both ways: a parent selected while hovered changes, a descendant never does.
    expect(verdict("a:hover > img{opacity:.5}", `<a href="/">${img()}</a>`)).toBe("css: a:hover > img");
    expect(verdict("a:focus-visible img{outline:2px solid}", `<a href="/">${img()}</a>`)).toBe("sì");
    // Keyframes select nothing.
    expect(verdict("@keyframes x { from { opacity: 0 } to { opacity: 1 } } @media (min-width: 40em) { img { max-width: 50% } }", `<div>${img()}</div>`)).toBe("sì");
  });

  it("il nuovo <picture> non deve ricevere valori ereditati o contenuto, i <source> nessun riquadro", () => {
    // `.card > *` now selects the <picture>: the font size would reach the image through it.
    expect(verdict(".card > *{font-size:2em}", `<div class="card"><span>x</span>${img()}</div>`)).toBe("css: .card > *");
    // A universal rule selects the image too: what it sets, the image sets itself.
    expect(verdict("*{color:#222;box-sizing:border-box;margin:0}", `<div>${img()}</div>`)).toBe("sì");
    expect(verdict("*,*::before,*::after{box-sizing:border-box;border-width:0;border-style:solid}", `<div>${img()}</div>`)).toBe("sì");
    // A box on every element would draw the empty <source> elements.
    expect(verdict("*{padding:4px}", `<div>${img()}</div>`)).toBe("css: *");
    expect(verdict("body *::before{content:'•'}", `<div>${img()}</div>`)).toBe("css: body *::before");
    // A rule for picture or source could see more than one image: nothing is wrapped.
    expect(verdict("picture{display:block}", `<div>${img()}</div>`)).toBe("css: @scope o una regola per picture o source nel CSS");
    // A :has() on the image's ancestor (or a sibling before one) can see the wrap: that image stays as it is…
    expect(verdict("div:has(> img){x:y}", `<div>${img()}</div>`)).toBe("css: div:has(> img) (:has() intorno all'immagine)");
    expect(verdict(".pre:has(+ .box img){x:y}", `<p class="pre">x</p><div class="box">${img()}</div>`)).toBe("css: .pre:has(+ .box img) (:has() intorno all'immagine)");
    // …but one elsewhere on the page does not touch it (doc 23 item 123: the lightbox's html:has(.open) did, for every image).
    expect(verdict(".lightbox:has(.open){overflow:hidden}", `<div class="lightbox"><span></span></div><main>${img()}</main>`)).toBe("sì");
    expect(verdict("nav:has(a:hover) .menu{display:block}", `<nav><a>x</a><ul class="menu"></ul></nav><main>${img()}</main>`)).toBe("sì");
    // On an ancestor, only an argument that can end on the image, a <picture> or a <source> sees the wrap.
    expect(verdict("html:has(.lightbox.open){overflow:hidden}", `<main><figure>${img()}</figure></main>`)).toBe("sì");
    expect(verdict("figure:has(.didascalia){padding:1rem}", `<figure>${img()}<figcaption class="didascalia">x</figcaption></figure>`)).toBe("sì");
    expect(verdict("figure:has(img){padding:1rem}", `<figure>${img()}</figure>`)).toBe("css: figure:has(img) (:has() intorno all'immagine)");
    expect(verdict("figure:has(picture){padding:1rem}", `<figure>${img()}</figure>`)).toBe("css: @scope o una regola per picture o source nel CSS");
  });

  it("un'immagine che il CSS dimensiona dal file resta com'è: il srcset ne cambierebbe la misura", () => {
    expect(verdict("img{width:auto;height:auto}", `<div>${img()}</div>`)).toBe("css: width e height automatici nel CSS");
    expect(verdict("img{height:auto}", `<div>${img()}</div>`)).toBe("sì");
    expect(verdict("img{width:auto;height:40px}", `<div>${img()}</div>`)).toBe("sì");
    expect(verdict("", `<div>${img(' style="width:auto;height:auto"')}</div>`)).toBe("css: width e height automatici nel CSS");
    expect(verdict("img{all:unset}", `<div>${img()}</div>`)).toBe("css: img{all:unset}".replace("img{all:unset}", "img"));
  });

  it("un foglio che non si legge non avvolge nulla", () => {
    expect(verdict("img > > p {}", `<div>${img()}</div>`)).toBe("css: un foglio CSS non si legge");
    expect(verdict("a[href=]{x:y}", `<div>${img()}</div>`)).toBe("css: un foglio CSS non si legge");
  });

  it("ricontrolla con il numero vero di <source>: un img:nth-child che uno solo farebbe scattare", () => {
    const html = page("img:nth-child(2){outline:1px solid}", `<div>${img()}</div>`);
    const checked = pictureImages(html);
    // Assuming three sources the image would be the fourth child: the check lets it through.
    expect(checked.images).toHaveLength(1);
    // With one source it would be the second: the rewrite refuses it.
    const result = wrapPictures(checked, () => sources.slice(1, 2));
    expect(result.wrapped).toEqual([]);
    expect(result.skipped).toEqual([{ src: SRC, reason: "css", detail: "img:nth-child(2)" }]);
    expect(result.html).toBe(html);
  });
});

describe("le regole che tolgono i formati moderni a tutte le immagini (doc 17, voce 1)", () => {
  it("trova ::selection, :hover senza elemento, *, @scope, picture, :has() vicino all'immagine, con il foglio e la riga", () => {
    const base = [
      "*, *::before, *::after { box-sizing: border-box; }",
      "* { margin: 0; }",
      "::selection { background: yellow; }",
      ":focus-visible { outline: 2px solid red; }",
      "a:hover { color: red; }",
      ":where(a, button):focus-visible { outline: 2px solid red; }",
      "@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto; } }",
      ".card > img { display: block; }",
      ".card:has(img) { padding: 1rem; }",
      ":root:has(img) { color: red; }",
      "img { max-width: 100%; height: auto; }",
    ].join("\n");
    const rules = pageWideImageRules([base, "@scope (.card) { img { border: 0; } }\npicture { display: block; }"]);
    expect(rules.map((rule) => [rule.sheet, rule.line, rule.rule])).toEqual([
      [0, 3, "::selection"],
      [0, 4, ":focus-visible"],
      [0, 7, "*"],
      [0, 10, ":root:has(img)"],
      [1, 1, "@scope (.card)"],
      [1, 2, "picture"],
    ]);
    expect(rules.map((rule) => rule.advice)).toEqual([
      "toglila",
      "metti un elemento davanti: :where(a, button, summary, input, textarea, select):focus-visible",
      expect.stringContaining("scroll-behavior va su html"),
      expect.stringContaining("una classe sull'elemento"),
      expect.stringContaining("una classe sull'img"),
      expect.stringContaining("una classe sull'img"),
    ]);
    // A rule of one class, and a sheet that does not parse.
    expect(pageWideImageRules([".card > img { display: block; } .foto { width: auto; height: auto; }"])).toEqual([]);
    expect(pageWideImageRules(["img { width: auto; height: auto; }"]).map((rule) => rule.rule)).toEqual(["img"]);
    expect(pageWideImageRules(["a { color: red", "::selection { background: red; }"]).map((rule) => [rule.sheet, rule.rule])).toEqual([[1, "::selection"]]);
    // The selector styles before their build: SCSS suffixes joined as SCSS does.
    expect(pageWideImageRules([".foto-card { display: grid; &__img { width: auto; height: auto; } } .a, .b { &__x { color: red; } }"])).toEqual([]);
    expect(pageWideImageRules([":where(.a, .b) { &:hover { outline: 2px solid; } } .menu { &--aperto :focus-visible { outline: 1px solid; } }"])).toEqual([]);
  });
});
