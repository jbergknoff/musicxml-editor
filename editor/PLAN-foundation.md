# Plan: Editor foundation milestone — fidelity, click-based editing, undo/redo

## Context

The editor (`editor/`) is past its step-1 MVP: a single-staff, single-row surface
where you add/move/remove notes by **dragging**, backed by a document-as-source
model (`dom-edit.ts` mutates the live MusicXML `Document`; untouched `<note>`
elements are reused verbatim). This milestone builds the **foundation** for a
trustworthy editor: confirm/harden lossless round-trip, replace the error-prone
drag interaction with a deliberate **click-to-select + context-menu** model, and
add **undo/redo** with a **dirty indicator**.

Why now: dragging any note makes accidental edits trivial and fights drag-to-scroll
(`SheetMusicDisplay.tsx`); there is no undo and no way to tell the file changed
from its imported state.

### Scope decisions (confirmed)

- **Scope:** foundation only — Phases 1–3 below (fidelity, click editing,
  undo/dirty). **Audio playback and structural edits (ties/repeats) are deferred**
  to a follow-up planning round (sketched at the end for continuity).
- **Round-trip = semantic/structural fidelity.** Preserve every element, all
  metadata/headers/`identification`/`credits`/`defaults`, AND the DOCTYPE +
  declaration; allow the serializer to normalize whitespace/formatting. Not a
  byte-for-byte text splice.
- **Interaction = click-to-select + context menu.** Single click selects the
  chord/beat; clicking again (or a focused note) narrows to one note; right-click /
  long-press opens a context menu. Dragging no longer edits — it only scrolls.
- **Chords:** support *selecting/focusing* chords + notes; editing stays
  single-voice for now (no creating/moving notes *within* a chord this milestone).
- **Mobile:** desktop-first (mouse + right-click + keyboard); keep touch functional
  (double-tap, long-press) but don't over-invest.

---

## Phase 1 — Lossless round-trip (confirm + harden)

**Status today:** content fidelity is already strong by construction (DOM is the
source of truth; `identification`/`credits`/dynamics/lyrics/layout survive because
they're never re-serialized from a model; `text/xml` preserves whitespace). **Gap:**
`serializeDocument` (`editor/src/dom-edit.ts:84`) serializes only
`doc.documentElement` with a hardcoded `<?xml …?>` line, so it **drops the DOCTYPE**
(`<!DOCTYPE score-partwise PUBLIC …>`, present in most real MusicXML) and overrides
the original declaration.

**Changes:**
- `serializeDocument` / `parseDocument` (`editor/src/dom-edit.ts:72`, `:84`):
  serialize the **whole document** so the XML declaration + DOCTYPE round-trip.
  In the browser, `new XMLSerializer().serializeToString(doc)` includes the
  doctype; under the linkedom test shim, reconstruct `<!DOCTYPE …>` from
  `doc.doctype` (name/publicId/systemId) and prepend the declaration. Keep the
  `parsererror` guard.
- Add a **round-trip regression test** (`editor/src/dom-edit.test.ts`): parse a
  real-world fixture with `<!DOCTYPE>`, `identification`/`encoding`, `credit`,
  `defaults`, dynamics/slurs/lyrics → serialize → assert **semantic equality**
  (DOCTYPE present; declaration present; all metadata/credits/headers retained).
  Then apply a single-note edit and assert untouched siblings are byte-for-byte
  intact (extends the existing fidelity test at `dom-edit.test.ts:214`).
- Add 1–2 representative `.musicxml` fixtures (small MuseScore/Finale exports with
  full headers) under the editor test fixtures.

**Critical files:** `editor/src/dom-edit.ts`, `editor/src/dom-edit.test.ts`.

---

## Phase 2 — Selection model + click-based editing (replace drag)

Replace drag-to-edit with: **single click/tap = select the chord (all notes at that
beat); click again / double-click = focus one note; right-click / long-press =
context menu; arrow keys nudge a focused note.** Dragging the staff only scrolls.

**Selection state** (`editor/src/Editor.tsx`): replace the single
`selectedHandle: NoteHandle | null` with a selection model:
- `selection: { kind: "chord"; measureIndex; onsetBeat; handles: NoteHandle[] }
  | { kind: "note"; handle: NoteHandle } | null`.
- Reuse `pickNote` (`editor/src/hit-test.ts:140`) to resolve a click to a note;
  group its onset-mates into the chord via the parsed `ChordGroup`
  (`sheet-music-types.ts`) for chord selection.
- Highlight via the existing `noteHighlights` prop (`ScoreHighlight` per handle):
  chord = all notes tinted; focused note = stronger tint.

**Interaction seam** (`editor/src/components/EditableSheetMusic.tsx` +
`sheet-music/SheetMusicDisplay.tsx`): the renderer already exposes
`onStagePointerDown/Move/Up`, `setPointerCapture`, drag-to-scroll
(`SheetMusicDisplay.tsx:1260`) and a right-click `onSheetContextMenu` seam
(`:1339`) that the editor never wired up. Wire it:
- **Remove the drag-to-edit path** (`Editor.tsx:103` `handleGestureMove` →
  `moveNote`, and `dragRef`); pointer drags fall through to the existing container
  drag-to-scroll.
- Click vs. double-click discrimination (use `event.detail` / a short timer).
- Wire `onSheetContextMenu` → a new `ContextMenu` component.

**Context menu** (`editor/src/components/ContextMenu.tsx`, new): items depend on
selection — *Edit note…* (pitch/duration), *Move* (enter nudge mode), *Delete*.
Small self-contained popover positioned at `clientX/clientY`; desktop right-click +
mobile long-press. (Tie/Repeat items arrive with the deferred structural phase.)

**Move via arrow keys** (`Editor.tsx` keydown, extend the existing handler at
`:142`): with a focused note, ↑/↓ = pitch step (reuse diatonic math in
`hit-test.ts`), ←/→ = move by grid beat; each calls `moveNote`
(`dom-edit.ts:500`) + `commit()`. Delete/Backspace already wired.

Adding a note still works (click empty staff with a duration selected →
`addNote`, as today at `Editor.tsx:84`), now distinct from selection because a
click on an existing note selects rather than drags.

**Critical files:** `editor/src/Editor.tsx`,
`editor/src/components/EditableSheetMusic.tsx`,
`editor/src/components/ContextMenu.tsx` (new), `editor/src/hit-test.ts`,
`editor/src/sheet-music/SheetMusicDisplay.tsx` (additive context-menu wiring only).

---

## Phase 3 — Undo/redo + dirty indicator

PLAN.md already earmarks `doc.cloneNode(true)` snapshots (`editor/PLAN.md:209`).

- **History** (`editor/src/use-history.ts`, new, or inline in `Editor.tsx`):
  past/future stacks of cloned `Document`s. `commit()` pushes the *prior* doc to
  `past`, clears `future`, bumps `version`. Undo/redo swap `documentRef.current`
  to a clone and re-render. Coalesce rapid same-target edits (arrow-key nudges)
  into one history entry (debounce / edit-session id).
- **Dirty indicator:** capture the **baseline** on Import/New (the
  serialized/imported string). Dirty when `past.length > 0` since the baseline (or
  `serializeDocument(current) !== baselineXml`). Show a dot/asterisk in the toolbar
  near Import/Export; reset baseline on Import and on Export.
- **Keyboard:** Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z (and Ctrl+Y), added to the keydown
  handler. Undo/redo toolbar buttons disabled when stacks are empty.

**Critical files:** `editor/src/Editor.tsx`, `editor/src/use-history.ts` (new),
test `editor/src/use-history.test.ts`.

---

## Sequencing

1. **Phase 1** (fidelity) — small, unblocks trusting the editor.
2. **Phase 2** (click editing) — the core UX shift; selection model underpins the rest.
3. **Phase 3** (undo/dirty) — cheap once edits are deliberate.

Each phase is a self-contained PR with its own tests; run `make pr-ready`
(format, lint, typecheck, build, unit-test) before each commit.

---

## Verification

- **Round-trip:** `make unit-test` runs the new `dom-edit.test.ts` round-trip +
  fidelity assertions (DOCTYPE/identification/credits/dynamics preserved; edited
  file keeps untouched siblings byte-for-byte). Manually: import a real MuseScore
  export, export immediately, `diff` — only declaration/whitespace formatting may
  differ.
- **Editing UX:** `make dev` / `make up` (serves `editor/dist` on :3456 with
  COOP/COEP); confirm single-click selects the chord, a second click/double-click
  focuses one note, right-click opens the menu, arrow keys nudge a focused note,
  plain drag scrolls (no accidental edit), and clicking empty staff still adds.
- **Undo/dirty:** edit → dirty marker appears; Ctrl+Z reverts; redo re-applies;
  Export clears dirty; arrow-key nudges coalesce into single undo steps.
- Consider a Playwright editor spec (currently only OMR has integration tests) for
  the click-select + context-menu flow.

---

## Deferred to the next planning round (out of scope here)

- **Audio playback** — built-in Web Audio synth (no assets) driven by the parsed
  `ParsedScore`, feeding the renderer's existing live-beat cursor + scroll-lock
  (`getLiveBeat()`); play whole piece or a selected region.
- **Structural edits** — ties (`addTie` writing `<tie>`/`<tied>` on equal-pitch
  selections), repeats (`setRepeat` writing `<barline><repeat>` + drawing repeat
  barlines, currently unrendered per `PLAN.md:27`), multi-measure selection.
  Beams are already automatic in rendering (`groupBeamableEvents`).
- **Chord editing** — creating/moving notes within a chord (selection already
  supported in Phase 2).
