import type { ParsedMeasure, ParsedScore } from "./sheet-music-types";

/**
 * The measure's length in quarter-note beats: the longest voice's summed event
 * durations. Voices sharing a staff are each padded (by the parser / writer) to
 * the same length, so any voice would normally do — the max is taken to stay
 * correct even if an intermediate edit leaves one voice transiently longer.
 */
export function measureBeatSpan(measure: ParsedMeasure): number {
  const divisions = measure.divisions || 4;
  let maxDivisions = 0;
  for (const voice of measure.voices) {
    let sum = 0;
    for (const event of voice.events) {
      sum += event.duration;
    }
    maxDivisions = Math.max(maxDivisions, sum);
  }
  return maxDivisions / divisions;
}

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
    beatCursor += measureBeatSpan(measure);
  }
  return startBeats;
}

/** Same as {@link startBeatsOfMeasures}, reading the score's first part. */
export function computeMeasureStartBeats(score: ParsedScore): number[] {
  const part = score.parts[0];
  return part ? startBeatsOfMeasures(part.measures) : [];
}
