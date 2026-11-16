import { HISTOS_RECIPES, HISTOS_TOKENS_CSS, HISTOS_UTILITIES_CSS } from "./histos-css-assets.generated.js";
import { SITE_TOKEN_PREFIX, computeHistosTokens, filterHistosClasses, histosDesignCss, histosGroupsOff, histosTokenSheet, printedHistosTokens, siteTokenDeclarations, validateHistosTokenOverrides, validateSiteRecipes, validateSiteTokens } from "./histos-design.js";
import { validateCoreFrameworkPresetData, type CoreFrameworkPresetData } from "@histos-publish/histos-contract/core-preset";
import { validateExternalFrameworkConfiguration, type ExternalFrameworkConfiguration } from "@histos-publish/histos-contract/framework-config";
import type { CssAssetReference } from "./css-resources.js";

export interface CmsStylesData {
  styles?: Array<{ id?: string; selector: string; css: string; assets?: CssAssetReference[] }>;
  globals?: Array<{ id?: string; css: string; source?: ExternalFrameworkSource; assets?: CssAssetReference[] }>;
  queries?: Record<string, string>;
  design?: unknown;
  tokenOverrides?: unknown;
  /** The site's own variables (`--xb-site-<name>`) and recipes, from the Design system. */
  siteTokens?: unknown;
  siteRecipes?: unknown;
  compiledCss?: string;
}

export type ExternalFrameworkId = "core-framework" | "automatic-css" | "custom";
export interface ExternalFrameworkSource {
  kind: "user-css";
  frameworkId: ExternalFrameworkId;
  name: string;
  version?: string;
  license?: string;
  sourceUrl?: string;
  preset?: CoreFrameworkPresetData;
  configuration?: ExternalFrameworkConfiguration;
  rightsConfirmed: true;
}

export function validateExternalFrameworkSource(value: unknown): ExternalFrameworkSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("La provenienza del CSS esterno non è valida.");
  const source = value as Record<string, unknown>;
  const allowed = new Set(["kind", "frameworkId", "name", "version", "license", "sourceUrl", "preset", "configuration", "rightsConfirmed"]);
  if (Object.keys(source).some((key) => !allowed.has(key)) || source.kind !== "user-css" || !["core-framework", "automatic-css", "custom"].includes(String(source.frameworkId)) || source.rightsConfirmed !== true) {
    throw new TypeError("La provenienza del CSS esterno non è valida o non conferma il diritto d'uso.");
  }
  const requiredText = (key: "name", limit: number): string => {
    const text = source[key];
    if (typeof text !== "string" || !text.trim() || text.trim().length > limit) throw new TypeError(`La provenienza del CSS esterno richiede ${key} valido.`);
    return text.trim();
  };
  const optionalText = (key: "version" | "license", limit: number): string | undefined => {
    const text = source[key];
    if (text === undefined || text === "") return undefined;
    if (typeof text !== "string" || text.trim().length > limit) throw new TypeError(`Il campo ${key} della provenienza CSS è troppo lungo.`);
    return text.trim();
  };
  const sourceUrl = source.sourceUrl;
  if (sourceUrl !== undefined && sourceUrl !== "") {
    if (typeof sourceUrl !== "string" || sourceUrl.length > 2048) throw new TypeError("L'indirizzo della provenienza CSS non è valido.");
    let parsed: URL;
    try { parsed = new URL(sourceUrl); } catch { throw new TypeError("L'indirizzo della provenienza CSS deve essere un URL HTTP o HTTPS."); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new TypeError("L'indirizzo della provenienza CSS deve essere un URL HTTP o HTTPS senza credenziali.");
  }
  const version = optionalText("version", 80);
  const license = optionalText("license", 160);
  const preset = source.preset === undefined ? undefined : validateCoreFrameworkPresetData(source.preset, source.frameworkId);
  const configuration = source.configuration === undefined ? undefined : validateExternalFrameworkConfiguration(source.configuration);
  return {
    kind: "user-css",
    frameworkId: source.frameworkId as ExternalFrameworkId,
    name: requiredText("name", 120),
    ...(version !== undefined ? { version } : {}),
    ...(license !== undefined ? { license } : {}),
    ...(typeof sourceUrl === "string" && sourceUrl !== "" ? { sourceUrl } : {}),
    ...(preset ? { preset } : {}),
    ...(configuration ? { configuration } : {}),
    rightsConfirmed: true,
  };
}

export function histosTokenNames(): string[] {
  return [...new Set([...HISTOS_TOKENS_CSS.matchAll(/(?<![\w-])--([a-z0-9-]+)\s*:/gu)].map((match) => match[1]!))];
}

const GROUPS: Array<[string, RegExp]> = [
  ["layout", /^xb-(container|section|stack|cluster|flow|center|grid)/u],
  ["spacing", /^xb-(p|px|py|mt|mb|gap)-/u],
  ["text", /^xb-(text-|h[1-6]$|font-|weight-|align-|balance|measure|muted|prose)/u],
  ["color", /^xb-(color-|bg-|border-[a-z]|scheme-)/u],
  ["visibility", /^xb-hide-/u],
  ["shape", /^xb-(rounded-|shadow-|border$)/u],
  ["ui", /^xb-(btn|card|badge|link)/u],
  ["forms", /^xb-(field|label|input)/u],
  ["helpers", /./u],
];

function validateCssAssetReferences(value: unknown): CssAssetReference[] {
  if (!Array.isArray(value) || value.length > 500) throw new TypeError("L’elenco dei file collegati al CSS non è valido.");
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError("Un file collegato al CSS non è valido.");
    const asset = item as Record<string, unknown>;
    if (Object.keys(asset).some((key) => !["reference", "assetId"].includes(key))
      || typeof asset.reference !== "string" || !asset.reference.trim() || asset.reference.length > 2048
      || typeof asset.assetId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(asset.assetId)) {
      throw new TypeError("Un file collegato al CSS non è valido.");
    }
    if (seen.has(asset.reference)) throw new TypeError(`Il riferimento CSS ${asset.reference} è collegato più volte.`);
    seen.add(asset.reference);
    return { reference: asset.reference, assetId: asset.assetId.toLowerCase() };
  });
}

export function histosFrameworkData(): {
  active: { id: string; label: string };
  variables: Array<{ name: string; group: string }>;
  classes: Array<{ name: string; group: string }>;
  recipes: Record<string, string>;
} {
  const classes = [...new Set([...HISTOS_UTILITIES_CSS.matchAll(/\.(xb-[a-z0-9-]+)/gu)].map((match) => match[1]!))];
  const groupedClasses = classes.flatMap((name) => {
    const group = GROUPS.find(([, pattern]) => pattern.test(name))?.[0] ?? "helpers";
    return [{ name, group }];
  });
  return {
    active: { id: "xb-tokens", label: "Histeon CSS" },
    variables: histosTokenNames().map((name) => ({ name, group: "xb" })),
    classes: groupedClasses,
    recipes: { ...HISTOS_RECIPES },
  };
}

function cssEscape(css: string, index: number): { value: string; end: number } | null {
  if (css[index] !== "\\" || index + 1 >= css.length) return null;
  const next = css[index + 1] ?? "";
  if (next === "\n" || next === "\r" || next === "\f") return null;
  const hex = /^[0-9a-f]{1,6}/iu.exec(css.slice(index + 1));
  if (!hex) return { value: next, end: index + 2 };
  const codePoint = Number.parseInt(hex[0], 16);
  let end = index + 1 + hex[0].length;
  if (/\s/u.test(css[end] ?? "")) {
    if (css[end] === "\r" && css[end + 1] === "\n") end += 2;
    else end++;
  }
  const value = codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ? "\uFFFD"
    : String.fromCodePoint(codePoint);
  return { value, end };
}

function isCssNameStart(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint === 0x5f || (codePoint >= 0x41 && codePoint <= 0x5a) || (codePoint >= 0x61 && codePoint <= 0x7a) || codePoint >= 0x80;
}

function isCssNameCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return isCssNameStart(character) || (codePoint >= 0x30 && codePoint <= 0x39) || codePoint === 0x2d;
}

function readCssClass(css: string, dot: number): { name: string; end: number } | null {
  const first = css[dot + 1] ?? "";
  const firstEscape = first === "\\" ? cssEscape(css, dot + 1) : null;
  if (!firstEscape && !isCssNameStart(first) && !(first === "-" && (css[dot + 2] === "-" || isCssNameStart(css[dot + 2] ?? "") || css[dot + 2] === "\\"))) return null;

  let name = "";
  let index = dot + 1;
  while (index < css.length) {
    const character = css[index] ?? "";
    if (character === "\\") {
      const escaped = cssEscape(css, index);
      if (!escaped) break;
      name += escaped.value;
      index = escaped.end;
    } else if (isCssNameCharacter(character)) {
      name += character;
      index++;
    } else break;
  }
  return name ? { name, end: index } : null;
}

function classesInSelector(selector: string): string[] {
  const classes: string[] = [];
  let index = 0;
  let attributeDepth = 0;
  while (index < selector.length) {
    if (selector.startsWith("/*", index)) {
      const end = selector.indexOf("*/", index + 2);
      index = end < 0 ? selector.length : end + 2;
      continue;
    }
    const character = selector[index] ?? "";
    if (character === "'" || character === '"') {
      const quote = character;
      index++;
      while (index < selector.length) {
        if (selector[index] === "\\") index += 2;
        else if (selector[index] === quote) { index++; break; }
        else index++;
      }
      continue;
    }
    if (character === "[") { attributeDepth++; index++; continue; }
    if (character === "]") { attributeDepth = Math.max(0, attributeDepth - 1); index++; continue; }
    if (attributeDepth === 0 && character === ".") {
      const parsed = readCssClass(selector, index);
      if (parsed) {
        classes.push(parsed.name);
        index = parsed.end;
        continue;
      }
    }
    if (character === "\\") index += 2;
    else index++;
  }
  return classes;
}

function cssSelectorClasses(css: string): string[] {
  const classes: string[] = [];
  let segmentStart = 0;
  let index = 0;
  let parentheses = 0;
  let brackets = 0;
  while (index < css.length) {
    if (css.startsWith("/*", index)) {
      const end = css.indexOf("*/", index + 2);
      if (end < 0) break;
      index = end + 2;
      continue;
    }
    const character = css[index] ?? "";
    if (character === "'" || character === '"') {
      const quote = character;
      index++;
      while (index < css.length) {
        if (css[index] === "\\") index += 2;
        else if (css[index] === quote) { index++; break; }
        else index++;
      }
      continue;
    }
    if (character === "\\") { index += 2; continue; }
    if (character === "(") parentheses++;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (character === "[") brackets++;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    else if (parentheses === 0 && brackets === 0 && character === ";") segmentStart = index + 1;
    else if (parentheses === 0 && brackets === 0 && character === "}") segmentStart = index + 1;
    else if (parentheses === 0 && brackets === 0 && character === "{") {
      const prelude = css.slice(segmentStart, index).trim();
      if (prelude && !prelude.startsWith("@")) classes.push(...classesInSelector(prelude));
      segmentStart = index + 1;
    }
    index++;
  }
  return classes;
}

function cssCustomPropertyNames(css: string): string[] {
  const names: string[] = [];
  let segmentStart = 0;
  let index = 0;
  let blockDepth = 0;
  let parentheses = 0;
  let brackets = 0;
  const addDeclaration = (end: number): void => {
    const declaration = css.slice(segmentStart, end).trim();
    const name = /^--([_a-zA-Z][\w-]*)\s*:/u.exec(declaration)?.[1];
    if (name) names.push(name);
  };

  while (index < css.length) {
    if (css.startsWith("/*", index)) {
      const end = css.indexOf("*/", index + 2);
      if (end < 0) break;
      index = end + 2;
      continue;
    }
    const character = css[index] ?? "";
    if (character === "'" || character === '"') {
      const quote = character;
      index++;
      while (index < css.length) {
        if (css[index] === "\\") index += 2;
        else if (css[index] === quote) { index++; break; }
        else index++;
      }
      continue;
    }
    if (character === "\\") { index += 2; continue; }
    if (character === "(") parentheses++;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (character === "[") brackets++;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    else if (parentheses === 0 && brackets === 0 && character === "{") {
      const prelude = css.slice(segmentStart, index).trim();
      const registered = /^@property\s+(--[_a-zA-Z][\w-]*)\s*$/iu.exec(prelude)?.[1];
      if (registered) names.push(registered.slice(2));
      blockDepth++;
      segmentStart = index + 1;
    } else if (parentheses === 0 && brackets === 0 && character === ";") {
      if (blockDepth > 0) addDeclaration(index);
      segmentStart = index + 1;
    } else if (parentheses === 0 && brackets === 0 && character === "}") {
      if (blockDepth > 0) addDeclaration(index);
      blockDepth = Math.max(0, blockDepth - 1);
      segmentStart = index + 1;
    }
    index++;
  }
  return names;
}

/**
 * The editor's framework lists with the site's own recipes (they win on the same name) and variables. A token of a
 * group switched off leaves the list, so the CSS panel marks it as unknown, as in WordPress.
 */
export function withSiteDesign(framework: ReturnType<typeof histosFrameworkData>, data: Pick<CmsStylesData, "siteTokens" | "siteRecipes" | "design">): ReturnType<typeof histosFrameworkData> {
  const tokens = validateSiteTokens(data.siteTokens ?? {});
  const all = computeHistosTokens(data.design ?? {});
  const printed = printedHistosTokens(all, data.design ?? {});
  return {
    ...framework,
    variables: [...framework.variables.filter(({ name }) => !Object.hasOwn(all, name) || Object.hasOwn(printed, name)), ...Object.entries(tokens).map(([name, value]) => ({ name: `${SITE_TOKEN_PREFIX}${name}`, group: "site", value }))],
    recipes: { ...framework.recipes, ...validateSiteRecipes(data.siteRecipes ?? {}) },
  };
}

export function frameworkDataWithExternalCss(globals: CmsStylesData["globals"] = []): ReturnType<typeof histosFrameworkData> {
  const framework = histosFrameworkData();
  const external = (globals ?? []).filter((sheet) => sheet.source?.kind === "user-css" && sheet.source.rightsConfirmed);
  const variables = new Map(framework.variables.map((variable) => [variable.name, variable]));
  const classes = new Map(framework.classes.map((entry) => [`${entry.name}\u0000${entry.group}`, entry]));
  for (const sheet of external) {
    const source = validateExternalFrameworkSource(sheet.source);
    const css = sheet.css.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(['"])(?:\\.|(?!\1)[^\\])*\1/gu, "");
    const group = source.name;
    for (const name of cssCustomPropertyNames(css)) if (!variables.has(name)) variables.set(name, { name, group });
    for (const name of cssSelectorClasses(css)) classes.set(`${name}\u0000${group}`, { name, group });
  }
  return { ...framework, variables: [...variables.values()], classes: [...classes.values()] };
}

/** The rules of the writer blocks (doc 24): a static site repeats its CSS in every page, so they go only where a block is. */
const ARTICLE_RULES = /^\.xb-art-[^\n]*\n|^@media[^\n]*\n\t\.xb-art-[^\n]*\n\}\n/gmu;

export function histosGlobalCss(input: { design?: unknown; tokenOverrides?: unknown; siteTokens?: unknown; globals?: Array<{ css: string }>; articleBlocks?: boolean }): string {
  const tokenNames = new Set(histosTokenNames());
  const overrides = validateHistosTokenOverrides(input.tokenOverrides ?? {}, tokenNames);
  // The site's own variables come right after the overrides, as in WordPress (TokenOverrides::css).
  const overrideCss = Object.entries(overrides).map(([name, value]) => `--${name}:${value};`).join("") + siteTokenDeclarations(input.siteTokens ?? {});
  // With groups of tokens switched off in the panel, the site's own sheet replaces the shipped defaults.
  return [
    histosGroupsOff(input.design ?? {}) ? histosTokenSheet(input.design ?? {}) : HISTOS_TOKENS_CSS,
    filterHistosClasses(input.articleBlocks === false ? HISTOS_UTILITIES_CSS.replace(ARTICLE_RULES, "") : HISTOS_UTILITIES_CSS, input.design ?? {}),
    histosDesignCss(input.design ?? {}),
    overrideCss ? `:root{${overrideCss}}` : "",
    ...(input.globals ?? []).map((sheet) => sheet.css),
  ].filter(Boolean).join("\n").replace(/<\//gu, "\\3C /");
}

export function stylesData(content: string): CmsStylesData {
  const parsed = JSON.parse(content) as CmsStylesData;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("Gli stili globali non contengono un oggetto JSON.");
  if (parsed.globals !== undefined) {
    if (!Array.isArray(parsed.globals)) throw new TypeError("I fogli CSS globali devono essere un elenco.");
    for (const sheet of parsed.globals) {
      if (!sheet || typeof sheet !== "object" || typeof sheet.css !== "string") throw new TypeError("Un foglio CSS globale non è valido.");
      if (sheet.source !== undefined) sheet.source = validateExternalFrameworkSource(sheet.source);
      if (sheet.assets !== undefined) sheet.assets = validateCssAssetReferences(sheet.assets);
    }
  }
  if (parsed.styles !== undefined) {
    if (!Array.isArray(parsed.styles)) throw new TypeError("Gli stili dei selettori devono essere un elenco.");
    for (const style of parsed.styles) {
      if (!style || typeof style !== "object" || typeof style.selector !== "string" || typeof style.css !== "string") throw new TypeError("Uno stile del selettore non è valido.");
      if (style.assets !== undefined) style.assets = validateCssAssetReferences(style.assets);
    }
  }
  if (parsed.design !== undefined) computeHistosTokens(parsed.design);
  if (parsed.queries !== undefined) {
    if (!parsed.queries || typeof parsed.queries !== "object" || Array.isArray(parsed.queries)) throw new TypeError("Le query CSS devono essere un oggetto nome → condizione.");
    for (const [name, condition] of Object.entries(parsed.queries)) {
      if (!/^[a-z][a-z0-9-]{0,30}$/u.test(name) || typeof condition !== "string" || condition.length > 160 || !/^[\w\s:().,%/<>+=-]+$/u.test(condition)) {
        throw new TypeError(`La query CSS ${name} contiene un valore non valido.`);
      }
    }
  }
  return parsed;
}
