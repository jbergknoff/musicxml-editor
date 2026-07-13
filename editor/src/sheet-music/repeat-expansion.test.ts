import { describe, expect, test } from "bun:test";
import {
  computePlaybackStartBeats,
  expandPlaybackOrder,
} from "./repeat-expansion";
import type { ParsedMeasure } from "./sheet-music-types";

function measure(overrides: Partial<ParsedMeasure> = {}): ParsedMeasure {
  return {
    number: 1,
    voices: [
      {
        voiceIndex: 0,
        voiceNumber: 1,
        events: [
          {
            kind: "rest",
            duration: 4,
            type: "quarter",
            dot: false,
            fullMeasure: false,
          },
        ],
      },
    ],
    divisions: 4,
    activeFifths: 0,
    ...overrides,
  };
}

describe("expandPlaybackOrder", () => {
  test("no repeats: identity order", () => {
    const measures = [measure(), measure(), measure()];
    expect(expandPlaybackOrder(measures)).toEqual([0, 1, 2]);
  });

  test("a single ||: ... :|| section repeats twice by default", () => {
    const measures = [
      measure(),
      measure({ repeatStart: true }),
      measure(),
      measure({ repeatEnd: { times: 2 } }),
      measure(),
    ];
    expect(expandPlaybackOrder(measures)).toEqual([0, 1, 2, 3, 1, 2, 3, 4]);
  });

  test("respects an explicit times count", () => {
    const measures = [
      measure({ repeatStart: true }),
      measure({ repeatEnd: { times: 3 } }),
      measure(),
    ];
    expect(expandPlaybackOrder(measures)).toEqual([0, 1, 0, 1, 0, 1, 2]);
  });

  test("a backward repeat with no preceding forward repeat jumps to the start", () => {
    const measures = [
      measure(),
      measure({ repeatEnd: { times: 2 } }),
      measure(),
    ];
    expect(expandPlaybackOrder(measures)).toEqual([0, 1, 0, 1, 2]);
  });
});

describe("computePlaybackStartBeats", () => {
  test("displayStart repeats the same value on each pass; playbackStart keeps increasing", () => {
    const measures = [
      measure({ repeatStart: true }),
      measure({ repeatEnd: { times: 2 } }),
      measure(),
    ];
    const order = expandPlaybackOrder(measures); // [0, 1, 0, 1, 2]
    const { playbackStart, displayStart } = computePlaybackStartBeats(
      measures,
      order,
    );
    expect(displayStart).toEqual([0, 1, 0, 1, 2]);
    expect(playbackStart).toEqual([0, 1, 2, 3, 4]);
  });
});
