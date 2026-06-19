/**
 * Orchestrates Phase 3 transcription: for each detected staff, crop the strip,
 * run TrOMR, decode the tokens, and collect all note events.
 */
import type { InferenceSession } from "../runtime/inference-backend";
import type { RgbaImage, Staff, Transcription } from "../types";
import { decodeTokens } from "./decode-tokens";
import type { TrOMRModelSpec } from "./tromr-session";
import { runTrOMR } from "./tromr-session";

export interface TranscribeOptions {
  /** Called after each staff is processed, for progress reporting. */
  onProgress?: (staffIndex: number, total: number) => void;
}

/**
 * Transcribe every detected staff in `staves` using one TrOMR inference
 * session. Returns one `Transcription` per staff, in the same order as
 * `staves`. Only the first staff is transcribed in Phase 3 (Mono POC); the
 * loop is written for all staves so Phase 4 just removes the early-exit.
 */
export async function transcribeStaves(
  session: InferenceSession,
  spec: TrOMRModelSpec,
  image: RgbaImage,
  staves: Staff[],
  options: TranscribeOptions = {},
): Promise<Transcription[]> {
  const results: Transcription[] = [];
  for (let index = 0; index < staves.length; index++) {
    const tokens = await runTrOMR(session, spec, image, staves[index]);
    const notes = decodeTokens(tokens.rhythm, tokens.pitch, tokens.lift);
    const measureCount =
      notes.length === 0 ? 0 : notes[notes.length - 1].measureIndex + 1;
    results.push({ notes, measureCount });
    options.onProgress?.(index + 1, staves.length);
  }
  return results;
}
