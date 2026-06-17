# Plan: speed up WebGPU segmentation by optimizing the ONNX weights

Status: **Phase 1 implemented** (2026-06-17). The offline graph simplification,
its `make optimize-models` tooling, the `manifest.inputShape` source of truth,
and the fixed-batch pipeline wiring all landed; `MODEL_VERSION` is bumped to
`v2`. Re-running the optimizer against the real oemer weights reproduced the
spike exactly — `1577 → 713` and `1619 → 719` nodes at fixed input `[1,…]`, with
`max|diff| = 0.0` on both models. The remaining work is out of band and on the
deployer: `make optimize-models && make upload-models` to publish the optimized
`v2` blobs, then deploy and read the WebGPU `segment` ms off the `[omr]` perf log
(the payoff metric) to decide whether Phase 2 is needed. Originally investigated
against the real oemer weights on 2026-06-17.

## What landed (Phase 1)

- `scripts/optimize-models.py` + `make optimize-models` (a `python:3.11-slim`
  Docker service): onnxsim with the per-model fixed input shape, a hard
  numerical-equivalence assertion, rewriting `public/models/*.onnx` in place.
  The bridge between the downloaded oemer originals and the served weights.
- `lib/models/manifest.ts`: per-model `inputShape` (`[1,256,256,3]` /
  `[1,288,288,3]`) as the single source for the baked batch; `MODEL_VERSION` →
  `v2`.
- `src/worker/omr.worker.ts`: feeds the baked fixed batch (`inputShape[0] = 1`)
  instead of the old provider-specific batch sizes.
- `AGENTS.md`: documents the optimize step as part of the local and rollout
  flows.

## Problem

WebGPU segmentation is ~3.7 min/page (~920 ms/tile on the 256² model, ~1830
ms/tile on the 288²). That is ~100× slower than a UNet this size should run on a
GPU. Earlier work established the crash is fixed (bounded batch) and that the
convolutions do run on WebGPU (JSEP), not on CPU — so the slowness is not a
conv-on-CPU fallback. ORT's own profiling can't be used to dig further on this
device (verbose logging floods/crashes the console; WebGPU per-kernel profiling
crashes the GPU process). So the weights were inspected offline instead.

## Evidence (measured against the actual weights)

Both models are old `tf2onnx 1.10.0`, **opset 9** exports, and are massively
bloated relative to the work they do:

| model | role | input (NHWC, uint8) | output | nodes | Conv/ConvT |
|---|---|---|---|---|---|
| `1st_model` (unet_big) | staff/symbol | `[?,256,256,3]` | `[?,256,256,3]` | **1577** | 49 / 8 |
| `2nd_model` (seg_net)  | symbol detail | `[?,288,288,3]` | `[?,288,288,4]` | **1619** | 36 / 4 |

The other ~1500 nodes per model are overhead, dominated by **dynamic-shape
machinery**: ~100 each of `Shape`, `Gather`, `ConstantOfShape`, `Reshape`, plus
~250 `Cast`, ~150 `Mul`, and ~95 `Transpose` (NHWC↔NCHW churn around each conv),
plus ~50 per-layer instance-norm blocks (`ReduceMean`/`Sub`/`ReduceSumSquare`/
`Div`).

The `Shape`/`Gather`/`ConstantOfShape` ops are exactly the ones ORT reports as
"not assigned to the preferred execution provider" — they run on **CPU**.
Because they sit mid-graph, every one forces a **GPU→CPU→GPU round-trip** per
tile. ~100 of them × 167 tiles/page is the prime suspect for the per-tile cost,
far more than the conv compute itself.

## Fix — Phase 1: offline graph simplification with a fixed input shape

Tooling: `onnx` + `onnx-simplifier` (onnxsim) + `onnxruntime` (Python). This is a
pure ONNX→ONNX transform of the released weights — **no access to oemer's source
TF model is needed**.

Running `onnxsim.simplify(model, overwrite_input_shapes={"input":[1,H,W,3]})`:

| model | nodes before → after | what's removed |
|---|---|---|
| `1st_model` | 1577 → **713** | all `Shape`/`Gather`/`ConstantOfShape`/`Cast` folded to constants |
| `2nd_model` | 1619 → **719** | same |

After simplification the remaining ops are `Conv`, `ConvTranspose`,
`BatchNormalization`, `Relu`, `ReduceMean`/`Sub`/`ReduceSumSquare`/`Div`,
`Reshape`, `Transpose`, `Concat`, `Softmax` — **all supported by ORT-web's
WebGPU EP**, so nothing should force a CPU sync any more.

Verified numerically exact: `max|original − simplified| = 0.0` on random uint8
input, at batch 1 and batch 4. (File size is ~unchanged: the weights dominate,
not the node count.)

**Why a fixed batch is required.** Leaving the batch dim dynamic and only fixing
the spatial dims folds almost nothing (`1619 → 1519`), because the shape
subgraphs are batch-dependent. Baking a concrete batch is what unlocks the
fold. Our tiles are always full-window (`planTiles` clamps edge tiles flush, so
they're always 256²/288²), so a fixed spatial shape is always valid.

## Pipeline impact (small)

- **Layout is unchanged.** Input stays NHWC `uint8 [N,H,W,3]`, output stays NHWC
  `[N,H,W,C]`. So `unet-session.ts` packing and `masks.ts`/`tiling.ts` output
  parsing need **no layout changes**. `detect-staves` etc. are untouched.
- **Only change: feed a fixed batch `N`.** Two options:
  - **Recommended: `N = 1`.** Set the batch size to 1 for the optimized models.
    Every inference is batch 1, so no padding is ever needed, shapes are fully
    static (best for WebGPU pipeline/shader caching — one compiled pipeline per
    kernel), and it's structurally immune to the oversized-buffer crash. Cost:
    ~167 inferences/page, each with its own readback. Since batch 4 vs 8 timed
    identically before, per-dispatch overhead isn't currently dominant.
  - **Alternative: `N = 4`** (fewer dispatches). Requires padding the final
    partial batch up to `N` with dummy tiles and discarding the extra outputs —
    a small change in `packBatch`/`runSegmentationModel`.
- The existing unit tests inject fake sessions, so they're unaffected by the
  weights change.

## Where it lives in the build

This is a one-time, out-of-band transform per weights change — mirroring how
`upload-models` already works — **not** part of the per-build path.

1. Add `scripts/optimize-models.py` run in a Python container (new
   `make optimize-models` target, alongside `make models`). It downloads the
   oemer originals (or reuses `download-models` output), runs onnxsim with the
   per-model fixed shapes, asserts numerical equivalence (fail if `max diff` >
   small tol), and writes the optimized files.
2. Store the fixed input shape per model in `lib/models/manifest.ts` so the
   optimize script and the pipeline agree on `N`/`H`/`W` from one source.
3. Bump `MODEL_VERSION` in the manifest (URLs are versioned + immutable, so this
   cache-busts the browser registry, Cache Storage, and the CDN).
4. Re-run `make upload-models` to push the optimized weights to Netlify Blobs.
   Keep the originals in the store so rollback is instant.
5. `download-models` keeps fetching the oemer originals; the optimize step is the
   bridge between "original" and "served".

## Verification

1. **Numerical equivalence** (already shown in the spike: `max diff = 0.0`) —
   keep it as a hard assertion in `optimize-models.py`.
2. **End-to-end masks**: run the pipeline on a sample page before/after; masks
   should be pixel-identical and the detected staff structure identical.
3. **Existing unit tests** continue to pass (they don't touch real weights).
4. **The payoff metric**: `segment` ms on WebGPU before/after, from the existing
   `[omr]` perf log. This is the number that decides success.

## Risks & rollback

- If, even with the sync-forcing ops gone, the device is still slow, that points
  at raw conv throughput on a weak GPU → go to Phase 2 (below) or reduce work
  (fewer tiles / lower resolution).
- Fixed batch needs last-batch handling; `N = 1` avoids it entirely.
- Rollback is a one-line `MODEL_VERSION` revert + redeploy; old URLs still
  resolve from Blobs.

## Phase 2 (only if Phase 1 isn't enough)

More invasive; defer until Phase 1 is measured.

- **NHWC → NCHW end-to-end** to delete the ~95 `Transpose` nodes: requires
  `packBatch` to emit `[N,3,H,W]` and the output reader to consume `[N,C,H,W]`
  (lib change + test updates).
- **Opset upgrade (9 → 17+)** plus fusing the manual instance-norm blocks into
  `InstanceNormalization` and folding `Conv`+`BatchNormalization`, for fewer and
  faster kernels.

## Estimated effort

Phase 1: ~half a day — `optimize-models.py`, manifest shape + version bump,
batch-size wiring, and verification — plus the out-of-band re-upload of weights.
