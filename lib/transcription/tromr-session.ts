/**
 * Drives the TrOMR ONNX model over one cropped staff image, producing the
 * three raw token-ID sequences (rhythm, pitch, lift). Pure inference — no
 * vocabulary decoding here (see decode-tokens.ts).
 */
import type { InferenceSession } from "../runtime/inference-backend";
import type { RgbaImage, Staff } from "../types";
import { cropStaff, prepareStaffTensor } from "./staff-crop";

/** Names of the three output tensors in the TrOMR ONNX graph. */
export interface TrOMROutputNames {
  rhythm: string;
  pitch: string;
  lift: string;
}

export interface TrOMRModelSpec {
  inputName: string;
  outputNames: TrOMROutputNames;
  /** Target height for the staff image (pixels). Default: 128. */
  inputHeight: number;
}

export interface TrOMRTokens {
  rhythm: Int32Array | BigInt64Array;
  pitch: Int32Array | BigInt64Array;
  lift: Int32Array | BigInt64Array;
}

/** Extract flat token array from a tensor (int32 or int64). */
function toNumbers(data: Int32Array | BigInt64Array): number[] {
  if (data instanceof BigInt64Array) {
    return Array.from(data, (v) => Number(v));
  }
  return Array.from(data);
}

/**
 * Run TrOMR on one detected staff: crop, resize, normalize, infer, return
 * the three raw token sequences as plain number arrays.
 */
export async function runTrOMR(
  session: InferenceSession,
  spec: TrOMRModelSpec,
  image: RgbaImage,
  staff: Staff,
): Promise<{ rhythm: number[]; pitch: number[]; lift: number[] }> {
  const cropped = cropStaff(image, staff);
  const { data, width } = prepareStaffTensor(cropped, spec.inputHeight);

  // TrOMR input: [1, 1, H, W] float32 (batch, channel, height, width).
  const feeds: Record<
    string,
    { type: "float32"; data: Float32Array; dims: number[] }
  > = {
    [spec.inputName]: {
      type: "float32",
      data,
      dims: [1, 1, spec.inputHeight, width],
    },
  };

  const outputs = await session.run(feeds);

  const rhythmData = outputs[spec.outputNames.rhythm]?.data;
  const pitchData = outputs[spec.outputNames.pitch]?.data;
  const liftData = outputs[spec.outputNames.lift]?.data;

  if (
    rhythmData === undefined ||
    pitchData === undefined ||
    liftData === undefined
  ) {
    throw new Error(
      `TrOMR output tensors missing. Expected "${spec.outputNames.rhythm}", ` +
        `"${spec.outputNames.pitch}", "${spec.outputNames.lift}". ` +
        `Got: ${Object.keys(outputs).join(", ")}`,
    );
  }

  // The inference-backend Tensor interface types data as Float32Array | Uint8Array
  // for the segmentation models, but TrOMR emits int64 (BigInt64Array in ORT-web)
  // or int32. Cast through unknown to handle the actual runtime type.
  return {
    rhythm: toNumbers(rhythmData as unknown as Int32Array | BigInt64Array),
    pitch: toNumbers(pitchData as unknown as Int32Array | BigInt64Array),
    lift: toNumbers(liftData as unknown as Int32Array | BigInt64Array),
  };
}
