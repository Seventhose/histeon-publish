/**
 * Settings and arithmetic of the modern image variants of a static build (queue B6), shared by the build, its report
 * and the project settings. The encoder itself (jSquash: WebAssembly builds of libjxl, libavif with libaom, libwebp,
 * mozjpeg, the Rust png and resize crates) runs in the server, in a worker thread (packages/server/src/image-*.ts).
 */

/** The project's choices: variants on or off, the widths of `srcset`, the quality of each format (1–100). */
export interface CmsImageSettings {
  variants: boolean;
  widths: number[];
  quality: { avif: number; jxl: number; webp: number };
}

/**
 * The defaults: one visual quality for the three formats, measured with SSIM on five photographs at 1600 px with the
 * build's encoder settings (docs/adr/0012-codificatore-immagini.md): WebP 75 (0.972), AVIF 60 (0.973), JPEG XL 75
 * (0.973). With the same quality, the build keeps a format only where it is the lighter one. Lossless sources (PNG,
 * lossless WebP) stay lossless and ignore the qualities.
 */
export const CMS_IMAGE_SETTINGS_DEFAULTS: Readonly<CmsImageSettings> = Object.freeze({
  variants: true,
  widths: Object.freeze([480, 960, 1600]) as unknown as number[],
  quality: Object.freeze({ avif: 60, jxl: 75, webp: 75 }),
});

/** No variant wider than this: the largest candidate is the file's own width up to here. */
export const IMAGE_VARIANT_MAX_WIDTH = 2560;
/** Nor larger than this many pixels (a tall image gets a narrower top width). */
export const IMAGE_VARIANT_MAX_OUTPUT_PIXELS = 8_000_000;

export function normalizeCmsImageSettings(value: unknown): CmsImageSettings {
  if (value === undefined || value === null) return cloneImageSettings(CMS_IMAGE_SETTINGS_DEFAULTS);
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("Impostazioni delle immagini non valide.");
  const input = value as Record<string, unknown>;
  const variants = input.variants === undefined ? CMS_IMAGE_SETTINGS_DEFAULTS.variants : input.variants;
  if (typeof variants !== "boolean") throw new TypeError("Le varianti delle immagini sono attive o no (true o false).");
  const widths = input.widths === undefined ? [...CMS_IMAGE_SETTINGS_DEFAULTS.widths] : input.widths;
  if (!Array.isArray(widths) || widths.length < 1 || widths.length > 6 || widths.some((width) => !Number.isSafeInteger(width) || width < 64 || width > IMAGE_VARIANT_MAX_WIDTH)) {
    throw new TypeError(`Le larghezze delle varianti sono da 1 a 6 numeri interi fra 64 e ${IMAGE_VARIANT_MAX_WIDTH}.`);
  }
  const quality = input.quality === undefined ? {} : input.quality;
  if (!quality || typeof quality !== "object" || Array.isArray(quality)) throw new TypeError("Qualità delle immagini non valida.");
  const read = (format: "avif" | "jxl" | "webp") => {
    const given = (quality as Record<string, unknown>)[format];
    const result = given === undefined ? CMS_IMAGE_SETTINGS_DEFAULTS.quality[format] : given;
    if (!Number.isSafeInteger(result) || (result as number) < 1 || (result as number) > 100) throw new TypeError(`La qualità ${format.toUpperCase()} è un numero intero da 1 a 100.`);
    return result as number;
  };
  return { variants, widths: [...new Set(widths as number[])].sort((left, right) => left - right), quality: { avif: read("avif"), jxl: read("jxl"), webp: read("webp") } };
}

function cloneImageSettings(settings: Readonly<CmsImageSettings>): CmsImageSettings {
  return { variants: settings.variants, widths: [...settings.widths], quality: { ...settings.quality } };
}

/**
 * The widths of an image's variants, smallest first, never upscaled: the settings' widths below the top one, and the
 * top one itself, which is the file's width (as shown, after its orientation) up to IMAGE_VARIANT_MAX_WIDTH and
 * IMAGE_VARIANT_MAX_OUTPUT_PIXELS.
 */
export function imageVariantWidths(width: number, height: number, settings: Pick<CmsImageSettings, "widths">): number[] {
  const byPixels = Math.floor(Math.sqrt((IMAGE_VARIANT_MAX_OUTPUT_PIXELS * width) / height));
  const top = Math.max(1, Math.min(width, IMAGE_VARIANT_MAX_WIDTH, byPixels));
  return [...settings.widths.filter((candidate) => candidate < top), top];
}

/** The height of a variant `width` wide of an image `width0` × `height0` (as shown): rounded, at least 1. */
export function imageVariantHeight(width: number, width0: number, height0: number): number {
  return Math.max(1, Math.round((height0 * width) / width0));
}
