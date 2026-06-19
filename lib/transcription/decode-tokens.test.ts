import { describe, expect, it } from "bun:test";
import { decodeTokens } from "./decode-tokens";
import {
  BOS,
  EOS,
  PAD,
  PITCH_VOCAB,
  RHYTHM_VOCAB,
  LIFT_VOCAB,
  BARLINE,
} from "./vocabulary";

/** Find the token index for a string in a vocab array. */
function indexOf(vocab: readonly string[], token: string): number {
  const index = vocab.indexOf(token);
  if (index === -1) {
    throw new Error(`Token not found: ${token}`);
  }
  return index;
}

describe("decodeTokens", () => {
  it("returns empty array for sequences with only EOS", () => {
    const result = decodeTokens([EOS], [EOS], [EOS]);
    expect(result).toEqual([]);
  });

  it("decodes a single quarter note C4 with no accidental", () => {
    const rhythmId = indexOf(RHYTHM_VOCAB, "quarter");
    const pitchId = indexOf(PITCH_VOCAB, "C4");
    const liftId = indexOf(LIFT_VOCAB, "natural");

    const result = decodeTokens([rhythmId, EOS], [pitchId, EOS], [liftId, EOS]);
    expect(result).toHaveLength(1);
    expect(result[0].pitch).toBe("C4");
    expect(result[0].duration).toBe("quarter");
    expect(result[0].dotted).toBe(false);
    expect(result[0].accidental).toBe("natural");
    expect(result[0].measureIndex).toBe(0);
  });

  it("decodes a dotted half note", () => {
    const rhythmId = indexOf(RHYTHM_VOCAB, "dotted_half");
    const pitchId = indexOf(PITCH_VOCAB, "G4");
    const liftId = indexOf(LIFT_VOCAB, "natural");

    const result = decodeTokens([rhythmId, EOS], [pitchId, EOS], [liftId, EOS]);
    expect(result[0].duration).toBe("half");
    expect(result[0].dotted).toBe(true);
  });

  it("increments measureIndex at barline tokens", () => {
    const quarter = indexOf(RHYTHM_VOCAB, "quarter");
    const pitchC4 = indexOf(PITCH_VOCAB, "C4");
    const pitchD4 = indexOf(PITCH_VOCAB, "D4");
    const natural = indexOf(LIFT_VOCAB, "natural");

    const rhythm = [quarter, BARLINE, quarter, EOS];
    const pitch = [pitchC4, pitchD4, EOS];
    const lift = [natural, natural, EOS];

    const result = decodeTokens(rhythm, pitch, lift);
    expect(result).toHaveLength(2);
    expect(result[0].measureIndex).toBe(0);
    expect(result[1].measureIndex).toBe(1);
  });

  it("decodes a rest", () => {
    const rhythmId = indexOf(RHYTHM_VOCAB, "eighth");
    const pitchId = indexOf(PITCH_VOCAB, "rest");
    const liftId = indexOf(LIFT_VOCAB, "natural");

    const result = decodeTokens([rhythmId, EOS], [pitchId, EOS], [liftId, EOS]);
    expect(result[0].pitch).toBe("rest");
    expect(result[0].duration).toBe("eighth");
  });

  it("decodes a sharp accidental", () => {
    const rhythmId = indexOf(RHYTHM_VOCAB, "quarter");
    const pitchId = indexOf(PITCH_VOCAB, "F4");
    const liftId = indexOf(LIFT_VOCAB, "sharp");

    const result = decodeTokens([rhythmId, EOS], [pitchId, EOS], [liftId, EOS]);
    expect(result[0].accidental).toBe("sharp");
  });

  it("skips BOS tokens at the start of each sequence", () => {
    const quarter = indexOf(RHYTHM_VOCAB, "quarter");
    const pitchC4 = indexOf(PITCH_VOCAB, "C4");
    const natural = indexOf(LIFT_VOCAB, "natural");

    const result = decodeTokens(
      [BOS, quarter, EOS],
      [BOS, pitchC4, EOS],
      [BOS, natural, EOS],
    );
    expect(result).toHaveLength(1);
    expect(result[0].pitch).toBe("C4");
  });

  it("stops at EOS in the rhythm sequence", () => {
    const quarter = indexOf(RHYTHM_VOCAB, "quarter");
    const pitchC4 = indexOf(PITCH_VOCAB, "C4");
    const natural = indexOf(LIFT_VOCAB, "natural");

    const result = decodeTokens(
      [quarter, EOS, quarter],
      [pitchC4, pitchC4, pitchC4],
      [natural, natural, natural],
    );
    expect(result).toHaveLength(1);
  });

  it("handles PAD tokens in rhythm by stopping", () => {
    const quarter = indexOf(RHYTHM_VOCAB, "quarter");
    const pitchC4 = indexOf(PITCH_VOCAB, "C4");
    const natural = indexOf(LIFT_VOCAB, "natural");

    const result = decodeTokens(
      [quarter, PAD, quarter],
      [pitchC4, pitchC4],
      [natural, natural],
    );
    expect(result).toHaveLength(1);
  });
});
