/**
 * The main-thread half of the capture worker.
 *
 * Failure here is never fatal: the drawing is already on screen and the viewer
 * has what they came for. A capture that does not happen costs a critique round,
 * nothing more, so every path returns a `ValidationResult` rather than throwing.
 */
import { fail, makeError, ok, type ValidationResult } from "@sketchmind/shared-types";

const PACKAGE = "@sketchmind/studio";

export interface CapturedImage {
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface EncodeCaptureOptions {
  readonly worker: Worker;
  /** Produces the bitmap to encode. Injected so tests need no real canvas. */
  readonly toBitmap: () => Promise<ImageBitmap>;
}

export async function encodeCapture(
  options: EncodeCaptureOptions,
): Promise<ValidationResult<CapturedImage>> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await options.toBitmap();
  } catch (cause) {
    return fail([
      makeError({
        code: "CAPTURE_FAILED",
        message: `The canvas could not be captured: ${(cause as Error).message}`,
        package: PACKAGE,
        stage: "render",
        recoverable: true,
      }),
    ]);
  }

  return new Promise((resolve) => {
    options.worker.onmessage = (event: MessageEvent) => {
      const reply = event.data as { error?: string; mimeType?: string; width?: number; height?: number; data?: ArrayBuffer };
      if (reply.error || !reply.data) {
        resolve(
          fail([
            makeError({
              code: "CAPTURE_FAILED",
              message: reply.error ?? "The capture worker returned no image.",
              package: PACKAGE,
              stage: "render",
              recoverable: true,
            }),
          ]),
        );
        return;
      }

      resolve(
        ok({
          mimeType: reply.mimeType ?? "image/png",
          width: reply.width ?? 0,
          height: reply.height ?? 0,
          data: new Uint8Array(reply.data),
        }),
      );
    };

    options.worker.postMessage({ bitmap }, [bitmap as unknown as Transferable]);
  });
}
