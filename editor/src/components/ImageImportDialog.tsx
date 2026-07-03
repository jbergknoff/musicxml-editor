// A modal confirmation dialog shown before a PDF/image is recognized by the
// OMR pipeline (lib/import-image). Unlike MIDI conversion, OMR has no
// per-file structural choices (no tracks, no key to infer) — its only
// user-facing knobs are which inference backend runs the models and how
// stafflines are located, both fixed for the whole run (changing either
// recreates the pipeline's worker; see use-image-import.ts). This is a pure
// form: the Editor owns the actual recognition and hands the chosen options
// to `imageImport.importImage`.

import { useEffect, useRef, useState } from "preact/hooks";
import type {
  BackendChoice,
  StaffDetectionMode,
} from "../../../lib/import-image/index";
import { COLORS, FONTS, RADIUS } from "../theme";

export interface ImageImportChoice {
  backend: BackendChoice;
  staffDetection: StaffDetectionMode;
  /**
   * Embed the source page crops + alignment data used by the review panel
   * into the exported MusicXML, so a later session can reopen the file with
   * the review panel restored. Inflates the file (a base64 PNG per system).
   */
  embedReviewData: boolean;
}

export interface ImageImportDialogProps {
  fileName: string;
  defaultChoice: ImageImportChoice;
  onConfirm: (choice: ImageImportChoice) => void;
  onCancel: () => void;
}

const BACKEND_OPTIONS: Array<{ value: BackendChoice; label: string }> = [
  { value: "auto", label: "Auto (WebGPU if available)" },
  { value: "webgpu", label: "WebGPU" },
  { value: "wasm", label: "WASM (CPU)" },
];

const STAFF_DETECTION_OPTIONS: Array<{
  value: StaffDetectionMode;
  label: string;
}> = [
  { value: "classical", label: "Classical (fast, model-free)" },
  { value: "model", label: "Model (oemer UNet)" },
];

export function ImageImportDialog({
  fileName,
  defaultChoice,
  onConfirm,
  onCancel,
}: ImageImportDialogProps) {
  const [backend, setBackend] = useState<BackendChoice>(defaultChoice.backend);
  const [staffDetection, setStaffDetection] = useState<StaffDetectionMode>(
    defaultChoice.staffDetection,
  );
  const [embedReviewData, setEmbedReviewData] = useState(
    defaultChoice.embedReviewData,
  );
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

  const hintStyle = {
    display: "block",
    fontSize: 12,
    color: COLORS.textFaint,
    marginTop: 4,
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss; Esc closes via the dialog cancel event
    <dialog
      ref={dialogRef}
      aria-label="Import image"
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
            Import from image
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
          }}
        >
          {/* Inference backend */}
          <label>
            <span style={labelStyle}>Inference backend</span>
            <select
              value={backend}
              onChange={(event) =>
                setBackend(
                  (event.currentTarget as HTMLSelectElement)
                    .value as BackendChoice,
                )
              }
              style={selectStyle}
            >
              {BACKEND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span style={hintStyle}>
              WebGPU is faster; WASM runs on the CPU and works everywhere. Auto
              picks WebGPU when the browser supports it.
            </span>
          </label>

          {/* Staff detection mode */}
          <label>
            <span style={labelStyle}>Staff detection</span>
            <select
              value={staffDetection}
              onChange={(event) =>
                setStaffDetection(
                  (event.currentTarget as HTMLSelectElement)
                    .value as StaffDetectionMode,
                )
              }
              style={selectStyle}
            >
              {STAFF_DETECTION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span style={hintStyle}>
              Classical is fast and works well for clean scans and
              computer-typeset scores; it falls back automatically when it can't
              find staves. Choose Model for photos or skewed pages, where the
              classical line-finder is less reliable.
            </span>
          </label>

          {/* Embed review data */}
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={embedReviewData}
              onChange={(event) =>
                setEmbedReviewData(
                  (event.currentTarget as HTMLInputElement).checked,
                )
              }
              style={{ marginTop: 2 }}
            />
            <span>
              <span
                style={{
                  display: "block",
                  fontSize: 13,
                  fontFamily: FONTS.ui,
                  color: COLORS.textPrimary,
                }}
              >
                Embed review data in the file
              </span>
              <span style={hintStyle}>
                Saves the source page crops and measure alignment used by the
                review panel into the exported MusicXML, so reopening the file
                later restores review mode. Increases file size.
              </span>
            </span>
          </label>
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
            onClick={() =>
              onConfirm({ backend, staffDetection, embedReviewData })
            }
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
            Import
          </button>
        </div>
      </div>
    </dialog>
  );
}
