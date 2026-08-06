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
import type { AgentTraceStep, CritiqueFinding, ValidationResult } from "@sketchmind/shared-types";
import type { CapturedImage } from "./captureClient.js";

export interface StartVisionAgentOptions {
  readonly sessionId: string;
  readonly request: string;
  readonly visionEnabled: boolean;
  readonly capture: () => Promise<ValidationResult<CapturedImage>>;
  readonly fetchImpl?: typeof fetch;
  readonly signal: AbortSignal;
  readonly apiBase?: string;
  /**
   * Where the client agent's own trace goes. Both loci are traced -- every
   * agent step is traced and streamed to the UI, a repo-wide invariant. The
   * server's steps arrive as `AgentStep` events on the SSE stream; the client's
   * never touch the wire, so this callback is their only route to the panel.
   */
  readonly onStep?: (step: AgentTraceStep) => void;
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
    ...(options.onStep ? { onStep: options.onStep } : {}),

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
      // Throw, never `return []`. An empty findings array is a verdict -- "the
      // drawing is fine" -- and the critique route's own contract is that "no
      // findings" and "critique never ran" must not look alike (see the file
      // header of `apps/api/src/routes/vision.ts`). A 503 (gate shut), 429
      // (rounds spent), 413 (too large), 400 (bad request) or 502 (upstream
      // down) collapsed into `[]` would tell the agent the board is clean.
      //
      // Nothing catches this locally on purpose: `agent-core`'s
      // `executeToolCall` already wraps every handler call and turns a throw
      // into a `TOOL_THREW` outcome the agent reads on its next step (AD-2), so
      // the failure becomes something it can reason about rather than something
      // it silently believes.
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `The critique service answered ${response.status}` +
            `${detail ? `: ${detail.slice(0, 500)}` : "."}`,
        );
      }
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
