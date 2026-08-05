# @sketchmind/llm-provider-anthropic

Anthropic adapter, over the Messages API. The second provider, and the reason
the first one can be trusted: a single adapter would let an Azure-shaped
interface pass as a generic one, so this package exists specifically to prove
`@sketchmind/llm-provider`'s interface holds for a vendor with a different
shape of API entirely.

## What differs from the Azure adapter — deliberately

| | Azure | Anthropic |
|---|---|---|
| System prompt | `instructions` field | `system` field, same place |
| Structured output | native `text.format` strict JSON Schema | **forced tool call**: the schema becomes a tool's `input_schema`, `tool_choice: { type: "tool", name }` |
| `max_tokens` | optional | **mandatory on every request** — `ANTHROPIC_MAX_OUTPUT_TOKENS` supplies a default when a caller doesn't name one |
| Tool arguments | JSON string, adapter parses it | already an object |
| Usage totals | reported by the API | **not reported at all** — recomputed from `input_tokens + output_tokens`, same as Azure |
| Finish reason vocabulary | `status` + `incomplete_details.reason` | `stop_reason` (`end_turn`, `tool_use`, `max_tokens`, `refusal`, …) |

None of it is visible above `AnthropicProvider` — callers see the same
`CompletionResponse` / `StructuredResponse` / `ToolResponse` either adapter
returns.

## Structured output by forced tool call (D-3)

There is no `response_format` on the Messages API. Instead:

1. The requested Zod schema is normalized to strict JSON Schema by the same
   normalizer Azure uses (`toStrictJsonSchema`, in `llm-provider`).
2. A single tool is sent whose `input_schema` *is* that schema, and
   `tool_choice` forces the model to call exactly that tool.
3. The tool's `input` — already a parsed object, not a JSON string — is
   validated against the Zod schema again before it is returned.

Step 3 exists because a forced call is a constraint the provider enforces, not
a guarantee we have checked: a `max_tokens` truncation still produces a
tool call, just with a broken input. When validation fails, it falls back to
`completeStructuredViaPrompt` — the same repair path Azure uses when
`structuredOutput` is declared false — and `mechanism: "prompt-repair"` says so.

## Configuration

```bash
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-5   # default if unset
```

`capabilitiesFromEnv()` always reports `structuredOutput: false` — not a
limitation being admitted, but an accurate statement that there is no native
schema mode here; `completeStructured()` still returns a validated value via
the forced-tool mechanism above. Vision defaults off
(`ANTHROPIC_VISION=true` to opt in), matching the standing "JSON only" directive.

## Testing

`tests/provider.test.ts` runs the same `describeProviderContract` suite as the
Azure adapter, over an injected fake `Anthropic` client (`tests/stub.ts`) — no
network, no key. `tests/config.test.ts` covers env parsing. There is no live
test in this package yet; add one alongside `llm-provider-azure-openai/tests/live.test.ts`
when Anthropic credentials are available to CI.

## Public API

See `src/index.ts`. Internals live in `src/internal/` and are not importable
from other packages (Volume 12).

## Dependency rules

This package may depend only on its own layer or below. Direction is enforced
by `scripts/check-layering.mjs`; run `pnpm run check:layering`.
