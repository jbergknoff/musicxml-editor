/**
 * Single source of truth for the segmentation model weights: where they come
 * from, the versioned file name they are served under, and the URL/blob-key
 * mapping. This module is plain data (no DOM, ORT, or Netlify imports) so it can
 * be shared by the browser registry (`src/models`), the out-of-band upload
 * script (`scripts/upload-models.ts`), and the Netlify serving function
 * (`netlify/functions`).
 *
 * The weights are served from Netlify Blobs (not bundled into the static
 * deploy): they are uploaded once with the Netlify CLI and a function streams
 * them back at `/models/<file>`. The file names are **versioned**
 * (`MODEL_VERSION`) so each URL is immutable — clients can cache it forever, and
 * bumping the version is how new weights are rolled out.
 */

/**
 * Bump when the underlying weights change to invalidate caches. The served
 * weights are the oemer originals run through `scripts/optimize-models.py`
 * (onnxsim with a fixed input shape — see `docs/model-optimization-plan.md`), so
 * a bump also rolls out a re-optimization. Re-run `make optimize-models` and
 * `make upload-models` after bumping.
 */
export const MODEL_VERSION = "v2";

/**
 * Name of the Netlify Blobs store the weights live in. They are uploaded once,
 * out of band, with the Netlify CLI (`scripts/upload-models.ts`) rather than at
 * deploy time — the ~109 MB upload is too slow for the build. The serving
 * function reads this same site-wide store.
 */
export const MODEL_STORE_NAME = "models";

/** Same-origin path prefix the weights are requested under. */
export const MODEL_URL_PREFIX = "/models/";

export type ModelId = "staffSymbol" | "symbolDetail" | "tromr";

export interface ModelManifestEntry {
  /** Stable identifier used in code. */
  id: ModelId;
  /** Where the build downloads the original weights from. */
  sourceUrl: string;
  /**
   * Versioned file name. Doubles as the Netlify Blobs key, the local cache file
   * name, and the last segment of the served URL, so the three stay in lockstep.
   */
  fileName: string;
  /**
   * The fixed input shape the served (optimized) weights are baked to.
   *
   * For the oemer segmentation models this is channel-last `[N, H, W, C]`
   * (uint8 NHWC). For TrOMR it is channel-first `[N, C, H, W]` (float32 NCHW)
   * with `C = 1` (grayscale) and `H` fixed while `W` is the actual serving-time
   * width — stored here as 0 to indicate "variable".
   */
  inputShape: readonly [number, number, number, number];
}

const OEMER_RELEASE_BASE =
  "https://github.com/BreezeWhite/oemer/releases/download/checkpoints";

/**
 * The TrOMR ONNX model is the Polyphonic-TrOMR encoder-decoder (NetEase,
 * Apache-2.0) pre-exported to ONNX by the homr project. The ONNX binary is
 * data (not AGPL code) and carries the original Apache-2.0 provenance.
 */
const TROMR_SOURCE_URL =
  "https://github.com/liebharc/homr/releases/download/models/tromr_model.onnx";

export const MODEL_MANIFEST: Record<ModelId, ModelManifestEntry> = {
  staffSymbol: {
    id: "staffSymbol",
    sourceUrl: `${OEMER_RELEASE_BASE}/1st_model.onnx`,
    // <source>-<arch>-<role>.<version>.onnx
    fileName: `oemer-unet_big-staffline-symbol-seg.${MODEL_VERSION}.onnx`,
    inputShape: [1, 256, 256, 3],
  },
  symbolDetail: {
    id: "symbolDetail",
    sourceUrl: `${OEMER_RELEASE_BASE}/2nd_model.onnx`,
    fileName: `oemer-seg_net-symbol-class-seg.${MODEL_VERSION}.onnx`,
    inputShape: [1, 288, 288, 3],
  },
  tromr: {
    id: "tromr",
    sourceUrl: TROMR_SOURCE_URL,
    fileName: `tromr-polyphonic.${MODEL_VERSION}.onnx`,
    // [N, C, H, W] — batch 1, 1 grayscale channel, height 128, width variable (0 = variable).
    inputShape: [1, 1, 128, 0],
  },
};

export const MODEL_ENTRIES: ModelManifestEntry[] =
  Object.values(MODEL_MANIFEST);

/**
 * TrOMR-specific inference spec: the tensor names and input height the
 * transcription code uses. These are the names baked into the ONNX graph
 * produced by the NetEase → homr export pipeline.
 */
export const TROMR_SPEC = {
  inputName: "input",
  outputNames: {
    rhythm: "rhythm",
    pitch: "pitch",
    lift: "lift",
  },
  inputHeight: MODEL_MANIFEST.tromr.inputShape[2],
} as const;

/** The same-origin URL a model is fetched from in the browser. */
export function modelUrl(entry: ModelManifestEntry): string {
  return `${MODEL_URL_PREFIX}${entry.fileName}`;
}

/**
 * The Netlify Blobs key for a served URL path, or `null` if the path is not a
 * model request. Used by the serving function to translate `/models/<file>`
 * into the deploy-store key (which is just `<file>`).
 */
export function blobKeyFromPath(pathname: string): string | null {
  if (!pathname.startsWith(MODEL_URL_PREFIX)) {
    return null;
  }
  const key = pathname.slice(MODEL_URL_PREFIX.length);
  // Reject empty keys and any path traversal — keys are flat file names.
  if (key.length === 0 || key.includes("/") || key.includes("..")) {
    return null;
  }
  return key;
}
