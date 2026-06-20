import { describe, expect, it } from "bun:test";
import type { RgbaImage, Staff } from "../types";
import { detectBraces } from "./brace-detection";

const UNIT = 8;

/** A fully white RGBA raster. */
function whiteImage(width: number, height: number): RgbaImage {
  return { data: new Uint8ClampedArray(width * height * 4).fill(255), width, height };
}

function setPixel(image: RgbaImage, x: number, y: number, value: number): void {
  const offset = (y * image.width + x) * 4;
  image.data[offset] = value;
  image.data[offset + 1] = value;
  image.data[offset + 2] = value;
  image.data[offset + 3] = 255;
}

/** Draw a vertical black run at column `x` from `y0` to `y1` inclusive. */
function drawVerticalLine(
  image: RgbaImage,
  x: number,
  y0: number,
  y1: number,
): void {
  for (let y = y0; y <= y1; y++) {
    setPixel(image, x, y, 0);
  }
}

/** A five-line staff with `topLine` as its first line, spaced by `UNIT`. */
function makeStaff(topLine: number, left: number, right: number): Staff {
  return {
    lines: [0, 1, 2, 3, 4].map((index) => topLine + index * UNIT),
    unitSize: UNIT,
    left,
    right,
  };
}

describe("detectBraces", () => {
  // Two stacked staves: upper lines 20..52, lower lines 100..132, both with
  // stafflines from x=30 to x=90. The inter-staff gap is rows 52..100; the
  // left-margin scan band is columns ~6..30.
  const upper = makeStaff(20, 30, 90);
  const lower = makeStaff(100, 30, 90);

  it("reports a connecting barline bridging the gap as braced", () => {
    const image = whiteImage(100, 160);
    // A straight barline at x=28 spanning both staves and the gap between them.
    drawVerticalLine(image, 28, 20, 132);
    expect(detectBraces(image, [upper, lower])).toEqual([true]);
  });

  it("reports a curved brace (ink at varying columns per row) as braced", () => {
    const image = whiteImage(100, 160);
    // A curve that stays within the left-margin band but wanders in x per row.
    for (let y = 20; y <= 132; y++) {
      const x = 12 + (Math.abs(y - 76) % 14);
      drawVerticalLine(image, x, y, y);
    }
    expect(detectBraces(image, [upper, lower])).toEqual([true]);
  });

  it("leaves an empty left margin ungrouped", () => {
    const image = whiteImage(100, 160);
    // Stafflines and a notehead inside the staff body — none of it in the margin.
    for (const line of [...upper.lines, ...lower.lines]) {
      drawVerticalLine(image, 30, line, line); // a left-edge staffline pixel
    }
    for (let x = 58; x <= 64; x++) {
      drawVerticalLine(image, x, 74, 80); // a notehead near the gap, inside body
    }
    expect(detectBraces(image, [upper, lower])).toEqual([false]);
  });

  it("does not count margin ink that fails to bridge the gap", () => {
    const image = whiteImage(100, 160);
    // A barline beside the upper staff only — it never reaches the gap rows.
    drawVerticalLine(image, 28, 20, 52);
    expect(detectBraces(image, [upper, lower])).toEqual([false]);
  });

  it("treats coverage below the threshold as unbraced", () => {
    const image = whiteImage(100, 160);
    // Ink over only the first third of the gap (rows 52..68 of 52..100).
    drawVerticalLine(image, 28, 52, 68);
    expect(detectBraces(image, [upper, lower])).toEqual([false]);
  });

  it("ignores ink to the right of the stafflines' left edge", () => {
    const image = whiteImage(100, 160);
    // A full-height vertical line well inside the staff body (x=60) — a stem-like
    // mark, not a brace. Outside the left-margin band, so it must not count.
    drawVerticalLine(image, 60, 20, 132);
    expect(detectBraces(image, [upper, lower])).toEqual([false]);
  });

  it("returns one link per adjacent pair, braced where ink bridges", () => {
    const image = whiteImage(100, 240);
    const middle = makeStaff(100, 30, 90);
    const bottom = makeStaff(180, 30, 90);
    // Brace links the first two staves (gap rows 52..100) but not the last pair.
    drawVerticalLine(image, 28, 20, 132);
    expect(detectBraces(image, [upper, middle, bottom])).toEqual([true, false]);
  });

  it("links every staff of a multi-staff braced group", () => {
    const image = whiteImage(100, 240);
    const middle = makeStaff(100, 30, 90);
    const bottom = makeStaff(180, 30, 90);
    // One barline spanning all three staves (rows 20..212).
    drawVerticalLine(image, 28, 20, 212);
    expect(detectBraces(image, [upper, middle, bottom])).toEqual([true, true]);
  });

  it("returns no links for fewer than two staves", () => {
    const image = whiteImage(100, 160);
    expect(detectBraces(image, [])).toEqual([]);
    expect(detectBraces(image, [upper])).toEqual([]);
  });
});
