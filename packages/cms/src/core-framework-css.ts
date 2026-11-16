import { applyCoreHoverMedia } from "./core-hover-media.js";
import { applyCoreEasingGradients } from "./core-easing-gradients.js";

/**
 * Offline Core Framework CSS generation for the pinned 1.1.0 preset format.
 *
 * The object ordering and formulae follow Core Framework at commit
 * 9e7390a2959fe73c62dcb39107f4b4158e7daab5 (MIT). This adapter intentionally
 * rejects other versions rather than silently interpreting a changed schema.
 */

type JsonRecord = Record<string, unknown>;
type CssDeclaration = { property: string; value: string; type?: string; colorValue?: string; fluidValue?: unknown[] };
type CssObject = {
  id?: string;
  selector: string;
  declarations: CssDeclaration[];
  mediaQuery?: number[];
  media?: string;
  support?: string;
  variants?: Array<{ mediaQuery: number[]; declarations: CssDeclaration[] }>;
};

const STYLESHEET_KEYS = [
  "colorStyles", "typographyStyles", "spacingStyles", "layoutsStyles", "designStyles",
  "componentsStyles", "stylesheetsStyles", "otherStyles", "fontsStyles",
] as const;
const ROOT_FONT_OBJECT_ID = "font-sizes-root";
const SPACING_ROOT_OBJECT_ID = "fluid-spacing-root";
const REDUCED_MOTION_CSS = `
@media (prefers-reduced-motion: reduce) {
  *,
  ::before,
  ::after {
    animation-delay: -1ms !important;
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    background-attachment: initial !important;
    scroll-behavior: auto !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
}
`;
const MEDIA_CONDITIONS: Record<string, string> = {
  HOVER: "(hover: hover)",
  NOT_HOVER: "(hover: none)",
  REDUCED_MOTION: "(prefers-reduced-motion: reduce)",
  NOT_REDUCED_MOTION: "(prefers-reduced-motion: no-preference)",
  LIGHT_MODE: "(prefers-color-scheme: light)",
  DARK_MODE: "(prefers-color-scheme: dark)",
};
const SUPPORT_CONDITIONS: Record<string, string> = {
  CLAMP: "(width: clamp(1px, 1px, 1px))",
  NOT_CLAMP: "not (width: clamp(1px, 1px, 1px))",
  ASPECT_RATIO: "(aspect-ratio: 1/1)",
  NOT_ASPECT_RATIO: "not (aspect-ratio: 1/1)",
};

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function round(value: number): string {
  return String(Number(value.toFixed(2)));
}

function kebab(value: string): string {
  return value.replace(/([a-z])([A-Z])/gu, "$1-$2").toLowerCase();
}

function variableName(naming: string, step: string): string {
  return `--${naming.replace("{step}", step).replace(/\s/gu, "-")}${naming.includes("{step}") ? "" : `-${step}`}`;
}

function unit(value: number | string, isRem: boolean, rootFontSize: number): string {
  if (!isRem) return `${value}px`;
  return `${round(Number(value) / rootFontSize)}rem`;
}

function scaleVariableName(name: string): string {
  const kebabName = name.replace(/([a-z])([A-Z])/gu, "$1-$2").toLowerCase();
  const property = kebabName.startsWith("--") ? kebabName : `--${kebabName}`;
  if (!/^--[A-Za-z_][A-Za-z0-9_-]*$/u.test(property)) {
    throw new TypeError("Il nome di una variabile di scala manuale Core non è valido.");
  }
  return property;
}

function scaleDeclarations(module: JsonRecord, preferences: JsonRecord, type: "fontSize" | "size"): CssObject[] {
  if (module.isDisabled === true || Object.keys(module).length === 0) return [];
  if (module.groups !== undefined && !Array.isArray(module.groups)) {
    throw new TypeError("I gruppi della scala Core non hanno una struttura supportata.");
  }
  if (module.classes !== undefined && (!Array.isArray(module.classes) || module.classes.some((item) => !isRecord(item)))) {
    throw new TypeError("Le classi della scala Core non hanno una struttura valida.");
  }
  const groups = Array.isArray(module.groups) ? module.groups : [module];
  const declarations: CssDeclaration[] = [];
  const fluidClasses: CssObject[] = [];
  const manualClasses: CssObject[] = [];
  const rootFontSize = typeof preferences.root_font_size === "number" && preferences.root_font_size > 0 ? preferences.root_font_size : 16;
  const minWidth = typeof preferences.min_screen_width === "number" ? preferences.min_screen_width : 320;
  const maxWidth = typeof preferences.max_screen_width === "number" ? preferences.max_screen_width : 1400;
  const isRem = preferences.is_rem !== false;

  const appendClasses = (groupValue: JsonRecord, steps: string[], variableNames: string[], destination: CssObject[]) => {
    const groupId = typeof groupValue.id === "string" ? groupValue.id : "";
    const availableClasses = list(module.classes).filter((item): item is JsonRecord => isRecord(item));
    for (const classValue of availableClasses) {
      if (classValue.isDisabled === true || classValue.tabId !== groupId) continue;
      if (typeof classValue.name !== "string" || !Array.isArray(classValue.property) || classValue.property.some((property) => typeof property !== "string")) {
        throw new TypeError("Una classe di scala Core non contiene nome o proprietà validi.");
      }
      for (let index = 0; index < Math.min(steps.length, variableNames.length); index += 1) {
        const step = steps[index];
        const variable = variableNames[index];
        if (step === undefined || variable === undefined) continue;
        const selector = classValue.name.replace("*", step);
        assertSafeCssSelector(selector);
        destination.push({
          selector,
          declarations: classValue.property.map((property) => ({ property, value: `var(${variable})` })),
        });
      }
    }
  };

  for (const groupValue of groups) {
    if (!isRecord(groupValue)) throw new TypeError("Un gruppo della scala Core non è valido.");
    if (groupValue.isDisabled === true) continue;
    if (groupValue.mode === "fluid_manual") {
      if (groupValue.manualSizes !== undefined && !Array.isArray(groupValue.manualSizes)) {
        throw new TypeError("Le misure manuali della scala Core non hanno una struttura valida.");
      }
      const manualSizes = list(groupValue.manualSizes);
      const manualVariables: string[] = [];
      for (const sizeValue of manualSizes) {
        if (!isRecord(sizeValue) || typeof sizeValue.name !== "string") {
          throw new TypeError("Una misura manuale della scala Core non contiene un nome valido.");
        }
        const minSize = sizeValue.min;
        const maxSize = sizeValue.max;
        if (typeof minSize !== "number" || typeof maxSize !== "number" || !Number.isFinite(minSize) || !Number.isFinite(maxSize) ||
          !Number.isFinite(minWidth) || !Number.isFinite(maxWidth) || maxWidth <= minWidth || !Number.isFinite(rootFontSize) || rootFontSize <= 0) {
          throw new TypeError("Una misura manuale della scala Core non contiene valori responsive validi.");
        }
        const slope = (maxSize - minSize) / (maxWidth - minWidth);
        const preferred = `${round(slope * 100)}vw + ${unit(round(minSize - slope * minWidth), isRem, rootFontSize)}`;
        const property = scaleVariableName(sizeValue.name);
        manualVariables.push(property);
        declarations.push({
          property,
          value: `clamp(${unit(round(minSize), isRem, rootFontSize)}, calc(${preferred}), ${unit(round(maxSize), isRem, rootFontSize)})`,
        });
      }
      const steps = typeof groupValue.steps === "string" ? groupValue.steps.split(",").map((step) => step.trim()) : [];
      if (module.has_legacy_manual_class_generator === true) appendClasses(groupValue, steps, manualVariables, manualClasses);
      continue;
    }
    if (groupValue.mode !== undefined && groupValue.mode !== "fluid") throw new TypeError("La modalità della scala Core non è supportata. Importa il CSS esportato da Core Framework.");
    const steps = typeof groupValue.steps === "string" ? groupValue.steps.split(",").map((step) => step.trim()) : [];
    const min = isRecord(groupValue.min) ? groupValue.min : {};
    const max = isRecord(groupValue.max) ? groupValue.max : {};
    const minScale = Number(min.isCustomScaleRatio && min.scaleRatioInputValue ? min.scaleRatioInputValue : min.scaleRatio || 1);
    const maxScale = Number(max.isCustomScaleRatio && max.scaleRatioInputValue ? max.scaleRatioInputValue : max.scaleRatio || 1);
    const minBase = Number(min[type]);
    const maxBase = Number(max[type]);
    const baseIndex = Number(groupValue.baseScaleIndex ?? 0);
    const naming = typeof groupValue.namingConvention === "string" ? groupValue.namingConvention : "size";
    const safeNaming = naming.replace(/\{step\}/gu, "");
    if (!steps.length || steps.some((step) => !/^[A-Za-z0-9_-]+$/u.test(step)) || new Set(steps).size !== steps.length || !safeNaming ||
      !/^[A-Za-z0-9_-]+$/u.test(safeNaming) || !Number.isFinite(minBase) || minBase <= 0 || !Number.isFinite(maxBase) || maxBase <= 0 ||
      !Number.isFinite(minScale) || minScale <= 0 || !Number.isFinite(maxScale) || maxScale <= 0 || !Number.isInteger(baseIndex) || baseIndex < 0 || baseIndex >= steps.length ||
      !Number.isFinite(minWidth) || !Number.isFinite(maxWidth) || maxWidth <= minWidth) {
      throw new TypeError("La scala fluida del preset Core non contiene parametri validi.");
    }

    const groupVariables: string[] = [];
    steps.forEach((step, index) => {
      const offset = index - baseIndex;
      const rawMinSize = minBase * minScale ** offset;
      const rawMaxSize = maxBase * maxScale ** offset;
      const minSize = round(rawMinSize);
      const maxSize = round(rawMaxSize);
      const slope = (rawMaxSize - rawMinSize) / (maxWidth - minWidth);
      const slopeVw = `${round(slope * 100)}vw`;
      const intercept = round(rawMinSize - slope * minWidth);
      const value = `clamp(${unit(minSize, isRem, rootFontSize)}, calc(${slopeVw} + ${unit(intercept, isRem, rootFontSize)}), ${unit(maxSize, isRem, rootFontSize)})`;
      const property = variableName(naming, step);
      groupVariables.push(property);
      declarations.push({ property, value });
    });
    appendClasses(groupValue, steps, groupVariables, fluidClasses);
  }

  const rootId = type === "fontSize" ? ROOT_FONT_OBJECT_ID : SPACING_ROOT_OBJECT_ID;
  const variables = declarations.length ? [{ id: rootId, selector: ":root", declarations }] : [];
  return [...manualClasses, ...fluidClasses, ...variables];
}

function moduleScaleObjects(module: JsonRecord, kind: "typography" | "spacing", preferences: JsonRecord): CssObject[] {
  if (module.isDisabled === true) return [];
  const type = kind === "typography" ? "fontSize" : "size";
  return scaleDeclarations(module, preferences, type);
}

function normalizeColor(value: string): string {
  return value.trim().replace(/\s*,\s*/gu, ",").replace(/\s*\/\s*/gu, "/");
}

function colorAlpha(value: string, alpha: number): string | null {
  const normalized = normalizeColor(value);
  const hsl = /^hsla?\(([^)]+)\)$/iu.exec(normalized);
  if (hsl?.[1]) {
    const parts = hsl[1].split(",").map((part) => part.trim());
    if (parts.length >= 3) {
      if (Number.parseFloat(parts[1] ?? "NaN") === 0) parts[0] = "0";
      return `hsla(${parts[0]},${parts[1]},${parts[2]},${round(alpha)})`;
    }
  }
  const rgb = /^rgba?\(([^)]+)\)$/iu.exec(normalized);
  if (rgb?.[1]) {
    const parts = rgb[1].split(",").map((part) => part.trim());
    if (parts.length >= 3) return `rgba(${parts[0]},${parts[1]},${parts[2]},${round(alpha)})`;
  }
  return null;
}

function colorSystemObjects(value: unknown, classPrefix: string): CssObject[] {
  if (!isRecord(value) || value.isDisabled === true) return [];
  if (value.groups !== undefined && !Array.isArray(value.groups)) {
    throw new TypeError("I gruppi colore del preset Core non hanno una struttura valida.");
  }
  if (value.groups === undefined && Object.keys(value).length > 0) {
    throw new TypeError("Il modulo colori Core non contiene i gruppi da cui generare il CSS.");
  }
  const groups = list(value.groups);
  const declarations: CssDeclaration[] = [];
  const darkDeclarations: CssDeclaration[] = [];
  const classes: CssObject[] = [];

  for (const groupValue of groups) {
    if (!isRecord(groupValue)) throw new TypeError("Un gruppo colore del preset Core non è valido.");
    if (groupValue.isDisabled === true) continue;
    if (groupValue.colors !== undefined && !Array.isArray(groupValue.colors)) {
      throw new TypeError("Il gruppo colore del preset Core non contiene un elenco valido.");
    }
    for (const colorValue of list(groupValue.colors)) {
      if (!isRecord(colorValue) || typeof colorValue.name !== "string") {
        throw new TypeError("Un colore del preset Core non contiene un nome valido.");
      }
      const name = colorValue.name;
      if (!/^-?[A-Za-z_][A-Za-z0-9_-]*$/u.test(name)) throw new TypeError("Il nome di un colore Core non è un identificatore CSS valido.");
      if (colorValue.value !== undefined && typeof colorValue.value !== "string") {
        throw new TypeError("Il valore colore del preset Core deve essere testo CSS.");
      }
      const mainValue = typeof colorValue.value === "string" ? normalizeColor(colorValue.value) : "";
      if (!mainValue) continue;
      if ((colorValue.darkShades !== undefined && !Array.isArray(colorValue.darkShades)) ||
        (colorValue.darkTints !== undefined && !Array.isArray(colorValue.darkTints))) {
        throw new TypeError("Le varianti colore dark mode del preset Core non hanno una struttura valida.");
      }
      const hasDarkModeData = Object.entries(colorValue).some(([key, darkValue]) => {
        if (!/dark/iu.test(key) || darkValue === undefined || darkValue === null || darkValue === false || darkValue === "") return false;
        if (["isDarkMode", "darkValue", "darkShades", "darkTints"].includes(key)) return false;
        if (Array.isArray(darkValue)) return darkValue.length > 0;
        if (isRecord(darkValue)) return Object.keys(darkValue).length > 0;
        return true;
      });
      if (hasDarkModeData) throw new TypeError("Il preset Core contiene dati colore dark mode non riconosciuti. Importa il CSS esportato da Core Framework.");
      if (colorValue.darkValue !== undefined && typeof colorValue.darkValue !== "string") {
        throw new TypeError("Il valore colore dark mode del preset Core deve essere testo CSS.");
      }
      if (colorValue.shades !== undefined && !Array.isArray(colorValue.shades)) throw new TypeError("Le sfumature colore del preset Core non hanno una struttura valida.");
      if (colorValue.tints !== undefined && !Array.isArray(colorValue.tints)) throw new TypeError("Le tonalità colore del preset Core non hanno una struttura valida.");
      if (colorValue.gen !== undefined && (!Array.isArray(colorValue.gen) || colorValue.gen.some((item) => typeof item !== "string" || !["bg", "text", "border", "fill"].includes(item)))) {
        throw new TypeError("I generatori di classi colore del preset Core non sono supportati.");
      }
      if (colorValue.transparent === true && colorValue.transparentVariables !== undefined && !Array.isArray(colorValue.transparentVariables)) {
        throw new TypeError("I livelli trasparenti del colore Core non hanno una struttura valida.");
      }
      declarations.push({ property: `--${name}`, value: mainValue });

      const darkValue = typeof colorValue.darkValue === "string" ? normalizeColor(colorValue.darkValue) : "";
      if (darkValue) darkDeclarations.push({ property: `--${name}`, value: darkValue });

      const variants: Array<{ name: string; value: string }> = [];
      if (colorValue.transparent === true) {
        for (const alphaValue of list(colorValue.transparentVariables)) {
          const alpha = Number(alphaValue);
          if (!Number.isFinite(alpha) || alpha < 0 || alpha > 100) throw new TypeError("Un livello di trasparenza del preset Core non è valido.");
          const transparent = colorAlpha(mainValue, alpha / 100);
          if (!transparent) throw new TypeError("La trasparenza di questo colore Core non è supportata dal generatore. Importa il CSS esportato da Core Framework.");
          const suffix = String(alpha).replace(/^0\./u, "");
          variants.push({ name: `${name}-${suffix}`, value: transparent });
          declarations.push({ property: `--${name}-${suffix}`, value: transparent });
          if (darkValue) {
            const darkTransparent = colorAlpha(darkValue, alpha / 100);
            if (!darkTransparent) throw new TypeError("La trasparenza dark mode di questo colore Core non è supportata dal generatore. Importa il CSS esportato da Core Framework.");
            darkDeclarations.push({ property: `--${name}-${suffix}`, value: darkTransparent });
          }
        }
      }
      if (colorValue.isShades === true) {
        for (const shade of list(colorValue.shades)) {
          if (!isRecord(shade) || typeof shade.name !== "string" || typeof shade.value !== "string") {
            throw new TypeError("Una sfumatura colore del preset Core non è valida.");
          }
          if (!/^-?[A-Za-z_][A-Za-z0-9_-]*$/u.test(shade.name)) throw new TypeError("Il nome di una sfumatura Core non è un identificatore CSS valido.");
          const shadeColor = normalizeColor(shade.value);
          declarations.push({ property: `--${shade.name}`, value: shadeColor });
          variants.push({ name: shade.name, value: shadeColor });
        }
      }
      if (colorValue.isTints === true) {
        for (const tint of list(colorValue.tints)) {
          if (!isRecord(tint) || typeof tint.name !== "string" || typeof tint.value !== "string") {
            throw new TypeError("Una tonalità colore del preset Core non è valida.");
          }
          if (!/^-?[A-Za-z_][A-Za-z0-9_-]*$/u.test(tint.name)) throw new TypeError("Il nome di una tonalità Core non è un identificatore CSS valido.");
          const tintColor = normalizeColor(tint.value);
          declarations.push({ property: `--${tint.name}`, value: tintColor });
          variants.push({ name: tint.name, value: tintColor });
        }
      }
      if (darkValue && colorValue.isShades === true) {
        for (const shade of list(colorValue.darkShades)) {
          if (!isRecord(shade) || typeof shade.name !== "string" || typeof shade.value !== "string" || !/^-?[A-Za-z_][A-Za-z0-9_-]*$/u.test(shade.name)) {
            throw new TypeError("Una sfumatura dark mode del preset Core non è valida.");
          }
          darkDeclarations.push({ property: `--${shade.name}`, value: normalizeColor(shade.value) });
        }
      }
      if (darkValue && colorValue.isTints === true) {
        for (const tint of list(colorValue.darkTints)) {
          if (!isRecord(tint) || typeof tint.name !== "string" || typeof tint.value !== "string" || !/^-?[A-Za-z_][A-Za-z0-9_-]*$/u.test(tint.name)) {
            throw new TypeError("Una tonalità dark mode del preset Core non è valida.");
          }
          darkDeclarations.push({ property: `--${tint.name}`, value: normalizeColor(tint.value) });
        }
      }

      const generated = list(colorValue.gen) as string[];
      const classGenerators: Array<[string, string, string]> = [
        ["bg", "background-color", "bg"], ["text", "color", "text"], ["border", "border-color", "border"], ["fill", "fill", "fill"],
      ];
      for (const [generator, property, prefix] of classGenerators) {
        if (!generated.includes(generator)) continue;
        const createClass = (className: string, variable: string) => classes.push({
          selector: `.${prefix}-${className}`,
          declarations: [{ property, value: `var(--${variable})` }],
        });
        createClass(name, name);
        for (const variant of variants) createClass(variant.name, variant.name);
      }
    }
  }

  const objects: CssObject[] = [];
  const darkSelector = `.cf-theme-dark`;
  const lightSelector = `.cf-theme-light`;
  const invertedClass = `.${classPrefix}theme-inverted`;
  if (declarations.length) objects.push({ id: "color-system-root", selector: ":root", declarations });
  if (darkDeclarations.length) {
    objects.push({
      id: "color-system-dark-root",
      selector: `:root${darkSelector}, :root${lightSelector} ${invertedClass}, :root${lightSelector} .theme-always-dark, :root${darkSelector} ${invertedClass} .theme-always-dark`,
      declarations: darkDeclarations,
    });
    objects.push({
      id: "color-system-dark-scheme",
      selector: `html${darkSelector}`,
      declarations: [{ property: "color-scheme", value: "dark" }],
    });
  }
  return [...objects, ...classes];
}

function componentSelector(main: string, variant: JsonRecord, parent?: JsonRecord): string {
  const type = String(variant.type ?? "default");
  const parentType = String(parent?.type ?? "default");
  const pseudo = ["before", "after"].includes(type) ? `::${type}` : type === "default" || type === "variant" || type === "custom" ? "" : `:${type}`;
  if (type === "custom") return String(variant.variantSelector ?? "");
  if (parentType === "custom") return `${String(parent?.variantSelector ?? "")}${pseudo}`;
  if (parent && parentType !== "default") return `${main}${String(parent.variantSelector ?? "")}${pseudo}`;
  if (type === "variant") return `${main}${String(variant.variantSelector ?? "")}`;
  return `${main}${pseudo}`;
}

function componentObjects(value: unknown): CssObject[] {
  if (!isRecord(value) || value.isDisabled === true) return [];
  const result: CssObject[] = [];
  for (const component of list(value.components)) {
    if (!isRecord(component) || typeof component.selector !== "string") continue;
    const variants = list(component.variants).filter(isRecord);
    const legacy = isRecord(component.declarations) ? component.declarations : undefined;
    if (variants.length) {
      for (const variant of variants) {
        const parent = variants.find((candidate) => candidate.id === variant.parentId);
        const declarations = list(variant.declarations).filter(isRecord).map((declaration) => ({
          property: String(declaration.property ?? ""),
          value: String(declaration.value ?? ""),
          ...(typeof declaration.type === "string" ? { type: declaration.type } : {}),
          ...(Array.isArray(declaration.fluidValue) ? { fluidValue: declaration.fluidValue } : {}),
        })).filter((declaration) => declaration.property && declaration.value);
        result.push({ id: `component-${String(component.id)}-${String(variant.id)}`, selector: componentSelector(component.selector, variant, parent), declarations });
      }
    } else if (legacy) {
      for (const [selector, declarations] of Object.entries(legacy)) {
        result.push({ id: `component-${String(component.id)}-${selector}`, selector: selector === "default" ? component.selector : selector, declarations: list(declarations).filter(isRecord).map((declaration) => ({ property: String(declaration.property ?? ""), value: String(declaration.value ?? "") })).filter((declaration) => declaration.property && declaration.value) });
      }
    }
  }
  return result;
}

function flattenStylesheets(value: unknown): CssObject[] {
  if (!isRecord(value)) return [];
  const result: CssObject[] = [];
  for (const key of STYLESHEET_KEYS) {
    for (const group of list(value[key])) {
      if (!isRecord(group)) throw new TypeError("Un gruppo CSS del preset Core non è valido.");
      if (group.isDisabled === true) continue;
      if (group.cssObjects !== undefined && !Array.isArray(group.cssObjects)) {
        throw new TypeError("Un gruppo CSS del preset Core contiene regole non valide.");
      }
      for (const object of list(group.cssObjects)) {
        if (!isRecord(object) || typeof object.selector !== "string" || !Array.isArray(object.declarations)) {
          throw new TypeError("Una regola CSS del preset Core non è valida.");
        }
        if (object.isDisabled === true) continue;
        assertSafeCssSelector(object.selector);
        const declarations = list(object.declarations).filter(isRecord).map((declaration) => ({
          property: String(declaration.property ?? ""),
          value: String(declaration.value ?? ""),
          ...(typeof declaration.type === "string" ? { type: declaration.type } : {}),
          ...(typeof declaration.colorValue === "string" ? { colorValue: declaration.colorValue } : {}),
          ...(Array.isArray(declaration.fluidValue) ? { fluidValue: declaration.fluidValue } : {}),
        })).filter((declaration) => declaration.property && (declaration.value || declaration.colorValue || declaration.type === "fluid"));
        const mediaQuery = Array.isArray(object.mediaQuery) ? object.mediaQuery.map(Number) : undefined;
        if (mediaQuery && (mediaQuery.length !== 2 || mediaQuery.some((item) => !Number.isFinite(item) || item < 0))) {
          throw new TypeError("Un breakpoint di un oggetto CSS Core non è valido.");
        }
        const media = typeof object.media === "string" ? object.media : undefined;
        const support = typeof object.support === "string" ? object.support : undefined;
        if (media && !MEDIA_CONDITIONS[media]) throw new TypeError("Una condizione media del preset Core non è supportata.");
        if (support && !SUPPORT_CONDITIONS[support]) throw new TypeError("Una condizione @supports del preset Core non è supportata.");
        const base: CssObject = {
          selector: object.selector,
          declarations,
          ...(typeof object.id === "string" ? { id: object.id } : {}),
          ...(mediaQuery ? { mediaQuery } : {}),
          ...(media ? { media } : {}),
          ...(support ? { support } : {}),
        };
        const variants: NonNullable<CssObject["variants"]> = [];
        for (const variant of list(object.variants)) {
          if (!isRecord(variant)) throw new TypeError("Una variante CSS del preset Core non è valida.");
          const variantQuery = list(variant.mediaQuery).map(Number);
          if (variantQuery.length !== 2 || variantQuery.some((item) => !Number.isFinite(item) || item < 0)) {
            throw new TypeError("Un breakpoint di una variante CSS Core non è valido.");
          }
          variants.push({
            mediaQuery: variantQuery,
            declarations: list(variant.declarations).filter(isRecord).map((declaration) => ({
              property: String(declaration.property ?? ""),
              value: String(declaration.value ?? ""),
              ...(typeof declaration.type === "string" ? { type: declaration.type } : {}),
              ...(typeof declaration.colorValue === "string" ? { colorValue: declaration.colorValue } : {}),
              ...(Array.isArray(declaration.fluidValue) ? { fluidValue: declaration.fluidValue } : {}),
            })).filter((declaration) => declaration.property && (declaration.value || declaration.colorValue || declaration.type === "fluid")),
          });
        }
        result.push({ ...base, ...(variants.length ? { variants } : {}) });
      }
    }
  }
  return result;
}

function addLegacyColumnDefaults(preset: JsonRecord): JsonRecord {
  if (preset.has_updated_columns === true || !isRecord(preset.styleSheetData)) return preset;
  const styleSheetData: JsonRecord = { ...preset.styleSheetData };
  const layouts: JsonRecord[] = list(styleSheetData.layoutsStyles).filter(isRecord).map((group) => ({
    ...group,
    cssObjects: list(group.cssObjects).filter(isRecord).map((object) => {
      const match = typeof object.selector === "string" ? /^\.columns-(\d+)(?:--|$)/u.exec(object.selector) : null;
      if (!match?.[1]) return object;
      const declarations = list(object.declarations).filter(isRecord).map((declaration) =>
        declaration.property === "grid-template-columns"
          ? { ...declaration, value: `var(--columns-${match[1]})` }
          : declaration,
      );
      return { ...object, declarations };
    }),
  }));
  const columns = Array.from({ length: 8 }, (_, index) => index + 1).map((number) => ({
    property: `--columns-${number}`,
    value: `repeat(${number}, minmax(0, 1fr))`,
  }));
  layouts.unshift({ id: "legacy-column-variables", name: "Column variables", cssObjects: [{ id: "legacy-column-root", selector: ":root", declarations: columns }] });
  styleSheetData.layoutsStyles = layouts;
  return { ...preset, styleSheetData };
}

function mergeObjects(objects: CssObject[]): CssObject[] {
  const merged: CssObject[] = [];
  for (const object of objects) {
    const existing = merged.find((item) => item.selector === object.selector && String(item.mediaQuery ?? "0,3") === String(object.mediaQuery ?? "0,3") && item.media === object.media && item.support === object.support && JSON.stringify(item.variants ?? []) === JSON.stringify(object.variants ?? []));
    if (existing) existing.declarations.push(...object.declarations);
    else merged.push({ ...object, declarations: [...object.declarations] });
  }
  for (const object of merged) {
    const seen = new Set<string>();
    object.declarations = object.declarations.filter((declaration) => {
      const key = `${declaration.property}\u0000${declaration.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return merged.filter((object) => object.selector.startsWith("/*") || object.declarations.length > 0);
}

function prefixSelector(selector: string, prefix: string): string {
  if (!prefix || selector.startsWith(":root") || selector.startsWith("/*")) return selector;
  return selector.split(",").map((part) => {
    const value = part.trim();
    return value.startsWith(".") && !value.includes(",") && !value.includes("&") ? `.${prefix}${value.slice(1)}` : value;
  }).join(", ");
}

function applyVariablePrefix(objects: CssObject[], prefix: string): void {
  if (!prefix) return;
  const roots = objects.filter((object) => object.selector.startsWith(":root") && !object.media && !object.support && !object.mediaQuery);
  const targetVariables = new Set((roots[0]?.declarations ?? []).map((declaration) => declaration.property.replace(/^--/u, "")));
  const prefixDeclarations = (object: CssObject, declarations: CssDeclaration[]) => declarations.map((declaration) => {
    let property = declaration.property;
    let value = declaration.value;
    if (object.selector.startsWith(":root") && property.startsWith("--") && !property.startsWith(`--${prefix}`)) {
      const name = property.slice(2);
      property = `--${prefix}${name}`;
    }
    value = value.replace(/var\(--([^)]+)\)/gu, (match, name: string) => targetVariables.has(name) ? `var(--${prefix}${name})` : match);
    return { ...declaration, property, value };
  });
  for (const object of objects) {
    object.declarations = prefixDeclarations(object, object.declarations);
    if (object.variants) object.variants = object.variants.map((variant) => ({ ...variant, declarations: prefixDeclarations(object, variant.declarations) }));
  }
}

function declarationsCss(declarations: CssDeclaration[], preferences: JsonRecord): string {
  const filtered = declarations.filter((declaration) => declaration.property && declaration.value);
  return filtered.map((declaration) => {
    if (!/^-{0,2}[A-Za-z_][A-Za-z0-9_-]*$/u.test(declaration.property)) throw new TypeError("Una proprietà CSS del preset Core non è valida.");
    const property = kebab(declaration.property);
    let value = declaration.type === "color" ? String(declaration.colorValue ?? "").trim() : declaration.value.trim().replace(/;/gu, "");
    if (declaration.type === "color" && !value) throw new TypeError("Un valore colore del preset Core non è valido.");
    if (declaration.type === "fluid") {
      if (!Array.isArray(declaration.fluidValue) || declaration.fluidValue.length < 2) throw new TypeError("Una dichiarazione fluid Core non contiene i valori necessari.");
      const [minSize, maxSize] = declaration.fluidValue;
      const minWidth = Number(preferences.min_screen_width ?? 320);
      const maxWidth = Number(preferences.max_screen_width ?? 1400);
      const rootSize = Number(preferences.root_font_size ?? 16);
      const isRem = preferences.is_rem !== false;
      if (!Number.isFinite(Number(minSize)) || !Number.isFinite(Number(maxSize)) || !Number.isFinite(minWidth) || !Number.isFinite(maxWidth) || maxWidth <= minWidth || !Number.isFinite(rootSize) || rootSize <= 0) {
        throw new TypeError("I valori responsive di una dichiarazione fluid Core non sono validi.");
      }
      const slope = (Number(maxSize) - Number(minSize)) / (maxWidth - minWidth);
      const intercept = Number(minSize) - slope * minWidth;
      value = `clamp(${unit(Number(minSize), isRem, rootSize)}, calc(${round(slope * 100)}vw + ${unit(round(intercept), isRem, rootSize)}), ${unit(Number(maxSize), isRem, rootSize)})`;
    }
    if (hasUnsafeCssValue(value)) throw new TypeError("Un valore CSS del preset Core contiene caratteri non ammessi.");
    return `  ${property}: ${value};`;
  }).join("\n");
}

function indentCss(value: string): string {
  return value.split("\n").map((line) => line ? `  ${line}` : line).join("\n");
}

function hasUnsafeCssValue(value: string): boolean {
  if (value.includes("{") || value.includes("}")) return true;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function assertSafeCssSelector(selector: string): void {
  const value = selector.trim();
  if (!value || value.length > 4096 || value.startsWith("@") || hasUnsafeCssValue(value)) {
    throw new TypeError("Un selettore CSS del preset Core non è valido o contiene una regola non supportata.");
  }
}

function ruleCss(object: CssObject, preferences: JsonRecord, classPrefix: string): string {
  assertSafeCssSelector(object.selector);
  if (object.selector.startsWith("/*") && !object.selector.endsWith("Vars */")) return `\n${object.selector}`;
  const selector = prefixSelector(object.selector, classPrefix);
  const ruleForDeclarations = (declarations: CssDeclaration[]) => {
    const rendered = declarationsCss(declarations, preferences);
    return rendered ? `\n${selector} {\n${rendered}\n}` : "";
  };
  let rule = ruleForDeclarations(object.declarations);
  for (const variant of object.variants ?? []) {
    const variantRule = ruleForDeclarations(variant.declarations);
    if (!variantRule) continue;
    rule += `\n@media ${mediaQueryName(variant.mediaQuery)} {\n${indentCss(variantRule.trim())}\n}`;
  }
  if (!rule) return "";
  if (object.support) rule = `\n@supports ${SUPPORT_CONDITIONS[object.support]} {\n${indentCss(rule.trim())}\n}`;
  if (object.media) rule = `\n@media ${MEDIA_CONDITIONS[object.media]} {\n${indentCss(rule.trim())}\n}`;
  return rule;
}

function mediaQueryName(value: number[]): string {
  const [min = 0, max = 0] = value;
  if (min === 0) return `(max-width: ${max}px)`;
  if (max === 0) return `(min-width: ${min}px)`;
  const [low, high] = [min, max].sort((a, b) => a - b);
  return `(min-width: ${low}px) and (max-width: ${high}px)`;
}

function renderObjects(objects: CssObject[], preferences: JsonRecord, classPrefix: string, variablePrefix: string, manualDarkMode: boolean): string {
  const merged = mergeObjects(objects);
  const mainRoot = merged.find((object) => object.selector === ":root" && !object.media && !object.support && !object.mediaQuery);
  if (manualDarkMode && mainRoot) {
    mainRoot.selector = `:root, :root.cf-theme-dark .${classPrefix}theme-inverted, :root.cf-theme-dark .theme-always-light, :root.cf-theme-light .${classPrefix}theme-inverted .theme-always-light`;
  }
  applyVariablePrefix(merged, variablePrefix);
  merged.sort((a, b) => {
    if (a.selector.startsWith("html")) return -1;
    if (b.selector === "html") return 1;
    if (mainRoot && a === mainRoot) return -1;
    if (mainRoot && b === mainRoot) return 1;
    if (a.selector.includes(":root")) return -1;
    if (b.selector.includes(":root")) return 1;
    return 0;
  });
  const base = merged.filter((object) => !object.mediaQuery?.length);
  const responsive = merged.filter((object) => object.mediaQuery?.length);
  const mediaGroups = new Map<string, { query: number[]; objects: CssObject[] }>();
  for (const object of responsive) {
    const query = object.mediaQuery;
    if (!query || query.length < 2) continue;
    const key = String(query);
    const group = mediaGroups.get(key);
    if (group) group.objects.push(object);
    else mediaGroups.set(key, { query, objects: [object] });
  }
  const sortedMedia = [...mediaGroups.values()].sort((a, b) => (b.query[1] ?? 0) - (a.query[1] ?? 0) || (a.query[0] ?? 0) - (b.query[0] ?? 0));
  const css = base.map((object) => ruleCss(object, preferences, classPrefix)).join("");
  const mediaCss = sortedMedia.map((group) => `\n@media ${mediaQueryName(group.query)} {${group.objects.map((object) => ruleCss(object, preferences, classPrefix).replace(/\n/gmu, "\n  ")).join("")}\n}`).join("");
  return css.concat(mediaCss).trim();
}

function transformLegacyModule(value: unknown): JsonRecord {
  if (!isRecord(value)) return {};
  if (value.groups !== undefined && !Array.isArray(value.groups)) {
    throw new TypeError("I gruppi della scala Core non hanno una struttura supportata.");
  }
  if (Array.isArray(value.groups)) return value;
  return { ...value, groups: value.isDisabled === true ? [] : [{ ...value, id: "legacy", name: "Legacy" }] };
}

export interface CoreFrameworkCssResult {
  css: string;
  version: "1.1.0";
  warnings: string[];
}

/** Generate CSS from a Core 1.1.0 preset. New Core versions are rejected until separately verified. */
export function generateCoreFrameworkCss(preset: JsonRecord, options: { includeHtmlRootFontSize?: boolean } = {}): CoreFrameworkCssResult {
  if (preset.app_version !== "1.1.0") throw new TypeError("La rigenerazione è verificata solo per preset Core Framework 1.1.0.");
  const preparedPreset = addLegacyColumnDefaults(preset);
  const preferences = isRecord(preset.preferences) ? preset.preferences : {};
  const modules = isRecord(preset.modulesData) ? preset.modulesData : {};
  const classPrefix = typeof preset.classPrefix === "string" ? preset.classPrefix : "";
  const variablePrefix = typeof preset.variablePrefix === "string" ? preset.variablePrefix : "";
  if (!/^[A-Za-z0-9_-]*$/u.test(classPrefix) || !/^[A-Za-z0-9_-]*$/u.test(variablePrefix)) {
    throw new TypeError("I prefissi CSS del preset Core contengono caratteri non supportati.");
  }
  const supportedModules = new Set(["COMPONENTS", "COLOR_SYSTEM", "FLUID_SPACING", "FLUID_TYPOGRAPHY", "FONTS"]);
  for (const [name, module] of Object.entries(modules)) {
    if (!isRecord(module)) throw new TypeError("Un modulo del preset Core non è valido.");
    if (module.isDisabled !== true && !supportedModules.has(name)) {
      throw new TypeError(`Il modulo Core ${name} non è supportato dal generatore. Importa il CSS esportato da Core Framework.`);
    }
  }
  const typography = transformLegacyModule(modules.FLUID_TYPOGRAPHY);
  const spacing = transformLegacyModule(modules.FLUID_SPACING);
  const colorGroups = isRecord(modules.COLOR_SYSTEM) ? list(modules.COLOR_SYSTEM.groups) : [];
  const manualDarkMode = colorGroups.some((group) => isRecord(group) && list(group.colors).some((color) => isRecord(color) && color.isDarkMode === true));
  const objects: CssObject[] = [
    ...componentObjects(modules.COMPONENTS),
    ...colorSystemObjects(modules.COLOR_SYSTEM, classPrefix),
    ...moduleScaleObjects(spacing, "spacing", preferences),
    ...moduleScaleObjects(typography, "typography", preferences),
    ...flattenStylesheets(preparedPreset.styleSheetData),
  ];
  let css = renderObjects(objects, preferences, classPrefix, variablePrefix, manualDarkMode);
  if (options.includeHtmlRootFontSize !== false && preferences.root_font_size === 10) css = `html {\n  font-size: 62.5%;\n}\n${css}`;
  const fonts = isRecord(modules.FONTS) ? list(modules.FONTS.fonts).filter(isRecord).filter((font) => font.enable === true && typeof font.cssPreview === "string").map((font) => font.cssPreview).join("") : "";
  if (fonts) css = `${fonts}\n${css}`;
  if (preferences.prefers_reduced_motion === true) css = `${css}${REDUCED_MOTION_CSS}`;
  const warnings: string[] = [];
  if (preferences.postcss === true) {
    if (preferences.postcss_easing_gradients === true) {
      const transformed = applyCoreEasingGradients(css);
      css = transformed.css;
      if (transformed.unsupported > 0) {
        warnings.push(`PostCSS Core non ha potuto espandere ${transformed.unsupported} gradiente/i easing; le regole originali sono state conservate. Importa il CSS esportato da Core Framework per questi gradienti.`);
      }
    }
    if (preferences.postcss_hover_media === true) css = applyCoreHoverMedia(css);
    warnings.push("PostCSS Core applica i gradienti easing e la trasformazione hover media quando le rispettive opzioni sono abilitate; restano non applicate le conversioni di compatibilità browser di postcss-preset-env. Importa il CSS esportato da Core Framework per la parità completa.");
  }
  return { css, version: "1.1.0", warnings };
}
