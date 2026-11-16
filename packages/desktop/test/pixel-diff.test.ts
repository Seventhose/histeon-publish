import { describe, expect, it } from "vitest";
import { differentPixels } from "../src/pixel-diff.js";

const bitmap = (width: number, height: number, fill: number) => ({ width, height, data: new Uint8Array(width * height * 4).fill(fill) });

describe("pixel diversi tra due fotografie (doc 23, voce 101)", () => {
  it("uguali, con lo scarto dell'antialiasing", () => {
    expect(differentPixels(bitmap(4, 3, 100), bitmap(4, 3, 100))).toEqual({ differentPixels: 0, totalPixels: 12 });
    expect(differentPixels(bitmap(4, 3, 100), bitmap(4, 3, 108))).toEqual({ differentPixels: 0, totalPixels: 12 });
  });

  it("conta i pixel cambiati e quelli che mancano a una delle due", () => {
    const changed = bitmap(4, 3, 100);
    changed.data[0] = 200;
    expect(differentPixels(bitmap(4, 3, 100), changed).differentPixels).toBe(1);
    // A page that grew by a row: the four pixels of that row differ.
    expect(differentPixels(bitmap(4, 3, 100), bitmap(4, 4, 100))).toEqual({ differentPixels: 4, totalPixels: 16 });
    expect(differentPixels(bitmap(5, 3, 100), bitmap(4, 3, 100))).toEqual({ differentPixels: 3, totalPixels: 15 });
  });
});
