import type { MidiData, MidiEvent } from "midi-file";

// The quantization grid the user can choose in the import confirmation
// dialog, expressed as the denominator of the finest notated duration (an
// 8th-, 16th-, or 32nd-note grid).
export type QuantizeGrid = 8 | 16 | 32;

// MusicXML divisions per quarter note for each grid choice (1 division = one
// grid step).
const GRID_DIVISIONS: Record<QuantizeGrid, number> = { 8: 2, 16: 4, 32: 8 };

// Chromatic note names, defaulting to sharps
const NOTE_STEPS = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

// Note-value durations as a fraction of a quarter note, used to derive the
// duration→[type, hasDot] map for a given `divisions` (grid resolution).
const NOTE_TYPE_FACTORS: Array<[string, number]> = [
  ["whole", 4],
  ["half", 2],
  ["quarter", 1],
  ["eighth", 0.5],
  ["16th", 0.25],
  ["32nd", 0.125],
];

// Build the duration(in divisions)→[type, hasDot] map for a given divisions
// (grid) resolution, including dotted values where they land on an integer
// number of divisions. At the default divisions=4 (16th-note grid) this
// reproduces the original fixed table: whole=16, half.=12, half=8,
// quarter.=6, quarter=4, eighth.=3, eighth=2, 16th=1.
function buildDurationType(divisions: number): Map<number, [string, boolean]> {
  const map = new Map<number, [string, boolean]>();
  for (const [type, factor] of NOTE_TYPE_FACTORS) {
    const dur = divisions * factor;
    if (!Number.isInteger(dur) || dur < 1) {
      continue;
    }
    const dotted = dur * 1.5;
    if (Number.isInteger(dotted)) {
      map.set(dotted, [type, true]);
    }
    map.set(dur, [type, false]);
  }
  return map;
}

// Standard grid durations, descending, for greedy rest decomposition /
// duration snapping.
function standardDurations(
  durationType: Map<number, [string, boolean]>,
): number[] {
  return [...durationType.keys()].sort((a, b) => b - a);
}

interface RawNote {
  noteNumber: number;
  startTick: number;
  endTick: number;
  velocity: number;
}

// A note segment within a single measure (after barline splitting)
interface NotePart {
  noteNumber: number;
  startTick: number; // absolute
  durationTicks: number; // within this measure only
  velocity: number;
  tieStop: boolean; // continues from previous measure
  tieStart: boolean; // continues into next measure
}

function noteNumberToPitch(n: number): {
  step: string;
  alter?: number;
  octave: number;
} {
  const name = NOTE_STEPS[n % 12];
  const octave = Math.floor(n / 12) - 1;
  return name.length > 1
    ? { step: name[0], alter: 1, octave }
    : { step: name, octave };
}

// Split a note into segments at every barline it crosses
function splitAtBarlines(note: RawNote, ticksPerMeasure: number): NotePart[] {
  const parts: NotePart[] = [];
  let tick = note.startTick;
  let first = true;
  while (tick < note.endTick) {
    const barEnd = (Math.floor(tick / ticksPerMeasure) + 1) * ticksPerMeasure;
    const segEnd = Math.min(note.endTick, barEnd);
    parts.push({
      noteNumber: note.noteNumber,
      startTick: tick,
      durationTicks: segEnd - tick,
      velocity: note.velocity,
      tieStop: !first,
      tieStart: segEnd < note.endTick,
    });
    tick = segEnd;
    first = false;
  }
  return parts;
}

// Break a grid duration into a sum of standard values (for rests)
function decompose(units: number, durations: number[]): number[] {
  const result: number[] = [];
  let rem = units;
  while (rem > 0) {
    const v = durations.find((d) => d <= rem);
    if (v === undefined) {
      break;
    }
    result.push(v);
    rem -= v;
  }
  return result;
}

function renderNote(
  pitch: { step: string; alter?: number; octave: number } | null,
  dur: number,
  tieStop: boolean,
  tieStart: boolean,
  chord: boolean,
  indent: string,
  durationType: Map<number, [string, boolean]>,
  staccato = false,
  /** When provided, emit a `<play-duration>` child so the parser can store the
   *  actual sounding length separately from the display duration (`dur`).
   *  `musicXmlToConversion` then uses the playback duration for `durationBeats`
   *  instead of the display duration, keeping highlight timing accurate when a
   *  second part has intermediate onsets that advance the cursor. */
  playbackDur?: number,
  /** Set on grand-staff (merged) parts so the parser can route each note to
   *  the correct staff; omitted for ordinary single-staff parts. */
  staffNumber?: number,
): string {
  const [type, dot] = durationType.get(dur) ?? ["quarter", false];
  const i = indent;
  const lines: string[] = [`${i}<note>`];
  if (chord) {
    lines.push(`${i}  <chord/>`);
  }
  if (pitch === null) {
    lines.push(`${i}  <rest/>`);
  } else {
    lines.push(`${i}  <pitch>`);
    lines.push(`${i}    <step>${pitch.step}</step>`);
    if (pitch.alter !== undefined) {
      lines.push(`${i}    <alter>${pitch.alter}</alter>`);
    }
    lines.push(`${i}    <octave>${pitch.octave}</octave>`);
    lines.push(`${i}  </pitch>`);
  }
  lines.push(`${i}  <duration>${dur}</duration>`);
  if (playbackDur !== undefined) {
    lines.push(`${i}  <play-duration>${playbackDur}</play-duration>`);
  }
  if (tieStop) {
    lines.push(`${i}  <tie type="stop"/>`);
  }
  if (tieStart) {
    lines.push(`${i}  <tie type="start"/>`);
  }
  lines.push(`${i}  <type>${type}</type>`);
  if (dot) {
    lines.push(`${i}  <dot/>`);
  }
  if (staffNumber !== undefined) {
    lines.push(`${i}  <staff>${staffNumber}</staff>`);
  }
  const hasNotations = (tieStop || tieStart || staccato) && pitch !== null;
  if (hasNotations) {
    lines.push(`${i}  <notations>`);
    if (tieStop) {
      lines.push(`${i}    <tied type="stop"/>`);
    }
    if (tieStart) {
      lines.push(`${i}    <tied type="start"/>`);
    }
    if (staccato) {
      lines.push(`${i}    <articulations><staccato/></articulations>`);
    }
    lines.push(`${i}  </notations>`);
  }
  lines.push(`${i}</note>`);
  return lines.join("\n");
}

// Emit a grace note (appoggiatura or acciaccatura) — no `<duration>`, type is
// always "eighth". slash=true adds `slash="yes"` to `<grace/>`.
function renderGraceNote(
  pitch: { step: string; alter?: number; octave: number },
  slash: boolean,
  chord: boolean,
  indent: string,
  staffNumber?: number,
): string {
  const i = indent;
  const lines: string[] = [`${i}<note>`];
  if (chord) {
    lines.push(`${i}  <chord/>`);
  }
  lines.push(`${i}  <grace${slash ? ' slash="yes"' : ""}/>`);
  lines.push(`${i}  <pitch>`);
  lines.push(`${i}    <step>${pitch.step}</step>`);
  if (pitch.alter !== undefined) {
    lines.push(`${i}    <alter>${pitch.alter}</alter>`);
  }
  lines.push(`${i}    <octave>${pitch.octave}</octave>`);
  lines.push(`${i}  </pitch>`);
  lines.push(`${i}  <type>eighth</type>`);
  if (staffNumber !== undefined) {
    lines.push(`${i}  <staff>${staffNumber}</staff>`);
  }
  lines.push(`${i}</note>`);
  return lines.join("\n");
}

// A note whose sounding length is at most this fraction of the space until the
// next onset is treated as staccato (detached) and gets a staccato dot.
const STACCATO_RATIO = 0.5;

// Raw MIDI duration thresholds for grace note detection (in ticks).
// A note shorter than GRACE_NOTE_THRESHOLD (≤ 32nd note) that is immediately
// followed by a longer note is classified as a grace note. Notes shorter than
// ACCIACCATURA_THRESHOLD (≤ 64th note) get the acciaccatura slash.
//
// These are expressed as multiples of tpb so they scale with the MIDI file's
// resolution. For the common 480-tpb case:
//   GRACE_NOTE_THRESHOLD  = 480/8  = 60 ticks (32nd note)
//   ACCIACCATURA_THRESHOLD= 480/16 = 30 ticks (64th note)
const GRACE_NOTE_THRESHOLD_FACTOR = 1 / 8; // × tpb
const ACCIACCATURA_THRESHOLD_FACTOR = 1 / 16; // × tpb

// ── Multi-track API ──────────────────────────────────────────────────────────

export function getMidiTempo(midiData: MidiData): number {
  for (const track of midiData.tracks) {
    for (const ev of track) {
      if (ev.type === "setTempo") {
        return Math.round(60_000_000 / ev.microsecondsPerBeat);
      }
    }
  }
  return 120;
}

export interface TrackInfo {
  index: number;
  name: string;
  noteCount: number;
}

// The file's time signature (first `timeSignature` meta event found, latest
// wins if it changes before any notes — mirrors the scan every conversion
// already does), defaulting to 4/4.
function detectTimeSignature(midiData: MidiData): {
  num: number;
  den: number;
} {
  let num = 4;
  let den = 4;
  for (const track of midiData.tracks) {
    for (const ev of track) {
      if (ev.type === "timeSignature") {
        num = ev.numerator;
        den = ev.denominator;
      }
    }
  }
  return { num, den };
}

/** The key signature that would apply at measure 1 if the file specifies one
 *  via a `keySignature` meta event, or null if it doesn't (in which case
 *  `convertMidiToMusicXml`'s `inferKey` option is the only way to get a
 *  non-C-major key). Used by the import confirmation dialog to show what the
 *  file specifies and to grey out the (otherwise ineffective) inference
 *  toggle. */
export function getMidiKeySignature(
  midiData: MidiData,
): { fifths: number; mode: string } | null {
  const tpb = midiData.header.ticksPerBeat ?? 480;
  const { num, den } = detectTimeSignature(midiData);
  const ticksPerMeasure = (tpb * num * 4) / den;
  const { byMeasure, hasExplicitKey } = collectKeyByMeasure(
    midiData,
    ticksPerMeasure,
  );
  return hasExplicitKey ? (byMeasure.get(0) ?? null) : null;
}

// Key names in circle-of-fifths order, fifths -7..7, index = fifths + 7.
const MAJOR_KEY_NAMES = [
  "Cb",
  "Gb",
  "Db",
  "Ab",
  "Eb",
  "Bb",
  "F",
  "C",
  "G",
  "D",
  "A",
  "E",
  "B",
  "F#",
  "C#",
];
const MINOR_KEY_NAMES = [
  "ab",
  "eb",
  "bb",
  "f",
  "c",
  "g",
  "d",
  "a",
  "e",
  "b",
  "f#",
  "c#",
  "g#",
  "d#",
  "a#",
];

/** A human-readable key name for a fifths count + mode, e.g. `keySignatureName(1, "major")` → "G major". */
export function keySignatureName(fifths: number, mode: string): string {
  const clamped = Math.max(-7, Math.min(7, fifths));
  const isMinor = mode === "minor";
  const tonic = (isMinor ? MINOR_KEY_NAMES : MAJOR_KEY_NAMES)[clamped + 7];
  return `${tonic} ${isMinor ? "minor" : "major"}`;
}

export function getMidiTracks(midiData: MidiData): TrackInfo[] {
  const result: TrackInfo[] = [];
  for (let i = 0; i < midiData.tracks.length; i++) {
    const track = midiData.tracks[i];
    let name = `Track ${i + 1}`;
    let noteCount = 0;
    for (const ev of track) {
      if (ev.type === "trackName") {
        name = ev.text || name;
      } else if (ev.type === "noteOn" && ev.velocity > 0) {
        noteCount++;
      }
    }
    if (noteCount > 0) {
      result.push({ index: i, name, noteCount });
    }
  }
  return result;
}

function extractTrackNotes(track: MidiEvent[], tpb: number): RawNote[] {
  const rawNotes: RawNote[] = [];
  let tick = 0;
  const active = new Map<number, { startTick: number; velocity: number }>();
  for (const ev of track) {
    tick += ev.deltaTime;
    if (ev.type === "noteOn" && ev.velocity > 0) {
      active.set(ev.noteNumber, { startTick: tick, velocity: ev.velocity });
    } else if (
      ev.type === "noteOff" ||
      (ev.type === "noteOn" && ev.velocity === 0)
    ) {
      const a = active.get(ev.noteNumber);
      if (a) {
        rawNotes.push({
          noteNumber: ev.noteNumber,
          startTick: a.startTick,
          endTick: tick,
          velocity: a.velocity,
        });
        active.delete(ev.noteNumber);
      }
    }
  }
  return rawNotes;
}

// Map each MIDI key-signature change to the measure it takes effect in. Key
// changes in MIDI fall on (or are snapped down to) a measure boundary. Measure 0
// always has an entry so the first measure's header can be emitted.
// `hasExplicitKey` is false when the file carries no `keySignature` meta event
// at all, i.e. `byMeasure` was filled in with the C-major default rather than
// data from the file — the signal `inferKeyFifthsFromPitches` gates on.
function collectKeyByMeasure(
  midiData: MidiData,
  ticksPerMeasure: number,
): {
  byMeasure: Map<number, { fifths: number; mode: string }>;
  hasExplicitKey: boolean;
} {
  const events: Array<{ tick: number; fifths: number; mode: string }> = [];
  for (const track of midiData.tracks) {
    let tick = 0;
    for (const ev of track) {
      tick += ev.deltaTime;
      if (ev.type === "keySignature") {
        events.push({
          tick,
          fifths: ev.key,
          mode: ev.scale === 0 ? "major" : "minor",
        });
      }
    }
  }
  events.sort((a, b) => a.tick - b.tick);

  const byMeasure = new Map<number, { fifths: number; mode: string }>();
  for (const ev of events) {
    const m = Math.max(0, Math.floor(ev.tick / ticksPerMeasure));
    byMeasure.set(m, { fifths: ev.fifths, mode: ev.mode });
  }
  if (!byMeasure.has(0)) {
    byMeasure.set(0, { fifths: 0, mode: "major" });
  }
  return { byMeasure, hasExplicitKey: events.length > 0 };
}

// The seven pitch classes of a C-major scale (fifths=0); every other major
// key's scale is this set transposed by its circle-of-fifths root.
const MAJOR_SCALE_DEGREES = [0, 2, 4, 5, 7, 9, 11];

function majorScalePitchClasses(fifths: number): Set<number> {
  const root = (((fifths * 7) % 12) + 12) % 12;
  return new Set(MAJOR_SCALE_DEGREES.map((degree) => (root + degree) % 12));
}

/**
 * Infer a major-key signature (as a fifths count, -7..7) from pitch-class
 * content, for MIDI files that carry no `keySignature` meta event. MIDI
 * export from DAWs and keyboards routinely omits key metadata, so notation
 * recovered without this falls back to C major and spells every accidental
 * as a sharp regardless of the piece's actual key. This is a simple
 * best-fit: for each of the 15 major keys, count how many sounding pitch
 * classes fall outside its diatonic scale and pick the fewest mismatches,
 * breaking ties toward fewer sharps/flats (closer to C). It does not
 * attempt minor-key detection — every inferred key is reported as major.
 */
export function inferKeyFifthsFromPitches(noteNumbers: number[]): number {
  if (noteNumbers.length === 0) {
    return 0;
  }
  const pitchClassCounts = new Map<number, number>();
  for (const n of noteNumbers) {
    const pc = ((n % 12) + 12) % 12;
    pitchClassCounts.set(pc, (pitchClassCounts.get(pc) ?? 0) + 1);
  }

  let best = 0;
  let bestMismatches = Number.POSITIVE_INFINITY;
  for (let fifths = -7; fifths <= 7; fifths++) {
    const scale = majorScalePitchClasses(fifths);
    let mismatches = 0;
    for (const [pc, count] of pitchClassCounts) {
      if (!scale.has(pc)) {
        mismatches += count;
      }
    }
    if (
      mismatches < bestMismatches ||
      (mismatches === bestMismatches && Math.abs(fifths) < Math.abs(best))
    ) {
      bestMismatches = mismatches;
      best = fifths;
    }
  }
  return best;
}

function detectClef(notes: RawNote[]): { sign: string; line: number } {
  if (notes.length === 0) {
    return { sign: "G", line: 2 };
  }
  const sorted = notes.map((n) => n.noteNumber).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return median < 60 ? { sign: "F", line: 4 } : { sign: "G", line: 2 };
}

// A grace note extracted before quantization, associated with the main note
// it immediately precedes.
interface GraceNoteInfo {
  noteNumber: number;
  /** Raw (pre-quantization) start tick. */
  rawStartTick: number;
  /** Raw MIDI duration in ticks. */
  rawDurationTicks: number;
  velocity: number;
  slash: boolean; // acciaccatura (true) vs appoggiatura (false)
  /** Raw startTick of the main note this grace note is associated with. */
  mainNoteRawTick: number;
}

/**
 * Identify grace note candidates from raw (unquantized) notes. Returns the
 * grace notes and the remaining regular notes (with grace notes removed).
 *
 * A note is a grace note when:
 *   1. Its raw duration < graceThreshold (≤ 32nd note), AND
 *   2. It is preceded (in time) by either a normal-duration note or a
 *      confirmed grace note — this prevents trill-termination figures from
 *      being misidentified as grace notes, AND
 *   3. There exists a subsequent note starting within one measure that is
 *      not itself a grace note candidate — that note is the "main note".
 * Slash (acciaccatura) is set when duration < acciaccaturaThreshold (≤ 64th).
 *
 * Rule 2 in detail: real grace ornaments always follow a "normal" note
 * (e.g. a quarter or eighth note with duration > graceThreshold).  Multiple
 * grace notes in a group chain: each subsequent candidate may follow another
 * confirmed grace note.  Trill endings look like clusters of short notes
 * preceded by the last trill repeat note which sits exactly at the threshold
 * — those are rejected because their predecessor has duration ≤ graceThreshold
 * and is not itself a confirmed grace.
 */
function detectGraceNotes(
  rawNotes: RawNote[],
  tpb: number,
  ticksPerMeasure: number,
): { graces: GraceNoteInfo[]; regulars: RawNote[] } {
  const graceThreshold = tpb * GRACE_NOTE_THRESHOLD_FACTOR;
  const acciaccaturaThreshold = tpb * ACCIACCATURA_THRESHOLD_FACTOR;

  // Sort by start tick for sequential processing.
  const sorted = [...rawNotes].sort(
    (a, b) => a.startTick - b.startTick || a.noteNumber - b.noteNumber,
  );

  // First pass: flag all notes shorter than the grace threshold as candidates.
  const isCandidate = sorted.map(
    (n) => n.endTick - n.startTick < graceThreshold,
  );

  const graces: GraceNoteInfo[] = [];
  const graceIndices = new Set<number>();

  // Second pass: confirm each candidate.
  for (let i = 0; i < sorted.length; i++) {
    if (!isCandidate[i]) {
      continue;
    }
    const grace = sorted[i];

    // --- Rule 2: predecessor check ---
    // Find the tick of the event that starts strictly before this candidate.
    let prevTick = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (sorted[j].startTick < grace.startTick) {
        prevTick = sorted[j].startTick;
        break;
      }
    }

    if (prevTick >= 0) {
      // Examine all notes that share that preceding tick (a potential chord).
      // The candidate is accepted if ANY predecessor is:
      //   a) a normal-duration note (dur > graceThreshold), or
      //   b) a confirmed grace note (chaining).
      let validPredecessor = false;
      for (let j = i - 1; j >= 0; j--) {
        if (sorted[j].startTick !== prevTick) {
          break;
        }
        const prevDur = sorted[j].endTick - sorted[j].startTick;
        if (prevDur > graceThreshold || graceIndices.has(j)) {
          validPredecessor = true;
          break;
        }
      }
      if (!validPredecessor) {
        continue; // trill-ending or other short-note cluster — skip
      }
    }
    // (If there is no preceding note at all, allow the candidate — it is the
    // first note in the track, which can legitimately be a grace note.)

    // --- Rule 3: following main note check ---
    let mainIdx = -1;
    for (let j = i + 1; j < sorted.length; j++) {
      if (
        !isCandidate[j] &&
        sorted[j].startTick <= grace.startTick + ticksPerMeasure
      ) {
        mainIdx = j;
        break;
      }
    }
    if (mainIdx === -1) {
      continue; // no following main note — keep as regular
    }

    graceIndices.add(i);
    const rawDurationTicks = grace.endTick - grace.startTick;
    graces.push({
      noteNumber: grace.noteNumber,
      rawStartTick: grace.startTick,
      rawDurationTicks,
      velocity: grace.velocity,
      slash: rawDurationTicks < acciaccaturaThreshold,
      mainNoteRawTick: sorted[mainIdx].startTick,
    });
  }

  const regulars = sorted.filter((_, i) => !graceIndices.has(i));
  return { graces, regulars };
}

// Quantize and split each raw note at barlines, then render one measure's
// worth of `<note>`/`<backup>`-free body lines per measure — no `<attributes>`,
// which the caller emits once (single-staff) or shared across two staves
// (grand staff). `staffNumber`, when given, tags every note/rest `<staff>`.
function buildMeasureBody(
  rawNotes: RawNote[],
  graceNotes: GraceNoteInfo[],
  tpb: number,
  timeSigNum: number,
  timeSigDen: number,
  divisions: number,
  durationType: Map<number, [string, boolean]>,
  numMeasures: number,
  staffNumber?: number,
): string[][] {
  const durations = standardDurations(durationType);
  const grid = tpb / divisions;
  const snap = (t: number) => Math.round(t / grid) * grid;
  const quantized: RawNote[] = rawNotes.map((n) => {
    const s = snap(n.startTick);
    const e = Math.max(s + grid, snap(n.endTick));
    return { ...n, startTick: s, endTick: e };
  });

  const ticksPerMeasure = (tpb * timeSigNum * 4) / timeSigDen;

  const parts: NotePart[] = quantized
    .flatMap((n) => splitAtBarlines(n, ticksPerMeasure))
    .sort((a, b) => a.startTick - b.startTick || a.noteNumber - b.noteNumber);

  // Build a map from the quantized tick of each grace note's main note to the
  // list of grace notes that precede it, sorted by rawStartTick (ascending so
  // the leftmost grace note is first in display order).
  const gracesByQuantizedMainTick = new Map<number, GraceNoteInfo[]>();
  for (const g of graceNotes) {
    const quantizedMain = snap(g.mainNoteRawTick);
    const list = gracesByQuantizedMainTick.get(quantizedMain) ?? [];
    list.push(g);
    gracesByQuantizedMainTick.set(quantizedMain, list);
  }
  // Sort each group so grace notes appear in onset order (left to right).
  for (const list of gracesByQuantizedMainTick.values()) {
    list.sort((a, b) => a.rawStartTick - b.rawStartTick);
  }

  const ind = "    ";
  const measures: string[][] = [];

  for (let m = 0; m < numMeasures; m++) {
    const mStart = m * ticksPerMeasure;
    const mEnd = mStart + ticksPerMeasure;
    const mParts = parts.filter(
      (p) => p.startTick >= mStart && p.startTick < mEnd,
    );
    const lines: string[] = [];

    let cursor = mStart;
    let i = 0;

    while (i < mParts.length) {
      const startTick = mParts[i].startTick;
      if (startTick > cursor) {
        const restGrid = Math.round((startTick - cursor) / grid);
        for (const d of decompose(restGrid, durations)) {
          lines.push(
            renderNote(
              null,
              d,
              false,
              false,
              false,
              ind,
              durationType,
              false,
              undefined,
              staffNumber,
            ),
          );
        }
      }

      let j = i;
      while (j < mParts.length && mParts[j].startTick === startTick) {
        j++;
      }
      const chord = mParts.slice(i, j);

      // Emit any grace notes that precede this chord (keyed by its quantized
      // start tick). Each grace note group is a single note (chord=false for
      // the first, chord=true for subsequent notes at the same grace onset).
      const graceList = gracesByQuantizedMainTick.get(startTick);
      if (graceList) {
        // Group grace notes that share the same rawStartTick into chords.
        let gi = 0;
        while (gi < graceList.length) {
          const graceStart = graceList[gi].rawStartTick;
          // Collect all grace notes at this same raw onset.
          let gj = gi;
          while (
            gj < graceList.length &&
            graceList[gj].rawStartTick === graceStart
          ) {
            gj++;
          }
          const graceChord = graceList.slice(gi, gj);
          // All notes in a grace chord share the same slash value (from first).
          const slash = graceChord[0].slash;
          // Sort the chord by note number (low → high).
          graceChord.sort((a, b) => a.noteNumber - b.noteNumber);
          for (let gk = 0; gk < graceChord.length; gk++) {
            const g = graceChord[gk];
            lines.push(
              renderGraceNote(
                noteNumberToPitch(g.noteNumber),
                slash,
                gk > 0, // chord member for all but the first
                ind,
                staffNumber,
              ),
            );
          }
          gi = gj;
        }
      }

      // The space to the next chord determines the visual notehead type so
      // that short MIDI note-off times (performance articulation) don't create
      // spurious rests in the notation.  However, `<duration>` uses the actual
      // quantized note length so that `musicXmlToConversion` derives correct
      // per-note `durationBeats` for highlighting — especially when a second
      // part has intermediate onsets that advance the cursor past this note's
      // X position before the space-to-next-onset expires.
      const nextStartTick = j < mParts.length ? mParts[j].startTick : mEnd;
      const spaceGrid = Math.round((nextStartTick - startTick) / grid);
      const displayDur = durations.find((d) => d <= spaceGrid) ?? 1;

      // Actual quantized note duration (from MIDI durationTicks), capped to the
      // space available so it never exceeds the next onset.
      const actualDurGrid = Math.round(chord[0].durationTicks / grid);
      const rhythmicDur =
        durations.find((d) => d <= Math.min(actualDurGrid, spaceGrid)) ?? 1;

      for (let k = 0; k < chord.length; k++) {
        const p = chord[k];
        const pitch = noteNumberToPitch(p.noteNumber);
        // The note is staccato when it sounds for much less than the space
        // until the next onset (displayDur). Tied segments are never staccato.
        const staccato =
          !p.tieStart &&
          !p.tieStop &&
          p.durationTicks <= displayDur * grid * STACCATO_RATIO;
        // When the actual sounding length is shorter than the display slot,
        // emit <play-duration> so musicXmlToConversion can use the real length
        // for durationBeats without an explicit rest disturbing the spine.
        // `displayDur` is always used for <duration> to keep beatCursor
        // advancement (and thus subsequent note startBeats) correct.
        const playbackDur = rhythmicDur < displayDur ? rhythmicDur : undefined;
        lines.push(
          renderNote(
            pitch,
            displayDur,
            p.tieStop,
            p.tieStart,
            k > 0,
            ind,
            durationType,
            staccato,
            playbackDur,
            staffNumber,
          ),
        );
      }

      // Advance cursor by the display duration (space to next onset in this
      // part). No explicit rests are needed: the <play-duration> element tells
      // musicXmlToConversion the actual note length, and beatCursor still
      // advances correctly via <duration>=displayDur.
      cursor = startTick + displayDur * grid;
      i = j;
    }

    if (cursor < mEnd) {
      const restGrid = Math.round((mEnd - cursor) / grid);
      for (const d of decompose(restGrid, durations)) {
        lines.push(
          renderNote(
            null,
            d,
            false,
            false,
            false,
            ind,
            durationType,
            false,
            undefined,
            staffNumber,
          ),
        );
      }
    }

    measures.push(lines);
  }

  return measures;
}

// The key `<attributes>` change common to both single- and grand-staff parts:
// a full block in measure 1, then a key-only block wherever the key changes.
function keyAttributesLines(
  m: number,
  keyByMeasure: Map<number, { fifths: number; mode: string }>,
  runningFifthsRef: { value: number },
  ind: string,
): string[] {
  if (m > 0) {
    const k = keyByMeasure.get(m);
    if (k && k.fifths !== runningFifthsRef.value) {
      runningFifthsRef.value = k.fifths;
      return [
        `${ind}<attributes><key><fifths>${k.fifths}</fifths><mode>${k.mode}</mode></key></attributes>`,
      ];
    }
  }
  return [];
}

function buildPartMeasuresXml(
  rawNotes: RawNote[],
  graceNotes: GraceNoteInfo[],
  tpb: number,
  timeSigNum: number,
  timeSigDen: number,
  divisions: number,
  durationType: Map<number, [string, boolean]>,
  keyByMeasure: Map<number, { fifths: number; mode: string }>,
  clef: { sign: string; line: number },
  numMeasures: number,
): string[] {
  const bodies = buildMeasureBody(
    rawNotes,
    graceNotes,
    tpb,
    timeSigNum,
    timeSigDen,
    divisions,
    durationType,
    numMeasures,
  );

  const ind = "    ";
  const initialKey = keyByMeasure.get(0) ?? { fifths: 0, mode: "major" };
  const runningFifths = { value: initialKey.fifths };
  const measureXml: string[] = [];

  for (let m = 0; m < numMeasures; m++) {
    const lines: string[] = [];
    if (m === 0) {
      lines.push(
        `${ind}<attributes>`,
        `${ind}  <divisions>${divisions}</divisions>`,
        `${ind}  <key><fifths>${initialKey.fifths}</fifths><mode>${initialKey.mode}</mode></key>`,
        `${ind}  <time><beats>${timeSigNum}</beats><beat-type>${timeSigDen}</beat-type></time>`,
        `${ind}  <clef><sign>${clef.sign}</sign><line>${clef.line}</line></clef>`,
        `${ind}</attributes>`,
      );
    } else {
      lines.push(...keyAttributesLines(m, keyByMeasure, runningFifths, ind));
    }
    lines.push(...bodies[m]);
    measureXml.push(
      `  <measure number="${m + 1}">\n${lines.join("\n")}\n  </measure>`,
    );
  }

  return measureXml;
}

// A single piano part split across two staves (treble/bass) by pitch, the
// shape `isEditableDocument` (editor/src/dom-edit.ts) recognizes as editable:
// one `<backup>` per measure rewinding from staff 1 to staff 2.
function buildGrandStaffMeasuresXml(
  trebleNotes: RawNote[],
  trebleGraces: GraceNoteInfo[],
  bassNotes: RawNote[],
  bassGraces: GraceNoteInfo[],
  tpb: number,
  timeSigNum: number,
  timeSigDen: number,
  divisions: number,
  durationType: Map<number, [string, boolean]>,
  keyByMeasure: Map<number, { fifths: number; mode: string }>,
  numMeasures: number,
): string[] {
  const trebleBodies = buildMeasureBody(
    trebleNotes,
    trebleGraces,
    tpb,
    timeSigNum,
    timeSigDen,
    divisions,
    durationType,
    numMeasures,
    1,
  );
  const bassBodies = buildMeasureBody(
    bassNotes,
    bassGraces,
    tpb,
    timeSigNum,
    timeSigDen,
    divisions,
    durationType,
    numMeasures,
    2,
  );
  const measureDivisions = (divisions * timeSigNum * 4) / timeSigDen;

  const ind = "    ";
  const initialKey = keyByMeasure.get(0) ?? { fifths: 0, mode: "major" };
  const runningFifths = { value: initialKey.fifths };
  const measureXml: string[] = [];

  for (let m = 0; m < numMeasures; m++) {
    const lines: string[] = [];
    if (m === 0) {
      lines.push(
        `${ind}<attributes>`,
        `${ind}  <divisions>${divisions}</divisions>`,
        `${ind}  <key><fifths>${initialKey.fifths}</fifths><mode>${initialKey.mode}</mode></key>`,
        `${ind}  <time><beats>${timeSigNum}</beats><beat-type>${timeSigDen}</beat-type></time>`,
        `${ind}  <staves>2</staves>`,
        `${ind}  <clef number="1"><sign>G</sign><line>2</line></clef>`,
        `${ind}  <clef number="2"><sign>F</sign><line>4</line></clef>`,
        `${ind}</attributes>`,
      );
    } else {
      lines.push(...keyAttributesLines(m, keyByMeasure, runningFifths, ind));
    }
    lines.push(...trebleBodies[m]);
    lines.push(
      `${ind}<backup>`,
      `${ind}  <duration>${measureDivisions}</duration>`,
      `${ind}</backup>`,
    );
    lines.push(...bassBodies[m]);
    measureXml.push(
      `  <measure number="${m + 1}">\n${lines.join("\n")}\n  </measure>`,
    );
  }

  return measureXml;
}

// ── Import confirmation options ──────────────────────────────────────────────

export interface MidiImportOptions {
  /** Track indices (into `midiData.tracks`) to include. */
  trackIndices: number[];
  /** Quantization grid, as the denominator of the finest notated duration. */
  quantizeGrid: QuantizeGrid;
  /** Combine every selected track's notes into one piano part, split across
   *  two staves by pitch at `splitPoint`, instead of one part per track. */
  mergeTracks: boolean;
  /** MIDI note number (60 = middle C): notes at or above go to the treble
   *  staff, below go to the bass staff. Only used when `mergeTracks`. */
  splitPoint: number;
  /** When the MIDI file carries no `keySignature` meta event, infer a major
   *  key from the selected tracks' pitch content instead of defaulting to C
   *  major (see `inferKeyFifthsFromPitches`). */
  inferKey: boolean;
}

export const DEFAULT_MIDI_IMPORT_OPTIONS: Omit<
  MidiImportOptions,
  "trackIndices"
> = {
  quantizeGrid: 16,
  mergeTracks: false,
  splitPoint: 60,
  inferKey: true,
};

export function convertMidiToMusicXml(
  midiData: MidiData,
  options: MidiImportOptions,
): string {
  const { trackIndices, quantizeGrid, mergeTracks, splitPoint, inferKey } =
    options;
  const tpb = midiData.header.ticksPerBeat ?? 480;
  const divisions = GRID_DIVISIONS[quantizeGrid];
  const durationType = buildDurationType(divisions);
  const { num: timeSigNum, den: timeSigDen } = detectTimeSignature(midiData);

  const grid = tpb / divisions;
  const snap = (t: number) => Math.round(t / grid) * grid;
  const ticksPerMeasure = (tpb * timeSigNum * 4) / timeSigDen;
  const { byMeasure: keyByMeasureRaw, hasExplicitKey } = collectKeyByMeasure(
    midiData,
    ticksPerMeasure,
  );

  // Extract raw notes per track, then detect grace notes *before* quantization
  // so the short-duration ornament notes are identified from the true MIDI data.
  const rawTrackNotes = trackIndices.map((idx) =>
    extractTrackNotes(midiData.tracks[idx], tpb),
  );

  // Detect and remove grace notes from each track's raw notes, then quantize.
  const trackGraceNotes = rawTrackNotes.map((raw) =>
    detectGraceNotes(raw, tpb, ticksPerMeasure),
  );

  const quantizeAll = (notes: RawNote[]) =>
    notes.map((n) => {
      const s = snap(n.startTick);
      const e = Math.max(s + grid, snap(n.endTick));
      return { ...n, startTick: s, endTick: e };
    });

  const trackNotes = trackGraceNotes.map(({ regulars }) =>
    quantizeAll(regulars),
  );
  const allNotes = trackNotes.flat();

  // Key: explicit from the MIDI file if present; otherwise, when requested,
  // inferred from the pitch content of the selected tracks. Falls back to C
  // major (the `collectKeyByMeasure` default) either way.
  let keyByMeasure = keyByMeasureRaw;
  if (!hasExplicitKey && inferKey && allNotes.length > 0) {
    const inferredFifths = inferKeyFifthsFromPitches(
      allNotes.map((n) => n.noteNumber),
    );
    keyByMeasure = new Map(keyByMeasureRaw);
    keyByMeasure.set(0, { fifths: inferredFifths, mode: "major" });
  }
  const initialKey = keyByMeasure.get(0) ?? { fifths: 0, mode: "major" };

  if (allNotes.length === 0) {
    return emptyScore(
      initialKey.fifths,
      initialKey.mode,
      timeSigNum,
      timeSigDen,
      divisions,
    );
  }

  const totalTicks = Math.max(...allNotes.map((n) => n.endTick));
  const numMeasures = Math.ceil(totalTicks / ticksPerMeasure);

  if (mergeTracks) {
    // Merge selected tracks' raw (pre-quantized) notes and split by pitch
    // into a two-staff piano part; grace-note detection runs once per staff
    // pool so ornaments split correctly alongside their main note.
    const mergedRaw = rawTrackNotes.flat();
    const trebleRaw = mergedRaw.filter((n) => n.noteNumber >= splitPoint);
    const bassRaw = mergedRaw.filter((n) => n.noteNumber < splitPoint);
    const treble = detectGraceNotes(trebleRaw, tpb, ticksPerMeasure);
    const bass = detectGraceNotes(bassRaw, tpb, ticksPerMeasure);

    const measureXml = buildGrandStaffMeasuresXml(
      quantizeAll(treble.regulars),
      treble.graces,
      quantizeAll(bass.regulars),
      bass.graces,
      tpb,
      timeSigNum,
      timeSigDen,
      divisions,
      durationType,
      keyByMeasure,
      numMeasures,
    );

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1">
      <part-name>Piano</part-name>
    </score-part>
  </part-list>
  <part id="P1">
${measureXml.join("\n")}
  </part>
</score-partwise>`;
  }

  const trackNames = getMidiTracks(midiData).reduce<Record<number, string>>(
    (acc, t) => {
      acc[t.index] = t.name;
      return acc;
    },
    {},
  );

  const partEntries = trackIndices.map((idx, i) => {
    const clef = detectClef(trackNotes[i]);
    const measureXml = buildPartMeasuresXml(
      trackNotes[i],
      trackGraceNotes[i].graces,
      tpb,
      timeSigNum,
      timeSigDen,
      divisions,
      durationType,
      keyByMeasure,
      clef,
      numMeasures,
    );
    return {
      id: `P${i + 1}`,
      name: trackNames[idx] ?? `Track ${idx + 1}`,
      measuresXml: measureXml,
    };
  });

  const partList = partEntries
    .map(
      (p) =>
        `    <score-part id="${p.id}">\n      <part-name>${p.name}</part-name>\n    </score-part>`,
    )
    .join("\n");
  const parts = partEntries
    .map((p) => `  <part id="${p.id}">\n${p.measuresXml.join("\n")}\n  </part>`)
    .join("\n");

  const musicxml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <part-list>
${partList}
  </part-list>
${parts}
</score-partwise>`;

  return musicxml;
}

/** Back-compat convenience wrapper: one part per track, 16th-note grid, no
 *  merge, no pitch-based key inference (matches this function's pre-options
 *  behavior exactly). */
export function midiToMusicXmlWithTracks(
  midiData: MidiData,
  trackIndices: number[],
): string {
  return convertMidiToMusicXml(midiData, {
    trackIndices,
    quantizeGrid: 16,
    mergeTracks: false,
    splitPoint: 60,
    inferKey: false,
  });
}

function emptyScore(
  keyFifths: number,
  keyMode: string,
  timeSigNum: number,
  timeSigDen: number,
  divisions: number,
): string {
  const fullMeasureDur = timeSigNum * divisions;
  return scoreTemplate(
    `  <measure number="1">
    <attributes>
      <divisions>${divisions}</divisions>
      <key><fifths>${keyFifths}</fifths><mode>${keyMode}</mode></key>
      <time><beats>${timeSigNum}</beats><beat-type>${timeSigDen}</beat-type></time>
      <clef><sign>G</sign><line>2</line></clef>
    </attributes>
    <note><rest measure="yes"/><duration>${fullMeasureDur}</duration></note>
  </measure>`,
  );
}

function scoreTemplate(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1">
      <part-name>Piano</part-name>
    </score-part>
  </part-list>
  <part id="P1">
${body}
  </part>
</score-partwise>`;
}
