import { describe, expect, it } from "bun:test";
import type { ReviewSystem } from "./import-review";
import { flaggedNotesInSystem, systemForMeasure } from "./import-review";

function reviewSystem(
  firstMeasure: number,
  measureCount: number,
): ReviewSystem {
  return {
    page: 0,
    firstMeasure,
    measureCount,
    region: { top: 0, bottom: 100, left: 0, right: 100 },
  };
}

const SYSTEMS = [reviewSystem(0, 2), reviewSystem(2, 3), reviewSystem(5, 4)];

describe("systemForMeasure", () => {
  it("finds the system whose range contains the measure", () => {
    expect(systemForMeasure(SYSTEMS, 0)).toBe(0);
    expect(systemForMeasure(SYSTEMS, 1)).toBe(0);
    expect(systemForMeasure(SYSTEMS, 2)).toBe(1);
    expect(systemForMeasure(SYSTEMS, 4)).toBe(1);
    expect(systemForMeasure(SYSTEMS, 5)).toBe(2);
    expect(systemForMeasure(SYSTEMS, 8)).toBe(2);
  });

  it("clamps a measure past the end to the last system", () => {
    expect(systemForMeasure(SYSTEMS, 9)).toBe(2);
    expect(systemForMeasure(SYSTEMS, 100)).toBe(2);
  });

  it("clamps a measure in a gap to the preceding system", () => {
    // A zero-measure system was omitted between measures 1 and 3.
    const gappy = [reviewSystem(0, 2), reviewSystem(3, 2)];
    expect(systemForMeasure(gappy, 2)).toBe(0);
  });

  it("clamps a measure before the first system to the first", () => {
    const late = [reviewSystem(2, 2)];
    expect(systemForMeasure(late, 0)).toBe(0);
  });

  it("returns null when there are no systems", () => {
    expect(systemForMeasure([], 0)).toBeNull();
  });
});

describe("flaggedNotesInSystem", () => {
  it("keeps only flags within the system's measure range", () => {
    const flag = (measureIndex: number) => ({
      measureIndex,
      noteElementIndex: 0,
      confidence: 0.5,
    });
    expect(
      flaggedNotesInSystem([flag(1), flag(2), flag(4)], reviewSystem(2, 3)),
    ).toEqual([flag(2), flag(4)]);
    expect(
      flaggedNotesInSystem([flag(0), flag(5)], reviewSystem(2, 3)),
    ).toEqual([]);
  });
});
