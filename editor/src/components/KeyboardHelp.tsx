// A dismissable overlay listing the editor's keyboard shortcuts and gestures.
// Replaces the always-on cheat-sheet strip that used to sit under the toolbar:
// discoverability on demand (the "?" button or key) instead of permanent
// screen real estate. Grouped by task so it reads as reference, not noise.

import { useEffect, useRef } from "preact/hooks";
import { COLORS, FONTS, RADIUS } from "../theme";

interface Shortcut {
  keys: string[];
  label: string;
}

interface Group {
  heading: string;
  shortcuts: Shortcut[];
}

// The canonical shortcut reference. Kept here (not scattered across button
// tooltips) so there is one source of truth for what the editor responds to.
const GROUPS: Group[] = [
  {
    heading: "Select",
    shortcuts: [
      { keys: ["Click"], label: "Select a beat" },
      { keys: ["Enter"], label: "Drill into a note" },
      { keys: ["Esc"], label: "Step back out" },
      { keys: ["⇧", "Click"], label: "Select measures" },
      { keys: ["←", "→"], label: "Move by beat" },
      { keys: ["⇧", "←", "→"], label: "Extend by measure" },
      { keys: ["Tab"], label: "Cycle notes in a chord" },
    ],
  },
  {
    heading: "Edit notes",
    shortcuts: [
      { keys: ["A", "–", "G"], label: "Add a note at the selected rest" },
      { keys: ["↑", "↓"], label: "Move pitch by step (⇧ = octave)" },
      { keys: ["−", "=", "0"], label: "Flat / sharp / natural" },
      { keys: [",", "."], label: "Shift the selection earlier / later" },
      { keys: ["v"], label: "Move to the other voice" },
      { keys: ["⌫"], label: "Delete the selection" },
    ],
  },
  {
    heading: "Measures & playback",
    shortcuts: [
      { keys: ["⌘", "C"], label: "Copy measures" },
      { keys: ["⌘", "X"], label: "Cut measures" },
      { keys: ["⌘", "V"], label: "Paste measures" },
      { keys: ["Space"], label: "Play / stop" },
    ],
  },
];

function Key({ children }: { children: string }) {
  return (
    <kbd
      style={{
        display: "inline-block",
        minWidth: 18,
        padding: "2px 6px",
        fontFamily: FONTS.mono,
        fontSize: 11.5,
        lineHeight: 1.3,
        textAlign: "center",
        color: COLORS.textPrimary,
        background: COLORS.panel,
        border: `1px solid ${COLORS.borderButton}`,
        borderRadius: 4,
        boxShadow: `0 1px 0 ${COLORS.borderButton}`,
      }}
    >
      {children}
    </kbd>
  );
}

export interface KeyboardHelpProps {
  onClose: () => void;
}

export function KeyboardHelp({ onClose }: KeyboardHelpProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    const onCancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog?.addEventListener("cancel", onCancel);
    return () => dialog?.removeEventListener("cancel", onCancel);
  }, [onClose]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss; Esc closes via the dialog cancel event
    <dialog
      ref={dialogRef}
      aria-label="Keyboard shortcuts"
      onClick={(event) => {
        if (event.target === dialogRef.current) {
          onClose();
        }
      }}
      style={{
        width: "100%",
        maxWidth: 560,
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: `1px solid ${COLORS.borderLight}`,
          }}
        >
          <span
            style={{ fontSize: 15, fontWeight: 600, color: COLORS.textPrimary }}
          >
            Keyboard shortcuts
          </span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              border: "none",
              background: "transparent",
              color: COLORS.textMuted,
              cursor: "pointer",
              fontSize: 16,
            }}
          >
            ✕
          </button>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
            gap: "18px 28px",
            padding: 18,
          }}
        >
          {GROUPS.map((group) => (
            <div key={group.heading}>
              <div
                style={{
                  fontSize: 11,
                  fontFamily: FONTS.mono,
                  letterSpacing: ".04em",
                  textTransform: "uppercase",
                  color: COLORS.textFaint,
                  marginBottom: 8,
                }}
              >
                {group.heading}
              </div>
              {group.shortcuts.map((shortcut) => (
                <div
                  key={shortcut.label}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "3px 0",
                  }}
                >
                  <span style={{ fontSize: 12.5, color: COLORS.textSecondary }}>
                    {shortcut.label}
                  </span>
                  <span style={{ display: "flex", gap: 3, flexShrink: 0 }}>
                    {shortcut.keys.map((key, index) => (
                      <Key key={`${shortcut.label}-${index}`}>{key}</Key>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </dialog>
  );
}
