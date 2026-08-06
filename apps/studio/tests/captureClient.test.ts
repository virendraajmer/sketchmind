import { describe, expect, it } from "vitest";
import { encodeCapture } from "../src/vision/captureClient.js";

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  postMessage(): void {
    queueMicrotask(() => {
      this.onmessage?.({
        data: { mimeType: "image/png", width: 4, height: 4, data: new Uint8Array([1, 2]).buffer },
      } as MessageEvent);
    });
  }
  terminate(): void {}
}

describe("encodeCapture", () => {
  it("returns the encoded image from the worker", async () => {
    const result = await encodeCapture({
      worker: new FakeWorker() as unknown as Worker,
      toBitmap: async () => ({ width: 4, height: 4, close() {} }) as unknown as ImageBitmap,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mimeType).toBe("image/png");
    expect(result.value.data).toBeInstanceOf(Uint8Array);
  });

  it("returns a validation failure when the bitmap cannot be produced", async () => {
    const result = await encodeCapture({
      worker: new FakeWorker() as unknown as Worker,
      toBitmap: async () => {
        throw new Error("no canvas");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("CAPTURE_FAILED");
  });
});
