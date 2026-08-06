/**
 * Builds the client agent and its transport, and starts it.
 *
 * Everything vendor-shaped stays server-side: the agent's model turns go to
 * `/api/agent/llm` through a proxy provider that is pure `fetch`, so this bundle
 * carries no SDK and no key. `pnpm check:bundle` asserts that rather than
 * trusting it.
 */
import { runVisionAgent } from "@sketchmind/agent-vision";
import { createProxyProvider } from "@sketchmind/llm-provider";
import type { CritiqueFinding, ValidationResult } from "@sketchmind/shared-types";
import type { CapturedImage } from "./captureClient.js";

export interface StartVisionAgentOptions {
  readonly sessionId: string;
  readonly request: string;
  readonly visionEnabled: boolean;
  readonly capture: () => Promise<ValidationResult<CapturedImage>>;
  readonly fetchImpl?: typeof fetch;
  readonly signal: AbortSignal;
  readonly apiBase?: string;
}

/**
 * Chunked, because `String.fromCharCode(...bytes)` spreads every byte onto the
 * call stack and a real board PNG is hundreds of kilobytes -- which overflows it.
 */
function toBase64(data: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < data.length; i += CHUNK) {
    binary += String.fromCharCode(...data.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function startVisionAgent(options: StartVisionAgentOptions): Promise<void> {
  if (!options.visionEnabled) return;

  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = options.apiBase ?? "";

  await runVisionAgent({
    sessionId: options.sessionId,
    request: options.request,
    provider: createProxyProvider({ endpoint: `${base}/api/agent/llm`, fetchImpl: doFetch }),
    visionEnabled: true,
    signal: options.signal,
    capture: options.capture,

    critique: async (image) => {
      const response = await doFetch(`${base}/api/agent/vision-critique`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: options.sessionId,
          mimeType: image.mimeType,
          width: image.width,
          height: image.height,
          base64: toBase64(image.data),
        }),
        signal: options.signal,
      });
      if (!response.ok) return [];
      return ((await response.json()) as { findings: CritiqueFinding[] }).findings;
    },

    report: async (findings) => {
      await doFetch(`${base}/api/sessions/${options.sessionId}/findings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ findings }),
        signal: options.signal,
      });
    },
  });
}
