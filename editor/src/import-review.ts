// Pure lookup logic for the import-review ("cleanup") panel, separated from the
// component so it runs under `bun test` (linkedom has no canvas).

import type {
  ImportReview,
  ImportReviewPage,
  ReviewFlaggedNote,
  ReviewSystem,
} from "../../lib/import-image/index";

export type { ImportReview, ImportReviewPage, ReviewFlaggedNote, ReviewSystem };

/** The flagged (low-confidence) notes falling inside one review system's measures. */
export function flaggedNotesInSystem(
  flaggedNotes: readonly ReviewFlaggedNote[],
  system: ReviewSystem,
): ReviewFlaggedNote[] {
  return flaggedNotes.filter(
    (flagged) =>
      flagged.measureIndex >= system.firstMeasure &&
      flagged.measureIndex < system.firstMeasure + system.measureCount,
  );
}

/**
 * The index of the review system containing `measureIndex` (0-based, matching
 * the parsed score's measure order). Structural edits after import (inserting
 * measures) can push a measure outside every recorded range; rather than losing
 * the panel we clamp to the nearest system, which stays correct for the common
 * cleanup flow of fixing notes in place. Null only when there are no systems.
 */
export function systemForMeasure(
  systems: readonly ReviewSystem[],
  measureIndex: number,
): number | null {
  if (systems.length === 0) {
    return null;
  }
  for (let index = 0; index < systems.length; index++) {
    const system = systems[index];
    if (
      measureIndex >= system.firstMeasure &&
      measureIndex < system.firstMeasure + system.measureCount
    ) {
      return index;
    }
    // Systems are ordered by firstMeasure; the first one starting past the
    // measure means we fell in a gap — clamp to the previous system.
    if (measureIndex < system.firstMeasure) {
      return Math.max(0, index - 1);
    }
  }
  return systems.length - 1;
}
