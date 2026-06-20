/**
 * Groups a page's per-staff transcriptions (ordered top to bottom) into systems
 * — the bands of staves that sound together.
 *
 * The target is the piano **grand staff**: a treble staff stacked directly over
 * a bass staff, braced as one instrument. Rather than detect the brace in the
 * image (fragile, and the brace is not reliably segmented), we use a signal the
 * pipeline already recovers per staff: the opening clef. A treble staff
 * immediately followed by a bass staff is paired into one two-staff system;
 * everything else stays a single-staff system. This is exactly the grand-staff
 * case and degrades gracefully — if a clef was missed, the staves simply fall
 * back to consecutive single-staff systems instead of being mis-paired.
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

export function groupSystems(
  transcriptions: Transcription[],
): ScoreSystem[] {
  const systems: ScoreSystem[] = [];
  let index = 0;
  while (index < transcriptions.length) {
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
