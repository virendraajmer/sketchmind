# @sketchmind/agent-core

Agent loop, tool registry, budgets, cancellation, tracing. Shared by both loci (AD-4).

## Public API

See `src/index.ts`. Internals live in `src/internal/` and are not importable
from other packages (Volume 12).

## Dependency rules

This package may depend only on its own layer or below. Direction is enforced
by `scripts/check-layering.mjs`; run `pnpm run check:layering`.
