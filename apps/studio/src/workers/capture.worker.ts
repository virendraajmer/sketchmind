/**
 * PNG encoding, off the main thread.
 *
 * This is the concrete performance decision of Phase 10. Encoding a full-board
 * canvas costs tens of milliseconds; doing it on the main thread drops frames in
 * the middle of playback, which is exactly when the user is watching. An
 * `OffscreenCanvas` transferred to a worker moves that cost out of the render
 * path entirely.
 *
 * The worker does no judgement and holds no state. It receives a bitmap and
 * returns bytes.
 *
 * Excluded from `tsconfig.json`'s type-checked set (see that file): the DOM lib
 * this app's tsconfig carries and the WebWorker lib this file's globals need
 * (`self.onmessage`, `OffscreenCanvas`'s worker-side members) declare the same
 * ambient names differently, and TS has no per-file lib override that reconciles
 * them without a second project. Vite's build does not type-check workers either
 * way, so nothing here goes unverified in practice.
 */
export interface CaptureRequest {
  readonly bitmap: ImageBitmap;
}

export interface CaptureReply {
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly data: ArrayBuffer;
}

self.onmessage = async (event: MessageEvent<CaptureRequest>): Promise<void> => {
  const { bitmap } = event.data;
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  if (!context) {
    self.postMessage({ error: "OffscreenCanvas 2d context unavailable" });
    return;
  }

  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  const blob = await canvas.convertToBlob({ type: "image/png" });
  const data = await blob.arrayBuffer();

  const reply: CaptureReply = {
    mimeType: "image/png",
    width: canvas.width,
    height: canvas.height,
    data,
  };
  self.postMessage(reply, [data]);
};
