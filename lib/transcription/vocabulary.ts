/**
 * TrOMR token vocabulary for the three parallel output heads: rhythm, pitch,
 * and lift (accidental). The ordering matches the vocabulary the Polyphonic-
 * TrOMR model (NetEase, Apache-2.0) was trained with, as used by the homr
 * project (AGPL-3.0, referenced but not copied). Special tokens occupy indices
 * 0–2 in each vocabulary: <pad>, <bos>, <eos>. The rhythm vocabulary adds "|"
 * (barline) at index 3.
 *
 * These lists are pure data — not AGPL code — transcribed from the vocabulary
 * spec and the TrOMR paper.
 */

export const RHYTHM_VOCAB: readonly string[] = [
  "<pad>",
  "<bos>",
  "<eos>",
  "|",
  "whole",
  "half",
  "quarter",
  "eighth",
  "sixteenth",
  "thirty_second",
  "dotted_whole",
  "dotted_half",
  "dotted_quarter",
  "dotted_eighth",
  "dotted_sixteenth",
  "dotted_thirty_second",
];

export const PITCH_VOCAB: readonly string[] = [
  "<pad>",
  "<bos>",
  "<eos>",
  "rest",
  // Octaves 2–6, notes C through B within each octave (diatonic, no accidentals
  // in the pitch token — accidentals are carried by the lift head).
  ...["C", "D", "E", "F", "G", "A", "B"].flatMap((note) =>
    [2, 3, 4, 5, 6].map((octave) => `${note}${octave}`),
  ),
];

export const LIFT_VOCAB: readonly string[] = [
  "<pad>",
  "<bos>",
  "<eos>",
  "natural",
  "sharp",
  "flat",
  "double_sharp",
  "double_flat",
];

/** Special token indices (shared across all three vocabularies). */
export const PAD = 0;
export const BOS = 1;
export const EOS = 2;
/** Barline token index in the rhythm vocabulary. */
export const BARLINE = 3;
