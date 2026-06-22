import { describe, expect, it } from "bun:test";
import type { RgbaImage } from "../types";
import { transcribeStavesClassically } from "./classical-transcription";

// ─── Image helpers ─────────────────────────────────────────────────────────────

/** White RGBA canvas; `draw` paints solid black rectangles onto it. */
function blankImage(width: number, height: number): Uint8ClampedArray {
  return new Uint8ClampedArray(width * height * 4).fill(255);
}

function paintRect(
  data: Uint8ClampedArray,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const offset = (y * width + x) * 4;
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      data[offset + 3] = 255;
    }
  }
}

function makeImage(
  width: number,
  height: number,
  rects: [number, number, number, number][],
): RgbaImage {
  const data = blankImage(width, height);
  for (const [x0, y0, x1, y1] of rects) {
    paintRect(data, width, x0, y0, x1, y1);
  }
  return { data, width, height };
}

// ─── Staff construction helpers ────────────────────────────────────────────────

interface StaffSpec {
  unitSize: number;
  topLine: number;
  left: number;
  right: number;
}

function staffLines(spec: StaffSpec): number[] {
  return Array.from({ length: 5 }, (_, i) => spec.topLine + i * spec.unitSize);
}

function staffFrom(spec: StaffSpec) {
  return {
    lines: staffLines(spec),
    unitSize: spec.unitSize,
    left: spec.left,
    right: spec.right,
  };
}

// ─── Drawing helpers ───────────────────────────────────────────────────────────

/** Draw five full-width staff lines at the given spec. */
function drawStaffLines(
  data: Uint8ClampedArray,
  width: number,
  spec: StaffSpec,
): void {
  for (let i = 0; i < 5; i++) {
    const y = Math.round(spec.topLine + i * spec.unitSize);
    paintRect(data, width, spec.left, y, spec.right, y);
  }
}

/** Draw a filled oval notehead (approximate: filled rectangle). */
function drawFilledNotehead(
  data: Uint8ClampedArray,
  width: number,
  cx: number,
  cy: number,
  unitSize: number,
): void {
  const hw = Math.round(unitSize * 0.55);
  const hh = Math.round(unitSize * 0.38);
  paintRect(data, width, cx - hw, cy - hh, cx + hw, cy + hh);
}

/** Draw an open oval notehead (ring: outer filled minus inner white). */
function drawOpenNotehead(
  data: Uint8ClampedArray,
  width: number,
  cx: number,
  cy: number,
  unitSize: number,
): void {
  const hw = Math.round(unitSize * 0.55);
  const hh = Math.round(unitSize * 0.38);
  const iw = Math.round(unitSize * 0.28);
  const ih = Math.round(unitSize * 0.18);
  paintRect(data, width, cx - hw, cy - hh, cx + hw, cy + hh);
  // Erase interior to make it open
  const d = data;
  for (let y = cy - ih; y <= cy + ih; y++) {
    for (let x = cx - iw; x <= cx + iw; x++) {
      const offset = (y * width + x) * 4;
      d[offset] = 255;
      d[offset + 1] = 255;
      d[offset + 2] = 255;
    }
  }
}

/** Draw a vertical stem from (cx, y0) to (cx, y1). */
function drawStem(
  data: Uint8ClampedArray,
  width: number,
  cx: number,
  y0: number,
  y1: number,
): void {
  paintRect(data, width, cx, Math.min(y0, y1), cx, Math.max(y0, y1));
}

/** Draw a horizontal beam. */
function drawBeam(
  data: Uint8ClampedArray,
  width: number,
  x0: number,
  x1: number,
  y: number,
  thickness: number,
): void {
  const half = Math.floor(thickness / 2);
  paintRect(data, width, x0, y - half, x1, y + half);
}

/** Draw a barline spanning the full staff height. */
function drawBarline(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  spec: StaffSpec,
): void {
  const y0 = Math.round(spec.topLine);
  const y1 = Math.round(spec.topLine + 4 * spec.unitSize);
  paintRect(data, width, x, y0, x, y1);
}

/**
 * Draw a minimal treble clef: a tall narrow rectangle that extends above the
 * top staff line (simulating the spiral of the treble clef).
 */
function drawTrebleClef(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  spec: StaffSpec,
): void {
  const u = spec.unitSize;
  const top = Math.round(spec.topLine - 1.5 * u);
  const bottom = Math.round(spec.topLine + 4.5 * u);
  // The clef shape is wider than a barline and tall — draw a shape ~2u wide
  paintRect(data, width, x, top, x + Math.round(1.8 * u), bottom);
  // Add thickness in the middle to distinguish from a barline
  paintRect(data, width, x, top, x + Math.round(2.2 * u), top + Math.round(u));
}

/**
 * Draw a minimal bass clef: a tall shape that does NOT extend much above the
 * top staff line.
 */
function drawBassClef(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  spec: StaffSpec,
): void {
  const u = spec.unitSize;
  const top = Math.round(spec.topLine - 0.3 * u);
  const bottom = Math.round(spec.topLine + 3.5 * u);
  paintRect(data, width, x, top, x + Math.round(2.0 * u), bottom);
  // Two dots to the right
  const dotX = x + Math.round(2.4 * u);
  paintRect(
    data,
    width,
    dotX,
    Math.round(spec.topLine + 0.5 * u),
    dotX + Math.round(0.3 * u),
    Math.round(spec.topLine + 0.8 * u),
  );
  paintRect(
    data,
    width,
    dotX,
    Math.round(spec.topLine + 1.2 * u),
    dotX + Math.round(0.3 * u),
    Math.round(spec.topLine + 1.5 * u),
  );
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("transcribeStavesClassically", () => {
  it("recognizes a single quarter note on the middle line of a treble staff", () => {
    const u = 12;
    const spec: StaffSpec = { unitSize: u, topLine: 40, left: 5, right: 295 };
    const width = 300;
    const height = 130;
    const data = blankImage(width, height);
    drawStaffLines(data, width, spec);

    // Middle line = lines[2] = topLine + 2u = 64. B4 in treble clef.
    const noteX = 120;
    const noteY = Math.round(spec.topLine + 2 * u);
    drawFilledNotehead(data, width, noteX, noteY, u);
    // Stem upward
    drawStem(data, width, noteX + Math.round(u * 0.5), noteY - Math.round(u * 3.5), noteY);

    const image: RgbaImage = { data, width, height };
    const staff = staffFrom(spec);
    const [result] = transcribeStavesClassically(image, [staff]);

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0].pitch).toBe("B4");
    expect(result.notes[0].duration).toBe("quarter");
    expect(result.notes[0].dotted).toBe(false);
    expect(result.notes[0].chord).toBe(false);
    expect(result.notes[0].measureIndex).toBe(0);
  });

  it("recognizes a whole note (open, no stem) on the bottom line of a treble staff", () => {
    const u = 12;
    const spec: StaffSpec = { unitSize: u, topLine: 40, left: 5, right: 295 };
    const width = 300;
    const height = 130;
    const data = blankImage(width, height);
    drawStaffLines(data, width, spec);

    // Bottom line = lines[4] = topLine + 4u = 88. E4 in treble clef.
    const noteX = 120;
    const noteY = Math.round(spec.topLine + 4 * u);
    drawOpenNotehead(data, width, noteX, noteY, u);
    // No stem for whole note

    const image: RgbaImage = { data, width, height };
    const staff = staffFrom(spec);
    const [result] = transcribeStavesClassically(image, [staff]);

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0].pitch).toBe("E4");
    expect(result.notes[0].duration).toBe("whole");
  });

  it("recognizes a half note (open, with stem)", () => {
    const u = 12;
    const spec: StaffSpec = { unitSize: u, topLine: 40, left: 5, right: 295 };
    const width = 300;
    const height = 140;
    const data = blankImage(width, height);
    drawStaffLines(data, width, spec);

    // Space between lines[3] and lines[4]: step 7 below top = A4.
    const noteX = 120;
    const noteY = Math.round(spec.topLine + 3.5 * u);
    drawOpenNotehead(data, width, noteX, noteY, u);
    drawStem(data, width, noteX + Math.round(u * 0.5), noteY - Math.round(u * 3.5), noteY);

    const image: RgbaImage = { data, width, height };
    const staff = staffFrom(spec);
    const [result] = transcribeStavesClassically(image, [staff]);

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0].duration).toBe("half");
  });

  it("assigns consecutive notes to the correct measure after a barline", () => {
    const u = 12;
    const spec: StaffSpec = { unitSize: u, topLine: 40, left: 5, right: 395 };
    const width = 400;
    const height = 130;
    const data = blankImage(width, height);
    drawStaffLines(data, width, spec);

    // Note 1 at x=80 (measure 0)
    drawFilledNotehead(data, width, 80, Math.round(spec.topLine + 2 * u), u);
    drawStem(
      data,
      width,
      80 + Math.round(u * 0.5),
      Math.round(spec.topLine + 2 * u) - Math.round(u * 3.5),
      Math.round(spec.topLine + 2 * u),
    );

    // Barline at x=160
    drawBarline(data, width, 160, spec);

    // Note 2 at x=240 (measure 1)
    drawFilledNotehead(data, width, 240, Math.round(spec.topLine + 2 * u), u);
    drawStem(
      data,
      width,
      240 + Math.round(u * 0.5),
      Math.round(spec.topLine + 2 * u) - Math.round(u * 3.5),
      Math.round(spec.topLine + 2 * u),
    );

    const image: RgbaImage = { data, width, height };
    const staff = staffFrom(spec);
    const [result] = transcribeStavesClassically(image, [staff]);

    expect(result.notes.length).toBeGreaterThanOrEqual(2);
    const measures = result.notes.map((n) => n.measureIndex);
    expect(measures[0]).toBe(0);
    expect(measures[measures.length - 1]).toBe(1);
    expect(result.measureCount).toBe(2);
  });

  it("recognizes beamed eighth notes", () => {
    const u = 12;
    const spec: StaffSpec = { unitSize: u, topLine: 40, left: 5, right: 295 };
    const width = 300;
    const height = 130;
    const data = blankImage(width, height);
    drawStaffLines(data, width, spec);

    const noteY = Math.round(spec.topLine + 2 * u);
    const stemTop = noteY - Math.round(u * 3.5);

    // Two eighth notes with a beam
    const x1 = 80;
    const x2 = 130;
    drawFilledNotehead(data, width, x1, noteY, u);
    drawStem(data, width, x1 + Math.round(u * 0.5), stemTop, noteY);
    drawFilledNotehead(data, width, x2, noteY, u);
    drawStem(data, width, x2 + Math.round(u * 0.5), stemTop, noteY);
    // Beam connecting the two stems
    drawBeam(
      data,
      width,
      x1 + Math.round(u * 0.5),
      x2 + Math.round(u * 0.5),
      stemTop,
      Math.round(u * 0.35),
    );

    const image: RgbaImage = { data, width, height };
    const staff = staffFrom(spec);
    const [result] = transcribeStavesClassically(image, [staff]);

    expect(result.notes.length).toBeGreaterThanOrEqual(2);
    const durations = result.notes.map((n) => n.duration);
    expect(durations.every((d) => d === "eighth")).toBe(true);
  });

  it("detects treble clef from a tall symbol extending above the staff", () => {
    const u = 12;
    const spec: StaffSpec = { unitSize: u, topLine: 40, left: 5, right: 295 };
    const width = 300;
    const height = 160;
    const data = blankImage(width, height);
    drawStaffLines(data, width, spec);
    drawTrebleClef(data, width, 10, spec);

    const image: RgbaImage = { data, width, height };
    const staff = staffFrom(spec);
    const [result] = transcribeStavesClassically(image, [staff]);

    expect(result.attributes.clef?.sign).toBe("G");
  });

  it("detects bass clef from a shape that does not extend above the staff", () => {
    const u = 12;
    const spec: StaffSpec = { unitSize: u, topLine: 50, left: 5, right: 295 };
    const width = 300;
    const height = 160;
    const data = blankImage(width, height);
    drawStaffLines(data, width, spec);
    drawBassClef(data, width, 10, spec);

    const image: RgbaImage = { data, width, height };
    const staff = staffFrom(spec);
    const [result] = transcribeStavesClassically(image, [staff]);

    expect(result.attributes.clef?.sign).toBe("F");
  });

  it("detects a key signature of two sharps", () => {
    const u = 12;
    const spec: StaffSpec = { unitSize: u, topLine: 40, left: 5, right: 295 };
    const width = 300;
    const height = 130;
    const data = blankImage(width, height);
    drawStaffLines(data, width, spec);

    // Draw two sharps after a clef region. A realistic # has two thin vertical
    // bars with two thin horizontal bars crossing them (and extending slightly
    // beyond). The vertical bars must be disconnected in the top zone so the
    // avgTopRunCount discriminator sees ≥2 runs there.
    const sharpW = Math.round(u * 0.85);
    const sharpH = Math.round(u * 1.5);
    const barW = Math.max(1, Math.round(sharpW * 0.2)); // ~2px vertical bar width
    const leftX = Math.round(sharpW * 0.15);   // left bar inset from edge
    const rightX = sharpW - leftX - barW;       // symmetric right bar
    const afterClefX = Math.round(u * 3.5);
    for (let i = 0; i < 2; i++) {
      const sx = afterClefX + i * (sharpW + Math.round(u * 0.4));
      const sy = Math.round(spec.topLine + u);
      // Two thin vertical bars (disconnected from each other)
      paintRect(data, width, sx + leftX, sy, sx + leftX + barW - 1, sy + sharpH);
      paintRect(data, width, sx + rightX, sy, sx + rightX + barW - 1, sy + sharpH);
      // Two thin horizontal bars spanning the full width at 35% and 65% height
      const hBarH = Math.max(1, Math.round(barW * 0.8));
      paintRect(data, width, sx, sy + Math.round(sharpH * 0.35), sx + sharpW - 1, sy + Math.round(sharpH * 0.35) + hBarH - 1);
      paintRect(data, width, sx, sy + Math.round(sharpH * 0.65), sx + sharpW - 1, sy + Math.round(sharpH * 0.65) + hBarH - 1);
    }

    const image: RgbaImage = { data, width, height };
    const staff = staffFrom(spec);
    const [result] = transcribeStavesClassically(image, [staff]);

    expect(result.attributes.keyFifths).toBe(2);
  });

  it("reports correct pitch for a bass clef note on the top line (A3)", () => {
    const u = 12;
    const spec: StaffSpec = { unitSize: u, topLine: 50, left: 5, right: 295 };
    const width = 300;
    const height = 160;
    const data = blankImage(width, height);
    drawStaffLines(data, width, spec);
    drawBassClef(data, width, 10, spec);

    // Note on top line = A3 in bass clef.
    const noteX = 100;
    const noteY = Math.round(spec.topLine); // top line
    drawFilledNotehead(data, width, noteX, noteY, u);
    drawStem(data, width, noteX + Math.round(u * 0.5), noteY, noteY + Math.round(u * 3.5));

    const image: RgbaImage = { data, width, height };
    const staff = staffFrom(spec);
    const [result] = transcribeStavesClassically(image, [staff]);

    const notePitches = result.notes.map((n) => n.pitch);
    expect(notePitches).toContain("A3");
  });

  it("calls onProgress once per staff", () => {
    const u = 12;
    const spec: StaffSpec = { unitSize: u, topLine: 40, left: 5, right: 295 };
    const image: RgbaImage = makeImage(300, 130, []);
    const staff = staffFrom(spec);

    const calls: [number, number][] = [];
    transcribeStavesClassically(image, [staff, staff], {
      onProgress: (done, total) => calls.push([done, total]),
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([1, 2]);
    expect(calls[1]).toEqual([2, 2]);
  });
});
