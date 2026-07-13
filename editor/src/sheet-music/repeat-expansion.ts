// Expands a part's measures into playback order by looping backward repeat
// barlines. Used only by Listen-mode playback — the renderer always draws
// measures once, in document order.

import { measureBeatSpan, startBeatsOfMeasures } from "./measure-beats";
import type { ParsedMeasure } from "./sheet-music-types";

/**
 * Walk `measures` in document order, jumping back to the matching forward
 * repeat (or the start of the piece, if a backward repeat has none) each time
 * a `repeatEnd` is reached, until it has been played `repeatEnd.times` times
 * (default 2). Returns the sequence of measure indices in playback order —
 * e.g. `[0, 1, 2, 1, 2, 3]` for a 2-measure repeated section (measures 1-2,
 * 0-indexed) followed by one more measure.
 */
export function expandPlaybackOrder(measures: ParsedMeasure[]): number[] {
  const order: number[] = [];
  let repeatStartIndex = 0;
  const timesPlayed = new Map<number, number>();
  let i = 0;
  while (i < measures.length) {
    order.push(i);
    const measure = measures[i];
    if (measure.repeatStart) {
      repeatStartIndex = i;
    }
    if (measure.repeatEnd) {
      const played = (timesPlayed.get(i) ?? 0) + 1;
      timesPlayed.set(i, played);
      if (played < measure.repeatEnd.times) {
        i = repeatStartIndex;
        continue;
      }
    }
    i++;
  }
  return order;
}

export interface PlaybackStartBeats {
  /** Cumulative playback-timeline beat at each position in `order`. */
  playbackStart: number[];
  /** Document-order (on-screen) start beat of the measure at each position. */
  displayStart: number[];
}

/**
 * For each position in an `expandPlaybackOrder` result, compute both its
 * cumulative playback-timeline beat (strictly increasing — drives scheduling)
 * and its document-order start beat (repeats each visit the same on-screen
 * beat — drives the playback cursor).
 */
export function computePlaybackStartBeats(
  measures: ParsedMeasure[],
  order: number[],
): PlaybackStartBeats {
  const displayStartByMeasure = startBeatsOfMeasures(measures);
  const playbackStart: number[] = [];
  const displayStart: number[] = [];
  let cursor = 0;
  for (const measureIndex of order) {
    playbackStart.push(cursor);
    displayStart.push(displayStartByMeasure[measureIndex] ?? 0);
    cursor += measureBeatSpan(measures[measureIndex]);
  }
  return { playbackStart, displayStart };
}
