// Import-review ("cleanup") panel: after an OMR import, shows the source page
// image cropped to the system that produced the selected measure, so the user
// can proofread the recovery against the original side by side and fix mistakes
// with the normal editing tools. TrOMR carries no positional output, so the
// finest source region we can show is the system (staff / brace-linked staves);
// the header names the measure range that system produced.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  flaggedNotesInSystem,
  type ImportReview,
  systemForMeasure,
} from "../import-review";
import { COLORS, FONTS, RADIUS } from "../theme";

// The source strip never grows past this, so the notation stays dominant.
const MAX_CROP_HEIGHT = 240;

const stepButtonStyle = (enabled: boolean) =>
  ({
    padding: "3px 10px",
    borderRadius: RADIUS.button,
    border: `1px solid ${COLORS.borderButton}`,
    background: COLORS.canvas,
    color: enabled ? COLORS.textPrimary : COLORS.textPlaceholder,
    cursor: enabled ? "pointer" : "default",
    fontSize: 12,
    fontFamily: FONTS.ui,
  }) as const;

export function ImportReviewPanel({
  review,
  selectedMeasure,
  onSelectMeasure,
  onClose,
}: {
  review: ImportReview;
  /** 0-based measure index of the editor's selection, if any. */
  selectedMeasure: number | null;
  /** Step the editor's selection to the given 0-based measure. */
  onSelectMeasure: (measureIndex: number) => void;
  onClose: () => void;
}) {
  // Object URLs for the page snapshots, revoked when the review data changes.
  const pageUrls = useMemo(
    () => review.pages.map((page) => URL.createObjectURL(page.image)),
    [review],
  );
  useEffect(() => {
    return () => {
      for (const url of pageUrls) {
        URL.revokeObjectURL(url);
      }
    };
  }, [pageUrls]);

  // The system on display: the one containing the selected measure, else the
  // last one stepped to (so Prev/Next work before anything is selected — and
  // keep working if a step lands on a measure the editor could not select).
  const [steppedIndex, setSteppedIndex] = useState(0);
  const selectedIndex =
    selectedMeasure !== null
      ? systemForMeasure(review.systems, selectedMeasure)
      : null;
  const activeIndex = selectedIndex ?? steppedIndex;
  const activeSystem = review.systems[activeIndex];

  const stepTo = (index: number) => {
    const system = review.systems[index];
    if (!system) {
      return;
    }
    setSteppedIndex(index);
    onSelectMeasure(system.firstMeasure);
  };

  // Decode the active system's page image (from its object URL) off-DOM.
  const [pageImage, setPageImage] = useState<HTMLImageElement | null>(null);
  const activePage = activeSystem?.page ?? null;
  useEffect(() => {
    if (activePage === null) {
      return;
    }
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (!cancelled) {
        setPageImage(image);
      }
    };
    image.src = pageUrls[activePage];
    return () => {
      cancelled = true;
    };
  }, [pageUrls, activePage]);

  // Track the strip's width so the crop rescales with the window/inspector.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyWidth, setBodyWidth] = useState(0);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) {
      return;
    }
    const observer = new ResizeObserver(() => {
      setBodyWidth(body.clientWidth);
    });
    observer.observe(body);
    setBodyWidth(body.clientWidth);
    return () => observer.disconnect();
  }, []);

  // Draw the active system's crop, fit to the strip (sharp on hi-DPI screens).
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pageImage || !activeSystem || bodyWidth <= 0) {
      return;
    }
    // The loaded image may still be the previous page's for a frame after a
    // page switch; skip drawing until the right one arrives.
    if (pageImage.src !== pageUrls[activeSystem.page]) {
      return;
    }
    const { top, bottom, left, right } = activeSystem.region;
    const cropWidth = Math.max(1, right - left);
    const cropHeight = Math.max(1, bottom - top);
    let scale = bodyWidth / cropWidth;
    if (cropHeight * scale > MAX_CROP_HEIGHT) {
      scale = MAX_CROP_HEIGHT / cropHeight;
    }
    const devicePixels = window.devicePixelRatio || 1;
    const displayWidth = Math.round(cropWidth * scale);
    const displayHeight = Math.round(cropHeight * scale);
    canvas.width = Math.round(displayWidth * devicePixels);
    canvas.height = Math.round(displayHeight * devicePixels);
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      pageImage,
      left,
      top,
      cropWidth,
      cropHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  }, [pageImage, pageUrls, activeSystem, bodyWidth]);

  if (!activeSystem) {
    return null;
  }

  const lastMeasure = activeSystem.firstMeasure + activeSystem.measureCount;
  const pageLabel =
    review.pages.length > 1
      ? ` · page ${activeSystem.page + 1}/${review.pages.length}`
      : "";
  // Notes the decoder was unsure about on this line — they draw amber in the
  // notation above so the user knows what to check against this crop.
  const flaggedCount = flaggedNotesInSystem(
    review.flaggedNotes,
    activeSystem,
  ).length;

  return (
    <div
      style={{
        borderTop: `1px solid ${COLORS.borderLight}`,
        background: COLORS.panel,
        padding: "6px 14px 10px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          minHeight: 28,
          fontFamily: FONTS.mono,
          fontSize: 12,
          color: COLORS.textSecondary,
        }}
      >
        <span style={{ color: COLORS.textPrimary, fontFamily: FONTS.ui }}>
          Source
        </span>
        <span>
          line {activeIndex + 1}/{review.systems.length} · measures{" "}
          {activeSystem.firstMeasure + 1}–{lastMeasure}
          {pageLabel}
        </span>
        {flaggedCount > 0 ? (
          <span
            title="Notes the recognizer was least sure about are marked amber in the score"
            style={{ color: COLORS.warning }}
          >
            ⚠ {flaggedCount} amber note{flaggedCount === 1 ? "" : "s"} on this
            line — low confidence, check against source
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => stepTo(activeIndex - 1)}
          disabled={activeIndex === 0}
          style={stepButtonStyle(activeIndex > 0)}
        >
          ← Prev line
        </button>
        <button
          type="button"
          onClick={() => stepTo(activeIndex + 1)}
          disabled={activeIndex >= review.systems.length - 1}
          style={stepButtonStyle(activeIndex < review.systems.length - 1)}
        >
          Next line →
        </button>
        <button
          type="button"
          aria-label="Close review"
          onClick={onClose}
          style={{
            border: "none",
            background: "transparent",
            cursor: "pointer",
            fontSize: 14,
            color: COLORS.textMuted,
            padding: "2px 4px",
          }}
        >
          ✕
        </button>
      </div>
      <div ref={bodyRef} style={{ overflow: "hidden" }}>
        <canvas
          ref={canvasRef}
          style={{
            display: "block",
            border: `1px solid ${COLORS.borderLight}`,
            borderRadius: RADIUS.overlay,
            boxSizing: "border-box",
          }}
        />
      </div>
    </div>
  );
}
