/** A channel that moves less than this is the same pixel (antialiasing of the same glyph). */
const CHANNEL_TOLERANCE = 8;

/**
 * Pixels that differ between two BGRA bitmaps. Every pixel of the larger area the smaller bitmap lacks counts as
 * different, so a page that grew or shrank never passes.
 */
export function differentPixels(left: { width: number; height: number; data: Uint8Array }, right: { width: number; height: number; data: Uint8Array }): { differentPixels: number; totalPixels: number } {
  const width = Math.max(left.width, right.width);
  const height = Math.max(left.height, right.height);
  const commonWidth = Math.min(left.width, right.width);
  const commonHeight = Math.min(left.height, right.height);
  let same = 0;
  for (let y = 0; y < commonHeight; y++) {
    for (let x = 0; x < commonWidth; x++) {
      const a = (y * left.width + x) * 4;
      const b = (y * right.width + x) * 4;
      if (
        Math.abs((left.data[a] ?? 0) - (right.data[b] ?? 0)) <= CHANNEL_TOLERANCE
        && Math.abs((left.data[a + 1] ?? 0) - (right.data[b + 1] ?? 0)) <= CHANNEL_TOLERANCE
        && Math.abs((left.data[a + 2] ?? 0) - (right.data[b + 2] ?? 0)) <= CHANNEL_TOLERANCE
        && Math.abs((left.data[a + 3] ?? 0) - (right.data[b + 3] ?? 0)) <= CHANNEL_TOLERANCE
      ) same += 1;
    }
  }
  return { differentPixels: width * height - same, totalPixels: width * height };
}
