// Persists OMR import-review data (per-system source crops + flagged notes)
// into the exported MusicXML, so a document reviewed in one session can be
// reopened later with its review panel restored. Optional — driven by the
// "Embed review data" checkbox in ImageImportDialog — since it embeds a base64
// PNG crop per recognized system and can noticeably inflate file size.
//
// Storage: a single `<miscellaneous-field name="import-review-data">` (see
// metadata.ts) holding JSON. Each system is stored already cropped to its
// source region (rather than the full page + a region rect, as the live,
// in-session `ImportReview` uses) — that's strictly less pixel data than
// sharing whole pages, and it lets a reloaded review reuse `ImportReview`/
// `ImportReviewPanel` unmodified: each stored system becomes its own
// single-system "page" with a region covering the whole crop.

import type {
  ImportReview,
  ImportReviewPage,
  ReviewFlaggedNote,
  ReviewRegion,
} from "../../lib/import-image/index";
import {
  IMPORT_REVIEW_FIELD_NAME,
  readMiscField,
  writeMiscField,
} from "./metadata";

const FORMAT_VERSION = 1;

interface EmbeddedReviewSystem {
  firstMeasure: number;
  measureCount: number;
  width: number;
  height: number;
  /** Base64-encoded PNG, already cropped to this system's region. */
  image: string;
}

export interface EmbeddedReviewPayload {
  version: number;
  systems: EmbeddedReviewSystem[];
  flaggedNotes: ReviewFlaggedNote[];
}

function isEmbeddedReviewPayload(
  value: unknown,
): value is EmbeddedReviewPayload {
  const candidate = value as EmbeddedReviewPayload | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    Array.isArray(candidate.systems) &&
    Array.isArray(candidate.flaggedNotes)
  );
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000; // avoid a huge argument list to String.fromCharCode
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

function base64ToBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: "image/png" });
}

async function cropSystem(
  page: ImportReviewPage,
  region: ReviewRegion,
): Promise<{ width: number; height: number; image: string }> {
  const width = Math.max(1, Math.round(region.right - region.left));
  const height = Math.max(1, Math.round(region.bottom - region.top));
  const bitmap = await createImageBitmap(page.image);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("2D canvas context unavailable");
  }
  context.drawImage(
    bitmap,
    region.left,
    region.top,
    width,
    height,
    0,
    0,
    width,
    height,
  );
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) {
        resolve(result);
      } else {
        reject(new Error("Failed to encode review crop as PNG"));
      }
    }, "image/png");
  });
  return { width, height, image: await blobToBase64(blob) };
}

/** Crop and base64-encode every reviewed system, ready to embed in a document. */
export async function buildEmbeddedReviewPayload(
  review: ImportReview,
): Promise<EmbeddedReviewPayload> {
  const systems: EmbeddedReviewSystem[] = [];
  for (const system of review.systems) {
    const page = review.pages[system.page];
    if (!page) {
      continue;
    }
    const crop = await cropSystem(page, system.region);
    systems.push({
      firstMeasure: system.firstMeasure,
      measureCount: system.measureCount,
      ...crop,
    });
  }
  return {
    version: FORMAT_VERSION,
    systems,
    flaggedNotes: [...review.flaggedNotes],
  };
}

/** Shift a payload's measure indices — for review data being appended after existing content. */
export function offsetEmbeddedReviewPayload(
  payload: EmbeddedReviewPayload,
  measureOffset: number,
): EmbeddedReviewPayload {
  if (measureOffset === 0) {
    return payload;
  }
  return {
    version: payload.version,
    systems: payload.systems.map((system) => ({
      ...system,
      firstMeasure: system.firstMeasure + measureOffset,
    })),
    flaggedNotes: payload.flaggedNotes.map((flagged) => ({
      ...flagged,
      measureIndex: flagged.measureIndex + measureOffset,
    })),
  };
}

function mergePayloads(
  prev: EmbeddedReviewPayload | null,
  next: EmbeddedReviewPayload,
): EmbeddedReviewPayload {
  return {
    version: FORMAT_VERSION,
    systems: [...(prev?.systems ?? []), ...next.systems],
    flaggedNotes: [...(prev?.flaggedNotes ?? []), ...next.flaggedNotes],
  };
}

function readEmbeddedReviewPayload(
  doc: Document,
): EmbeddedReviewPayload | null {
  const raw = readMiscField(doc, IMPORT_REVIEW_FIELD_NAME);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return isEmbeddedReviewPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Merge `payload` into whatever review data `doc` already carries and write
 * the result back, or (when `payload` is null) remove any embedded review
 * data. Mutates `doc` in place, matching the rest of this codebase's DOM-edit
 * functions.
 */
export function writeEmbeddedReview(
  doc: Document,
  payload: EmbeddedReviewPayload | null,
): void {
  if (payload === null) {
    writeMiscField(doc, IMPORT_REVIEW_FIELD_NAME, null);
    return;
  }
  const merged = mergePayloads(readEmbeddedReviewPayload(doc), payload);
  writeMiscField(doc, IMPORT_REVIEW_FIELD_NAME, JSON.stringify(merged));
}

/**
 * Overwrite the embedded payload's flagged-notes list in place — used when the
 * user dismisses a flag (or a structural edit drops one) so the export
 * actually reflects it; a merge (as `writeEmbeddedReview` does for appends)
 * would resurrect the ones just removed. No-op if `doc` carries no embedded
 * review data yet (nothing to reconcile until an import embeds one).
 */
export function writeEmbeddedReviewFlaggedNotes(
  doc: Document,
  flaggedNotes: ReviewFlaggedNote[],
): void {
  const existing = readEmbeddedReviewPayload(doc);
  if (!existing) {
    return;
  }
  writeMiscField(
    doc,
    IMPORT_REVIEW_FIELD_NAME,
    JSON.stringify({ ...existing, flaggedNotes: [...flaggedNotes] }),
  );
}

/** Reconstruct a live `ImportReview` (real image Blobs) from a document's embedded data, if any. */
export function readEmbeddedReview(doc: Document): ImportReview | null {
  const payload = readEmbeddedReviewPayload(doc);
  if (!payload || payload.systems.length === 0) {
    return null;
  }
  return {
    pages: payload.systems.map((system) => ({
      width: system.width,
      height: system.height,
      image: base64ToBlob(system.image),
    })),
    systems: payload.systems.map((system, index) => ({
      page: index,
      firstMeasure: system.firstMeasure,
      measureCount: system.measureCount,
      region: { top: 0, left: 0, right: system.width, bottom: system.height },
    })),
    flaggedNotes: [...payload.flaggedNotes],
  };
}
