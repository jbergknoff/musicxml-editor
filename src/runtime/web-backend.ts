import * as ort from "onnxruntime-web";
import type {
  InferenceBackend,
  Tensor,
  TensorDataType,
} from "../../lib/runtime/inference-backend";

// ORT Web fetches its WASM assets at runtime; serve them from /ort/ (see
// scripts/build.ts, which copies them there, and scripts/serve.ts).
ort.env.wasm.wasmPaths = "/ort/";

function toOrtTensor(tensor: Tensor): ort.Tensor {
  if (tensor.type === "uint8") {
    return new ort.Tensor("uint8", tensor.data as Uint8Array, tensor.dims);
  }
  return new ort.Tensor("float32", tensor.data as Float32Array, tensor.dims);
}

function fromOrtTensor(value: ort.Tensor): Tensor {
  return {
    type: value.type as TensorDataType,
    data: value.data as Float32Array | Uint8Array,
    dims: value.dims as number[],
  };
}

/**
 * Browser inference backend. Prefers WebGPU when available, falling back to the
 * threaded WASM backend. The page must be cross-origin isolated for the WASM
 * threads to work (see scripts/serve.ts / netlify.toml).
 */
export async function createWebBackend(): Promise<InferenceBackend> {
  const provider = "gpu" in navigator ? "webgpu" : "wasm";
  return {
    provider,
    async createSession(modelBytes) {
      const session = await ort.InferenceSession.create(modelBytes, {
        executionProviders: [provider, "wasm"],
      });
      return {
        async run(feeds) {
          const ortFeeds: Record<string, ort.Tensor> = {};
          for (const [name, tensor] of Object.entries(feeds)) {
            ortFeeds[name] = toOrtTensor(tensor);
          }
          const results = await session.run(ortFeeds);
          const output: Record<string, Tensor> = {};
          for (const [name, value] of Object.entries(results)) {
            output[name] = fromOrtTensor(value);
          }
          return output;
        },
      };
    },
  };
}
