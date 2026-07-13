/**
 * Voice inference for OMR output.
 *
 * TrOMR transcribes each staff as one linear note stream with no concept of
 * voices, so a staff written in two rhythmically independent voices — the
 * classic "sustained chord over a moving inner line" — comes back flattened into
 * one `<chord/>` group whose members carry **different durations**: a held
 * whole-note pair stacked with the quarter note that actually starts a moving
 * line. A real chord's members always share one duration, so an unequal-duration
 * chord is the unmistakable signature of two collapsed voices.
 *
 * `inferVoices` finds that signal per staff-measure and splits the measure into
 * two voices: the longest member of an unequal chord (the held note) becomes
 * voice 2, and everything else — the shorter chord member plus the rest of the
 * measure's notes — becomes voice 1, the moving line. Because the builder emits
 * each voice as its own `<backup>`-separated run, the moving line is *re-timed*
 * from the chord's onset by its own note values (undoing TrOMR's habit of
 * advancing the whole measure by the held note's long duration and overflowing
 * the bar). It is deliberately conservative — a normal equal-duration chord
 * never triggers it — so monophonic and plain-chord staves pass through
 * untouched (every `voice` left undefined). Users can refine the split with the
 * editor's voice controls.
 */

import { noteDivisions } from "./durations";
import type { NoteEvent } from "../types";

/**
 * The 0-based rhythmic column each note belongs to: a lead note starts a new
 * column, its `<chord/>`-tail members share it. Shared by the inference (to find
 * unequal-duration chords) and the builder (to re-flag chords within each split
 * voice), so both agree on what a "chord" is.
 */
export function columnIndices(notes: NoteEvent[]): number[] {
  const indices: number[] = [];
  let column = -1;
  for (const note of notes) {
    if (note.chord && column >= 0) {
      indices.push(column);
    } else {
      column += 1;
      indices.push(column);
    }
  }
  return indices;
}

// Assign MusicXML voice numbers within one measure's note stream, mutating each
// note's `voice`. Fires only when a chord has members of unequal duration: the
// longest such member becomes voice 2 (the held note) and the rest of the
// measure becomes voice 1 (the moving line). Returns true when a split was made.
function inferMeasureVoices(notes: NoteEvent[]): boolean {
  const columns = columnIndices(notes);
  const columnCount = columns.length > 0 ? columns[columns.length - 1] + 1 : 0;
  // The pitched, non-grace members of each column, by note index.
  const membersByColumn: number[][] = Array.from(
    { length: columnCount },
    () => [],
  );
  for (let index = 0; index < notes.length; index++) {
    const note = notes[index];
    if (!note.grace && note.pitch !== "rest") {
      membersByColumn[columns[index]].push(index);
    }
  }
  // Held notes: in any column whose members have unequal durations, every
  // longest-duration member is the sustained (held) chord → voice 2; the shorter
  // members drop to the moving voice. A uniform chord (no unequal pair) is left
  // alone, so a genuine equal-duration chord is never split.
  const held = new Set<number>();
  for (const members of membersByColumn) {
    if (members.length < 2) {
      continue;
    }
    const durations = members.map((index) => noteDivisions(notes[index]));
    const maxDuration = Math.max(...durations);
    const minDuration = Math.min(...durations);
    if (maxDuration === minDuration) {
      continue;
    }
    members.forEach((index, position) => {
      if (durations[position] === maxDuration) {
        held.add(index);
      }
    });
  }
  if (held.size === 0) {
    return false;
  }
  for (let index = 0; index < notes.length; index++) {
    notes[index].voice = held.has(index) ? 2 : 1;
  }
  return true;
}

/**
 * Assign `voice` to every note in a staff's stream, per measure. Mutates the
 * notes in place (and returns them) so the builder can group by voice. A
 * measure with no sustained-over-moving signal is left entirely single-voice
 * (every `voice` undefined), so plain monophonic/chordal staves are unchanged.
 */
export function inferVoices(notes: NoteEvent[]): NoteEvent[] {
  if (notes.length === 0) {
    return notes;
  }
  const byMeasure = new Map<number, NoteEvent[]>();
  for (const note of notes) {
    const group = byMeasure.get(note.measureIndex);
    if (group) {
      group.push(note);
    } else {
      byMeasure.set(note.measureIndex, [note]);
    }
  }
  for (const measureNotes of byMeasure.values()) {
    inferMeasureVoices(measureNotes);
  }
  return notes;
}
