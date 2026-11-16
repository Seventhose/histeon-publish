/**
 * TypeScript port of Histeon CSS's GPL-3.0-or-later Design, Color, Scale and Tokens classes.
 * Source: https://github.com/Seventhose/xb, commit 9bc212050403dd056ac21edfcff398b514e4a3c1,
 * plugin/src/Framework/HistosCss/{Design,Color,Scale,Tokens}.php.
 * Keep the parity tests in histos-design.test.ts aligned with the PHP unit tests.
 */

export type HistosDesignValue = string | number;
export type HistosDesign = Record<string, HistosDesignValue>;
export type HistosTokens = Record<string, string>;

import { HISTOS_CSS_DESIGN_DATA } from "./histos-design-data.generated.js";
import { utf8Length } from "./isomorphic.js";

export const HISTOS_COLOR_FAMILIES = HISTOS_CSS_DESIGN_DATA.families;
export const HISTOS_DESIGN_DEFAULTS: HistosDesign = HISTOS_CSS_DESIGN_DATA.defaults;
const DESIGN_LIMITS: Record<string, readonly [number, number]> = HISTOS_CSS_DESIGN_DATA.limits;

interface OklchColor { l: number; c: number; h: number }

const SHADES: Record<number, number> = HISTOS_CSS_DESIGN_DATA.shades;
const SHADE_CHROMA: Record<number, number> = HISTOS_CSS_DESIGN_DATA.chroma;
const TEXT_STEPS: Record<string, number> = HISTOS_CSS_DESIGN_DATA.textSteps;
const SPACE_STEPS: Record<string, number> = HISTOS_CSS_DESIGN_DATA.spaceSteps;
const ALPHAS = HISTOS_CSS_DESIGN_DATA.alphas;
const HEADINGS: Record<string, string> = HISTOS_CSS_DESIGN_DATA.headings;
const FLAGS: readonly string[] = HISTOS_CSS_DESIGN_DATA.flags;
const CHOICES: Record<string, readonly string[]> = HISTOS_CSS_DESIGN_DATA.choices;
const ROLES: readonly string[] = HISTOS_CSS_DESIGN_DATA.roles;
const ROLE_DEFAULTS: Record<"light" | "dark", Record<string, string>> = HISTOS_CSS_DESIGN_DATA.roleDefaults;
const AUTO_TEXT: Record<string, string> = HISTOS_CSS_DESIGN_DATA.autoText;
const AUTO_ALSO: Record<string, readonly string[]> = HISTOS_CSS_DESIGN_DATA.autoAlso;
const LIST_ICONS: Record<string, string> = HISTOS_CSS_DESIGN_DATA.listIcons;
const PATTERNS: Record<string, string> = HISTOS_CSS_DESIGN_DATA.patterns;
const BRAND_FAMILIES: readonly string[] = HISTOS_CSS_DESIGN_DATA.brandFamilies;
const FAMILY_NAMES: readonly string[] = HISTOS_CSS_DESIGN_DATA.families;

/** A colour role's value: `auto`, `white`, `black`, a family (`primary`) or one of its shades (`primary-700`). */
export function isHistosRole(value: string): boolean {
  if (["auto", "white", "black"].includes(value) || FAMILY_NAMES.includes(value)) return true;
  const dash = value.lastIndexOf("-");
  return dash > 0 && FAMILY_NAMES.includes(value.slice(0, dash)) && Object.hasOwn(SHADES, value.slice(dash + 1));
}

/** The design parameter of a colour role: role_bg, role_text_muted_dark… */
export function histosRoleKey(role: string, dark = false): string {
  return `role_${role.replaceAll("-", "_")}${dark ? "_dark" : ""}`;
}

function phpNumber(value: number, decimals = 3): string {
  if (value === 0) return "0";
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value), false);
  const bits = view.getBigUint64(0, false);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fractionBits = bits & ((1n << 52n) - 1n);
  const significand = exponentBits === 0 ? fractionBits : (1n << 52n) | fractionBits;
  const exponent = exponentBits === 0 ? -1074 : exponentBits - 1023 - 52;
  const factor = 10n ** BigInt(decimals);
  let numerator = significand * factor;
  let denominator = 1n;
  if (exponent >= 0) numerator <<= BigInt(exponent);
  else denominator <<= BigInt(-exponent);
  let integer = numerator / denominator;
  const remainder = numerator % denominator;
  const twiceRemainder = remainder * 2n;
  if (twiceRemainder > denominator || (twiceRemainder === denominator && integer % 2n !== 0n)) integer++;
  const whole = integer / factor;
  const fractional = decimals ? `.${(integer % factor).toString().padStart(decimals, "0")}` : "";
  const rounded = `${value < 0 ? "-" : ""}${whole}${fractional}`;
  const trimmed = decimals ? rounded.replace(/(?:\.0+|(?:(\.\d*?)0+))$/u, "$1") : rounded;
  return trimmed === "-0" || trimmed === "" ? "0" : trimmed;
}

function cbrt(value: number): number {
  return value < 0 ? -((-value) ** (1 / 3)) : value ** (1 / 3);
}

function oklch(l: number, c: number, h: number): OklchColor {
  const normalizedHue = h % 360;
  return { l: Math.max(0, Math.min(1, l)), c: Math.max(0, Math.min(0.5, c)), h: normalizedHue < 0 ? normalizedHue + 360 : normalizedHue };
}

function fromSrgb(red: number, green: number, blue: number): OklchColor {
  const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  const r = linear(red), g = linear(green), b = linear(blue);
  const l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const okL = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const okA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const okB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const chroma = Math.sqrt(okA * okA + okB * okB);
  const hue = chroma < 1e-6 ? 0 : Math.atan2(okB, okA) * 180 / Math.PI;
  return oklch(okL, chroma, hue);
}

function parseColor(input: string): OklchColor | null {
  const value = input.trim().toLowerCase();
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/u.exec(value);
  if (hex) {
    const expanded = hex[1]!.length === 3 ? [...hex[1]!].map((char) => char + char).join("") : hex[1]!;
    return fromSrgb(Number.parseInt(expanded.slice(0, 2), 16) / 255, Number.parseInt(expanded.slice(2, 4), 16) / 255, Number.parseInt(expanded.slice(4, 6), 16) / 255);
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*[ ,]\s*(\d{1,3})\s*[ ,]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/u.exec(value);
  if (rgb) return fromSrgb(...rgb.slice(1, 4).map((part) => Math.min(255, Number.parseInt(part!, 10)) / 255) as [number, number, number]);
  const match = /^oklch\(\s*([\d.]+)(%)?\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.]+%?\s*)?\)$/u.exec(value);
  if (!match) return null;
  const lightness = Number(match[1]);
  return oklch(match[2] === "%" || lightness > 1 ? lightness / 100 : lightness, Number(match[3]), Number(match[4]));
}

function colorCss(color: OklchColor): string {
  const l = phpNumber(color.l * 100, 1);
  const c = color.c < 0.0005 ? "0" : phpNumber(color.c, 3);
  const h = color.c < 0.0005 ? "0" : phpNumber(color.h, 1);
  return `oklch(${l}% ${c} ${h})`;
}

function toSrgb(color: OklchColor): [number, number, number] {
  const a = color.c * Math.cos(color.h * Math.PI / 180);
  const b = color.c * Math.sin(color.h * Math.PI / 180);
  const l = (color.l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (color.l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (color.l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const gamma = (value: number) => value <= 0.0031308 ? 12.92 * value : 1.055 * (value ** (1 / 2.4)) - 0.055;
  return linear.map((value) => Math.max(0, Math.min(1, gamma(Math.max(0, value))))) as [number, number, number];
}

function luminance(color: OklchColor): number {
  const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  const [r, g, b] = toSrgb(color);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(one: OklchColor, two: OklchColor): number {
  const a = luminance(one), b = luminance(two);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function shade(color: OklchColor, step: number): OklchColor {
  return oklch(SHADES[step] ?? color.l, color.c * (SHADE_CHROMA[step] ?? 1), color.h);
}

function onColor(color: OklchColor): OklchColor {
  const light = oklch(0.99, 0, 0);
  const dark = oklch(0.2, Math.min(0.02, color.c), color.h);
  return contrast(color, light) >= contrast(color, dark) ? light : dark;
}

function scaleNumber(value: number, decimals = 3): string { return phpNumber(value, decimals); }
function rem(px: number): string { return `${scaleNumber(px / HISTOS_CSS_DESIGN_DATA.rootPx, 4)}rem`; }

function fluid(minPx: number, maxPx: number, viewportMin: number, viewportMax: number): string {
  if (Math.abs(maxPx - minPx) < 0.01 || viewportMax <= viewportMin) return rem(minPx);
  const slope = (maxPx - minPx) / (viewportMax - viewportMin);
  const intercept = minPx - slope * viewportMin;
  const vw = slope * 100;
  const preferred = `${rem(intercept)}${vw < 0 ? " - " : " + "}${scaleNumber(Math.abs(vw), 4)}vw`;
  return `clamp(${rem(Math.min(minPx, maxPx))}, ${preferred}, ${rem(Math.max(minPx, maxPx))})`;
}

function scaleStep(step: number, baseMin: number, baseMax: number, ratioMin: number, ratioMax: number): [number, number] {
  return [baseMin * ratioMin ** step, baseMax * ratioMax ** step];
}

function fontStack(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 300) return false;
  return trimmed.split(",").every((family) => /^\s*(?:"[\p{L}\p{N} \-]+"|'[\p{L}\p{N} \-]+'|[\p{L}\p{N}\-]+(?: [\p{L}\p{N}\-]+)*)\s*$/u.test(family));
}

export function validateHistosDesign(raw: unknown): HistosDesign {
  if (raw === null || raw === undefined || (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 0)) return { ...HISTOS_DESIGN_DEFAULTS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Design: serve un oggetto nome → valore.");
  const out: HistosDesign = { ...HISTOS_DESIGN_DEFAULTS };
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(HISTOS_DESIGN_DEFAULTS, key)) throw new TypeError(`Parametro sconosciuto: ${key}`);
    if (HISTOS_COLOR_FAMILIES.includes(key as typeof HISTOS_COLOR_FAMILIES[number])) {
      const color = typeof value === "string" ? parseColor(value) : null;
      if (!color) throw new TypeError(`Colore non valido per ${key}: usa #rrggbb, rgb() o oklch().`);
      out[key] = colorCss(color);
      continue;
    }
    if (key.endsWith("_dark") && FAMILY_NAMES.includes(key.slice(0, -5))) {
      const empty = typeof value === "string" && value.trim() === "";
      const color = typeof value === "string" && !empty ? parseColor(value) : null;
      if (!color && !empty) throw new TypeError(`Colore non valido per ${key}: usa #rrggbb, rgb() o oklch().`);
      out[key] = color ? colorCss(color) : "";
      continue;
    }
    if (FLAGS.includes(key)) {
      if (![true, false, 0, 1, "0", "1"].includes(value as never)) throw new TypeError(`${key}: serve 0 o 1.`);
      out[key] = value === true || value === 1 || value === "1" ? 1 : 0;
      continue;
    }
    if (Object.hasOwn(CHOICES, key)) {
      const choice = typeof value === "string" || (typeof value === "number" && Number.isInteger(value)) ? String(value) : "";
      if (!CHOICES[key]!.includes(choice)) throw new TypeError(`${key}: uno fra ${CHOICES[key]!.join(", ")}.`);
      out[key] = choice;
      continue;
    }
    if (Object.hasOwn(PATTERNS, key)) {
      // The two free texts of the panel: their pattern leaves nothing that could end a CSS string.
      const text = typeof value === "string" ? value.trim() : "";
      if (typeof value !== "string" || !new RegExp(PATTERNS[key]!, "u").test(text)) throw new TypeError(`${key}: valore non valido.`);
      out[key] = text;
      continue;
    }
    if (key.startsWith("role_")) {
      if (typeof value !== "string" || !isHistosRole(value)) throw new TypeError(`${key}: auto, white, black, una famiglia o famiglia-sfumatura (primary-700).`);
      out[key] = value;
      continue;
    }
    if (Object.hasOwn(DESIGN_LIMITS, key)) {
      const number = typeof value === "number" ? value : typeof value === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value) ? Number(value) : Number.NaN;
      const [min, max] = DESIGN_LIMITS[key]!;
      if (!Number.isFinite(number)) throw new TypeError(`${key}: serve un numero.`);
      if (number < min || number > max) throw new TypeError(`${key}: fra ${min} e ${max}.`);
      out[key] = number;
      continue;
    }
    if ((HISTOS_CSS_DESIGN_DATA.optionalFonts as readonly string[]).includes(key) && typeof value === "string" && value.trim() === "") {
      out[key] = "";
      continue;
    }
    if (typeof value !== "string" || !fontStack(value)) throw new TypeError(`${key}: solo nomi di caratteri separati da virgole.`);
    out[key] = value.trim();
  }
  if (Number(out.viewport_max) <= Number(out.viewport_min)) throw new TypeError("La viewport grande deve essere più larga di quella piccola.");
  return out;
}

export function changedHistosDesign(design: HistosDesign): HistosDesign {
  const out: HistosDesign = {};
  for (const [key, value] of Object.entries(design)) {
    const fallback = HISTOS_DESIGN_DEFAULTS[key];
    if (fallback === undefined) continue;
    const same = typeof fallback === "string" ? String(value) === fallback : Math.abs(Number(value) - Number(fallback)) < 1e-9;
    if (!same) out[key] = value;
  }
  return out;
}

/** A step's own size from the panel (px, small and large screen), or null when it follows its scale. */
function ownSize(design: HistosDesign, step: string): [number, number] | null {
  const min = Number(design[`size_${step}_min`]), max = Number(design[`size_${step}_max`]);
  return min > 0 && max > 0 ? [min, max] : null;
}

/** A shadow from the panel: its distance, blur and opacity. */
function shadowOf(design: HistosDesign, name: string): string {
  return `0 ${scaleNumber(Number(design[`${name}_y`]))}px ${scaleNumber(Number(design[`${name}_blur`]))}px oklch(0% 0 0 / ${scaleNumber(Number(design[`${name}_opacity`]))})`;
}

export function computeHistosTokens(input: unknown): HistosTokens {
  const design = validateHistosDesign(input);
  const vwMin = Number(design.viewport_min), vwMax = Number(design.viewport_max);
  const tokens: HistosTokens = {};
  for (const [name, step] of Object.entries(TEXT_STEPS)) {
    const [min, max] = ownSize(design, `text_${name}`) ?? scaleStep(step, Number(design.text_min), Number(design.text_max), Number(design.text_ratio_min), Number(design.text_ratio_max));
    tokens[`xb-text-${name}`] = fluid(min, max, vwMin, vwMax);
  }
  tokens["xb-text-xxl"] = "var(--xb-text-2xl)";
  for (const [heading, step] of Object.entries(HEADINGS)) {
    const own = ownSize(design, heading);
    if (own) tokens[`xb-${heading}`] = fluid(own[0], own[1], vwMin, vwMax);
    else if (Number(design.heading_scale_on) === 1) {
      // Their own scale: h6 is its step 0, h1 its step 5.
      const [min, max] = scaleStep(6 - Number(heading.slice(1)), Number(design.heading_min), Number(design.heading_max), Number(design.heading_ratio_min), Number(design.heading_ratio_max));
      tokens[`xb-${heading}`] = fluid(min, max, vwMin, vwMax);
    } else tokens[`xb-${heading}`] = `var(--xb-text-${step})`;
  }

  for (const [name, step] of Object.entries(SPACE_STEPS)) {
    const [min, max] = scaleStep(step, Number(design.space_min), Number(design.space_max), Number(design.space_ratio_min), Number(design.space_ratio_max));
    tokens[`xb-space-${name}`] = fluid(min, max, vwMin, vwMax);
  }
  tokens["xb-space-xxl"] = "var(--xb-space-2xl)";
  // Sections: the space steps xl … 4xl, times the multiplier of the small and of the large screen (Tokens::compute).
  const multMin = Number(design.section_multiplier_min), multMax = Number(design.section_multiplier_max);
  for (const [size, space] of [["s", "xl"], ["m", "2xl"], ["l", "3xl"], ["xl", "4xl"]] as const) {
    if (Math.abs(multMin - 1) < 1e-9 && Math.abs(multMax - 1) < 1e-9) {
      tokens[`xb-section-${size}`] = `var(--xb-space-${space})`;
      continue;
    }
    const [min, max] = scaleStep(SPACE_STEPS[space]!, Number(design.space_min), Number(design.space_max), Number(design.space_ratio_min), Number(design.space_ratio_max));
    tokens[`xb-section-${size}`] = fluid(min * multMin, max * multMax, vwMin, vwMax);
  }
  tokens["xb-section-pad"] = `var(--xb-section-${design.section_padding})`;
  tokens["xb-gutter"] = Number(design.gutter_min) > 0 && Number(design.gutter_max) > 0 ? fluid(Number(design.gutter_min), Number(design.gutter_max), vwMin, vwMax) : "var(--xb-space-m)";
  for (const gap of ["container", "content", "grid"]) tokens[`xb-${gap}-gap`] = `var(--xb-space-${design[`${gap}_gap`]})`;
  tokens["xb-grid-min"] = `${scaleNumber(Number(design.grid_min))}rem`;
  tokens["xb-grid-fill"] = String(design.grid_fill);
  const gridMax = Number(design.grid_max);
  tokens["xb-grid-auto-min"] = gridMax > 0 ? `max(var(--xb-grid-min), calc((100% - ${gridMax - 1} * var(--xb-grid-gap)) / ${gridMax}))` : "var(--xb-grid-min)";

  const bases = familyBases(design);
  for (const [family, color] of Object.entries(bases)) {
    tokens[`xb-${family}`] = colorCss(color);
    for (const shadeStep of Object.keys(SHADES).map(Number)) tokens[`xb-${family}-${shadeStep}`] = colorCss(shade(color, shadeStep));
    tokens[`xb-on-${family}`] = colorCss(onColor(color));
    for (const alpha of ALPHAS) tokens[`xb-${family}-a${alpha}`] = `color-mix(in oklch, var(--xb-${family}) ${alpha}%, transparent)`;
    tokens[`xb-${family}-hover`] = `var(--xb-${family}-${design.hover_shade})`;
  }
  Object.assign(tokens, {
    "xb-primary-light": "var(--xb-primary-100)", "xb-primary-dark": "var(--xb-primary-800)",
    "xb-secondary-light": "var(--xb-secondary-100)", "xb-secondary-dark": "var(--xb-secondary-800)",
    "xb-white": "oklch(99.5% 0 0)", "xb-black": "oklch(15% 0 0)",
  });
  for (const [role, value] of Object.entries(colorRoles(design, bases, bases, false))) tokens[`xb-${role}`] = value;
  const radius = Number(design.radius);
  // With a ratio, the steps around the medium radius follow it; at 0, the first steps (¼, ½, 2, 3).
  const ratio = Number(design.radius_ratio);
  const radiusSteps: [number, number, number, number] = ratio >= 1 ? [radius / (ratio * ratio), radius / ratio, radius * ratio, radius * ratio * ratio] : [radius / 4, radius / 2, radius * 2, radius * 3];
  Object.assign(tokens, {
    "xb-radius-xs": rem(radiusSteps[0]), "xb-radius-s": rem(radiusSteps[1]), "xb-radius-m": rem(radius), "xb-radius-l": rem(radiusSteps[2]), "xb-radius-xl": rem(radiusSteps[3]),
    "xb-radius-full": "9999px", "xb-shadow-s": shadowOf(design, "shadow_s"), "xb-shadow-m": shadowOf(design, "shadow_m"),
    "xb-shadow-l": shadowOf(design, "shadow_l"), "xb-shadow-xl": shadowOf(design, "shadow_xl"),
    "xb-shadow-2xl": shadowOf(design, "shadow_2xl"),
    "xb-text-shadow-s": shadowOf(design, "tshadow_s"), "xb-drop-shadow-s": `drop-shadow(${shadowOf(design, "tshadow_s")})`,
    "xb-text-shadow-m": shadowOf(design, "tshadow_m"), "xb-drop-shadow-m": `drop-shadow(${shadowOf(design, "tshadow_m")})`,
    "xb-text-shadow-l": shadowOf(design, "tshadow_l"), "xb-drop-shadow-l": `drop-shadow(${shadowOf(design, "tshadow_l")})`,
    "xb-border-width": `${scaleNumber(Number(design.border_width))}px`, "xb-border-style": String(design.border_style), "xb-border-color": `var(--xb-${design.border_color})`, "xb-divider-width": `${scaleNumber(Number(design.divider_width))}px`, "xb-divider-style": String(design.divider_style), "xb-divider-space": `var(--xb-space-${design.divider_space})`, "xb-divider-color": `var(--xb-${design.divider_color})`, "xb-transition": `${scaleNumber(Number(design.transition_ms))}ms ease`,
    // Buttons and links (Tokens::compute): the classes read these tokens.
    "xb-btn-pad-y": `${scaleNumber(Number(design.btn_pad_y))}em`, "xb-btn-pad-x": `${scaleNumber(Number(design.btn_pad_x))}em`,
    "xb-btn-radius": design.btn_radius === "none" ? "0" : `var(--xb-radius-${design.btn_radius})`,
    "xb-btn-weight": scaleNumber(Number(design.btn_weight)), "xb-btn-leading": scaleNumber(Number(design.btn_leading)),
    "xb-btn-size": design.btn_size === "inherit" ? "inherit" : `var(--xb-text-${design.btn_size})`, "xb-btn-case": String(design.btn_case),
    "xb-btn-tracking": `${scaleNumber(Number(design.btn_tracking))}em`,
    "xb-btn-border": Number(design.btn_border) > 0 ? `${scaleNumber(Number(design.btn_border))}px` : "var(--xb-border-width)",
    "xb-btn-min": Number(design.btn_min) > 0 ? `${scaleNumber(Number(design.btn_min))}rem` : "0",
    "xb-link-line": design.link_underline === "always" ? "underline" : "none", "xb-link-line-hover": design.link_underline === "never" ? "none" : "underline",
    "xb-link-thickness": Number(design.link_thickness) > 0 ? `${scaleNumber(Number(design.link_thickness))}px` : "auto",
    "xb-link-offset": `${scaleNumber(Number(design.link_offset))}em`,
    // Forms and details (Tokens::compute).
    "xb-field-pad-y": `${scaleNumber(Number(design.field_pad_y))}em`, "xb-field-pad-x": `${scaleNumber(Number(design.field_pad_x))}em`,
    "xb-field-radius": design.field_radius === "none" ? "0" : `var(--xb-radius-${design.field_radius})`, "xb-field-bg": `var(--xb-${design.field_bg})`,
    "xb-field-border": Number(design.field_border) > 0 ? `${scaleNumber(Number(design.field_border))}px` : "var(--xb-border-width)",
    "xb-field-focus-ring": `${scaleNumber(Number(design.field_focus_ring))}px`, "xb-field-accent": "var(--xb-primary)",
    "xb-field-invalid": `var(--xb-${design.field_invalid})`, "xb-field-valid": `var(--xb-${design.field_valid})`, "xb-label-weight": scaleNumber(Number(design.label_weight)),
    "xb-field-size": design.field_size === "inherit" ? "inherit" : `var(--xb-text-${design.field_size})`, "xb-field-placeholder": `var(--xb-${design.field_placeholder})`,
    "xb-label-size": design.label_size === "inherit" ? "inherit" : `var(--xb-text-${design.label_size})`, "xb-help-size": `var(--xb-text-${design.help_size})`,
    "xb-help-color": `var(--xb-${design.help_color})`, "xb-check-size": `${scaleNumber(Number(design.check_size))}em`, "xb-field-gap": `var(--xb-space-${design.field_gap})`,
    "xb-step-height": `${scaleNumber(Number(design.step_height))}px`, "xb-step-color": `var(--xb-${design.step_color})`, "xb-step-track": `var(--xb-${design.step_track})`,
    "xb-field-focus": `var(--xb-${design.field_focus_color})`, "xb-label-color": `var(--xb-${design.label_color})`, "xb-legend-size": design.legend_size === "inherit" ? "inherit" : `var(--xb-text-${design.legend_size})`,
    "xb-focus-width": `${scaleNumber(Number(design.focus_width))}px`, "xb-focus-offset": `${scaleNumber(Number(design.focus_offset))}px`,
    "xb-focus-style": String(design.focus_style), "xb-selection-bg": `var(--xb-primary-${design.selection_shade})`, "xb-selection-text": `var(--xb-${design.selection_text})`,
    "xb-columns-min": `${scaleNumber(Number(design.columns_min))}rem`, "xb-columns-gap": `var(--xb-space-${design.columns_gap})`,
    "xb-columns-rule": Number(design.columns_rule) === 1 ? "var(--xb-border-width) solid var(--xb-border)" : "none",
    "xb-quote-width": `${scaleNumber(Number(design.quote_width))}px`, "xb-quote-color": `var(--xb-${design.quote_color})`, "xb-quote-pad": `var(--xb-space-${design.quote_pad})`, "xb-quote-style": Number(design.quote_italic) === 1 ? "italic" : "normal",
    // Cards and icons (Tokens::compute).
    "xb-card-pad": `var(--xb-space-${design.card_pad})`, "xb-card-gap": `var(--xb-space-${design.card_gap})`,
    "xb-card-radius": `var(--xb-radius-${design.card_radius})`, "xb-card-bg": `var(--xb-${design.card_bg})`,
    "xb-card-shadow": design.card_shadow === "none" ? "none" : `var(--xb-shadow-${design.card_shadow})`,
    "xb-card-border": Number(design.card_border) === 1 ? "var(--xb-border-width) var(--xb-border-style) var(--xb-border)" : "none",
    "xb-card-ratio": String(design.card_ratio).replace("/", " / "), "xb-card-title": `var(--xb-${design.card_title})`, "xb-radius-inner": "max(0px, calc(var(--xb-card-radius) - var(--xb-card-pad)))",
    "xb-icon-xs": `${scaleNumber(Number(design.icon_xs))}em`, "xb-icon-s": `${scaleNumber(Number(design.icon_s))}em`, "xb-icon-m": `${scaleNumber(Number(design.icon_m))}em`, "xb-icon-l": `${scaleNumber(Number(design.icon_l))}em`, "xb-icon-xl": `${scaleNumber(Number(design.icon_xl))}em`, "xb-icon-2xl": `${scaleNumber(Number(design["icon_2xl"]))}em`,
    "xb-icon-color": design.icon_color === "currentColor" ? "currentColor" : `var(--xb-${design.icon_color})`, "xb-icon-stroke": scaleNumber(Number(design.icon_stroke)),
    "xb-icon-box-bg": `var(--xb-primary-${design.icon_box_shade})`, "xb-icon-box-pad": `var(--xb-space-${design.icon_box_pad})`, "xb-icon-box-radius": design.icon_box_radius === "none" ? "0" : `var(--xb-radius-${design.icon_box_radius})`, "xb-list-icon-color": `var(--xb-${design.list_icon_color})`,
    "xb-list-icon-gap": `var(--xb-space-${design.list_icon_gap})`,
    ...(design.list_icon_symbol === "check" ? {} : { "xb-list-icon-mask": `url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27%3E%3Cpath d=%27${LIST_ICONS[String(design.list_icon_symbol)]}%27/%3E%3C/svg%3E")` }),
    // Overlay (Tokens::compute); the surfaces follow below.
    "xb-overlay": design.overlay_color === "black" ? `oklch(0% 0 0 / ${scaleNumber(Number(design.overlay_opacity))})` : `color-mix(in oklch, var(--xb-${design.overlay_color}) ${scaleNumber(Number(design.overlay_opacity) * 100)}%, transparent)`,
    "xb-overlay-blend": String(design.overlay_blend),
  });
  for (const n of [2, 3]) {
    const color = String(design[`overlay_${n}_color`]), opacity = Number(design[`overlay_${n}_opacity`]);
    tokens[`xb-overlay-${n}`] = color === "black" ? `oklch(0% 0 0 / ${scaleNumber(opacity)})` : `color-mix(in oklch, var(--xb-${color}) ${scaleNumber(opacity * 100)}%, transparent)`;
    tokens[`xb-overlay-${n}-blend`] = String(design[`overlay_${n}_blend`]);
  }
  for (const n of [1, 2, 3]) {
    const ref = String(design[`role_named_${n}`]);
    const bg = ref === "auto" ? null : refColor(ref, bases, bases);
    if (!bg) continue;
    tokens[`xb-surface-${n}-bg`] = `var(--xb-${ref})`;
    // With a second colour the surface is a gradient: its text must read on both ends.
    const to = String(design[`role_named_${n}_to`]);
    const end = to === "auto" ? null : refColor(to, bases, bases);
    const ends = end ? [bg, end] : [bg];
    tokens[`xb-surface-${n}-text`] = Math.min(...ends.map((color) => contrast(WHITE(), color))) >= Math.min(...ends.map((color) => contrast(BLACK(), color))) ? "var(--xb-white)" : "var(--xb-black)";
    tokens[`xb-surface-${n}-border`] = Number(design[`surface_${n}_border`]) === 1 ? "var(--xb-border-width) var(--xb-border-style) var(--xb-border)" : "none";
    tokens[`xb-surface-${n}-shadow`] = design[`surface_${n}_shadow`] === "none" ? "none" : `var(--xb-shadow-${design[`surface_${n}_shadow`]})`;
    if (end) tokens[`xb-surface-${n}-image`] = `linear-gradient(${scaleNumber(Number(design[`surface_${n}_angle`]))}deg, var(--xb-${ref}), var(--xb-${to}))`;
  }
  Object.assign(tokens, {
    // Motion and effects: the xb-enter-*, xb-exit-* and xb-hover-* classes read them.
    "xb-enter-range": `${scaleNumber(Number(design.enter_range))}%`, "xb-enter-distance": `var(--xb-space-${design.enter_distance})`,
    "xb-enter-ease": String(design.enter_ease), "xb-hover-duration": `${scaleNumber(Number(design.hover_duration))}ms`,
    "xb-hover-lift": `${scaleNumber(Number(design.hover_lift))}px`, "xb-hover-scale": scaleNumber(Number(design.hover_scale)),
    "xb-enter-scale": scaleNumber(Number(design.enter_scale)), "xb-enter-scale-out": scaleNumber(2 - Number(design.enter_scale)), "xb-enter-blur": `${scaleNumber(Number(design.enter_blur))}px`,
    "xb-exit-range": `${scaleNumber(Number(design.exit_range))}%`, "xb-hover-bright": scaleNumber(Number(design.hover_bright)), "xb-hover-fade": scaleNumber(Number(design.hover_fade)),
    "xb-width-content": `${scaleNumber(Number(design.width_content))}rem`,
    "xb-width-wide": `${scaleNumber(Number(design.width_wide))}rem`, "xb-width-prose": `${scaleNumber(Number(design.width_prose))}ch`,
    "xb-width-min": rem(Number(design.width_min)), "xb-header-height": fluid(Number(design.header_min), Number(design.header_max), vwMin, vwMax),
    "xb-sticky-top": "var(--xb-header-height)",
    // Text spacing in xb-prose and the boxed layout.
    "xb-flow-text": `${scaleNumber(Number(design.flow_text))}em`, "xb-flow-heading": `${scaleNumber(Number(design.flow_heading))}em`,
    "xb-flow-after": Number(design.flow_after) > 0 ? `${scaleNumber(Number(design.flow_after))}em` : "var(--xb-flow-text)",
    "xb-flow-list": `${scaleNumber(Number(design.flow_list))}em`, "xb-boxed-width": `${scaleNumber(Number(design.boxed_width))}rem`,
    "xb-boxed-bg": `var(--xb-${design.boxed_bg})`, "xb-boxed-shadow": design.boxed_shadow === "none" ? "none" : `var(--xb-shadow-${design.boxed_shadow})`,
    "xb-font-body": String(design.font_body), "xb-font-heading": String(design.font_heading), "xb-font-mono": String(design.font_mono),
  });
  for (const font of HISTOS_CSS_DESIGN_DATA.optionalFonts) if (String(design[font]) !== "") tokens[`xb-${font.replace("_", "-")}`] = String(design[font]);
  const role = String(design.heading_font);
  Object.assign(tokens, {
    "xb-leading-tight": "1.15", "xb-leading-normal": scaleNumber(Number(design.text_leading)), "xb-leading-loose": "1.8", "xb-text-wrap": String(design.text_wrap),
    "xb-heading-font": role === "accent" || role === "display" ? `var(--xb-font-${role}, var(--xb-font-heading))` : `var(--xb-font-${role})`,
    "xb-heading-weight": scaleNumber(Number(design.heading_weight)), "xb-heading-leading": scaleNumber(Number(design.heading_leading)),
    "xb-heading-tracking": `${scaleNumber(Number(design.heading_tracking))}em`, "xb-heading-transform": String(design.heading_case),
    "xb-heading-wrap": String(design.heading_wrap), "xb-heading-measure": Number(design.heading_measure) > 0 ? `${scaleNumber(Number(design.heading_measure))}ch` : "none",
    "xb-heading-style": Number(design.heading_italic) === 1 ? "italic" : "normal",
  });
  for (const heading of Object.keys(HEADINGS)) {
    const weight = Number(design[`${heading}_weight`]), leading = Number(design[`${heading}_leading`]);
    tokens[`xb-${heading}-weight`] = weight > 0 ? scaleNumber(weight) : "var(--xb-heading-weight)";
    tokens[`xb-${heading}-leading`] = leading > 0 ? scaleNumber(leading) : "var(--xb-heading-leading)";
    const color = String(design[`${heading}_color`]), font = String(design[`${heading}_font`]), textCase = String(design[`${heading}_case`]);
    tokens[`xb-${heading}-color`] = color === "auto" ? "var(--xb-heading)" : `var(--xb-${color})`;
    tokens[`xb-${heading}-font`] = font === "auto" ? "var(--xb-heading-font)" : font === "accent" || font === "display" ? `var(--xb-font-${font}, var(--xb-font-heading))` : `var(--xb-font-${font})`;
    tokens[`xb-${heading}-transform`] = textCase === "auto" ? "var(--xb-heading-transform)" : textCase;
    // Printed only when set: the rules fall back to all the headings'.
    if (design[`${heading}_wrap`] !== "auto") tokens[`xb-${heading}-wrap`] = String(design[`${heading}_wrap`]);
    if (Number(design[`${heading}_tracking`]) !== 0) tokens[`xb-${heading}-tracking`] = `${scaleNumber(Number(design[`${heading}_tracking`]))}em`;
    if (Number(design[`${heading}_measure`]) !== 0) tokens[`xb-${heading}-measure`] = `${scaleNumber(Number(design[`${heading}_measure`]))}ch`;
  }
  return tokens;
}

/** The base colour of every family switched on: its own, or the one lightness of the brand or of the states. */
function familyBases(design: HistosDesign): Record<string, OklchColor> {
  const out: Record<string, OklchColor> = {};
  for (const family of HISTOS_COLOR_FAMILIES) {
    if (Number(design[`${family}_on`] ?? 1) === 0) continue;
    let color = parseColor(String(design[family])) ?? parseColor(String(HISTOS_DESIGN_DEFAULTS[family]!));
    if (!color) continue;
    const group = BRAND_FAMILIES.includes(family) ? "brand" : "state";
    if (Number(design[`${group}_lightness_on`]) === 1) color = oklch(Number(design[`${group}_lightness`]), color.c, color.h);
    out[family] = color;
  }
  return out;
}

const WHITE = (): OklchColor => oklch(0.995, 0, 0);
const BLACK = (): OklchColor => oklch(0.15, 0, 0);

function refColor(ref: string, shades: Record<string, OklchColor>, bases: Record<string, OklchColor>): OklchColor | null {
  if (ref === "white") return WHITE();
  if (ref === "black") return BLACK();
  if (bases[ref]) return bases[ref]!;
  const match = /^([a-z]+)-(\d+)$/u.exec(ref);
  return match && shades[match[1]!] ? shade(shades[match[1]!]!, Number(match[2])) : null;
}

/** The shade nearest to a text role that reads on the page's background and on the surfaces (Tokens::readable in PHP). */
function readableRef(ref: string, bgRefs: string[], shades: Record<string, OklchColor>, bases: Record<string, OklchColor>): string {
  const text = refColor(ref, shades, bases), bg = refColor(bgRefs[0]!, shades, bases);
  if (!text || !bg) return ref;
  const backgrounds = bgRefs.flatMap((bgRef) => refColor(bgRef, shades, bases) ?? []);
  const whiteOrBlack = contrast(WHITE(), bg) >= contrast(BLACK(), bg) ? "white" : "black";
  const match = /^([a-z]+)-(\d+)$/u.exec(ref);
  const steps = Object.keys(SHADES).map(Number);
  for (const targets of [backgrounds, [bg]]) {
    const reads = (color: OklchColor) => targets.every((target) => contrast(color, target) >= 4.5);
    if (reads(text)) return ref;
    if (!match) continue;
    const at = Math.max(0, steps.indexOf(Number(match[2])));
    const darker = luminance(bg) > 0.18;
    for (let far = 1; far < steps.length; far++) {
      for (const index of darker ? [at + far, at - far] : [at - far, at + far]) {
        const step = steps[index];
        if (step !== undefined && reads(shade(shades[match[1]!]!, step))) return `${match[1]}-${step}`;
      }
    }
  }
  return match || ref === "white" || ref === "black" ? whiteOrBlack : ref;
}

function colorRoles(design: HistosDesign, shades: Record<string, OklchColor>, bases: Record<string, OklchColor>, dark: boolean): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const role of ROLES) {
    const ref = String(design[histosRoleKey(role, dark)]);
    refs[role] = ref === "auto" || !refColor(ref, shades, bases) ? ROLE_DEFAULTS[dark ? "dark" : "light"][role]! : ref;
  }
  if (Number(design.auto_contrast) === 1) {
    for (const [role, bg] of Object.entries(AUTO_TEXT)) {
      if (String(design[histosRoleKey(role, dark)]) === "auto") refs[role] = readableRef(refs[role]!, [refs[bg]!, ...(AUTO_ALSO[role] ?? []).map((surface) => refs[surface]!)], shades, bases);
    }
  }
  return Object.fromEntries(Object.entries(refs).map(([role, ref]) => [role, `var(--xb-${ref})`]));
}

/** The tokens the dark theme changes (Tokens::dark in PHP). */
export function histosDarkTokens(input: unknown): HistosTokens {
  const design = validateHistosDesign(input);
  const light = familyBases(design);
  const bases: Record<string, OklchColor> = {};
  const out: HistosTokens = {};
  for (const [family, color] of Object.entries(light)) {
    const own = String(design[`${family}_dark`]) === "" ? null : parseColor(String(design[`${family}_dark`]));
    const base = own ?? shade(color, 400);
    bases[family] = base;
    out[`xb-${family}`] = colorCss(base);
    out[`xb-on-${family}`] = colorCss(onColor(base));
    for (const alpha of ALPHAS) out[`xb-${family}-a${alpha}`] = `color-mix(in oklch, var(--xb-${family}) ${alpha}%, transparent)`;
    out[`xb-${family}-hover`] = `var(--xb-${family}-${design.dark_hover_shade})`;
  }
  for (const [role, value] of Object.entries(colorRoles(design, light, bases, true))) out[`xb-${role}`] = value;
  return out;
}

const READABLE_PAIRS: Array<[string, string]> = [
  ["xb-text", "xb-bg"], ["xb-heading", "xb-bg"], ["xb-text-muted", "xb-bg"], ["xb-text", "xb-surface"], ["xb-text", "xb-surface-2"], ["xb-heading", "xb-surface"], ["xb-text-muted", "xb-surface"], ["xb-text-muted", "xb-surface-2"], ["xb-link", "xb-bg"], ["xb-link", "xb-surface"],
];

export interface HistosContrastPair { text: string; bg: string; ratio: number; ok: boolean; scheme?: "dark" }

export function histosContrast(input: unknown): HistosContrastPair[] {
  const design = validateHistosDesign(input);
  const tokens = computeHistosTokens(design);
  const resolver = (map: HistosTokens) => (name: string): OklchColor | null => {
    let value = map[name] ?? "";
    for (let hops = 0; hops < 5; hops++) {
      const variable = /^var\(--([a-z0-9-]+)\)$/u.exec(value);
      if (!variable) return parseColor(value);
      value = map[variable[1]!] ?? "";
    }
    return null;
  };
  const pairs = [...READABLE_PAIRS, ...Object.keys(familyBases(design)).map((family): [string, string] => [`xb-on-${family}`, `xb-${family}`])];
  const measure = (resolve: (name: string) => OklchColor | null) => pairs.flatMap(([text, bg]) => {
    const foreground = resolve(text), background = resolve(bg);
    if (!foreground || !background) return [];
    const ratio = Math.round(contrast(foreground, background) * 100) / 100;
    return [{ text, bg, ratio, ok: ratio >= 4.5 }];
  });
  const out: HistosContrastPair[] = measure(resolver(tokens));
  if (Number(design.dark_on) === 1) out.push(...measure(resolver({ ...tokens, ...histosDarkTokens(design) })).map((pair) => ({ ...pair, scheme: "dark" as const })));
  return out;
}

/** The tokens a site prints: without the groups switched off in the panel (Tokens::printed in PHP). */
export function printedHistosTokens(tokens: HistosTokens, input: unknown): HistosTokens {
  const off = offPatterns(validateHistosDesign(input));
  return off.length ? Object.fromEntries(Object.entries(tokens).filter(([name]) => !off.some((pattern) => pattern.test(name)))) : tokens;
}

/**
 * The tokens a site prints, for the panel's «Esporta i token (DTCG)»: the light theme and, with the dark theme on, the
 * same tokens with its colours in place; null when it is off (Tokens::export in PHP). Names keep their `xb-` prefix.
 */
export function histosExportTokens(input: unknown): { light: HistosTokens; dark: HistosTokens | null } {
  const design = validateHistosDesign(input);
  const light = printedHistosTokens(computeHistosTokens(design), design);
  const dark = Number(design.dark_on) === 1 ? { ...light, ...printedHistosTokens(histosDarkTokens(design), design) } : null;
  return { light, dark };
}

function offPatterns(design: HistosDesign): RegExp[] {
  return Object.entries(HISTOS_CSS_DESIGN_DATA.printGroups).filter(([group]) => Number(design[`print_${group}`]) === 0).map(([, pattern]) => new RegExp(pattern, "u"));
}

/** What the panel switches off: the groups of classes, the buttons of a family, a variant of every family (Utilities::off_patterns). */
export function histosClassOffPatterns(input: unknown): string[] {
  const design = validateHistosDesign(input);
  const off: string[] = Object.entries(HISTOS_CSS_DESIGN_DATA.classGroups).filter(([group]) => Number(design[`classes_${group}`]) === 0).map(([, pattern]) => pattern);
  for (const family of FAMILY_NAMES) if (Number(design[`btn_${family}_on`]) === 0) off.push(`^xb-btn-${family}(?:-outline|-light|-dark)?$`);
  for (const variant of ["outline", "light", "dark"]) if (Number(design[`btn_${variant}_on`]) === 0) off.push(`^xb-btn-(?:${FAMILY_NAMES.join("|")})-${variant}$`);
  return off;
}

/**
 * Histeon CSS's sheet without the groups of classes switched off in the panel (Utilities::filtered in PHP): a rule
 * goes when every class it names belongs to a group switched off; @keyframes by their name. Line by line on the
 * generated sheet, so both give the same bytes.
 */
export function filterHistosClasses(css: string, input: unknown): string {
  const design = validateHistosDesign(input);
  const off = histosClassOffPatterns(design).map((pattern) => new RegExp(pattern, "u"));
  if (!off.length) return css;
  const gone = (selector: string): boolean => {
    const keyframes = /^@keyframes\s+([a-z0-9-]+)/u.exec(selector);
    const names = keyframes ? [keyframes[1]!] : [...selector.matchAll(/\.(xb-[a-z0-9-]+)/gu)].map((match) => match[1]!);
    return names.length > 0 && names.every((name) => off.some((pattern) => pattern.test(name)));
  };
  const selectorOf = (line: string) => { const at = line.indexOf(" { "); return at < 0 ? null : line.slice(0, at); };
  const lines = css.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("@") && line.endsWith("{")) {
      const block: string[] = [];
      for (i++; i < lines.length && lines[i] !== "}"; i++) block.push(lines[i]!);
      if (line.startsWith("@keyframes")) {
        if (!gone(line)) out.push(line, ...block, "}");
        continue;
      }
      const kept = block.filter((inner) => !gone(selectorOf(inner) ?? ""));
      if (kept.length) out.push(line, ...kept, "}");
      continue;
    }
    const selector = selectorOf(line);
    if (selector === null || !gone(selector)) out.push(line);
  }
  return out.join("\n");
}

export function histosGroupsOff(input: unknown): boolean {
  return offPatterns(validateHistosDesign(input)).length > 0;
}

/** The whole `:root{…}` of a site with groups switched off, in place of the shipped xb-tokens.css (Tokens::sheet). */
export function histosTokenSheet(input: unknown): string {
  const design = validateHistosDesign(input);
  return `:root{${Object.entries(printedHistosTokens(computeHistosTokens(design), design)).map(([name, value]) => `--${name}:${value};`).join("")}}`;
}

/** The panel's live preview (Tokens::preview_css in PHP): the groups switched off, as `initial` over the sheet the page has. */
export function histosPreviewCss(input: unknown): string {
  const design = validateHistosDesign(input);
  const all = computeHistosTokens(design);
  const printed = printedHistosTokens(all, design);
  const off = Object.keys(all).filter((name) => !Object.hasOwn(printed, name)).map((name) => `--${name}:initial;`).join("");
  return histosDesignCss(design) + (off ? `:root{${off}}` : "");
}

export function histosDesignCss(input: unknown): string {
  const design = validateHistosDesign(input);
  const defaults = computeHistosTokens(HISTOS_DESIGN_DEFAULTS);
  const tokens = printedHistosTokens(computeHistosTokens(design), design);
  const changed: string[] = [];
  for (const [name, value] of Object.entries(tokens)) if (defaults[name] !== value) changed.push(`--${name}:${value};`);
  let css = changed.length ? `:root{${changed.join("")}}` : "";
  if (Number(design.dark_on) !== 1) return css + elementRules(design);
  // The dark theme (Tokens::css_changes in PHP): the sections marked dark always, the whole site with «dark» or «system».
  const darkTokens = printedHistosTokens(histosDarkTokens(design), design);
  const declarations = (map: HistosTokens) => Object.entries(map).map(([name, value]) => `--${name}:${value};`).join("");
  const dark = declarations(darkTokens);
  const all = computeHistosTokens(design);
  const light = declarations(Object.fromEntries(Object.keys(darkTokens).map((name) => [name, all[name]!])));
  css += `:root .xb-scheme-dark,:root.xb-scheme-dark{${dark}color-scheme:dark}:root .xb-scheme-light,:root.xb-scheme-light{${light}color-scheme:light}`;
  const site = `:root:not(.xb-scheme-light){${dark}background-color:var(--xb-bg);color:var(--xb-text);color-scheme:dark}`;
  if (design.scheme === "dark") css += site;
  else if (design.scheme === "system") css += `:root{color-scheme:light dark}@media (prefers-color-scheme:dark){${site}}`;
  return css + elementRules(design);
}

/** Rules on bare elements the panel switches on, in `:where()` (Tokens::element_rules in PHP). */
function elementRules(design: HistosDesign): string {
  let css = Math.abs(Number(design.root_size) - 100) > 1e-9 ? `html{font-size:${scaleNumber(Number(design.root_size))}%}` : "";
  if (Number(design.boxed_on) === 1) css += "html{background-color:var(--xb-boxed-bg)}body{box-sizing:border-box;max-inline-size:var(--xb-boxed-width);min-block-size:100vh;margin-inline:auto;background-color:var(--xb-bg);box-shadow:var(--xb-boxed-shadow)}";
  if (Number(design.scroll_offset_on) === 1) css += "html{scroll-padding-top:var(--xb-header-height)}";
  if (Number(design.focus_on) === 1) css += ":where(:focus-visible){outline:var(--xb-focus-width) var(--xb-focus-style) var(--xb-focus);outline-offset:var(--xb-focus-offset)}";
  if (Number(design.smooth_scroll) === 1) css += "@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}";
  if (Number(design.reduce_motion) === 1) css += "@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:0.01ms !important;animation-iteration-count:1 !important;transition-duration:0.01ms !important}html,body{scroll-behavior:auto !important}}";
  if (Number(design.selection_on) === 1) css += "::selection{background-color:var(--xb-selection-bg);color:var(--xb-selection-text)}";
  if (Number(design.quotes_on) === 1) css += ":where(blockquote){margin-inline:0;padding-inline-start:var(--xb-quote-pad);border-inline-start:var(--xb-quote-width) solid var(--xb-quote-color);color:var(--xb-text-muted);font-style:var(--xb-quote-style)}:where(blockquote cite){display:block;margin-block-start:var(--xb-space-xs);font-size:var(--xb-text-s);font-style:normal}";
  if (Number(design.forms_on) === 1) {
    // Bare fields in `:where()`; Fluent Forms' markup needs `html` in front to beat its sheet (Tokens::element_rules).
    const field = ":where(input:not([type=checkbox],[type=radio],[type=submit],[type=button],[type=reset],[type=range],[type=color],[type=file],[type=hidden]),select,textarea),html .fluentform .ff-el-form-control";
    css += `${field}{box-sizing:border-box;padding:var(--xb-field-pad-y) var(--xb-field-pad-x);border:var(--xb-field-border) solid var(--xb-border);border-radius:var(--xb-field-radius);background-color:var(--xb-field-bg);color:var(--xb-text);font:inherit}`;
    css += ":where(input,select,textarea):focus,html .fluentform .ff-el-form-control:focus{outline:none;border-color:var(--xb-field-focus);box-shadow:0 0 0 var(--xb-field-focus-ring) var(--xb-primary-a30)}";
    css += ":where(input[type=checkbox],input[type=radio]){accent-color:var(--xb-field-accent)}";
    css += ":where(label),html .fluentform .ff-el-input--label label{font-weight:var(--xb-label-weight);color:var(--xb-label-color)}";
    css += ':where([aria-invalid="true"]),html .fluentform .ff-el-is-error .ff-el-form-control{border-color:var(--xb-field-invalid)}html .fluentform .error,html .fluentform .text-danger{color:var(--xb-field-invalid)}';
    css += ":where(input,textarea)::placeholder,html .fluentform .ff-el-form-control::placeholder{color:var(--xb-field-placeholder);opacity:1}:where(input:not([type=checkbox],[type=radio]),select,textarea),html .fluentform .ff-el-form-control{font-size:var(--xb-field-size)}:where(label),html .fluentform .ff-el-input--label label{font-size:var(--xb-label-size)}:where(.xb-help),html .fluentform .ff-el-help-message{font-size:var(--xb-help-size);color:var(--xb-help-color)}html .fluentform .ff-el-is-valid .ff-el-form-control{border-color:var(--xb-field-valid)}:where(input[type=checkbox],input[type=radio]){inline-size:var(--xb-check-size);block-size:var(--xb-check-size)}:where(select),html .fluentform select.ff-el-form-control{appearance:none;padding-inline-end:2.4em;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 1.25em) 55%,calc(100% - 0.9em) 55%;background-size:0.35em 0.35em;background-repeat:no-repeat}:where(fieldset){margin:0;padding:var(--xb-space-m);border:var(--xb-field-border) solid var(--xb-border);border-radius:var(--xb-field-radius)}:where(legend){padding-inline:var(--xb-space-2xs);font-size:var(--xb-legend-size);font-weight:var(--xb-label-weight)}html .fluentform .ff-el-group{margin-block-end:var(--xb-field-gap)}";
    if (design.check_style === "switch") css += ":where(input[type=checkbox]){appearance:none;position:relative;inline-size:calc(var(--xb-check-size) * 1.8);block-size:var(--xb-check-size);border-radius:999px;background-color:var(--xb-neutral-300);cursor:pointer;transition:background-color var(--xb-transition)}:where(input[type=checkbox])::before{content:\"\";position:absolute;inset-block:2px;inset-inline-start:2px;aspect-ratio:1;border-radius:50%;background-color:var(--xb-white);transition:translate var(--xb-transition)}:where(input[type=checkbox]:checked){background-color:var(--xb-field-accent)}:where(input[type=checkbox]:checked)::before{translate:calc(var(--xb-check-size) * 0.8) 0}";
    const submit = String(design.form_submit);
    css += `html .fluentform .ff-btn-submit{padding:var(--xb-btn-pad-y) var(--xb-btn-pad-x);border:0;border-radius:var(--xb-btn-radius);background-color:var(--xb-${submit});color:var(--xb-on-${submit});font-weight:var(--xb-btn-weight)}html .fluentform .ff-btn-submit:hover{background-color:var(--xb-${submit}-hover)}`;
    // The step bar of multi-page forms (Tokens::element_rules).
    css += "html .fluentform .ff-el-progress{block-size:var(--xb-step-height, 0.5rem);border-radius:var(--xb-radius-full);background-color:var(--xb-step-track, var(--xb-neutral-200))}html .fluentform .ff-el-progress-bar{background-color:var(--xb-step-color, var(--xb-primary))}html .fluentform .ff-el-progress-bar span{display:none}";
  }
  if (Number(design.btn_full_mobile) === 1) css += `@media (max-width:${scaleNumber(Number(design.btn_full_below))}px){:where(.xb-btn,[class^="xb-btn-"],[class*=" xb-btn-"]){inline-size:100%}}`;
  if (Number(design.links_on) === 1) css += ":where(a:not([class])){color:var(--xb-link);text-decoration-line:var(--xb-link-line);text-decoration-thickness:var(--xb-link-thickness);text-underline-offset:var(--xb-link-offset);transition:color var(--xb-transition)}:where(a:not([class])):hover{color:var(--xb-link-hover);text-decoration-line:var(--xb-link-line-hover)}";
  if (Number(design.external_on) === 1 && design.external_host !== "") {
    // The site's domain and the words for a screen reader come from the panel, validated (Tokens::element_rules).
    const host = String(design.external_host), before = design.external_place === "before", symbol = design.external_symbol === "arrow" ? "↗" : "";
    css += `:where(:is(a:not([class]),.xb-link,.xb-prose a)[href^="http"]:not([href^="https://${host}"],[href^="http://${host}"],[href^="https://www.${host}"],[href^="http://www.${host}"]))::${before ? "before" : "after"}{content:"${symbol}";content:"${symbol}" / "${design.external_label}";margin-inline-${before ? "end" : "start"}:0.2em}`;
  }
  // The hover of the light and dark buttons, when it is not the sheet's (Tokens::element_rules).
  for (const [variant, sheet] of [["light", "200"], ["dark", "900"]] as const) {
    const hover = String(design[`btn_${variant}_hover`]);
    if (hover !== sheet) for (const family of FAMILY_NAMES) css += `html .xb-btn-${family}-${variant}:hover{background-color:var(--xb-${family}-${hover})}`;
  }
  // A site surface under a name of its own (a checked class name).
  for (const n of [1, 2, 3]) {
    const name = String(design[`surface_${n}_name`]);
    if (name !== "") css += `:where(.xb-surface-${name}){background-color:var(--xb-surface-${n}-bg, var(--xb-surface));background-image:var(--xb-surface-${n}-image, none);color:var(--xb-surface-${n}-text, var(--xb-text));border:var(--xb-surface-${n}-border, none);box-shadow:var(--xb-surface-${n}-shadow, none)}`;
  }
  if (design.flow_scope === "content") css += ":where(main,[role=main]) :where(p,ul,ol,dl,blockquote,pre,table,figure,h1,h2,h3,h4,h5,h6){margin-block:0}:where(main,[role=main]) :where(p,ul,ol,dl,blockquote,pre,table,figure):where(:not(:first-child)){margin-block-start:var(--xb-flow-text)}:where(main,[role=main]) :where(h1,h2,h3,h4,h5,h6):where(:not(:first-child)){margin-block-start:var(--xb-flow-heading)}:where(main,[role=main]) :where(h1,h2,h3,h4,h5,h6) + :where(*){margin-block-start:var(--xb-flow-after)}:where(main,[role=main]) :where(li + li,li > ul,li > ol){margin-block-start:var(--xb-flow-list)}";
  if (Number(design.section_grid_on) === 1) css += ":where(section,.xb-section){display:grid;row-gap:var(--xb-container-gap);grid-template-columns:[full-start] minmax(var(--xb-gutter), 1fr) [wide-start] minmax(0, calc((var(--xb-width-wide) - var(--xb-width-content)) / 2)) [content-start] min(100% - 2 * var(--xb-gutter), var(--xb-width-content)) [content-end] minmax(0, calc((var(--xb-width-wide) - var(--xb-width-content)) / 2)) [wide-end] minmax(var(--xb-gutter), 1fr) [full-end]}:where(section,.xb-section) > :where(*){grid-column:content;min-inline-size:0}:where(section,.xb-section) > :where(.xb-wide){grid-column:wide}:where(section,.xb-section) > :where(.xb-full){grid-column:full}:where(section,.xb-section) > :where(.xb-narrow){inline-size:100%;max-inline-size:var(--xb-width-prose);justify-self:center}";
  if (Number(design.headings_on) === 1) {
    css += ":where(h1,h2,h3,h4,h5,h6){font-family:var(--xb-heading-font);letter-spacing:var(--xb-heading-tracking);text-transform:var(--xb-heading-transform);text-wrap:var(--xb-heading-wrap);max-inline-size:var(--xb-heading-measure);font-style:var(--xb-heading-style);color:var(--xb-heading)}";
    for (const heading of Object.keys(HEADINGS)) css += `:where(${heading}){text-wrap:var(--xb-${heading}-wrap, var(--xb-heading-wrap));letter-spacing:var(--xb-${heading}-tracking, var(--xb-heading-tracking));max-inline-size:var(--xb-${heading}-measure, var(--xb-heading-measure));font-family:var(--xb-${heading}-font);font-size:var(--xb-${heading});font-weight:var(--xb-${heading}-weight);line-height:var(--xb-${heading}-leading);text-transform:var(--xb-${heading}-transform);color:var(--xb-${heading}-color)}`;
  }
  if (Number(design.text_on) === 1) css += ":where(body){font-family:var(--xb-font-body);line-height:var(--xb-leading-normal);color:var(--xb-text)}:where(p,li,dd,blockquote,figcaption){text-wrap:var(--xb-text-wrap)}";
  // A text step's own style, on its class: only what the panel sets.
  for (const step of Object.keys(TEXT_STEPS)) {
    let own = "";
    for (const [key, property, unit] of [["leading", "line-height:", ""], ["tracking", "letter-spacing:", "em"], ["measure", "max-inline-size:", "ch"]] as const) {
      const value = Number(design[`text_${step}_${key}`]);
      if (value !== 0) own += `${property}${scaleNumber(value)}${unit};`;
    }
    for (const [key, property] of [["case", "text-transform:"], ["wrap", "text-wrap:"]] as const) {
      const value = String(design[`text_${step}_${key}`]);
      if (value !== "auto") own += `${property}${value};`;
    }
    if (own) css += `:where(.xb-text-${step}){${own}}`;
  }
  return css;
}

/** The site's own variables are printed as `--xb-site-<name>` (builder docs/spec/design-system.md). */
export const SITE_TOKEN_PREFIX = "xb-site-";
const SITE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const SITE_MAX = 200;

function siteNameProblem(name: string): string | null {
  return SITE_NAME.test(name) && !name.endsWith("-") && !name.includes("--") ? null : "Nome: da 1 a 40 caratteri fra lettere minuscole, cifre e trattini singoli.";
}

/** The site's variables, names without the prefix: the same rules as the builder's SiteTokens. */
export function validateSiteTokens(raw: unknown): Record<string, string> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > SITE_MAX) throw new TypeError(`Variabili del sito: serve un oggetto nome → valore, al massimo ${SITE_MAX}.`);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const problem = siteNameProblem(name);
    if (problem) throw new TypeError(`--${SITE_TOKEN_PREFIX}${name}: ${problem}`);
    // The value rules are the token overrides' (plain CSS values only).
    out[name] = validateHistosTokenOverrides({ [`${SITE_TOKEN_PREFIX}${name}`]: value }, new Set([`${SITE_TOKEN_PREFIX}${name}`]))[`${SITE_TOKEN_PREFIX}${name}`]!;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** The site's own recipes: the same rules as the builder's SiteRecipes (no markup, nothing that loads or runs). */
export function validateSiteRecipes(raw: unknown): Record<string, string> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > SITE_MAX) throw new TypeError(`Ricette del sito: serve un oggetto nome → CSS, al massimo ${SITE_MAX}.`);
  const out: Record<string, string> = {};
  for (const [name, css] of Object.entries(raw)) {
    const fail = (message: string): never => { throw new TypeError(`@${name}: ${message}`); };
    const problem = siteNameProblem(name);
    if (problem) fail(problem);
    if (typeof css !== "string" || !css.trim()) fail("La ricetta è vuota.");
    const text = css as string;
    if (utf8Length(text) > 4096) fail("La ricetta supera 4 KB.");
    if (text.includes("<") || /url\s*\(|@import|expression\s*\(|javascript:|behavior\s*:|-moz-binding/iu.test(text)) fail("Non sono ammessi markup, url(), @import, expression(), behavior e -moz-binding.");
    let depth = 0;
    for (const character of text) {
      depth += character === "{" ? 1 : character === "}" ? -1 : 0;
      if (depth < 0) break;
    }
    if (depth !== 0) fail("Graffe non bilanciate.");
    out[name] = text.trim();
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** `--xb-site-x:…;` for each variable (validated: nothing here can close the rule). */
export function siteTokenDeclarations(raw: unknown): string {
  return Object.entries(validateSiteTokens(raw)).map(([name, value]) => `--${SITE_TOKEN_PREFIX}${name}:${value};`).join("");
}

/** The id of the global sheet the site's variables travel as in a transfer (page-transfer.ts). */
export const SITE_TOKENS_SHEET_ID = "histos-site-tokens";

/**
 * A styles payload as a transfer brings it: its `histos-site-tokens` sheet goes back to `siteTokens`, where the Design
 * panel lists the site's variables, when it is to the letter what the export writes (`:root{--xb-site-a:1px;…}`, valid
 * names and values, after the other sheets and before the fonts'). So the next export writes the same payload. Anything
 * else stays the sheet it is: the content is not trusted, and nothing is lost.
 */
export function receiveSiteTokens(payload: Record<string, unknown>, fontSheetId: string): Record<string, unknown> {
  if (!Array.isArray(payload.globals) || payload.siteTokens !== undefined) return payload;
  const globals = payload.globals as Array<Record<string, unknown> | null>;
  const index = globals.findIndex((sheet) => sheet?.id === SITE_TOKENS_SHEET_ID);
  const sheet = index < 0 ? null : globals[index];
  if (!sheet || typeof sheet.css !== "string" || Object.keys(sheet).some((key) => key !== "id" && key !== "css")) return payload;
  if (globals.slice(index + 1).some((later) => later?.id !== fontSheetId)) return payload;
  const body = /^:root\{(.*)\}$/su.exec(sheet.css)?.[1];
  if (body === undefined) return payload;
  const tokens: Record<string, string> = {};
  for (const declaration of body.split(";")) {
    if (!declaration) continue;
    const parts = /^--xb-site-([a-z0-9-]+):(.+)$/su.exec(declaration);
    if (!parts || Object.hasOwn(tokens, parts[1]!)) return payload;
    tokens[parts[1]!] = parts[2]!;
  }
  try {
    const valid = validateSiteTokens(tokens);
    if (!Object.keys(valid).length || `:root{${siteTokenDeclarations(valid)}}` !== sheet.css) return payload;
    return { ...payload, globals: globals.filter((_, at) => at !== index), siteTokens: valid };
  } catch {
    return payload;
  }
}

export function validateHistosTokenOverrides(raw: unknown, tokenNames: ReadonlySet<string>): Record<string, string> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Token: serve un oggetto nome → valore.");
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(raw)) {
    const name = rawName.replace(/^-+/, "");
    if (!tokenNames.has(name)) throw new TypeError(`Token sconosciuto: --${name}`);
    if (typeof rawValue !== "string") throw new TypeError(`Token --${name}: serve un testo.`);
    const value = rawValue.trim();
    if (!value) throw new TypeError(`--${name}: Il valore è vuoto.`);
    if (utf8Length(value) > 200) throw new TypeError(`--${name}: Il valore è troppo lungo.`);
    if (/[;{}<>"'\\@!]|\/\*|url\s*\(|expression\s*\(|javascript:/iu.test(value) || !/^[\w\s.,%()+\-*/#]+$/u.test(value)) throw new TypeError(`--${name}: Solo valori CSS semplici: numeri, unità, colori, calc(), clamp(), var().`);
    let depth = 0;
    for (const character of value) {
      depth += character === "(" ? 1 : character === ")" ? -1 : 0;
      if (depth < 0) break;
    }
    if (depth !== 0) throw new TypeError(`--${name}: Parentesi non bilanciate.`);
    out[name] = value;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
