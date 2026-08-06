/**
 * PNG decoding for the render acceptance tests.
 *
 * The exported bytes are decoded back into pixels rather than hashed, because
 * "the PNG contains all the drawn objects" is a claim about *pixels in specific
 * places* -- a hash can only say the file changed, which is the least useful
 * thing a renderer test can tell you.
 *
 * `canvas` is the same library Konva rasterises through under Node (Phase 8 D-9)
 * and is a devDependency of this test package only.
 */
import { createCanvas, loadImage } from "canvas";

export interface Bitmap {
  readonly width: number;
  readonly height: number;
  /** RGBA, four bytes per pixel, row-major. */
  readonly data: Uint8ClampedArray;
}

export async function decodePNG(bytes: Uint8Array): Promise<Bitmap> {
  const image = await loadImage(Buffer.from(bytes));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  return { width: image.width, height: image.height, data };
}

export function pixelAt(bitmap: Bitmap, x: number, y: number): [number, number, number, number] {
  const index = (Math.round(y) * bitmap.width + Math.round(x)) * 4;
  return [
    bitmap.data[index] ?? 0,
    bitmap.data[index + 1] ?? 0,
    bitmap.data[index + 2] ?? 0,
    bitmap.data[index + 3] ?? 0,
  ];
}

/** Ink is anything meaningfully darker than the white background. */
export function isInk(bitmap: Bitmap, x: number, y: number, threshold = 200): boolean {
  const [r, g, b, a] = pixelAt(bitmap, x, y);
  if (a < 32) return false;
  return r < threshold || g < threshold || b < threshold;
}

export function inkCount(bitmap: Bitmap, threshold = 200): number {
  let count = 0;
  for (let i = 0; i < bitmap.data.length; i += 4) {
    if (bitmap.data[i + 3]! < 32) continue;
    if (bitmap.data[i]! < threshold || bitmap.data[i + 1]! < threshold || bitmap.data[i + 2]! < threshold) {
      count += 1;
    }
  }
  return count;
}

export function inkInRect(
  bitmap: Bitmap,
  rect: { x: number; y: number; width: number; height: number },
): number {
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(bitmap.width - 1, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(bitmap.height - 1, Math.ceil(rect.y + rect.height));
  let count = 0;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (isInk(bitmap, x, y)) count += 1;
    }
  }
  return count;
}

export interface PixelDiff {
  readonly comparable: boolean;
  readonly differing: number;
  readonly total: number;
  readonly ratio: number;
}

/**
 * Per-channel comparison with a tolerance.
 *
 * `channelTolerance` absorbs anti-aliasing differences between machines without
 * absorbing a stroke drawn in the wrong place: a misplaced line moves whole
 * pixels from white to near-black, which no plausible tolerance hides.
 */
export function diffBitmaps(a: Bitmap, b: Bitmap, channelTolerance = 12): PixelDiff {
  if (a.width !== b.width || a.height !== b.height) {
    return { comparable: false, differing: 0, total: 0, ratio: 1 };
  }
  let differing = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let channel = 0; channel < 4; channel += 1) {
      if (Math.abs(a.data[i + channel]! - b.data[i + channel]!) > channelTolerance) {
        differing += 1;
        break;
      }
    }
  }
  const total = a.width * a.height;
  return { comparable: true, differing, total, ratio: total === 0 ? 1 : differing / total };
}
