import type {
  AccidentalKind,
  ChordGroup,
  GraceGroup,
  MeasureEvent,
  NoteType,
  ParsedMeasure,
  ParsedNote,
  ParsedPart,
  ParsedRest,
  ParsedScore,
  Pitch,
  VoiceStream,
} from "./sheet-music-types";

const DIATONIC: Record<string, number> = {
  C: 0,
  D: 1,
  E: 2,
  F: 3,
  G: 4,
  A: 5,
  B: 6,
};

export function diatonicIndex(pitch: Pitch): number {
  return DIATONIC[pitch.step] + pitch.octave * 7;
}

export function parseScore(xml: string): ParsedScore {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("Invalid MusicXML");
  }

  const scorePartEls = Array.from(
    doc.querySelectorAll("part-list > score-part"),
  );
  const partEls = Array.from(doc.querySelectorAll("score-partwise > part"));

  const parts: ParsedPart[] = [];
  scorePartEls.forEach((scorePartEl, i) => {
    const id = scorePartEl.getAttribute("id") ?? `P${i + 1}`;
    const partEl = partEls[i];
    if (!partEl) {
      parts.push(emptyPart(id));
      return;
    }
    // A piano part with two staves (treble + bass) — or any part using <backup>
    // to interleave voices — is split into one ParsedPart per staff. The renderer
    // already stacks parts as vertically aligned staves (a grand staff), and the
    // split-out durations are normalized to NORMALIZED_DIVISIONS per quarter note
    // so the layout and playback derivation need no special casing.
    const staffParts = isMultiStaffPart(partEl)
      ? parseMultiStaffPart(partEl, id)
      : [parseSingleStaffPart(partEl, id)];
    for (const part of staffParts) {
      parts.push(part);
    }
  });

  return { parts, numMeasures: parts[0]?.measures.length ?? 0 };
}

function emptyPart(id: string): ParsedPart {
  return {
    id,
    measures: [],
    clef: { sign: "G", line: 2 },
    timeSig: { beats: 4, beatType: 4 },
    keySig: { fifths: 0, mode: "major" },
  };
}

function parseSingleStaffPart(partEl: Element, id: string): ParsedPart {
  const measures = parseMeasures(partEl);
  const initialClef = measures[0]?.clef ?? { sign: "G", line: 2 };
  resolvePartMeasures(measures);
  resolveClefs(measures, initialClef);
  return {
    id,
    measures,
    clef: initialClef,
    timeSig: measures[0]?.timeSig ?? { beats: 4, beatType: 4 },
    keySig: measures[0]?.keySig ?? { fifths: 0, mode: "major" },
  };
}

// Resolve, for every measure in a single-staff part, the running clef (carried
// forward from the last measure that declared one) and the mid-staff clef
// changes — mirroring the running-key resolution in resolvePartMeasures. On
// entry `measure.clef` holds the clef declared in that measure (or undefined);
// on exit it holds the running clef in effect at the measure's start. Only
// measure-start clef changes are handled here (parseMeasure reads a single clef
// per measure); mid-measure changes are a multi-staff concern.
function resolveClefs(measures: ParsedMeasure[], initialClef: Clef): void {
  let runningClef: Clef = measures[0]?.clef ?? initialClef;
  measures.forEach((measure, m) => {
    const declared = measure.clef;
    if (m === 0) {
      runningClef = declared ?? runningClef;
    } else if (declared && !clefEqual(declared, runningClef)) {
      measure.clefChange = declared;
      runningClef = declared;
    }
    measure.clef = runningClef;
  });
}

// Resolve, for every measure in a part, the running key signature and divisions
// (each carries forward from the last measure that declared one), the mid-staff
// key changes, and the per-measure printed accidentals. Mutates in place.
function resolvePartMeasures(measures: ParsedMeasure[]): void {
  let runningFifths = measures[0]?.keySig?.fifths ?? 0;
  let runningDivisions = measures.find((m) => m.divisions > 0)?.divisions ?? 4;
  measures.forEach((measure, m) => {
    const declared = measure.keySig;
    if (m === 0) {
      runningFifths = declared?.fifths ?? runningFifths;
    } else if (declared && declared.fifths !== runningFifths) {
      measure.keyChange = {
        fifths: declared.fifths,
        prevFifths: runningFifths,
      };
      runningFifths = declared.fifths;
    }
    measure.activeFifths = runningFifths;
    if (measure.divisions > 0) {
      runningDivisions = measure.divisions;
    }
    measure.divisions = runningDivisions;
    assignMeasureAccidentals(measure.voices, runningFifths);
  });
}

function parseMeasures(partEl: Element): ParsedMeasure[] {
  return Array.from(partEl.querySelectorAll("measure")).map((el, m) =>
    parseMeasure(el, m),
  );
}

function parseMeasure(el: Element, measureIndex = 0): ParsedMeasure {
  const number = Number.parseInt(el.getAttribute("number") ?? "1", 10);

  const attrEl = el.querySelector("attributes");
  const timeSig = attrEl ? parseTimeSig(attrEl) : undefined;
  const keySig = attrEl ? parseKeySig(attrEl) : undefined;
  const clef = attrEl ? parseClef(attrEl) : undefined;
  // 0 is a sentinel for "not declared here"; parseScore resolves the running value.
  const divisions = attrEl
    ? Number.parseInt(attrEl.querySelector("divisions")?.textContent ?? "0", 10)
    : 0;

  const rawItems = Array.from(el.querySelectorAll("note")).map(
    (noteEl, noteElementIndex) =>
      parseRawNote(noteEl, { measureIndex, noteElementIndex }),
  );
  const events = groupEvents(rawItems);
  // A single-staff part (no <backup>) is monophonic modulo chords: one voice.
  const voices: VoiceStream[] = [{ voiceIndex: 0, voiceNumber: 1, events }];
  assignNoteIndices(voices);

  const { repeatStart, repeatEnd } = parseBarlines(el);

  // activeFifths is a placeholder here; parseScore resolves the running key
  // across measures and overwrites it.
  return {
    number,
    timeSig,
    keySig,
    clef,
    voices,
    divisions,
    activeFifths: keySig?.fifths ?? 0,
    repeatStart,
    repeatEnd,
  };
}

// Read a measure's <barline> children for repeat markings. A repeat forward
// (start of a repeated section) is conventionally location="left"; a repeat
// backward (end of a repeated section) is conventionally location="right" —
// MusicXML's default location when omitted is "right", so an unlocated
// backward repeat is still treated as the measure's end.
function parseBarlines(measureEl: Element): {
  repeatStart?: boolean;
  repeatEnd?: { times: number };
} {
  let repeatStart: boolean | undefined;
  let repeatEnd: { times: number } | undefined;
  for (const barlineEl of Array.from(measureEl.querySelectorAll("barline"))) {
    const repeatEl = barlineEl.querySelector("repeat");
    const direction = repeatEl?.getAttribute("direction");
    if (direction === "forward") {
      repeatStart = true;
    } else if (direction === "backward") {
      const timesAttr = Number.parseInt(
        repeatEl?.getAttribute("times") ?? "2",
        10,
      );
      repeatEnd = { times: Number.isFinite(timesAttr) ? timesAttr : 2 };
    }
  }
  return { repeatStart, repeatEnd };
}

// Assign noteIndex sequentially to grace groups and ChordGroups (rests don't
// count). Grace groups and regular chords share the same counter so their SVG
// IDs are unique within a measure. The counter runs across *every* voice of the
// measure (in voice order) so two voices never mint the same id.
function assignNoteIndices(voices: VoiceStream[]): void {
  let noteIndex = 0;
  for (const voice of voices) {
    for (const event of voice.events) {
      if (!isRest(event)) {
        for (const gg of event.gracesBefore ?? []) {
          gg.noteIndex = noteIndex++;
        }
        event.noteIndex = noteIndex++;
      }
    }
  }
}

// ── Multi-staff parts (piano grand staff, <backup>, multiple voices) ───────────

// Divisions-per-quarter the layout and renderer assume. Multi-staff durations
// are normalized to this base so existing onset/spacing math works unchanged.
const NORMALIZED_DIVISIONS = 4;

interface StaffItem {
  staff: number;
  /** The MusicXML `<voice>` number (default 1). Groups a staff's notes into
   *  independent rhythmic lines. */
  voice: number;
  /** Onset within the measure, in the file's own divisions. */
  onset: number;
  /** Notated duration in the file's own divisions (0 for grace notes). */
  durationReal: number;
  parsed: ParsedNote | ParsedRest;
  isChord: boolean;
  isGrace: boolean;
}

// A part is multi-staff when it declares more than one <staff> or uses <backup>
// to interleave voices (which the flat single-staff reader cannot place in time).
function isMultiStaffPart(partEl: Element): boolean {
  const staves = partEl.querySelector("staves")?.textContent;
  if (staves && Number.parseInt(staves, 10) > 1) {
    return true;
  }
  return partEl.querySelector("backup") !== null;
}

function clefsByStaff(
  partEl: Element,
  staffCount: number,
): Array<{ sign: "G" | "F"; line: number }> {
  // Default a 2-staff piano part to treble over bass; everything else treble.
  const clefs = Array.from({ length: staffCount }, (_, s) =>
    s === 1 ? { sign: "F" as const, line: 4 } : { sign: "G" as const, line: 2 },
  );
  const seen = new Array<boolean>(staffCount).fill(false);
  for (const clefEl of Array.from(
    partEl.querySelectorAll("attributes > clef"),
  )) {
    const staffIndex =
      Number.parseInt(clefEl.getAttribute("number") ?? "1", 10) - 1;
    if (staffIndex < 0 || staffIndex >= staffCount || seen[staffIndex]) {
      continue;
    }
    const sign = (clefEl.querySelector("sign")?.textContent ?? "G") as
      | "G"
      | "F";
    const line = Number.parseInt(
      clefEl.querySelector("line")?.textContent ?? "2",
      10,
    );
    clefs[staffIndex] = { sign, line };
    seen[staffIndex] = true;
  }
  return clefs;
}

// Walk a measure's children in document order, tracking the MusicXML time cursor
// (advanced by note durations, rewound by <backup>, advanced by <forward>), and
// record every note/rest with the staff it belongs to and its onset.
// `measureIndex` is the 0-based index of this measure within its part; it is
// threaded into the parsed notes as `source.measureIndex` so the editor can
// map a clicked note back to its DOM element.
function collectStaffItems(
  measureEl: Element,
  measureIndex: number,
): StaffItem[] {
  const items: StaffItem[] = [];
  let cursor = 0;
  let lastOnset = 0;
  let noteElementIndex = 0;
  for (const child of Array.from(measureEl.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === "note") {
      const isChord = child.querySelector("chord") !== null;
      const isGrace = child.querySelector("grace") !== null;
      const staff = Number.parseInt(
        child.querySelector("staff")?.textContent ?? "1",
        10,
      );
      const voice = Number.parseInt(
        child.querySelector("voice")?.textContent ?? "1",
        10,
      );
      const durationReal = isGrace
        ? 0
        : Number.parseInt(
            child.querySelector("duration")?.textContent ?? "0",
            10,
          );
      const onset = isChord ? lastOnset : cursor;
      items.push({
        staff,
        voice,
        onset,
        durationReal,
        parsed: parseRawNote(child, { measureIndex, noteElementIndex }),
        isChord,
        isGrace,
      });
      noteElementIndex++;
      if (!isChord && !isGrace) {
        lastOnset = cursor;
        cursor += durationReal;
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
  return items;
}

// A clef declaration within a measure, tagged with the staff it applies to and
// the time cursor (in the file's own divisions) at which it takes effect. A clef
// in the measure's opening <attributes> lands at onset 0; a clef in a later
// <attributes> block (a mid-measure change) lands at the current cursor.
interface ClefChange {
  staff: number;
  onset: number;
  clef: Clef;
}

// Walk a measure's children in document order tracking the same time cursor as
// collectStaffItems, recording every <clef> (with its staff number and onset).
function collectClefChanges(measureEl: Element): ClefChange[] {
  const changes: ClefChange[] = [];
  let cursor = 0;
  for (const child of Array.from(measureEl.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === "note") {
      const isChord = child.querySelector("chord") !== null;
      const isGrace = child.querySelector("grace") !== null;
      if (!isChord && !isGrace) {
        cursor += Number.parseInt(
          child.querySelector("duration")?.textContent ?? "0",
          10,
        );
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
    } else if (tag === "attributes") {
      for (const clefEl of Array.from(child.querySelectorAll("clef"))) {
        const staff = Number.parseInt(clefEl.getAttribute("number") ?? "1", 10);
        changes.push({
          staff,
          onset: cursor,
          clef: parseClefElement(clefEl),
        });
      }
    }
  }
  return changes;
}

function restEvent(duration: number, fullMeasure = false): ParsedRest {
  return { kind: "rest", duration, type: "quarter", dot: false, fullMeasure };
}

// Group a staff's grace notes (which carry no rhythmic time) by the onset of the
// chord they precede, splitting into grace chords on the <chord/> flag.
function graceGroupsByOnset(
  graceItems: StaffItem[],
): Map<number, GraceGroup[]> {
  const byOnset = new Map<number, GraceGroup[]>();
  for (const item of graceItems) {
    const note = item.parsed as ParsedNote;
    const groups = byOnset.get(item.onset) ?? [];
    if (item.isChord && groups.length > 0) {
      groups[groups.length - 1].notes.push(note);
    } else {
      groups.push({
        notes: [note],
        slash: note.grace?.slash ?? false,
        noteIndex: -1,
      });
    }
    byOnset.set(item.onset, groups);
  }
  for (const groups of byOnset.values()) {
    for (const group of groups) {
      group.notes.sort(
        (a, b) => diatonicIndex(a.pitch) - diatonicIndex(b.pitch),
      );
    }
  }
  return byOnset;
}

// Reduce one voice's items to a single onset-ordered event stream: notes
// sharing an onset become a chord, each event's duration is the gap to the next
// onset so the cumulative-duration layout stays aligned, and gaps before the
// first onset / an empty voice become rests.
//
// `contentEndReal` is the maximum (onset + durationReal) within *this voice*
// only; it anchors the last note's duration so it isn't stretched to cover a
// different voice's (or staff's) later content. `globalContentEndReal` is the
// maximum across every voice/staff in the measure; a trailing rest fills any gap
// between the two so every voice's total beat count reaches the measure end
// (required for cursor and highlight timing to agree, and standard notation
// draws the silent tail of a short voice as rests).
function buildStaffEvents(
  items: StaffItem[],
  contentEndReal: number,
  globalContentEndReal: number,
  scale: number,
  // The clef in effect at this staff's measure start, plus the active clef at an
  // arbitrary onset (in the file's own divisions). A ChordGroup is tagged with
  // its clef only when a mid-measure change makes it differ from `startClef`.
  startClef?: Clef,
  clefForOnset?: (onset: number) => Clef,
): MeasureEvent[] {
  if (items.length === 0) {
    return globalContentEndReal > 0
      ? [restEvent(globalContentEndReal * scale, true)]
      : [];
  }

  const graces = graceGroupsByOnset(items.filter((it) => it.isGrace));
  const byOnset = new Map<number, StaffItem[]>();
  for (const item of items) {
    if (item.isGrace) {
      continue;
    }
    const list = byOnset.get(item.onset) ?? [];
    list.push(item);
    byOnset.set(item.onset, list);
  }
  const onsets = [...byOnset.keys()].sort((a, b) => a - b);

  const events: MeasureEvent[] = [];
  if (onsets.length === 0) {
    return globalContentEndReal > 0
      ? [restEvent(globalContentEndReal * scale, true)]
      : [];
  }
  if (onsets[0] > 0) {
    events.push(restEvent(onsets[0] * scale));
  }

  for (let i = 0; i < onsets.length; i++) {
    const onset = onsets[i];
    // Use contentEndReal (not globalContentEndReal) as the terminal anchor
    // for the last note so its duration reflects only this voice's content.
    const nextOnset = i + 1 < onsets.length ? onsets[i + 1] : contentEndReal;
    const duration = Math.max(nextOnset - onset, 0) * scale;
    const group = byOnset.get(onset) ?? [];
    const noteItems = group.filter((it) => it.parsed.kind === "note");

    if (noteItems.length === 0) {
      const rest = group[0].parsed as ParsedRest;
      events.push({
        kind: "rest",
        duration,
        type: rest.type,
        dot: rest.dot,
        fullMeasure: rest.fullMeasure,
      });
      continue;
    }

    const notes = noteItems
      .map((it) => it.parsed as ParsedNote)
      .sort((a, b) => diatonicIndex(a.pitch) - diatonicIndex(b.pitch));
    // The longest note at this onset defines the notehead glyph (its type/dot).
    const representative = noteItems.reduce((best, it) =>
      it.durationReal > best.durationReal ? it : best,
    ).parsed as ParsedNote;
    const activeClef = clefForOnset?.(onset);
    events.push({
      notes,
      duration,
      type: representative.type,
      dot: representative.dot,
      noteIndex: -1,
      gracesBefore: graces.get(onset),
      // Only tag chords whose clef differs from the measure's start clef, so the
      // common (no-change) case keeps `clef` undefined and consumers fall back
      // to `measure.clef`.
      clef:
        activeClef && !clefEqual(activeClef, startClef)
          ? activeClef
          : undefined,
    });
  }

  // If this voice ends before the measure's global content end (because another
  // voice/staff has notes that extend further), append a rest so the total beat
  // count matches every other voice — keeping cursor and highlight timing in sync.
  if (contentEndReal < globalContentEndReal) {
    events.push(restEvent((globalContentEndReal - contentEndReal) * scale));
  }

  return events;
}

function parseMultiStaffPart(partEl: Element, id: string): ParsedPart[] {
  const measureEls = Array.from(partEl.querySelectorAll("measure"));
  const staffCount = Math.max(
    1,
    Number.parseInt(partEl.querySelector("staves")?.textContent ?? "1", 10),
  );
  const clefs = clefsByStaff(partEl, staffCount);
  // The clef in effect entering each measure, per staff — seeded with the
  // initial clefs and advanced by every clef change (including mid-measure ones)
  // as the measures are walked, so a clef declared in one measure carries into
  // the next just like the running key signature does.
  const runningClefByStaff = clefs.map((clef) => ({ ...clef }));
  const measuresByStaff: ParsedMeasure[][] = Array.from(
    { length: staffCount },
    () => [],
  );

  let runningDivisions =
    measureEls
      .map((el) =>
        Number.parseInt(
          el.querySelector("attributes > divisions")?.textContent ?? "0",
          10,
        ),
      )
      .find((d) => d > 0) ?? NORMALIZED_DIVISIONS;

  for (const [mi, measureEl] of measureEls.entries()) {
    const attrEl = measureEl.querySelector("attributes");
    const declaredDivisions = attrEl
      ? Number.parseInt(
          attrEl.querySelector("divisions")?.textContent ?? "0",
          10,
        )
      : 0;
    if (declaredDivisions > 0) {
      runningDivisions = declaredDivisions;
    }
    const number = Number.parseInt(measureEl.getAttribute("number") ?? "1", 10);
    const timeSig = attrEl ? parseTimeSig(attrEl) : undefined;
    const keySig = attrEl ? parseKeySig(attrEl) : undefined;
    const { repeatStart, repeatEnd } = parseBarlines(measureEl);

    const items = collectStaffItems(measureEl, mi);
    const clefChanges = collectClefChanges(measureEl);
    const scale = NORMALIZED_DIVISIONS / runningDivisions;
    const globalContentEndReal = items.reduce(
      (end, it) => Math.max(end, it.onset + it.durationReal),
      0,
    );

    for (let s = 0; s < staffCount; s++) {
      const staffItems = items.filter((it) => it.staff === s + 1);

      // Clef changes for this staff, in time order. A change at onset 0 is the
      // measure's start clef; anything later is a mid-measure change.
      const staffChanges = clefChanges
        .filter((change) => change.staff === s + 1)
        .sort((a, b) => a.onset - b.onset);
      const prevClef = runningClefByStaff[s];
      const startClef =
        staffChanges.length > 0 && staffChanges[0].onset === 0
          ? staffChanges[0].clef
          : prevClef;
      const clefForOnset = (onset: number): Clef => {
        let active = startClef;
        for (const change of staffChanges) {
          if (change.onset <= onset) {
            active = change.clef;
          } else {
            break;
          }
        }
        return active;
      };

      // Split this staff's notes into independent voices, ordered by first
      // appearance (the first voice becomes voiceIndex 0). An empty staff still
      // gets one (empty) voice so it renders a full-measure rest.
      const voiceNumbers: number[] = [];
      for (const it of staffItems) {
        if (!voiceNumbers.includes(it.voice)) {
          voiceNumbers.push(it.voice);
        }
      }
      if (voiceNumbers.length === 0) {
        voiceNumbers.push(1);
      }
      const voices: VoiceStream[] = voiceNumbers.map(
        (voiceNumber, voiceIndex) => {
          const voiceItems = staffItems.filter(
            (it) => it.voice === voiceNumber,
          );
          const voiceContentEndReal = voiceItems.reduce(
            (end, it) => Math.max(end, it.onset + it.durationReal),
            0,
          );
          const events = buildStaffEvents(
            voiceItems,
            voiceContentEndReal,
            globalContentEndReal,
            scale,
            startClef,
            clefForOnset,
          );
          return { voiceIndex, voiceNumber, events };
        },
      );
      assignNoteIndices(voices);
      measuresByStaff[s].push({
        number,
        timeSig,
        keySig,
        clef: startClef,
        // A clef change at the barline (start clef differs from the clef carried
        // in from the previous measure), for the mid-staff clef glyph. The first
        // measure uses the header, so it never gets one.
        clefChange:
          measuresByStaff[s].length > 0 && !clefEqual(startClef, prevClef)
            ? startClef
            : undefined,
        voices,
        divisions: NORMALIZED_DIVISIONS,
        activeFifths: keySig?.fifths ?? 0,
        repeatStart,
        repeatEnd,
      });

      // Carry the last clef in this measure into the next one.
      runningClefByStaff[s] =
        staffChanges.length > 0
          ? staffChanges[staffChanges.length - 1].clef
          : startClef;
    }
  }

  return measuresByStaff.map((measures, s) => {
    resolvePartMeasures(measures);
    const first = measures[0];
    return {
      id: staffCount > 1 ? `${id}-staff${s + 1}` : id,
      measures,
      clef: clefs[s],
      timeSig: first?.timeSig ?? { beats: 4, beatType: 4 },
      keySig: first?.keySig ?? { fifths: 0, mode: "major" },
    };
  });
}

function parseTimeSig(
  el: Element,
): { beats: number; beatType: number } | undefined {
  const timeEl = el.querySelector("time");
  if (!timeEl) {
    return undefined;
  }
  const beats = Number.parseInt(
    timeEl.querySelector("beats")?.textContent ?? "4",
    10,
  );
  const beatType = Number.parseInt(
    timeEl.querySelector("beat-type")?.textContent ?? "4",
    10,
  );
  return { beats, beatType };
}

function parseKeySig(
  el: Element,
): { fifths: number; mode: string } | undefined {
  const keyEl = el.querySelector("key");
  if (!keyEl) {
    return undefined;
  }
  const fifths = Number.parseInt(
    keyEl.querySelector("fifths")?.textContent ?? "0",
    10,
  );
  const mode = keyEl.querySelector("mode")?.textContent ?? "major";
  return { fifths, mode };
}

type Clef = { sign: "G" | "F"; line: number };

function parseClefElement(clefEl: Element): Clef {
  const sign = (clefEl.querySelector("sign")?.textContent ?? "G") as "G" | "F";
  const line = Number.parseInt(
    clefEl.querySelector("line")?.textContent ?? "2",
    10,
  );
  return { sign, line };
}

function parseClef(el: Element): Clef | undefined {
  const clefEl = el.querySelector("clef");
  return clefEl ? parseClefElement(clefEl) : undefined;
}

function clefEqual(a: Clef | undefined, b: Clef | undefined): boolean {
  return a?.sign === b?.sign && a?.line === b?.line;
}

function parseRawNote(
  el: Element,
  source?: { measureIndex: number; noteElementIndex: number },
): ParsedNote | ParsedRest {
  const restEl = el.querySelector("rest");
  const isRestEl = restEl !== null;
  const fullMeasure = restEl?.getAttribute("measure") === "yes";

  // Grace notes have <grace/> instead of (or in addition to) <duration>.
  const graceEl = el.querySelector("grace");
  const isGrace = graceEl !== null;

  // Grace notes carry no rhythmic duration — treat as 0.
  const durationText = el.querySelector("duration")?.textContent;
  const duration = isGrace ? 0 : Number.parseInt(durationText ?? "4", 10);

  const typeText = el.querySelector("type")?.textContent;
  const type: NoteType =
    fullMeasure && !typeText ? "whole" : ((typeText ?? "quarter") as NoteType);

  const dot = el.querySelector("dot") !== null;
  const isChordMember = el.querySelector("chord") !== null;

  if (isRestEl) {
    return { kind: "rest", duration, type, dot, fullMeasure };
  }

  const pitchEl = el.querySelector("pitch");
  const step = (pitchEl?.querySelector("step")?.textContent ??
    "C") as Pitch["step"];
  const alterText = pitchEl?.querySelector("alter")?.textContent;
  const alter = alterText ? Number.parseInt(alterText, 10) : 0;
  const octave = Number.parseInt(
    pitchEl?.querySelector("octave")?.textContent ?? "4",
    10,
  );

  const ties = Array.from(el.querySelectorAll("tie"));
  const tieStart = ties.some((t) => t.getAttribute("type") === "start");
  const tieStop = ties.some((t) => t.getAttribute("type") === "stop");

  const staccato =
    el.querySelector("notations > articulations > staccato") !== null;

  const fermata = el.querySelector("notations > fermata") !== null;

  // Non-standard element emitted by the MIDI-to-MusicXML converter when the
  // actual note duration differs from the display duration (space to next onset).
  const playbackDurationText = el.querySelector("play-duration")?.textContent;
  const playbackDuration = playbackDurationText
    ? Number.parseInt(playbackDurationText, 10)
    : undefined;

  const note: ParsedNote = {
    kind: "note",
    pitch: { step, alter, octave },
    duration,
    type,
    dot,
    tieStart,
    tieStop,
    isChordMember,
    // Provisional; replaced by assignMeasureAccidentals once the measure's
    // running accidental state (and the key signature) are known.
    accidental: "none",
    staccato,
    fermata,
    playbackDuration,
    source,
  };
  if (isGrace) {
    note.grace = { slash: graceEl.getAttribute("slash") === "yes" };
  }
  return note;
}

// Order in which sharps / flats are added by the key signature.
const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER = ["B", "E", "A", "D", "G", "C", "F"];

// The alteration the key signature imposes on a given step (+1 sharp, -1 flat).
export function keyAlterForStep(step: string, fifths: number): number {
  if (fifths > 0) {
    return SHARP_ORDER.slice(0, fifths).includes(step) ? 1 : 0;
  }
  if (fifths < 0) {
    return FLAT_ORDER.slice(0, -fifths).includes(step) ? -1 : 0;
  }
  return 0;
}

// Walk a measure's events in onset order, deciding which notes need a printed
// accidental. The active alteration for each (step, octave) starts at whatever
// the key signature dictates and is updated by every explicit accidental, so a
// pitch sharped earlier in the measure shows a natural when it returns, and a
// repeated sharp is not redrawn.
//
// Grace note groups that precede a chord are processed first (left to right),
// matching their left-to-right display order.
function assignMeasureAccidentals(voices: VoiceStream[], fifths: number): void {
  const active = new Map<string, number>();

  function assignForNotes(notes: ParsedNote[]) {
    for (const note of notes) {
      const key = `${note.pitch.step}${note.pitch.octave}`;
      const current = active.has(key)
        ? (active.get(key) as number)
        : keyAlterForStep(note.pitch.step, fifths);
      const alter = note.pitch.alter;
      if (alter === current) {
        note.accidental = "none";
        continue;
      }
      const glyph: AccidentalKind =
        alter > 0 ? "sharp" : alter < 0 ? "flat" : "natural";
      note.accidental = glyph;
      active.set(key, alter);
    }
  }

  // A printed accidental carries to same (step, octave) notes later in the
  // measure regardless of voice, so the running state is shared across voices
  // and the chords are visited in onset order (ties broken by voice order).
  const chords: Array<{ onset: number; group: ChordGroup }> = [];
  for (const voice of voices) {
    let onset = 0;
    for (const event of voice.events) {
      if (!isRest(event)) {
        chords.push({ onset, group: event });
      }
      onset += event.duration;
    }
  }
  chords.sort((a, b) => a.onset - b.onset);
  for (const { group } of chords) {
    // Grace notes appear visually before the main chord — process them first.
    for (const graceGroup of group.gracesBefore ?? []) {
      assignForNotes(graceGroup.notes);
    }
    assignForNotes(group.notes);
  }
}

function groupEvents(items: Array<ParsedNote | ParsedRest>): MeasureEvent[] {
  const events: MeasureEvent[] = [];
  // Buffer grace notes until we find the main chord they precede.
  const pendingGraceGroups: GraceGroup[] = [];

  let i = 0;
  while (i < items.length) {
    const item = items[i];

    if (item.kind === "rest") {
      // Flush any pending grace notes before the rest (attach to the rest is
      // not supported — discard them; this is an unusual edge case).
      pendingGraceGroups.length = 0;
      events.push(item);
      i++;
      continue;
    }

    // Collect this note plus any immediately following chord members.
    const group: ParsedNote[] = [item];
    i++;
    while (
      i < items.length &&
      items[i].kind === "note" &&
      (items[i] as ParsedNote).isChordMember
    ) {
      group.push(items[i] as ParsedNote);
      i++;
    }

    // Sort low→high by diatonic index
    group.sort((a, b) => diatonicIndex(a.pitch) - diatonicIndex(b.pitch));

    if (group[0].grace) {
      // This is a grace note group. Buffer it until the following main chord.
      pendingGraceGroups.push({
        notes: group,
        slash: group[0].grace.slash,
        noteIndex: -1, // filled by parseMeasure
      });
      continue;
    }

    // Regular chord — attach any buffered grace groups and clear the buffer.
    // The chord's own duration/type mirrors its longest member (chord members
    // may diverge in duration; the longest one is the "lead" note that drives
    // the cursor — see writeStaffNotes), not just the first (lowest-pitch) one.
    // Propagate <play-duration> from that lead note (set by MIDI-to-MusicXML
    // converter when the actual note length differs from the display duration).
    const lead = group.reduce((longest, note) =>
      note.duration > longest.duration ? note : longest,
    );
    const chord: ChordGroup = {
      notes: group,
      duration: lead.duration,
      type: lead.type,
      dot: lead.dot,
      noteIndex: -1, // filled by caller
      gracesBefore:
        pendingGraceGroups.length > 0 ? [...pendingGraceGroups] : undefined,
      playbackDuration: lead.playbackDuration,
    };
    pendingGraceGroups.length = 0;
    events.push(chord);
  }

  // If grace notes appear at the very end of a measure with no following note,
  // discard them (this shouldn't happen in well-formed MusicXML).
  return events;
}

export function isRest(event: MeasureEvent): event is ParsedRest {
  return "kind" in event && event.kind === "rest";
}
