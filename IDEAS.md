# Improvement ideas

A researched backlog of improvement ideas across the project's three pillars —
image→MusicXML (OMR), MIDI→MusicXML, and the WYSIWYG editor — grounded in the
current state of the codebase: the editor's capability inventory, the OMR
pipeline's own skipped fixtures and `EXPECTED_DIFFERENCES` affordances, and the
deferred items already noted in `editor/PLAN.md` / `editor/PLAN-ui-overhaul.md` /
`lib/import-image/PLAN.md`.

## Where the project stands

- **Editor**: solid selection-first editing (notes, chords, ties, grace notes,
  accidentals, durations, grand staff, undo/redo, metadata/tempo). Imports
  MusicXML/MXL/MIDI/PDF/images; exports MusicXML only. Gaps: no key/time
  signature editing, no copy/paste, no dotted-duration or tuplet authoring,
  expressions (dynamics/slurs/lyrics/articulations) preserved but invisible and
  uneditable, multi-voice scores view-only, single-row horizontal layout.
- **OMR**: client-side segment → staff-detect → TrOMR → assemble pipeline,
  grand-staff capable, multi-page. Known limits (from its own test ratchet):
  single `<part>` output only (blocks three fixtures), meter inferred from
  rhythms (can't tell 6/8 from 3/4), no dynamics/articulations/lyrics, slurs
  decoded but dropped, dense low-bass misreads need a stronger model.
- **MIDI import**: works (tracks, tempo, duration decomposition) but is
  fire-and-forget — no quantization/confirmation UI. No MIDI export anywhere.

## Highest-leverage shortlist

1. **OMR cleanup mode in the editor** (deferred as PLAN-ui-overhaul item 10).
   After an `optical-music-recognition`-provenance import, show the source page
   image beside the notation and step measure-by-measure comparing the two.
   Extend by surfacing TrOMR decoder confidence (per-token softmax margins) to
   highlight the notes most worth double-checking. Turns "OMR is 95% right"
   into a usable workflow instead of a proofreading hunt, and is the feature
   that makes the pipeline+editor integration unique.
2. **Key & time signature editing.** No `setKey`/`setTime` op exists in
   `editor/src/dom-edit.ts` (PLAN.md follow-up) — users can't start a piece in
   D major or 3/4 without hand-editing XML. Key-signature-aware pitch stepping
   already exists, so the read side is done.
3. **Copy/cut/paste + measure-range selection** (deferred item 9). The biggest
   day-to-day productivity multiplier; naturally brings delete-measure
   (currently insert-only).
4. **Multi-part OMR assembly** — emit multiple `<part>`s
   (`lib/import-image/lib/assembly/musicxml-builder.ts`, plus a part-aware
   `tests/integration/helpers/musicxml-diff.ts`). The integration spec's own
   #1 unskip blocker (binchois, gabriels-bell, elgar-ave-verum); unlocks
   choral/vocal/organ scores.
5. **MIDI import confirmation dialog** (deferred item 10): quantization grid
   choice, track selection/merging, piano staff-split point, and key-signature
   inference from pitch content (MIDI files usually lack key metadata, so
   accidental spelling suffers today).
6. **Playback upgrades** (deferred item 12): tempo control in the transport,
   play-just-the-selection, and a lookahead WebAudio scheduler instead of
   `setTimeout` in `editor/src/use-listen.ts`. Cheap and very visible.

## More ideas by area

### Editor

- **Render, then edit, expressions**: dynamics, slurs, articulations, and
  lyrics survive round-trip but are invisible
  (`editor/src/sheet-music/musicxml-parser.ts` models only
  pitch/duration/dot/staccato/tie/grace/chord). Render first (read-only), then
  add editing. Dynamics could also drive playback velocity (fixed at 80 today).
- **Dotted durations, tuplets, beam break/join** (deferred item 8) — dots are
  parsed and preserved but cannot be authored.
- **More export formats**: MXL (inverse of the existing `lib/mxl.ts` reader),
  **MIDI export** (inverse of `lib/midi-to-musicxml.ts`), PDF/PNG via the
  existing renderer.
- **Wrapped multi-system layout** instead of one endless horizontal row — the
  prerequisite for decent printing/PDF export.
- **Lift the view-only gate gradually**: per-staff multi-voice editing beyond
  the current grand-staff case (`isEditableDocument` in `dom-edit.ts`).
- **Repeats/voltas authoring** (rendered and played, but not editable).
- **Autosave/session persistence** (localStorage/IndexedDB) — a minute-long OMR
  import plus corrections shouldn't be lost to a tab close.
- **Touch/mobile polish** (deferred item 11), an accessibility pass, and
  self-hosted fonts (item 13; COOP/COEP isolation can block Google Fonts).

### OMR

- **Compound-meter detection**: TrOMR emits no beaming, so 6/8 reads as 3/4
  (`saltarello` affordance). Recover beam groupings from the image itself and
  feed them to `lib/import-image/lib/assembly/meter.ts`; HOMR-COMPARISON.md
  notes this is closeable independently with a small classifier.
- **Emit slurs**: already decoded into `NoteEvent.slurStart/Stop`, then dropped
  by the assembler. Cheap fidelity win now that ties landed.
- **Phone-photo robustness** (PLAN Phase 6): deskew/dewarp and lighting
  normalization — today's implicit assumption is a clean scan or born-digital
  page.
- **Int8 quantization, progressive model loading, service-worker caching**
  (Phases 6–7): ~109 MB of weights is the biggest first-run friction; the
  classical staff path already avoids the 70 MB UNet — shrink TrOMR too.
- **Per-staff multi-voice** (Phase 5 remainder); repeat-count/volta emission
  (the decoder currently skips volta tokens and hardcodes `times: 2`).
- **Long-term: fine-tune or replace the transcription model.**
  `fixtures/COMPARISON.md` concludes the dense low-bass misreads need a
  stronger model. Synthetic training data is cheap here: render MusicXML
  corpora to images (Verovio/LilyPond) and fine-tune; or track the end-to-end
  full-page pianoform models noted in PLAN §10.

### MIDI

- **Smarter quantization**: triplet/swing grid detection, overlap dedupe,
  grace-note detection from very short leading notes.
- **Hand/voice separation** for piano MIDI beyond a fixed split point.
- **Velocity → dynamics markings**; tempo map → multiple `<sound tempo>`
  directions.
