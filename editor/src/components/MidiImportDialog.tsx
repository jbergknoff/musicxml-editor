// A modal confirmation dialog shown before a MIDI file is converted to
// MusicXML. MIDI conversion has choices no other import format needs — which
// tracks to bring in (and whether to arrange the selected notes into one
// piano part split across treble/bass clef by pitch, whether that's one
// track's notes or several tracks' merged together), how fine a rhythmic
// grid to quantize to, and whether to infer a key
// signature from the notes themselves (most MIDI files carry no key-signature
// meta event, so without this every accidental defaults to a sharp spelling
// in C major regardless of the piece's actual key). This is a pure form: the
// Editor owns the actual conversion and hands the chosen options to
// `convertMidiToMusicXml`.

import { useEffect, useRef, useState } from "preact/hooks";
import {
  DEFAULT_MIDI_IMPORT_OPTIONS,
  type QuantizeGrid,
  type TrackInfo,
  keySignatureName,
} from "../../../lib/midi-to-musicxml";
import { COLORS, FONTS, RADIUS } from "../theme";

export interface MidiImportChoice {
  trackIndices: number[];
  quantizeGrid: QuantizeGrid;
  mergeTracks: boolean;
  splitPoint: number;
  inferKey: boolean;
}

export interface MidiImportDialogProps {
  fileName: string;
  tracks: TrackInfo[];
  /** The key signature the file itself specifies (a `keySignature` meta
   *  event), or null when it has none. When set, key inference has nothing
   *  to override and the toggle is disabled. */
  explicitKey: { fifths: number; mode: string } | null;
  onConfirm: (choice: MidiImportChoice) => void;
  onCancel: () => void;
}

const GRID_OPTIONS: Array<{ value: QuantizeGrid; label: string }> = [
  { value: 8, label: "8th note (coarse)" },
  { value: 16, label: "16th note (default)" },
  { value: 32, label: "32nd note (fine)" },
];

// Middle C = MIDI note 60 = octave 4 in the (Yamaha/scientific) convention
// this editor uses elsewhere (see noteNumberToPitch in midi-to-musicxml.ts).
function noteNumberName(n: number): string {
  const steps = [
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
  const octave = Math.floor(n / 12) - 1;
  return `${steps[((n % 12) + 12) % 12]}${octave}`;
}

export function MidiImportDialog({
  fileName,
  tracks,
  explicitKey,
  onConfirm,
  onCancel,
}: MidiImportDialogProps) {
  const hasExplicitKey = explicitKey !== null;
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(tracks.map((t) => t.index)),
  );
  const [quantizeGrid, setQuantizeGrid] = useState<QuantizeGrid>(
    DEFAULT_MIDI_IMPORT_OPTIONS.quantizeGrid,
  );
  const [mergeTracks, setMergeTracks] = useState(
    DEFAULT_MIDI_IMPORT_OPTIONS.mergeTracks,
  );
  const [splitPoint, setSplitPoint] = useState(
    DEFAULT_MIDI_IMPORT_OPTIONS.splitPoint,
  );
  const [inferKey, setInferKey] = useState(!hasExplicitKey);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    const onCancelEvent = (event: Event) => {
      event.preventDefault();
      onCancel();
    };
    dialog?.addEventListener("cancel", onCancelEvent);
    return () => dialog?.removeEventListener("cancel", onCancelEvent);
  }, [onCancel]);

  const toggleTrack = (index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const canImport = selected.size > 0;

  const labelStyle = {
    display: "block",
    fontSize: 11,
    fontFamily: FONTS.mono,
    letterSpacing: ".04em",
    textTransform: "uppercase" as const,
    color: COLORS.textFaint,
    marginBottom: 6,
  };

  const selectStyle = {
    width: "100%",
    boxSizing: "border-box" as const,
    padding: "7px 9px",
    fontSize: 13,
    fontFamily: FONTS.ui,
    color: COLORS.textPrimary,
    background: COLORS.canvas,
    border: `1px solid ${COLORS.borderButton}`,
    borderRadius: RADIUS.button,
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss; Esc closes via the dialog cancel event
    <dialog
      ref={dialogRef}
      aria-label="Import MIDI"
      onClick={(event) => {
        if (event.target === dialogRef.current) {
          onCancel();
        }
      }}
      style={{
        width: "100%",
        maxWidth: 480,
        padding: 0,
        margin: "auto",
        border: "none",
        background: "transparent",
        color: COLORS.textPrimary,
      }}
    >
      <div
        style={{
          background: COLORS.canvas,
          borderRadius: RADIUS.overlay,
          border: `1px solid ${COLORS.borderLight}`,
          boxShadow: "0 12px 40px rgba(0,0,0,0.22)",
          fontFamily: FONTS.ui,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            padding: "14px 18px",
            borderBottom: `1px solid ${COLORS.borderLight}`,
          }}
        >
          <span
            style={{ fontSize: 15, fontWeight: 600, color: COLORS.textPrimary }}
          >
            Import MIDI
          </span>
          <span
            style={{
              fontSize: 12,
              color: COLORS.textMuted,
              fontFamily: FONTS.mono,
              wordBreak: "break-all",
            }}
          >
            {fileName}
          </span>
        </div>

        <div
          style={{
            padding: 18,
            display: "flex",
            flexDirection: "column",
            gap: 16,
            maxHeight: "60vh",
            overflowY: "auto",
          }}
        >
          {/* Track selection */}
          <div>
            <span style={labelStyle}>
              Tracks ({selected.size} of {tracks.length} selected)
            </span>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                border: `1px solid ${COLORS.borderLight}`,
                borderRadius: RADIUS.row,
                padding: 8,
              }}
            >
              {tracks.map((track) => (
                <label
                  key={track.index}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 13,
                    padding: "3px 4px",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(track.index)}
                    onChange={() => toggleTrack(track.index)}
                  />
                  <span style={{ flex: 1, color: COLORS.textPrimary }}>
                    {track.name}
                  </span>
                  <span style={{ color: COLORS.textFaint, fontSize: 12 }}>
                    {track.noteCount} {track.noteCount === 1 ? "note" : "notes"}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Quantization grid */}
          <label>
            <span style={labelStyle}>Quantization grid</span>
            <select
              value={quantizeGrid}
              onChange={(event) =>
                setQuantizeGrid(
                  Number(
                    (event.currentTarget as HTMLSelectElement).value,
                  ) as QuantizeGrid,
                )
              }
              style={selectStyle}
            >
              {GRID_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          {/* Track merging + staff split point */}
          <div>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={mergeTracks}
                onChange={(event) =>
                  setMergeTracks(
                    (event.currentTarget as HTMLInputElement).checked,
                  )
                }
              />
              <span>Arrange into one piano part (treble + bass clef)</span>
            </label>
            {mergeTracks ? (
              <div style={{ marginTop: 10 }}>
                <span style={labelStyle}>
                  Staff split point — {noteNumberName(splitPoint)} and above
                  goes to the treble staff
                </span>
                <input
                  type="range"
                  min={21}
                  max={108}
                  value={splitPoint}
                  onInput={(event) =>
                    setSplitPoint(
                      Number((event.currentTarget as HTMLInputElement).value),
                    )
                  }
                  style={{ width: "100%" }}
                />
              </div>
            ) : null}
          </div>

          {/* Key signature inference */}
          <div>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                cursor: hasExplicitKey ? "default" : "pointer",
                opacity: hasExplicitKey ? 0.5 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={inferKey}
                disabled={hasExplicitKey}
                onChange={(event) =>
                  setInferKey((event.currentTarget as HTMLInputElement).checked)
                }
              />
              <span>Infer key signature from the notes</span>
            </label>
            <span
              style={{
                display: "block",
                fontSize: 12,
                color: COLORS.textFaint,
                marginTop: 4,
                marginLeft: 24,
              }}
            >
              {explicitKey
                ? `This file specifies ${keySignatureName(explicitKey.fifths, explicitKey.mode)}; inference is disabled because it wouldn't be used.`
                : "This file has no key signature — without inference, accidentals default to C major spelling."}
            </span>
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 18px",
            borderTop: `1px solid ${COLORS.borderLight}`,
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "7px 14px",
              borderRadius: RADIUS.button,
              border: `1px solid ${COLORS.borderButton}`,
              background: COLORS.canvas,
              color: COLORS.textPrimary,
              cursor: "pointer",
              fontSize: 13,
              fontFamily: FONTS.ui,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canImport}
            onClick={() =>
              onConfirm({
                trackIndices: [...selected].sort((a, b) => a - b),
                quantizeGrid,
                mergeTracks,
                splitPoint,
                inferKey,
              })
            }
            style={{
              padding: "7px 16px",
              borderRadius: RADIUS.button,
              border: "none",
              background: canImport ? COLORS.accent : COLORS.borderButton,
              color: "#fff",
              cursor: canImport ? "pointer" : "default",
              fontSize: 13,
              fontFamily: FONTS.ui,
            }}
          >
            Import
          </button>
        </div>
      </div>
    </dialog>
  );
}
