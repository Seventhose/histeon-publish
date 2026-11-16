import { describe, expect, it } from "vitest";
import { applyCoreHoverMedia } from "../src/core-hover-media.js";
import { applyCoreEasingGradients } from "../src/core-easing-gradients.js";

describe("trasformazione hover media di Core Framework", () => {
  it("sposta i selettori hover dentro una media query e lascia gli altri fuori", () => {
    const result = applyCoreHoverMedia(".card, .card:hover { color: red; }");
    expect(result).toContain(".card { color: red; }");
    expect(result).toContain("@media (hover: hover)");
    expect(result).toContain(".card:hover");
  });

  it("trasforma correttamente liste di selettori con virgole annidate", () => {
    const result = applyCoreHoverMedia(':is(.card, .tile):hover, [data-label=", :hover"] { color: red; }');
    expect(result).toContain("@media (hover: hover)");
    expect(result).toContain(":is(.card, .tile):hover");
    expect(result).toContain('[data-label=", :hover"]');
    expect(result).not.toMatch(/^\[data-label=.*\{ color: red; \}$/mu);
  });

  it("non trasforma :hover negato o già dentro la media corretta", () => {
    const negated = ".card:not(:hover) { color: red; }";
    const nested = "@media (hover: hover) { .card:hover { color: red; } }";
    expect(applyCoreHoverMedia(negated)).toBe(negated);
    expect(applyCoreHoverMedia(nested)).toBe(nested);
  });

  it("riconosce :hover dentro :not quando è parte di un selettore più ampio", () => {
    const css = ".card:not(.disabled:hover) { color: red; }";
    const result = applyCoreHoverMedia(css);
    expect(result).toContain("@media (hover: hover)");
    expect(result).toContain(":not(.disabled:hover)");
  });

  it("non cambia i selettori senza hover e il fallback touch di Core", () => {
    const css = ".card { color: red; } html:not(.supports-touch) .card:hover { color: blue; }";
    expect(applyCoreHoverMedia(css)).toBe(css);
  });
});

describe("trasformazione gradienti easing di Core Framework", () => {
  it("espande il timing easing in fermate colore HSL", () => {
    const result = applyCoreEasingGradients(".example { background: linear-gradient(#000, ease-in-out, #fff); }");
    expect(result.unsupported).toBe(0);
    expect(result.css).not.toContain("ease-in-out");
    expect(result.css.match(/hsl\(/gu)).toHaveLength(13);
    expect(result.css).toContain("linear-gradient(hsl(");
  });

  it("lascia invariati i gradienti ordinari e conserva la direzione", () => {
    const ordinary = ".example { background: linear-gradient(#000, #fff); }";
    expect(applyCoreEasingGradients(ordinary)).toEqual({ css: ordinary, unsupported: 0 });

    const directed = applyCoreEasingGradients(".example { background: linear-gradient(to right, red, ease, blue); }");
    expect(directed.unsupported).toBe(0);
    expect(directed.css).toContain("linear-gradient(to right,");
    expect(directed.css).not.toContain(", ease,");
  });

  it("converte easing steps e Bézier nei gradienti lineari e radiali", () => {
    const radial = applyCoreEasingGradients(".radial { background: radial-gradient(circle, #000, steps(2, end), #fff); }");
    expect(radial.unsupported).toBe(0);
    expect(radial.css).toContain("radial-gradient(circle, hsl(");
    expect(radial.css).not.toContain("steps(");

    const bezier = applyCoreEasingGradients(".bezier { background: linear-gradient(45deg, #000, cubic-bezier(0.2, 0, 0.8, 1), #fff); }");
    expect(bezier.unsupported).toBe(0);
    expect(bezier.css).toContain("linear-gradient(45deg, hsl(");
    expect(bezier.css).not.toContain("cubic-bezier(");
  });

  it("conserva e segnala le espressioni easing con colori non convertibili", () => {
    const css = ".example { background: linear-gradient(#000, ease, var(--brand)); }";
    expect(applyCoreEasingGradients(css)).toEqual({ css, unsupported: 1 });
  });

  it("non perde fermate nei gradienti con più di due colori", () => {
    const css = ".example { background: linear-gradient(red, ease-in-out, blue, white); }";
    expect(applyCoreEasingGradients(css)).toEqual({ css, unsupported: 1 });
  });
});
