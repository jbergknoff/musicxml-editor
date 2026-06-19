/**
 * Converts the three raw token-ID sequences produced by TrOMR (rhythm, pitch,
 * lift) into a structured list of NoteEvents, splitting on barline tokens to
 * track measure positions.
 */
import type { NoteEvent } from "../types";
import {
  BARLINE,
  BOS,
  EOS,
  LIFT_VOCAB,
  PAD,
  PITCH_VOCAB,
  RHYTHM_VOCAB,
} from "./vocabulary";

type AccidentalValue = NoteEvent["accidental"];
type DurationValue = NoteEvent["duration"];

const DURATION_MAP: Record<string, DurationValue | undefined> = {
  whole: "whole",
  half: "half",
  quarter: "quarter",
  eighth: "eighth",
  sixteenth: "sixteenth",
  thirty_second: "thirty_second",
  dotted_whole: "whole",
  dotted_half: "half",
  dotted_quarter: "quarter",
  dotted_eighth: "eighth",
  dotted_sixteenth: "sixteenth",
  dotted_thirty_second: "thirty_second",
};

const ACCIDENTAL_MAP: Record<string, AccidentalValue> = {
  natural: "natural",
  sharp: "sharp",
  flat: "flat",
  double_sharp: "double_sharp",
  double_flat: "double_flat",
};

/**
 * Decode three parallel token-ID arrays from TrOMR into an ordered list of
 * note events. The rhythm, pitch, and lift arrays are expected to be the same
 * length (after stripping BOS/EOS/PAD). Barline tokens in the rhythm sequence
 * increment the measure index for subsequent notes.
 */
export function decodeTokens(
  rhythmIds: ArrayLike<number>,
  pitchIds: ArrayLike<number>,
  liftIds: ArrayLike<number>,
): NoteEvent[] {
  const notes: NoteEvent[] = [];

  // The three sequences may start with BOS and end with EOS; align them by
  // walking until EOS or exhaustion, skipping PAD/BOS.
  let pitchIndex = 0;
  let liftIndex = 0;
  let measureIndex = 0;

  for (let index = 0; index < rhythmIds.length; index++) {
    const rhythmId = rhythmIds[index];
    if (rhythmId === EOS || rhythmId === PAD) {
      break;
    }
    if (rhythmId === BOS) {
      continue;
    }
    if (rhythmId === BARLINE) {
      measureIndex++;
      // Barline tokens have no corresponding pitch/lift entries.
      continue;
    }

    // Advance past BOS/PAD on pitch and lift.
    while (
      pitchIndex < pitchIds.length &&
      (pitchIds[pitchIndex] === BOS || pitchIds[pitchIndex] === PAD)
    ) {
      pitchIndex++;
    }
    while (
      liftIndex < liftIds.length &&
      (liftIds[liftIndex] === BOS || liftIds[liftIndex] === PAD)
    ) {
      liftIndex++;
    }

    const pitchToken =
      pitchIndex < pitchIds.length && pitchIds[pitchIndex] !== EOS
        ? PITCH_VOCAB[pitchIds[pitchIndex++]]
        : undefined;
    const liftToken =
      liftIndex < liftIds.length && liftIds[liftIndex] !== EOS
        ? LIFT_VOCAB[liftIds[liftIndex++]]
        : undefined;
    const rhythmToken = RHYTHM_VOCAB[rhythmId];

    if (rhythmToken === undefined || pitchToken === undefined) {
      continue;
    }

    const duration = DURATION_MAP[rhythmToken];
    if (duration === undefined) {
      continue;
    }

    const pitch = pitchToken === "rest" ? "rest" : pitchToken;
    const accidental =
      liftToken !== undefined ? (ACCIDENTAL_MAP[liftToken] ?? null) : null;
    const dotted = rhythmToken.startsWith("dotted_");

    notes.push({ pitch, accidental, duration, dotted, measureIndex });
  }

  return notes;
}
