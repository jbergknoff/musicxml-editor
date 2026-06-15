import type { InferenceBackend } from "../../lib/runtime/inference-backend";
import {
  createSegmentationModels,
  type SegmentationModels,
} from "../../lib/segmentation/segment";

/**
 * Locates and loads the ONNX model weights, caching the downloaded bytes so
 * repeat visits (and offline use) skip the network.
 *
 * The weights are large (~70 MB + ~38 MB) and must be served from the same
 * origin: cross-origin isolation (COEP `require-corp`) blocks third-party
 * fetches that lack CORP headers. They are therefore expected under `/models/`
 * (run `make models` to download them into `public/models/`, which the build
 * copies into `dist/`). Once fetched they are stored in the Cache Storage API.
 */

export interface ModelAsset {
  /** File name, used for logging and cache keys. */
  name: string;
  /** Same-origin URL the weights are served from. */
  url: string;
}

const MODEL_BASE_URL = "/models/";

export const SEGMENTATION_MODEL_ASSETS = {
  /** oemer `unet_big` — staffline + symbol segmentation. */
  staffSymbol: {
    name: "1st_model.onnx",
    url: `${MODEL_BASE_URL}1st_model.onnx`,
  },
  /** oemer `seg_net` — stems/rests, noteheads, clefs/keys. */
  symbolDetail: {
    name: "2nd_model.onnx",
    url: `${MODEL_BASE_URL}2nd_model.onnx`,
  },
} satisfies Record<string, ModelAsset>;

const CACHE_NAME = "pdf-to-musicxml-models-v1";

/** Fetch a model's bytes, serving from Cache Storage when available. */
async function fetchModelBytes(asset: ModelAsset): Promise<Uint8Array> {
  const cache =
    typeof caches !== "undefined" ? await caches.open(CACHE_NAME) : undefined;
  let response = await cache?.match(asset.url);
  if (response === undefined) {
    response = await fetch(asset.url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch model "${asset.name}" from ${asset.url}: ${response.status}`,
      );
    }
    await cache?.put(asset.url, response.clone());
  }
  return new Uint8Array(await response.arrayBuffer());
}

export interface LoadModelsOptions {
  /** Reports which asset is being loaded, for UI status. */
  onAssetLoading?: (asset: ModelAsset) => void;
}

/**
 * Download (or read from cache) both segmentation models and create their
 * inference sessions on the given backend.
 */
export async function loadSegmentationModels(
  backend: InferenceBackend,
  options: LoadModelsOptions = {},
): Promise<SegmentationModels> {
  options.onAssetLoading?.(SEGMENTATION_MODEL_ASSETS.staffSymbol);
  const staffSymbolBytes = await fetchModelBytes(
    SEGMENTATION_MODEL_ASSETS.staffSymbol,
  );
  const staffSymbolSession = await backend.createSession(staffSymbolBytes);

  options.onAssetLoading?.(SEGMENTATION_MODEL_ASSETS.symbolDetail);
  const symbolDetailBytes = await fetchModelBytes(
    SEGMENTATION_MODEL_ASSETS.symbolDetail,
  );
  const symbolDetailSession = await backend.createSession(symbolDetailBytes);

  return createSegmentationModels(staffSymbolSession, symbolDetailSession);
}
