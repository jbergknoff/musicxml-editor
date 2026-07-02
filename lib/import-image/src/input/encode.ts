import type { RgbaImage } from "../../lib/types";

/**
 * Encodes a decoded page raster into a compressed PNG blob, for the editor's
 * import-review panel. The raster's pixel buffer is *transferred* to the OMR
 * worker when recognition starts, so any copy the review UI needs must be
 * snapshotted first — and as a PNG rather than raw RGBA, since a full-resolution
 * page is tens of MB raw but mostly white ink-on-paper that PNG compresses well.
 *
 * Main-thread only (canvas is DOM-bound), like the decoders in `decode.ts`.
 */
export function rgbaImageToPngBlob(image: RgbaImage): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("Could not get a 2D canvas context");
  }
  // Copy the pixels: RgbaImage's buffer is typed over ArrayBufferLike (it may
  // arrive from a worker), while ImageData requires a plain ArrayBuffer.
  context.putImageData(
    new ImageData(
      new Uint8ClampedArray(image.data),
      image.width,
      image.height,
    ),
    0,
    0,
  );
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error("Could not encode the page image as PNG"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}
