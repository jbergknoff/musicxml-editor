// Covers the base64-blob-free parts of import-review-persistence.ts: writing,
// reading, merging, and offsetting embedded review payloads on a `Document`.
// `buildEmbeddedReviewPayload`'s canvas-based cropping needs a real browser
// (see `make editor-integration-test` for that path) and isn't exercised here.

import { describe, expect, test } from "bun:test";
import { createBlankDocument, serializeDocument } from "./dom-edit";
import {
  type EmbeddedReviewPayload,
  offsetEmbeddedReviewPayload,
  readEmbeddedReview,
  writeEmbeddedReview,
} from "./import-review-persistence";
import { readMetadata } from "./metadata";

function payload(
  systems: Array<{ firstMeasure: number; measureCount: number }>,
): EmbeddedReviewPayload {
  return {
    version: 1,
    systems: systems.map((system, index) => ({
      ...system,
      width: 10,
      height: 10,
      // Stands in for a real base64-encoded PNG crop.
      image: btoa(`fake-image-${index}`),
    })),
    flaggedNotes: [
      {
        measureIndex: systems[0]?.firstMeasure ?? 0,
        noteElementIndex: 0,
        confidence: 0.5,
      },
    ],
  };
}

describe("writeEmbeddedReview / readEmbeddedReview", () => {
  test("round-trips through serialize + reparse", () => {
    const doc = createBlankDocument();
    writeEmbeddedReview(doc, payload([{ firstMeasure: 0, measureCount: 2 }]));

    const reparsed = new DOMParser().parseFromString(
      serializeDocument(doc),
      "text/xml",
    );
    const review = readEmbeddedReview(reparsed);
    expect(review).not.toBeNull();
    expect(review?.systems).toEqual([
      {
        page: 0,
        firstMeasure: 0,
        measureCount: 2,
        region: { top: 0, left: 0, right: 10, bottom: 10 },
      },
    ]);
    expect(review?.pages.length).toBe(1);
    expect(review?.pages[0].image).toBeInstanceOf(Blob);
  });

  test("is hidden from the human-facing miscellaneous-field list", () => {
    const doc = createBlankDocument();
    writeEmbeddedReview(doc, payload([{ firstMeasure: 0, measureCount: 1 }]));
    expect(readMetadata(doc).miscellaneous).toEqual([]);
  });

  test("a second write merges with (rather than replaces) the first", () => {
    const doc = createBlankDocument();
    writeEmbeddedReview(doc, payload([{ firstMeasure: 0, measureCount: 2 }]));
    writeEmbeddedReview(doc, payload([{ firstMeasure: 2, measureCount: 3 }]));

    const review = readEmbeddedReview(doc);
    expect(review?.systems.map((s) => s.firstMeasure)).toEqual([0, 2]);
    expect(review?.flaggedNotes.map((f) => f.measureIndex)).toEqual([0, 2]);
  });

  test("writing null removes the embedded data", () => {
    const doc = createBlankDocument();
    writeEmbeddedReview(doc, payload([{ firstMeasure: 0, measureCount: 1 }]));
    writeEmbeddedReview(doc, null);
    expect(readEmbeddedReview(doc)).toBeNull();
  });

  test("readEmbeddedReview returns null for a document with no embedded data", () => {
    expect(readEmbeddedReview(createBlankDocument())).toBeNull();
  });
});

describe("offsetEmbeddedReviewPayload", () => {
  test("shifts every system's and flagged note's measure index", () => {
    const shifted = offsetEmbeddedReviewPayload(
      payload([
        { firstMeasure: 0, measureCount: 2 },
        { firstMeasure: 2, measureCount: 1 },
      ]),
      5,
    );
    expect(shifted.systems.map((s) => s.firstMeasure)).toEqual([5, 7]);
    expect(shifted.flaggedNotes.map((f) => f.measureIndex)).toEqual([5]);
  });

  test("is a no-op for a zero offset", () => {
    const original = payload([{ firstMeasure: 0, measureCount: 2 }]);
    expect(offsetEmbeddedReviewPayload(original, 0)).toBe(original);
  });
});
