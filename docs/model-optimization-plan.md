# Plan: speed up WebGPU segmentation by optimizing the ONNX weights

Status: **Phase 1 + work reduction implemented** (2026-06-17). The offline
graph simplification, stride widening, and pixel-budget reduction all landed.
Measured on a real score page via WebGPU: **~3.7 min → 35.8 s** total, across
two rounds of improvement. `MODEL_VERSION` is `v2`; the optimized weights are
uploaded.

**fp16 was tried and rolled back (2026-06-18).** It passed the quality gate
convincingly (**0.99998 overall pixel agreement, every class IoU ≥ 0.998** vs the
fp32 served weights) and is implemented as `make optimize-models ARGS="--fp16"`,
but serving it as `v3` *regressed* WebGPU speed badly on the test device:
**35.8 s → 126 s**, with per-tile times (904 ms on the 256² model, 1666 ms on the
288²) back at the pre-Phase-1 figures (~920 / ~1830 ms). That signature means the
fp16 ops fall back to CPU mid-graph, reintroducing the per-tile GPU↔CPU
round-trips Phase 1 removed — the WebGPU EP only runs fp16 on devices advertising
`shader-f16`, and the cast nodes the conversion inserts make a non-f16 device
strictly worse, not merely "no faster." Rolled back to `v2` (one-line
`MODEL_VERSION` revert; the v2 blobs were retained). The gate measures *quality*
on the CPU EP and structurally cannot see this, so a `shader-f16`-gated WebGPU
speed measurement must precede any future fp16 rollout. Net: fp16 is only worth
revisiting behind runtime `shader-f16` detection (serve fp32 to everyone else),
not as a single served artifact.

## What landed (Phase 1 + work reduction)

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

**Phase 1 measured result (WebGPU, real score page):** ~3.7 min → **58.6 s**
(~3.8× speedup). Per-tile: 236.9 ms (staff/symbol, 256²) and 492.3 ms
(symbol detail, 288²) — down from ~920 ms and ~1830 ms. Confirms the
GPU↔CPU round-trip hypothesis: ops are now on the GPU EP.

**Work reduction (stride + pixel budget) — also landed:**

- `lib/input/preprocess.ts`: All three pixel-count constants set to exactly
  3,000,000 px (oemer's training lower bound). Pages above 3 M px are
  downscaled; pages below are upscaled. Previously the ceiling was 4.35 M px,
  driving larger pages to ~100 tiles/model.
- `lib/segmentation/segment.ts`: Step sizes widened from 75% to **87.5%**
  of the window: `staffSymbol.stepSize` 192 → **224** (32 px overlap),
  `symbolDetail.stepSize` 216 → **252** (36 px overlap). ~30% fewer tiles
  than the 75%-stride baseline.
- Tile counts at 3 M px (measured page, 1523×1970): **58** staff/symbol +
  **44** symbol detail.

**Work reduction measured result (WebGPU):** 58.6 s → **35.8 s** (~1.6×
further speedup from Phase 1 alone).

**Parallel-workers experiment (tried and reverted):** Running the two models
in separate workers to overlap GPU dispatch showed that the GPU is the wall.
Both workers slowed ~2× (236 ms/tile → 592 ms, 492 ms/tile → 701 ms) because
they compete for the same physical GPU; total wall-clock improved only ~1.4 s
(35.8 s → 34.4 s), within run-to-run variance. Reverted — the added complexity
bought nothing.

**Why further stride widening is a no-op at 3 MP:** Edge-clamping snaps the
last tile in each axis flush to the image edge regardless of stride. At 3 M px
resolution, widening from 87.5% to 93.75% yields identical tile counts for
both models on the measured page (the edge tile absorbs the difference). Going
further would risk misaligned edges rather than reducing tile count.

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

## Phase 2 (further optimization avenues)

Phase 1 + work reduction achieved ~6× total speedup (3.7 min → 35.8 s). The
GPU is compute-saturated at 35.8 s; the remaining levers are model-level, not
structural.

### Quality evaluation gate (landed)

The model-level levers below are not numerically exact, so they need a gate
before they can be served — the `optimize-models` bitwise check (`max|diff| = 0`)
no longer applies. `scripts/evaluate-models.py` (`make evaluate-models`) is that
gate: for each served model it runs the reference and a candidate (by default the
model's fp16 conversion; or an arbitrary `--candidate-dir`) over the same real
sample tiles and compares their per-pixel **argmax** — the class map the pipeline
actually consumes — reporting per-class IoU and overall pixel agreement, and
exiting non-zero below a threshold. It argmaxes real notation rather than diffing
raw outputs on random input because a class flip is what changes a mask and fp16
rounding only bites where two class scores are close (symbol edges). Because both
models see identical pixels it is a purely relative comparison, so it need not
reproduce the production preprocess/tiling exactly. Out of band, like
`optimize-models`; reads `public/models/` plus user-provided pages in `samples/`.
`make evaluate-models` writes a committable Markdown report to
`docs/model-evaluation.md` (the script's `--report` flag) so the numbers behind a
rollout decision — candidate, thresholds, sample pages, per-class IoU — live in
the repo even though `samples/` is gitignored. Commit that file after a run.

Caveat: the gate evaluates on the CPU EP (no browser from Python), so it
approximates the served WebGPU fp16 numerics. If ORT's CPU EP can't run a true
fp16 `Conv`, it falls back to fp16 *weight-rounding* emulation (a lower bound on
divergence) and says so. The faithful end-to-end check remains running the
candidate weights through the browser pipeline before rollout.

### Reduced-precision and structural levers

- **fp16 conversion** (**implemented but regressed on the test device** — see the
  status note): `make optimize-models ARGS="--fp16"` runs `onnxconverter-common`'s
  `convert_float_to_float16` (with `keep_io_types=True`) after the onnxsim step.
  Layout is unchanged (NHWC) and the I/O dtypes are preserved (uint8 in, float32
  out), so no `lib/` change is needed. It is numerically safe (gated by
  `make evaluate-models`), but only a *speed* win on a device advertising
  `shader-f16`; on a device without it the fp16 ops fall back to CPU mid-graph and
  it is a large regression. Do not serve it as a single artifact — revisit only
  behind runtime `shader-f16` detection that picks fp16 vs fp32 weights per
  device. Always confirm the WebGPU speedup on a `shader-f16` device before
  rollout.
- **int8 quantization** is *not* recommended for the WebGPU target: ORT-web's
  WebGPU EP has no efficient int8 conv path, so `ConvInteger`/`QDQ` ops fall back
  to CPU and reintroduce the per-tile GPU↔CPU round-trips Phase 1 deleted —
  likely a regression, not a speedup.
- **NHWC → NCHW end-to-end** to delete the ~95 `Transpose` nodes: requires
  `packBatch` to emit `[N,3,H,W]` and the output reader to consume `[N,C,H,W]`
  (lib change + test updates).
- **Opset upgrade (9 → 17+)** plus fusing the manual instance-norm blocks into
  `InstanceNormalization` and folding `Conv`+`BatchNormalization`, for fewer and
  faster kernels.

## Estimated effort

Phase 1: ~half a day — `optimize-models.py`, manifest shape + version bump,
batch-size wiring, and verification — plus the out-of-band re-upload of weights.
