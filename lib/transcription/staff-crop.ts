/**
 * Extracts a raster strip for one detected staff from the full-page image and
 * converts it to the float32 grayscale format TrOMR expects.
 */
import type { RgbaImage, Staff } from "../types";

/**
 * The target height TrOMR was trained at. The staff strip is scaled to this
 * height (preserving aspect ratio) before being fed to the model.
 */
export const TROMR_INPUT_HEIGHT = 128;

/**
 * Crop the bounding band for one staff from `image`, adding vertical padding
 * proportional to the staff's unit size so ledger-line notes above and below
 * the staff are included.
 */
export function cropStaff(image: RgbaImage, staff: Staff): RgbaImage {
  const padding = Math.round(staff.unitSize * 2.5);
  const top = Math.max(0, Math.floor(staff.lines[0]) - padding);
  const bottom = Math.min(
    image.height - 1,
    Math.ceil(staff.lines[staff.lines.length - 1]) + padding,
  );
  const left = Math.max(0, staff.left);
  const right = Math.min(image.width - 1, staff.right);

  const width = right - left + 1;
  const height = bottom - top + 1;
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = ((top + y) * image.width + (left + x)) * 4;
      const destination = (y * width + x) * 4;
      data[destination] = image.data[source];
      data[destination + 1] = image.data[source + 1];
      data[destination + 2] = image.data[source + 2];
      data[destination + 3] = image.data[source + 3];
    }
  }
  return { data, width, height };
}

/**
 * Resize an RGBA image to the given target height using bilinear interpolation,
 * scaling width proportionally. Returns a new RgbaImage.
 */
function resizeToHeight(image: RgbaImage, targetHeight: number): RgbaImage {
  const scale = targetHeight / image.height;
  const targetWidth = Math.max(1, Math.round(image.width * scale));
  const data = new Uint8ClampedArray(targetWidth * targetHeight * 4);

  for (let y = 0; y < targetHeight; y++) {
    const sourceY = y / scale;
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(y0 + 1, image.height - 1);
    const yFraction = sourceY - y0;

    for (let x = 0; x < targetWidth; x++) {
      const sourceX = x / scale;
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(x0 + 1, image.width - 1);
      const xFraction = sourceX - x0;

      for (let channel = 0; channel < 4; channel++) {
        const top0 = image.data[(y0 * image.width + x0) * 4 + channel];
        const top1 = image.data[(y0 * image.width + x1) * 4 + channel];
        const bottom0 = image.data[(y1 * image.width + x0) * 4 + channel];
        const bottom1 = image.data[(y1 * image.width + x1) * 4 + channel];
        const value =
          top0 * (1 - xFraction) * (1 - yFraction) +
          top1 * xFraction * (1 - yFraction) +
          bottom0 * (1 - xFraction) * yFraction +
          bottom1 * xFraction * yFraction;
        data[(y * targetWidth + x) * 4 + channel] = Math.round(value);
      }
    }
  }
  return { data, width: targetWidth, height: targetHeight };
}

/**
 * Prepare a cropped staff strip for TrOMR inference: resize to `targetHeight`
 * preserving aspect ratio, convert to grayscale, and normalize to [0, 1].
 *
 * Returns a `Float32Array` of length `targetHeight × width` in row-major
 * order (the NCHW channel dimension is 1, so the layout is `[H, W]`), plus
 * the width so the caller can build the [1, 1, H, W] tensor.
 */
export function prepareStaffTensor(
  image: RgbaImage,
  targetHeight = TROMR_INPUT_HEIGHT,
): { data: Float32Array; width: number } {
  const resized = resizeToHeight(image, targetHeight);
  const { width, height } = resized;
  const data = new Float32Array(height * width);

  for (let index = 0; index < height * width; index++) {
    const r = resized.data[index * 4];
    const g = resized.data[index * 4 + 1];
    const b = resized.data[index * 4 + 2];
    // ITU-R BT.601 luma; divide by 255 to normalize to [0, 1].
    data[index] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }
  return { data, width };
}
