/**
 * Runtime-agnostic inference interface.
 *
 * `lib/` runs in both Node/Bun (with onnxruntime-node, for unit tests) and the
 * browser (with onnxruntime-web). To keep `lib/` free of any concrete ORT
 * dependency, the runtime is injected through this interface; implementations
 * live in `src/runtime/` (web) and in tests (node).
 */

/**
 * The element types a {@link Tensor} can hold. The oemer segmentation models
 * take `uint8` RGB patches and emit `float32` probabilities, so both are
 * supported; the `type` tag selects the matching backing array.
 */
export type TensorDataType = "float32" | "uint8";

export interface Tensor {
  type: TensorDataType;
  data: Float32Array | Uint8Array;
  dims: number[];
}

export interface InferenceSession {
  run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
}

export interface InferenceBackend {
  /** Execution provider actually selected, e.g. "webgpu" | "wasm" | "cpu". */
  readonly provider: string;
  createSession(modelBytes: Uint8Array): Promise<InferenceSession>;
}
