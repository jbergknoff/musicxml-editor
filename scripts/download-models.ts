/**
 * Downloads the oemer segmentation model weights into public/models/ so the
 * build can serve them same-origin (cross-origin isolation blocks third-party
 * fetches that lack CORP headers). The weights are gitignored and total ~109 MB;
 * run this once via `make models`.
 *
 * Source: oemer's GitHub release `checkpoints` tag (MIT-licensed).
 */
import { mkdir, stat } from "node:fs/promises";

const RELEASE_BASE =
  "https://github.com/BreezeWhite/oemer/releases/download/checkpoints";

const MODELS = ["1st_model.onnx", "2nd_model.onnx"];
const TARGET_DIRECTORY = "public/models";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

await mkdir(TARGET_DIRECTORY, { recursive: true });

for (const model of MODELS) {
  const target = `${TARGET_DIRECTORY}/${model}`;
  if (await exists(target)) {
    console.log(`✓ ${model} already present`);
    continue;
  }
  console.log(`Downloading ${model}…`);
  const response = await fetch(`${RELEASE_BASE}/${model}`);
  if (!response.ok) {
    throw new Error(`Failed to download ${model}: ${response.status}`);
  }
  await Bun.write(target, response);
  console.log(`✓ ${model}`);
}

console.log(`Models ready in ${TARGET_DIRECTORY}/`);
