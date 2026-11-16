export type CoreFrameworkPresetFormat = "core-lz-utf16-v1" | "core-json-v1";

export interface CoreFrameworkPresetData {
  format: CoreFrameworkPresetFormat;
  data: string;
}

const MAX_PRESET_DATA_CHARS = 524_288;
const MAX_PRESET_DATA_BYTES = 1_048_576;

/** Validate an opaque Core preset before it crosses the CMS/WP transfer boundary. */
export function validateCoreFrameworkPresetData(value: unknown, frameworkId: unknown): CoreFrameworkPresetData {
  if (frameworkId !== "core-framework" || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Il preset salvato non appartiene a Core Framework.");
  }
  const preset = value as Record<string, unknown>;
  if (
    Object.keys(preset).some((key) => !["format", "data"].includes(key)) ||
    !["core-lz-utf16-v1", "core-json-v1"].includes(String(preset.format)) ||
    typeof preset.data !== "string" ||
    !preset.data.trim() ||
    preset.data.length > MAX_PRESET_DATA_CHARS ||
    new TextEncoder().encode(preset.data).byteLength > MAX_PRESET_DATA_BYTES
  ) {
    throw new TypeError("Il preset Core Framework supera i limiti o non è valido.");
  }

  if (preset.format === "core-lz-utf16-v1") {
    for (const character of preset.data) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint < 32 || codePoint > 0x801f)
        throw new TypeError("Il file Core Framework compresso non usa il formato UTF-16 previsto.");
    }
  } else {
    validateCoreFrameworkPresetJson(preset.data);
  }

  return { format: preset.format as CoreFrameworkPresetFormat, data: preset.data };
}

export function validateCoreFrameworkPresetJson(value: string): Record<string, unknown> {
  if (
    typeof value !== "string" ||
    value.length > MAX_PRESET_DATA_CHARS ||
    new TextEncoder().encode(value).byteLength > MAX_PRESET_DATA_BYTES
  ) {
    throw new TypeError("Il preset Core Framework supera il limite di 1 MiB.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("Il preset Core Framework non contiene JSON valido.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("La radice del preset Core Framework deve essere un oggetto JSON.");
  const preset = parsed as Record<string, unknown>;
  if (
    typeof preset.id !== "string" ||
    !preset.id.trim() ||
    typeof preset.name !== "string" ||
    !preset.name.trim() ||
    typeof preset.description !== "string" ||
    typeof preset.date !== "string"
  ) {
    throw new TypeError("Il JSON non contiene i campi riconoscibili di un preset Core Framework.");
  }
  if (preset.cssString !== undefined && typeof preset.cssString !== "string")
    throw new TypeError("Il campo CSS del preset Core Framework non è testo.");
  if (typeof preset.cssString === "string" && new TextEncoder().encode(preset.cssString).byteLength > 1_048_576) {
    throw new TypeError("Il CSS del preset Core Framework supera il limite di 1 MiB; importa il CSS separatamente.");
  }
  if (preset.groups !== undefined) validateCoreGroups(preset.groups);
  if (preset.styleSheetData !== undefined) validateCoreStylesheetData(preset.styleSheetData);
  if (preset.modulesData !== undefined && !isRecord(preset.modulesData)) {
    throw new TypeError("Il campo modulesData del preset Core Framework non è valido.");
  }
  if (
    preset.breakpoints !== undefined &&
    (!Array.isArray(preset.breakpoints) ||
      preset.breakpoints.some(
        (breakpoint) =>
          !Array.isArray(breakpoint) ||
          breakpoint.length !== 2 ||
          breakpoint.some((width) => typeof width !== "number" || !Number.isFinite(width)),
      ))
  ) {
    throw new TypeError("Il campo breakpoints del preset Core Framework deve contenere coppie di numeri.");
  }
  if (preset.preferences !== undefined) validateCorePresetPreferences(preset.preferences);
  return preset;
}

const CORE_STYLESHEET_KEYS = new Set([
  "colorStyles",
  "typographyStyles",
  "spacingStyles",
  "layoutsStyles",
  "designStyles",
  "componentsStyles",
  "stylesheetsStyles",
  "otherStyles",
  "fontsStyles",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateCorePresetPreferences(value: unknown): void {
  if (!isRecord(value)) throw new TypeError("Il campo preferences del preset Core Framework non è valido.");
  for (const key of ["root_font_size", "min_screen_width", "max_screen_width"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) {
      throw new TypeError(`La preferenza ${key} del preset Core Framework deve essere numerica.`);
    }
  }
  for (const key of [
    "postcss",
    "postcss_easing_gradients",
    "postcss_hover_media",
    "is_rem",
    "prefers_reduced_motion",
    "is_add_group_comments",
  ] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new TypeError(`La preferenza ${key} del preset Core Framework deve essere booleana.`);
    }
  }
  if (value.theme_mode !== undefined && !["light", "dark", "auto"].includes(String(value.theme_mode))) {
    throw new TypeError("La preferenza theme_mode del preset Core Framework non è valida.");
  }
}

function validateCoreGroups(value: unknown): void {
  if (!isRecord(value)) throw new TypeError("Il campo groups del preset Core Framework non è valido.");
  for (const [stylesheet, groups] of Object.entries(value)) {
    if (!CORE_STYLESHEET_KEYS.has(stylesheet) || !Array.isArray(groups)) {
      throw new TypeError("Il campo groups del preset Core Framework contiene una categoria non valida.");
    }
    for (const group of groups) {
      if (
        !isRecord(group) ||
        typeof group.id !== "string" ||
        typeof group.name !== "string" ||
        (group.cssObjects !== undefined && !Array.isArray(group.cssObjects))
      ) {
        throw new TypeError("Un gruppo CSS del preset Core Framework non è valido.");
      }
      if (Array.isArray(group.cssObjects)) validateCoreCssObjects(group.cssObjects);
    }
  }
}

function validateCoreStylesheetData(value: unknown): void {
  if (!isRecord(value)) throw new TypeError("Il campo styleSheetData del preset Core Framework non è valido.");
  for (const [stylesheet, groups] of Object.entries(value)) {
    if (!CORE_STYLESHEET_KEYS.has(stylesheet) || !Array.isArray(groups)) {
      throw new TypeError("Il campo styleSheetData del preset Core Framework contiene una categoria non valida.");
    }
    for (const group of groups) {
      if (
        !isRecord(group) ||
        typeof group.id !== "string" ||
        typeof group.name !== "string" ||
        !Array.isArray(group.cssObjects)
      ) {
        throw new TypeError("Un foglio di stile del preset Core Framework non è valido.");
      }
      validateCoreCssObjects(group.cssObjects);
    }
  }
}

function validateCoreCssObjects(cssObjects: unknown[]): void {
  for (const cssObject of cssObjects) {
    if (
      !isRecord(cssObject) ||
      typeof cssObject.id !== "string" ||
      typeof cssObject.selector !== "string" ||
      !Array.isArray(cssObject.declarations)
    ) {
      throw new TypeError("Un oggetto CSS del preset Core Framework non è valido.");
    }
    for (const declaration of cssObject.declarations) {
      if (
        !isRecord(declaration) ||
        typeof declaration.id !== "string" ||
        typeof declaration.property !== "string" ||
        typeof declaration.value !== "string"
      ) {
        throw new TypeError("Una dichiarazione CSS del preset Core Framework non è valida.");
      }
    }
  }
}
