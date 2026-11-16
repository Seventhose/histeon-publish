/**
 * OKLCH/OKLab → sRGB, for the colour pickers of the Histeon CSS generator (an `<input type="color">` only takes hex)
 * and for the contrast check (browsers compute Histeon CSS colours as `oklch()`, not `rgb()`). Same OKLab
 * definition as the server (plugin/src/Framework/HistosCss/Color.php; Björn Ottosson, 2020), clipped to sRGB.
 */

/** OKLab → sRGB channels 0–255 (clipped, not rounded). */
export function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((x) => {
    const g = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.max(0, x) ** (1 / 2.4) - 0.055;
    return Math.min(1, Math.max(0, g)) * 255;
  }) as [number, number, number];
}

/** OKLCH (hue in degrees) → sRGB channels 0–255. */
export function oklchToRgb(L: number, c: number, h: number): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  return oklabToRgb(L, c * Math.cos(rad), c * Math.sin(rad));
}

export function oklchToHex(value: string): string {
  const v = String(value ?? '').trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/i.exec(v);
  if (!m) return '#000000';
  const L = m[2] ? Number.parseFloat(m[1]!) / 100 : Number.parseFloat(m[1]!);
  return '#' + oklchToRgb(L, Number.parseFloat(m[3]!), Number.parseFloat(m[4]!)).map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
}

/** sRGB channels 0–255 → OKLCH (L 0–1, chroma, hue in degrees): the inverse of oklchToRgb. */
export function rgbToOklch(r: number, g: number, b: number): [number, number, number] {
  const lin = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2]);
  const m = Math.cbrt(0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2]);
  const s = Math.cbrt(0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2]);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(bb, a) * 180) / Math.PI;
  return [L, Math.hypot(a, bb), h < 0 ? h + 360 : h];
}
