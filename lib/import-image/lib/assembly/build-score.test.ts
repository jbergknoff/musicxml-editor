import { describe, expect, it } from "bun:test";
import type {
  NoteEvent,
  ScoreAttributes,
  ScoreSystem,
  Transcription,
} from "../types";
import { buildScore } from "./musicxml-builder";

function note(
  pitch: string,
  measureIndex = 0,
  extra: Partial<NoteEvent> = {},
): NoteEvent {
  return {
    pitch,
    duration: "quarter",
    dotted: false,
    accidental: "natural",
    measureIndex,
    chord: false,
    ...extra,
  };
}

function staff(
  notes: NoteEvent[],
  attributes: ScoreAttributes = {},
): Transcription {
  return { notes, measureCount: 0, rawRhythm: [], attributes };
}

function system(...staves: Transcription[]): ScoreSystem {
  return { staves };
}

const TREBLE: ScoreAttributes = {
  clef: { sign: "G", line: 2 },
  time: { beats: 4, beatType: 4 },
};
const BASS: ScoreAttributes = { clef: { sign: "F", line: 4 } };

describe("buildScore — single staff", () => {
  it("matches the single-staff format (no <staves>/<staff>/<backup>)", () => {
    const xml = buildScore([system(staff([note("C4")], TREBLE))]);
    expect(xml).not.toContain("<staves>");
    expect(xml).not.toContain("<staff>");
    expect(xml).not.toContain("<backup>");
    expect(xml).toContain("<step>C</step>");
  });

  it("concatenates single-staff systems sequentially in time", () => {
    const xml = buildScore([
      system(staff([note("C4", 0)], TREBLE)),
      system(staff([note("D4", 0)], TREBLE)),
    ]);
    // The second system's measure 0 becomes measure 2 of the part.
    expect(xml).toContain('measure number="1"');
    expect(xml).toContain('measure number="2"');
    const firstNote = xml.indexOf("<step>C</step>");
    const secondNote = xml.indexOf("<step>D</step>");
    expect(firstNote).toBeLessThan(secondNote);
  });

  it("throws rather than guess when the staff's clef was not recovered", () => {
    expect(() => buildScore([system(staff([note("C4")]))])).toThrow(/clef/i);
  });
});

describe("buildScore — voice inference", () => {
  // A whole note stacked with a quarter is TrOMR's flattened two-voice chord.
  function held(pitch: string, extra: Partial<NoteEvent> = {}): NoteEvent {
    return note(pitch, 0, { duration: "whole", ...extra });
  }

  it("splits an unequal-duration chord into two <backup>-separated voices", () => {
    const xml = buildScore([
      system(
        staff(
          [
            held("E4"),
            held("G4", { chord: true }),
            note("C4", 0, { chord: true }),
            note("D4", 0),
            note("E4", 0),
            note("F4", 0),
          ],
          TREBLE,
        ),
      ),
    ]);
    // Two voices with a backup between them, all on one staff (no <staff>).
    expect(xml).toContain("<voice>1</voice>");
    expect(xml).toContain("<voice>2</voice>");
    expect(xml).toContain("<backup>");
    expect(xml).not.toContain("<staff>");
    // The held chord (voice 2) keeps its whole notes; the moving line (voice 1)
    // is four quarters re-timed from the chord onset.
    expect((xml.match(/<type>whole<\/type>/g) ?? []).length).toBe(2);
    expect((xml.match(/<type>quarter<\/type>/g) ?? []).length).toBe(4);
  });

  it("leaves an equal-duration chord single-voice (no backup)", () => {
    const xml = buildScore([
      system(
        staff(
          [note("C4"), note("E4", 0, { chord: true }), note("G4", 0, { chord: true })],
          TREBLE,
        ),
      ),
    ]);
    expect(xml).not.toContain("<backup>");
    expect(xml).not.toContain("<voice>");
  });

  it("reports note-element indices in document order across both voices", () => {
    const emitted: Array<[string, number]> = [];
    buildScore(
      [
        system(
          staff(
            [
              held("E4"),
              note("C4", 0, { chord: true }),
              note("D4", 0),
            ],
            TREBLE,
          ),
        ),
      ],
      {
        onNoteEmitted: (note, _measureIndex, noteElementIndex) => {
          emitted.push([note.pitch, noteElementIndex]);
        },
      },
    );
    // Voice 1 (C4, D4) is emitted first (indices 0, 1), then voice 2 (E4) after
    // the backup (index 2) — matching the editor's document-order handles.
    expect(emitted).toEqual([
      ["C4", 0],
      ["D4", 1],
      ["E4", 2],
    ]);
  });
});

describe("buildScore — grand staff", () => {
  it("emits one part with two staves, a clef per staff", () => {
    const xml = buildScore([
      system(staff([note("C5")], TREBLE), staff([note("C3")], BASS)),
    ]);
    expect(xml).toContain("<staves>2</staves>");
    expect(xml).toContain(
      '<clef number="1"><sign>G</sign><line>2</line></clef>',
    );
    expect(xml).toContain(
      '<clef number="2"><sign>F</sign><line>4</line></clef>',
    );
  });

  it("tags notes with their staff and voice and backs up between staves", () => {
    const xml = buildScore([
      system(staff([note("C5")], TREBLE), staff([note("C3")], BASS)),
    ]);
    expect(xml).toContain("<staff>1</staff>");
    expect(xml).toContain("<staff>2</staff>");
    expect(xml).toContain("<voice>1</voice>");
    expect(xml).toContain("<voice>2</voice>");
    // Backup rewinds by the treble's written duration (one quarter = 4).
    expect(xml).toContain("<backup>\n  <duration>4</duration>\n</backup>");
    // The bass note follows the backup.
    const backupIndex = xml.indexOf("<backup>");
    const bassNote = xml.indexOf("<octave>3</octave>");
    expect(backupIndex).toBeLessThan(bassNote);
  });

  it("fills an empty staff in a non-empty measure with a measure rest", () => {
    // Treble plays measures 0 and 1; bass plays only measure 0.
    const xml = buildScore([
      system(
        staff([note("C5", 0), note("D5", 1)], TREBLE),
        staff([note("C3", 0)], BASS),
      ),
    ]);
    // Measure 2 (index 1): bass staff gets a whole-measure rest on staff 2.
    const secondMeasure = xml.slice(xml.indexOf('measure number="2"'));
    expect(secondMeasure).toContain('<rest measure="yes"/>');
    expect(secondMeasure).toContain("<staff>2</staff>");
  });

  it("runs grand-staff systems sequentially across the part", () => {
    const xml = buildScore([
      system(staff([note("C5", 0)], TREBLE), staff([note("C3", 0)], BASS)),
      system(staff([note("E5", 0)], TREBLE), staff([note("E3", 0)], BASS)),
    ]);
    // Two systems of one measure each → two measures total.
    expect(xml).toContain('measure number="1"');
    expect(xml).toContain('measure number="2"');
    expect(xml).not.toContain('measure number="3"');
  });

  it("derives the shared meter from the top staff for backups", () => {
    // 3/4: an empty bass measure rest spans three quarters = 12 divisions.
    const treble: ScoreAttributes = {
      clef: { sign: "G", line: 2 },
      time: { beats: 3, beatType: 4 },
    };
    const xml = buildScore([
      system(staff([], treble), staff([], BASS)),
    ]);
    expect(xml).toContain("<beats>3</beats>");
    expect(xml).toContain("<duration>12</duration>");
  });

  it("ties within a staff across measures, independently per staff", () => {
    const xml = buildScore([
      system(
        staff(
          [
            note("C5", 0, { slurStart: true }),
            note("C5", 1, { slurStop: true }),
          ],
          TREBLE,
        ),
        // The bass has an unrelated same-pitch pair with no slur tokens — must
        // stay untied, proving the two staves' spans don't cross-pollinate.
        staff([note("C3", 0), note("C3", 1)], BASS),
      ),
    ]);
    expect((xml.match(/<tie /g) ?? []).length).toBe(2);
    const bassBlock = xml.slice(xml.indexOf("<octave>3</octave>") - 40);
    expect(bassBlock.split("</note>")[0]).not.toContain("<tie ");
  });

  it("splits one staff's unequal-duration chord into two voices, part-unique", () => {
    // Treble holds an E5+G5 whole chord over a moving C5 D5 E5 F5 line (TrOMR's
    // flattened form); the bass is a plain single-voice quarter run.
    const heldWhole = (pitch: string, extra: Partial<NoteEvent> = {}): NoteEvent =>
      note(pitch, 0, { duration: "whole", ...extra });
    const xml = buildScore([
      system(
        staff(
          [
            heldWhole("E5"),
            heldWhole("G5", { chord: true }),
            note("C5", 0, { chord: true }),
            note("D5", 0),
            note("E5", 0),
            note("F5", 0),
          ],
          TREBLE,
        ),
        staff([note("C3"), note("E3", 0), note("G3", 0)], BASS),
      ),
    ]);
    const measure = xml.slice(
      xml.indexOf('measure number="1"'),
      xml.indexOf("</measure>"),
    );
    // Treble's split-off voice is part-unique (staffCount 2 + staff 1 = voice 3);
    // bass keeps voice 2. All three voices are present on their own staves.
    expect(measure).toContain("<voice>1</voice>"); // treble moving line
    expect(measure).toContain("<voice>3</voice>"); // treble held chord
    expect(measure).toContain("<voice>2</voice>"); // bass
    // The held whole-note chord stays on staff 1 (not moved to a new staff).
    const heldBlock = measure.slice(measure.indexOf("<voice>3</voice>") - 200);
    expect(heldBlock).toContain("<staff>1</staff>");
    // Two backups: one within the treble (between its voices), one to the bass.
    expect((measure.match(/<backup>/g) ?? []).length).toBe(2);
  });

  it("leaves a plain grand staff byte-identical (no voice split)", () => {
    // A grand staff with only equal-duration content must be unchanged by the
    // voice-inference pass: staff 1 = voice 1, staff 2 = voice 2, one backup.
    const xml = buildScore([
      system(
        staff([note("C5"), note("E5", 0, { chord: true })], TREBLE),
        staff([note("C3")], BASS),
      ),
    ]);
    expect(xml).not.toContain("<voice>3</voice>");
    expect((xml.match(/<backup>/g) ?? []).length).toBe(1);
  });
});

describe("buildScore — three-stave piano", () => {
  it("emits three staves with each recovered clef", () => {
    const xml = buildScore([
      system(
        staff([note("E5")], TREBLE),
        staff([note("C4")], TREBLE),
        staff([note("C3")], BASS),
      ),
    ]);
    expect(xml).toContain("<staves>3</staves>");
    expect(xml).toContain(
      '<clef number="1"><sign>G</sign><line>2</line></clef>',
    );
    expect(xml).toContain(
      '<clef number="2"><sign>G</sign><line>2</line></clef>',
    );
    expect(xml).toContain(
      '<clef number="3"><sign>F</sign><line>4</line></clef>',
    );
  });

  it("throws rather than guess when a staff's clef was not recovered", () => {
    // The middle staff recovered no clef — refuse to build instead of defaulting.
    expect(() =>
      buildScore([
        system(staff([note("E5")], TREBLE), staff([note("C4")]), staff([note("C3")], BASS)),
      ]),
    ).toThrow(/clef/i);
  });
});

describe("buildScore — onNoteEmitted", () => {
  type Emitted = [string, number, number]; // pitch, measureIndex, noteElementIndex

  function collect(systems: ScoreSystem[]): Emitted[] {
    const emitted: Emitted[] = [];
    buildScore(systems, {
      onNoteEmitted: (note, measureIndex, noteElementIndex) => {
        emitted.push([note.pitch, measureIndex, noteElementIndex]);
      },
    });
    return emitted;
  }

  it("reports single-staff notes with per-measure element indices", () => {
    const emitted = collect([
      system(staff([note("C4", 0), note("D4", 0), note("E4", 1)], TREBLE)),
      system(staff([note("F4", 0)], TREBLE)),
    ]);
    expect(emitted).toEqual([
      ["C4", 0, 0],
      ["D4", 0, 1],
      ["E4", 1, 0],
      // The second system's measure 0 lands at global measure 2.
      ["F4", 2, 0],
    ]);
  });

  it("offsets the lower staff's indices past the upper staff's notes", () => {
    const emitted = collect([
      system(
        staff([note("C5", 0), note("D5", 0)], TREBLE),
        staff([note("C3", 0)], BASS),
      ),
    ]);
    // The bass note is the measure's third <note> element (after both treble
    // notes), matching the editor's document-order noteElementIndex.
    expect(emitted).toEqual([
      ["C5", 0, 0],
      ["D5", 0, 1],
      ["C3", 0, 2],
    ]);
  });

  it("counts a synthesized whole-measure rest as a note element", () => {
    const emitted = collect([
      system(
        // Treble is empty in measure 0 (its first note is in measure 1), so the
        // builder synthesizes a whole-measure rest there — a <note> element that
        // shifts the bass note to index 1.
        staff([note("C5", 1)], TREBLE),
        staff([note("C3", 0), note("D3", 1)], BASS),
      ),
    ]);
    expect(emitted).toEqual([
      ["C3", 0, 1],
      ["C5", 1, 0],
      ["D3", 1, 1],
    ]);
  });
});
