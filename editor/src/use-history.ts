// Undo/redo + dirty tracking for the editor's live document.
//
// The document is still the source of truth and is mutated *in place* by the
// dom-edit ops; this hook layers a snapshot history over those mutations. It
// keeps a clone of the last committed state so that, when `commit()` is called
// after an edit, the *prior* state can be pushed onto the undo stack (the live
// document has already changed by then). Undo/redo swap the live document for a
// clone and bump a version counter so the editor re-serializes and re-renders.
//
// Callers with session state that should undo/redo in lockstep with the
// document (e.g. the editor's OMR review data) can thread it through as
// `Extra`: `setExtra` applies immediately (for reactivity) while `commit`
// snapshots whatever `Extra` value is current at commit time, alongside the
// document.
//
// Dirty state is a string comparison against a baseline captured on load
// (Import / New) and reset on save (Export): see `baselineXml` / `markSaved`.

import { useCallback, useRef, useState } from "preact/hooks";
import { serializeDocument } from "./dom-edit";

// Successive edits sharing a coalesce key within this window collapse into one
// undo entry (e.g. a burst of arrow-key nudges).
const COALESCE_WINDOW_MS = 500;

interface Snapshot<Extra> {
  doc: Document;
  extra: Extra;
}

export interface History<Extra = undefined> {
  /** The live document. Mutate `.current` in place, then call `commit`. */
  documentRef: { current: Document };
  /** Bumped on every state change; drive re-serialize / re-render off this. */
  version: number;
  /** Record the in-place edit just applied to `documentRef.current`. Pass a
   *  `coalesce` key to merge a rapid run of edits into a single undo entry. */
  commit: (options?: { coalesce?: string }) => void;
  undo: () => void;
  redo: () => void;
  /** Load a new document (Import / New): clears history and resets the dirty
   *  baseline to the new document, along with `extra`. */
  reset: (doc: Document, extra: Extra) => void;
  /** Reset the dirty baseline to the current document (e.g. after Export). */
  markSaved: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Serialized baseline the editor compares against to decide if it's dirty. */
  baselineXml: string;
  /** The companion state threaded through undo/redo alongside the document. */
  extra: Extra;
  /** Updates `extra` immediately (for reactivity); undoable once `commit` runs. */
  setExtra: (updater: Extra | ((prev: Extra) => Extra)) => void;
}

function clone(doc: Document): Document {
  return doc.cloneNode(true) as Document;
}

export function useHistory<Extra = undefined>(
  createInitial: () => Document,
  createInitialExtra: () => Extra = () => undefined as Extra,
): History<Extra> {
  const documentRef = useRef<Document | null>(null);
  if (documentRef.current === null) {
    documentRef.current = createInitial();
  }
  const extraRef = useRef<Extra>(createInitialExtra());
  // A pristine clone of the current committed state. `commit` pushes this (the
  // pre-edit snapshot) before refreshing it from the just-edited document.
  const committedRef = useRef<Document>(clone(documentRef.current));
  const committedExtraRef = useRef<Extra>(extraRef.current);
  const pastRef = useRef<Snapshot<Extra>[]>([]);
  const futureRef = useRef<Snapshot<Extra>[]>([]);
  const lastCommitRef = useRef<{ key: string; time: number } | null>(null);
  const baselineRef = useRef<string>(serializeDocument(documentRef.current));
  const [version, setVersion] = useState(0);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const setExtra = useCallback(
    (updater: Extra | ((prev: Extra) => Extra)) => {
      extraRef.current =
        typeof updater === "function"
          ? (updater as (prev: Extra) => Extra)(extraRef.current)
          : updater;
      bump();
    },
    [bump],
  );

  const commit = useCallback(
    (options?: { coalesce?: string }) => {
      const key = options?.coalesce;
      const now = Date.now();
      const coalesce =
        key !== undefined &&
        lastCommitRef.current?.key === key &&
        now - lastCommitRef.current.time < COALESCE_WINDOW_MS;
      if (!coalesce) {
        // The previous committed snapshot becomes an undo step.
        pastRef.current.push({
          doc: committedRef.current,
          extra: committedExtraRef.current,
        });
      }
      futureRef.current = [];
      committedRef.current = clone(documentRef.current as Document);
      committedExtraRef.current = extraRef.current;
      lastCommitRef.current = key !== undefined ? { key, time: now } : null;
      bump();
    },
    [bump],
  );

  const undo = useCallback(() => {
    const previous = pastRef.current.pop();
    if (!previous) {
      return;
    }
    // The current state moves to the redo stack; restore the popped one.
    futureRef.current.push({
      doc: committedRef.current,
      extra: committedExtraRef.current,
    });
    documentRef.current = previous.doc;
    committedRef.current = clone(previous.doc);
    extraRef.current = previous.extra;
    committedExtraRef.current = previous.extra;
    lastCommitRef.current = null;
    bump();
  }, [bump]);

  const redo = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next) {
      return;
    }
    pastRef.current.push({
      doc: committedRef.current,
      extra: committedExtraRef.current,
    });
    documentRef.current = next.doc;
    committedRef.current = clone(next.doc);
    extraRef.current = next.extra;
    committedExtraRef.current = next.extra;
    lastCommitRef.current = null;
    bump();
  }, [bump]);

  const reset = useCallback(
    (doc: Document, extra: Extra) => {
      documentRef.current = doc;
      committedRef.current = clone(doc);
      extraRef.current = extra;
      committedExtraRef.current = extra;
      pastRef.current = [];
      futureRef.current = [];
      lastCommitRef.current = null;
      baselineRef.current = serializeDocument(doc);
      bump();
    },
    [bump],
  );

  const markSaved = useCallback(() => {
    baselineRef.current = serializeDocument(documentRef.current as Document);
    bump();
  }, [bump]);

  return {
    documentRef: documentRef as { current: Document },
    version,
    commit,
    undo,
    redo,
    reset,
    markSaved,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
    baselineXml: baselineRef.current,
    extra: extraRef.current,
    setExtra,
  };
}
