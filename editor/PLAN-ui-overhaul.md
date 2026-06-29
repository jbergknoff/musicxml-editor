# Plan: Selection-first UI overhaul — next steps

## Context

The editor has been overhauled to the **selection-first, keyboard-driven** model
from the Claude Design handoff (PR #24). The work was built on the editor's
**existing custom SVG renderer** rather than migrating to OpenSheetMusicDisplay:
the renderer (`editor/src/sheet-music/`) already implements the same
overlay/highlight/hit-test/cursor architecture the handoff calls for, so adopting
the design's *interaction model and chrome* onto it satisfied the OSMD
recommendation in spirit without a risky rewrite.

This doc records what shipped and captures the prioritized **next steps** — the
highest-impact being a pre-existing hit-test inaccuracy surfaced during the work.
It continues the `editor/PLAN.md` → `editor/PLAN-foundation.md` milestone series.

### What shipped (PR #24)

- **`dom-edit.ts`** — chord-aware `writeMeasure` (emits `<chord/>` on stacked
  notes, ordered low-to-high), plus `setAccidental`, `addNoteToChord`, and
  `insertMeasure`, all preserving the beat-budget invariant and untouched-element
  fidelity.
- **`hit-test.ts`** — `ChordInfo` (id + pitch + type per note),
  `chordInfoForHandle` / `chordInfoAtBeat` / `chordInfos`, `topFirstNotes`, and
  `octavePitch` for the inspector and beat navigation.
- **`components/Inspector.tsx`** (new) — the right panel: level badge, time-position
  header, top-first note rows (accidental segmented control, ▲▼ steppers, ✕
  remove), Add note, and empty state.
- **`Editor.tsx`** — the new toolbar + instruction-strip + transport shell on
  `theme.ts` design tokens, the full keyboard map (Esc/Enter/Tab, ↑↓ pitch with
  Shift octave, ←→ beat navigation, A–G add, −/=/0 accidentals, Space listen), and
  the inspector + listen wiring.
- **`use-listen.ts`** (new) — a WebAudio triangle step-synth stepping ~600 ms/beat
  from the selected beat, driving the renderer's existing `getLiveBeat`/`isPlaying`
  cursor and scroll-follow.
- **`theme.ts`** (new) + `index.html` — design tokens and IBM Plex / Noto Music
  fonts (system fallback under COEP).
- **Tests** — chord/accidental/measure unit tests in `dom-edit.test.ts`, and a new
  `editor/tests/selection-loop.spec.ts` Playwright spec (drill, inspector edits,
  Esc step-out, letter add, + Measure). The original `editing-flows.spec.ts` still
  passes.

Scope: single treble staff (matching the prototype). Multi-staff / multi-voice
documents remain **view-only** (`isEditableDocument`).

---

## Immediate follow-ups (polish / correctness)

### 1. Hit-test accuracy — **done** (PR #25)

### 2. Selection overlay chrome — **done** (PR #28)

Beat-box rect (Level 1) and note ring (Level 2) implemented via `BeatBox` /
`NoteRing` memo components in `SheetMusicDisplay`, keyed off `selectionBeat` /
`focusNoteId` props threaded through `EditableSheetMusic` and `Editor`.

### 3. Reselect after removing a chord member — **done** (PR #28)

`removeHandle` now re-resolves and re-selects the remaining chord (Level 1) after
removing one note from a multi-note chord, instead of always clearing to null.

### 4. Enharmonic spelling by key signature — **done** (PR #28)

`stepPitch` now accepts an optional `fifths` parameter and applies
`keyAlterForStep(step, fifths)` so ↑/↓ stays diatonic in the active key
(F♯ in G major, B♭ in F major, etc.). `stepHandle` in `Editor.tsx` reads
`score.parts[0].measures[measureIndex].activeFifths` and passes it through.
`keyAlterForStep` is now exported from `musicxml-parser.ts` and the barrel.

---

## Larger deferred features (in the spec, not in the prototype)

Each is its own milestone.

6. ~~**Multi-staff (grand-staff) editing**~~ — **done** (PR #26).
7. **Grace notes** — a selection sub-level attached to a parent note; `G` adds,
   ←/→ step into/out of the grace group.
8. **Durations, ties, beaming** — a duration palette (1–5 + dot), `T` to tie across
   a barline, `B` to break/join beams; lengthening absorbs following rests and
   overflow past the barline is carried by a tie. (Beaming already auto-renders via
   `groupBeamableEvents`.)
9. **Measure-range selection + copy/cut/paste** — a third selection mode above the
   note level; cut removes measures and pulls later ones left, paste inserts before
   the selected measure. Pairs with the existing `focusRange` scrubber in
   `SheetMusicDisplay.tsx`.
10. **Import confirm steps** — MIDI quantize / staff-split confirmation; OMR results
    landing in a cleanup mode. (Type routing already exists in `Editor.tsx`'s
    `onImport`.)
11. **Touch adaptations** — 44 px hit targets, the inspector as a bottom sheet on
    narrow screens, and tap / tap-again parity with the mouse two-click path.

---

## Polish / infra

12. **Configurable tempo + range playback** — the transport shows a fixed ♩ = 100;
    make it adjustable and let Listen play a selected measure range. `use-listen.ts`
    already steps a flat beat list and accepts a `fromBeat`, so this is mostly UI +
    an end-beat bound.
13. **Self-host fonts** — `index.html` loads IBM Plex / Noto Music from Google
    Fonts, which the page's COOP/COEP isolation may block (the theme's font stacks
    fall back to system fonts). Self-host the woff2 files under the static deploy for
    reliable rendering.

---

## Suggested order

**Done:** #1 (hit-test accuracy, PR #25), #2 (selection overlay chrome, PR #28),
#3 (reselect on remove, PR #28), #4 (enharmonic spelling, PR #28), #6 (multi-staff
editing, PR #26).

Remaining immediate follow-ups: none. Next work is the larger features (#7–#11)
as their own milestones. Each is a self-contained PR; run `make pr-ready`
(format, lint, typecheck, build, unit-test) plus `make editor-integration-test`
before committing.
