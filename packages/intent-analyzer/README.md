# @sketchmind/intent-analyzer

Natural language to `IntentModel` (V03 §Intent Analyzer, V15 §Agent Contracts).

The first reasoning stage, and the smallest. It answers four questions — what is
this, what field, what kind of diagram, how involved — and stops. Deciding *what
to draw* is `visual-planner`'s job, and keeping the two apart is what lets AD-1's
agent skip either one independently.

## What the model is and is not asked for

`analyzeIntent` asks for `IntentDraftSchema` — `IntentModelSchema` minus
`version`, `rawRequest` and `metadata`. Those three are supplied here:

- **`version`** — an agent should not have to know a schema version to describe a
  pulley, and letting it guess is how you get a model claiming a version that
  never existed.
- **`rawRequest`** — paraphrasing the user's own words is the one thing this
  field must never do, and asking the model to echo back a string we already hold
  is paying tokens for the privilege.
- **`metadata`** — caller context, e.g. a session id. Attached to the result,
  never sent to the model.

## Open and closed fields

`intent` and `category` are enums because each selects downstream behaviour, so
an unrecognised value must fail here rather than surface as a mystery later.
`subject` and `domain` are open strings: the product requirement is to draw
*anything*, and an enum of domains would be a list of what it cannot draw.

## The prompt

`INTENT_PROMPT` is versioned data in `src/internal/prompt.ts`, following V15's
Standard Prompt Template. Its two few-shot examples — a pulley system and a bare
circle — are the two ends of AD-1's adaptive range, chosen to teach *depth*
rather than vocabulary.

## Failure

Nothing here throws on the model's account (AD-2). Output that will not validate
comes back as a `ValidationResult` failure the agent reads and fixes. Only a
provider that cannot answer at all — bad credentials, missing deployment —
propagates as an exception.

## Public API

See `src/index.ts`. Internals live in `src/internal/` and are not importable
from other packages (Volume 12).

## Dependency rules

Depends on `@sketchmind/llm-provider` and `@sketchmind/shared-types`, and on no
concrete provider. Direction is enforced by `scripts/check-layering.mjs`; run
`pnpm run check:layering`.
