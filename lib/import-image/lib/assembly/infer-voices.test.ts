import { describe, expect, it } from "bun:test";
import type { NoteEvent } from "../types";
import { inferVoices } from "./infer-voices";

function note(
  pitch: string | "rest",
  duration: NoteEvent["duration"],
  extra: Partial<NoteEvent> = {},
): NoteEvent {
  return {
    pitch,
    duration,
    dotted: false,
    accidental: "natural",
    measureIndex: 0,
    chord: false,
    ...extra,
  };
}

describe("inferVoices", () => {
  it("leaves a plain monophonic run single-voice", () => {
    const notes = [
      note("C4", "quarter"),
      note("D4", "quarter"),
      note("E4", "quarter"),
      note("F4", "quarter"),
    ];
    inferVoices(notes);
    expect(notes.every((n) => n.voice === undefined)).toBe(true);
  });

  it("leaves an equal-duration chord single-voice", () => {
    // A block chord: three quarters at one onset, none overlapping the next.
    const notes = [
      note("C4", "quarter"),
      note("E4", "quarter", { chord: true }),
      note("G4", "quarter", { chord: true }),
      note("C4", "quarter"),
    ];
    inferVoices(notes);
    expect(notes.every((n) => n.voice === undefined)).toBe(true);
  });

  it("splits an unequal-duration chord into held and moving voices", () => {
    // TrOMR's flattening: a held E4+G4 whole-note chord stacked with the C4
    // quarter that starts the moving line, then the rest of the moving quarters.
    const notes = [
      note("E4", "whole"), // held (longest chord member)
      note("G4", "whole", { chord: true }), // chord-mate of the held note
      note("C4", "quarter", { chord: true }), // the moving line's first note
      note("D4", "quarter"),
      note("E4", "quarter"),
      note("F4", "quarter"),
    ];
    inferVoices(notes);
    // Both whole-note members of the unequal chord (the held E4+G4) are voice 2;
    // every shorter note — the chord's C4 quarter and the following quarters —
    // is voice 1, the moving line.
    expect(notes[0].voice).toBe(2); // E4 whole (held)
    expect(notes[1].voice).toBe(2); // G4 whole (held chord-mate)
    expect(notes[2].voice).toBe(1); // C4 quarter (moving)
    expect(notes[3].voice).toBe(1);
    expect(notes[4].voice).toBe(1);
    expect(notes[5].voice).toBe(1);
  });

  it("keeps a chord single-voice when all members share a duration", () => {
    // A block chord (all quarters) has no unequal pair, so it never splits even
    // though it spans past the next onset would-be test — there is none here.
    const notes = [
      note("C4", "quarter"),
      note("E4", "quarter", { chord: true }),
      note("G4", "quarter", { chord: true }),
      note("D4", "half"),
    ];
    inferVoices(notes);
    expect(notes.every((n) => n.voice === undefined)).toBe(true);
  });

  it("infers voices independently per measure", () => {
    const notes = [
      // Measure 0: plain monophonic.
      note("C4", "quarter", { measureIndex: 0 }),
      note("D4", "quarter", { measureIndex: 0 }),
      // Measure 1: an unequal chord (held whole + moving quarter).
      note("E4", "whole", { measureIndex: 1 }),
      note("C4", "quarter", { measureIndex: 1, chord: true }),
      note("D4", "quarter", { measureIndex: 1 }),
    ];
    inferVoices(notes);
    expect(notes[0].voice).toBeUndefined();
    expect(notes[1].voice).toBeUndefined();
    expect(notes[2].voice).toBe(2); // the held whole note
    expect(notes[3].voice).toBe(1); // the moving quarters
    expect(notes[4].voice).toBe(1);
  });
});
