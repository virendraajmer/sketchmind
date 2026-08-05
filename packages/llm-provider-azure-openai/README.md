# @sketchmind/llm-provider-azure-openai

Azure OpenAI / AI Foundry adapter. The only place Azure types exist — lint
forbids `openai` and `@azure/*` imports anywhere outside `packages/llm-provider-*`.

## AD-9: targets Azure's v1 API surface

No `api-version`, stock `OpenAI` client (not `AzureOpenAI`), Responses API
(`client.responses.create`), not Chat Completions. This is what Azure's
playground itself emits for a current deployment, and what Microsoft
recommends going forward. See `src/internal/config.ts` for the reasoning and
`normalizeBaseUrl()` for the two endpoint spellings Azure accepts.

## Configuration

See `.env.example` at the repo root for the full list. In short:

```bash
AZURE_OPENAI_BASE_URL=https://<resource>.services.ai.azure.com/openai/v1
AZURE_OPENAI_DEPLOYMENT=<deployment-name>
AZURE_OPENAI_API_KEY=...          # or AZURE_OPENAI_USE_ENTRA_ID=true
```

Entra auth uses `getBearerTokenProvider(new DefaultAzureCredential(), ENTRA_SCOPE)`
passed as `apiKey` — the v1 client refreshes the token itself, which is why
`AzureOpenAI` is no longer needed for that path. The account needs the
**Cognitive Services OpenAI User** role on the resource.

Capabilities (`AZURE_OPENAI_STRUCTURED_OUTPUT`, `AZURE_OPENAI_TOOL_CALLING`, …)
are declared, not inferred from the model name — a hardcoded model catalogue
goes stale the week it is written. Run the probe against a real deployment to
find out what to set:

```bash
pnpm build && pnpm probe:azure
```

Vision stays off (`AZURE_OPENAI_VISION_DEPLOYMENT` unset) per the standing
directive that the agent works on JSON only; `completeWithImages()` refuses
before it reads `req.images`.

## Testing

- `tests/provider.test.ts` — the full contract suite, plus adapter-specific
  cases, all run over `tests/stub.ts` (an injected fake `OpenAI` client). No
  network, no credentials, deterministic.
- `tests/registry-switch.test.ts` — proves `SKETCHMIND_LLM_PROVIDER` actually
  switches between this adapter and `llm-provider-anthropic` with no code
  change (D-9). Depends on `llm-provider-anthropic` as a **devDependency**
  only — it never ships in `dist/`, and `check-layering.mjs` does not inspect
  `devDependencies`.
- `tests/live.test.ts` — the one test that touches the network. Skipped
  entirely unless `AZURE_OPENAI_*` credentials are present in the environment;
  never runs in CI without them. Uses `IntentModelSchema` from `shared-types`,
  not a toy schema, so a real strict-mode failure would show up here first.

## Public API

See `src/index.ts`. Internals live in `src/internal/` and are not importable
from other packages (Volume 12).

## Dependency rules

This package may depend only on its own layer or below. Direction is enforced
by `scripts/check-layering.mjs`; run `pnpm run check:layering`.
