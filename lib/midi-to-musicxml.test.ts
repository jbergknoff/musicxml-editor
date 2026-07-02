import { describe, expect, test } from "bun:test";
import type { MidiData, MidiEvent } from "midi-file";
import {
  DEFAULT_MIDI_IMPORT_OPTIONS,
  convertMidiToMusicXml,
  getMidiTempo,
  inferKeyFifthsFromPitches,
} from "./midi-to-musicxml";

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

// Build a single track's events from a list of (noteNumber, startTick,
// endTick) notes, converting absolute ticks to the deltaTime encoding a real
// MIDI track uses.
function notesToTrack(
  notes: Array<{ num: number; start: number; end: number }>,
): MidiEvent[] {
  const timed: Array<{ tick: number; event: MidiEvent }> = [];
  for (const n of notes) {
    timed.push({
      tick: n.start,
      event: {
        deltaTime: 0,
        type: "noteOn",
        channel: 0,
        noteNumber: n.num,
        velocity: 80,
      },
    });
    timed.push({
      tick: n.end,
      event: {
        deltaTime: 0,
        type: "noteOff",
        channel: 0,
        noteNumber: n.num,
        velocity: 0,
      },
    });
  }
  timed.sort((a, b) => a.tick - b.tick);
  let prevTick = 0;
  return timed.map(({ tick, event }) => {
    const deltaTime = tick - prevTick;
    prevTick = tick;
    return { ...event, deltaTime };
  });
}

describe("inferKeyFifthsFromPitches", () => {
  test("infers G major (1 sharp) from a G major scale", () => {
    // G A B C D E F# G, i.e. every pitch class of G major, none outside it.
    const gMajor = [7, 9, 11, 0, 2, 4, 6, 7].map((pc) => 60 + pc);
    expect(inferKeyFifthsFromPitches(gMajor)).toBe(1);
  });

  test("infers F major (1 flat) from an F major scale", () => {
    const fMajor = [5, 7, 9, 10, 0, 2, 4].map((pc) => 60 + pc);
    expect(inferKeyFifthsFromPitches(fMajor)).toBe(-1);
  });

  test("defaults to C major for an empty pitch list", () => {
    expect(inferKeyFifthsFromPitches([])).toBe(0);
  });

  test("prefers the key closer to C on a tie", () => {
    // A single pitch class is diatonic to many keys; the fewest-accidentals
    // (closest to C) key should win.
    expect(inferKeyFifthsFromPitches([60, 60, 60])).toBe(0);
  });
});

describe("convertMidiToMusicXml", () => {
  function midiWithTrack(
    notes: Array<{ num: number; start: number; end: number }>,
  ): MidiData {
    return {
      header: { format: 1, numTracks: 1, ticksPerBeat: 480 },
      tracks: [notesToTrack(notes)],
    };
  }

  test("infers a key signature from pitch content when the file has none", () => {
    // A one-measure G major run (480 ticks/quarter, 4/4).
    const midiData = midiWithTrack(
      [67, 69, 71, 72, 74, 76, 78, 79].map((num, i) => ({
        num,
        start: i * 240,
        end: (i + 1) * 240,
      })),
    );
    const xml = convertMidiToMusicXml(midiData, {
      ...DEFAULT_MIDI_IMPORT_OPTIONS,
      trackIndices: [0],
      inferKey: true,
    });
    expect(xml).toContain("<fifths>1</fifths>");
  });

  test("leaves the key at C major when inference is disabled", () => {
    const midiData = midiWithTrack(
      [67, 69, 71, 72, 74, 76, 78, 79].map((num, i) => ({
        num,
        start: i * 240,
        end: (i + 1) * 240,
      })),
    );
    const xml = convertMidiToMusicXml(midiData, {
      ...DEFAULT_MIDI_IMPORT_OPTIONS,
      trackIndices: [0],
      inferKey: false,
    });
    expect(xml).toContain("<fifths>0</fifths>");
  });

  test("quantizes to a coarser grid when an 8th-note grid is requested", () => {
    // Two back-to-back quarter notes, so the first note's display duration
    // is bounded by the second note's onset rather than filling the measure.
    const midiData = midiWithTrack([
      { num: 60, start: 0, end: 480 },
      { num: 62, start: 480, end: 960 },
    ]);
    const xml = convertMidiToMusicXml(midiData, {
      ...DEFAULT_MIDI_IMPORT_OPTIONS,
      trackIndices: [0],
      quantizeGrid: 8,
    });
    // divisions=2 (8th-note grid): a quarter note is 2 divisions.
    expect(xml).toContain("<divisions>2</divisions>");
    expect(xml).toContain("<duration>2</duration>");
  });

  test("merges selected tracks into a two-staff piano part split by pitch", () => {
    const midiData: MidiData = {
      header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
      tracks: [
        notesToTrack([{ num: 72, start: 0, end: 480 }]), // treble (>= 60)
        notesToTrack([{ num: 48, start: 0, end: 480 }]), // bass (< 60)
      ],
    };
    const xml = convertMidiToMusicXml(midiData, {
      ...DEFAULT_MIDI_IMPORT_OPTIONS,
      trackIndices: [0, 1],
      mergeTracks: true,
      splitPoint: 60,
    });
    expect(xml).toContain("<staves>2</staves>");
    expect(xml).toContain("<backup>");
    expect((xml.match(/<part id=/g) ?? []).length).toBe(1);
    expect(xml).toContain("<staff>1</staff>");
    expect(xml).toContain("<staff>2</staff>");
  });
});
