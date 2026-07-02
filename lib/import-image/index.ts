/**
 * Public API of the import-image OMR pipeline.
 *
 * This is the single entry point the editor (and any other consumer) uses to
 * turn a PDF or raster image of printed sheet music into MusicXML. Everything
 * runs locally in the browser: decoding happens on the main thread (pdf.js /
 * canvas are DOM-bound), and all inference runs in the OMR worker.
 *
 * The heavy lifting — segmentation, staff detection, TrOMR transcription — lives
 * behind `createOmrClient`, which spins up `omr.worker.js`. The build copies that
 * worker bundle, the ORT WASM assets, and the pdf.js worker to the site root, and
 * the page must be cross-origin isolated (COOP/COEP) for ORT's threaded WASM
 * backend; see the root build script and netlify.toml.
 */
import { buildScore } from "./lib/assembly/musicxml-builder";
import {
  mapSystemsToRegions,
  type ReviewPageInput,
  type ReviewRegion,
  type ReviewSystem,
} from "./lib/assembly/review-map";
import { groupSystems } from "./lib/staves/system-grouping";
import type { ScoreSystem } from "./lib/types";
import { decodeFilePages, isPdf } from "./src/input/decode";
import { rgbaImageToPngBlob } from "./src/input/encode";
import { createOmrClient } from "./src/worker/omr-client";
import type {
  BackendChoice,
  ProgressUpdate,
  StaffDetectionMode,
} from "./src/worker/protocol";

export { isPdf };
export type {
  BackendChoice,
  ProgressUpdate,
  ReviewRegion,
  ReviewSystem,
  StaffDetectionMode,
};

/** One decoded page, snapshotted for the import-review panel. */
export interface ImportReviewPage {
  /** Full-resolution page dimensions, the space {@link ReviewSystem} regions use. */
  width: number;
  height: number;
  /** The page raster as a compressed PNG. */
  image: Blob;
}

/**
 * Everything the editor's import-review ("cleanup") mode needs to show the
 * source image beside the recovered notation: each decoded page as a PNG, and
 * each recognized system's page region paired with the measure range it
 * produced in the returned MusicXML.
 */
export interface ImportReview {
  pages: ImportReviewPage[];
  systems: ReviewSystem[];
}

/** The outcome of recognizing one file. */
export interface ImageImportResult {
  /** The recovered MusicXML; empty string when nothing was recognized. */
  musicXml: string;
  /** Source-image review data; null when nothing was recognized. */
  review: ImportReview | null;
}

export interface ImageImporterOptions {
  /** Inference provider; "auto" (default) picks WebGPU when an adapter works. */
  backend?: BackendChoice;
  /**
   * How to locate stafflines; "classical" (default) is the fast, weight-free
   * Otsu + run-length path for born-digital scores, falling back to the model
   * when it finds no staves. "model" always uses the oemer staff mask.
   */
  staffDetection?: StaffDetectionMode;
}

/**
 * A reusable importer. Creating it loads the inference backend (and, on first
 * import, the model weights) once and keeps the worker alive across imports, so
 * prefer this over {@link imageToMusicXml} when importing more than one file.
 */
export interface ImageImporter {
  /** Inference provider the worker resolved (e.g. "webgpu" | "wasm"). */
  readonly provider: string;
  /**
   * Recognize one PDF/image file, returning the recovered MusicXML alongside
   * the review data tying its measures back to the source page images.
   */
  importFile(
    file: File,
    onProgress?: (update: ProgressUpdate) => void,
  ): Promise<ImageImportResult>;
  /** Terminate the underlying worker. */
  dispose(): void;
}

/**
 * Create a reusable {@link ImageImporter}. Resolves once the worker has reported
 * its inference provider, so the caller can show it before the first import.
 */
export async function createImageImporter(
  options: ImageImporterOptions = {},
): Promise<ImageImporter> {
  const client = await createOmrClient({
    backend: options.backend ?? "auto",
    staffDetection: options.staffDetection ?? "classical",
  });
  return {
    provider: client.provider,
    async importFile(file, onProgress) {
      // Decode on the main thread (pdf.js / createImageBitmap are DOM-bound),
      // then hand each full-resolution page raster to the worker in turn. A
      // multi-page PDF yields one raster per page; a raster image yields one.
      const pages = await decodeFilePages(file);
      // Each page contributes its systems (a treble-over-bass pair becomes one
      // grand-staff system) in reading order; concatenating across pages gives
      // the part's full timeline.
      const systems: ScoreSystem[] = [];
      const reviewPages: ImportReviewPage[] = [];
      const reviewInputs: ReviewPageInput[] = [];
      let recognizedNotes = 0;
      for (let page = 0; page < pages.length; page++) {
        const raster = pages[page];
        const pageWidth = raster.width;
        const pageHeight = raster.height;
        // Snapshot the page for the review panel before recognition: process()
        // transfers the raster's pixel buffer to the worker, detaching it here.
        const pageImage = await rgbaImageToPngBlob(raster);
        const result = await client.process(raster, (update) => {
          onProgress?.(
            pages.length > 1
              ? { ...update, page, pageCount: pages.length }
              : update,
          );
        });
        const pageSystems = groupSystems(result.transcriptions, result.braces);
        systems.push(...pageSystems);
        for (const transcription of result.transcriptions) {
          recognizedNotes += transcription.notes.length;
        }
        reviewPages.push({ width: pageWidth, height: pageHeight, image: pageImage });
        // Staff geometry comes back in the worker's detection space (the
        // segmentation-resolution image, whose dimensions the masks carry);
        // scale its coordinates up into the full-resolution page.
        reviewInputs.push({
          systems: pageSystems,
          staves: result.staves.staves,
          scaleX: pageWidth / result.masks.width,
          scaleY: pageHeight / result.masks.height,
          pageWidth,
          pageHeight,
        });
      }
      // Preserve the worker's empty-result contract (nothing recognized) so
      // callers can tell a failed import from a one-rest document.
      if (recognizedNotes === 0) {
        return { musicXml: "", review: null };
      }
      return {
        musicXml: buildScore(systems),
        review: {
          pages: reviewPages,
          systems: mapSystemsToRegions(reviewInputs),
        },
      };
    },
    dispose() {
      client.dispose();
    },
  };
}

/**
 * One-shot convenience: recognize a single file and return its MusicXML, tearing
 * the worker down afterward. For repeated imports use {@link createImageImporter}
 * so the models load only once.
 */
export async function imageToMusicXml(
  file: File,
  options: ImageImporterOptions & {
    onProgress?: (update: ProgressUpdate) => void;
  } = {},
): Promise<string> {
  const importer = await createImageImporter({
    backend: options.backend,
    staffDetection: options.staffDetection,
  });
  try {
    const result = await importer.importFile(file, options.onProgress);
    return result.musicXml;
  } finally {
    importer.dispose();
  }
}
