/**
 * Core Framework's fluid scales as its default preset (1.1.0, open source) writes them (doc 18 §6.4.1): the target of
 * a conversion with `framework: "core"`. The expressions are the ones `generateCoreFrameworkCss` writes for that preset
 * (core-framework-scale.test.ts holds them to it), in rem of Core's root size, 10 px.
 */
export const CORE_DEFAULT_ROOT_PX = 10;

export const CORE_DEFAULT_SCALE: Readonly<Record<string, string>> = {
  "space-4xs": "clamp(0.52rem, calc(-0.03vw + 0.53rem), 0.49rem)",
  "space-3xs": "clamp(0.66rem, calc(0.04vw + 0.64rem), 0.7rem)",
  "space-2xs": "clamp(0.82rem, calc(0.16vw + 0.77rem), 0.99rem)",
  "space-xs": "clamp(1.02rem, calc(0.35vw + 0.91rem), 1.4rem)",
  "space-s": "clamp(1.28rem, calc(0.65vw + 1.07rem), 1.98rem)",
  "space-m": "clamp(1.6rem, calc(1.11vw + 1.24rem), 2.8rem)",
  "space-l": "clamp(2rem, calc(1.81vw + 1.42rem), 3.96rem)",
  "space-xl": "clamp(2.5rem, calc(2.87vw + 1.58rem), 5.6rem)",
  "space-2xl": "clamp(3.13rem, calc(4.44vw + 1.71rem), 7.92rem)",
  "space-3xl": "clamp(3.91rem, calc(6.75vw + 1.75rem), 11.19rem)",
  "space-4xl": "clamp(4.88rem, calc(10.13vw + 1.64rem), 15.83rem)",
  "text-xs": "clamp(1.26rem, calc(-0.23vw + 1.34rem), 1.01rem)",
  "text-s": "clamp(1.42rem, calc(-0.07vw + 1.44rem), 1.35rem)",
  "text-m": "clamp(1.6rem, calc(0.19vw + 1.54rem), 1.8rem)",
  "text-l": "clamp(1.8rem, calc(0.55vw + 1.62rem), 2.4rem)",
  "text-xl": "clamp(2.02rem, calc(1.09vw + 1.68rem), 3.2rem)",
  "text-2xl": "clamp(2.28rem, calc(1.84vw + 1.69rem), 4.26rem)",
  "text-3xl": "clamp(2.56rem, calc(2.89vw + 1.64rem), 5.68rem)",
  "text-4xl": "clamp(2.88rem, calc(4.34vw + 1.49rem), 7.58rem)",
};

const CLAMP = /^clamp\((-?[\d.]+)rem, calc\((-?[\d.]+)vw \+ (-?[\d.]+)rem\), (-?[\d.]+)rem\)$/u;

/** A Core expression read as numbers: min and max in px, and the fluid value as `vw` + px. */
function parts(expression: string): { min: number; vw: number; px: number; max: number } {
  const match = CLAMP.exec(expression);
  if (!match) throw new TypeError(`Espressione Core non riconosciuta: ${expression}`);
  const [min, vw, px, max] = match.slice(1).map(Number) as [number, number, number, number];
  return { min: min * CORE_DEFAULT_ROOT_PX, vw, px: px * CORE_DEFAULT_ROOT_PX, max: max * CORE_DEFAULT_ROOT_PX };
}

/** Its value in px at a viewport width, as the browser resolves clamp(): max(MIN, min(VAL, MAX)). */
export function coreValueAt(expression: string, width: number): number {
  const { min, vw, px, max } = parts(expression);
  return Math.max(min, Math.min((vw * width) / 100 + px, max));
}

/**
 * The same expression in px, so it does not depend on the page's root size: what a converted site defines for the
 * variables it uses, at the lowest specificity, so Core itself wins where it is active (WordPress).
 */
export function corePxExpression(expression: string): string {
  const { min, vw, px, max } = parts(expression);
  const round = (value: number) => Number(value.toFixed(2));
  return `clamp(${round(min)}px, calc(${vw}vw + ${round(px)}px), ${round(max)}px)`;
}

/** The steps of one scale (`space`, `text`) with their px at a viewport width. */
export function coreScale(prefix: "space" | "text", width: number): Array<{ name: string; px: number }> {
  return Object.entries(CORE_DEFAULT_SCALE).filter(([name]) => name.startsWith(`${prefix}-`)).map(([name, expression]) => ({ name: name.slice(prefix.length + 1), px: coreValueAt(expression, width) }));
}
