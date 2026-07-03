// Wraps the vendored read-only renderer and adds the editing pointer seam.
// It holds no document: it resolves each raw pointer gesture from the staff SVG
// into a musical `{ beat, pitch, hit }` (via hit-test) and reports it up to the
// Editor, which owns the document and applies the dom-edit op. Visual feedback
// is drawn through the renderer's existing `noteHighlights` prop.
//
// Interaction model (foundation milestone): a primary-button tap reports a
// gesture (the Editor selects, or adds on empty staff); a plain drag is left
// uncaptured so it falls through to the renderer's drag-to-scroll; a
// right-click / long-press reports a context-menu request. Dragging never edits.

import type { NoteHandle } from "../dom-edit";
import { beatFromX, pickNote, pitchFromY } from "../hit-test";
import {
  type NoteHighlight,
  type Pitch,
  SheetMusicDisplay,
  type StagePointerInfo,
} from "../sheet-music/index";

export interface EditorGesture {
  /** Absolute quarter-note beat, snapped to the 16th-note grid. */
  beat: number;
  /** Pitch under the pointer, snapped to the nearest half staff-space. */
  pitch: Pitch;
  /** The note the pointer is over, if any (id for highlight, handle for edits). */
  hit: { id: string; handle: NoteHandle } | null;
  /** The parsed part (staff) nearest the click — 0 for a single staff, or the
   *  treble (0) / bass (1) staff of a grand staff. Lets a tap select/add on the
   *  staff the user actually clicked rather than always the top one. */
  partIndex: number;
  /** True when the click landed well clear of every staff (vertically) — a tap
   *  in the empty margin, which clears the selection rather than selecting. */
  offStaff: boolean;
}

// How far (in staff-spaces) beyond a staff's own extent a click still counts as
// "on" that staff. Generous enough to cover ledger-line notes a few spaces out;
// past it a click reads as the empty margin and clears the selection.
const OFF_STAFF_MARGIN_SPACES = 4;

/** A right-click / long-press request: a beat (and 1-indexed measure) plus the
 *  viewport coordinates to anchor a context menu at. */
export interface ContextMenuRequest {
  measureNumber: number;
  beat: number;
  clientX: number;
  clientY: number;
}

function resolveGesture(info: StagePointerInfo): EditorGesture {
  const beat = beatFromX(
    info.svgX,
    info.score,
    info.layout,
    info.measureStartBeats,
  );
  // For grand staff there are multiple parts (one per staff), each at a
  // different Y. Find the staff whose vertical extent is nearest the click: for
  // a click within a staff the distance is zero; for a click between staves it
  // resolves to whichever staff is closest. This ensures clicking the bass staff
  // yields bass-range pitches rather than treble-range ones.
  let partIndex = 0;
  let minDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < info.layout.staffBottomYs.length; i++) {
    const bottomY = info.layout.staffBottomYs[i] ?? 0;
    const topY = bottomY - 4 * info.layout.staffSpace;
    const clampedY = Math.max(topY, Math.min(bottomY, info.svgY));
    const dist = Math.abs(clampedY - info.svgY);
    if (dist < minDist) {
      minDist = dist;
      partIndex = i;
    }
  }
  const clef = info.score.parts[partIndex]?.clef ?? {
    sign: "G" as const,
    line: 2,
  };
  const staffBottomY = info.layout.staffBottomYs[partIndex] ?? 0;
  const pitch = pitchFromY(
    info.svgY,
    staffBottomY,
    info.layout.staffSpace,
    clef,
  );
  const offStaff = minDist > OFF_STAFF_MARGIN_SPACES * info.layout.staffSpace;
  return {
    beat,
    pitch,
    hit: pickNote(info.score, beat, pitch),
    partIndex,
    offStaff,
  };
}

export function EditableSheetMusic({
  musicxml,
  noteHighlights,
  onTap,
  onContextMenu,
  accentColor,
  textFontFamily = "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",
  getLiveBeat,
  isPlaying,
  scrollLocked,
  selectionBeat,
  focusNoteId,
  snapBeatRef,
  snapGeneration,
  fitContent = false,
  focusRange,
  focusColor,
}: {
  musicxml: string;
  noteHighlights?: ReadonlyArray<NoteHighlight>;
  /** Primary-button tap on the staff (a non-drag). */
  onTap?: (gesture: EditorGesture, event: PointerEvent) => void;
  /** Right-click / long-press on the staff. */
  onContextMenu?: (request: ContextMenuRequest) => void;
  /** Accent color for the playback cursor (and any selection chrome). */
  accentColor?: string;
  /** Font family for measure numbers. */
  textFontFamily?: string;
  /** Playback cursor beat source (drives the on-score cursor + scroll-follow). */
  getLiveBeat?: () => number | null;
  /** Whether playback is active (runs the cursor rAF loop). */
  isPlaying?: boolean;
  /** Disable user scroll while playing. */
  scrollLocked?: boolean;
  /** Absolute quarter-note beat for the Level 1 beat-box selection chrome. */
  selectionBeat?: number | null;
  /** Note id (from noteInfos) for the Level 2 note-ring chrome. */
  focusNoteId?: string | null;
  /** Beat to instant-scroll to when `snapGeneration` changes (see renderer). */
  snapBeatRef?: { current: number | null };
  /** Bump to trigger the snap scroll (fires even for a repeated beat). */
  snapGeneration?: number;
  /**
   * Size the scroll container to the staves' own height instead of filling the
   * parent — used while the import-review panel sits directly below the music.
   */
  fitContent?: boolean;
  /** Tinted background over a measure range (1-indexed, inclusive) — the
   *  measure-range selection's chrome. No `onFocusRangeChange` is passed
   *  through, so this never grows the renderer's draggable scrubber pills. */
  focusRange?: { from: number; to: number } | null;
  /** Fill color for `focusRange`. */
  focusColor?: string;
}) {
  return (
    <SheetMusicDisplay
      musicxml={musicxml}
      noteHighlights={noteHighlights}
      accentColor={accentColor}
      textFontFamily={textFontFamily}
      getLiveBeat={getLiveBeat}
      isPlaying={isPlaying}
      scrollLocked={scrollLocked}
      selectionBeat={selectionBeat}
      focusNoteId={focusNoteId}
      snapBeatRef={snapBeatRef}
      snapGeneration={snapGeneration}
      focusRange={focusRange}
      focusColor={focusColor}
      // Allow horizontal pan: a plain drag scrolls rather than edits.
      containerStyle={{
        touchAction: "pan-x",
        height: fitContent ? "auto" : "100%",
        cursor: "default",
      }}
      // Leave the pointer uncaptured so a drag reaches the container's
      // drag-to-scroll; we only act on the (primary-button) down as a tap.
      captureStagePointer={false}
      onStagePointerDown={(info, event) => {
        // Ignore non-primary buttons here — right-click is handled by the
        // context-menu seam, which also fires its own pointerdown.
        if (event.button !== 0) {
          return;
        }
        onTap?.(resolveGesture(info), event);
      }}
      onSheetContextMenu={onContextMenu}
    />
  );
}
