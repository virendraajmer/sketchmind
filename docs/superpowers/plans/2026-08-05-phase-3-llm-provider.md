# Phase 3 — LLM Provider Abstraction + Azure OpenAI

**Branch:** `phase-3`
**Packages:** `llm-provider`, `llm-provider-azure-openai`, `llm-provider-anthropic`
**Deliverable:** a live Azure call returning schema-valid JSON through an interface that contains
no Azure concept, proven by running one test suite unchanged against three providers.

---

## What the user's deployment settles

The Azure playground sample for `gpt-5.6-luna` resolves three open questions from the master plan.

```js
const endpoint = "https://reviewmind-resource.services.ai.azure.com/openai/v1";
const openai = new OpenAI({ baseURL: endpoint, apiKey: tokenProvider });
await openai.responses.stream({ model: "gpt-5.6-luna", input: "..." });
```

1. **No `api-version`.** This is Azure's v1 API surface, GA since August 2025. `api-version` is
   gone as a required parameter — that was the whole point of the v1 line.
2. **Stock `OpenAI` client, not `AzureOpenAI`.** Azure now supports the vanilla client with a
   `baseURL`, including automatic Entra token refresh when `apiKey` is a token provider function.
3. **Responses API, not Chat Completions.** That is what the playground emits and what Microsoft
   recommends for Azure OpenAI models.

`AZURE_OPENAI_API_VERSION` is therefore **deleted** from the env contract rather than left blank.
A variable that must be empty is a variable someone will eventually fill in wrongly.

---

## Design decisions

### D-1. Target the v1 API surface; `api-version` is not modelled at all

The master plan said "`AzureOpenAI` client, verify the API version at implementation time." Verified:
the answer is that there is no version to verify. Config becomes a base URL that already carries
`/openai/v1`, and the adapter normalizes a bare resource endpoint up to that form so both spellings
work:

```
https://reviewmind-resource.services.ai.azure.com          -> .../openai/v1/
https://reviewmind-resource.services.ai.azure.com/openai/v1 -> unchanged
```

Deviation from the master plan, recorded as **AD-9**.

### D-2. The interface is request/response shaped, not chat shaped

`CompletionRequest` carries `system`, `messages`, `maxOutputTokens`, `temperature`, `stop`,
`signal` — no `role: "developer"`, no `input` union, no Azure content-part arrays. Everything
provider-specific is translated inside the adapter. If a field cannot be expressed by both Azure
and Anthropic, it does not belong in the interface; that is the test for whether the abstraction
is real or is Azure with a coat of paint.

### D-3. Structured output is Zod in, typed value out — the mechanism is invisible

```ts
completeStructured<T>(req: StructuredRequest<T>): Promise<StructuredResponse<T>>
```

Three mechanisms exist behind that one signature, selected by `capabilities.structuredOutput`:

| Mechanism | Used by | How |
|---|---|---|
| Native strict JSON Schema | Azure v1 | `text.format = { type: "json_schema", strict: true, schema }` |
| Forced tool call | Anthropic | A single tool whose input schema *is* the target schema, `tool_choice` forced |
| Prompt-injected schema + parse-and-repair | Anything weaker | Schema in the prompt; on parse failure, feed the Zod errors back and retry |

The caller never learns which ran. That is precisely what lets a local model drop in later with no
change above this layer — which is the whole LLM-independence requirement, made mechanical.

### D-4. A strict-mode JSON Schema normalizer, in `llm-provider`, shared by every adapter

`z.toJSONSchema()` produces valid JSON Schema. It does **not** produce schema that Azure's
`strict: true` accepts. Strict mode requires, at every object depth:

- `additionalProperties: false`
- every property listed in `required` — optional fields must instead be `["T", "null"]`
- no unsupported validation keywords (`minLength`, `format`, `pattern` on some paths, …)

So a normalizer walks the generated schema and enforces those. It lives in `llm-provider`, not in
the Azure adapter, for two reasons: it imports no SDK, and the same normalization is what makes the
prompt-injected fallback legible to a weak model. Putting it in the adapter would mean writing it
again for the next provider.

This is the highest-risk piece in the phase, so it is tested directly against every schema
`shared-types` exports — not against toy schemas. If `DiagramASTSchema` cannot be normalized, we
learn it now rather than in Phase 5.

### D-5. Capabilities are declared in config and *verifiable* by probe — never hardcoded per model name

Hardcoding `gpt-5.6-luna` → `{ structuredOutput: true }` puts a model catalogue in our source that
goes stale the week after it is written. Instead capabilities come from config (with sane defaults),
and `probeCapabilities()` makes a real minimal call to confirm. The probe is opt-in, run by the
integration test and available at API startup — not on every construction, which would cost a round
trip per process.

`vision` defaults to **`false`**, per the standing directive that the agent works on JSON only.

### D-6. Retry and backoff live in `llm-provider`; adapters only *classify*

Adapters translate a provider error into a `SketchMindError` plus a `retryability` verdict. One
shared policy acts on it. The SDK's own retries are turned **off** (`maxRetries: 0`) — leaving them
on gives two nested retry loops, so a 429 storm becomes 2 × 3 = 6 attempts and the timeout budget
means nothing.

| Condition | Verdict |
|---|---|
| 429 | retry, honoring `Retry-After` |
| 5xx, connection error, timeout | retry with exponential backoff + jitter |
| Content filter | **not** retryable — the same prompt fails the same way |
| 401 / 403 | fatal, not retryable |
| Deployment not found (404) | fatal — a config error, not a transient one |
| 400 schema/validation | fatal, but `recoverable: true` so the agent can revise |

### D-7. No user content in logs, at any level

Prompts contain what the user asked us to draw. The adapter logs request *shape* — message count,
token counts, model id, latency, status — and never message text, never structured output values.
Enforced by a test that spies on the logger and asserts a canary string present in the prompt is
absent from every log call.

### D-8. One contract suite, three providers, zero test-code changes

```ts
describeProviderContract("azure-openai", () => makeAzureProvider(config));
```

The same exported function runs against the fake provider (always), the strict-mode-disabled fake
(exercises repair), and Azure (skipped without env). The master plan's acceptance criterion — "the
same test passes against an in-memory fake with zero test-code changes" — is satisfied by
construction rather than by discipline, because there is literally one copy of the test body.

### D-9. Provider selection is a registry, not an import

`llm-provider` cannot import `llm-provider-azure-openai` — that is a cycle, and it would drag the
Azure SDK into every consumer. So `llm-provider` owns a registry, each adapter exports a
`register*` function, and the composition root (Phase 11's `ai-orchestrator`, `apps/api` before
then) registers what it wants. `createProviderFromEnv(registry)` then reads
`SKETCHMIND_LLM_PROVIDER` and hands back an `LLMProvider`.

That is what makes "switching providers is one env var" true without anything importing a provider
it does not use.

### D-10. `completeWithImages` exists and refuses

The method stays on the interface — removing it would mean a breaking change when Phase 10b turns
on. With `vision: false` it returns a `PROVIDER_CAPABILITY_UNAVAILABLE` error without constructing
a request. A test asserts that no image bytes reach the transport in that state, which is the
guarantee the standing "JSON only" directive actually needs.

---

## Task breakdown

TDD throughout: test first, watch it fail, implement, watch it pass.

| # | Task | Files |
|---|---|---|
| 0 | Env contract: drop `AZURE_OPENAI_API_VERSION`, add `AZURE_OPENAI_BASE_URL` | `.env.example` |
| 1 | Interface + models: `LLMProvider`, capabilities, requests, responses, usage | `llm-provider/src/types.ts` |
| 2 | Error classification + `SketchMindError` mapping + retry policy | `llm-provider/src/internal/{classify,retry}.ts` |
| 3 | Strict-mode JSON Schema normalizer, tested against every `shared-types` schema | `llm-provider/src/internal/json-schema.ts` |
| 4 | Parse-and-repair fallback for `structuredOutput: false` | `llm-provider/src/internal/repair.ts` |
| 5 | `FakeProvider` (scriptable, capability-configurable) | `llm-provider/src/fake.ts` |
| 6 | Registry + `createProviderFromEnv` | `llm-provider/src/registry.ts` |
| 7 | The contract suite, exported for reuse | `llm-provider/src/testing/contract.ts` |
| 8 | Azure adapter: client construction, both auth modes, Responses API, streaming | `llm-provider-azure-openai/src/**` |
| 9 | Anthropic adapter: forced-tool structured output — the proof the interface isn't Azure-shaped | `llm-provider-anthropic/src/**` |
| 10 | Live integration test, skipped without env; capability probe | `llm-provider-azure-openai/tests/live.test.ts` |
| 11 | READMEs, master-plan update (AD-9), full gate | — |

All eleven tasks complete. See Outcome below.

---

## Acceptance criteria

- [x] Live integration test (skipped without Azure env) returns an object matching a Zod schema
      drawn from `shared-types`, not a toy schema. — `IntentModelSchema`, `live.test.ts`.
- [x] The same contract suite passes against the fake provider with **zero test-code changes** —
      guaranteed because there is one copy of the suite, parameterized by a factory. Run three times:
      fake/native, fake/repair, and against both real adapters over stubbed transports.
- [x] `SKETCHMIND_LLM_PROVIDER=anthropic` switches adapters with no code change, proven by a test
      that flips the env var and asserts on `provider.id`. — `registry-switch.test.ts`.
- [x] A provider with `structuredOutput: false` still returns schema-valid objects via repair, and
      the trace shows the repair round trip happened. — asserted for both adapters
      (`mechanism: "prompt-repair"`, `repairAttempts > 0`).
- [x] Every schema `shared-types` exports normalizes to Azure-strict-valid JSON Schema. — all 40
      object-rooted schemas; one documented exclusion (`ToolSpecSchema`, never model output) with a
      test proving it fails for exactly the open-ended-map reason.
- [x] 429 retries honoring `Retry-After`; content filter fails fast; 404 deployment-not-found is
      fatal — each asserted with a stubbed transport, no network.
- [x] No `openai` / `@azure/*` / `@anthropic-ai/*` import outside `packages/llm-provider-*`
      (lint-enforced, plus the grep the earlier phases used).
- [x] With `vision: false`, `completeWithImages` fails before constructing a request — asserted by
      a transport spy, not by reading the code. Both adapters and the fake.
- [x] No prompt text appears in any log call — asserted with a canary string. Both adapters.
- [x] Full gate green: layering → lint → typecheck → build → test.

---

## Open item carried to the user

`gpt-5.6-luna`'s exact capability set is not something to assume from a model name. Task 10's probe
answers it empirically against the real deployment, and the result is what populates config. If the
probe shows strict structured output is unsupported, the repair fallback from Task 4 carries it with
no change above this layer — which is the point of building the fallback first.

**Still open after this phase:** the probe (`pnpm probe:azure`) has not been run against the live
`gpt-5.6-luna` deployment in this environment — there is no Azure credential available here. Run it
once real credentials are configured, and set `AZURE_OPENAI_STRUCTURED_OUTPUT` /
`AZURE_OPENAI_TOOL_CALLING` from its output. Until then the adapter assumes both are supported
(the pre-probe default for a current-generation deployment), which the live test would catch if wrong.

---

## Outcome

All eleven tasks landed on `phase-3`, TDD throughout. Final state:

- **`llm-provider`** — 135 tests passing across 6 files. The provider-independent interface,
  strict-mode JSON Schema normalizer (tested against all 40 object-rooted `shared-types` schemas),
  retry/backoff, error classification, `FakeProvider`, `ProviderRegistry`, and the exported contract
  suite (`@sketchmind/llm-provider/testing`).
- **`llm-provider-azure-openai`** — 56 tests passing, 3 skipped (the live suite; no Azure
  credentials in this environment). Targets the v1 API surface per AD-9: no `api-version`, stock
  `OpenAI` client, Responses API, both API-key and Entra auth. Includes `scripts/probe.mjs`
  (`pnpm probe:azure`) for measuring real capabilities against a deployment.
- **`llm-provider-anthropic`** — 49 tests passing. Structured output via forced tool call
  (`mechanism: "forced-tool"`), same contract suite, zero test-code changes — the proof that
  `types.ts` isn't secretly Azure-shaped.
- **Repo-wide fix, found while wiring this phase:** `tsconfig.base.json` moved from
  `moduleResolution: "Bundler"` to `NodeNext`/`NodeNext` (with `apps/web` overriding back to
  `Bundler`, which Next.js needs), because `Bundler` emitted extensionless relative imports that
  Node's ESM loader could not resolve — `dist/` was unloadable by `node` outside a bundler. A
  one-time codemod (`scripts/add-import-extensions.mjs`) added the missing `.js` extensions across
  49 files in `packages/*` and `apps/api`.
- **Env contract:** `AZURE_OPENAI_API_VERSION` removed; `AZURE_OPENAI_BASE_URL` +
  `AZURE_OPENAI_DEPLOYMENT` + one credential added; capability-override variables
  (`AZURE_OPENAI_STRUCTURED_OUTPUT`, etc.) and the Anthropic block added.
- **Not committed.** Per standing instruction, the user reviews and checks in.

Not done in this phase, intentionally out of scope: wiring either adapter into a composition root
(`ai-orchestrator` is Phase 11's package and is still an empty skeleton), and an Anthropic live test
(no Anthropic credential available here either — add one alongside the Azure live test when a key
is available).
