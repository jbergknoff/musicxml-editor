// Editor shell: owns the live MusicXML Document, the selection, import/export,
// and playback. The Document is the source of truth (held in a ref); a `version`
// counter forces a re-render after each in-place mutation, and the serialized
// string is recomputed from it.
//
// Interaction is selection-first and keyboard-driven (per the Claude Design
// handoff): a click selects the whole chord at a beat (Level 1); a second click
// on a notehead — or Enter — drills to a single note (Level 2); Esc steps back
// out. The right-hand inspector mirrors the selection and edits pitch /
// accidental / chord membership with discrete commands. Arrow keys re-pitch the
// drilled note (↑/↓) or move between beats (←/→); A–G add a note; -/=/0 set
// accidentals; Space plays/stops. A plain drag only scrolls the staff.

import { parseMidi } from "midi-file";
import type { MidiData } from "midi-file";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import {
  type TrackInfo,
  convertMidiToMusicXml,
  getMidiKeySignature,
  getMidiTempo,
  getMidiTracks,
} from "../../lib/midi-to-musicxml";
import { extractMusicXmlFromMxl } from "../../lib/mxl";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import {
  type ContextMenuRequest,
  EditableSheetMusic,
  type EditorGesture,
} from "./components/EditableSheetMusic";
import {
  type ImageImportChoice,
  ImageImportDialog,
} from "./components/ImageImportDialog";
import { ImportReviewPanel } from "./components/ImportReviewPanel";
import {
  Inspector,
  type InspectorModel,
  type InspectorNoteGroup,
} from "./components/Inspector";
import { MetadataDialog } from "./components/MetadataDialog";
import {
  type MidiImportChoice,
  MidiImportDialog,
} from "./components/MidiImportDialog";
import { ScoreHeader } from "./components/ScoreHeader";
import {
  type MeasureClipboard,
  type NoteHandle,
  addGraceNote,
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
  removeGraceNote,
  removeNotes,
  removeStaff,
  reorderGrace,
  serializeDocument,
  setAccidental,
  setChordMemberDuration,
  setGracePitch,
  setGraceSlash,
  setNoteDuration,
  shiftNotesInTime,
  toggleTie,
} from "./dom-edit";
import {
  type SlotInfo,
  allSlotsAtBeat,
  chordForHandle,
  chordInfoForHandle,
  idForGraceHandle,
  idForHandle,
  octavePitch,
  pitchForHandle,
  slotAt,
  slotAtBeat,
  slots,
  stepPitch,
  topFirstNotes,
} from "./hit-test";
import type { ImportReview } from "./import-review";
import {
  type EmbeddedReviewPayload,
  buildEmbeddedReviewPayload,
  offsetEmbeddedReviewPayload,
  readEmbeddedReview,
  writeEmbeddedReview,
} from "./import-review-persistence";
import {
  type EditableMetadata,
  readMetadata,
  stampImportProvenance,
  writeMetadata,
  writeTempo,
} from "./metadata";
import {
  type NoteHighlight,
  type NoteType,
  type ParsedScore,
  type Pitch,
  computeMeasureStartBeats,
  parseScore,
} from "./sheet-music/index";
import { COLORS, FONTS, LAYOUT, RADIUS } from "./theme";
import { useHistory } from "./use-history";
import { isImportableImage, useImageImport } from "./use-image-import";
import { useListen } from "./use-listen";

function isMxl(file: File): boolean {
  return file.name.toLowerCase().endsWith(".mxl");
}

function isMidi(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".mid") ||
    name.endsWith(".midi") ||
    file.type === "audio/midi" ||
    file.type === "audio/x-midi"
  );
}

// A focused note draws solid accent; its chord-mates draw a lighter tint.
const FOCUS_COLOR = COLORS.accent;
const CHORD_TINT = "#84a9e8";
// Low-confidence OMR notes draw amber while the import-review panel is open.
const FLAG_COLOR = COLORS.warningDot;

// Undotted note-value → quarter-note beats, for the inspector's duration
// selector (mirrors dom-edit's own standard-duration table).
const BEATS_BY_TYPE: Record<NoteType, number> = {
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  "16th": 0.25,
};

// The current selection: either a whole spine slot (Level 1) — a position that
// may hold a chord OR a rest — or one focused note within a chord (Level 2). A
// slot is identified by its position (measure + onset beat) so it survives edits
// even when it holds no note (a rest carries no handle).
// A measure-range selection (whole measures, no beat granularity) — the
// target for copy/cut/paste and delete-measure. `startMeasureIndex` is the
// shift-click/shift-arrow anchor; `endMeasureIndex` is the far end and may be
// on either side of it.
type Selection =
  | { kind: "slot"; partIndex: number; measureIndex: number; onsetBeat: number }
  | { kind: "note"; handle: NoteHandle }
  | {
      kind: "measureRange";
      partIndex: number;
      startMeasureIndex: number;
      endMeasureIndex: number;
    }
  | null;

function sameHandle(a: NoteHandle, b: NoteHandle): boolean {
  return (
    a.measureIndex === b.measureIndex &&
    a.noteElementIndex === b.noteElementIndex
  );
}

function sameSlot(
  selection: Selection,
  slot: { partIndex: number; measureIndex: number; onsetBeat: number },
): boolean {
  return (
    selection?.kind === "slot" &&
    selection.partIndex === slot.partIndex &&
    selection.measureIndex === slot.measureIndex &&
    Math.abs(selection.onsetBeat - slot.onsetBeat) < 1e-6
  );
}

// The single-note target for nudges/accidentals: an explicitly focused note, or
// a chord slot that holds exactly one note. A rest slot has no target.
function focusedHandle(
  selection: Selection,
  slot: SlotInfo | null,
): NoteHandle | null {
  if (selection?.kind === "note") {
    return selection.handle;
  }
  if (slot && !slot.isRest && slot.handles.length === 1) {
    return slot.handles[0];
  }
  return null;
}

// The measure range a selection covers, recomputed against a given (fresh)
// score rather than closed over — see `selectionRef`'s doc comment for why
// copy/cut/paste read selection this way instead of via the `activeMeasureRange`
// memo.
function measureRangeForSelection(
  selection: Selection,
  freshScore: ParsedScore,
): { partIndex: number; lo: number; hi: number } | null {
  if (selection?.kind === "measureRange") {
    return {
      partIndex: selection.partIndex,
      lo: Math.min(selection.startMeasureIndex, selection.endMeasureIndex),
      hi: Math.max(selection.startMeasureIndex, selection.endMeasureIndex),
    };
  }
  if (selection?.kind === "slot") {
    return {
      partIndex: selection.partIndex,
      lo: selection.measureIndex,
      hi: selection.measureIndex,
    };
  }
  if (selection?.kind === "note") {
    const info = chordInfoForHandle(freshScore, selection.handle);
    return info
      ? {
          partIndex: info.partIndex,
          lo: info.measureIndex,
          hi: info.measureIndex,
        }
      : null;
  }
  return null;
}

const STEPS_ORDER: Pitch["step"][] = ["C", "D", "E", "F", "G", "A", "B"];

// Inspector group labels for each staff, from its clef: a classic grand staff
// reads "Treble"/"Bass"; staves sharing a clef get numbered ("Treble 1",
// "Treble 2", "Bass") so a three-staff score doesn't label two different
// staves identically. Single-staff scores show no label.
export function staffGroupLabels(
  parts: ReadonlyArray<{ clef?: { sign: "G" | "F" } }>,
): string[] {
  if (parts.length <= 1) {
    return parts.map(() => "");
  }
  const names = parts.map((part) =>
    part.clef?.sign === "F" ? "Bass" : "Treble",
  );
  const totals = new Map<string, number>();
  for (const name of names) {
    totals.set(name, (totals.get(name) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return names.map((name) => {
    if ((totals.get(name) ?? 0) <= 1) {
      return name;
    }
    const ordinal = (seen.get(name) ?? 0) + 1;
    seen.set(name, ordinal);
    return `${name} ${ordinal}`;
  });
}

// A new note added onto a rest is placed near the staff's middle line for the
// active clef (B4 treble, D3 bass) so it lands on the staff rather than far
// above/below — the user nudges from there with ↑/↓.
function staffReferencePitch(clef: { sign: "G" | "F" } | undefined): Pitch {
  return clef?.sign === "F"
    ? { step: "D", alter: 0, octave: 3 }
    : { step: "B", alter: 0, octave: 4 };
}

// Place a chosen letter (A–G) at the octave that lands it nearest the staff's
// middle line for the clef — so typing "C" onto an empty treble bar gives C5,
// not C4 far below.
function placeLetterNearStaff(
  step: Pitch["step"],
  clef: { sign: "G" | "F" } | undefined,
): Pitch {
  const reference = staffReferencePitch(clef);
  const referenceDiatonic =
    reference.octave * 7 + STEPS_ORDER.indexOf(reference.step);
  const stepIndex = STEPS_ORDER.indexOf(step);
  let best = Math.round((referenceDiatonic - stepIndex) / 7);
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const octave of [best - 1, best, best + 1]) {
    const distance = Math.abs(octave * 7 + stepIndex - referenceDiatonic);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = octave;
    }
  }
  return { step, alter: 0, octave: best };
}

// A pitch's display accidental for the inspector label.
function accidentalSymbol(alter: number): string {
  if (alter >= 2) {
    return "♯♯";
  }
  if (alter === 1) {
    return "♯";
  }
  if (alter === -1) {
    return "♭";
  }
  if (alter <= -2) {
    return "♭♭";
  }
  return "";
}

function pitchLabel(pitch: Pitch): string {
  return `${pitch.step}${accidentalSymbol(pitch.alter)}${pitch.octave}`;
}

// Shared style for the plain toolbar buttons, dimmed when disabled.
function toolbarButtonStyle(enabled: boolean) {
  return {
    padding: "6px 12px",
    borderRadius: RADIUS.button,
    border: `1px solid ${COLORS.borderButton}`,
    background: COLORS.canvas,
    color: enabled ? COLORS.textPrimary : COLORS.textPlaceholder,
    cursor: enabled ? "pointer" : "default",
    fontSize: 13,
    fontFamily: FONTS.ui,
  } as const;
}

export function Editor() {
  // Undo/redo + dirty tracking own the live document, the version counter, and
  // commit. The document is still mutated in place; commit snapshots it.
  const history = useHistory(createBlankDocument);
  const { documentRef, version, commit } = history;
  const [selection, setSelection] = useState<Selection>(null);
  // Mirrors `selection`, but updated synchronously in the render body rather
  // than via an effect. The global keydown listener is re-subscribed by a
  // `useEffect` that only flushes after the *next* commit/paint — so two
  // keyboard shortcuts fired back-to-back (e.g. Shift+→ to extend a measure
  // range, immediately followed by ⌘X to cut it) can have the second one
  // handled by a listener still closing over the selection from *before* the
  // first one's state update. Copy/cut/paste read the range from this ref
  // (always current) instead of the `activeMeasureRange` memo to avoid acting
  // on that stale selection.
  const selectionRef = useRef<Selection>(null);
  selectionRef.current = selection;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const imageImport = useImageImport();
  // Source-image review data from the most recent OMR import (session-only —
  // not part of the document), and whether its cleanup panel is showing.
  const [importReview, setImportReview] = useState<ImportReview | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  // A MIDI file awaiting confirmation (track selection, quantization grid,
  // etc.) via MidiImportDialog before it's actually converted. `mode` tracks
  // whether confirming should replace the document (the top-level "Open/
  // Import New") or append onto the end of it (the file-scoped "Append
  // Import").
  const [pendingMidi, setPendingMidi] = useState<{
    fileName: string;
    midiData: MidiData;
    tracks: TrackInfo[];
    explicitKey: { fifths: number; mode: string } | null;
    importMode: "replace" | "append";
  } | null>(null);
  // A PDF/image awaiting confirmation (inference backend, staff-detection
  // mode) via ImageImportDialog before OMR recognition runs. The chosen
  // options carry over as the default for the next import.
  const [pendingImage, setPendingImage] = useState<{
    file: File;
    importMode: "replace" | "append";
  } | null>(null);
  // Error from a failed "Append Import" (e.g. a part/staff-layout mismatch
  // with the current document) — shown alongside the OMR status/error strip.
  const [appendError, setAppendError] = useState<string | null>(null);
  const [imageImportChoice, setImageImportChoice] = useState<ImageImportChoice>(
    { backend: "auto", staffDetection: "classical", embedReviewData: true },
  );
  // Instant-scroll request for the sheet renderer: set the beat, bump the
  // generation. Used when the review panel steps the selection between systems.
  const snapBeatRef = useRef<number | null>(null);
  const [snapGeneration, setSnapGeneration] = useState(0);
  // The measure a shift-click/shift-arrow range selection extends from — the
  // "far end" moves with the gesture, this end stays put. Set on any plain
  // (non-shift) tap that lands on a slot. Session-only, not part of Selection
  // state since it outlives a collapse back to a single slot.
  const anchorMeasureRef = useRef<{
    partIndex: number;
    measureIndex: number;
  } | null>(null);
  // Copy/cut/paste's in-memory clipboard (session-only, not the OS clipboard —
  // see `MeasureClipboard`'s doc comment).
  const [clipboard, setClipboard] = useState<MeasureClipboard | null>(null);
  // A transient one-line explanation for an edit that couldn't apply (e.g. a
  // time-shift refused because the bar is full), shown in the transport bar.
  // Cleared on the next keypress/tap so it never lingers.
  const [editHint, setEditHint] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version drives re-serialize after in-place mutations
  const musicxml = useMemo(
    () => serializeDocument(documentRef.current),
    [version],
  );
  const dirty = musicxml !== history.baselineXml;
  const score = useMemo(() => parseScore(musicxml), [musicxml]);
  const measureStartBeats = useMemo(
    () => computeMeasureStartBeats(score),
    [score],
  );
  // Whether the loaded document is in the editor's supported single-staff shape.
  // Multi-staff / multi-voice files are view-only.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version tracks the live document
  const editable = useMemo(
    () => isEditableDocument(documentRef.current),
    [version],
  );

  // Over-full staves: each (measure, staff) whose content exceeds the time
  // signature (a too-long OMR duration, or a mid-cleanup intermediate state),
  // for the renderer's per-staff amber badge. Flagged per staff — a grand
  // staff's bass can overflow while its treble is fine. Under-full bars
  // (pickups, final bars) are legitimate and not flagged.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version tracks the live document
  const overfullBars = useMemo(() => {
    const flagged: Array<{
      measureIndex: number;
      partIndex: number;
      beats: number;
    }> = [];
    measureFillReport(documentRef.current).forEach((fill, measureIndex) => {
      fill.staffBeats.forEach((beats, partIndex) => {
        if (beats > fill.nominalBeats + 1e-6) {
          flagged.push({ measureIndex, partIndex, beats });
        }
      });
    });
    return flagged;
  }, [version]);

  // Score-level metadata, re-read from the live document on each commit. Cheap,
  // so recomputed eagerly rather than only when the dialog opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version tracks the live document
  const metadata = useMemo(() => readMetadata(documentRef.current), [version]);

  const onSaveMetadata = useCallback(
    (values: EditableMetadata) => {
      writeMetadata(documentRef.current, values);
      setMetadataOpen(false);
      commit();
    },
    [documentRef, commit],
  );

  // The tempo "Listen" plays at — the score's configured BPM, or a default.
  const bpm = metadata.tempo ?? 100;
  const listen = useListen(score, bpm);

  // The slot (chord or rest) for the current selection. A slot selection
  // resolves by position; a drilled note resolves via its chord's onset.
  const slotInfo: SlotInfo | null = useMemo(() => {
    if (!selection || selection.kind === "measureRange") {
      return null;
    }
    if (selection.kind === "slot") {
      return slotAt(
        score,
        selection.measureIndex,
        selection.onsetBeat,
        selection.partIndex,
      );
    }
    const info = chordInfoForHandle(score, selection.handle);
    return info
      ? slotAt(score, info.measureIndex, info.onsetBeat, info.partIndex)
      : null;
  }, [selection, score]);

  // The single-note target for nudges/accidentals (null on a rest slot).
  const focused = useMemo(
    () => focusedHandle(selection, slotInfo),
    [selection, slotInfo],
  );

  // The measure range copy/cut/paste/delete-measure act on: an explicit
  // measureRange selection, or (so these commands also work from an ordinary
  // note/beat selection) the single measure the current slot/note sits in.
  const activeMeasureRange = useMemo<{
    partIndex: number;
    lo: number;
    hi: number;
  } | null>(() => {
    if (selection?.kind === "measureRange") {
      return {
        partIndex: selection.partIndex,
        lo: Math.min(selection.startMeasureIndex, selection.endMeasureIndex),
        hi: Math.max(selection.startMeasureIndex, selection.endMeasureIndex),
      };
    }
    if (slotInfo) {
      return {
        partIndex: slotInfo.partIndex,
        lo: slotInfo.measureIndex,
        hi: slotInfo.measureIndex,
      };
    }
    return null;
  }, [selection, slotInfo]);

  // Measure-range selection chrome: a tinted background over the selected
  // measures (1-indexed, inclusive) — null outside a measureRange selection.
  const measureFocusRange = useMemo(() => {
    if (selection?.kind !== "measureRange") {
      return null;
    }
    return {
      from:
        Math.min(selection.startMeasureIndex, selection.endMeasureIndex) + 1,
      to: Math.max(selection.startMeasureIndex, selection.endMeasureIndex) + 1,
    };
  }, [selection]);

  // The inspector model + the parallel top-first handle list it indexes into.
  // A rest slot yields an empty note list, which the Inspector renders as
  // "Rest · {type}" with an Add-note affordance.
  // For grand staff, `allSlots` holds one SlotInfo per staff so the inspector
  // can show notes and Add-note buttons for each staff independently.
  const inspector = useMemo<{
    model: InspectorModel;
    handles: NoteHandle[];
    graceHandles: NoteHandle[];
    gracePitches: Pitch[];
    allSlots: SlotInfo[];
  } | null>(() => {
    if (!slotInfo) {
      return null;
    }
    const beatStaffSlots = allSlotsAtBeat(
      score,
      slotInfo.measureIndex,
      slotInfo.onsetBeat,
    );
    const groupLabels = staffGroupLabels(score.parts);
    const flatHandles: NoteHandle[] = [];
    const flatGraceHandles: NoteHandle[] = [];
    const flatGracePitches: Pitch[] = [];
    const noteGroups: InspectorNoteGroup[] = beatStaffSlots.map((staffSlot) => {
      const rows = topFirstNotes(staffSlot);
      const offset = flatHandles.length;
      for (const row of rows) {
        flatHandles.push(row.handle);
      }
      const graceOffset = flatGraceHandles.length;
      for (const grace of staffSlot.graces) {
        flatGraceHandles.push(grace.handle);
        flatGracePitches.push(grace.pitch);
      }
      return {
        partIndex: staffSlot.partIndex,
        label: groupLabels[staffSlot.partIndex] ?? "",
        durationLabel: staffSlot.type,
        durationBeats: BEATS_BY_TYPE[staffSlot.type],
        maxDurationBeats:
          rows.length > 0
            ? (maxNoteDuration(documentRef.current, rows[0].handle) ??
              BEATS_BY_TYPE[staffSlot.type])
            : BEATS_BY_TYPE[staffSlot.type],
        isRest: staffSlot.isRest,
        noteOffset: offset,
        notes: rows.map((row) => ({
          key: row.id,
          label: pitchLabel(row.pitch),
          alter: row.pitch.alter,
          focused: focused ? sameHandle(row.handle, focused) : false,
          tied: row.tieStart,
          durationBeats: BEATS_BY_TYPE[row.type],
          maxDurationBeats:
            maxNoteDuration(documentRef.current, row.handle) ??
            BEATS_BY_TYPE[row.type],
          canDivergeDuration: rows.length > 1,
        })),
        graceOffset,
        graces: staffSlot.graces.map((grace) => ({
          key: grace.id,
          label: pitchLabel(grace.pitch),
          alter: grace.pitch.alter,
          groupIndex: grace.groupIndex,
          groupCount: grace.groupCount,
          slash: grace.slash,
        })),
      };
    });

    const allNoteRows = noteGroups.flatMap((g) => g.notes);
    const measureStart = measureStartBeats[slotInfo.measureIndex] ?? 0;
    const beatType = score.parts[0]?.timeSig?.beatType ?? 4;
    const beatNumber =
      Math.round((slotInfo.onsetBeat - measureStart) * (beatType / 4)) + 1;
    return {
      model: {
        level: selection?.kind === "note" ? "note" : "beat",
        measureNumber: slotInfo.measureIndex + 1,
        beatNumber,
        durationLabel: slotInfo.type,
        notes: allNoteRows,
        noteGroups,
      },
      handles: flatHandles,
      graceHandles: flatGraceHandles,
      gracePitches: flatGracePitches,
      allSlots: beatStaffSlots,
    };
  }, [slotInfo, focused, selection, score, measureStartBeats, documentRef]);

  // Whether the import-review panel is showing (drives layout + highlights).
  const reviewVisible = reviewOpen && importReview !== null;

  // Low-confidence highlights: while reviewing an OMR import, tint the notes
  // the decoder was least sure about so the user knows what to check against
  // the source. Flags address notes by measure + <note> element index — the
  // handle shape — so they survive pitch/accidental fixes in place (and detach
  // once a structural edit reorders the measure's note elements).
  const confidenceHighlights: NoteHighlight[] = useMemo(() => {
    if (!reviewVisible || importReview === null) {
      return [];
    }
    return importReview.flaggedNotes
      .map((flagged) => {
        const handle = {
          measureIndex: flagged.measureIndex,
          noteElementIndex: flagged.noteElementIndex,
        };
        // Grace notes are not pickable (no beat of their own) but still render
        // with ids — and the dense grace runs are exactly where the recognizer
        // is least sure, so fall back to the grace lookup.
        return idForHandle(score, handle) ?? idForGraceHandle(score, handle);
      })
      .filter((id): id is string => id !== null)
      .map((id) => ({
        kind: "score" as const,
        id,
        color: FLAG_COLOR,
        title:
          "Low-confidence: the recognizer was least sure about this note. Check it against the source image.",
      }));
  }, [reviewVisible, importReview, score]);

  // Selection highlights: at Level 2 the focused note draws strong and its
  // chord-mates light; a slot selection tints all its members across every
  // staff (none for a rest — the beat-box chrome marks a rest instead).
  // Confidence flags go first so the selection recolor draws over them.
  const noteHighlights: NoteHighlight[] = useMemo(() => {
    if (!selection || !slotInfo) {
      return confidenceHighlights;
    }
    if (selection.kind === "note") {
      const out: NoteHighlight[] = [...confidenceHighlights];
      for (const note of slotInfo.notes) {
        const id = idForHandle(score, note.handle);
        if (id) {
          out.push({
            kind: "score",
            id,
            color: sameHandle(note.handle, selection.handle)
              ? FOCUS_COLOR
              : CHORD_TINT,
          });
        }
      }
      return out;
    }
    const slots = inspector?.allSlots ?? [slotInfo];
    return [
      ...confidenceHighlights,
      ...slots
        .flatMap((slot) => slot.notes)
        .map((note) => idForHandle(score, note.handle))
        .filter((id): id is string => id !== null)
        .map((id) => ({ kind: "score" as const, id, color: CHORD_TINT })),
    ];
  }, [selection, score, slotInfo, inspector, confidenceHighlights]);

  const hasSelection = selection !== null;

  // Selection chrome geometry: the beat column to highlight and (at Level 2) the
  // specific note to ring. Both are passed straight through to the renderer.
  const selectionBeat = slotInfo?.onsetBeat ?? null;
  const focusNoteId = useMemo(() => {
    if (selection?.kind !== "note") {
      return null;
    }
    return idForHandle(score, selection.handle) ?? null;
  }, [selection, score]);

  // Tap on the staff: select the spine slot (chord or rest) at that beat, then
  // narrow to one note on a repeat tap on a notehead. A tap that resolves to no
  // slot (off the staff) clears the selection — it never inserts a note.
  const handleTap = useCallback(
    (gesture: EditorGesture, event: PointerEvent) => {
      setMenu(null);
      setEditHint(null);
      if (!editable) {
        return;
      }
      // A tap clear of the staves (in the empty margin) clears the selection;
      // it never selects or inserts. A tap on a notehead selects that note's
      // own slot — exact staff and onset — rather than whatever slot is
      // nearest the tap's staff-band/beat estimate, which for ledger-line
      // notes between two staves can be a different staff entirely.
      const hitChord = gesture.hit
        ? chordForHandle(score, gesture.hit.handle)
        : null;
      const slot = gesture.offStaff
        ? null
        : hitChord
          ? slotAt(
              score,
              hitChord.measureIndex,
              hitChord.onsetBeat,
              hitChord.partIndex,
            )
          : slotAtBeat(score, gesture.beat, 1.5, gesture.partIndex);
      if (!slot) {
        setSelection(null);
        anchorMeasureRef.current = null;
        return;
      }
      // Shift-click extends a measure-range selection from the last plain
      // (non-shift) tap's measure to this one's — text-editor-style range
      // selection, at measure granularity.
      const anchor = anchorMeasureRef.current;
      if (event.shiftKey && anchor && anchor.partIndex === slot.partIndex) {
        setSelection({
          kind: "measureRange",
          partIndex: slot.partIndex,
          startMeasureIndex: anchor.measureIndex,
          endMeasureIndex: slot.measureIndex,
        });
        return;
      }
      anchorMeasureRef.current = {
        partIndex: slot.partIndex,
        measureIndex: slot.measureIndex,
      };
      setSelection((prev) => {
        const onThisSlot =
          sameSlot(prev, slot) ||
          (prev?.kind === "note" &&
            slot.handles.some((handle) => sameHandle(handle, prev.handle)));
        // A repeat tap that landed on a notehead drills into that note.
        if (onThisSlot && gesture.hit) {
          return { kind: "note", handle: gesture.hit.handle };
        }
        // Already drilled to note level: a tap on another notehead stays at
        // note level (matching ←/→, which keeps the drill level while
        // moving) instead of popping back out to the beat and demanding a
        // second click on every note.
        if (prev?.kind === "note" && gesture.hit) {
          return { kind: "note", handle: gesture.hit.handle };
        }
        return {
          kind: "slot",
          partIndex: slot.partIndex,
          measureIndex: slot.measureIndex,
          onsetBeat: slot.onsetBeat,
        };
      });
    },
    [editable, score],
  );

  // Live drag-to-select-measures: fired on every pointermove (and the final
  // pointerup) of a Shift-held drag that started on the staff. Extends the
  // measure range from the drag's start (the anchor `handleTap`'s shift
  // branch — or, absent a shift-branch hit, its plain-tap branch — already
  // set) to wherever the pointer currently is, exactly like a repeated
  // shift-click would. A drag that leaves the anchor's staff (grand staff) or
  // starts with no anchor yet is a no-op.
  const handleRangeSelectMove = useCallback(
    (gesture: EditorGesture) => {
      if (!editable) {
        return;
      }
      const anchor = anchorMeasureRef.current;
      if (!anchor) {
        return;
      }
      const slot = gesture.offStaff
        ? null
        : slotAtBeat(score, gesture.beat, 1.5, anchor.partIndex);
      if (!slot || slot.partIndex !== anchor.partIndex) {
        return;
      }
      setSelection({
        kind: "measureRange",
        partIndex: anchor.partIndex,
        startMeasureIndex: anchor.measureIndex,
        endMeasureIndex: slot.measureIndex,
      });
    },
    [editable, score],
  );

  const handleContextMenu = useCallback(
    (request: ContextMenuRequest) => {
      if (!editable) {
        return;
      }
      // Which measure the click landed in, straight from the renderer's own
      // `measureXs` boundary walk — precise regardless of where in the bar
      // the click fell. `request.beat` (used below for the slot lookup) is a
      // cruder proportional interpolation within that measure and can, near a
      // barline, round into the *adjacent* measure; comparing this instead of
      // `slot.measureIndex` against the current range is what makes a
      // right-click that's visually inside a multi-measure selection reliably
      // read as inside it.
      const clickedMeasureIndex = request.measureNumber - 1;
      // Resolve the slot with the right-click's own staff/notehead gesture
      // when it landed on the staff SVG: a right-clicked notehead selects that
      // note's exact slot, and a bare right-click stays on the staff under the
      // pointer instead of whichever staff has the nearest onset.
      const hitChord = request.gesture?.hit
        ? chordForHandle(score, request.gesture.hit.handle)
        : null;
      const slot = hitChord
        ? slotAt(
            score,
            hitChord.measureIndex,
            hitChord.onsetBeat,
            hitChord.partIndex,
          )
        : slotAtBeat(score, request.beat, 1.5, request.gesture?.partIndex);
      if (!slot) {
        setMenu(null);
        return;
      }
      setSelection((prev) => {
        if (
          prev?.kind === "note" &&
          slot.handles.some((handle) => sameHandle(handle, prev.handle))
        ) {
          return prev;
        }
        // A right-click landing inside an existing measure-range selection
        // opens the menu for the whole range rather than collapsing it to a
        // single slot — matching how right-click behaves on an existing
        // selection elsewhere (Finder, text editors, …). The range's tinted
        // background spans every staff of a grand staff, so any staff's click
        // at that measure counts — not just the one the range's own partIndex
        // happens to be.
        if (
          prev?.kind === "measureRange" &&
          clickedMeasureIndex >=
            Math.min(prev.startMeasureIndex, prev.endMeasureIndex) &&
          clickedMeasureIndex <=
            Math.max(prev.startMeasureIndex, prev.endMeasureIndex)
        ) {
          return prev;
        }
        return {
          kind: "slot",
          partIndex: slot.partIndex,
          measureIndex: slot.measureIndex,
          onsetBeat: slot.onsetBeat,
        };
      });
      setMenu({ x: request.clientX, y: request.clientY });
    },
    [editable, score],
  );

  // ── Editing operations ──────────────────────────────────────────────────────

  // Structural edits rebuild a measure's <note> elements, so index-addressed
  // confidence flags in that measure would drift onto the wrong notes. Drop
  // that measure's flags instead — a stale amber tint pointing at the wrong
  // note is worse than none.
  const dropFlagsInMeasure = useCallback((measureIndex: number) => {
    setImportReview((prev) =>
      prev
        ? {
            ...prev,
            flaggedNotes: prev.flaggedNotes.filter(
              (flagged) => flagged.measureIndex !== measureIndex,
            ),
          }
        : prev,
    );
  }, []);

  // Staff-step (or octave-step) a specific note, keeping its onset. Returns to
  // Level 2 on the moved note and coalesces a rapid run into one undo entry.
  const stepHandle = useCallback(
    (handle: NoteHandle, delta: number, octave: boolean) => {
      if (!editable) {
        return;
      }
      const pitch = pitchForHandle(score, handle);
      const chord = chordForHandle(score, handle);
      if (!pitch || !chord) {
        return;
      }
      const measureStart = measureStartBeats[chord.measureIndex] ?? 0;
      const activeFifths =
        score.parts[chord.partIndex]?.measures[chord.measureIndex]
          ?.activeFifths ?? 0;
      const moved = moveNote(documentRef.current, handle, {
        measureIndex: chord.measureIndex,
        onsetBeatInMeasure: chord.onsetBeat - measureStart,
        pitch: octave
          ? octavePitch(pitch, delta)
          : stepPitch(pitch, delta, activeFifths),
      });
      if (moved) {
        setSelection({ kind: "note", handle: moved });
        commit({ coalesce: "nudge" });
      }
    },
    [editable, score, measureStartBeats, documentRef, commit],
  );

  const setAccidentalOn = useCallback(
    (handle: NoteHandle, alter: number) => {
      if (!editable) {
        return;
      }
      if (setAccidental(documentRef.current, handle, alter)) {
        setSelection({ kind: "note", handle });
        commit();
      }
    },
    [editable, documentRef, commit],
  );

  const toggleTieOn = useCallback(
    (handle: NoteHandle) => {
      if (!editable) {
        return;
      }
      if (toggleTie(documentRef.current, handle)) {
        setSelection({ kind: "note", handle });
        commit();
      }
    },
    [editable, documentRef, commit],
  );

  // Resize the chord at `handle`'s onset (every member together) to a new
  // standard duration.
  const setDurationOn = useCallback(
    (handle: NoteHandle, durationBeats: number) => {
      if (!editable) {
        return;
      }
      if (setNoteDuration(documentRef.current, handle, durationBeats)) {
        dropFlagsInMeasure(handle.measureIndex);
        setSelection({ kind: "note", handle });
        commit();
      }
    },
    [editable, documentRef, commit, dropFlagsInMeasure],
  );

  // Resize a single chord member independently of its chord-mates — lets one
  // note in a chord diverge from the others' duration.
  const setMemberDurationOn = useCallback(
    (handle: NoteHandle, durationBeats: number) => {
      if (!editable) {
        return;
      }
      if (setChordMemberDuration(documentRef.current, handle, durationBeats)) {
        dropFlagsInMeasure(handle.measureIndex);
        setSelection({ kind: "note", handle });
        commit();
      }
    },
    [editable, documentRef, commit, dropFlagsInMeasure],
  );

  // Grace note edits never move the host's onset, so the active slot selection
  // (the beat) stays valid through any of these — no reselection needed.
  const setGraceAccidentalOn = useCallback(
    (handle: NoteHandle, alter: number) => {
      if (!editable) {
        return;
      }
      if (setAccidental(documentRef.current, handle, alter)) {
        commit();
      }
    },
    [editable, documentRef, commit],
  );

  const stepGraceHandle = useCallback(
    (handle: NoteHandle, pitch: Pitch, delta: number) => {
      if (!editable) {
        return;
      }
      const activeFifths =
        score.parts[slotInfo?.partIndex ?? 0]?.measures[handle.measureIndex]
          ?.activeFifths ?? 0;
      if (
        setGracePitch(
          documentRef.current,
          handle,
          stepPitch(pitch, delta, activeFifths),
        )
      ) {
        commit({ coalesce: "nudge" });
      }
    },
    [editable, score, slotInfo, documentRef, commit],
  );

  const removeGraceHandle = useCallback(
    (handle: NoteHandle) => {
      if (!editable) {
        return;
      }
      if (removeGraceNote(documentRef.current, handle)) {
        dropFlagsInMeasure(handle.measureIndex);
        commit();
      }
    },
    [editable, documentRef, commit, dropFlagsInMeasure],
  );

  const reorderGraceHandle = useCallback(
    (handle: NoteHandle, direction: "earlier" | "later") => {
      if (!editable) {
        return;
      }
      if (reorderGrace(documentRef.current, handle, direction)) {
        dropFlagsInMeasure(handle.measureIndex);
        commit();
      }
    },
    [editable, documentRef, commit, dropFlagsInMeasure],
  );

  const setGraceSlashOn = useCallback(
    (handle: NoteHandle, slash: boolean) => {
      if (!editable) {
        return;
      }
      if (setGraceSlash(documentRef.current, handle, slash)) {
        commit();
      }
    },
    [editable, documentRef, commit],
  );

  // Adds the new grace note immediately before `handle`'s chord; the active
  // slot selection (the beat) stays valid, same as the other grace edits.
  const addGraceHandle = useCallback(
    (handle: NoteHandle) => {
      if (!editable) {
        return;
      }
      if (addGraceNote(documentRef.current, handle)) {
        dropFlagsInMeasure(handle.measureIndex);
        commit();
      }
    },
    [editable, documentRef, commit, dropFlagsInMeasure],
  );

  // Re-select the slot at `onsetBeat` after a mutation, resolving against the
  // freshly serialized document so positions/handles are current. Used after a
  // removal so the position stays selected (it becomes a rest, or the remaining
  // chord).
  const reselectSlotAt = useCallback(
    (onsetBeat: number | null, partIndex: number) => {
      if (onsetBeat === null) {
        setSelection(null);
        return;
      }
      const freshScore = parseScore(serializeDocument(documentRef.current));
      const slot = slotAtBeat(freshScore, onsetBeat, 0.1, partIndex);
      setSelection(
        slot
          ? {
              kind: "slot",
              partIndex: slot.partIndex,
              measureIndex: slot.measureIndex,
              onsetBeat: slot.onsetBeat,
            }
          : null,
      );
    },
    [documentRef],
  );

  // Shift the selected chord — and everything after it in its measure/staff —
  // later (+1) or earlier (−1) in time by the chord's own duration, swallowing
  // rest space at one end of the bar and emitting it at the other (see
  // `shiftNotesInTime`). The OMR-cleanup fix for a run the recognizer placed a
  // beat early or late: select its first note and nudge the whole block.
  const shiftSelectionInTime = useCallback(
    (direction: 1 | -1) => {
      if (
        !editable ||
        !slotInfo ||
        slotInfo.isRest ||
        slotInfo.handles.length === 0
      ) {
        return;
      }
      const step = BEATS_BY_TYPE[slotInfo.type];
      const moved = shiftNotesInTime(
        documentRef.current,
        slotInfo.handles[0],
        direction * step,
      );
      if (!moved) {
        // A right shift always fits now (the bar grows), so a refusal here is a
        // left shift blocked by the note before it. Explain rather than
        // dead-keying.
        if (direction < 0) {
          setEditHint(
            "Can't shift earlier — a note (or the bar start) is in the way.",
          );
        }
        return;
      }
      dropFlagsInMeasure(slotInfo.measureIndex);
      setMenu(null);
      commit();
      // Follow the block to its new onset, keeping the drill level.
      if (selectionRef.current?.kind === "note") {
        setSelection({ kind: "note", handle: moved });
      } else {
        reselectSlotAt(
          slotInfo.onsetBeat + direction * step,
          slotInfo.partIndex,
        );
      }
    },
    [
      editable,
      slotInfo,
      documentRef,
      commit,
      dropFlagsInMeasure,
      reselectSlotAt,
    ],
  );

  // A pointer-down on the canvas around/below the staves (not on the staff
  // SVG) clears the selection; taps that reach the SVG are handleTap's.
  const clearSelectionOffStaff = useCallback((event: PointerEvent) => {
    const target = event.target as Element | null;
    if (target && !target.closest("svg")) {
      setSelection(null);
      setMenu(null);
    }
  }, []);

  // The flagged (low-confidence) notes that still resolve to selectable
  // notes, in score order — the review panel's "next flagged" jump targets.
  // Grace-note flags are skipped: graces have no beat to select.
  const flaggedTargets = useMemo(() => {
    if (!reviewVisible || importReview === null) {
      return [];
    }
    const targets: Array<{
      handle: NoteHandle;
      partIndex: number;
      onsetBeat: number;
    }> = [];
    for (const flagged of importReview.flaggedNotes) {
      const handle = {
        measureIndex: flagged.measureIndex,
        noteElementIndex: flagged.noteElementIndex,
      };
      const info = chordInfoForHandle(score, handle);
      if (info) {
        targets.push({
          handle,
          partIndex: info.partIndex,
          onsetBeat: info.onsetBeat,
        });
      }
    }
    return targets.sort(
      (a, b) => a.onsetBeat - b.onsetBeat || a.partIndex - b.partIndex,
    );
  }, [reviewVisible, importReview, score]);

  // Step the selection to the next flagged note after the current position
  // (wrapping), drilled to note level so the fix-up tools are immediately
  // live, and snap-scroll it into view.
  const gotoNextFlagged = useCallback(() => {
    if (flaggedTargets.length === 0) {
      return;
    }
    const currentBeat = slotInfo?.onsetBeat ?? Number.NEGATIVE_INFINITY;
    const currentPart = slotInfo?.partIndex ?? Number.NEGATIVE_INFINITY;
    const next =
      flaggedTargets.find(
        (target) =>
          target.onsetBeat > currentBeat + 1e-6 ||
          (Math.abs(target.onsetBeat - currentBeat) < 1e-6 &&
            target.partIndex > currentPart),
      ) ?? flaggedTargets[0];
    setSelection({ kind: "note", handle: next.handle });
    snapBeatRef.current = next.onsetBeat;
    setSnapGeneration((generation) => generation + 1);
  }, [flaggedTargets, slotInfo]);

  // Jump the selection to a measure's first slot and scroll it into view —
  // the review panel's system stepping. Selection may fail on an unusual
  // document shape; the scroll still happens so the source and notation views
  // stay aligned.
  const selectMeasureStart = useCallback(
    (measureIndex: number) => {
      const beat = measureStartBeats[measureIndex];
      if (beat === undefined) {
        return;
      }
      const slot = slotAtBeat(score, beat, 0.5, 0);
      if (slot) {
        setSelection({
          kind: "slot",
          partIndex: slot.partIndex,
          measureIndex: slot.measureIndex,
          onsetBeat: slot.onsetBeat,
        });
      }
      snapBeatRef.current = beat;
      setSnapGeneration((generation) => generation + 1);
    },
    [measureStartBeats, score],
  );

  const removeHandle = useCallback(
    (handle: NoteHandle) => {
      if (!editable) {
        return;
      }
      const info = chordInfoForHandle(score, handle);
      const onsetBeat = info?.onsetBeat ?? null;
      removeNotes(documentRef.current, [handle]);
      dropFlagsInMeasure(handle.measureIndex);
      setMenu(null);
      commit();
      reselectSlotAt(onsetBeat, info?.partIndex ?? 0);
    },
    [editable, score, documentRef, commit, reselectSlotAt, dropFlagsInMeasure],
  );

  // Add a note at the current slot (or `targetSlot` for a specific staff). On a
  // chord slot it stacks a chord member (default a third above the top, via
  // `addNoteToChord`); on a rest slot it inserts a quarter note (`addNote` fits
  // the duration and rebalances). `pitch` is required for a rest.
  // `overrideOnsetBeat` lets the caller insert into a covering rest at a
  // specific beat rather than at the rest's own onset — used when adding a note
  // to an adjacent staff whose rest spans the selected beat.
  const addNoteAtSlot = useCallback(
    (pitch?: Pitch, targetSlot?: SlotInfo, overrideOnsetBeat?: number) => {
      const slot = targetSlot ?? slotInfo;
      if (!editable || !slot) {
        return;
      }
      if (slot.isRest) {
        const clef = score.parts[slot.partIndex]?.clef;
        const measureStart = measureStartBeats[slot.measureIndex] ?? 0;
        const onsetBeat = overrideOnsetBeat ?? slot.onsetBeat;
        const added = addNote(documentRef.current, {
          measureIndex: slot.measureIndex,
          onsetBeatInMeasure: onsetBeat - measureStart,
          durationBeats: 1,
          pitch: pitch ?? staffReferencePitch(clef),
          // 1-based staff; addNote ignores it for single-staff documents.
          staff: slot.partIndex + 1,
        });
        if (added) {
          dropFlagsInMeasure(slot.measureIndex);
          setSelection({ kind: "note", handle: added });
          commit();
        }
        return;
      }
      const added = addNoteToChord(
        documentRef.current,
        slot.notes[0].handle,
        pitch,
      );
      if (added) {
        dropFlagsInMeasure(slot.measureIndex);
        setSelection({ kind: "note", handle: added });
        commit();
      }
    },
    [
      editable,
      slotInfo,
      score,
      measureStartBeats,
      documentRef,
      commit,
      dropFlagsInMeasure,
    ],
  );

  const addLetter = useCallback(
    (step: Pitch["step"]) => {
      if (!slotInfo) {
        return;
      }
      if (slotInfo.isRest) {
        addNoteAtSlot(
          placeLetterNearStaff(step, score.parts[slotInfo.partIndex]?.clef),
        );
      } else {
        const top = topFirstNotes(slotInfo)[0].pitch;
        addNoteAtSlot({ step, alter: 0, octave: top.octave });
      }
    },
    [slotInfo, score, addNoteAtSlot],
  );

  const onInsertMeasure = useCallback(() => {
    if (!editable) {
      return;
    }
    insertMeasure(documentRef.current, slotInfo?.measureIndex);
    setSelection(null);
    setMenu(null);
    commit();
  }, [editable, slotInfo, documentRef, commit]);

  // The number of staves in the (single) part = the number of parsed staff-parts.
  const staffCount = score.parts.length;

  const onAddStaff = useCallback(() => {
    if (!editable) {
      return;
    }
    if (addStaff(documentRef.current) === null) {
      return;
    }
    setSelection(null);
    setMenu(null);
    commit();
  }, [editable, documentRef, commit]);

  // Remove the staff holding the current selection, or the bottom staff when
  // nothing is selected.
  const onRemoveStaff = useCallback(() => {
    if (!editable || staffCount <= 1) {
      return;
    }
    const target = slotInfo !== null ? slotInfo.partIndex + 1 : staffCount;
    if (removeStaff(documentRef.current, target) === null) {
      return;
    }
    setSelection(null);
    setMenu(null);
    commit();
  }, [editable, staffCount, slotInfo, documentRef, commit]);

  // Delete the measures [range.lo, range.hi] and reselect the slot that now
  // occupies that position (shared tail of both delete-measure and cut).
  const deleteMeasureRange = useCallback(
    (range: { partIndex: number; lo: number; hi: number }) => {
      if (!editable) {
        return;
      }
      const nextIndex = deleteMeasures(documentRef.current, range.lo, range.hi);
      setMenu(null);
      commit();
      anchorMeasureRef.current = null;
      if (nextIndex === null) {
        setSelection(null);
        return;
      }
      const freshScore = parseScore(serializeDocument(documentRef.current));
      const beat = computeMeasureStartBeats(freshScore)[nextIndex];
      const slot =
        beat !== undefined
          ? slotAtBeat(freshScore, beat, 0.5, range.partIndex)
          : null;
      setSelection(
        slot
          ? {
              kind: "slot",
              partIndex: slot.partIndex,
              measureIndex: slot.measureIndex,
              onsetBeat: slot.onsetBeat,
            }
          : null,
      );
    },
    [editable, documentRef, commit],
  );

  const deleteSelection = useCallback(() => {
    if (!editable) {
      return;
    }
    // Reads `selectionRef` fresh (see its doc comment) so a Delete fired
    // immediately after a Shift+←/→ range-extend can't act on a stale range.
    if (selectionRef.current?.kind === "measureRange") {
      const sel = selectionRef.current;
      deleteMeasureRange({
        partIndex: sel.partIndex,
        lo: Math.min(sel.startMeasureIndex, sel.endMeasureIndex),
        hi: Math.max(sel.startMeasureIndex, sel.endMeasureIndex),
      });
      return;
    }
    if (!selection || !slotInfo) {
      return;
    }
    const handles =
      selection.kind === "note" ? [selection.handle] : slotInfo.handles;
    if (handles.length === 0) {
      // A rest slot has nothing to delete.
      return;
    }
    const onsetBeat = slotInfo.onsetBeat;
    removeNotes(documentRef.current, handles);
    dropFlagsInMeasure(slotInfo.measureIndex);
    setMenu(null);
    commit();
    reselectSlotAt(onsetBeat, slotInfo.partIndex);
  }, [
    editable,
    selection,
    slotInfo,
    deleteMeasureRange,
    commit,
    documentRef,
    reselectSlotAt,
    dropFlagsInMeasure,
  ]);

  // Copy the active measure range (an explicit measureRange selection, or the
  // single measure a note/beat selection sits in) into the session clipboard.
  // Reads `selectionRef` + a freshly parsed score rather than the closed-over
  // `activeMeasureRange` memo (see `selectionRef`'s doc comment).
  const copyMeasureSelection = useCallback(() => {
    if (!editable) {
      return;
    }
    const freshScore = parseScore(serializeDocument(documentRef.current));
    const range = measureRangeForSelection(selectionRef.current, freshScore);
    if (!range) {
      return;
    }
    const clip = copyMeasures(documentRef.current, range.lo, range.hi);
    if (clip) {
      setClipboard(clip);
    }
  }, [editable, documentRef]);

  const cutMeasureSelection = useCallback(() => {
    if (!editable) {
      return;
    }
    const freshScore = parseScore(serializeDocument(documentRef.current));
    const range = measureRangeForSelection(selectionRef.current, freshScore);
    if (!range) {
      return;
    }
    const clip = copyMeasures(documentRef.current, range.lo, range.hi);
    if (!clip) {
      return;
    }
    setClipboard(clip);
    deleteMeasureRange(range);
  }, [editable, documentRef, deleteMeasureRange]);

  // Insert the clipboard's measures before the active selection's first
  // measure (or at the end of the piece with no selection), then select the
  // pasted range so it's obvious what landed and ready for another paste/cut.
  const pasteMeasureSelection = useCallback(() => {
    if (!editable || !clipboard) {
      return;
    }
    const freshScore = parseScore(serializeDocument(documentRef.current));
    const range = measureRangeForSelection(selectionRef.current, freshScore);
    const atIndex = range?.lo ?? freshScore.parts[0]?.measures.length ?? 0;
    const partIndex = range?.partIndex ?? 0;
    const result = pasteMeasures(documentRef.current, atIndex, clipboard);
    if (!result) {
      return;
    }
    setMenu(null);
    commit();
    anchorMeasureRef.current = {
      partIndex,
      measureIndex: result.firstPastedIndex,
    };
    setSelection({
      kind: "measureRange",
      partIndex,
      startMeasureIndex: result.firstPastedIndex,
      endMeasureIndex: result.firstPastedIndex + result.pastedCount - 1,
    });
    const postPasteScore = parseScore(serializeDocument(documentRef.current));
    const beat =
      computeMeasureStartBeats(postPasteScore)[result.firstPastedIndex];
    if (beat !== undefined) {
      snapBeatRef.current = beat;
      setSnapGeneration((generation) => generation + 1);
    }
  }, [editable, clipboard, documentRef, commit]);

  // ── Selection navigation (keyboard) ─────────────────────────────────────────

  const drillIn = useCallback(() => {
    setSelection((prev) => {
      if (prev?.kind !== "slot") {
        return prev;
      }
      const slot = slotAt(
        score,
        prev.measureIndex,
        prev.onsetBeat,
        prev.partIndex,
      );
      // A rest slot has no note to drill into.
      if (!slot || slot.isRest || slot.notes.length === 0) {
        return prev;
      }
      return { kind: "note", handle: topFirstNotes(slot)[0].handle };
    });
  }, [score]);

  const stepOut = useCallback(() => {
    setMenu(null);
    setSelection((prev) => {
      // A measure range isn't part of the slot→note drill hierarchy Escape
      // steps back out of, so it isn't Escape's to clear. Without this, the
      // very natural "right-click a range, then press Escape to dismiss the
      // menu without picking anything" gesture would silently wipe the
      // range: Escape reaches this global handler before (or as well as)
      // ContextMenu's own Escape-closes-the-menu listener.
      if (prev?.kind === "measureRange") {
        return prev;
      }
      if (prev?.kind !== "note") {
        return null;
      }
      const info = chordInfoForHandle(score, prev.handle);
      return info
        ? {
            kind: "slot",
            partIndex: info.partIndex,
            measureIndex: info.measureIndex,
            onsetBeat: info.onsetBeat,
          }
        : null;
    });
  }, [score]);

  const cycleChord = useCallback(
    (dir: number) => {
      setSelection((prev) => {
        if (prev?.kind !== "note") {
          return prev;
        }
        const info = chordInfoForHandle(score, prev.handle);
        if (!info) {
          return prev;
        }
        const rows = topFirstNotes(info);
        const index = rows.findIndex((row) =>
          sameHandle(row.handle, prev.handle),
        );
        if (index < 0) {
          return prev;
        }
        const next =
          (((index + dir) % rows.length) + rows.length) % rows.length;
        return { kind: "note", handle: rows[next].handle };
      });
    },
    [score],
  );

  // ←/→: move to the adjacent position on the *shared* rhythm spine — the union
  // of every staff's onsets (chords and rests alike), in time order. Navigation
  // is not staff-bound: pressing → from a note that spans a beat another staff
  // subdivides advances to that subdivision rather than skipping to this staff's
  // own next onset. On landing, the selection stays on the current staff when it
  // has an onset at the destination beat, and otherwise crosses to the staff
  // that does (a note-bearing staff first, then the topmost). Clamps at the ends.
  const navBeat = useCallback(
    (dir: number) => {
      const allSlots = slots(score);
      if (allSlots.length === 0) {
        return;
      }
      // Distinct onset beats across all staves = the shared spine.
      const beats = [...new Set(allSlots.map((slot) => slot.onsetBeat))].sort(
        (a, b) => a - b,
      );
      setSelection((prev) => {
        // The current beat + staff, from either selection level.
        let currentBeat: number | null = null;
        let currentPart = 0;
        if (prev?.kind === "note") {
          const info = chordInfoForHandle(score, prev.handle);
          if (info) {
            currentBeat = info.onsetBeat;
            currentPart = info.partIndex;
          }
        } else if (prev?.kind === "slot") {
          currentBeat = prev.onsetBeat;
          currentPart = prev.partIndex;
        }
        const beatIndex =
          currentBeat === null
            ? dir > 0
              ? -1
              : beats.length
            : beats.findIndex((beat) => Math.abs(beat - currentBeat) < 1e-6);
        const nextIndex = beatIndex + dir;
        if (nextIndex < 0 || nextIndex >= beats.length) {
          return prev; // clamp at the piece ends
        }
        const destBeat = beats[nextIndex];
        const here = allSlots.filter(
          (slot) => Math.abs(slot.onsetBeat - destBeat) < 1e-6,
        );
        // Keep the current staff when it has an onset here; otherwise cross to
        // another staff, preferring one that actually holds a note.
        const chosen =
          here.find((slot) => slot.partIndex === currentPart) ??
          [...here].sort(
            (a, b) =>
              Number(a.isRest) - Number(b.isRest) || a.partIndex - b.partIndex,
          )[0];
        if (!chosen) {
          return prev;
        }
        // Stay drilled to a note only when the destination actually holds one.
        if (
          prev?.kind === "note" &&
          !chosen.isRest &&
          chosen.notes.length > 0
        ) {
          return { kind: "note", handle: topFirstNotes(chosen)[0].handle };
        }
        return {
          kind: "slot",
          partIndex: chosen.partIndex,
          measureIndex: chosen.measureIndex,
          onsetBeat: chosen.onsetBeat,
        };
      });
    },
    [score],
  );

  // Shift+←/→: grow or shrink a measure-range selection by one measure, away
  // from (or back toward) the shift-click/shift-arrow anchor — the keyboard
  // counterpart of shift-click range selection. Starting from a slot/note
  // selection, the current slot's measure becomes the anchor.
  const extendMeasureRange = useCallback(
    (dir: number) => {
      const measureCount = score.parts[0]?.measures.length ?? 0;
      if (measureCount === 0) {
        return;
      }
      setSelection((prev) => {
        if (prev?.kind === "measureRange") {
          const anchor =
            anchorMeasureRef.current?.partIndex === prev.partIndex
              ? anchorMeasureRef.current.measureIndex
              : prev.startMeasureIndex;
          const far =
            prev.startMeasureIndex === anchor
              ? prev.endMeasureIndex
              : prev.startMeasureIndex;
          const next = Math.max(0, Math.min(measureCount - 1, far + dir));
          return {
            kind: "measureRange",
            partIndex: prev.partIndex,
            startMeasureIndex: anchor,
            endMeasureIndex: next,
          };
        }
        const partIndex = slotInfo?.partIndex ?? 0;
        const base = slotInfo?.measureIndex ?? 0;
        anchorMeasureRef.current = { partIndex, measureIndex: base };
        const next = Math.max(0, Math.min(measureCount - 1, base + dir));
        return {
          kind: "measureRange",
          partIndex,
          startMeasureIndex: base,
          endMeasureIndex: next,
        };
      });
    },
    [score, slotInfo],
  );

  // ↑/↓: at Level 2 step the note (Shift = octave); at Level <2 drill in.
  const arrowPitch = useCallback(
    (dir: number, shift: boolean) => {
      if (selection?.kind === "note") {
        stepHandle(selection.handle, dir, shift);
      } else {
        drillIn();
      }
    },
    [selection, stepHandle, drillIn],
  );

  const accidentalOnFocus = useCallback(
    (alter: number) => {
      if (focused) {
        setAccidentalOn(focused, alter);
      }
    },
    [focused, setAccidentalOn],
  );

  const onListen = useCallback(() => {
    listen.toggle(slotInfo?.onsetBeat);
  }, [listen, slotInfo]);

  // Undo/redo keep the user's place: re-resolve the selected position (its
  // measure/beat/staff) against the restored document rather than dropping
  // the selection entirely. Note-level selections collapse to their beat —
  // a handle's element index may mean a different note after the restore.
  const reselectAfterHistory = useCallback(
    (position: { partIndex: number; onsetBeat: number } | null) => {
      setMenu(null);
      if (!position) {
        setSelection(null);
        return;
      }
      const freshScore = parseScore(serializeDocument(documentRef.current));
      const slot = slotAtBeat(
        freshScore,
        position.onsetBeat,
        0.5,
        position.partIndex,
      );
      setSelection(
        slot
          ? {
              kind: "slot",
              partIndex: slot.partIndex,
              measureIndex: slot.measureIndex,
              onsetBeat: slot.onsetBeat,
            }
          : null,
      );
    },
    [documentRef],
  );

  const undo = useCallback(() => {
    if (!history.canUndo) {
      return;
    }
    const position = slotInfo
      ? { partIndex: slotInfo.partIndex, onsetBeat: slotInfo.onsetBeat }
      : null;
    history.undo();
    reselectAfterHistory(position);
  }, [history, slotInfo, reselectAfterHistory]);

  const redo = useCallback(() => {
    if (!history.canRedo) {
      return;
    }
    const position = slotInfo
      ? { partIndex: slotInfo.partIndex, onsetBeat: slotInfo.onsetBeat }
      : null;
    history.redo();
    reselectAfterHistory(position);
  }, [history, slotInfo, reselectAfterHistory]);

  // Global keyboard map. Modifier combos (undo/redo) are always active; the
  // single-key commands are ignored while typing in a form field.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Any keypress clears a lingering edit hint (a refused shift below may set
      // a fresh one within this same handler).
      setEditHint(null);
      const mod = event.metaKey || event.ctrlKey;
      if (mod && (event.key === "z" || event.key === "Z")) {
        event.preventDefault();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
        return;
      }
      if (mod && (event.key === "y" || event.key === "Y")) {
        event.preventDefault();
        redo();
        return;
      }
      if (mod && (event.key === "c" || event.key === "C")) {
        event.preventDefault();
        copyMeasureSelection();
        return;
      }
      if (mod && (event.key === "x" || event.key === "X")) {
        event.preventDefault();
        cutMeasureSelection();
        return;
      }
      if (mod && (event.key === "v" || event.key === "V")) {
        event.preventDefault();
        pasteMeasureSelection();
        return;
      }
      if (mod) {
        return;
      }
      // Alt-modified keys are browser/OS shortcuts (e.g. Alt+D focuses the URL
      // bar). Leave them to the browser rather than treating Alt+letter as note
      // entry.
      if (event.altKey) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
        return;
      }

      const key = event.key;
      if (key === " ") {
        event.preventDefault();
        onListen();
        return;
      }
      if (key === "Escape") {
        event.preventDefault();
        if (listen.playing) {
          listen.stop();
        }
        stepOut();
        return;
      }

      if (!editable) {
        return;
      }

      switch (key) {
        case "Enter":
          event.preventDefault();
          drillIn();
          return;
        case "Tab":
          event.preventDefault();
          cycleChord(event.shiftKey ? -1 : 1);
          return;
        case "Delete":
        case "Backspace":
          event.preventDefault();
          deleteSelection();
          return;
        case "ArrowLeft":
          event.preventDefault();
          if (event.shiftKey) {
            extendMeasureRange(-1);
          } else {
            navBeat(-1);
          }
          return;
        case "ArrowRight":
          event.preventDefault();
          if (event.shiftKey) {
            extendMeasureRange(1);
          } else {
            navBeat(1);
          }
          return;
        case "ArrowUp":
          event.preventDefault();
          arrowPitch(1, event.shiftKey);
          return;
        case "ArrowDown":
          event.preventDefault();
          arrowPitch(-1, event.shiftKey);
          return;
        case "-":
        case "_":
          event.preventDefault();
          accidentalOnFocus(-1);
          return;
        case "=":
        case "+":
          event.preventDefault();
          accidentalOnFocus(1);
          return;
        case "0":
          event.preventDefault();
          accidentalOnFocus(0);
          return;
        case ",":
        case "<":
          event.preventDefault();
          shiftSelectionInTime(-1);
          return;
        case ".":
        case ">":
          event.preventDefault();
          shiftSelectionInTime(1);
          return;
        default:
          break;
      }

      const upper = key.length === 1 ? key.toUpperCase() : "";
      // "".includes("") is true, so an empty `upper` (any multi-character key
      // name — Shift, CapsLock, Home, …) must be excluded explicitly, or a
      // bare modifier-key press (e.g. holding Shift for a shift-click) would
      // silently add a bogus empty-pitch chord note.
      if (upper !== "" && "ABCDEFG".includes(upper)) {
        event.preventDefault();
        addLetter(upper as Pitch["step"]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    editable,
    listen,
    onListen,
    stepOut,
    drillIn,
    cycleChord,
    deleteSelection,
    navBeat,
    extendMeasureRange,
    arrowPitch,
    accidentalOnFocus,
    addLetter,
    shiftSelectionInTime,
    undo,
    redo,
    copyMeasureSelection,
    cutMeasureSelection,
    pasteMeasureSelection,
  ]);

  // Shared tail of every import path: parse, stamp provenance, load into
  // history, and (for OMR) open the cleanup review panel.
  const finishImport = useCallback(
    (
      imported: string,
      importMethod: "optical-music-recognition" | "midi-conversion" | null,
      sourceFileName: string,
      midiTempo: number | null,
      review: ImportReview | null,
      embeddedReviewPayload: EmbeddedReviewPayload | null = null,
    ) => {
      const doc = parseDocument(imported);
      // Stamp how/when/from-what the document was imported (conversions only).
      if (importMethod) {
        stampImportProvenance(doc, {
          method: importMethod,
          sourceFile: sourceFileName,
        });
      }
      if (midiTempo !== null) {
        writeTempo(doc, midiTempo);
      }
      if (embeddedReviewPayload) {
        writeEmbeddedReview(doc, embeddedReviewPayload);
      }
      // A fresh OMR import opens its cleanup panel using the live review data;
      // otherwise, fall back to whatever review data the opened file itself
      // carries (from a previous session's "Embed review data" export).
      const restoredReview = review ?? readEmbeddedReview(doc);
      history.reset(doc);
      setSelection(null);
      setMenu(null);
      setImportReview(restoredReview);
      setReviewOpen(restoredReview !== null);
    },
    [history],
  );

  // "Append Import"'s tail: append the imported score onto the end of the
  // live document (rather than replacing it, as `finishImport` does) — the
  // flow for a series of page screenshots that should all end up in one
  // file. Fails (surfacing `appendError`) when the imported score isn't in
  // the editor's single-part shape or its staff count doesn't match the live
  // document's; a mismatched OMR/MIDI conversion has no other sensible target.
  const finishAppend = useCallback(
    (
      imported: string,
      sourceFileName: string,
      review: ImportReview | null,
      embeddedReviewPayload: EmbeddedReviewPayload | null = null,
    ) => {
      const result = appendScore(documentRef.current, imported);
      if (!result) {
        setAppendError(
          `Couldn't append "${sourceFileName}": its part/staff layout doesn't match this score.`,
        );
        return;
      }
      setAppendError(null);
      if (embeddedReviewPayload) {
        writeEmbeddedReview(
          documentRef.current,
          offsetEmbeddedReviewPayload(
            embeddedReviewPayload,
            result.firstAppendedMeasureIndex,
          ),
        );
      }
      commit();
      setSelection(null);
      setMenu(null);
      // Shift the appended import's review data (measure/page indices) past
      // whatever the document already had, then merge it into the existing
      // review (if any) so cleanup can continue across every append.
      if (review) {
        setImportReview((prev) => {
          const pageOffset = prev?.pages.length ?? 0;
          return {
            pages: [...(prev?.pages ?? []), ...review.pages],
            systems: [
              ...(prev?.systems ?? []),
              ...review.systems.map((system) => ({
                ...system,
                page: system.page + pageOffset,
                firstMeasure:
                  system.firstMeasure + result.firstAppendedMeasureIndex,
              })),
            ],
            flaggedNotes: [
              ...(prev?.flaggedNotes ?? []),
              ...review.flaggedNotes.map((flagged) => ({
                ...flagged,
                measureIndex:
                  flagged.measureIndex + result.firstAppendedMeasureIndex,
              })),
            ],
          };
        });
        setReviewOpen(true);
      }
      // Jump the selection/scroll to the first appended measure so the user
      // lands on the new content rather than staying scrolled where they were.
      const freshScore = parseScore(serializeDocument(documentRef.current));
      const beat =
        computeMeasureStartBeats(freshScore)[result.firstAppendedMeasureIndex];
      if (beat !== undefined) {
        const slot = slotAtBeat(freshScore, beat, 0.5, 0);
        if (slot) {
          setSelection({
            kind: "slot",
            partIndex: slot.partIndex,
            measureIndex: slot.measureIndex,
            onsetBeat: slot.onsetBeat,
          });
        }
        snapBeatRef.current = beat;
        setSnapGeneration((generation) => generation + 1);
      }
    },
    [documentRef, commit],
  );

  const onImport = useCallback(
    async (event: Event) => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (!file) {
        return;
      }
      if (isImportableImage(file)) {
        // OMR's only user-facing knobs are the inference backend and staff-
        // detection mode, collected by ImageImportDialog before recognition
        // runs — see onImageImportConfirm.
        setPendingImage({ file, importMode: "replace" });
      } else if (isMxl(file)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const imported = await extractMusicXmlFromMxl(bytes);
        finishImport(imported, null, file.name, null, null);
      } else if (isMidi(file)) {
        // MIDI conversion has choices (tracks, quantization, staff split,
        // key inference) that the confirmation dialog collects before the
        // actual conversion runs — see onMidiImportConfirm.
        const bytes = new Uint8Array(await file.arrayBuffer());
        const parsed = parseMidi(bytes);
        setPendingMidi({
          fileName: file.name,
          midiData: parsed,
          tracks: getMidiTracks(parsed),
          explicitKey: getMidiKeySignature(parsed),
          importMode: "replace",
        });
      } else {
        const imported = await file.text();
        finishImport(imported, null, file.name, null, null);
      }
    },
    [finishImport],
  );

  // "Append Import": same file handling as `onImport`, but every path ends in
  // `finishAppend` (or a dialog whose confirm handler branches on
  // `importMode`) instead of replacing the document.
  const onAppendImport = useCallback(
    async (event: Event) => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (!file) {
        return;
      }
      if (isImportableImage(file)) {
        setPendingImage({ file, importMode: "append" });
      } else if (isMxl(file)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const imported = await extractMusicXmlFromMxl(bytes);
        finishAppend(imported, file.name, null);
      } else if (isMidi(file)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const parsed = parseMidi(bytes);
        setPendingMidi({
          fileName: file.name,
          midiData: parsed,
          tracks: getMidiTracks(parsed),
          explicitKey: getMidiKeySignature(parsed),
          importMode: "append",
        });
      } else {
        const imported = await file.text();
        finishAppend(imported, file.name, null);
      }
    },
    [finishAppend],
  );

  const onImageImportConfirm = useCallback(
    async (choice: ImageImportChoice) => {
      if (!pendingImage) {
        return;
      }
      const { file, importMode } = pendingImage;
      setImageImportChoice(choice);
      setPendingImage(null);
      const result = await imageImport.importImage(file, choice);
      if (result === null) {
        return;
      }
      const embeddedReviewPayload =
        choice.embedReviewData && result.review
          ? await buildEmbeddedReviewPayload(result.review)
          : null;
      if (importMode === "append") {
        finishAppend(
          result.musicXml,
          file.name,
          result.review,
          embeddedReviewPayload,
        );
        return;
      }
      finishImport(
        result.musicXml,
        "optical-music-recognition",
        file.name,
        null,
        result.review,
        embeddedReviewPayload,
      );
    },
    [pendingImage, imageImport, finishImport, finishAppend],
  );

  const onMidiImportConfirm = useCallback(
    (choice: MidiImportChoice) => {
      if (!pendingMidi) {
        return;
      }
      const imported = convertMidiToMusicXml(pendingMidi.midiData, choice);
      if (pendingMidi.importMode === "append") {
        finishAppend(imported, pendingMidi.fileName, null);
        setPendingMidi(null);
        return;
      }
      const midiTempo = getMidiTempo(pendingMidi.midiData);
      finishImport(
        imported,
        "midi-conversion",
        pendingMidi.fileName,
        midiTempo,
        null,
      );
      setPendingMidi(null);
    },
    [pendingMidi, finishImport, finishAppend],
  );

  const onExport = useCallback(() => {
    const blob = new Blob([musicxml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "score.musicxml";
    anchor.click();
    URL.revokeObjectURL(url);
    history.markSaved();
  }, [history, musicxml]);

  // Context-menu items act on the current selection.
  const canNudge = focused !== null;
  const isMeasureRangeSelection = selection?.kind === "measureRange";
  const canDelete =
    isMeasureRangeSelection ||
    (hasSelection && (slotInfo ? !slotInfo.isRest : true));
  const menuItems: ContextMenuItem[] = [
    {
      label: "Move up",
      onSelect: () => {
        if (focused) {
          stepHandle(focused, 1, false);
        }
      },
      disabled: !canNudge,
    },
    {
      label: "Move down",
      onSelect: () => {
        if (focused) {
          stepHandle(focused, -1, false);
        }
      },
      disabled: !canNudge,
    },
    {
      label: "Add note",
      onSelect: () => addNoteAtSlot(),
      disabled: !slotInfo,
    },
    // Time shifts move the selected chord and everything after it in the
    // measure as a block, by the chord's own duration (see
    // `shiftSelectionInTime`).
    {
      label: "Shift later in time",
      onSelect: () => shiftSelectionInTime(1),
      disabled: !slotInfo || slotInfo.isRest,
    },
    {
      label: "Shift earlier in time",
      onSelect: () => shiftSelectionInTime(-1),
      disabled: !slotInfo || slotInfo.isRest,
    },
    // Copy/Cut only appear for an explicit measure-range selection (shift-
    // click/drag or Shift+←/→) — not for an ordinary note/beat selection,
    // where "Cut measure(s)" acting on the whole containing measure would be
    // a surprise. Paste and Delete stay available regardless: paste always
    // targets the current position, and Delete already labels itself
    // correctly for either selection kind.
    ...(isMeasureRangeSelection
      ? [
          { label: "Copy measure(s)", onSelect: copyMeasureSelection },
          { label: "Cut measure(s)", onSelect: cutMeasureSelection },
        ]
      : []),
    {
      label: "Paste measure(s)",
      onSelect: pasteMeasureSelection,
      disabled: !clipboard,
    },
    {
      label: isMeasureRangeSelection ? "Delete measure(s)" : "Delete",
      onSelect: deleteSelection,
      disabled: !canDelete,
    },
  ];

  // Accidental toolbar buttons act on the drilled note.
  const accidentalButtonStyle = (enabled: boolean) =>
    ({
      width: 30,
      height: 28,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: RADIUS.button,
      border: `1px solid ${COLORS.borderButton}`,
      background: COLORS.canvas,
      color: enabled ? COLORS.textPrimary : COLORS.textPlaceholder,
      cursor: enabled ? "pointer" : "default",
      fontFamily: FONTS.music,
      fontSize: 15,
    }) as const;

  const selectionReadout =
    selection?.kind === "measureRange"
      ? `Sel: m.${
          Math.min(selection.startMeasureIndex, selection.endMeasureIndex) + 1
        }–${
          Math.max(selection.startMeasureIndex, selection.endMeasureIndex) + 1
        }`
      : slotInfo
        ? slotInfo.isRest
          ? `Sel: m.${slotInfo.measureIndex + 1} · rest`
          : `Sel: m.${slotInfo.measureIndex + 1} · ${slotInfo.notes.length} ${
              slotInfo.notes.length === 1 ? "note" : "notes"
            }`
        : "No selection";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        boxSizing: "border-box",
        fontFamily: FONTS.ui,
        background: COLORS.appBg,
        color: COLORS.textPrimary,
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          minHeight: LAYOUT.toolbarHeight,
          padding: "0 12px",
          background: COLORS.panel,
          borderBottom: `1px solid ${COLORS.borderLight}`,
          flexWrap: "wrap",
        }}
      >
        {/* Not scoped to the current file — opens a new document, replacing
            whatever is loaded now (see "Append Import" below for adding onto
            it instead). */}
        <label style={toolbarButtonStyle(!imageImport.busy)}>
          Open/Import New
          <input
            type="file"
            accept=".musicxml,.xml,.mxl,.mid,.midi,audio/midi,.pdf,image/*"
            onChange={onImport}
            disabled={imageImport.busy}
            style={{ display: "none" }}
          />
        </label>
        <span
          style={{ width: 1, height: 22, background: COLORS.borderLight }}
        />
        <button
          type="button"
          onClick={undo}
          disabled={!history.canUndo}
          style={toolbarButtonStyle(history.canUndo)}
        >
          Undo
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={!history.canRedo}
          style={toolbarButtonStyle(history.canRedo)}
        >
          Redo
        </button>
        <button
          type="button"
          onClick={deleteSelection}
          disabled={!canDelete}
          style={toolbarButtonStyle(hasSelection)}
        >
          Delete
        </button>
        <span
          style={{ width: 1, height: 22, background: COLORS.borderLight }}
        />
        <button
          type="button"
          onClick={copyMeasureSelection}
          disabled={!editable || !activeMeasureRange}
          title="Copy the selected measure(s)"
          style={toolbarButtonStyle(editable && activeMeasureRange !== null)}
        >
          Copy
        </button>
        <button
          type="button"
          onClick={cutMeasureSelection}
          disabled={!editable || !activeMeasureRange}
          title="Cut the selected measure(s)"
          style={toolbarButtonStyle(editable && activeMeasureRange !== null)}
        >
          Cut
        </button>
        <button
          type="button"
          onClick={pasteMeasureSelection}
          disabled={!editable || !clipboard}
          title="Paste measure(s) before the current selection"
          style={toolbarButtonStyle(editable && clipboard !== null)}
        >
          Paste
        </button>
        {/* Scoped to the current file: appends onto the end of the live
            document (e.g. a series of page screenshots that should all land
            in one score) rather than replacing it. Undoable like any other
            edit. */}
        <label
          style={toolbarButtonStyle(editable && !imageImport.busy)}
          title="Append an imported file onto the end of this score"
        >
          Append Import
          <input
            type="file"
            accept=".musicxml,.xml,.mxl,.mid,.midi,audio/midi,.pdf,image/*"
            onChange={onAppendImport}
            disabled={!editable || imageImport.busy}
            style={{ display: "none" }}
          />
        </label>
        <span
          style={{ width: 1, height: 22, background: COLORS.borderLight }}
        />
        {(
          [
            { glyph: "♭", value: -1, title: "Flat" },
            { glyph: "♮", value: 0, title: "Natural" },
            { glyph: "♯", value: 1, title: "Sharp" },
          ] as const
        ).map((option) => (
          <button
            key={option.value}
            type="button"
            title={option.title}
            onClick={() => accidentalOnFocus(option.value)}
            disabled={!canNudge}
            style={accidentalButtonStyle(canNudge)}
          >
            {option.glyph}
          </button>
        ))}
        <span
          style={{ width: 1, height: 22, background: COLORS.borderLight }}
        />
        <button
          type="button"
          onClick={onInsertMeasure}
          disabled={!editable}
          style={toolbarButtonStyle(editable)}
        >
          + Measure
        </button>
        <button
          type="button"
          onClick={() => {
            if (activeMeasureRange) {
              deleteMeasureRange(activeMeasureRange);
            }
          }}
          disabled={!editable || !activeMeasureRange}
          title="Delete the selected measure(s)"
          style={toolbarButtonStyle(editable && activeMeasureRange !== null)}
        >
          − Measure
        </button>
        <button
          type="button"
          onClick={onAddStaff}
          disabled={!editable}
          title="Add a staff below the existing staves"
          style={toolbarButtonStyle(editable)}
        >
          + Staff
        </button>
        <button
          type="button"
          onClick={onRemoveStaff}
          disabled={!editable || staffCount <= 1}
          title="Remove the selected staff (or the bottom staff)"
          style={toolbarButtonStyle(editable && staffCount > 1)}
        >
          − Staff
        </button>
        <span style={{ flex: 1 }} />
        {/* Always rendered (hidden when clean) so the first edit doesn't
            reflow the toolbar — a wrap here shifts the whole score canvas
            mid-interaction. */}
        <span
          aria-label="Unsaved changes"
          title="Unsaved changes"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            color: COLORS.warning,
            visibility: dirty ? "visible" : "hidden",
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: COLORS.warningDot,
            }}
          />
          Unsaved
        </span>
        {importReview !== null ? (
          <button
            type="button"
            onClick={() => setReviewOpen((open) => !open)}
            style={{
              ...toolbarButtonStyle(true),
              ...(reviewOpen
                ? {
                    background: COLORS.accentHighlight,
                    border: `1px solid ${COLORS.accentBorder}`,
                    color: COLORS.accent,
                  }
                : {}),
            }}
          >
            Review
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setMetadataOpen(true)}
          style={toolbarButtonStyle(true)}
        >
          Metadata
        </button>
        <button
          type="button"
          onClick={onExport}
          style={toolbarButtonStyle(true)}
        >
          Export
        </button>
        <button
          type="button"
          onClick={onListen}
          style={{
            padding: "6px 14px",
            borderRadius: RADIUS.button,
            border: "none",
            background: listen.playing ? COLORS.green : COLORS.accent,
            color: "#fff",
            cursor: "pointer",
            fontSize: 13,
            fontFamily: FONTS.ui,
          }}
        >
          {listen.playing ? "■ Stop" : "▶ Listen"}
        </button>
      </div>

      {/* Instruction strip — keyboard cheat sheet. */}
      <div
        style={{
          minHeight: LAYOUT.instructionStripHeight,
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          background: COLORS.instructionStrip,
          borderBottom: `1px solid ${COLORS.borderLight}`,
          fontFamily: FONTS.mono,
          fontSize: 11.5,
          color: COLORS.textSecondary,
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <span>Click: select beat · ⇧Click: select measures</span>
        <span>Enter: drill in · Esc: out</span>
        <span>↑↓: pitch (⇧ octave)</span>
        <span>←→: beat · ⇧←→: measures · Tab: cycle</span>
        <span>A–G: add · −/=/0: ♭♯♮ · ,/.: shift in time</span>
        <span>⌘C/X/V: copy/cut/paste measures</span>
        <span>Space: listen</span>
      </div>

      {/* Import status / error. */}
      {imageImport.status !== null ? (
        <div
          style={{
            fontSize: 13,
            color: COLORS.textSecondary,
            padding: "4px 14px",
          }}
        >
          {imageImport.status}
        </div>
      ) : null}
      {imageImport.error !== null ? (
        <div style={{ fontSize: 13, color: COLORS.error, padding: "4px 14px" }}>
          Import failed: {imageImport.error}
        </div>
      ) : null}
      {appendError !== null ? (
        <div style={{ fontSize: 13, color: COLORS.error, padding: "4px 14px" }}>
          {appendError}
        </div>
      ) : null}

      {/* Body: score canvas + inspector. */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            background: COLORS.canvas,
            boxSizing: "border-box",
            // While reviewing, the staves shrink to their content height so the
            // source strip sits directly under them; let the column scroll if
            // the two together outgrow it.
            overflowY: reviewVisible ? "auto" : undefined,
          }}
        >
          <ScoreHeader
            metadata={metadata}
            onEdit={() => setMetadataOpen(true)}
          />
          {/* A pointer-down that lands off the staff SVG (the empty canvas
              around/below the staves) clears the selection. Taps that reach the
              SVG keep their svg ancestor and are handled by handleTap instead. */}
          <div
            style={
              reviewVisible
                ? { flex: "0 0 auto", padding: 8 }
                : { flex: 1, minHeight: 0, padding: 8 }
            }
            onPointerDown={clearSelectionOffStaff}
          >
            <EditableSheetMusic
              musicxml={musicxml}
              noteHighlights={noteHighlights}
              onTap={handleTap}
              onContextMenu={handleContextMenu}
              onRangeSelectMove={handleRangeSelectMove}
              accentColor={COLORS.accent}
              getLiveBeat={listen.getLiveBeat}
              isPlaying={listen.playing}
              scrollLocked={listen.playing}
              selectionBeat={selectionBeat}
              focusNoteId={focusNoteId}
              snapBeatRef={snapBeatRef}
              snapGeneration={snapGeneration}
              fitContent={reviewVisible}
              focusRange={measureFocusRange}
              focusColor={COLORS.accentHighlight}
              overfullBars={overfullBars}
            />
          </div>
          {reviewVisible && importReview !== null ? (
            <>
              <ImportReviewPanel
                review={importReview}
                selectedMeasure={slotInfo?.measureIndex ?? null}
                onSelectMeasure={selectMeasureStart}
                flaggedTargetCount={flaggedTargets.length}
                onNextFlagged={gotoNextFlagged}
                onClose={() => setReviewOpen(false)}
              />
              {/* Fill the leftover column height so clicks below the panel
                  still clear the selection, as they did when the staves' own
                  container covered this space. */}
              <div
                style={{ flex: 1, minHeight: 0 }}
                onPointerDown={clearSelectionOffStaff}
              />
            </>
          ) : null}
        </div>
        <Inspector
          model={inspector?.model ?? null}
          editable={editable}
          onDrill={(index) => {
            const handle = inspector?.handles[index];
            if (handle) {
              setSelection({ kind: "note", handle });
            }
          }}
          onAccidental={(index, alter) => {
            const handle = inspector?.handles[index];
            if (handle) {
              setAccidentalOn(handle, alter);
            }
          }}
          onStep={(index, delta) => {
            const handle = inspector?.handles[index];
            if (handle) {
              stepHandle(handle, delta, false);
            }
          }}
          onRemove={(index) => {
            const handle = inspector?.handles[index];
            if (handle) {
              removeHandle(handle);
            }
          }}
          onToggleTie={(index) => {
            const handle = inspector?.handles[index];
            if (handle) {
              toggleTieOn(handle);
            }
          }}
          onSetDuration={(index, durationBeats) => {
            const handle = inspector?.handles[index];
            if (handle) {
              setDurationOn(handle, durationBeats);
            }
          }}
          onSetNoteDuration={(index, durationBeats) => {
            const handle = inspector?.handles[index];
            if (handle) {
              setMemberDurationOn(handle, durationBeats);
            }
          }}
          onAddNote={(partIndex) => {
            const targetSlot = inspector?.allSlots.find(
              (s) => s.partIndex === partIndex,
            );
            // When the target staff's covering slot started before the selected
            // beat (e.g. a whole rest at beat 0 while beat 1 is selected), pass
            // the selected beat so the note lands at the right rhythmic position.
            addNoteAtSlot(undefined, targetSlot, slotInfo?.onsetBeat);
          }}
          onGraceAccidental={(index, alter) => {
            const handle = inspector?.graceHandles[index];
            if (handle) {
              setGraceAccidentalOn(handle, alter);
            }
          }}
          onGraceStep={(index, delta) => {
            const handle = inspector?.graceHandles[index];
            const pitch = inspector?.gracePitches[index];
            if (handle && pitch) {
              stepGraceHandle(handle, pitch, delta);
            }
          }}
          onGraceRemove={(index) => {
            const handle = inspector?.graceHandles[index];
            if (handle) {
              removeGraceHandle(handle);
            }
          }}
          onGraceReorder={(index, direction) => {
            const handle = inspector?.graceHandles[index];
            if (handle) {
              reorderGraceHandle(handle, direction);
            }
          }}
          onGraceSlash={(index, slash) => {
            const handle = inspector?.graceHandles[index];
            if (handle) {
              setGraceSlashOn(handle, slash);
            }
          }}
          onAddGrace={(index) => {
            const handle = inspector?.handles[index];
            if (handle) {
              addGraceHandle(handle);
            }
          }}
        />
      </div>

      {/* Transport bar. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          minHeight: 40,
          padding: "0 14px",
          background: COLORS.panel,
          borderTop: `1px solid ${COLORS.borderLight}`,
          fontFamily: FONTS.mono,
          fontSize: 12,
          color: COLORS.textMuted,
        }}
      >
        <button
          type="button"
          aria-label={listen.playing ? "Pause" : "Play"}
          onClick={onListen}
          style={{
            border: "none",
            background: "transparent",
            cursor: "pointer",
            fontSize: 14,
            color: listen.playing ? COLORS.green : COLORS.textSecondary,
          }}
        >
          {listen.playing ? "⏸" : "▶"}
        </button>
        <span>♩ = {bpm}</span>
        {editHint !== null ? (
          <span style={{ color: COLORS.warning }}>{editHint}</span>
        ) : null}
        <span style={{ flex: 1 }} />
        <span>{selectionReadout}</span>
      </div>

      {menu && hasSelection ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {metadataOpen ? (
        <MetadataDialog
          metadata={metadata}
          editable={true}
          onSave={onSaveMetadata}
          onClose={() => setMetadataOpen(false)}
        />
      ) : null}

      {pendingMidi ? (
        <MidiImportDialog
          fileName={pendingMidi.fileName}
          tracks={pendingMidi.tracks}
          explicitKey={pendingMidi.explicitKey}
          onConfirm={onMidiImportConfirm}
          onCancel={() => setPendingMidi(null)}
        />
      ) : null}

      {pendingImage ? (
        <ImageImportDialog
          fileName={pendingImage.file.name}
          defaultChoice={imageImportChoice}
          onConfirm={onImageImportConfirm}
          onCancel={() => setPendingImage(null)}
        />
      ) : null}
    </div>
  );
}
