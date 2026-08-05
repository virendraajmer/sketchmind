# @sketchmind/llm-provider

The provider-independent model interface: `LLMProvider`, capability flags,
structured-output fallback, retry, error classification, and the strict-mode
JSON Schema normalizer. **Imports no provider SDK, and never will** — that is
what makes "any LLM, swappable anytime" a guarantee rather than an intention.
Lint forbids `openai` / `@azure/*` / `@anthropic-ai/*` / `@google*` imports
anywhere outside `packages/llm-provider-*`.

## Why this shape

`types.ts` is the test: a field belongs here only if it can be expressed by
**both** Azure and Anthropic. That constraint is what `llm-provider-anthropic`
proves — a single adapter would let an Azure-shaped interface pass as a
generic one.

`completeStructured()` hides three different mechanisms behind one signature:

| Mechanism | Provider | How |
|---|---|---|
| `native` | Azure v1 | `text.format = { type: "json_schema", strict: true }` |
| `forced-tool` | Anthropic | A single tool whose input schema *is* the target schema, `tool_choice` forced |
| `prompt-repair` | anything weaker | Schema injected into the prompt; on parse failure, Zod's errors are fed back and it tries again |

Callers never learn which one ran — `mechanism` in the response is
observability, not control flow. That is what lets a local or future model
drop in with no change above this layer.

### The tool round trip (Phase 4, D-1)

`Message` is a discriminated union — `UserMessage | AssistantMessage |
ToolResultMessage` — not just `{ role, content }`. Phase 3 could ask a model to
call a tool but had no way to send back what the tool returned; Phase 4's agent
loop needed to, and the two providers put a call-and-result history on the wire
in genuinely different shapes (Anthropic nests `tool_use` inside the assistant
turn and *rejects* an unmatched `tool_result`; Azure wants flat sibling
`function_call` / `function_call_output` items). Both translations are tested
directly — `llm-provider-*/tests/tool-results.test.ts` — and the whole round
trip is proven provider-independent by `tests/agent-loop-providers.test.ts` at
the repo root, which runs one `runAgent` script against the fake and both real
adapters over stubbed transports.

## What lives here

- `types.ts` — `LLMProvider`, `CompletionRequest`/`Response`, `StructuredRequest`/`Response`,
  `ToolRequest`/`Response`, `VisionRequest`, `LLMCapabilities`, `LLMProviderError`.
- `internal/errors.ts` — classifies a transport failure into a `SketchMindError`
  plus a retryability verdict. `retryable` and `recoverable` are deliberately
  independent: a schema-validation failure is not retryable with the same
  request, but it *is* recoverable — the agent can revise and try again.
- `internal/retry.ts` — exponential backoff with jitter, `Retry-After` aware.
  Adapters run their SDK with `maxRetries: 0`; this is the only retry loop.
- `internal/json-schema.ts` — the highest-risk piece in Phase 3. Walks a Zod
  schema's generated JSON Schema and enforces Azure's `strict: true`
  requirements (`additionalProperties: false` everywhere, every property in
  `required`, optionality expressed as nullable). Tested against every
  object-rooted schema `shared-types` exports, not toy schemas.
- `internal/structured.ts` — the `prompt-repair` mechanism: schema-in-prompt,
  parse, and on failure a second attempt naming exactly which field was wrong.
- `fake.ts` — `FakeProvider`, scriptable and capability-configurable, for
  testing anything above this layer without a real provider.
- `registry.ts` — `ProviderRegistry` + `createProviderFromEnv`. This package
  cannot import an adapter (that would be a cycle, and would drag an SDK into
  every consumer), so adapters export a `register*` function and the
  composition root wires them. Changing `SKETCHMIND_LLM_PROVIDER` is then the
  entire cost of switching providers.
- `logging.ts` — `describeRequest()` returns shape only (message count, prompt
  character count, `maxOutputTokens`, `temperature`) — never message text.
- `testing/contract.ts` — `describeProviderContract(name, { make })`. One copy
  of the provider assertions, run against the fake and against every real
  adapter with zero test-code changes. Exported at `@sketchmind/llm-provider/testing`.

## Public API

See `src/index.ts` for the full export surface. Internals live in
`src/internal/` and are not importable from other packages (Volume 12).

## Dependency rules

This package may depend only on its own layer or below. Direction is enforced
by `scripts/check-layering.mjs`; run `pnpm run check:layering`.
