import type {
  RgbaImage,
  SegmentationMasks,
  StaffStructure,
} from "../../lib/types";

/**
 * Message protocol between the main thread and the OMR worker
 * (`src/worker/omr.worker.ts`).
 *
 * The worker owns the inference backend, the model weights, and the heavy
 * segmentation + staff-detection pass, so none of that blocks the UI thread.
 * The main thread decodes the file (pdf.js / `createImageBitmap` are
 * DOM-bound), hands the raster over, and renders progress and results.
 */

/** Coarse pipeline phase, so the UI thread composes its own status text. */
export type ProgressPhase =
  | "loading-models"
  | "segmenting"
  | "detecting-staves";

export interface ProgressUpdate {
  phase: ProgressPhase;
  /** Fraction complete within the phase, in [0, 1]. */
  fraction: number;
  /** Extra context for the phase (e.g. the model file being loaded). */
  detail?: string;
}

/** Posted once, after the worker resolves its inference backend. */
export interface ReadyMessage {
  type: "ready";
  provider: string;
}

export interface ProgressMessage extends ProgressUpdate {
  type: "progress";
  requestId: number;
}

export interface ResultMessage {
  type: "result";
  requestId: number;
  masks: SegmentationMasks;
  staves: StaffStructure;
}

export interface ErrorMessage {
  type: "error";
  requestId: number;
  message: string;
}

/** Everything the worker sends back to the main thread. */
export type WorkerOutbound =
  | ReadyMessage
  | ProgressMessage
  | ResultMessage
  | ErrorMessage;

/** Request to run the pipeline on one decoded page. */
export interface ProcessRequest {
  type: "process";
  requestId: number;
  image: RgbaImage;
}

/** Which inference provider to use; "auto" picks WebGPU when an adapter works. */
export type BackendChoice = "auto" | "webgpu" | "wasm";

/** UI-controlled inference options, sent to the worker before it starts up. */
export interface OmrConfig {
  backend: BackendChoice;
  /**
   * Turn on ORT's verbose logging (which exposes the node->execution-provider
   * assignment dump) plus WebGPU per-kernel profiling to the console. Noisy, so
   * it's opt-in — it's for chasing the segmentation bottleneck.
   */
  profiling: boolean;
}

/**
 * Sent once, right after the worker starts, to configure the backend. The
 * worker defers resolving its inference provider until this arrives, so the UI
 * can pick the backend; changing it later recreates the worker.
 */
export interface ConfigRequest extends OmrConfig {
  type: "config";
}

/** Everything the main thread sends to the worker. */
export type WorkerInbound = ProcessRequest | ConfigRequest;
