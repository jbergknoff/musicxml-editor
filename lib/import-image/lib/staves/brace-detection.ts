/**
 * Detects which adjacent staves are joined at the left margin by a brace (or the
 * system's connecting barline) — the image signal that two staves belong to one
 * instrument, e.g. the treble + bass of a piano grand staff.
 *
 * The reliable, position-independent cue is *ink in the left margin that bridges
 * the vertical gap between two staves*. A grand staff draws a curly brace (and a
 * connecting barline) spanning from the top staff down across the gap into the
 * bottom staff; two unrelated stacked staves (e.g. consecutive systems) leave
 * that margin blank in the gap. So for each adjacent pair we scan a narrow column
 * band just left of the stafflines, over the rows between the upper staff's
 * bottom line and the lower staff's top line, and report the pair as braced when
 * most of those gap rows carry ink there. Taking the union across the band's
 * columns per row makes a curved brace count as well as a straight barline; the
 * band stops at the stafflines' left edge, so notes and clefs (inside the staff)
 * never intrude.
 *
 * Runtime-agnostic: operates on a plain RGBA raster and the detected staff
 * geometry, both in the same coordinate space (the segmentation image).
 */
import type { RgbaImage, Staff } from "../types";

export interface BraceDetectionOptions {
  /** Width of the left-margin scan band, in unit sizes. */
  searchUnits?: number;
  /** Luma (0–255) at or below which a pixel counts as ink. */
  inkThreshold?: number;
  /**
   * Fraction of the inter-staff gap rows that must carry margin ink for the pair
   * to count as braced.
   */
  coverageThreshold?: number;
}

const DEFAULT_SEARCH_UNITS = 3;
const DEFAULT_INK_THRESHOLD = 128;
const DEFAULT_COVERAGE_THRESHOLD = 0.6;

/** Rec. 601 luma of the RGBA pixel at byte offset `index`. */
function lumaAt(data: Uint8ClampedArray, index: number): number {
  return (
    0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]
  );
}

/**
 * Whether a brace/connecting barline bridges the gap between `upper` (directly
 * above) and `lower`.
 */
function isBraced(
  image: RgbaImage,
  upper: Staff,
  lower: Staff,
  searchUnits: number,
  inkThreshold: number,
  coverageThreshold: number,
): boolean {
  const { data, width, height } = image;
  const unit = (upper.unitSize + lower.unitSize) / 2;
  if (!(unit > 0)) {
    return false;
  }

  // Column band just left of the leftmost stafflines, inclusive of the left edge
  // where a connecting barline sits.
  const leftEdge = Math.min(upper.left, lower.left);
  const bandLeft = Math.max(0, Math.round(leftEdge - searchUnits * unit));
  const bandRight = Math.min(width - 1, Math.round(leftEdge));
  if (bandRight < bandLeft) {
    return false;
  }

  // Rows spanning the gap between the two staves (upper's bottom line to lower's
  // top line). Misordered or overlapping staves have no gap to bridge.
  const gapTop = Math.max(0, Math.round(upper.lines[upper.lines.length - 1]));
  const gapBottom = Math.min(height - 1, Math.round(lower.lines[0]));
  if (gapBottom <= gapTop) {
    return false;
  }

  let coveredRows = 0;
  const totalRows = gapBottom - gapTop + 1;
  for (let y = gapTop; y <= gapBottom; y++) {
    const rowStart = y * width;
    for (let x = bandLeft; x <= bandRight; x++) {
      if (lumaAt(data, (rowStart + x) * 4) <= inkThreshold) {
        coveredRows++;
        break;
      }
    }
  }
  return coveredRows / totalRows >= coverageThreshold;
}

/**
 * For each adjacent pair of staves (top to bottom), whether a brace/connecting
 * barline bridges them at the left margin. The result has length
 * `max(0, staves.length - 1)`: entry `i` is the link between staff `i` and staff
 * `i + 1`. Consumed by {@link groupSystems} as its primary grouping signal.
 */
export function detectBraces(
  image: RgbaImage,
  staves: Staff[],
  options: BraceDetectionOptions = {},
): boolean[] {
  const {
    searchUnits = DEFAULT_SEARCH_UNITS,
    inkThreshold = DEFAULT_INK_THRESHOLD,
    coverageThreshold = DEFAULT_COVERAGE_THRESHOLD,
  } = options;

  const links: boolean[] = [];
  for (let index = 0; index + 1 < staves.length; index++) {
    links.push(
      isBraced(
        image,
        staves[index],
        staves[index + 1],
        searchUnits,
        inkThreshold,
        coverageThreshold,
      ),
    );
  }
  return links;
}
