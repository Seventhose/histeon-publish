/**
 * The fonts of a project (the builder's «Font del sito» panel, docs/spec/fonts.md of the builder): WOFF2 files among
 * the project's media and their @font-face rules, kept apart from the styles document so the editor's styles never
 * conflict with a font added from the panel. Render, build and transfer add them as one more global sheet,
 * `histos-fonts`; a project received with that sheet keeps it here again.
 */
export const FONT_SHEET_ID = "histos-fonts";
/** Where the rules point: a local path of the sheet, mapped to the project's media like any global sheet. */
export const FONT_REFERENCE_PREFIX = "histos-fonts/";

export interface FontSheet {
  css: string;
  assets: Array<{ reference: string; assetId: string }>;
}

export interface FontFace {
  family: string;
  weight: string;
  style: "normal" | "italic";
  reference: string;
  /** The whole rule, as written. */
  rule: string;
}

const RULE = /@font-face\s*\{([^{}]*)\}/gu;
const FAMILY = /^[\p{L}\p{N} ._-]{1,80}$/u;

/** The rules of the sheet, read one by one; a rule that is not a plain local face is not one of them. */
export function fontFaces(sheet: FontSheet | null): FontFace[] {
  if (!sheet) return [];
  const faces: FontFace[] = [];
  for (const match of sheet.css.matchAll(RULE)) {
    const body = match[1] ?? "";
    const family = /font-family:\s*"([^"]+)"\s*;/u.exec(body)?.[1] ?? "";
    const style = /font-style:\s*(normal|italic)\s*;/u.exec(body)?.[1] as FontFace["style"] | undefined;
    const weight = /font-weight:\s*([0-9]{3}(?: [0-9]{3})?)\s*;/u.exec(body)?.[1];
    const reference = /src:\s*url\("([^"]+)"\)\s*format\("woff2"\)/u.exec(body)?.[1] ?? "";
    if (!FAMILY.test(family) || !style || !weight || !reference.startsWith(FONT_REFERENCE_PREFIX)) continue;
    faces.push({ family, weight, style, reference, rule: match[0] });
  }
  return faces;
}

/** The families of the sheet with their faces, as the panel lists them. */
export function fontFamilies(sheet: FontSheet | null): Array<{ family: string; faces: Array<{ weight: string; style: string }> }> {
  const families = new Map<string, Array<{ weight: string; style: string }>>();
  for (const face of fontFaces(sheet)) {
    const faces = families.get(face.family) ?? [];
    if (!faces.some((known) => known.weight === face.weight && known.style === face.style)) faces.push({ weight: face.weight, style: face.style });
    families.set(face.family, faces);
  }
  return [...families].sort(([a], [b]) => a.localeCompare(b)).map(([family, faces]) => ({ family, faces }));
}

/** The sheet with the faces of `family` replaced by these (none: the family goes). Media no rule names go too. */
export function withFamily(sheet: FontSheet | null, family: string, faces: ReadonlyArray<{ rule: string; reference: string; assetId: string }>): FontSheet | null {
  const kept = fontFaces(sheet).filter((face) => face.family !== family);
  const rules = [...kept.map((face) => face.rule), ...faces.map((face) => face.rule)];
  if (!rules.length) return null;
  const known = new Map((sheet?.assets ?? []).map((asset) => [asset.reference, asset.assetId]));
  for (const face of faces) known.set(face.reference, face.assetId);
  const used = new Set([...kept.map((face) => face.reference), ...faces.map((face) => face.reference)]);
  return { css: rules.join("\n"), assets: [...known].filter(([reference]) => used.has(reference)).map(([reference, assetId]) => ({ reference, assetId })) };
}

/**
 * A received global sheet that is the project's fonts: only plain local faces, each pointing to a media of the sheet.
 * Anything else stays an ordinary global sheet.
 */
export function asFontSheet(value: { id?: unknown; css?: unknown; assets?: unknown }): FontSheet | null {
  if (value.id !== FONT_SHEET_ID || typeof value.css !== "string" || !Array.isArray(value.assets)) return null;
  const assets = value.assets.filter((asset): asset is { reference: string; assetId: string } => typeof asset === "object" && asset !== null && typeof (asset as { reference?: unknown }).reference === "string" && typeof (asset as { assetId?: unknown }).assetId === "string");
  const sheet = { css: value.css, assets };
  const faces = fontFaces(sheet);
  const rest = value.css.replace(RULE, "").trim();
  const mapped = new Set(assets.map((asset) => asset.reference));
  return faces.length && !rest && faces.every((face) => mapped.has(face.reference)) ? sheet : null;
}
