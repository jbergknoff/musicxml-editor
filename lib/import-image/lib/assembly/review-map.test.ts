import { describe, expect, it } from "bun:test";
import type { NoteEvent, ScoreSystem, Staff, Transcription } from "../types";
import { mapSystemsToRegions, type ReviewPageInput } from "./review-map";

function note(measureIndex: number): NoteEvent {
  return {
    pitch: "C4",
    duration: "quarter",
    dotted: false,
    accidental: "natural",
    measureIndex,
    chord: false,
  };
}

/** A transcription whose notes span measures 0..measureCount-1. */
function transcription(measureCount: number): Transcription {
  const notes: NoteEvent[] = [];
  for (let measure = 0; measure < measureCount; measure++) {
    notes.push(note(measure));
  }
  return { notes, measureCount, rawRhythm: [], attributes: {} };
}

function system(...measureCounts: number[]): ScoreSystem {
  return { staves: measureCounts.map(transcription) };
}

/** A staff whose five lines start at `top` with the given interline spacing. */
function staff(top: number, unitSize = 10, left = 50, right = 950): Staff {
  return {
    lines: [0, 1, 2, 3, 4].map((line) => top + line * unitSize),
    unitSize,
    left,
    right,
  };
}

function page(
  systems: ScoreSystem[],
  staves: Staff[],
  overrides: Partial<ReviewPageInput> = {},
): ReviewPageInput {
  return {
    systems,
    staves,
    scaleX: 1,
    scaleY: 1,
    pageWidth: 1000,
    pageHeight: 1400,
    ...overrides,
  };
}

describe("mapSystemsToRegions", () => {
  it("maps a single-staff system to its padded staff region", () => {
    const mapped = mapSystemsToRegions([
      page([system(2)], [staff(100, 10, 50, 950)]),
    ]);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].page).toBe(0);
    expect(mapped[0].firstMeasure).toBe(0);
    expect(mapped[0].measureCount).toBe(2);
    // 4 units of vertical padding and 2 units of horizontal padding.
    expect(mapped[0].region).toEqual({
      top: 60,
      bottom: 180,
      left: 30,
      right: 970,
    });
  });

  it("unions a grand-staff system's two staves into one region", () => {
    const mapped = mapSystemsToRegions([
      page([system(3, 3)], [staff(100), staff(220)]),
    ]);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].region.top).toBe(60);
    expect(mapped[0].region.bottom).toBe(300);
  });

  it("numbers measures continuously across systems and pages", () => {
    const mapped = mapSystemsToRegions([
      page([system(2), system(3)], [staff(100), staff(300)]),
      page([system(4)], [staff(100)]),
    ]);
    expect(
      mapped.map((entry) => [entry.page, entry.firstMeasure, entry.measureCount]),
    ).toEqual([
      [0, 0, 2],
      [0, 2, 3],
      [1, 5, 4],
    ]);
  });

  it("sizes a system's span by the wider of its staves", () => {
    // The bass staff recognized one more measure than the treble; the next
    // system must start past the wider span, matching buildScore.
    const mapped = mapSystemsToRegions([
      page([system(2, 3), system(1)], [staff(100), staff(220), staff(400)]),
    ]);
    expect(mapped[1].firstMeasure).toBe(3);
  });

  it("omits a system that recognized nothing without disturbing numbering", () => {
    const mapped = mapSystemsToRegions([
      page([system(2), system(0), system(1)], [
        staff(100),
        staff(300),
        staff(500),
      ]),
    ]);
    expect(mapped).toHaveLength(2);
    expect(mapped[1].firstMeasure).toBe(2);
    // The empty system's staff was still consumed: the third region is the
    // third staff's, not the second's.
    expect(mapped[1].region.top).toBe(460);
  });

  it("scales detected-staff coordinates into page space and clamps to the page", () => {
    const mapped = mapSystemsToRegions([
      page([system(1)], [staff(10, 10, 5, 490)], {
        scaleX: 2,
        scaleY: 3,
        pageWidth: 900,
        pageHeight: 200,
      }),
    ]);
    // top = (10 - 40) * 3 clamps to 0; bottom = (50 + 40) * 3 clamps to 200;
    // left = (5 - 20) * 2 clamps to 0; right = (490 + 20) * 2 clamps to 900.
    expect(mapped[0].region).toEqual({ top: 0, bottom: 200, left: 0, right: 900 });
  });

  it("returns an empty list for no pages", () => {
    expect(mapSystemsToRegions([])).toEqual([]);
  });
});
