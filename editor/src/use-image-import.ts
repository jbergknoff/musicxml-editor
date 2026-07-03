// Lazily-created bridge to the OMR pipeline (lib/import-image): turns a dropped
// PDF/image file into MusicXML in the worker, exposing a small busy/status/error
// surface for the toolbar. The importer (and its worker + model weights) is
// created on first use and reused for subsequent imports.

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  createImageImporter,
  type ImageImporter,
  type ImageImporterOptions,
  type ImageImportResult,
  isPdf,
  type ProgressUpdate,
} from "../../lib/import-image/index";

/** Recognized image extensions, alongside PDF, that route through the OMR pipeline. */
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"];

/** Whether a file should be recognized via OMR rather than parsed as MusicXML. */
export function isImportableImage(file: File): boolean {
  if (isPdf(file)) {
    return true;
  }
  if (file.type.startsWith("image/")) {
    return true;
  }
  const name = file.name.toLowerCase();
  return IMAGE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/** Human-readable status line for a worker progress update. */
function describeProgress(update: ProgressUpdate): string {
  // Prefix multi-page imports with the page being recognized.
  const prefix =
    update.pageCount !== undefined && update.pageCount > 1
      ? `Page ${(update.page ?? 0) + 1}/${update.pageCount}: `
      : "";
  switch (update.phase) {
    case "loading-models": {
      return update.detail ? `Loading ${update.detail}…` : "Loading models…";
    }
    case "segmenting": {
      return `${prefix}Segmenting… ${Math.round(update.fraction * 100)}%`;
    }
    case "detecting-staves": {
      return `${prefix}Detecting staves…`;
    }
    case "transcribing": {
      return `${prefix}Transcribing… ${Math.round(update.fraction * 100)}%`;
    }
  }
}

export interface ImageImportState {
  busy: boolean;
  status: string | null;
  error: string | null;
  /**
   * Recognize a file and return its MusicXML plus the source-image review
   * data for the cleanup panel, or null on failure. `options` picks the
   * inference backend and staff-detection mode; changing either from the
   * previous call tears down and recreates the worker.
   */
  importImage(
    file: File,
    options?: ImageImporterOptions,
  ): Promise<ImageImportResult | null>;
}

/** Keys of {@link ImageImporterOptions} that require a fresh worker when changed. */
function sameConfig(a: ImageImporterOptions, b: ImageImporterOptions): boolean {
  return (
    (a.backend ?? "auto") === (b.backend ?? "auto") &&
    (a.staffDetection ?? "classical") === (b.staffDetection ?? "classical")
  );
}

export function useImageImport(): ImageImportState {
  // The importer plus the options it was created with, so a config change
  // (backend/staff detection) tears it down and starts a fresh worker rather
  // than silently reusing the old one.
  const importerRef = useRef<{
    promise: Promise<ImageImporter>;
    options: ImageImporterOptions;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Tear the worker down when the editor unmounts.
  useEffect(() => {
    return () => {
      importerRef.current?.promise.then((importer) => importer.dispose());
    };
  }, []);

  const importImage = useCallback(
    async (
      file: File,
      options: ImageImporterOptions = {},
    ): Promise<ImageImportResult | null> => {
      setBusy(true);
      setError(null);
      setStatus(`Decoding ${file.name}…`);
      try {
        if (
          importerRef.current !== null &&
          !sameConfig(importerRef.current.options, options)
        ) {
          importerRef.current.promise.then((importer) => importer.dispose());
          importerRef.current = null;
        }
        if (importerRef.current === null) {
          importerRef.current = {
            promise: createImageImporter(options),
            options,
          };
        }
        const importer = await importerRef.current.promise;
        const result = await importer.importFile(file, (update) => {
          setStatus(describeProgress(update));
        });
        if (result.musicXml === "") {
          setError("No staves were recognized in that file.");
          return null;
        }
        return result;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        return null;
      } finally {
        setBusy(false);
        setStatus(null);
      }
    },
    [],
  );

  return { busy, status, error, importImage };
}
