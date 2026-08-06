/**
 * The main-thread half of the capture worker.
 *
 * Failure here is never fatal: the drawing is already on screen and the viewer
 * has what they came for. A capture that does not happen costs a critique round,
 * nothing more, so every path returns a `ValidationResult` rather than throwing.
 */
import type { CapturedImage } from "@sketchmind/renderer-core";
import { fail as failResult, makeError, ok, type ValidationResult } from "@sketchmind/shared-types";

const PACKAGE = "@sketchmind/studio";

// Structurally identical to the worker's own reply shape; re-exported rather
// than redeclared so `bootstrap.ts` doesn't need to cast between two
// independently-declared but identical interfaces.
export type { CapturedImage };

export interface EncodeCaptureOptions {
  readonly worker: Worker;
  /** Produces the bitmap to encode. Injected so tests need no real canvas. */
  readonly toBitmap: () => Promise<ImageBitmap>;
}

/**
 * Last-resort safety net. `worker.onerror` covers construction/script
 * failures and `capture.worker.ts`'s own try/catch covers everything inside
 * its handler, but neither can prove a message will *always* arrive -- a
 * timeout is the only way to guarantee this promise settles no matter what
 * goes wrong on the worker thread.
 */
const CAPTURE_TIMEOUT_MS = 10_000;

export async function encodeCapture(
  options: EncodeCaptureOptions,
): Promise<ValidationResult<CapturedImage>> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await options.toBitmap();
  } catch (cause) {
    return failResult([
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
    let settled = false;
    const finish = (result: ValidationResult<CapturedImage>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = (message: string) =>
      finish(
        failResult([
          makeError({
            code: "CAPTURE_FAILED",
            message,
            package: PACKAGE,
            stage: "render",
            recoverable: true,
          }),
        ]),
      );

    const timer = setTimeout(
      () => fail("The capture worker did not respond in time."),
      CAPTURE_TIMEOUT_MS,
    );

    options.worker.onmessage = (event: MessageEvent) => {
      const reply = event.data as { error?: string; mimeType?: string; width?: number; height?: number; data?: ArrayBuffer };
      if (reply.error || !reply.data) {
        fail(reply.error ?? "The capture worker returned no image.");
        return;
      }

      finish(
        ok({
          mimeType: reply.mimeType ?? "image/png",
          width: reply.width ?? 0,
          height: reply.height ?? 0,
          data: new Uint8Array(reply.data),
        }),
      );
    };

    // Covers what the worker's own try/catch cannot: construction failures,
    // an uncaught error before the handler runs, or the script failing to
    // load at all -- none of those post a message, so without this the
    // returned promise would hang forever (contradicts this module's own
    // "failure here is never fatal" contract).
    options.worker.onerror = (event) => {
      const message = event instanceof ErrorEvent ? event.message : "The capture worker crashed.";
      fail(message);
    };

    options.worker.postMessage({ bitmap }, [bitmap as unknown as Transferable]);
  });
}
