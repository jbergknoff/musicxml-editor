// A modal confirmation dialog for the "Redistribute across staves" toolbar
// command. Redistribution is destructive — it rewrites the whole part's staff
// and voice layout, moving every note onto a two-staff grand staff by pitch — so
// this explains what will happen and lets the user pick the split point (the
// pitch boundary between the treble and bass staves), mirroring the MIDI import
// dialog's staff-split control. The Editor owns the actual edit
// (`redistributeStaves`) and this dialog just collects the threshold.

import { useEffect, useRef, useState } from "preact/hooks";
import { COLORS, FONTS, RADIUS } from "../theme";

// Middle C = MIDI note 60 = octave 4 (the scientific convention used elsewhere;
// matches MidiImportDialog's split-point control).
const DEFAULT_SPLIT_POINT = 60;

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

export interface RedistributeStavesDialogProps {
  /** How many staves the part currently has, for the explanatory copy. */
  staffCount: number;
  onConfirm: (splitPoint: number) => void;
  onCancel: () => void;
}

export function RedistributeStavesDialog({
  staffCount,
  onConfirm,
  onCancel,
}: RedistributeStavesDialogProps) {
  const [splitPoint, setSplitPoint] = useState(DEFAULT_SPLIT_POINT);
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

  const labelStyle = {
    display: "block",
    fontSize: 11,
    fontFamily: FONTS.mono,
    letterSpacing: ".04em",
    textTransform: "uppercase" as const,
    color: COLORS.textFaint,
    marginBottom: 6,
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss; Esc closes via the dialog cancel event
    <dialog
      ref={dialogRef}
      aria-label="Redistribute across staves"
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
            Redistribute across staves
          </span>
        </div>

        <div
          style={{
            padding: 18,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: 13,
              lineHeight: 1.5,
              color: COLORS.textMuted,
            }}
          >
            {staffCount > 1
              ? `Combine all notes from this score's ${staffCount} staves onto two staves`
              : "Split every note in this score onto two staves"}{" "}
            — a treble staff for the right hand and a bass staff for the left.
            Each note is assigned by pitch. This replaces the current staff and
            voice layout; rhythm and pitches are preserved.
          </p>

          {/* Staff split point */}
          <div>
            <span style={labelStyle}>
              Staff split point — {noteNumberName(splitPoint)} and above goes to
              the treble staff
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
            onClick={() => onConfirm(splitPoint)}
            style={{
              padding: "7px 16px",
              borderRadius: RADIUS.button,
              border: "none",
              background: COLORS.accent,
              color: "#fff",
              cursor: "pointer",
              fontSize: 13,
              fontFamily: FONTS.ui,
            }}
          >
            Redistribute
          </button>
        </div>
      </div>
    </dialog>
  );
}
