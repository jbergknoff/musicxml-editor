// Document-as-source-of-truth editing primitives.
//
// The editor holds one live MusicXML `Document`. Every gesture applies a
// *surgical* edit to the actual `<note>` elements and the document is then
// re-serialized and re-parsed for rendering. Untouched `<note>` elements are
// reused verbatim (never regenerated), so everything the editor does not model
// — dynamics, slurs, lyrics, voices, layout hints — survives a round-trip by
// construction.
//
// Scope: a single part — single-staff, grand staff, or multi-voice staves
// (see `isEditableDocument`). Within that scope the rewrite preserves chords
// (including members of unequal duration), grace notes (re-emitted with their
// host, never folded into its chord), any `<divisions>` value, irregular bar
// lengths (pickup/over-full bars are rebuilt to their own length, not the time
// signature's), and multiple voices per staff (each voice group is emitted in
// order, separated by `<backup>` elements). A "beat" throughout is one quarter
// note (matching `computeMeasureStartBeats`), so divisions-per-beat ==
// divisions-per-quarter.

import type { NoteType, Pitch } from "./sheet-music/index";

// MusicXML divisions per quarter note. The renderer/layout assume this value.
export const DIVISIONS = 4;

/** Identifies a `<note>` element: its measure (0-based within the part) and its
 *  position among that measure's `<note>` elements (document order, rests
 *  included — matching `ParsedNote.source.noteElementIndex`). */
export interface NoteHandle {
  measureIndex: number;
  noteElementIndex: number;
}

// Standard note values as [MusicXML type, dotted, span-in-quarter-notes],
// largest first. The dotted values (1.5, 0.75) let a single glyph cover dotted
// spans. These are expressed in quarter notes — not raw divisions — so the same
// table works for any document `<divisions>` value: a span in divisions is the
// quarter-fraction times the document's divisions-per-quarter. The editor's
// blank document uses DIVISIONS (4) per quarter, but imported/OMR/MIDI scores
// commonly use 8, 12, or 24, and hardcoding 4 mis-scaled every rest/type those
// produced (a quarter became a "half", gaps filled with wrong-length rests).
const NOTE_VALUES: Array<[NoteType, boolean, number]> = [
  ["whole", false, 4],
  ["half", true, 3],
  ["half", false, 2],
  ["quarter", true, 1.5],
  ["quarter", false, 1],
  ["eighth", true, 0.75],
  ["eighth", false, 0.5],
  ["16th", false, 0.25],
];

// The standard division spans (largest first) representable at this
// divisions-per-quarter — those whose quarter-fraction lands on a whole number
// of divisions. (At divisions=2 a 16th is half a division, so it drops out.)
function standardDurations(divisionsPerQuarter: number): number[] {
  const spans: number[] = [];
  for (const [, , quarters] of NOTE_VALUES) {
    const span = quarters * divisionsPerQuarter;
    if (Number.isInteger(span)) {
      spans.push(span);
    }
  }
  return spans;
}

// Division span → [MusicXML type, dotted] at this divisions-per-quarter. Mirrors
// the table in midi-to-musicxml so notation reads identically.
function typeDotForDivisions(
  divisions: number,
  divisionsPerQuarter: number,
): [NoteType, boolean] {
  for (const [type, dot, quarters] of NOTE_VALUES) {
    if (quarters * divisionsPerQuarter === divisions) {
      return [type, dot];
    }
  }
  return ["quarter", false];
}

// Greatest standard duration not exceeding `maxDivisions` (never below 1).
function largestFit(maxDivisions: number, divisionsPerQuarter: number): number {
  return (
    standardDurations(divisionsPerQuarter).find((d) => d <= maxDivisions) ?? 1
  );
}

// Split an arbitrary division span into a sum of standard durations (used to
// fill rest gaps). Ported from midi-to-musicxml's `decompose`. A span that no
// standard value can subdivide (e.g. an odd remainder at a coarse divisions
// value) is emitted whole as a final non-standard span so total time stays exact.
function decompose(divisions: number, divisionsPerQuarter: number): number[] {
  const spans = standardDurations(divisionsPerQuarter);
  const result: number[] = [];
  let remaining = divisions;
  while (remaining > 0) {
    const value = spans.find((d) => d <= remaining);
    if (value === undefined) {
      result.push(remaining);
      break;
    }
    result.push(value);
    remaining -= value;
  }
  return result;
}

// ── Document plumbing ─────────────────────────────────────────────────────────

export function parseDocument(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("Invalid MusicXML");
  }
  return doc;
}

// Reconstruct a `<!DOCTYPE …>` line from a parsed doctype node. Real MusicXML
// carries `<!DOCTYPE score-partwise PUBLIC "…" "…">`; preserving it keeps the
// export valid against the MusicXML DTD.
//
// Note: the browser's DOMParser parses the doctype faithfully (full name +
// PUBLIC/SYSTEM ids), so production exports round-trip it byte-for-byte. The
// linkedom test shim mis-parses XML doctypes (it truncates the name at the
// first hyphen and drops the ids), so under `bun test` this only emits a
// degraded `<!DOCTYPE score>` — enough to prove the doctype is no longer
// dropped, which is the regression Phase 1 guards against.
function doctypeString(doctype: DocumentType): string {
  let result = `<!DOCTYPE ${doctype.name}`;
  if (doctype.publicId) {
    result += ` PUBLIC "${doctype.publicId}" "${doctype.systemId}"`;
  } else if (doctype.systemId) {
    result += ` SYSTEM "${doctype.systemId}"`;
  }
  return `${result}>`;
}

// Serialize the live document back to a MusicXML string. The XML declaration
// and the DOCTYPE (when present) are emitted explicitly, then the
// `<score-partwise>` root: serializing the root element (rather than the whole
// Document) keeps the linkedom test shim — which exposes `outerHTML` on
// elements but not on a Document — behaving like the browser's real
// XMLSerializer. The doctype is reconstructed from `doc.doctype` rather than
// relying on `serializeToString(doc)` so the same code path works in both.
export function serializeDocument(doc: Document): string {
  const root = doc.documentElement;
  const declaration = `<?xml version="1.0" encoding="UTF-8"?>`;
  const doctype = doc.doctype ? `${doctypeString(doc.doctype)}\n` : "";
  return `${declaration}\n${doctype}${new XMLSerializer().serializeToString(
    root,
  )}`;
}

// Whether the editor's surgical ops can safely edit this document.
//
// Multi-part scores are always view-only (the editor models one part at a time).
// A document is editable when it has exactly one `<part>`. Multi-part scores
// (orchestral, ensemble) are view-only because the editor's model is single-part.
// Within a single part any number of staves and voices is supported: `writeMeasure`
// groups notes by (staff, voice) and rebuilds the backup structure faithfully.
export function isEditableDocument(doc: Document): boolean {
  const parts = Array.from(doc.querySelectorAll("part"));
  return parts.length === 1;
}

// The `<measure>` elements of the (single) part, in document order.
function measuresOf(doc: Document): Element[] {
  const part = doc.querySelector("part");
  if (!part) {
    return [];
  }
  return Array.from(part.children).filter(
    (child) => child.tagName.toLowerCase() === "measure",
  );
}

// Number of staves declared in the part (1 for single-staff, 2 for grand staff).
function staffCountOf(doc: Document): number {
  const staves = doc
    .querySelector("part")
    ?.querySelector("staves")?.textContent;
  return staves ? Math.max(1, Number.parseInt(staves, 10)) : 1;
}

// The staff number a `<note>` element belongs to (defaulting to 1 when no
// `<staff>` child is present, as per the MusicXML default for single-staff parts).
function staffOf(noteEl: Element): number {
  const staffText = noteEl.querySelector("staff")?.textContent;
  return staffText ? Number.parseInt(staffText, 10) : 1;
}

// Divisions-per-quarter and total divisions per measure, read from the first
// measure's `<attributes>`.
function measureMetrics(doc: Document): {
  divisions: number;
  divisionsPerMeasure: number;
} {
  const attrEl = measuresOf(doc)[0]?.querySelector("attributes");
  const divisions =
    Number.parseInt(
      attrEl?.querySelector("divisions")?.textContent ?? "4",
      10,
    ) || 4;
  const beats =
    Number.parseInt(
      attrEl?.querySelector("time > beats")?.textContent ?? "4",
      10,
    ) || 4;
  const beatType =
    Number.parseInt(
      attrEl?.querySelector("time > beat-type")?.textContent ?? "4",
      10,
    ) || 4;
  return { divisions, divisionsPerMeasure: divisions * beats * (4 / beatType) };
}

// A measure's *actual* notated length in divisions: the furthest the MusicXML
// time cursor reaches across all voices/staves (notes and rests advance it,
// `<backup>` rewinds it, `<forward>` advances it; grace notes and chord members
// don't advance it). This is the bar's own length, which can differ from the
// time signature's nominal `divisionsPerMeasure` — pickup/anacrusis bars are
// shorter, cadenza/over-full bars are longer, and irregular bars are whatever
// they are. `writeMeasure` rebuilds to *this* length (not the nominal one) so it
// never stretches or truncates a bar that the time signature doesn't describe,
// and sizes the inter-staff `<backup>` to match so the staves stay aligned.
function measureContentDivisions(measureEl: Element): number {
  let cursor = 0;
  let lastOnset = 0;
  let maxExtent = 0;
  for (const child of Array.from(measureEl.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === "note") {
      if (child.querySelector("grace") !== null) {
        continue;
      }
      const isChord = child.querySelector("chord") !== null;
      const duration = Number.parseInt(
        child.querySelector("duration")?.textContent ?? "0",
        10,
      );
      const onset = isChord ? lastOnset : cursor;
      maxExtent = Math.max(maxExtent, onset + duration);
      if (!isChord) {
        lastOnset = cursor;
        cursor += duration;
      }
    } else if (tag === "backup") {
      cursor -= Number.parseInt(
        child.querySelector("duration")?.textContent ?? "0",
        10,
      );
    } else if (tag === "forward") {
      cursor += Number.parseInt(
        child.querySelector("duration")?.textContent ?? "0",
        10,
      );
      maxExtent = Math.max(maxExtent, cursor);
    }
  }
  return maxExtent;
}

// A real (pitched) note in a measure, with its element and timing in divisions.
interface RealNote {
  element: Element;
  onsetDivisions: number;
  durationDivisions: number;
  voice: number;
  // Grace `<note>` elements that immediately precede this note in document order.
  // Grace notes carry no rhythmic duration, so they must ride *with* their host
  // note — re-emitted verbatim just before it — rather than being treated as
  // zero-duration notes at the host's onset. Folding them into the host's onset
  // (the old behaviour) made `setChordFlag` stamp `<chord/>` onto the host, after
  // which the parser's time cursor stopped advancing and the whole measure's
  // rhythm collapsed leftward. The same trap springs on any zero-duration note
  // (e.g. a malformed import missing `<duration>`), which is also captured here.
  graces: Element[];
}

// Walk a measure's children tracking the MusicXML time cursor (same logic as
// the parser's `collectStaffItems`), returning only the real notes — rests are
// dropped because `writeMeasure` regenerates them, and grace notes are attached
// to the real note they precede (their host) rather than emitted standalone.
// Handles multiple voices: the cursor is rewound by <backup> elements, so notes
// from later voices get their correct within-measure onset positions.
function readRealNotes(measureEl: Element, _divisions: number): RealNote[] {
  const notes: RealNote[] = [];
  let cursor = 0;
  let lastOnset = 0;
  // Grace notes seen since the last real note, awaiting their host.
  let pendingGraces: Element[] = [];
  for (const child of Array.from(measureEl.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === "note") {
      const isRest = child.querySelector("rest") !== null;
      const isGrace = child.querySelector("grace") !== null;
      const isChord = child.querySelector("chord") !== null;
      if (isGrace) {
        // Buffer (non-rest) grace notes until the next real note hosts them;
        // they advance neither the cursor nor `lastOnset`.
        if (!isRest) {
          pendingGraces.push(child);
        }
        continue;
      }
      const durationDivisions = Number.parseInt(
        child.querySelector("duration")?.textContent ?? "0",
        10,
      );
      const voice = Number.parseInt(
        child.querySelector("voice")?.textContent ?? "1",
        10,
      );
      const onset = isChord ? lastOnset : cursor;
      if (!isRest) {
        notes.push({
          element: child,
          onsetDivisions: onset,
          durationDivisions,
          voice,
          graces: pendingGraces,
        });
        pendingGraces = [];
      }
      if (!isChord) {
        lastOnset = cursor;
        cursor += durationDivisions;
      }
    } else if (tag === "backup") {
      cursor -= Number.parseInt(
        child.querySelector("duration")?.textContent ?? "0",
        10,
      );
    } else if (tag === "forward") {
      cursor += Number.parseInt(
        child.querySelector("duration")?.textContent ?? "0",
        10,
      );
    }
  }
  return notes;
}

// Diatonic step letters, low to high within an octave.
const STEPS: Pitch["step"][] = ["C", "D", "E", "F", "G", "A", "B"];

// A pitch's height as a single comparable number (semitone-ish), used only to
// order chord members low-to-high. Reads the note element's `<pitch>` directly.
const SEMITONE_OF_STEP: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};
function pitchHeight(noteEl: Element): number {
  const pitchEl = noteEl.querySelector("pitch");
  if (!pitchEl) {
    return 0;
  }
  const step = pitchEl.querySelector("step")?.textContent ?? "C";
  const octave = Number.parseInt(
    pitchEl.querySelector("octave")?.textContent ?? "4",
    10,
  );
  const alter = Number.parseInt(
    pitchEl.querySelector("alter")?.textContent ?? "0",
    10,
  );
  return octave * 12 + (SEMITONE_OF_STEP[step] ?? 0) + alter;
}

// Read a note element's `<pitch>` into a Pitch (or null for a rest). Local to
// dom-edit to avoid a circular import with hit-test (which imports dom-edit).
function readPitch(noteEl: Element): Pitch | null {
  const pitchEl = noteEl.querySelector("pitch");
  if (!pitchEl) {
    return null;
  }
  const step = (pitchEl.querySelector("step")?.textContent ??
    "C") as Pitch["step"];
  const octave = Number.parseInt(
    pitchEl.querySelector("octave")?.textContent ?? "4",
    10,
  );
  const alterText = pitchEl.querySelector("alter")?.textContent;
  const alter = alterText ? Number.parseInt(alterText, 10) : 0;
  return { step, alter, octave };
}

// Ensure a note carries (or drops) the `<chord/>` flag. The first note of a beat
// is plain; every later note sharing that onset is a chord member. The flag goes
// before `<pitch>` (grace notes are emitted separately and never passed here).
function setChordFlag(doc: Document, noteEl: Element, isChord: boolean): void {
  const existing = Array.from(noteEl.children).find(
    (childEl) => childEl.tagName.toLowerCase() === "chord",
  );
  if (isChord && !existing) {
    const pitchEl = noteEl.querySelector("pitch");
    noteEl.insertBefore(
      doc.createElement("chord"),
      pitchEl ?? noteEl.firstChild,
    );
  } else if (!isChord && existing) {
    existing.remove();
  }
}

// Emit one voice's note/rest run into `measureEl`. Called by `writeMeasure` for
// each (staff, voice) group in turn. `staff` is the staff number to tag freshly
// created rests with (0 = single-staff document, omit the <staff> element).
// `voice` is the voice number for fill rests (0 = omit). `measureLength` is
// the bar's actual length in divisions (`measureContentDivisions`), the target
// every voice's run is padded out to.
function writeStaffNotes(
  doc: Document,
  measureEl: Element,
  notes: RealNote[],
  measureLength: number,
  staff: number,
  divisionsPerQuarter: number,
  voice = 0,
): void {
  const makeRest = (durationDivisions: number, fullMeasure = false) =>
    createRestElement(doc, {
      durationDivisions,
      fullMeasure,
      voice: voice > 0 ? voice : undefined,
      staff: staff > 0 ? staff : undefined,
      divisionsPerQuarter,
    });

  if (notes.length === 0) {
    measureEl.appendChild(makeRest(measureLength, true));
    return;
  }

  // Group notes by onset so same-onset notes render as one chord.
  const byOnset = new Map<number, RealNote[]>();
  for (const note of notes) {
    const group = byOnset.get(note.onsetDivisions);
    if (group) {
      group.push(note);
    } else {
      byOnset.set(note.onsetDivisions, [note]);
    }
  }
  const onsets = Array.from(byOnset.keys()).sort((a, b) => a - b);

  let cursor = 0;
  for (const onset of onsets) {
    if (onset > cursor) {
      for (const span of decompose(onset - cursor, divisionsPerQuarter)) {
        measureEl.appendChild(makeRest(span));
      }
    }
    // appendChild moves each element here (from its old slot, or another
    // measure on a cross-measure relocation). Members are ordered low-to-high.
    const byPitch = (byOnset.get(onset) as RealNote[])
      .slice()
      .sort((a, b) => pitchHeight(a.element) - pitchHeight(b.element));
    // The first (plain, un-`<chord/>`-flagged) member must carry the chord's full
    // rhythmic span: the parser advances the time cursor by the first note's
    // duration. Normal chords share one duration so any member works, but some
    // engravers stack members of unequal length — making a *shorter* member plain
    // would under-advance the cursor and collapse the rest of the bar, so the
    // longest member leads (ties broken by the existing low-to-high order).
    const leadIndex = byPitch.reduce(
      (best, member, index) =>
        member.durationDivisions > byPitch[best].durationDivisions
          ? index
          : best,
      0,
    );
    const members = [
      byPitch[leadIndex],
      ...byPitch.filter((_, index) => index !== leadIndex),
    ];
    // Grace notes belonging to this onset are emitted first — verbatim, ahead of
    // the chord, and never re-flagged as chord members — so they keep their
    // grace-ness and their pitches survive the rewrite.
    for (const member of members) {
      for (const grace of member.graces) {
        measureEl.appendChild(grace);
      }
    }
    members.forEach((member, index) => {
      setChordFlag(doc, member.element, index > 0);
      measureEl.appendChild(member.element);
    });
    // Chord members share one rhythmic slot; advance by the longest member.
    cursor =
      onset + Math.max(...members.map((member) => member.durationDivisions));
  }
  if (cursor < measureLength) {
    for (const span of decompose(measureLength - cursor, divisionsPerQuarter)) {
      measureEl.appendChild(makeRest(span));
    }
  }
}

// Re-emit a measure's note/rest run from a list of real notes. Removes every
// existing `<note>` (rests and notes) and re-appends: each real note's *existing*
// element verbatim (reused — this is what makes the edit faithful) with freshly
// built `<rest>` notes filling every gap. Notes sharing an onset within the same
// voice are emitted as a chord — ordered low-to-high, the first plain and the
// rest flagged `<chord/>` — so stacked pitches survive the rewrite. Non-note
// siblings (`<attributes>`, etc.) keep their relative order; the notes are
// appended after them.
//
// Multi-voice / grand-staff: `notes` may contain notes from multiple staves and
// voices. They are grouped by (staff, voice) in canonical order (staff 1 before
// staff 2, lower voice numbers first within each staff). Each group is emitted as
// a contiguous run, separated from the next by a <backup> element that rewinds to
// the measure start. Freshly created rests carry the <staff> and <voice> numbers
// of the group they fill. Existing note elements already carry their own children.
// `requiredStaves` (multi-staff only) lists staff numbers that must be emitted
// even when they hold no notes — an empty staff has nothing in `notes`, so it
// would otherwise vanish from the rebuilt measure. Each missing staff is filled
// with a single full-measure rest. Used by `addStaff`/`removeStaff` so a newly
// added (or newly emptied) staff always carries a well-formed blank bar.
function writeMeasure(
  doc: Document,
  measureEl: Element,
  notes: RealNote[],
  measureLength: number,
  divisionsPerQuarter: number,
  staffCount = 1,
  requiredStaves?: number[],
): void {
  for (const noteEl of Array.from(measureEl.querySelectorAll("note"))) {
    noteEl.remove();
  }

  if (staffCount <= 1) {
    // Single-staff: check for multiple voices.
    const voices = [...new Set(notes.map((n) => n.voice))].sort(
      (a, b) => a - b,
    );
    if (voices.length <= 1) {
      writeStaffNotes(
        doc,
        measureEl,
        notes,
        measureLength,
        0,
        divisionsPerQuarter,
      );
      return;
    }
    // Single-staff multi-voice: fall through to the general path below with
    // staffCount treated as 1 (no <staff> tags on rests).
  }

  // Multi-voice or grand-staff: remove existing backup/forward (rebuilt below).
  for (const el of Array.from(measureEl.querySelectorAll("backup"))) {
    el.remove();
  }
  for (const el of Array.from(measureEl.querySelectorAll("forward"))) {
    el.remove();
  }

  // Collect the unique (staff, voice) pairs that appear in the notes, in the
  // canonical order they should be emitted: staff 1 first (ascending voice),
  // then staff 2 (ascending voice), etc.
  const groupKeys = new Map<string, { staff: number; voice: number }>();
  for (const n of notes) {
    const s = staffCount > 1 ? staffOf(n.element) : 0;
    const v = n.voice;
    const key = `${s}:${v}`;
    if (!groupKeys.has(key)) {
      groupKeys.set(key, { staff: s, voice: v });
    }
  }
  // Ensure every required staff appears, even if it has no notes (voice 0 → the
  // fill rest carries a <staff> but no <voice>, matching a simple grand staff).
  if (requiredStaves) {
    for (const staff of requiredStaves) {
      if (
        !groupKeys.has(`${staff}:0`) &&
        ![...groupKeys.values()].some((g) => g.staff === staff)
      ) {
        groupKeys.set(`${staff}:0`, { staff, voice: 0 });
      }
    }
  }
  const groups = [...groupKeys.values()].sort(
    (a, b) => a.staff - b.staff || a.voice - b.voice,
  );

  // Emit each (staff, voice) group followed by a <backup>, except the last.
  // The backup rewinds by the bar's actual length so every group starts from
  // the same point — using the nominal time-signature length here desyncs the
  // staves whenever the bar is shorter or longer than the meter says.
  for (let g = 0; g < groups.length; g++) {
    const { staff, voice } = groups[g];
    const groupNotes = notes.filter((n) => {
      const s = staffCount > 1 ? staffOf(n.element) : 0;
      return s === staff && n.voice === voice;
    });
    writeStaffNotes(
      doc,
      measureEl,
      groupNotes,
      measureLength,
      staff,
      divisionsPerQuarter,
      voice,
    );
    if (g < groups.length - 1) {
      const backupEl = doc.createElement("backup");
      backupEl.appendChild(child(doc, "duration", String(measureLength)));
      measureEl.appendChild(backupEl);
    }
  }
}

// The handle for a note element after a rewrite (its index among the measure's
// `<note>` elements).
function handleFor(
  measures: Element[],
  measureIndex: number,
  element: Element,
): NoteHandle {
  const noteEls = Array.from(measures[measureIndex].querySelectorAll("note"));
  return { measureIndex, noteElementIndex: noteEls.indexOf(element) };
}

// ── Node builders ─────────────────────────────────────────────────────────────

function child(doc: Document, tag: string, text?: string): Element {
  const el = doc.createElement(tag);
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

function appendPitch(doc: Document, noteEl: Element, pitch: Pitch): void {
  const pitchEl = doc.createElement("pitch");
  pitchEl.appendChild(child(doc, "step", pitch.step));
  if (pitch.alter !== 0) {
    pitchEl.appendChild(child(doc, "alter", String(pitch.alter)));
  }
  pitchEl.appendChild(child(doc, "octave", String(pitch.octave)));
  noteEl.appendChild(pitchEl);
}

export function createNoteElement(
  doc: Document,
  options: {
    step: Pitch["step"];
    alter: number;
    octave: number;
    durationDivisions: number;
    type?: NoteType;
    dot?: boolean;
    /** Voice number for multi-voice staves. Omit for single-voice content. */
    voice?: number;
    /** Grand-staff only: which staff this note belongs to. Omit for single-staff. */
    staff?: number;
    /** Document divisions-per-quarter (for type/dot inference). Defaults to 4. */
    divisionsPerQuarter?: number;
  },
): Element {
  const [defaultType, defaultDot] = typeDotForDivisions(
    options.durationDivisions,
    options.divisionsPerQuarter ?? DIVISIONS,
  );
  const type = options.type ?? defaultType;
  const dot = options.dot ?? defaultDot;
  const noteEl = doc.createElement("note");
  appendPitch(doc, noteEl, {
    step: options.step,
    alter: options.alter,
    octave: options.octave,
  });
  noteEl.appendChild(child(doc, "duration", String(options.durationDivisions)));
  noteEl.appendChild(child(doc, "type", type));
  if (dot) {
    noteEl.appendChild(doc.createElement("dot"));
  }
  if (options.voice !== undefined && options.voice > 0) {
    noteEl.appendChild(child(doc, "voice", String(options.voice)));
  }
  if (options.staff !== undefined && options.staff > 0) {
    noteEl.appendChild(child(doc, "staff", String(options.staff)));
  }
  return noteEl;
}

export function createRestElement(
  doc: Document,
  options: {
    durationDivisions: number;
    fullMeasure?: boolean;
    /** Grand-staff only: which staff this rest belongs to. Omit for single-staff. */
    staff?: number;
    /** Voice number for multi-voice staves. Omit for single-voice content. */
    voice?: number;
    /** Document divisions-per-quarter (for type/dot inference). Defaults to 4. */
    divisionsPerQuarter?: number;
  },
): Element {
  const noteEl = doc.createElement("note");
  const restEl = doc.createElement("rest");
  if (options.fullMeasure) {
    restEl.setAttribute("measure", "yes");
  }
  noteEl.appendChild(restEl);
  noteEl.appendChild(child(doc, "duration", String(options.durationDivisions)));
  // A full-measure rest is drawn as a whole rest regardless of meter; the
  // parser infers `type: "whole"` from `measure="yes"` when no <type> is given.
  if (!options.fullMeasure) {
    const [type, dot] = typeDotForDivisions(
      options.durationDivisions,
      options.divisionsPerQuarter ?? DIVISIONS,
    );
    noteEl.appendChild(child(doc, "type", type));
    if (dot) {
      noteEl.appendChild(doc.createElement("dot"));
    }
  }
  if (options.voice !== undefined && options.voice > 0) {
    noteEl.appendChild(child(doc, "voice", String(options.voice)));
  }
  if (options.staff !== undefined && options.staff > 0) {
    noteEl.appendChild(child(doc, "staff", String(options.staff)));
  }
  return noteEl;
}

// Mutate an existing note's `<pitch>` in place, preserving every other child
// (ties, articulations, lyrics, …). Used for pitch changes so expression
// elements survive.
function setPitch(doc: Document, noteEl: Element, pitch: Pitch): void {
  const existing = noteEl.querySelector("pitch");
  const pitchEl = doc.createElement("pitch");
  pitchEl.appendChild(child(doc, "step", pitch.step));
  if (pitch.alter !== 0) {
    pitchEl.appendChild(child(doc, "alter", String(pitch.alter)));
  }
  pitchEl.appendChild(child(doc, "octave", String(pitch.octave)));
  if (existing) {
    existing.replaceWith(pitchEl);
  } else {
    noteEl.insertBefore(pitchEl, noteEl.firstChild);
  }
}

// Mutate an existing note's `<duration>`/`<type>`/`<dot>` in place to a new
// standard span. Other children are untouched.
function setDuration(
  doc: Document,
  noteEl: Element,
  durationDivisions: number,
  divisionsPerQuarter: number,
): void {
  const [type, dot] = typeDotForDivisions(
    durationDivisions,
    divisionsPerQuarter,
  );
  const durEl = noteEl.querySelector("duration");
  if (durEl) {
    durEl.textContent = String(durationDivisions);
  } else {
    noteEl.appendChild(child(doc, "duration", String(durationDivisions)));
  }
  const typeEl = noteEl.querySelector("type");
  if (typeEl) {
    typeEl.textContent = type;
  } else {
    noteEl.appendChild(child(doc, "type", type));
  }
  const dotEl = noteEl.querySelector("dot");
  if (dot && !dotEl) {
    noteEl.appendChild(doc.createElement("dot"));
  } else if (!dot && dotEl) {
    dotEl.remove();
  }
}

// ── Blank document ────────────────────────────────────────────────────────────

export function createBlankDocument(options?: {
  timeSigNum?: number;
  timeSigDen?: number;
  keyFifths?: number;
  clef?: { sign: "G" | "F"; line: number };
  measureCount?: number;
}): Document {
  const timeSigNum = options?.timeSigNum ?? 4;
  const timeSigDen = options?.timeSigDen ?? 4;
  const keyFifths = options?.keyFifths ?? 0;
  const clef = options?.clef ?? { sign: "G" as const, line: 2 };
  const measureCount = options?.measureCount ?? 4;
  const fullMeasureDur = DIVISIONS * timeSigNum * (4 / timeSigDen);

  const measures: string[] = [];
  for (let m = 0; m < measureCount; m++) {
    const attributes =
      m === 0
        ? `
      <attributes>
        <divisions>${DIVISIONS}</divisions>
        <key><fifths>${keyFifths}</fifths><mode>major</mode></key>
        <time><beats>${timeSigNum}</beats><beat-type>${timeSigDen}</beat-type></time>
        <clef><sign>${clef.sign}</sign><line>${clef.line}</line></clef>
      </attributes>`
        : "";
    measures.push(
      `    <measure number="${m + 1}">${attributes}
      <note><rest measure="yes"/><duration>${fullMeasureDur}</duration></note>
    </measure>`,
    );
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1">
      <part-name>Music</part-name>
    </score-part>
  </part-list>
  <part id="P1">
${measures.join("\n")}
  </part>
</score-partwise>`;
  return parseDocument(xml);
}

// ── Surgical operations ───────────────────────────────────────────────────────

// Insert a fresh note. The caller (hit-test) has already snapped the onset/pitch
// to the grid; the duration is fitted to the gap before the next existing note
// (or the barline) so single-voice notes never overlap and stay single, well-
// typed durations. Returns the new note's handle, or null if the target measure
// does not exist.
export function addNote(
  doc: Document,
  options: {
    measureIndex: number;
    onsetBeatInMeasure: number;
    durationBeats: number;
    pitch: Pitch;
    /** Grand-staff only: which staff to insert into (1 = treble, 2 = bass). */
    staff?: number;
  },
): NoteHandle | null {
  const measures = measuresOf(doc);
  const measureEl = measures[options.measureIndex];
  if (!measureEl) {
    return null;
  }
  const { divisions, divisionsPerMeasure } = measureMetrics(doc);
  const measureLength =
    measureContentDivisions(measureEl) || divisionsPerMeasure;
  const onsetDivisions = Math.max(
    0,
    Math.min(
      Math.round(options.onsetBeatInMeasure * divisions),
      measureLength - 1,
    ),
  );
  const requested = Math.max(1, Math.round(options.durationBeats * divisions));

  const sc = staffCountOf(doc);
  const targetStaff = sc > 1 ? (options.staff ?? 1) : 0;

  // For gap-detection, only look at notes in the same staff.
  const notes = readRealNotes(measureEl, divisions);
  const staffNotes =
    targetStaff > 0
      ? notes.filter((n) => staffOf(n.element) === targetStaff)
      : notes;
  const nextOnset = staffNotes.reduce(
    (min, note) =>
      note.onsetDivisions > onsetDivisions
        ? Math.min(min, note.onsetDivisions)
        : min,
    measureLength,
  );
  const fit = largestFit(
    Math.min(requested, nextOnset - onsetDivisions),
    divisions,
  );

  const element = createNoteElement(doc, {
    step: options.pitch.step,
    alter: options.pitch.alter,
    octave: options.pitch.octave,
    durationDivisions: fit,
    staff: targetStaff > 0 ? targetStaff : undefined,
    divisionsPerQuarter: divisions,
  });
  notes.push({
    element,
    onsetDivisions,
    durationDivisions: fit,
    voice: 1,
    graces: [],
  });
  writeMeasure(doc, measureEl, notes, measureLength, divisions, sc);
  return handleFor(measuresOf(doc), options.measureIndex, element);
}

// Locate the `<note>` element a handle refers to.
function elementForHandle(doc: Document, handle: NoteHandle): Element | null {
  const measureEl = measuresOf(doc)[handle.measureIndex];
  if (!measureEl) {
    return null;
  }
  return (
    Array.from(measureEl.querySelectorAll("note"))[handle.noteElementIndex] ??
    null
  );
}

// Remove several notes at once (e.g. every member of a selected chord). All
// target elements are resolved up front — while the handles are still valid
// against the current document — and each affected measure is rebuilt once, so
// the index shifts a sequence of single removals would cause cannot occur.
export function removeNotes(doc: Document, handles: NoteHandle[]): void {
  const elements = handles
    .map((handle) => elementForHandle(doc, handle))
    .filter((element): element is Element => element !== null);
  if (elements.length === 0) {
    return;
  }
  const { divisions, divisionsPerMeasure } = measureMetrics(doc);
  const sc = staffCountOf(doc);
  const removeSet = new Set(elements);
  const measureEls = new Set<Element>();
  for (const element of elements) {
    if (element.parentElement) {
      measureEls.add(element.parentElement);
    }
  }
  for (const measureEl of measureEls) {
    const measureLength =
      measureContentDivisions(measureEl) || divisionsPerMeasure;
    const notes = readRealNotes(measureEl, divisions).filter(
      (note) => !removeSet.has(note.element),
    );
    writeMeasure(doc, measureEl, notes, measureLength, divisions, sc);
  }
}

// Remove a note; its span becomes rest (rebalanced by writeMeasure).
export function removeNote(doc: Document, handle: NoteHandle): void {
  const measures = measuresOf(doc);
  const measureEl = measures[handle.measureIndex];
  if (!measureEl) {
    return;
  }
  const { divisions, divisionsPerMeasure } = measureMetrics(doc);
  const measureLength =
    measureContentDivisions(measureEl) || divisionsPerMeasure;
  const sc = staffCountOf(doc);
  const target = elementForHandle(doc, handle);
  if (!target) {
    return;
  }
  const notes = readRealNotes(measureEl, divisions).filter(
    (note) => note.element !== target,
  );
  writeMeasure(doc, measureEl, notes, measureLength, divisions, sc);
}

// Move a note to a new pitch and/or onset (possibly a different measure). The
// pitch is mutated in place (preserving the note's expression children); only
// when the onset moves and the available gap forces a shorter span is the
// duration adjusted. Returns the note's new handle, or null on a bad handle.
export function moveNote(
  doc: Document,
  handle: NoteHandle,
  target: { measureIndex: number; onsetBeatInMeasure: number; pitch: Pitch },
): NoteHandle | null {
  const measures = measuresOf(doc);
  const sourceMeasureEl = measures[handle.measureIndex];
  const destMeasureEl = measures[target.measureIndex];
  if (!sourceMeasureEl || !destMeasureEl) {
    return null;
  }
  const element = elementForHandle(doc, handle);
  if (!element) {
    return null;
  }
  const { divisions, divisionsPerMeasure } = measureMetrics(doc);
  const sc = staffCountOf(doc);
  const movingStaff = staffOf(element);
  const destLength =
    measureContentDivisions(destMeasureEl) || divisionsPerMeasure;

  // Grace notes and voice attached to the moving note (read before any rewrite,
  // while the element is still in its source measure) so they travel with it.
  const movingNote = readRealNotes(sourceMeasureEl, divisions).find(
    (note) => note.element === element,
  );
  const movingGraces = movingNote?.graces ?? [];
  const movingVoice = movingNote?.voice ?? 1;

  // Pitch change is always a faithful in-place mutation.
  setPitch(doc, element, target.pitch);

  const onsetDivisions = Math.max(
    0,
    Math.min(Math.round(target.onsetBeatInMeasure * divisions), destLength - 1),
  );

  // Destination notes (excluding the moving element, in case the move is within
  // the same measure).
  const destNotes = readRealNotes(destMeasureEl, divisions).filter(
    (note) => note.element !== element,
  );
  // Gap detection looks only at notes in the moving note's own staff — a busier
  // staff alongside it (grand staff) must not shorten this note's duration.
  const nextOnset = destNotes.reduce(
    (min, note) =>
      staffOf(note.element) === movingStaff &&
      note.onsetDivisions > onsetDivisions
        ? Math.min(min, note.onsetDivisions)
        : min,
    destLength,
  );
  const currentDuration = Number.parseInt(
    element.querySelector("duration")?.textContent ?? "4",
    10,
  );
  const fit = largestFit(
    Math.min(currentDuration, nextOnset - onsetDivisions),
    divisions,
  );
  if (fit !== currentDuration) {
    setDuration(doc, element, fit, divisions);
  }

  destNotes.push({
    element,
    onsetDivisions,
    durationDivisions: fit,
    voice: movingVoice,
    graces: movingGraces,
  });
  writeMeasure(doc, destMeasureEl, destNotes, destLength, divisions, sc);
  // A cross-measure move leaves a hole in the source measure to backfill.
  if (sourceMeasureEl !== destMeasureEl) {
    const sourceLength =
      measureContentDivisions(sourceMeasureEl) || divisionsPerMeasure;
    const sourceNotes = readRealNotes(sourceMeasureEl, divisions);
    writeMeasure(
      doc,
      sourceMeasureEl,
      sourceNotes,
      sourceLength,
      divisions,
      sc,
    );
  }
  return handleFor(measuresOf(doc), target.measureIndex, element);
}

// Shared groundwork for setNoteDuration/maxNoteDuration: resolves the anchor
// note, every chord member sharing its onset (in the same staff/voice, since
// chords share one duration intrinsically), and how many divisions are free
// before the next note in that staff/voice (or the measure's end).
function noteDurationContext(
  doc: Document,
  handle: NoteHandle,
): {
  measureEl: Element;
  notes: RealNote[];
  members: RealNote[];
  measureLength: number;
  divisions: number;
  sc: number;
  availableDivisions: number;
} | null {
  const measureEl = measuresOf(doc)[handle.measureIndex];
  if (!measureEl) {
    return null;
  }
  const target = elementForHandle(doc, handle);
  if (!target) {
    return null;
  }
  const { divisions, divisionsPerMeasure } = measureMetrics(doc);
  const measureLength =
    measureContentDivisions(measureEl) || divisionsPerMeasure;
  const notes = readRealNotes(measureEl, divisions);
  const anchor = notes.find((note) => note.element === target);
  if (!anchor) {
    return null;
  }
  const sc = staffCountOf(doc);
  const targetStaff = sc > 1 ? staffOf(target) : 0;
  const targetVoice = anchor.voice;

  const members = notes.filter(
    (note) =>
      note.onsetDivisions === anchor.onsetDivisions &&
      note.voice === targetVoice &&
      (targetStaff === 0 || staffOf(note.element) === targetStaff),
  );
  const memberSet = new Set(members);

  const nextOnset = notes.reduce((min, note) => {
    if (
      memberSet.has(note) ||
      note.voice !== targetVoice ||
      (targetStaff > 0 && staffOf(note.element) !== targetStaff)
    ) {
      return min;
    }
    return note.onsetDivisions > anchor.onsetDivisions
      ? Math.min(min, note.onsetDivisions)
      : min;
  }, measureLength);

  return {
    measureEl,
    notes,
    members,
    measureLength,
    divisions,
    sc,
    availableDivisions: nextOnset - anchor.onsetDivisions,
  };
}

// Change a note's rhythmic duration, keeping its onset and pitch. Every chord
// member sharing the note's onset (in the same staff/voice) is resized with
// it — chords share one duration intrinsically, so the whole beat moves
// together. The requested span is clamped to the largest standard duration
// that fits before the next note in the same staff/voice (or the measure's
// end); the freed or consumed time is rebalanced into rests by `writeMeasure`.
// Returns false on a bad handle.
export function setNoteDuration(
  doc: Document,
  handle: NoteHandle,
  durationBeats: number,
): boolean {
  const ctx = noteDurationContext(doc, handle);
  if (!ctx) {
    return false;
  }
  const requested = Math.max(1, Math.round(durationBeats * ctx.divisions));
  const fit = largestFit(
    Math.min(requested, ctx.availableDivisions),
    ctx.divisions,
  );

  for (const member of ctx.members) {
    setDuration(doc, member.element, fit, ctx.divisions);
    member.durationDivisions = fit;
  }
  writeMeasure(
    doc,
    ctx.measureEl,
    ctx.notes,
    ctx.measureLength,
    ctx.divisions,
    ctx.sc,
  );
  return true;
}

// The largest standard duration (in quarter-note beats) that setNoteDuration
// could actually apply to this note without clamping it back down — the
// Inspector uses this to disable picker options that would silently no-op.
// Returns null on a bad handle.
export function maxNoteDuration(
  doc: Document,
  handle: NoteHandle,
): number | null {
  const ctx = noteDurationContext(doc, handle);
  if (!ctx) {
    return null;
  }
  return largestFit(ctx.availableDivisions, ctx.divisions) / ctx.divisions;
}

// Change a single chord member's duration independently of its chord-mates —
// unlike setNoteDuration (which resizes every note sharing the onset
// together), this touches only the note at `handle`. `writeStaffNotes`
// already re-derives which member leads the group (the longest — see its
// comment) and re-flags `<chord/>` on write, so any member can end up plain
// or `<chord/>`-flagged after this; nothing here needs to track that
// explicitly. Clamped the same way as setNoteDuration: the largest standard
// value that fits before the next note in the same staff/voice. Returns
// false on a bad handle or a note with no chord-mates (nothing to diverge
// a single note's duration from).
export function setChordMemberDuration(
  doc: Document,
  handle: NoteHandle,
  durationBeats: number,
): boolean {
  const ctx = noteDurationContext(doc, handle);
  if (!ctx || ctx.members.length < 2) {
    return false;
  }
  const target = elementForHandle(doc, handle);
  if (!target) {
    return false;
  }
  const member = ctx.members.find((note) => note.element === target);
  if (!member) {
    return false;
  }
  const requested = Math.max(1, Math.round(durationBeats * ctx.divisions));
  const fit = largestFit(
    Math.min(requested, ctx.availableDivisions),
    ctx.divisions,
  );

  setDuration(doc, member.element, fit, ctx.divisions);
  member.durationDivisions = fit;
  writeMeasure(
    doc,
    ctx.measureEl,
    ctx.notes,
    ctx.measureLength,
    ctx.divisions,
    ctx.sc,
  );
  return true;
}

// Set (or clear) the printed alteration on a note's pitch: -1 flat, +1 sharp,
// 0 natural (drops `<alter>`; ±2 for double accidentals). Mutated in place so
// every other child (ties, articulations, lyrics) survives, and no rhythm
// changes so the measure needs no rewrite. Returns false on a bad handle / rest.
export function setAccidental(
  doc: Document,
  handle: NoteHandle,
  alter: number,
): boolean {
  const element = elementForHandle(doc, handle);
  if (!element) {
    return false;
  }
  const pitchEl = element.querySelector("pitch");
  if (!pitchEl) {
    return false;
  }
  const existing = pitchEl.querySelector("alter");
  if (alter === 0) {
    existing?.remove();
  } else if (existing) {
    existing.textContent = String(alter);
  } else {
    // `<alter>` sits between `<step>` and `<octave>`.
    pitchEl.insertBefore(
      child(doc, "alter", String(alter)),
      pitchEl.querySelector("octave"),
    );
  }
  return true;
}

// ── Ties ────────────────────────────────────────────────────────────────────

function pitchesEqual(a: Pitch, b: Pitch): boolean {
  return a.step === b.step && a.alter === b.alter && a.octave === b.octave;
}

// A real note's position for tie-partner search: which measure/onset it
// sounds at and which staff it belongs to, alongside the element and pitch.
interface TieCandidate {
  element: Element;
  measureIndex: number;
  onsetDivisions: number;
  staff: number;
  pitch: Pitch;
}

// Every pitched (non-rest, non-grace) note across the whole document, in
// document order, tagged with its measure/onset/staff/pitch — the sequence a
// tie's start/stop partner search walks.
function tieCandidates(doc: Document): TieCandidate[] {
  const result: TieCandidate[] = [];
  measuresOf(doc).forEach((measureEl, measureIndex) => {
    for (const note of readRealNotes(measureEl, 0)) {
      const pitch = readPitch(note.element);
      if (!pitch) {
        continue;
      }
      result.push({
        element: note.element,
        measureIndex,
        onsetDivisions: note.onsetDivisions,
        staff: staffOf(note.element),
        pitch,
      });
    }
  });
  return result;
}

// The note element a tie from/to `source` would connect to: the first note of
// the same staff, at the next (or previous) distinct onset in document order,
// whose pitch matches exactly. Ties only ever join immediately adjacent
// onsets, so a same-staff onset boundary with no matching pitch means no
// partner. Returns null if `source` isn't found or has no partner.
function findTiePartner(
  doc: Document,
  source: Element,
  direction: "forward" | "backward",
): Element | null {
  const candidates = tieCandidates(doc);
  const sourceIndex = candidates.findIndex((c) => c.element === source);
  if (sourceIndex === -1) {
    return null;
  }
  const src = candidates[sourceIndex];
  const sameStaff = candidates.filter((c) => c.staff === src.staff);
  const srcStaffIndex = sameStaff.findIndex((c) => c.element === source);
  const sequence =
    direction === "forward"
      ? sameStaff.slice(srcStaffIndex + 1)
      : sameStaff.slice(0, srcStaffIndex).reverse();
  const boundary = sequence.find(
    (c) =>
      c.measureIndex !== src.measureIndex ||
      c.onsetDivisions !== src.onsetDivisions,
  );
  if (!boundary) {
    return null;
  }
  const atBoundary = sequence.filter(
    (c) =>
      c.measureIndex === boundary.measureIndex &&
      c.onsetDivisions === boundary.onsetDivisions,
  );
  const match = atBoundary.find((c) => pitchesEqual(c.pitch, src.pitch));
  return match ? match.element : null;
}

function hasTieMark(noteEl: Element, type: "start" | "stop"): boolean {
  return Array.from(noteEl.children).some(
    (c) => c.tagName.toLowerCase() === "tie" && c.getAttribute("type") === type,
  );
}

// Add or remove the paired sound (`<tie>`) and notation (`<notations><tied>`)
// marks for one endpoint of a tie. `<tie>` is inserted right after the last
// existing `<tie>` (or after `<duration>`), matching MusicXML's required child
// order; `<notations><tied>` is appended (reusing an existing `<notations>` if
// the note already carries one, e.g. from articulations).
function setTieMark(
  doc: Document,
  noteEl: Element,
  type: "start" | "stop",
  present: boolean,
): void {
  const existingTie = Array.from(noteEl.children).find(
    (c) => c.tagName.toLowerCase() === "tie" && c.getAttribute("type") === type,
  );
  if (present && !existingTie) {
    const tieEl = doc.createElement("tie");
    tieEl.setAttribute("type", type);
    const ties = Array.from(noteEl.children).filter(
      (c) => c.tagName.toLowerCase() === "tie",
    );
    const anchor = ties[ties.length - 1] ?? noteEl.querySelector("duration");
    if (anchor?.nextSibling) {
      noteEl.insertBefore(tieEl, anchor.nextSibling);
    } else if (anchor) {
      noteEl.appendChild(tieEl);
    } else {
      noteEl.appendChild(tieEl);
    }
  } else if (!present && existingTie) {
    existingTie.remove();
  }

  let notationsEl = Array.from(noteEl.children).find(
    (c) => c.tagName.toLowerCase() === "notations",
  );
  const existingTied =
    notationsEl &&
    Array.from(notationsEl.children).find(
      (c) =>
        c.tagName.toLowerCase() === "tied" && c.getAttribute("type") === type,
    );
  if (present && !existingTied) {
    if (!notationsEl) {
      notationsEl = doc.createElement("notations");
      const lyric = noteEl.querySelector("lyric");
      noteEl.insertBefore(notationsEl, lyric);
    }
    const tiedEl = doc.createElement("tied");
    tiedEl.setAttribute("type", type);
    notationsEl.insertBefore(tiedEl, notationsEl.firstChild);
  } else if (!present && existingTied) {
    existingTied.remove();
    if (notationsEl && notationsEl.children.length === 0) {
      notationsEl.remove();
    }
  }
}

// Toggle a tie on `handle`'s note: if it already ties to its neighbor (in
// either direction — the handle may be the tie's start or stop endpoint),
// remove the tie from both notes; otherwise tie it forward to the next
// same-pitch note on its staff, if one exists at the immediately following
// onset. Mutated in place (no measure rewrite) so every other child survives.
// Returns false on a bad handle, a rest, or a forward tie with no eligible
// partner.
export function toggleTie(doc: Document, handle: NoteHandle): boolean {
  const element = elementForHandle(doc, handle);
  if (!element || !readPitch(element)) {
    return false;
  }

  if (hasTieMark(element, "start")) {
    const partner = findTiePartner(doc, element, "forward");
    setTieMark(doc, element, "start", false);
    if (partner) {
      setTieMark(doc, partner, "stop", false);
    }
    return true;
  }
  if (hasTieMark(element, "stop")) {
    const partner = findTiePartner(doc, element, "backward");
    setTieMark(doc, element, "stop", false);
    if (partner) {
      setTieMark(doc, partner, "start", false);
    }
    return true;
  }

  const partner = findTiePartner(doc, element, "forward");
  if (!partner) {
    return false;
  }
  setTieMark(doc, element, "start", true);
  setTieMark(doc, partner, "stop", true);
  return true;
}

// Mutate a grace note's pitch in place. Grace notes carry no rhythmic span, so
// — unlike `moveNote` — there is no onset/duration to rebalance; a direct
// pitch swap (mirroring `setPitch`) is sufficient. Returns false on a bad
// handle or a handle that isn't actually a grace note.
export function setGracePitch(
  doc: Document,
  handle: NoteHandle,
  pitch: Pitch,
): boolean {
  const element = elementForHandle(doc, handle);
  if (!element || !element.querySelector("grace")) {
    return false;
  }
  setPitch(doc, element, pitch);
  return true;
}

// Remove a single grace note. Grace notes are never tracked by `writeMeasure`'s
// real-note scan — they ride along as a host's buffered `graces` — so a direct
// removal from the DOM (no measure rewrite) is correct and sufficient. Returns
// false on a bad handle or a handle that isn't actually a grace note.
export function removeGraceNote(doc: Document, handle: NoteHandle): boolean {
  const element = elementForHandle(doc, handle);
  if (!element || !element.querySelector("grace")) {
    return false;
  }
  element.remove();
  return true;
}

const isGraceNoteElement = (el: Element): boolean =>
  el.tagName.toLowerCase() === "note" && el.querySelector("grace") !== null;

// The onset group (the simultaneous grace notes at `handle`'s temporal
// position) that `handle` belongs to, plus the groups around it — the shared
// lookup `reorderGrace` and `setGraceSlash` both need. A group is a plain
// grace note plus any following `<chord/>`-flagged notes (they sound
// together); groups are in playback order. Returns null on a bad handle, a
// non-grace handle, or a grace run with no following host note.
function graceGroupsForHandle(
  doc: Document,
  handle: NoteHandle,
): { measureEl: Element; groups: Element[][]; groupIndex: number } | null {
  const measureEl = measuresOf(doc)[handle.measureIndex];
  if (!measureEl) {
    return null;
  }
  const element = elementForHandle(doc, handle);
  if (!element || !element.querySelector("grace")) {
    return null;
  }
  const children = Array.from(measureEl.children);
  const elementIndex = children.indexOf(element);
  if (elementIndex === -1) {
    return null;
  }

  // The host is the next non-grace `<note>` after this run of grace notes.
  let hostIndex = elementIndex + 1;
  while (
    hostIndex < children.length &&
    isGraceNoteElement(children[hostIndex])
  ) {
    hostIndex++;
  }
  if (hostIndex >= children.length) {
    return null;
  }

  // The contiguous run of grace notes immediately before the host, split into
  // onset groups: a plain note plus any following `<chord/>`-flagged notes
  // sound together as one group.
  let runStart = hostIndex;
  while (runStart > 0 && isGraceNoteElement(children[runStart - 1])) {
    runStart--;
  }
  const groups: Element[][] = [];
  for (const note of children.slice(runStart, hostIndex)) {
    if (!note.querySelector("chord") || groups.length === 0) {
      groups.push([note]);
    } else {
      groups[groups.length - 1].push(note);
    }
  }

  const groupIndex = groups.findIndex((group) => group.includes(element));
  return groupIndex === -1 ? null : { measureEl, groups, groupIndex };
}

// Swap a grace note's group (the simultaneous grace notes at its position)
// with the temporally adjacent group — the only way to reorder grace notes
// relative to each other, since their pitch alone carries no rhythmic
// position. `direction` is relative to playback order: "earlier" swaps with
// the group that sounds before this one, "later" with the group after.
// Returns false on a bad handle, a non-grace handle, or no neighbor to swap
// with (already first/last).
export function reorderGrace(
  doc: Document,
  handle: NoteHandle,
  direction: "earlier" | "later",
): boolean {
  const found = graceGroupsForHandle(doc, handle);
  if (!found) {
    return false;
  }
  const { measureEl, groups, groupIndex } = found;
  const neighborIndex =
    direction === "earlier" ? groupIndex - 1 : groupIndex + 1;
  if (neighborIndex < 0 || neighborIndex >= groups.length) {
    return false;
  }

  // Relocate the later group's notes to just before the earlier group's first
  // note — the rest of the run keeps its document order, completing the swap.
  const earlierGroup = groups[Math.min(groupIndex, neighborIndex)];
  const laterGroup = groups[Math.max(groupIndex, neighborIndex)];
  const anchor = earlierGroup[0];
  for (const note of laterGroup) {
    measureEl.insertBefore(note, anchor);
  }
  return true;
}

// Toggle a grace note between acciaccatura (slashed) and appoggiatura
// (unslashed). The slash is one visual mark per group of simultaneous grace
// notes, so it's set on every note in `handle`'s group — matching how the
// parser reads it (the group's slash comes from its first note's `<grace>`
// element) and how the renderer draws it (one slash per `GraceGroup`).
// Returns false on a bad handle or a handle that isn't actually a grace note.
export function setGraceSlash(
  doc: Document,
  handle: NoteHandle,
  slash: boolean,
): boolean {
  const found = graceGroupsForHandle(doc, handle);
  if (!found) {
    return false;
  }
  const group = found.groups[found.groupIndex];
  for (const note of group) {
    note.querySelector("grace")?.setAttribute("slash", slash ? "yes" : "no");
  }
  return true;
}

// Diatonic step index (octave * 7 + step), the staff-position ordinal.
function diatonicOf(pitch: Pitch): number {
  return pitch.octave * 7 + STEPS.indexOf(pitch.step);
}

function pitchFromDiatonic(index: number): Pitch {
  const octave = Math.floor(index / 7);
  const stepIndex = ((index % 7) + 7) % 7;
  return { step: STEPS[stepIndex], alter: 0, octave };
}

// Add a note to the beat (chord) a handle points at — a stacked chord member at
// the same onset and duration. `pitch` defaults to a diatonic third above the
// beat's current top note (a sensible chord-building default). Returns the new
// note's handle, or null on a bad handle.
export function addNoteToChord(
  doc: Document,
  handle: NoteHandle,
  pitch?: Pitch,
): NoteHandle | null {
  const measureEl = measuresOf(doc)[handle.measureIndex];
  if (!measureEl) {
    return null;
  }
  const target = elementForHandle(doc, handle);
  if (!target) {
    return null;
  }
  const { divisions, divisionsPerMeasure } = measureMetrics(doc);
  const measureLength =
    measureContentDivisions(measureEl) || divisionsPerMeasure;
  const notes = readRealNotes(measureEl, divisions);
  const anchor = notes.find((note) => note.element === target);
  if (!anchor) {
    return null;
  }
  // The notes already sounding at this beat, to seed the default pitch above.
  const members = notes.filter(
    (note) => note.onsetDivisions === anchor.onsetDivisions,
  );
  const topDiatonic = members.reduce((max, member) => {
    const memberPitch = readPitch(member.element);
    return memberPitch ? Math.max(max, diatonicOf(memberPitch)) : max;
  }, Number.NEGATIVE_INFINITY);
  const newPitch =
    pitch ??
    (topDiatonic === Number.NEGATIVE_INFINITY
      ? { step: "C", alter: 0, octave: 5 }
      : pitchFromDiatonic(topDiatonic + 2));

  const sc = staffCountOf(doc);
  const anchorStaff = sc > 1 ? staffOf(target) : undefined;
  // Emit <voice> on the element only when voice > 1, so it survives round-trips
  // in multi-voice measures. Voice 1 is the implicit default and can be omitted.
  const anchorVoice = anchor.voice;
  const element = createNoteElement(doc, {
    step: newPitch.step,
    alter: newPitch.alter,
    octave: newPitch.octave,
    durationDivisions: anchor.durationDivisions,
    voice: anchorVoice > 1 ? anchorVoice : undefined,
    staff: anchorStaff,
    divisionsPerQuarter: divisions,
  });
  notes.push({
    element,
    onsetDivisions: anchor.onsetDivisions,
    durationDivisions: anchor.durationDivisions,
    voice: anchorVoice,
    graces: [],
  });
  writeMeasure(doc, measureEl, notes, measureLength, divisions, sc);
  return handleFor(measuresOf(doc), handle.measureIndex, element);
}

// The first ("lead") `<note>` element of the onset group `element` belongs
// to. Chord members are laid out in document order as
// [grace notes…, lead (no `<chord/>`), member2 (`<chord/>`), …] — existing
// grace notes always sit immediately before the lead, regardless of which
// member a handle happens to point at. Walking back over `<chord/>`-flagged
// siblings (stopping at any `<grace>` sibling, which belongs to a different,
// earlier group) finds it from any member.
function leadElementOfChord(measureEl: Element, element: Element): Element {
  const children = Array.from(measureEl.children);
  let index = children.indexOf(element);
  if (index === -1) {
    return element;
  }
  while (
    index > 0 &&
    children[index].querySelector("chord") !== null &&
    children[index].querySelector("grace") === null
  ) {
    index--;
  }
  return children[index];
}

// Add a new grace note immediately before the chord at `handle`'s onset — it
// becomes the temporally-last grace group (closest to the chord); any
// existing grace groups keep their order ahead of it (`reorderGrace` can move
// it earlier). `pitch` defaults to a diatonic step above the chord's current
// top note. Returns the new grace note's handle, or null on a bad handle.
export function addGraceNote(
  doc: Document,
  handle: NoteHandle,
  pitch?: Pitch,
): NoteHandle | null {
  const measureEl = measuresOf(doc)[handle.measureIndex];
  if (!measureEl) {
    return null;
  }
  const target = elementForHandle(doc, handle);
  if (!target) {
    return null;
  }
  const lead = leadElementOfChord(measureEl, target);
  const { divisions } = measureMetrics(doc);
  const notes = readRealNotes(measureEl, divisions);
  const anchor = notes.find((note) => note.element === lead);
  if (!anchor) {
    return null;
  }
  // The notes already sounding at this beat, to seed the default pitch above.
  const members = notes.filter(
    (note) => note.onsetDivisions === anchor.onsetDivisions,
  );
  const topDiatonic = members.reduce((max, member) => {
    const memberPitch = readPitch(member.element);
    return memberPitch ? Math.max(max, diatonicOf(memberPitch)) : max;
  }, Number.NEGATIVE_INFINITY);
  const newPitch =
    pitch ??
    (topDiatonic === Number.NEGATIVE_INFINITY
      ? { step: "C", alter: 0, octave: 5 }
      : pitchFromDiatonic(topDiatonic + 1));

  const sc = staffCountOf(doc);
  const leadStaff = sc > 1 ? staffOf(lead) : undefined;
  const graceEl = doc.createElement("note");
  graceEl.appendChild(doc.createElement("grace"));
  appendPitch(doc, graceEl, newPitch);
  if (anchor.voice > 1) {
    graceEl.appendChild(child(doc, "voice", String(anchor.voice)));
  }
  graceEl.appendChild(child(doc, "type", "16th"));
  if (leadStaff !== undefined) {
    graceEl.appendChild(child(doc, "staff", String(leadStaff)));
  }
  measureEl.insertBefore(graceEl, lead);
  return handleFor(measuresOf(doc), handle.measureIndex, graceEl);
}

// ── Append (from another import) ──────────────────────────────────────────────

export interface AppendResult {
  /** 0-based index of the first measure the appended score contributed. */
  firstAppendedMeasureIndex: number;
  appendedMeasureCount: number;
}

// Rescale every `<duration>` value in a measure (on `<note>`, `<backup>`, and
// `<forward>` elements) from one divisions-per-quarter to another, and update
// the measure's own `<attributes><divisions>` to match, if present. Used when
// appending a score whose divisions differ from the target document's — the
// measure's note spans are otherwise expressed in the wrong units.
function rescaleMeasureDurations(
  measureEl: Element,
  targetDivisions: number,
  sourceDivisions: number,
): void {
  if (targetDivisions === sourceDivisions) {
    return;
  }
  const ratio = targetDivisions / sourceDivisions;
  for (const tag of ["note", "backup", "forward"]) {
    for (const durationEl of Array.from(
      measureEl.querySelectorAll(`${tag} > duration`),
    )) {
      const value = Number.parseInt(durationEl.textContent ?? "0", 10);
      durationEl.textContent = String(Math.max(1, Math.round(value * ratio)));
    }
  }
  const divisionsEl = measureEl.querySelector("attributes > divisions");
  if (divisionsEl) {
    divisionsEl.textContent = String(targetDivisions);
  }
}

// Append every measure of `importedXml` onto the end of `doc`'s (single) part,
// then renumber every measure sequentially — the "append from import" flow:
// several imports (e.g. a series of page screenshots) landing sequentially in
// one document rather than replacing it. Both documents must be in the
// editor's single-part shape (`isEditableDocument`) and declare the same
// staff count (a grand-staff score can only extend with another grand-staff
// score) — anything else returns null rather than guessing a layout. Note
// spans are rescaled if the two documents' `<divisions>` differ; each
// transplanted measure's own `<attributes>` (clef/key/time changes) are kept
// verbatim, since MusicXML allows a mid-score change and this is exactly one.
export function appendScore(
  doc: Document,
  importedXml: string,
): AppendResult | null {
  let sourceDoc: Document;
  try {
    sourceDoc = parseDocument(importedXml);
  } catch {
    return null;
  }
  if (!isEditableDocument(doc) || !isEditableDocument(sourceDoc)) {
    return null;
  }
  const sourceMeasures = measuresOf(sourceDoc);
  const part = doc.querySelector("part");
  if (sourceMeasures.length === 0 || !part) {
    return null;
  }
  if (staffCountOf(sourceDoc) !== staffCountOf(doc)) {
    return null;
  }

  const firstAppendedMeasureIndex = measuresOf(doc).length;
  const { divisions: targetDivisions } = measureMetrics(doc);
  const { divisions: sourceDivisions } = measureMetrics(sourceDoc);

  for (const sourceMeasureEl of sourceMeasures) {
    const imported = doc.importNode(sourceMeasureEl, true);
    rescaleMeasureDurations(imported, targetDivisions, sourceDivisions);
    part.appendChild(imported);
  }

  measuresOf(doc).forEach((measureEl, i) => {
    measureEl.setAttribute("number", String(i + 1));
  });

  return {
    firstAppendedMeasureIndex,
    appendedMeasureCount: sourceMeasures.length,
  };
}

// Insert a blank (full-measure-rest) measure after `afterIndex` (default: the
// end), then renumber every measure sequentially. Returns the new measure's
// index, or null when the part has no measures to anchor against.
export function insertMeasure(
  doc: Document,
  afterIndex?: number,
): number | null {
  const part = doc.querySelector("part");
  const measures = measuresOf(doc);
  if (!part || measures.length === 0) {
    return null;
  }
  const { divisionsPerMeasure } = measureMetrics(doc);
  const sc = staffCountOf(doc);
  const newMeasure = doc.createElement("measure");
  if (sc <= 1) {
    newMeasure.appendChild(
      createRestElement(doc, {
        durationDivisions: divisionsPerMeasure,
        fullMeasure: true,
      }),
    );
  } else {
    // Grand staff: one full-measure rest per staff, separated by <backup>.
    for (let s = 1; s <= sc; s++) {
      newMeasure.appendChild(
        createRestElement(doc, {
          durationDivisions: divisionsPerMeasure,
          fullMeasure: true,
          staff: s,
        }),
      );
      if (s < sc) {
        const backupEl = doc.createElement("backup");
        backupEl.appendChild(
          child(doc, "duration", String(divisionsPerMeasure)),
        );
        newMeasure.appendChild(backupEl);
      }
    }
  }

  const index = afterIndex ?? measures.length - 1;
  const ref = measures[Math.max(0, Math.min(index, measures.length - 1))];
  if (ref.nextSibling) {
    part.insertBefore(newMeasure, ref.nextSibling);
  } else {
    part.appendChild(newMeasure);
  }

  // Renumber all measures 1..N so the inserted one and its successors are right.
  measuresOf(doc).forEach((measureEl, i) => {
    measureEl.setAttribute("number", String(i + 1));
  });
  return index + 1;
}

// ── Copy / cut / paste measure ranges ─────────────────────────────────────────

// A copied measure range: each measure's serialized XML plus enough context
// (source divisions, staff count) to paste it faithfully into a different
// document. Session-only (held in Editor state), not the OS clipboard — so a
// paste only round-trips within this tab, but needs no clipboard permissions
// and carries full MusicXML fidelity (ties/articulations/etc. survive).
export interface MeasureClipboard {
  measuresXml: string[];
  divisionsPerQuarter: number;
  staffCount: number;
}

// Copy measures [startIndex, endIndex] (inclusive, either order) as a
// clipboard payload, or null if the range is empty/out of bounds.
export function copyMeasures(
  doc: Document,
  startIndex: number,
  endIndex: number,
): MeasureClipboard | null {
  const measures = measuresOf(doc);
  const lo = Math.max(0, Math.min(startIndex, endIndex));
  const hi = Math.min(measures.length - 1, Math.max(startIndex, endIndex));
  if (measures.length === 0 || lo > hi) {
    return null;
  }
  const { divisions } = measureMetrics(doc);
  const serializer = new XMLSerializer();
  return {
    measuresXml: measures
      .slice(lo, hi + 1)
      .map((measureEl) => serializer.serializeToString(measureEl)),
    divisionsPerQuarter: divisions,
    staffCount: staffCountOf(doc),
  };
}

// Delete measures [startIndex, endIndex] (inclusive, either order), then
// renumber. Always leaves at least one measure: a range spanning the whole
// part drops its last measure from the deletion instead, since an empty part
// has no sensible blank state to fall back to. Returns the index to reselect
// (the measure that now sits at `lo`, clamped to the new measure count), or
// null if the part has no measures / nothing survives to select.
export function deleteMeasures(
  doc: Document,
  startIndex: number,
  endIndex: number,
): number | null {
  const part = doc.querySelector("part");
  const measures = measuresOf(doc);
  if (!part || measures.length === 0) {
    return null;
  }
  const lo = Math.max(0, Math.min(startIndex, endIndex));
  let hi = Math.min(measures.length - 1, Math.max(startIndex, endIndex));
  if (hi - lo + 1 >= measures.length) {
    hi -= 1;
  }
  if (hi < lo) {
    return null;
  }
  for (const measureEl of measures.slice(lo, hi + 1)) {
    part.removeChild(measureEl);
  }
  const remaining = measuresOf(doc);
  remaining.forEach((measureEl, i) => {
    measureEl.setAttribute("number", String(i + 1));
  });
  return remaining.length === 0 ? null : Math.min(lo, remaining.length - 1);
}

// Insert a copied measure range before `atIndex` (append at the end when
// `atIndex` is past the last measure), rescaling divisions to match this
// document — the same transplant `appendScore` does. Returns null when the
// clipboard's staff count doesn't match this document's (a grand-staff clip
// can't paste into a single-staff score, or vice versa) or the clipboard is
// empty.
export function pasteMeasures(
  doc: Document,
  atIndex: number,
  clipboard: MeasureClipboard,
): { firstPastedIndex: number; pastedCount: number } | null {
  const part = doc.querySelector("part");
  if (!part || clipboard.measuresXml.length === 0) {
    return null;
  }
  if (staffCountOf(doc) !== clipboard.staffCount) {
    return null;
  }
  const { divisions: targetDivisions } = measureMetrics(doc);
  const parser = new DOMParser();
  const inserted: Element[] = [];
  for (const measureXml of clipboard.measuresXml) {
    const wrapped = parser.parseFromString(
      `<wrap>${measureXml}</wrap>`,
      "text/xml",
    );
    const measureEl = wrapped.querySelector("measure");
    if (!measureEl) {
      continue;
    }
    const imported = doc.importNode(measureEl, true);
    rescaleMeasureDurations(
      imported,
      targetDivisions,
      clipboard.divisionsPerQuarter,
    );
    inserted.push(imported);
  }
  if (inserted.length === 0) {
    return null;
  }
  const measures = measuresOf(doc);
  const firstPastedIndex = Math.min(Math.max(0, atIndex), measures.length);
  const anchor = measures[firstPastedIndex] ?? null;
  for (const measureEl of inserted) {
    if (anchor) {
      part.insertBefore(measureEl, anchor);
    } else {
      part.appendChild(measureEl);
    }
  }
  measuresOf(doc).forEach((measureEl, i) => {
    measureEl.setAttribute("number", String(i + 1));
  });
  return { firstPastedIndex, pastedCount: inserted.length };
}

// ── Add / remove staves ───────────────────────────────────────────────────────

// The `<attributes>` element carrying the score-wide declarations (`<staves>`,
// `<clef>`s, `<key>`, `<time>`): the first measure's, created if absent.
function firstAttributes(doc: Document): Element | null {
  const measure = measuresOf(doc)[0];
  if (!measure) {
    return null;
  }
  const existing = measure.querySelector("attributes");
  if (existing) {
    return existing;
  }
  const attributes = doc.createElement("attributes");
  measure.insertBefore(attributes, measure.firstChild);
  return attributes;
}

// Insert a `<clef>` at its canonical spot in `<attributes>` (clefs are the last
// of the ordered attribute children we build, so append after the final clef, or
// at the end when there is none yet). Order among clefs follows staff number.
function insertClef(
  doc: Document,
  attributes: Element,
  number: number,
  sign: "G" | "F",
  line: number,
): void {
  const clefEl = doc.createElement("clef");
  clefEl.setAttribute("number", String(number));
  clefEl.appendChild(child(doc, "sign", sign));
  clefEl.appendChild(child(doc, "line", String(line)));
  const clefs = Array.from(attributes.children).filter(
    (el) => el.tagName.toLowerCase() === "clef",
  );
  const after = clefs[clefs.length - 1];
  if (after?.nextSibling) {
    attributes.insertBefore(clefEl, after.nextSibling);
  } else {
    attributes.appendChild(clefEl);
  }
}

// Set (or create) the `<staves>` count in `<attributes>`. A count of 1 removes
// the element entirely — a single-staff part omits `<staves>`. When creating it,
// `<staves>` sits before the first `<clef>` (its schema position), else at the end.
function setStavesCount(
  doc: Document,
  attributes: Element,
  count: number,
): void {
  const existing = attributes.querySelector("staves");
  if (count <= 1) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.textContent = String(count);
    return;
  }
  const stavesEl = child(doc, "staves", String(count));
  const firstClef = Array.from(attributes.children).find(
    (el) => el.tagName.toLowerCase() === "clef",
  );
  if (firstClef) {
    attributes.insertBefore(stavesEl, firstClef);
  } else {
    attributes.appendChild(stavesEl);
  }
}

// Add a staff to the (single) part, appended below the existing staves — turning
// a single-staff score into a grand staff, or extending an existing grand staff.
// The new staff gets a bass clef when it becomes the second staff (the piano
// convention) and a treble clef otherwise. Every measure gains a full-measure
// rest for it, and notes that had no explicit `<staff>` (a former single-staff
// part) are tagged onto staff 1. Returns the new staff count, or null when there
// is no part/measures to act on.
export function addStaff(doc: Document): number | null {
  const attributes = firstAttributes(doc);
  const measures = measuresOf(doc);
  if (!attributes || measures.length === 0) {
    return null;
  }
  const previousCount = staffCountOf(doc);
  const newCount = previousCount + 1;
  const { divisions, divisionsPerMeasure } = measureMetrics(doc);

  // A former single-staff part may have a lone `<clef>` with no `number`; give it
  // number 1 so the new clef's numbering is unambiguous.
  if (previousCount === 1) {
    const soleClef = attributes.querySelector("clef");
    if (soleClef && !soleClef.getAttribute("number")) {
      soleClef.setAttribute("number", "1");
    }
  }
  setStavesCount(doc, attributes, newCount);
  const newIsBass = newCount === 2;
  insertClef(
    doc,
    attributes,
    newCount,
    newIsBass ? "F" : "G",
    newIsBass ? 4 : 2,
  );

  for (const measureEl of measures) {
    // Tag pre-existing (untagged) notes onto staff 1 so the part is explicitly
    // multi-staff; then rebuild with the new staff required so it gets a rest.
    if (previousCount === 1) {
      for (const noteEl of Array.from(measureEl.querySelectorAll("note"))) {
        if (!noteEl.querySelector("staff")) {
          noteEl.appendChild(child(doc, "staff", "1"));
        }
      }
    }
    const measureLength =
      measureContentDivisions(measureEl) || divisionsPerMeasure;
    const notes = readRealNotes(measureEl, divisions);
    writeMeasure(
      doc,
      measureEl,
      notes,
      measureLength,
      divisions,
      newCount,
      Array.from({ length: newCount }, (_, i) => i + 1),
    );
  }
  return newCount;
}

// Remove a staff from the (single) part. `staff` defaults to the bottom staff.
// Every note/rest on that staff is dropped, staves below it slide up by one, and
// the matching `<clef>` is removed (remaining clefs renumbered). Removing the
// last remaining staff is a no-op — a part must keep at least one. When the
// result is a single staff, `<staves>` and the surviving notes' `<staff>` tags
// are dropped so the part reverts to plain single-staff shape. Returns the new
// staff count, or null when there is nothing to remove.
export function removeStaff(doc: Document, staff?: number): number | null {
  const attributes = firstAttributes(doc);
  const measures = measuresOf(doc);
  if (!attributes || measures.length === 0) {
    return null;
  }
  const previousCount = staffCountOf(doc);
  if (previousCount <= 1) {
    return null;
  }
  const target = staff ?? previousCount;
  if (target < 1 || target > previousCount) {
    return null;
  }
  const newCount = previousCount - 1;
  const { divisions, divisionsPerMeasure } = measureMetrics(doc);

  // Drop the target clef and renumber the rest (staves above `target` shift down).
  for (const clefEl of Array.from(attributes.querySelectorAll("clef"))) {
    const number = Number.parseInt(clefEl.getAttribute("number") ?? "1", 10);
    if (number === target) {
      clefEl.remove();
    } else if (number > target) {
      if (newCount === 1) {
        clefEl.removeAttribute("number");
      } else {
        clefEl.setAttribute("number", String(number - 1));
      }
    } else if (newCount === 1) {
      clefEl.removeAttribute("number");
    }
  }
  setStavesCount(doc, attributes, newCount);

  for (const measureEl of measures) {
    const measureLength =
      measureContentDivisions(measureEl) || divisionsPerMeasure;
    // Keep notes not on the removed staff; slide higher-numbered staves down.
    const kept = readRealNotes(measureEl, divisions).filter(
      (note) => staffOf(note.element) !== target,
    );
    for (const note of kept) {
      const noteStaff = staffOf(note.element);
      const staffEl = note.element.querySelector("staff");
      if (newCount === 1) {
        staffEl?.remove();
      } else if (noteStaff > target && staffEl) {
        staffEl.textContent = String(noteStaff - 1);
      }
    }
    writeMeasure(
      doc,
      measureEl,
      kept,
      measureLength,
      divisions,
      newCount,
      newCount > 1
        ? Array.from({ length: newCount }, (_, i) => i + 1)
        : undefined,
    );
  }
  return newCount;
}
