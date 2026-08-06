/**
 * An `LLMProvider` backed by SketchMind's own proxy route rather than a vendor.
 *
 * This is what lets a browser run the same `agent-core` loop the server runs
 * without a key or an SDK reaching it: `completeWithTools` becomes one POST to
 * `/api/agent/llm`, and the credentials stay in the server process.
 *
 * It lives beside `fake.ts` in this package for the same reason `fake.ts` does
 * -- it imports no provider SDK, only `fetch`, so the lint rule that keeps
 * vendors out of the browser bundle has nothing to object to.
 *
 * Its capabilities are honest about the proxy's scope, which is deliberately one
 * method. In particular `vision: false`: images do not travel this route, and a
 * client agent that believed otherwise would build a request the server would
 * reject.
 */
import { ProviderErrorCode, classifyFailure, providerError } from "./internal/errors.js";
import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResponse,
  LLMCapabilities,
  LLMProvider,
  LLMProviderError,
  StructuredRequest,
  StructuredResponse,
  ToolRequest,
  ToolResponse,
  VisionRequest,
} from "./types.js";
import type { ZodType, z } from "zod";

const PACKAGE = "@sketchmind/llm-provider";

export interface ProxyProviderOptions {
  /** Absolute or same-origin path of the proxy route. */
  readonly endpoint: string;
  /** Injected in tests; defaults to the ambient `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly model?: string;
}

const PROXY_CAPABILITIES: LLMCapabilities = {
  structuredOutput: false,
  toolCalling: true,
  parallelToolCalls: false,
  streaming: false,
  vision: false,
  maxContextTokens: 128_000,
};

function unsupported(method: string): LLMProviderError {
  // `providerError` already returns an `LLMProviderError` instance (see
  // internal/errors.ts), so no wrapping is needed here -- but the throw sites
  // below stay narrow (one call each) precisely so that stops being true.
  return providerError(
    ProviderErrorCode.Misconfigured,
    `The LLM proxy carries tool-calling turns only; "${method}" is not routed through it. ` +
      `Scope is widened by a deliberate decision about what the browser may spend, not by need.`,
    PACKAGE,
  );
}

export function createProxyProvider(options: ProxyProviderOptions): LLMProvider {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const model = options.model ?? "proxy";

  return {
    id: "proxy",
    model,
    capabilities: PROXY_CAPABILITIES,

    async completeWithTools(req: ToolRequest): Promise<ToolResponse> {
      const response = await doFetch(options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(req.system === undefined ? {} : { system: req.system }),
          messages: req.messages,
          tools: req.tools,
          ...(req.toolChoice === undefined ? {} : { toolChoice: req.toolChoice }),
          ...(req.maxOutputTokens === undefined ? {} : { maxOutputTokens: req.maxOutputTokens }),
          ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
          // `allowParallelCalls` is deliberately omitted: the route derives it
          // server-side from the real provider's own capabilities (see
          // apps/api/src/routes/llm.ts), and the browser has no basis to assert
          // it -- it does not know, and must not decide, what the backing
          // provider can actually do.
        }),
        ...(req.signal ? { signal: req.signal } : {}),
      });

      if (!response.ok) {
        // `classifyFailure` (internal/errors.ts) already maps status codes to
        // the codes callers actually need to act on -- 400 is a client bug in
        // this very request, not the model being unreachable, and collapsing
        // both into `Unavailable` would send whoever reads the error code
        // looking for an outage that isn't there.
        throw classifyFailure(
          { status: response.status, message: `The LLM proxy answered ${response.status}.` },
          PACKAGE,
        );
      }

      return (await response.json()) as ToolResponse;
    },

    async complete(_req: CompletionRequest): Promise<CompletionResponse> {
      throw unsupported("complete");
    },
    async completeStructured<S extends ZodType>(
      _req: StructuredRequest<S>,
    ): Promise<StructuredResponse<z.infer<S>>> {
      throw unsupported("completeStructured");
    },
    async completeWithImages(_req: VisionRequest): Promise<CompletionResponse> {
      throw unsupported("completeWithImages");
    },
    // Fails on the first `next()`, not at call time: every other provider in
    // this package (FakeProvider.stream, and the Azure/Anthropic adapters) only
    // rejects once the caller starts iterating, because `for await` is how every
    // consumer actually invokes `stream`. Throwing synchronously here would
    // raise before the `for await` even begins, which no other provider does
    // and no consumer expects. (Not written as `async *stream` because a
    // generator whose body never reaches a `yield` trips `require-yield`.)
    stream(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
      return {
        [Symbol.asyncIterator]() {
          return {
            next: (): Promise<IteratorResult<CompletionChunk>> => Promise.reject(unsupported("stream")),
          };
        },
      };
    },
  };
}
