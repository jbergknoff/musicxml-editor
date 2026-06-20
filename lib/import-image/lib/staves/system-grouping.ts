/**
 * Groups a page's per-staff transcriptions (ordered top to bottom) into systems
 * — the bands of staves that sound together.
 *
 * The target is the piano **grand staff**: a treble staff stacked directly over
 * a bass staff, braced as one instrument. The primary signal is the brace itself,
 * detected from the image by {@link detectBraces} and passed in as a per-adjacent-
 * pair link array: a maximal run of brace-linked staves becomes one system (two
 * for a grand staff, more for an organ-style group). Brace detection is the most
 * direct evidence that two staves form one instrument.
 *
 * Where no brace was detected (it was missed, or the input had none), we fall
 * back to the opening clefs the pipeline already recovers per staff: a treble
 * staff immediately over a bass staff is paired into one two-staff system. This
 * keeps the grand-staff case working when the margin scan comes up empty, and
 * degrades to consecutive single-staff systems rather than mis-pairing.
 *
 * Systems come out in reading order (top to bottom = earlier to later in time),
 * so concatenating them across the page (and across pages) gives the part's full
 * measure sequence.
 */
import type { ScoreSystem, Transcription } from "../types";

function isTreble(transcription: Transcription): boolean {
  return transcription.attributes.clef?.sign === "G";
}

function isBass(transcription: Transcription): boolean {
  return transcription.attributes.clef?.sign === "F";
}

/**
 * @param braces Per-adjacent-pair brace links from {@link detectBraces} (entry
 *   `i` links staff `i` and `i + 1`); omit when no image-based detection ran, in
 *   which case grouping relies entirely on the clef fallback.
 */
export function groupSystems(
  transcriptions: Transcription[],
  braces: boolean[] = [],
): ScoreSystem[] {
  const systems: ScoreSystem[] = [];
  let index = 0;
  while (index < transcriptions.length) {
    // A detected brace is the strongest grouping signal: extend the system over
    // every consecutive brace-linked staff (a grand staff is two; an organ-style
    // group could be three or more).
    if (braces[index] === true) {
      let end = index;
      while (braces[end] === true) {
        end++;
      }
      systems.push({ staves: transcriptions.slice(index, end + 1) });
      index = end + 1;
      continue;
    }
    // No brace here: fall back to pairing a treble directly over a bass by the
    // recovered clefs (the prior, image-free heuristic).
    const upper = transcriptions[index];
    const lower = transcriptions[index + 1];
    if (lower !== undefined && isTreble(upper) && isBass(lower)) {
      systems.push({ staves: [upper, lower] });
      index += 2;
    } else {
      systems.push({ staves: [upper] });
      index += 1;
    }
  }
  return systems;
}
