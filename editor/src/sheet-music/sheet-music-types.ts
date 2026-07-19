export interface Pitch {
  step: "C" | "D" | "E" | "F" | "G" | "A" | "B";
  /** Chromatic alteration in semitones: -1 flat, 0 natural, +1 sharp. */
  alter: number;
  octave: number;
}

export type NoteType = "whole" | "half" | "quarter" | "eighth" | "16th";

// Which accidental glyph (if any) to draw before the notehead. Computed per
// measure from the running accidental state, not just the pitch's alter:
// a sharp is only drawn the first time it appears, and a natural is drawn to
// cancel a sharp earlier in the same measure.
export type AccidentalKind = "none" | "sharp" | "flat" | "natural";

export interface ParsedNote {
  kind: "note";
  pitch: Pitch;
  duration: number;
  type: NoteType;
  dot: boolean;
  tieStart: boolean;
  tieStop: boolean;
  isChordMember: boolean;
  accidental: AccidentalKind;
  staccato: boolean;
  /** True when the note (or its chord) carries a fermata (hold) mark. */
  fermata: boolean;
  /** Present when this note is a grace note (appoggiatura or acciaccatura). */
  grace?: { slash: boolean };
  /**
   * Editor-only provenance: which `<note>` element in the source document this
   * parsed note came from. `measureIndex` is the 0-based index of the `<measure>`
   * within its part; `noteElementIndex` is the 0-based index of the `<note>`
   * element within that measure (document order, rests included). Populated by
   * the duplicated single-staff parser — the bridge from a picked on-screen note
   * back to the DOM node the editor must mutate.
   */
  source?: { measureIndex: number; noteElementIndex: number };
  /**
   * Actual sounding duration in the measure's divisions. Set by the parser
   * when the note element contains a `<play-duration>` child (emitted by the
   * MIDI-to-MusicXML converter). Propagated to `ChordGroup.playbackDuration`.
   */
  playbackDuration?: number;
}

export interface ParsedRest {
  kind: "rest";
  duration: number;
  type: NoteType;
  dot: boolean;
  fullMeasure: boolean;
}

/**
 * A group of grace notes (appoggiatura or acciaccatura) that immediately
 * precede a main chord. Grace notes take no rhythmic space — they are rendered
 * to the left of the chord they belong to.
 */
export interface GraceGroup {
  notes: ParsedNote[];
  slash: boolean;
  /** Sequential noteIndex shared with ChordGroup.noteIndex for stable SVG IDs. */
  noteIndex: number;
}

export interface ChordGroup {
  notes: ParsedNote[];
  duration: number;
  type: NoteType;
  dot: boolean;
  noteIndex: number;
  /** Grace note groups that precede this chord, in display order (left to right). */
  gracesBefore?: GraceGroup[];
  /**
   * The clef in effect at this chord's onset, set by the parser only when a
   * mid-measure clef change makes it differ from the measure's start clef
   * (`ParsedMeasure.clef`). Consumers use `clef ?? measure.clef` to position
   * this chord's noteheads. Absent on the common case (no mid-measure change).
   */
  clef?: { sign: "G" | "F"; line: number };
  /**
   * Actual sounding duration in the measure's divisions, when it differs from
   * `duration`. Set by the MIDI-to-MusicXML converter (via `<play-duration>`)
   * when the real note length is shorter than the space to the next onset.
   * `musicXmlToConversion` uses this instead of `duration` when computing
   * per-note `durationBeats` so highlight timing reflects the true note length.
   */
  playbackDuration?: number;
}

export type MeasureEvent = ChordGroup | ParsedRest;

/**
 * One voice's onset-ordered event stream within a staff-measure. A voice is an
 * independent rhythmic line: its `events` durations are the gaps between *its
 * own* onsets (not flattened against other voices sharing the staff), so a
 * sustained whole note in one voice and a moving quarter-note line in another
 * are each rhythmically faithful. The overwhelmingly common single-voice
 * measure has exactly one `VoiceStream`.
 *
 * `voiceIndex` is the 0-based ordinal within the staff (voice 0 renders with
 * up-stems / normal ink, voice 1 with down-stems / a distinguishing tint — the
 * standard two-voice engraving). `voiceNumber` is the source MusicXML `<voice>`
 * number, carried so the editor can route an edit on this stream back to the
 * right `<voice>` in the document.
 */
export interface VoiceStream {
  voiceIndex: number;
  voiceNumber: number;
  events: MeasureEvent[];
}

export interface ParsedMeasure {
  number: number;
  /** Independent rhythmic lines sharing this staff-measure, in voice order.
   *  Single-voice measures carry one stream; see {@link VoiceStream}. */
  voices: VoiceStream[];
  /** Divisions per quarter note in effect for this measure (carried forward
   *  from the last measure that declared one). Resolved by the parser. */
  divisions: number;
  timeSig?: { beats: number; beatType: number };
  /** The key signature declared in this measure's <attributes>, if any. */
  keySig?: { fifths: number; mode: string };
  /** The clef in effect at the start of this measure. During parsing this holds
   *  the clef declared in the measure's first <attributes> (undefined if none);
   *  the parser then resolves it to the running clef carried forward from the
   *  last measure that declared one (like `activeFifths` for key signatures). */
  clef?: { sign: "G" | "F"; line: number };
  /** Present only when this measure starts a new clef different from the running
   *  one (and it isn't the first measure, which uses the header). Drives the
   *  mid-staff clef-change glyph drawn just after the barline. */
  clefChange?: { sign: "G" | "F"; line: number };
  /** The key signature in effect for this measure (carried forward from the
   *  last measure that declared one). Resolved by the parser for every measure. */
  activeFifths: number;
  /** Present only when this measure starts a new key signature different from
   *  the running one (and it isn't the first measure, which uses the header).
   *  Drives the mid-staff key-change rendering (cancel naturals + new accidentals). */
  keyChange?: { fifths: number; prevFifths: number };
  /** `<barline location="left"><repeat direction="forward"/></barline>`: this
   *  measure is the start of a repeated section. */
  repeatStart?: boolean;
  /** `<barline location="right"><repeat direction="backward" times="N"/></barline>`:
   *  this measure is the end of a repeated section, played `times` times total. */
  repeatEnd?: { times: number };
}

export interface ParsedPart {
  id: string;
  measures: ParsedMeasure[];
  clef: { sign: "G" | "F"; line: number };
  timeSig: { beats: number; beatType: number };
  keySig: { fifths: number; mode: string };
}

export interface ParsedScore {
  parts: ParsedPart[];
  numMeasures: number;
}

export interface LayoutConfig {
  staffLineSpacing?: number;
  noteUnitWidth?: number;
  partGap?: number;
  canvasPadding?: number;
  ledgerMargin?: number;
}

/**
 * Shared horizontal rhythm grid for one measure. Onset positions (in divisions)
 * are the union across every part, so a note in any staff that sounds at a given
 * division is drawn at the same x — keeping the staves vertically aligned.
 */
export interface MeasureSpine {
  /** Distinct onset divisions in the measure, ascending (always starts at 0). */
  divs: number[];
  /** Absolute x for each onset in `divs`. */
  xs: number[];
  /** Total divisions in the measure (the closing-barline anchor). */
  endDiv: number;
}

export interface ResolvedLayout {
  staffSpace: number;
  noteUnitWidth: number;
  measureXs: number[];
  measureWidths: number[];
  /** One rhythm spine per measure, shared by all parts (see MeasureSpine). */
  measureSpines: MeasureSpine[];
  staffBottomYs: number[];
  totalWidth: number;
  totalHeight: number;
  /** Vertical space reserved above the first staff / below the last staff for
   *  ledger lines extending past the grand staff. */
  ledgerMargin: number;
}
