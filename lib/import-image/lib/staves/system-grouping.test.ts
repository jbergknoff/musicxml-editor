import { describe, expect, it } from "bun:test";
import type { ScoreAttributes, Transcription } from "../types";
import { groupSystems } from "./system-grouping";

function staff(clefSign?: string): Transcription {
  const attributes: ScoreAttributes =
    clefSign !== undefined
      ? { clef: { sign: clefSign, line: clefSign === "G" ? 2 : 4 } }
      : {};
  return { notes: [], measureCount: 0, rawRhythm: [], attributes };
}

describe("groupSystems", () => {
  it("pairs a treble staff over a bass staff into one system", () => {
    const systems = groupSystems([staff("G"), staff("F")]);
    expect(systems).toHaveLength(1);
    expect(systems[0].staves).toHaveLength(2);
  });

  it("keeps two treble staves as separate single-staff systems", () => {
    const systems = groupSystems([staff("G"), staff("G")]);
    expect(systems).toHaveLength(2);
    expect(systems.every((system) => system.staves.length === 1)).toBe(true);
  });

  it("pairs each treble/bass pair across multiple systems", () => {
    const systems = groupSystems([
      staff("G"),
      staff("F"),
      staff("G"),
      staff("F"),
    ]);
    expect(systems).toHaveLength(2);
    expect(systems.every((system) => system.staves.length === 2)).toBe(true);
  });

  it("does not pair a bass over a treble (wrong order)", () => {
    const systems = groupSystems([staff("F"), staff("G")]);
    expect(systems).toHaveLength(2);
  });

  it("leaves an unpaired trailing treble as its own system", () => {
    const systems = groupSystems([staff("G"), staff("F"), staff("G")]);
    expect(systems).toHaveLength(2);
    expect(systems[0].staves).toHaveLength(2);
    expect(systems[1].staves).toHaveLength(1);
  });

  it("does not pair when the lower staff's clef was not recovered", () => {
    const systems = groupSystems([staff("G"), staff(undefined)]);
    expect(systems).toHaveLength(2);
  });

  it("returns one system for a single staff", () => {
    expect(groupSystems([staff("G")])).toHaveLength(1);
  });

  it("returns nothing for no staves", () => {
    expect(groupSystems([])).toEqual([]);
  });

  it("groups brace-linked staves even when the clefs disagree", () => {
    // Two trebles the clef heuristic would keep apart, but a detected brace
    // joins them into one system.
    const systems = groupSystems([staff("G"), staff("G")], [true]);
    expect(systems).toHaveLength(1);
    expect(systems[0].staves).toHaveLength(2);
  });

  it("groups a maximal run of brace-linked staves into one system", () => {
    const systems = groupSystems(
      [staff("G"), staff("C"), staff("F")],
      [true, true],
    );
    expect(systems).toHaveLength(1);
    expect(systems[0].staves).toHaveLength(3);
  });

  it("falls back to the clef pairing where no brace was detected", () => {
    const systems = groupSystems([staff("G"), staff("F")], [false]);
    expect(systems).toHaveLength(1);
    expect(systems[0].staves).toHaveLength(2);
  });

  it("mixes brace groups and clef pairs across the page", () => {
    // First pair joins by clef (no brace), the second by a detected brace.
    const systems = groupSystems(
      [staff("G"), staff("F"), staff("G"), staff("G")],
      [false, false, true],
    );
    expect(systems).toHaveLength(2);
    expect(systems.every((system) => system.staves.length === 2)).toBe(true);
  });
});
