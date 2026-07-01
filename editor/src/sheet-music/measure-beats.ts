import type { ParsedMeasure, ParsedScore } from "./sheet-music-types";

/**
 * Compute the quarter-note beat at which each measure starts, walking a
 * part's event durations. Index 0 corresponds to measure 1.
 *
 * This correctly handles pickup (anacrusis) measures and any other situation
 * where measures are not all the same length, unlike the naive formula
 * `(measureNumber - 1) * timeSigNum`.
 */
export function startBeatsOfMeasures(measures: ParsedMeasure[]): number[] {
  const startBeats: number[] = [];
  let beatCursor = 0;
  for (const measure of measures) {
    startBeats.push(beatCursor);
    const divisions = measure.divisions || 4;
    for (const event of measure.events) {
      beatCursor += event.duration / divisions;
    }
  }
  return startBeats;
}

/** Same as {@link startBeatsOfMeasures}, reading the score's first part. */
export function computeMeasureStartBeats(score: ParsedScore): number[] {
  const part = score.parts[0];
  return part ? startBeatsOfMeasures(part.measures) : [];
}
