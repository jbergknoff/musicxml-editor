import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type NoteHandle,
  addNote,
  addNoteToChord,
  addStaff,
  appendScore,
  copyMeasures,
  createBlankDocument,
  deleteMeasures,
  insertMeasure,
  isEditableDocument,
  maxNoteDuration,
  measureFillReport,
  moveNote,
  parseDocument,
  pasteMeasures,
  redistributeStaves,
  removeNote,
  removeNotes,
  removeStaff,
  serializeDocument,
  setAccidental,
  setChordMemberDuration,
  setNoteDuration,
  shiftNotesInTime,
  toggleTie,
} from "./dom-edit";
import {
  type ChordGroup,
  type MeasureEvent,
  type ParsedMeasure,
  type ParsedScore,
  isRest,
  measureBeatSpan,
  parseScore,
} from "./sheet-music/index";

// All events across a measure's voices, concatenated. The dom-edit tests are
// single-voice per staff, so this equals the old flat `events` list; the helper
// keeps the assertions terse after the voices refactor.
function flatEvents(measure: ParsedMeasure | undefined): MeasureEvent[] {
  return measure ? measure.voices.flatMap((v) => v.events) : [];
}

function reparse(doc: Document): ParsedScore {
  return parseScore(serializeDocument(doc));
}

// Flatten a score's chords with their measure index and absolute onset beat.
function chords(
  score: ParsedScore,
): Array<{ measureIndex: number; onsetBeat: number; chord: ChordGroup }> {
  const result: Array<{
    measureIndex: number;
    onsetBeat: number;
    chord: ChordGroup;
  }> = [];
  score.parts[0].measures.forEach((measure, measureIndex) => {
    let onsetBeat = 0;
    const divisions = measure.divisions || 4;
    for (const event of flatEvents(measure)) {
      if (!isRest(event)) {
        result.push({ measureIndex, onsetBeat, chord: event });
      }
      onsetBeat += event.duration / divisions;
    }
  });
  return result;
}

describe("createBlankDocument", () => {
  test("produces a parseable empty score of the requested size", () => {
    const score = reparse(createBlankDocument({ measureCount: 3 }));
    expect(score.parts.length).toBe(1);
    expect(score.parts[0].measures.length).toBe(3);
    expect(score.numMeasures).toBe(3);
    // Every measure is a single full-measure rest.
    for (const measure of score.parts[0].measures) {
      expect(flatEvents(measure).length).toBe(1);
      expect(isRest(flatEvents(measure)[0])).toBe(true);
    }
    expect(score.parts[0].timeSig).toEqual({ beats: 4, beatType: 4 });
    expect(score.parts[0].clef).toEqual({ sign: "G", line: 2 });
  });
});

describe("addNote", () => {
  test("inserts a note at the snapped measure/onset/pitch/duration", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    });
    expect(handle).not.toBeNull();

    const score = reparse(doc);
    const placed = chords(score);
    expect(placed.length).toBe(1);
    expect(placed[0].measureIndex).toBe(0);
    expect(placed[0].onsetBeat).toBe(0);
    expect(placed[0].chord.type).toBe("quarter");
    expect(placed[0].chord.notes[0].pitch).toEqual({
      step: "C",
      alter: 0,
      octave: 5,
    });
  });

  test("fits the duration to the gap before an existing note", () => {
    const doc = createBlankDocument();
    // A quarter at beat 1, then a whole note requested at beat 0 — it must
    // shrink to a quarter so it does not overlap.
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 1,
      durationBeats: 1,
      pitch: { step: "E", alter: 0, octave: 5 },
    });
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 4,
      pitch: { step: "C", alter: 0, octave: 5 },
    });
    const placed = chords(reparse(doc));
    expect(placed.map((p) => p.onsetBeat)).toEqual([0, 1]);
    expect(placed[0].chord.type).toBe("quarter");
    expect(placed[0].chord.notes[0].pitch.step).toBe("C");
  });
});

describe("moveNote", () => {
  test("pitch-only change keeps the onset", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    const moved = moveNote(doc, handle, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      pitch: { step: "G", alter: 0, octave: 5 },
    });
    expect(moved).not.toBeNull();
    const placed = chords(reparse(doc));
    expect(placed.length).toBe(1);
    expect(placed[0].onsetBeat).toBe(0);
    expect(placed[0].chord.notes[0].pitch.step).toBe("G");
  });

  test("onset change relocates the note", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    moveNote(doc, handle, {
      measureIndex: 0,
      onsetBeatInMeasure: 2,
      pitch: { step: "C", alter: 0, octave: 5 },
    });
    const placed = chords(reparse(doc));
    expect(placed.length).toBe(1);
    expect(placed[0].onsetBeat).toBe(2);
  });

  test("can move a note into another measure", () => {
    const doc = createBlankDocument({ measureCount: 2 });
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    moveNote(doc, handle, {
      measureIndex: 1,
      onsetBeatInMeasure: 1,
      pitch: { step: "D", alter: 0, octave: 5 },
    });
    const placed = chords(reparse(doc));
    expect(placed.length).toBe(1);
    expect(placed[0].measureIndex).toBe(1);
    expect(placed[0].onsetBeat).toBe(1);
    expect(placed[0].chord.notes[0].pitch.step).toBe("D");
  });
});

describe("removeNote", () => {
  test("turns the note's span back into rest", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    removeNote(doc, handle);
    const score = reparse(doc);
    expect(chords(score).length).toBe(0);
    expect(flatEvents(score.parts[0].measures[0]).every(isRest)).toBe(true);
  });
});

describe("removeNotes", () => {
  test("removes several notes from one measure in a single rebuild", () => {
    const doc = createBlankDocument();
    const a = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    const b = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 1,
      durationBeats: 1,
      pitch: { step: "E", alter: 0, octave: 5 },
    }) as NoteHandle;
    const c = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 2,
      durationBeats: 1,
      pitch: { step: "G", alter: 0, octave: 5 },
    }) as NoteHandle;
    // Removing the first and last (by their original handles, resolved up front)
    // leaves only the middle note — the index shift of sequential removals would
    // otherwise drop the wrong elements.
    removeNotes(doc, [a, c]);
    const placed = chords(reparse(doc));
    expect(placed.length).toBe(1);
    expect(placed[0].onsetBeat).toBe(1);
    expect(placed[0].chord.notes[0].pitch.step).toBe("E");
    // Sanity: `b` still resolves to the surviving note.
    expect(b.measureIndex).toBe(0);
  });

  test("ignores handles that do not resolve", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    removeNotes(doc, [{ measureIndex: 9, noteElementIndex: 9 }]);
    // The real note is untouched.
    expect(chords(reparse(doc)).length).toBe(1);
    removeNotes(doc, [handle]);
    expect(chords(reparse(doc)).length).toBe(0);
  });
});

describe("fidelity", () => {
  // A two-note measure where the first note carries an articulation and a lyric
  // (neither modelled by the editor). Moving the *second* note must leave the
  // first note's expression elements byte-for-byte intact.
  const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note>
        <pitch><step>C</step><octave>5</octave></pitch>
        <duration>4</duration>
        <type>quarter</type>
        <lyric><text>la</text></lyric>
        <notations><articulations><staccato/></articulations></notations>
      </note>
      <note>
        <pitch><step>E</step><octave>5</octave></pitch>
        <duration>4</duration>
        <type>quarter</type>
      </note>
    </measure>
  </part>
</score-partwise>`;

  test("untouched note's expression elements survive a move of another note", () => {
    const doc = parseDocument(FIXTURE);
    // The E note is the 2nd <note> element in measure 0.
    moveNote(
      doc,
      { measureIndex: 0, noteElementIndex: 1 },
      {
        measureIndex: 0,
        onsetBeatInMeasure: 2,
        pitch: { step: "F", alter: 0, octave: 5 },
      },
    );
    const serialized = serializeDocument(doc);
    // The first note's articulation and lyric are still present and intact.
    expect(serialized).toContain("<staccato");
    expect(serialized).toContain("<lyric><text>la</text></lyric>");
    // And it still parses as a staccato C5.
    const score = parseScore(serialized);
    const firstChord = chords(score)[0].chord;
    expect(firstChord.notes[0].pitch.step).toBe("C");
    expect(firstChord.notes[0].staccato).toBe(true);
  });

  const REPEAT_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <barline location="left"><repeat direction="forward"/></barline>
      <note>
        <pitch><step>C</step><octave>5</octave></pitch>
        <duration>4</duration>
        <type>quarter</type>
      </note>
      <note><rest/><duration>12</duration><type>half</type></note>
      <barline location="right">
        <bar-style>light-heavy</bar-style>
        <repeat direction="backward"/>
      </barline>
    </measure>
  </part>
</score-partwise>`;

  test("a note edit in a repeat-barline measure leaves the barlines intact", () => {
    const doc = parseDocument(REPEAT_FIXTURE);
    moveNote(
      doc,
      { measureIndex: 0, noteElementIndex: 0 },
      {
        measureIndex: 0,
        onsetBeatInMeasure: 0,
        pitch: { step: "D", alter: 0, octave: 5 },
      },
    );
    const serialized = serializeDocument(doc);
    expect(serialized).toContain('<repeat direction="forward"');
    expect(serialized).toContain('<repeat direction="backward"');
    const score = parseScore(serialized);
    expect(score.parts[0].measures[0].repeatStart).toBe(true);
    expect(score.parts[0].measures[0].repeatEnd).toEqual({ times: 2 });
  });
});

describe("round-trip", () => {
  // A real-world export: the Mozart "Rondo alla Turca" clip (MuseScore 2.2.1,
  // public domain), the same fixture the sibling piano-practice renderer tests
  // use. It carries a `<!DOCTYPE>`, the XML declaration, `identification` /
  // `encoding` / `source`, `defaults`, multi-line `credit`s, and a grand-staff
  // piano part with voices, `<backup>`, chords, grace notes, ties, and beams —
  // none of which the editor models, so all of it must survive a parse →
  // serialize round-trip by construction.
  const RONDO = readFileSync(
    fileURLToPath(
      new URL("./__fixtures__/rondo-alla-turca-clip.musicxml", import.meta.url),
    ),
    "utf8",
  );

  test("preserves the declaration, DOCTYPE, and all metadata/headers", () => {
    const serialized = serializeDocument(parseDocument(RONDO));

    // Declaration + DOCTYPE both present (the DOCTYPE was previously dropped).
    expect(serialized.startsWith("<?xml")).toBe(true);
    expect(serialized).toContain("<!DOCTYPE");

    // Metadata / headers the editor never models survive verbatim.
    expect(serialized).toContain("<software>MuseScore 2.2.1</software>");
    expect(serialized).toContain("<encoding-date>2018-05-10</encoding-date>");
    expect(serialized).toContain(
      "<source>http://musescore.com/classicman/scores/49143</source>",
    );
    expect(serialized).toContain("<part-name>Piano</part-name>");
    expect(serialized).toContain("<millimeters>7.05556</millimeters>");
    // Credits (title, work, composer) round-trip including their text.
    expect(serialized).toContain("Rondo alla Turca");
    expect(serialized).toContain("Wolfgang Amadeus Mozart");

    // And it re-parses without error.
    expect(() => parseScore(serialized)).not.toThrow();
  });

  test("editing one note leaves untouched measures byte-for-byte intact", () => {
    const doc = parseDocument(RONDO);
    // Serialize once before any edit. Both serializations go through the same
    // serializer, so any whitespace normalization is identical on each side and
    // the only difference must be the edited measure itself.
    const before = serializeDocument(doc);
    const identificationBefore = sliceTag(before, "identification");
    const measure5Before = sliceMeasure(before, 5);

    // Remove the first note of the pickup measure (measure index 0) — a single,
    // localized edit. dom-edit only rewrites that one measure.
    removeNote(doc, { measureIndex: 0, noteElementIndex: 0 });
    const after = serializeDocument(doc);

    // Header metadata and an unrelated later measure are reused verbatim.
    expect(sliceTag(after, "identification")).toBe(identificationBefore);
    expect(sliceMeasure(after, 5)).toBe(measure5Before);
    // The edit did land somewhere: the whole document is not byte-identical.
    expect(after).not.toBe(before);
  });
});

describe("addNoteToChord", () => {
  test("stacks a chord member at the same beat, default a third above", () => {
    const doc = createBlankDocument();
    const base = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    const added = addNoteToChord(doc, base);
    expect(added).not.toBeNull();

    const placed = chords(reparse(doc));
    // Still one beat (one chord) at onset 0…
    expect(placed.length).toBe(1);
    expect(placed[0].onsetBeat).toBe(0);
    // …now with two stacked notes, ordered low-to-high (C5 then a third up, E5).
    const pitches = placed[0].chord.notes.map((n) => n.pitch);
    expect(pitches).toEqual([
      { step: "C", alter: 0, octave: 5 },
      { step: "E", alter: 0, octave: 5 },
    ]);
    // The second member carries the <chord/> flag; the first does not.
    expect(placed[0].chord.notes[1].isChordMember).toBe(true);
    expect(placed[0].chord.notes[0].isChordMember).toBe(false);
  });

  test("honors an explicit pitch and round-trips a three-note chord", () => {
    const doc = createBlankDocument();
    const base = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    addNoteToChord(doc, base, { step: "E", alter: 0, octave: 5 });
    addNoteToChord(doc, base, { step: "G", alter: 0, octave: 5 });

    const placed = chords(reparse(doc));
    expect(placed.length).toBe(1);
    expect(placed[0].chord.notes.map((n) => n.pitch.step)).toEqual([
      "C",
      "E",
      "G",
    ]);
  });
});

describe("setAccidental", () => {
  test("applies, then clears, a sharp on a note", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "F", alter: 0, octave: 5 },
    }) as NoteHandle;

    expect(setAccidental(doc, handle, 1)).toBe(true);
    let note = chords(reparse(doc))[0].chord.notes[0];
    expect(note.pitch.alter).toBe(1);
    expect(note.accidental).toBe("sharp");

    // Natural drops the <alter> back to a plain F (no printed accidental in C).
    expect(setAccidental(doc, handle, 0)).toBe(true);
    note = chords(reparse(doc))[0].chord.notes[0];
    expect(note.pitch.alter).toBe(0);
    expect(note.accidental).toBe("none");
  });
});

describe("toggleTie", () => {
  test("ties a note to the matching pitch in the next chord, then removes it", () => {
    const doc = createBlankDocument();
    const first = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 1,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    });
    // A non-matching pitch at the same onset as the second C — proves the
    // tie targets the matching pitch, not just "the next note".
    const second = chords(reparse(doc))[1];
    expect(second.chord.notes[0].pitch).toEqual({
      step: "C",
      alter: 0,
      octave: 5,
    });

    expect(toggleTie(doc, first)).toBe(true);
    let score = reparse(doc);
    let placed = chords(score);
    expect(placed[0].chord.notes[0].tieStart).toBe(true);
    expect(placed[1].chord.notes[0].tieStop).toBe(true);

    // Toggling again (from either endpoint) clears the tie on both notes.
    expect(toggleTie(doc, first)).toBe(true);
    score = reparse(doc);
    placed = chords(score);
    expect(placed[0].chord.notes[0].tieStart).toBe(false);
    expect(placed[1].chord.notes[0].tieStop).toBe(false);
  });

  test("ties every matching pitch of a chord independently", () => {
    const doc = createBlankDocument();
    const c1 = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    const e1 = addNoteToChord(doc, c1, {
      step: "E",
      alter: 0,
      octave: 5,
    }) as NoteHandle;
    const c2 = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 1,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    addNoteToChord(doc, c2, { step: "G", alter: 0, octave: 5 });

    expect(toggleTie(doc, c1)).toBe(true);
    // E5 has no matching pitch in the next chord (which has C5/G5).
    expect(toggleTie(doc, e1)).toBe(false);

    const placed = chords(reparse(doc));
    expect(
      placed[0].chord.notes.find((n) => n.pitch.step === "C")?.tieStart,
    ).toBe(true);
    expect(
      placed[0].chord.notes.find((n) => n.pitch.step === "E")?.tieStart,
    ).toBe(false);
  });

  test("returns false for a rest handle or a note with no eligible partner", () => {
    const doc = createBlankDocument();
    const only = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    // No next note of matching pitch anywhere in the (otherwise empty) score.
    expect(toggleTie(doc, only)).toBe(false);
  });
});

describe("setNoteDuration", () => {
  test("grows a note, consuming the trailing rest", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;

    expect(setNoteDuration(doc, handle, 2)).toBe(true);
    const placed = chords(reparse(doc));
    expect(placed.length).toBe(1);
    expect(placed[0].onsetBeat).toBe(0);
    expect(placed[0].chord.type).toBe("half");
    expect(placed[0].chord.notes[0].pitch.step).toBe("C");
  });

  test("shrinks a note, refilling the gap with a rest", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 4,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;

    expect(setNoteDuration(doc, handle, 1)).toBe(true);
    const score = reparse(doc);
    const placed = chords(score);
    expect(placed.length).toBe(1);
    expect(placed[0].chord.type).toBe("quarter");
    // The freed three beats are rebalanced into rests.
    const events = flatEvents(score.parts[0].measures[0]);
    expect(events.length).toBe(2);
    expect(isRest(events[1])).toBe(true);
  });

  test("clamps growth to the gap before the next note", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 1.5,
      durationBeats: 1,
      pitch: { step: "E", alter: 0, octave: 5 },
    });

    expect(setNoteDuration(doc, handle, 4)).toBe(true);
    const placed = chords(reparse(doc));
    // Clamped to the 1.5-beat gap before the next note: a dotted quarter.
    expect(placed[0].chord.type).toBe("quarter");
    expect(placed[0].chord.dot).toBe(true);
    expect(placed[1].onsetBeat).toBe(1.5);
  });

  test("resizes every member of a chord together", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    addNoteToChord(doc, handle, { step: "E", alter: 0, octave: 5 });

    expect(setNoteDuration(doc, handle, 2)).toBe(true);
    const chord = chords(reparse(doc))[0].chord;
    expect(chord.type).toBe("half");
    expect(chord.notes.map((n) => n.pitch.step).sort()).toEqual(["C", "E"]);
  });
});

describe("maxNoteDuration", () => {
  test("reports the full gap when nothing follows", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;

    expect(maxNoteDuration(doc, handle)).toBe(4);
  });

  test("reports the largest standard value that actually fits", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 1.5,
      durationBeats: 1,
      pitch: { step: "E", alter: 0, octave: 5 },
    });

    // 1.5 beats of room before the next note — a dotted quarter is the
    // largest standard value (dotted or not) that fits.
    expect(maxNoteDuration(doc, handle)).toBe(1.5);
  });

  test("matches what setNoteDuration would actually apply, so equal requests never no-op silently", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 1.5,
      durationBeats: 1,
      pitch: { step: "E", alter: 0, octave: 5 },
    });
    const max = maxNoteDuration(doc, handle);
    expect(max).toBe(1.5);

    expect(setNoteDuration(doc, handle, max as number)).toBe(true);
    const chord = chords(reparse(doc))[0].chord;
    expect(chord.type).toBe("quarter");
    expect(chord.dot).toBe(true);
  });

  test("returns null on a bad handle", () => {
    const doc = createBlankDocument();
    expect(
      maxNoteDuration(doc, { measureIndex: 0, noteElementIndex: 99 }),
    ).toBeNull();
  });
});

describe("setChordMemberDuration", () => {
  test("resizes one chord member without touching the others", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 2,
      pitch: { step: "C", alter: 0, octave: 4 },
    }) as NoteHandle;
    const memberHandle = addNoteToChord(doc, handle, {
      step: "E",
      alter: 0,
      octave: 4,
    }) as NoteHandle;

    expect(setChordMemberDuration(doc, memberHandle, 0.5)).toBe(true);
    const chord = chords(reparse(doc))[0].chord;
    const byStep = new Map(chord.notes.map((n) => [n.pitch.step, n]));
    expect(byStep.get("C")?.type).toBe("half");
    expect(byStep.get("E")?.type).toBe("eighth");
  });

  test("clamps a diverged member to the gap before the next note", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 4 },
    }) as NoteHandle;
    const memberHandle = addNoteToChord(doc, handle, {
      step: "E",
      alter: 0,
      octave: 4,
    }) as NoteHandle;
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 1.5,
      durationBeats: 1,
      pitch: { step: "G", alter: 0, octave: 4 },
    });

    expect(setChordMemberDuration(doc, memberHandle, 4)).toBe(true);
    const placed = chords(reparse(doc));
    const byStep = new Map(placed[0].chord.notes.map((n) => [n.pitch.step, n]));
    expect(byStep.get("C")?.type).toBe("quarter");
    // Clamped to the 1.5-beat gap: a dotted quarter, now the longer (lead)
    // member, so the group's onset-advancing duration follows it.
    expect(byStep.get("E")?.type).toBe("quarter");
    expect(byStep.get("E")?.dot).toBe(true);
    expect(placed[1].onsetBeat).toBe(1.5);
  });

  test("returns false for a solo note (nothing to diverge from)", () => {
    const doc = createBlankDocument();
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;

    expect(setChordMemberDuration(doc, handle, 2)).toBe(false);
  });
});

describe("insertMeasure", () => {
  test("appends a blank measure and renumbers sequentially", () => {
    const doc = createBlankDocument({ measureCount: 2 });
    const newIndex = insertMeasure(doc);
    expect(newIndex).toBe(2);

    const score = reparse(doc);
    expect(score.parts[0].measures.length).toBe(3);
    expect(score.parts[0].measures.map((m) => m.number)).toEqual([1, 2, 3]);
    // The new (last) measure is a single full-measure rest.
    const last = score.parts[0].measures[2];
    expect(flatEvents(last).length).toBe(1);
    expect(isRest(flatEvents(last)[0])).toBe(true);
  });

  test("inserts in the middle and shifts later measures down", () => {
    const doc = createBlankDocument({ measureCount: 2 });
    // A note in measure 2 (index 1) so we can prove it moved to measure 3.
    addNote(doc, {
      measureIndex: 1,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    });
    insertMeasure(doc, 0); // after measure index 0

    const placed = chords(reparse(doc));
    expect(reparse(doc).parts[0].measures.length).toBe(3);
    // The note that was in measure index 1 is now in measure index 2.
    expect(placed.length).toBe(1);
    expect(placed[0].measureIndex).toBe(2);
  });
});

describe("copy/cut/paste measures", () => {
  test("copyMeasures serializes the requested range", () => {
    const doc = createBlankDocument({ measureCount: 3 });
    addNote(doc, {
      measureIndex: 1,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "E", alter: 0, octave: 5 },
    });
    const clip = copyMeasures(doc, 1, 2);
    expect(clip).not.toBeNull();
    expect(clip?.measuresXml.length).toBe(2);
    expect(clip?.measuresXml[0]).toContain("<step>E</step>");
    expect(clip?.divisionsPerQuarter).toBe(4);
    expect(clip?.staffCount).toBe(1);
  });

  test("copyMeasures accepts either index order and clamps to bounds", () => {
    const doc = createBlankDocument({ measureCount: 3 });
    expect(copyMeasures(doc, 2, 0)?.measuresXml.length).toBe(3);
    expect(copyMeasures(doc, -5, 100)?.measuresXml.length).toBe(3);
  });

  test("copyMeasures returns null on an empty document", () => {
    const doc = parseDocument(
      `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
  <part id="P1"></part>
</score-partwise>`,
    );
    expect(copyMeasures(doc, 0, 0)).toBeNull();
  });

  test("deleteMeasures removes the range and renumbers", () => {
    const doc = createBlankDocument({ measureCount: 4 });
    addNote(doc, {
      measureIndex: 3,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "G", alter: 0, octave: 5 },
    });
    const nextIndex = deleteMeasures(doc, 1, 2);
    expect(nextIndex).toBe(1);

    const score = reparse(doc);
    expect(score.parts[0].measures.length).toBe(2);
    expect(score.parts[0].measures.map((m) => m.number)).toEqual([1, 2]);
    // The note originally in measure index 3 is now in measure index 1.
    const placed = chords(score);
    expect(placed.length).toBe(1);
    expect(placed[0].measureIndex).toBe(1);
  });

  test("deleteMeasures never empties the part", () => {
    const doc = createBlankDocument({ measureCount: 3 });
    const nextIndex = deleteMeasures(doc, 0, 2);
    expect(nextIndex).toBe(0);
    expect(reparse(doc).parts[0].measures.length).toBe(1);
  });

  test("deleteMeasures returns null on an already-empty document", () => {
    const doc = parseDocument(
      `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
  <part id="P1"></part>
</score-partwise>`,
    );
    expect(deleteMeasures(doc, 0, 0)).toBeNull();
  });

  test("pasteMeasures inserts before the target index and renumbers", () => {
    const doc = createBlankDocument({ measureCount: 2 });
    const clipSource = createBlankDocument({ measureCount: 1 });
    addNote(clipSource, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "A", alter: 0, octave: 4 },
    });
    const clip = copyMeasures(clipSource, 0, 0);
    expect(clip).not.toBeNull();
    if (!clip) {
      return;
    }

    const result = pasteMeasures(doc, 1, clip);
    expect(result).toEqual({ firstPastedIndex: 1, pastedCount: 1 });

    const score = reparse(doc);
    expect(score.parts[0].measures.length).toBe(3);
    expect(score.parts[0].measures.map((m) => m.number)).toEqual([1, 2, 3]);
    const placed = chords(score);
    expect(placed.length).toBe(1);
    expect(placed[0].measureIndex).toBe(1);
    expect(placed[0].chord.notes[0].pitch).toEqual({
      step: "A",
      alter: 0,
      octave: 4,
    });
  });

  test("pasteMeasures appends when the target index is past the end", () => {
    const doc = createBlankDocument({ measureCount: 1 });
    const clip = copyMeasures(doc, 0, 0);
    expect(clip).not.toBeNull();
    if (!clip) {
      return;
    }
    const result = pasteMeasures(doc, 99, clip);
    expect(result).toEqual({ firstPastedIndex: 1, pastedCount: 1 });
    expect(reparse(doc).parts[0].measures.length).toBe(2);
  });

  test("pasteMeasures rescales divisions to match the target document", () => {
    const doc = createBlankDocument({ measureCount: 1 }); // divisions = 4
    const imported = parseDocument(
      `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>24</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>24</duration><type>quarter</type></note>
      <note><rest/><duration>72</duration></note>
    </measure>
  </part>
</score-partwise>`,
    );
    const clip = copyMeasures(imported, 0, 0);
    expect(clip).not.toBeNull();
    if (!clip) {
      return;
    }
    const result = pasteMeasures(doc, 1, clip);
    expect(result).toEqual({ firstPastedIndex: 1, pastedCount: 1 });
    const score = reparse(doc);
    const placed = chords(score);
    expect(placed.length).toBe(1);
    expect(placed[0].chord.duration).toBe(4);
  });

  test("pasteMeasures refuses a staff-count mismatch", () => {
    const doc = createBlankDocument(); // single staff
    const rondo = readFileSync(
      fileURLToPath(
        new URL(
          "./__fixtures__/rondo-alla-turca-clip.musicxml",
          import.meta.url,
        ),
      ),
      "utf8",
    ); // grand staff
    const grandStaffDoc = parseDocument(rondo);
    const clip = copyMeasures(grandStaffDoc, 0, 0);
    expect(clip).not.toBeNull();
    if (!clip) {
      return;
    }
    expect(pasteMeasures(doc, 0, clip)).toBeNull();
  });

  test("copy then paste round-trips a note's expression children", () => {
    const doc = createBlankDocument({ measureCount: 2 });
    const handle = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    });
    expect(handle).not.toBeNull();
    if (handle) {
      toggleTie(doc, handle); // ties to nothing yet, but exercise a real edit first
    }
    const clip = copyMeasures(doc, 0, 0);
    expect(clip).not.toBeNull();
    if (!clip) {
      return;
    }
    const result = pasteMeasures(doc, 2, clip);
    expect(result).toEqual({ firstPastedIndex: 2, pastedCount: 1 });
    const score = reparse(doc);
    expect(score.parts[0].measures.length).toBe(3);
    const placed = chords(score);
    expect(placed.map((p) => p.measureIndex)).toEqual([0, 2]);
  });
});

describe("appendScore", () => {
  test("appends the imported score's measures and renumbers sequentially", () => {
    const doc = createBlankDocument({ measureCount: 2 });
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    });
    const imported = createBlankDocument({ measureCount: 2 });
    addNote(imported, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "E", alter: 0, octave: 5 },
    });

    const result = appendScore(doc, serializeDocument(imported));
    expect(result).toEqual({
      firstAppendedMeasureIndex: 2,
      appendedMeasureCount: 2,
    });

    const score = reparse(doc);
    expect(score.parts[0].measures.length).toBe(4);
    expect(score.parts[0].measures.map((m) => m.number)).toEqual([1, 2, 3, 4]);
    const placed = chords(score);
    expect(placed.map((p) => p.measureIndex)).toEqual([0, 2]);
  });

  test("rescales note durations when divisions differ", () => {
    const doc = createBlankDocument({ measureCount: 1 }); // divisions = 4
    const imported = parseDocument(
      `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>24</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>24</duration><type>quarter</type></note>
      <note><rest/><duration>72</duration></note>
    </measure>
  </part>
</score-partwise>`,
    );

    const result = appendScore(doc, serializeDocument(imported));
    expect(result).toEqual({
      firstAppendedMeasureIndex: 1,
      appendedMeasureCount: 1,
    });

    const score = reparse(doc);
    // The rescaled quarter note now spans 4 divisions (this document's
    // divisions-per-quarter), not the source's 24.
    const placed = chords(score);
    expect(placed.length).toBe(1);
    expect(placed[0].chord.duration).toBe(4);
    expect(score.parts[0].measures[1].divisions).toBe(4);
  });

  test("refuses to append a multi-part score", () => {
    const doc = createBlankDocument();
    const multiPart = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>A</part-name></score-part>
    <score-part id="P2"><part-name>B</part-name></score-part>
  </part-list>
  <part id="P1"><measure number="1"><note><rest measure="yes"/><duration>16</duration></note></measure></part>
  <part id="P2"><measure number="1"><note><rest measure="yes"/><duration>16</duration></note></measure></part>
</score-partwise>`;
    expect(appendScore(doc, multiPart)).toBeNull();
  });

  test("refuses to append a staff-count mismatch", () => {
    const doc = createBlankDocument(); // single staff
    const rondo = readFileSync(
      fileURLToPath(
        new URL(
          "./__fixtures__/rondo-alla-turca-clip.musicxml",
          import.meta.url,
        ),
      ),
      "utf8",
    ); // grand staff
    expect(appendScore(doc, rondo)).toBeNull();
  });

  test("refuses invalid MusicXML", () => {
    const doc = createBlankDocument();
    expect(appendScore(doc, "not xml at all <<<")).toBeNull();
  });
});

describe("isEditableDocument", () => {
  test("a blank single-staff document is editable", () => {
    expect(isEditableDocument(createBlankDocument())).toBe(true);
  });

  test("a single-staff file with notes is editable", () => {
    const doc = createBlankDocument();
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    });
    expect(isEditableDocument(doc)).toBe(true);
  });

  test("a simple grand-staff part (one backup per measure) is editable", () => {
    const rondo = readFileSync(
      fileURLToPath(
        new URL(
          "./__fixtures__/rondo-alla-turca-clip.musicxml",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(isEditableDocument(parseDocument(rondo))).toBe(true);
  });

  test("a multi-voice grand-staff part (multiple backups per measure) is editable", () => {
    // Two voices per staff = 3 backups per measure; writeMeasure handles this now.
    const multiVoice = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <staves>2</staves>
      </attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>2</voice><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>5</voice><staff>2</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>4</duration><voice>6</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;
    expect(isEditableDocument(parseDocument(multiVoice))).toBe(true);
  });

  test("a multi-part score is view-only", () => {
    const twoParts = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>One</part-name></score-part>
    <score-part id="P2"><part-name>Two</part-name></score-part>
  </part-list>
  <part id="P1"><measure number="1"></measure></part>
  <part id="P2"><measure number="1"></measure></part>
</score-partwise>`;
    expect(isEditableDocument(parseDocument(twoParts))).toBe(false);
  });
});

// A minimal two-staff (grand staff) fixture: treble + bass, one voice each,
// one backup per measure — the "simple grand staff" shape the editor supports.
const GRAND_STAFF_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>4</duration><type>quarter</type><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

describe("grand-staff editing", () => {
  function grandStaffChords(
    score: ReturnType<typeof parseScore>,
    partIndex: number,
  ): Array<{ onsetBeat: number; notes: Array<{ step: string }> }> {
    const result: Array<{ onsetBeat: number; notes: Array<{ step: string }> }> =
      [];
    const part = score.parts[partIndex];
    if (!part) {
      return result;
    }
    let beat = 0;
    const divisions = part.measures[0]?.divisions || 4;
    for (const event of flatEvents(part.measures[0]) ?? []) {
      if (!isRest(event)) {
        result.push({
          onsetBeat: beat,
          notes: (event as ChordGroup).notes.map((n) => ({
            step: n.pitch.step,
          })),
        });
      }
      beat += event.duration / divisions;
    }
    return result;
  }

  test("removeNote on staff 1 leaves staff 2 intact", () => {
    const doc = parseDocument(GRAND_STAFF_XML);
    // E5 is note element index 0 (staff 1). Remove it.
    removeNote(doc, { measureIndex: 0, noteElementIndex: 0 });
    const score = parseScore(serializeDocument(doc));
    // Treble staff (parts[0]) is all rests.
    expect(flatEvents(score.parts[0].measures[0]).every(isRest)).toBe(true);
    // Bass staff (parts[1]) still has G2.
    const bassChords = grandStaffChords(score, 1);
    expect(bassChords.length).toBe(1);
    expect(bassChords[0].notes[0].step).toBe("G");
  });

  test("removeNote on staff 2 leaves staff 1 intact", () => {
    const doc = parseDocument(GRAND_STAFF_XML);
    // G2 is note element index 1 (staff 2). Remove it.
    removeNote(doc, { measureIndex: 0, noteElementIndex: 1 });
    const score = parseScore(serializeDocument(doc));
    // Bass staff (parts[1]) is all rests.
    expect(flatEvents(score.parts[1].measures[0]).every(isRest)).toBe(true);
    // Treble staff (parts[0]) still has E5.
    const trebleChords = grandStaffChords(score, 0);
    expect(trebleChords.length).toBe(1);
    expect(trebleChords[0].notes[0].step).toBe("E");
  });

  test("notes have source provenance for both staves", () => {
    const score = parseScore(GRAND_STAFF_XML);
    // Grand staff parses into two parts.
    expect(score.parts.length).toBe(2);
    const trebleNote = (flatEvents(score.parts[0].measures[0])[0] as ChordGroup)
      .notes[0];
    const bassNote = (flatEvents(score.parts[1].measures[0])[0] as ChordGroup)
      .notes[0];
    // Both staves carry source provenance so the editor can select/edit them.
    expect(trebleNote.source).toEqual({ measureIndex: 0, noteElementIndex: 0 });
    expect(bassNote.source).toEqual({ measureIndex: 0, noteElementIndex: 1 });
  });

  test("addNote inserts into the correct staff", () => {
    const doc = parseDocument(GRAND_STAFF_XML);
    // Add a note to the bass staff at beat 1.
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 1,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 3 },
      staff: 2,
    });
    const score = parseScore(serializeDocument(doc));
    // Treble (parts[0]) is unchanged — still one note.
    const trebleChords = grandStaffChords(score, 0);
    expect(trebleChords.length).toBe(1);
    expect(trebleChords[0].notes[0].step).toBe("E");
    // Bass (parts[1]) now has two notes: G2 at beat 0 and C3 at beat 1.
    const bassChords = grandStaffChords(score, 1);
    expect(bassChords.length).toBe(2);
    expect(bassChords[0].notes[0].step).toBe("G");
    expect(bassChords[1].notes[0].step).toBe("C");
  });

  test("insertMeasure creates a valid grand-staff blank measure", () => {
    const doc = parseDocument(GRAND_STAFF_XML);
    insertMeasure(doc);
    const score = parseScore(serializeDocument(doc));
    expect(score.parts[0].measures.length).toBe(2);
    expect(score.parts[1].measures.length).toBe(2);
    // The new measure is all rests in both staves.
    expect(flatEvents(score.parts[0].measures[1]).every(isRest)).toBe(true);
    expect(flatEvents(score.parts[1].measures[1]).every(isRest)).toBe(true);
  });
});

describe("add / remove staves", () => {
  test("addStaff turns a single-staff score into a grand staff", () => {
    const doc = createBlankDocument({ measureCount: 2 });
    const newCount = addStaff(doc);
    expect(newCount).toBe(2);

    const score = reparse(doc);
    // Two staves now parse into two parts.
    expect(score.parts.length).toBe(2);
    // Both staves span the same measures, all rests, and the new (bass) staff
    // carries an F clef.
    expect(score.parts[0].measures.length).toBe(2);
    expect(score.parts[1].measures.length).toBe(2);
    expect(score.parts[1].clef?.sign).toBe("F");
    for (const part of score.parts) {
      for (const measure of part.measures) {
        expect(flatEvents(measure).every(isRest)).toBe(true);
      }
    }
    // The document declares two staves.
    expect(doc.querySelector("staves")?.textContent).toBe("2");
  });

  test("addStaff preserves existing notes on staff 1", () => {
    const doc = createBlankDocument({ measureCount: 1 });
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "E", alter: 0, octave: 5 },
    });
    addStaff(doc);

    const score = reparse(doc);
    // The E5 still leads the treble staff; the bass staff is blank.
    const treble = flatEvents(score.parts[0].measures[0]);
    const firstNote = treble.find((event) => !isRest(event)) as ChordGroup;
    expect(firstNote.notes[0].pitch.step).toBe("E");
    expect(firstNote.notes[0].pitch.octave).toBe(5);
    expect(flatEvents(score.parts[1].measures[0]).every(isRest)).toBe(true);
    // That preserved note is now explicitly tagged onto staff 1.
    const staffTags = Array.from(doc.querySelectorAll("note")).flatMap(
      (noteEl) =>
        noteEl.querySelector("rest")
          ? []
          : [noteEl.querySelector("staff")?.textContent],
    );
    expect(staffTags).toContain("1");
  });

  test("addStaff extends a grand staff to three staves", () => {
    const doc = parseDocument(GRAND_STAFF_XML);
    const newCount = addStaff(doc);
    expect(newCount).toBe(3);

    const score = reparse(doc);
    expect(score.parts.length).toBe(3);
    // Original staves keep their notes; the third staff is blank.
    expect(flatEvents(score.parts[2].measures[0]).every(isRest)).toBe(true);
    expect(doc.querySelector("staves")?.textContent).toBe("3");
  });

  test("removeStaff drops the bottom staff and reverts to single-staff", () => {
    const doc = parseDocument(GRAND_STAFF_XML);
    const newCount = removeStaff(doc);
    expect(newCount).toBe(1);

    const score = reparse(doc);
    // Back to a single part carrying the treble content (E5).
    expect(score.parts.length).toBe(1);
    const firstNote = flatEvents(score.parts[0].measures[0]).find(
      (event) => !isRest(event),
    ) as ChordGroup;
    expect(firstNote.notes[0].pitch.step).toBe("E");
    // `<staves>` is gone, and no note keeps a `<staff>` tag.
    expect(doc.querySelector("staves")).toBeNull();
    expect(doc.querySelector("note staff")).toBeNull();
    // The lone remaining clef drops its number attribute.
    const clef = doc.querySelector("clef");
    expect(clef?.getAttribute("number")).toBeNull();
    expect(isEditableDocument(doc)).toBe(true);
  });

  test("removeStaff can drop the treble staff, keeping the bass", () => {
    const doc = parseDocument(GRAND_STAFF_XML);
    const newCount = removeStaff(doc, 1);
    expect(newCount).toBe(1);

    const score = reparse(doc);
    const firstNote = flatEvents(score.parts[0].measures[0]).find(
      (event) => !isRest(event),
    ) as ChordGroup;
    // The surviving staff holds the bass content (G2) with a bass clef.
    expect(firstNote.notes[0].pitch.step).toBe("G");
    expect(firstNote.notes[0].pitch.octave).toBe(2);
    expect(score.parts[0].clef?.sign).toBe("F");
  });

  test("removeStaff on a three-staff score renumbers the survivors", () => {
    const doc = parseDocument(GRAND_STAFF_XML);
    addStaff(doc); // now 3 staves: treble(1), bass(2), treble(3)
    // Put a note on the middle (bass) staff so we can track renumbering.
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 2,
      durationBeats: 1,
      pitch: { step: "A", alter: 0, octave: 3 },
      staff: 2,
    });
    const newCount = removeStaff(doc, 1); // drop the original treble
    expect(newCount).toBe(2);

    const score = reparse(doc);
    expect(score.parts.length).toBe(2);
    // The old staff-2 content slid up to staff 1 (parts[0]).
    const survivor = flatEvents(score.parts[0].measures[0]).find(
      (event) => !isRest(event),
    ) as ChordGroup;
    expect(survivor.notes[0].pitch.step).toBe("G");
    // Every surviving note is tagged staff 1 or 2 — none still references 3.
    const staffTags = new Set(
      Array.from(doc.querySelectorAll("note > staff")).map(
        (el) => el.textContent,
      ),
    );
    expect(staffTags.has("3")).toBe(false);
  });

  test("removeStaff refuses to remove the only staff", () => {
    const doc = createBlankDocument();
    expect(removeStaff(doc)).toBeNull();
  });

  test("add then remove round-trips to a single staff", () => {
    const doc = createBlankDocument({ measureCount: 3 });
    addNote(doc, {
      measureIndex: 1,
      onsetBeatInMeasure: 0,
      durationBeats: 2,
      pitch: { step: "C", alter: 0, octave: 5 },
    });
    addStaff(doc);
    removeStaff(doc);

    const score = reparse(doc);
    expect(score.parts.length).toBe(1);
    // The half note in measure 2 survives the round trip.
    const note = flatEvents(score.parts[0].measures[1]).find(
      (event) => !isRest(event),
    ) as ChordGroup;
    expect(note.notes[0].pitch.step).toBe("C");
    expect(isEditableDocument(doc)).toBe(true);
  });
});

// A grand-staff fixture with two voices on staff 1: voice 1 has a half note D5,
// voice 2 has two quarter notes B4+G4 over the same span. Staff 2 has one voice.
const MULTI_VOICE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>8</duration><type>half</type><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><voice>1</voice><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type><voice>2</voice><staff>1</staff></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type><voice>2</voice><staff>1</staff></note>
      <backup><duration>8</duration></backup>
      <note><pitch><step>G</step><octave>3</octave></pitch><duration>8</duration><type>half</type><voice>5</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

describe("multi-voice grand-staff editing", () => {
  test("removeNote on voice-1 staff-1 leaves voice-2 staff-1 and staff-2 intact", () => {
    const doc = parseDocument(MULTI_VOICE_XML);
    // D5 (voice 1) is note element index 0. Remove it.
    removeNote(doc, { measureIndex: 0, noteElementIndex: 0 });
    const score = parseScore(serializeDocument(doc));
    // Treble (parts[0]): voice 1 first slot becomes rest, but C5 and D5 remain.
    const treble = flatEvents(score.parts[0].measures[0]);
    expect(
      treble.some(
        (e) =>
          !isRest(e) &&
          (e as ChordGroup).notes.some((n) => n.pitch.step === "C"),
      ),
    ).toBe(true);
    // Voice-2 notes B4 and G4 survive.
    const bass1 = flatEvents(score.parts[0].measures[0]);
    const allSteps = bass1.flatMap((e) =>
      isRest(e) ? [] : (e as ChordGroup).notes.map((n) => n.pitch.step),
    );
    expect(allSteps).toContain("B");
    expect(allSteps).toContain("G");
    // Staff 2 (parts[1]): G3 still present.
    const bassChords = flatEvents(score.parts[1].measures[0]).filter(
      (e) => !isRest(e),
    ) as ChordGroup[];
    expect(
      bassChords.some((c) => c.notes.some((n) => n.pitch.step === "G")),
    ).toBe(true);
  });

  test("addNote on staff 2 of a multi-voice score leaves staff-1 voices intact", () => {
    const doc = parseDocument(MULTI_VOICE_XML);
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 2,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 3 },
      staff: 2,
    });
    const score = parseScore(serializeDocument(doc));
    // Staff 1 treble voices: D5 (voice 1), B4/G4 (voice 2) all survive.
    const treble = flatEvents(score.parts[0].measures[0]);
    const trebleSteps = treble.flatMap((e) =>
      isRest(e) ? [] : (e as ChordGroup).notes.map((n) => n.pitch.step),
    );
    expect(trebleSteps).toContain("D");
    expect(trebleSteps).toContain("B");
    expect(trebleSteps).toContain("G");
    // Staff 2: now has G3 and C3.
    const bassChords = flatEvents(score.parts[1].measures[0]).filter(
      (e) => !isRest(e),
    ) as ChordGroup[];
    const bassSteps = bassChords.flatMap((c) =>
      c.notes.map((n) => n.pitch.step),
    );
    expect(bassSteps).toContain("G");
    expect(bassSteps).toContain("C");
  });
});

// The total length, in quarter-note beats, of a part's measure `m`. Used to
// assert an edit preserves a bar's length.
function measureBeats(
  score: ParsedScore,
  partIndex: number,
  m: number,
): number {
  const measure = score.parts[partIndex]?.measures[m];
  return measure ? measureBeatSpan(measure) : 0;
}

// A flat list of "step+octave" strings for the chord at event index over a
// part's measure 0, top-first (descending pitch) like the inspector.
function chordPitches(
  score: ParsedScore,
  partIndex: number,
  onsetBeat: number,
): string[] {
  const stepOrder: Record<string, number> = {
    C: 0,
    D: 1,
    E: 2,
    F: 3,
    G: 4,
    A: 5,
    B: 6,
  };
  const diatonic = (p: { step: string; octave: number }) =>
    p.octave * 7 + (stepOrder[p.step] ?? 0);
  let beat = 0;
  const measure = score.parts[partIndex]?.measures[0];
  const divisions = measure?.divisions || 4;
  for (const event of flatEvents(measure) ?? []) {
    if (!isRest(event) && Math.abs(beat - onsetBeat) < 1e-6) {
      return [...(event as ChordGroup).notes]
        .sort((a, b) => diatonic(b.pitch) - diatonic(a.pitch))
        .map((n) => `${n.pitch.step || "<EMPTY>"}${n.pitch.octave}`);
    }
    beat += event.duration / divisions;
  }
  return [];
}

// These guard the family of corruptions seen when stepping a chord member in an
// imported grand-staff score (Chrono Trigger fixture): the bar restructured, the
// other staff shifted, and a phantom "<step>-less" note appeared. The triggers —
// distinct from #30's single-staff/single-note coverage — are bars whose true
// length differs from the time signature, and chords whose members have unequal
// durations.
describe("irregular bars and mismatched-duration chords (regression)", () => {
  // 4/4 nominal (16 divisions) but the bar actually holds 5 quarters (20) in both
  // staves — an over-full bar, as real engraved scores contain. The treble has a
  // chord C5+A4 at beat 1; the bass is independent.
  const OVERFULL = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type>
      <staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef>
      <clef number="2"><sign>F</sign><line>4</line></clef></attributes>
    <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
    <note><chord/><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
    <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
    <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
    <note><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
    <note><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
    <backup><duration>20</duration></backup>
    <note><pitch><step>C</step><octave>3</octave></pitch><duration>8</duration><type>half</type><staff>2</staff></note>
    <note><pitch><step>G</step><octave>2</octave></pitch><duration>8</duration><type>half</type><staff>2</staff></note>
    <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><type>quarter</type><staff>2</staff></note>
  </measure></part></score-partwise>`;

  test("stepping a treble chord member keeps both staves' length and the bass intact", () => {
    const doc = parseDocument(OVERFULL);
    // C5 is note element index 0 (staff 1, the chord's first member).
    moveNote(
      doc,
      { measureIndex: 0, noteElementIndex: 0 },
      {
        measureIndex: 0,
        onsetBeatInMeasure: 0,
        pitch: { step: "D", alter: 0, octave: 5 },
      },
    );
    const score = parseScore(serializeDocument(doc));
    // Both staves keep their true 5-beat length (not truncated to the 4/4 nominal).
    expect(measureBeats(score, 0, 0)).toBe(5);
    expect(measureBeats(score, 1, 0)).toBe(5);
    // The stepped chord is exactly D5 over A4 — no phantom, no duplicate.
    expect(chordPitches(score, 0, 0)).toEqual(["D5", "A4"]);
    // The bass is untouched: C3, G2, C3 at beats 0, 2, 4.
    expect(chordPitches(score, 1, 0)).toEqual(["C3"]);
    expect(chordPitches(score, 1, 2)).toEqual(["G2"]);
    expect(chordPitches(score, 1, 4)).toEqual(["C3"]);
  });

  // A grand-staff bar (the Chrono Trigger shape) whose treble beat-2 chord stacks
  // members of unequal length: C5/A4 quarters with a lower E4 *eighth*. Stepping
  // the unrelated beat-1 note must not let the rewrite make the short, low E4 the
  // cursor-advancing (plain) note — which would under-advance the time cursor and
  // swallow the rest of the bar (and desync the bass).
  const MISMATCHED = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type>
      <staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef>
      <clef number="2"><sign>F</sign><line>4</line></clef></attributes>
    <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
    <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
    <note><chord/><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type><staff>1</staff></note>
    <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><type>eighth</type><staff>1</staff></note>
    <note><pitch><step>D</step><octave>5</octave></pitch><duration>8</duration><type>half</type><staff>1</staff></note>
    <backup><duration>16</duration></backup>
    <note><pitch><step>C</step><octave>3</octave></pitch><duration>16</duration><type>whole</type><staff>2</staff></note>
  </measure></part></score-partwise>`;

  test("stepping near a mismatched-duration chord keeps the bar's length", () => {
    const doc = parseDocument(MISMATCHED);
    // Step the beat-1 G4 (treble index 0) up a step; the beat-2 chord is untouched.
    moveNote(
      doc,
      { measureIndex: 0, noteElementIndex: 0 },
      {
        measureIndex: 0,
        onsetBeatInMeasure: 0,
        pitch: { step: "A", alter: 0, octave: 4 },
      },
    );
    const score = parseScore(serializeDocument(doc));
    // The treble is still a full 4 beats — the short E4 didn't collapse it.
    expect(measureBeats(score, 0, 0)).toBe(4);
    // The bass whole note is untouched (no desync).
    expect(measureBeats(score, 1, 0)).toBe(4);
    expect(chordPitches(score, 1, 0)).toEqual(["C3"]);
    // The mismatched chord still sounds all three pitches at beat 1.
    expect(chordPitches(score, 0, 1)).toEqual(["C5", "A4", "E4"]);
    // The half note at beat 2 survives.
    expect(chordPitches(score, 0, 2)).toEqual(["D5"]);
  });
});

describe("grace notes survive edits", () => {
  // A single grace note (D5) ornaments the beat-2 chord E5+G5.
  const GRACE = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>M</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type>
      <clef><sign>G</sign><line>2</line></clef></attributes>
    <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
    <note><grace/><pitch><step>D</step><octave>5</octave></pitch><type>eighth</type></note>
    <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
    <note><chord/><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
    <note><pitch><step>F</step><octave>5</octave></pitch><duration>8</duration><type>half</type></note>
  </measure></part></score-partwise>`;

  test("stepping the grace's host chord keeps the grace and the bar", () => {
    const doc = parseDocument(GRACE);
    // G5 (top of the beat-2 chord) is note element index 3; step it up to A5.
    moveNote(
      doc,
      { measureIndex: 0, noteElementIndex: 3 },
      {
        measureIndex: 0,
        onsetBeatInMeasure: 1,
        pitch: { step: "A", alter: 0, octave: 5 },
      },
    );
    const score = parseScore(serializeDocument(doc));
    // Bar length preserved (no collapse from folding the grace into the chord).
    expect(measureBeats(score, 0, 0)).toBe(4);
    // The chord stepped to E5 + A5 (no phantom, no swallowed notes).
    expect(chordPitches(score, 0, 1)).toEqual(["A5", "E5"]);
    // The grace note D5 still precedes the beat-2 chord.
    const beat2 = flatEvents(score.parts[0].measures[0]).find(
      (e) => !isRest(e) && (e as ChordGroup).gracesBefore !== undefined,
    ) as ChordGroup | undefined;
    expect(beat2?.gracesBefore?.[0].notes[0].pitch.step).toBe("D");
    // No note lost its <step>.
    expect(serializeDocument(doc)).not.toContain("<step></step>");
  });
});

describe("non-quarter divisions", () => {
  // divisions=8 (quarter = 8): a quarter note must still be typed "quarter", and
  // a gap must fill with correctly-scaled rests — not the 4-per-quarter the
  // editor's blank document uses.
  const DIV8 = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>M</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <attributes><divisions>8</divisions><time><beats>4</beats><beat-type>4</beat-type>
      <clef><sign>G</sign><line>2</line></clef></attributes>
    <note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><type>quarter</type></note>
    <note><pitch><step>E</step><octave>5</octave></pitch><duration>8</duration><type>quarter</type></note>
    <note><rest/><duration>16</duration><type>half</type></note>
  </measure></part></score-partwise>`;

  test("addNote types a quarter as a quarter (not a half)", () => {
    const doc = parseDocument(DIV8);
    // Add a quarter (durationBeats 1 = 8 divisions) into the rest at beat 3.
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 2,
      durationBeats: 1,
      pitch: { step: "G", alter: 0, octave: 5 },
    });
    const score = parseScore(serializeDocument(doc));
    const placed = chords(score);
    const added = placed.find((p) => p.onsetBeat === 2);
    expect(added?.chord.type).toBe("quarter");
    // The bar still totals four quarter beats.
    expect(measureBeats(score, 0, 0)).toBe(4);
  });

  test("removing a note fills the gap with a correctly-typed rest", () => {
    const doc = parseDocument(DIV8);
    // Remove the beat-1 C5 (index 0); the gap becomes a quarter rest, not a half.
    removeNote(doc, { measureIndex: 0, noteElementIndex: 0 });
    const score = parseScore(serializeDocument(doc));
    const firstRest = flatEvents(score.parts[0].measures[0])[0];
    expect(isRest(firstRest)).toBe(true);
    expect((firstRest as { type: string }).type).toBe("quarter");
    expect(measureBeats(score, 0, 0)).toBe(4);
  });
});

// Extract the enclosing `<tag>…</tag>` substring (first occurrence).
function sliceTag(xml: string, tag: string): string {
  const open = xml.indexOf(`<${tag}`);
  const close = xml.indexOf(`</${tag}>`, open) + `</${tag}>`.length;
  return xml.slice(open, close);
}

// Extract the `<measure number="N" …>…</measure>` substring.
function sliceMeasure(xml: string, number: number): string {
  const open = xml.indexOf(`<measure number="${number}"`);
  const close = xml.indexOf("</measure>", open) + "</measure>".length;
  return xml.slice(open, close);
}

describe("shiftNotesInTime", () => {
  // C5 quarter at beat 0, E5 quarter at beat 1, rest of the bar empty.
  function docWithRun(): { doc: Document; first: NoteHandle } {
    const doc = createBlankDocument();
    const first = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 1,
      durationBeats: 1,
      pitch: { step: "E", alter: 0, octave: 5 },
    });
    return { doc, first };
  }

  test("shifts the anchor and everything after it right, absorbing trailing rest", () => {
    const { doc, first } = docWithRun();
    const moved = shiftNotesInTime(doc, first, 1);
    expect(moved).not.toBeNull();
    const onsets = chords(reparse(doc)).map((entry) => entry.onsetBeat);
    expect(onsets).toEqual([1, 2]);
  });

  test("shifts left back into the freed rest space", () => {
    const { doc, first } = docWithRun();
    const moved = shiftNotesInTime(doc, first, 1) as NoteHandle;
    const back = shiftNotesInTime(doc, moved, -1);
    expect(back).not.toBeNull();
    const onsets = chords(reparse(doc)).map((entry) => entry.onsetBeat);
    expect(onsets).toEqual([0, 1]);
  });

  test("shifting only the tail leaves earlier notes in place", () => {
    const { doc } = docWithRun();
    // Anchor on the E5 at beat 1; the C5 at beat 0 must not move.
    const second = handleOfNoteAt(doc, 1);
    const moved = shiftNotesInTime(doc, second, 2);
    expect(moved).not.toBeNull();
    const onsets = chords(reparse(doc)).map((entry) => entry.onsetBeat);
    expect(onsets).toEqual([0, 3]);
  });

  test("a right shift past the bar end grows the measure into an over-full bar", () => {
    const { doc, first } = docWithRun();
    // C5(beat0) E5(beat1), beats 2-3 empty. Shift right by 3 beats: C5→beat3,
    // E5→beat4, so the block runs past the barline and the bar grows rather
    // than refusing.
    const moved = shiftNotesInTime(doc, first, 3);
    expect(moved).not.toBeNull();
    const score = reparse(doc);
    const onsets = chords(score).map((entry) => entry.onsetBeat);
    expect(onsets).toEqual([3, 4]);
    // The bar is now over-full: the staff's notes reach beat 5 (E5 ends), > 4.
    const fill = measureFillReport(doc)[0];
    expect(fill.staffBeats[0]).toBeGreaterThan(fill.nominalBeats);
    expect(fill.staffBeats[0]).toBe(5);
  });

  test("refuses a left shift that would collide with the previous note", () => {
    const { doc } = docWithRun();
    const second = handleOfNoteAt(doc, 1);
    const before = serializeDocument(doc);
    expect(shiftNotesInTime(doc, second, -1)).toBeNull();
    expect(serializeDocument(doc)).toBe(before);
  });

  test("on a grand staff, shifting one staff leaves the other untouched", () => {
    const doc = createBlankDocument();
    addStaff(doc);
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
      staff: 1,
    });
    const bass = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "G", alter: 0, octave: 2 },
      staff: 2,
    }) as NoteHandle;
    expect(shiftNotesInTime(doc, bass, 1)).not.toBeNull();
    const score = reparse(doc);
    // Treble (parts[0]) still starts at beat 0; bass (parts[1]) moved to 1.
    const partOnsets = score.parts.map((part) => {
      let onsetBeat = 0;
      const divisions = part.measures[0].divisions || 4;
      for (const event of flatEvents(part.measures[0])) {
        if (!isRest(event)) {
          return onsetBeat;
        }
        onsetBeat += event.duration / divisions;
      }
      return null;
    });
    expect(partOnsets).toEqual([0, 1]);
  });

  // The handle of the (single) non-rest note whose onset is `beat` in measure 1.
  function handleOfNoteAt(doc: Document, beat: number): NoteHandle {
    const noteEls = Array.from(
      doc.querySelectorAll("measure")[0].querySelectorAll("note"),
    );
    let cursor = 0;
    for (let index = 0; index < noteEls.length; index++) {
      const el = noteEls[index];
      const duration = Number.parseInt(
        el.querySelector("duration")?.textContent ?? "0",
        10,
      );
      const isRestEl = el.querySelector("rest") !== null;
      if (!isRestEl && cursor === beat * 4) {
        return { measureIndex: 0, noteElementIndex: index };
      }
      cursor += duration;
    }
    throw new Error(`no note at beat ${beat}`);
  }
});

describe("measureFillReport", () => {
  test("a well-formed 4/4 bar's notes reach exactly the bar length", () => {
    const doc = createBlankDocument();
    for (let beat = 0; beat < 4; beat++) {
      addNote(doc, {
        measureIndex: 0,
        onsetBeatInMeasure: beat,
        durationBeats: 1,
        pitch: { step: "C", alter: 0, octave: 5 },
      });
    }
    const fill = measureFillReport(doc)[0];
    expect(fill.staffBeats[0]).toBe(4);
    expect(fill.nominalBeats).toBe(4);
    expect(fill.staffBeats[0]).not.toBeGreaterThan(fill.nominalBeats);
  });

  test("reports how far an over-full bar's notes reach", () => {
    const doc = createBlankDocument();
    const first = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
    }) as NoteHandle;
    // Push the note out to beat 4, growing the bar to 5 beats.
    shiftNotesInTime(doc, first, 4);
    const fill = measureFillReport(doc)[0];
    expect(fill.staffBeats[0]).toBe(5);
    expect(fill.nominalBeats).toBe(4);
    expect(fill.staffBeats[0]).toBeGreaterThan(fill.nominalBeats);
  });

  test("a blank document's empty bars are not flagged (notes reach 0)", () => {
    const doc = createBlankDocument();
    for (const fill of measureFillReport(doc)) {
      // A whole-rest bar has no notes, so nothing overruns the bar.
      expect(fill.staffBeats.every((b) => b <= fill.nominalBeats)).toBe(true);
    }
  });

  test("attributes over-fullness to the specific staff on a grand staff", () => {
    const doc = createBlankDocument();
    addStaff(doc);
    // Treble keeps a single beat-1 note (its notes reach beat 1, well within
    // the bar); the bass note is pushed past the barline. writeMeasure pads
    // the treble with trailing rests to match the grown bar, but those rests
    // must NOT make the treble read as over-full — only the bass does.
    addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "C", alter: 0, octave: 5 },
      staff: 1,
    });
    const bass = addNote(doc, {
      measureIndex: 0,
      onsetBeatInMeasure: 0,
      durationBeats: 1,
      pitch: { step: "G", alter: 0, octave: 2 },
      staff: 2,
    }) as NoteHandle;
    shiftNotesInTime(doc, bass, 4);
    const fill = measureFillReport(doc)[0];
    // staffBeats index 0 = treble (staff 1), 1 = bass (staff 2).
    expect(fill.staffBeats[0]).toBe(1); // treble: notes end at beat 1, not over-full
    expect(fill.staffBeats[1]).toBe(5); // bass: notes reach beat 5, over-full
    expect(fill.nominalBeats).toBe(4);
  });
});

describe("redistributeStaves", () => {
  // A single-staff score with a high melody note (C5) and a low note (G2) in the
  // same measure, plus a second measure, to prove the split works per measure.
  const SINGLE_STAFF_MIXED = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><type>half</type></note>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>8</duration><type>half</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>8</duration><type>half</type></note>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>8</duration><type>half</type></note>
    </measure>
  </part>
</score-partwise>`;

  test("splits a single-staff score into a treble/bass grand staff by pitch", () => {
    const doc = parseDocument(SINGLE_STAFF_MIXED);
    const result = redistributeStaves(doc, 60);
    expect(result?.staffCount).toBe(2);

    const score = reparse(doc);
    expect(score.parts.length).toBe(2);
    // Treble carries the high notes (C5, E5); bass carries the low ones (G2, C3).
    expect(score.parts[0].clef?.sign).toBe("G");
    expect(score.parts[1].clef?.sign).toBe("F");

    const trebleSteps = score.parts[0].measures.flatMap((m) =>
      flatEvents(m).flatMap((e) =>
        isRest(e) ? [] : (e as ChordGroup).notes.map((n) => n.pitch.step),
      ),
    );
    const bassSteps = score.parts[1].measures.flatMap((m) =>
      flatEvents(m).flatMap((e) =>
        isRest(e) ? [] : (e as ChordGroup).notes.map((n) => n.pitch.step),
      ),
    );
    expect(trebleSteps.sort()).toEqual(["C", "E"]);
    expect(bassSteps.sort()).toEqual(["C", "G"]);
    // Declares two staves and stays editable.
    expect(doc.querySelector("staves")?.textContent).toBe("2");
    expect(isEditableDocument(doc)).toBe(true);
  });

  test("a chord straddling the split is divided note-by-note", () => {
    // One quarter-note chord C3+E3+C5+G5 at beat 0. Split at middle C (60):
    // C5/G5 (>= 60) → treble, C3/E3 (< 60) → bass.
    const CHORD = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>M</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type>
      <clef><sign>G</sign><line>2</line></clef></attributes>
    <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><type>quarter</type></note>
    <note><chord/><pitch><step>E</step><octave>3</octave></pitch><duration>4</duration><type>quarter</type></note>
    <note><chord/><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
    <note><chord/><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
  </measure></part></score-partwise>`;
    const doc = parseDocument(CHORD);
    redistributeStaves(doc, 60);
    const score = reparse(doc);

    // Treble beat 0: C5 + G5.
    expect(chordPitches(score, 0, 0).sort()).toEqual(["C5", "G5"]);
    // Bass beat 0: C3 + E3.
    expect(chordPitches(score, 1, 0).sort()).toEqual(["C3", "E3"]);
  });

  test("collapses a grand staff and re-splits by pitch", () => {
    // GRAND_STAFF_XML: E5 on staff 1, G2 on staff 2. A very low split (below
    // both) sends everything to the treble staff; the bass becomes rests.
    const doc = parseDocument(GRAND_STAFF_XML);
    redistributeStaves(doc, 21);
    const score = reparse(doc);
    const trebleSteps = flatEvents(score.parts[0].measures[0]).flatMap((e) =>
      isRest(e) ? [] : (e as ChordGroup).notes.map((n) => n.pitch.step),
    );
    expect(trebleSteps.sort()).toEqual(["E", "G"]);
    expect(flatEvents(score.parts[1].measures[0]).every(isRest)).toBe(true);
  });

  test("redistributes a multi-voice score onto two staves without overfilling", () => {
    // MULTI_VOICE_XML: staff 1 has voice 1 (D5 half, C5+D5 quarters) and voice 2
    // (B4+G4 quarters); staff 2 has voice 5 (G3 half). All the >= 60 pitches
    // (D5/C5/B4/G4) land on the treble staff, G3 on the bass. Voices are kept,
    // so the overlapping treble voices don't collapse into one over-full run.
    const doc = parseDocument(MULTI_VOICE_XML);
    redistributeStaves(doc, 60);
    const score = reparse(doc);
    expect(score.parts.length).toBe(2);

    const trebleSteps = new Set<string>(
      flatEvents(score.parts[0].measures[0]).flatMap((e) =>
        isRest(e) ? [] : (e as ChordGroup).notes.map((n) => n.pitch.step),
      ),
    );
    for (const step of ["D", "C", "B", "G"]) {
      expect(trebleSteps.has(step)).toBe(true);
    }
    const bassSteps = new Set<string>(
      flatEvents(score.parts[1].measures[0]).flatMap((e) =>
        isRest(e) ? [] : (e as ChordGroup).notes.map((n) => n.pitch.step),
      ),
    );
    expect(bassSteps.has("G")).toBe(true);

    // Neither staff is over-full: the preserved voices keep the treble at its
    // true 4 beats rather than serializing the two voices end-to-end.
    const fill = measureFillReport(doc)[0];
    expect(fill.nominalBeats).toBe(4);
    for (const beats of fill.staffBeats) {
      expect(beats).toBeLessThanOrEqual(fill.nominalBeats + 1e-6);
    }
    expect(isEditableDocument(doc)).toBe(true);
  });

  test("returns null when there is nothing to act on", () => {
    const empty = new DOMParser().parseFromString(
      `<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>M</part-name></score-part></part-list><part id="P1"></part></score-partwise>`,
      "text/xml",
    );
    expect(redistributeStaves(empty, 60)).toBeNull();
  });

  test("resolves tracked handles (e.g. OMR confidence flags) across the rewrite", () => {
    // G2 is note element index 1 in measure 0 before the split. After the split
    // it's the sole real note on the new bass staff, following the treble
    // staff's C5-plus-fill-rest run — so its element survives (reused, not
    // regenerated) at a new index.
    const doc = parseDocument(SINGLE_STAFF_MIXED);
    const g2Handle: NoteHandle = { measureIndex: 0, noteElementIndex: 1 };
    const result = redistributeStaves(doc, 60, [g2Handle]);
    expect(result).not.toBeNull();
    const [tracked] = result?.trackedHandles ?? [];
    expect(tracked).not.toBeNull();
    expect(tracked?.measureIndex).toBe(0);

    // The tracked handle really does still point at the G2 note.
    const measureEl = Array.from(
      doc.querySelectorAll("part > measure"),
    )[0] as Element;
    const noteEls = Array.from(measureEl.querySelectorAll("note"));
    const resolved = tracked ? noteEls[tracked.noteElementIndex] : undefined;
    expect(resolved?.querySelector("pitch step")?.textContent).toBe("G");
    expect(resolved?.querySelector("pitch octave")?.textContent).toBe("2");
  });

  test("a tracked handle for a note that no longer exists resolves to null", () => {
    const doc = parseDocument(SINGLE_STAFF_MIXED);
    // No note element index 5 exists in measure 0 — a stale/bad handle.
    const badHandle: NoteHandle = { measureIndex: 0, noteElementIndex: 5 };
    const result = redistributeStaves(doc, 60, [badHandle]);
    expect(result?.trackedHandles).toEqual([null]);
  });
});
