/**
 * Maps recognized systems back onto the source page images, for the editor's
 * import-review ("cleanup") mode: each entry ties a run of measures in the
 * assembled MusicXML to the region of the page image those measures came from,
 * so the user can proofread the recovery side by side with the source.
 *
 * TrOMR has no positional output, so individual measures cannot be located
 * within a staff — the finest region we can attribute is the **system** (the
 * staff, or brace-linked staves, transcribed together). Measure numbering must
 * match the builder exactly: `buildScore` advances by {@link systemMeasureSpan}
 * per system, in reading order, continuously across pages, and so does this map.
 */
import type { ScoreSystem, Staff } from "../types";
import { systemMeasureSpan } from "./musicxml-builder";

/** An axis-aligned pixel region of a page image (full-resolution page space). */
export interface ReviewRegion {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** One recognized system: where it sits on its page and which measures it produced. */
export interface ReviewSystem {
  /** 0-based index into the decoded pages. */
  page: number;
  /** 0-based index of the system's first measure in the assembled document. */
  firstMeasure: number;
  /** How many measures the system contributed (always ≥ 1 in the output). */
  measureCount: number;
  /** The system's staves plus padding, in full-resolution page pixels. */
  region: ReviewRegion;
}

/** Everything one page contributes to the map. */
export interface ReviewPageInput {
  /** The page's systems, as grouped by `groupSystems` (reading order). */
  systems: ScoreSystem[];
  /**
   * The page's detected staves, top to bottom — the same order and count
   * `groupSystems` consumed, so system `i` owns the next
   * `systems[i].staves.length` entries.
   */
  staves: Staff[];
  /** Detected-staff space → full-resolution page space scale factors. */
  scaleX: number;
  scaleY: number;
  /** Full-resolution page dimensions, to clamp padded regions. */
  pageWidth: number;
  pageHeight: number;
}

// Padding around the stafflines, in staff interline units: enough vertical room
// for ledger lines, dynamics, and lyrics; a little horizontal room for the
// clef's left edge and the final barline.
const VERTICAL_PADDING_UNITS = 4;
const HORIZONTAL_PADDING_UNITS = 2;

/** The padded bounding region of a run of staves, clamped to the page. */
function regionOfStaves(
  staves: Staff[],
  scaleX: number,
  scaleY: number,
  pageWidth: number,
  pageHeight: number,
): ReviewRegion {
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const staff of staves) {
    const verticalPadding = staff.unitSize * VERTICAL_PADDING_UNITS;
    const horizontalPadding = staff.unitSize * HORIZONTAL_PADDING_UNITS;
    top = Math.min(top, staff.lines[0] - verticalPadding);
    bottom = Math.max(bottom, staff.lines[4] + verticalPadding);
    left = Math.min(left, staff.left - horizontalPadding);
    right = Math.max(right, staff.right + horizontalPadding);
  }
  return {
    top: Math.max(0, Math.floor(top * scaleY)),
    bottom: Math.min(pageHeight, Math.ceil(bottom * scaleY)),
    left: Math.max(0, Math.floor(left * scaleX)),
    right: Math.min(pageWidth, Math.ceil(right * scaleX)),
  };
}

/**
 * Walk every page's systems in reading order, pairing each with its staves'
 * page region and its measure range in the assembled document. Systems that
 * recognized nothing (zero measures) are omitted — no measure maps to them —
 * but never disturb the numbering, mirroring `buildScore`.
 */
export function mapSystemsToRegions(pages: ReviewPageInput[]): ReviewSystem[] {
  const mapped: ReviewSystem[] = [];
  let measureOffset = 0;
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    let staffCursor = 0;
    for (const system of page.systems) {
      const systemStaves = page.staves.slice(
        staffCursor,
        staffCursor + system.staves.length,
      );
      staffCursor += system.staves.length;
      const span = systemMeasureSpan(system);
      if (span > 0 && systemStaves.length === system.staves.length) {
        mapped.push({
          page: pageIndex,
          firstMeasure: measureOffset,
          measureCount: span,
          region: regionOfStaves(
            systemStaves,
            page.scaleX,
            page.scaleY,
            page.pageWidth,
            page.pageHeight,
          ),
        });
      }
      measureOffset += span;
    }
  }
  return mapped;
}
