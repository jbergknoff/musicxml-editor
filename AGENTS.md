# Agent notes (monorepo root)

This repository is **`musicxml-editor`**: a WYSIWYG MusicXML editor whose
"import from an image/PDF" feature is the old `pdf-to-musicxml` OMR pipeline. The
two are now **integrated** — the editor's Import control routes PDFs and raster
images through the OMR pipeline (which lives under `lib/import-image/`) and loads
the recovered MusicXML into the editor; `.musicxml`/`.xml` files are still parsed
directly.

## Layout

```
editor/             The WYSIWYG MusicXML editor (Preact). The primary app and the
                    deploy target. Its Import feature calls the OMR pipeline via
                    lib/import-image's API. See editor/PLAN.md.

lib/import-image/   The OMR pipeline (the original pdf-to-musicxml app), moved
                    here and folded into the root toolchain — its standalone
                    Makefile / docker-compose / netlify.toml / package.json were
                    removed and merged into the root. Its own lib/ (runtime-
                    agnostic core), src/ (worker, decode, ORT backend, model
                    registry), netlify/functions, scripts, and tests are intact.
                    lib/import-image/index.ts is the public API. See
                    lib/import-image/AGENTS.md and PLAN.md for the pipeline.
```

### The import API — `lib/import-image/index.ts`

`createImageImporter()` → an `ImageImporter` whose `importFile(file, onProgress)`
decodes a PDF/image on the main thread and runs segmentation → staff detection →
TrOMR transcription in the OMR worker, returning an `ImageImportResult`: the
recovered MusicXML string plus `review` data for the editor's cleanup mode —
each decoded page as a PNG blob, each recognized system's page region paired
with the measure range it produced (`lib/assembly/review-map.ts`; measure
numbering mirrors `buildScore` exactly), and the notes the TrOMR decoder was
least sure about (`flaggedNotes`: per-token softmax confidence from
`tromr-session.ts`, addressed by measure + `<note>` element index via the
builder's `onNoteEmitted` sink — the editor tints them amber while reviewing). Multi-page PDFs are recognized a page
at a time and stitched into one document (measure numbers run continuously
across pages); progress updates carry `page`/`pageCount` for those.
`imageToMusicXml(file)` is the one-shot convenience (string only). The editor
wraps this in `editor/src/use-image-import.ts` and calls it from `Editor.tsx`'s
Import handler; after an OMR import the editor opens `ImportReviewPanel`
(`editor/src/components/ImportReviewPanel.tsx`), which shows the source page
cropped to the system containing the selection and steps system-by-system
(TrOMR has no positional output, so the system — not the measure — is the
finest source region).

Inference runs in `lib/import-image/src/worker/omr.worker.ts`, bundled by the
build into `editor/dist/omr.worker.js` and loaded via `new Worker("/omr.worker.js")`.
ORT WASM, the pdf.js worker, and the model weights are fetched at run time, so the
page must be cross-origin isolated (COOP/COEP).

## Root tooling

The repo root is a Bun workspace whose member is `editor/`; the OMR runtime deps
(onnxruntime-web, pdfjs-dist, opensheetmusicdisplay, …) are merged into the root
`package.json`. Local requirements are `make` and `docker` (Bun/Biome/tsc/
Playwright run in containers via docker-compose).

```sh
make build         # scripts/build-editor.ts -> editor/dist (editor + OMR worker + assets)
make dev           # build, then rebuild on change
make up / make down # serve editor/dist on :3456 with COOP/COEP (scripts/serve.ts)
make format        # biome format --write
make lint          # biome lint
make typecheck     # tsc --noEmit
make unit-test     # bun test editor + lib/import-image lib/src
make integration-test # Playwright (lib/import-image/playwright.config.ts)
make editor-integration-test # Playwright editor editing-flow tests
                   # (playwright.editor.config.ts): select/delete/undo, the
                   # no-insert-on-empty-tap and view-only guards for multi-staff
                   # scores, driving the served editor/dist in the pinned browser
                   # image.
make omr-integration-test # end-to-end OMR: real pipeline (Node/CPU) over
                   # musicxml.com fixture images, diffing the recovered MusicXML
                   # against each fixture's source score (only codified
                   # affordances allowed) + an OSMD screenshot. Slow but
                   # deterministic; downloads the v2 weights once into
                   # public/models/. Regenerate screenshots with
                   # ARGS=--update-snapshots.
make pr-ready      # format, lint, typecheck, build, unit-test
```

The OMR integration tests (`lib/import-image/tests/integration/import-image.spec.ts`,
config `playwright.omr.config.ts`) run the recognition pipeline headlessly in
Node (onnxruntime-node, CPU — `tests/integration/helpers/omr-pipeline.ts` mirrors
`omr.worker.ts`) so the recovered MusicXML is deterministic, then **diff it against
the fixture's source score** (`helpers/musicxml-diff.ts`) and render it with OSMD
in Chromium for a screenshot. The recovered MusicXML is **not** committed — each
fixture instead lists, in the spec's `EXPECTED_DIFFERENCES`, the specific
currently-expected ways its recovery differs from the real score (the "affordances").
The diff is a two-way ratchet: an uncodified difference fails (regression), and an
affordance that no longer matches any actual difference also fails (improve the OMR,
then delete the affordance). Fixtures (images + `*.source.musicxml`) and the
committed screenshot baselines live under `tests/integration/fixtures/` and
`tests/integration/__snapshots__/` (screenshots only). CI runs them in the
`omr-integration` job (separate from the editor job; caches the weights).

**Running the OMR integration tests (weights).** The suite needs the ~109 MB
weights in `lib/import-image/public/models/`. `ensureModels` fetches them on first
run from the served (Netlify) host the app uses, falling back to the upstream
GitHub releases (`scripts/model-source.ts`) if that host is unreachable. The
fixtures use the model-free *classical* staff path and the TrOMR weights are
served as-is, so the upstream weights recover byte-identical MusicXML — either
source works. **On a network-restricted machine (e.g. Claude Code on the web,
whose egress proxy CA is mounted only into the `main` Docker service, not
`playwright`): run `make models` first.** That downloads from the upstream
releases inside the `main` container (which has the proxy CA) into the shared
`public/models/` volume; `make omr-integration-test` (the `playwright` container)
then finds them and skips the network fetch. The screenshots render in the pinned
Playwright image, so baselines regenerated locally (`ARGS=--update-snapshots`)
match CI.

Out-of-band OMR model-weight targets (weights are ~109 MB, gitignored, not
committed) run inside `lib/import-image/` so their relative paths resolve:
`make models` (download), `make optimize-models` (onnxsim to v2),
`make upload-models` (to Netlify Blobs), `make compare-resolutions`.

`editor/src/test-setup.ts` (linkedom DOM globals) is preloaded for the editor's
tests via root `bunfig.toml`.

## Deployment

Netlify deploys the **editor**: `netlify.toml` builds with `make build-editor`,
publishes `editor/dist`, sets the COOP/COEP headers the OMR WASM backend needs,
and points `[functions]` at `lib/import-image/netlify/functions` so the models
function streams the weights same-origin at `/models/<file>` (required under
COEP). The weights themselves are uploaded once, out of band, to Netlify Blobs
(`make upload-models`) — not part of the static deploy. Locally `scripts/serve.ts`
serves the same `/models/<file>` URLs from `lib/import-image/public/models/`.

## Conventions

Carried from the sibling piano-practice repo: full words in names, braces around
every conditional/loop body, `PascalCase` components and `kebab-case` everything
else, `lib/` runtime-agnostic. Run `make pr-ready` before committing.

## Editor architecture notes

**Grand staff internals (non-obvious):**
A MusicXML `<part>` with `<staves>2</staves>` is split into TWO entries in
`score.parts[]`: `parts[0]` = treble, `parts[1]` = bass. `SlotInfo`, `ChordInfo`,
and `ChordSelection` all carry a `partIndex` field that maps directly to this array.
When editing grand-staff scores, propagate `partIndex` through selection state and
pass `slotInfo.partIndex + 1` (1-based) as the MusicXML `<staff>` number to
`addNote`. The editability gate is `isEditableDocument()` in `dom-edit.ts` —
a document with exactly one `<part>` is editable (any number of staves and
voices; `writeMeasure` rebuilds the backup structure faithfully); multi-part
scores are view-only.

`addStaff(doc)` / `removeStaff(doc, staff?)` (`dom-edit.ts`, toolbar "+ Staff" /
"− Staff") grow and shrink that staff array in place: `addStaff` appends a staff
below the rest (bass clef when it becomes staff 2, treble otherwise), bumps
`<staves>`, and gives every measure a full-measure rest for it; `removeStaff`
drops one staff's notes, slides the staves below it up (renumbering `<staff>`
tags and clefs), and reverts to plain single-staff shape (no `<staves>`, no
`<staff>` tags) when one staff remains. Both rebuild each measure through
`writeMeasure`, whose `requiredStaves` argument forces an otherwise-empty staff
to still emit its blank bar.

**Tempo storage in MusicXML:**
Playback BPM is stored as `<sound tempo="N">` inside a `<direction>` in measure 1,
paired with `<metronome>` for display. `readMetadata()` finds it via
`doc.querySelector("sound[tempo]")`; `writeMetadata()` upserts a single tempo
direction and prunes it when cleared. `useListen(score, bpm)` takes BPM explicitly;
the editor reads `metadata.tempo ?? 100`.

**`linkedom` limitation in unit tests:**
`bun test` uses `linkedom` as the DOM shim (loaded via `editor/src/test-setup.ts`).
`linkedom` does **not** implement `Element.closest()`. Use `element.parentElement`
with a tag check instead when traversing up the DOM in any code that also runs
under `bun test`.

**Editor Playwright tests:**
`make editor-integration-test` runs `editor/tests/*.spec.ts`. Narrow the run with
`ARGS="filename.spec.ts"` or `ARGS="filename.spec.ts:lineNumber"`.

Test flakiness is not tolerated: a flaky test is a real bug, not a rerun-until-green
situation. In this codebase flaky Playwright failures have consistently traced back
to a stale-closure race in `Editor.tsx` — a keyboard shortcut fired immediately after
one that changed `selection`/the document gets handled by a `keydown` listener that
hasn't been re-subscribed yet, so it acts on pre-edit state (see `selectionRef`'s and
`slotInfoRef`'s doc comments for the fix pattern: read a ref kept current in the
render body, or reparse a fresh score from `documentRef.current`, instead of closing
over the memoized `selection`/`score`/`slotInfo`). Reproduce a suspected flake with
`--repeat-each` under `--workers` > 1 to force the race, fix the root cause, then
confirm with a large `--repeat-each` before treating it as resolved.

**Selection / gesture types:**
`EditorGesture` carries `hit` (the notehead under the pointer, picked in screen
space across every staff by `pickNoteAtPoint()` in `hit-test.ts`), `partIndex`
(the hit note's own staff when a notehead was clicked, else the staff whose
vertical band is nearest), and `offStaff` (true if the tap has no hit and is >4
staff-spaces from every staff, used to clear selection). When a tap hits a
notehead, `handleTap` selects that note's exact slot via `chordForHandle` —
never a beat/staff-band estimate — so ledger-line notes between two staves
select correctly. A tap while drilled to note level stays at note level. The
`slot` variant of the `Selection` union also carries `partIndex`. `sameSlot()`
compares `partIndex`. The `slots()`, `slotAt()`, and `slotAtBeat()` functions in
`hit-test.ts` accept an optional `partIndex` to restrict results to one staff.

`←/→` navigation (`navBeat`), by contrast, is **not** staff-bound: it walks the
*shared* rhythm spine — the union of every staff's onsets — so it reaches a beat
that only another staff subdivides rather than skipping to the current staff's
own next onset. On landing it keeps the current staff when that staff has an
onset at the destination beat, and otherwise crosses to the staff that does
(note-bearing staff first, then topmost). Editing ops that must target a staff
(add-note, `shiftNotesInTime`) stay staff-aware via the landed slot's `partIndex`.

**Shift in time (`shiftNotesInTime` / `shiftSelectionInTime`):** `,` / `.` move
the selected chord and everything after it in its measure/staff as a block, by
the chord's own duration, absorbing/emitting rest space at the bar ends. A right
shift with no trailing rest to absorb it **grows the bar into an over-full bar**
rather than refusing — intermediate states during OMR cleanup are allowed to be
irregular, and the over-full badge (below) makes them visible. A **left** shift
is still refused when it would overlap a real note before the anchor (or the bar
start): that is a genuine collision, not merely a long bar, and the editor
surfaces a transient `editHint` in the transport bar.

**Over-full badges (`measureFillReport` in `dom-edit.ts` → `OverfullBadges` in
the renderer):** an amber "N beats" pill is drawn above any *staff* whose notes
reach past its time signature. It is **per staff**, not per measure:
`measureFillReport` measures how far each staff's *notes* extend (rests and the
trailing padding `writeMeasure` adds to align staves are excluded, or every
staff of an over-full bar would read as over-full), so a grand staff whose bass
overflows while the treble is fine badges only the bass. `staffBeats[i]` is
index-aligned with `score.parts[i]`. Under-full bars (pickups, final bars) are
legitimate and never flagged.

**Trim measure (`trimMeasure` in `dom-edit.ts` → the "Trim measure" context-menu
item):** the "fix" counterpart to an over-full bar. `writeMeasure` pads every
voice out to the bar's *own* length (`measureContentDivisions`, which counts the
padding rests), so an over-full OMR bar is a fixed point — shortening the
over-long durations that stretched it just re-pads to the same length, and the
trailing rests can't be deleted directly (a rest slot has no handles). `trimMeasure`
re-emits the measure at `max(realNoteExtent, nominalDivisionsPerMeasure)` — as far
as its real notes reach, but never below the time signature — dropping the padding
on every staff at once. It floors at nominal so a bar that legitimately ends on a
rest is left alone, and never removes a real note that overruns the barline (that
stays over-full and badged). `measureTrailingPadding` is the pure predicate the
menu uses to enable the item only when there is padding to drop. Note that a
measure whose content genuinely crosses the barline (tied-over notes) keeps fill
rests on the shorter staves until those over-barline durations are themselves
corrected — trim removes padding, it doesn't model cross-bar ties.
