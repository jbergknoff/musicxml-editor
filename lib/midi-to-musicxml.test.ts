import { describe, expect, test } from "bun:test";
import type { MidiData } from "midi-file";
import { getMidiTempo } from "./midi-to-musicxml";

function midiWithTempo(microsecondsPerBeat: number | null): MidiData {
  return {
    header: { format: 1, numTracks: 1, ticksPerBeat: 480 },
    tracks:
      microsecondsPerBeat === null
        ? [[]]
        : [
            [
              {
                deltaTime: 0,
                type: "setTempo",
                microsecondsPerBeat,
              },
            ],
          ],
  };
}

describe("getMidiTempo", () => {
  test("converts a setTempo meta event to quarter-note BPM", () => {
    // 500,000 µs/beat = 120 BPM (the canonical MIDI default tempo).
    expect(getMidiTempo(midiWithTempo(500_000))).toBe(120);
  });

  test("rounds to the nearest whole BPM", () => {
    // 461,538 µs/beat ≈ 130.0 BPM, but pick a value that doesn't land exactly.
    expect(getMidiTempo(midiWithTempo(409_836))).toBe(146);
  });

  test("finds a setTempo event on a later track", () => {
    const midiData: MidiData = {
      header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
      tracks: [
        [{ deltaTime: 0, type: "trackName", text: "Notes" }],
        [{ deltaTime: 0, type: "setTempo", microsecondsPerBeat: 600_000 }],
      ],
    };
    expect(getMidiTempo(midiData)).toBe(100);
  });

  test("defaults to 120 BPM when no setTempo event is present", () => {
    expect(getMidiTempo(midiWithTempo(null))).toBe(120);
  });
});
