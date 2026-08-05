---
name: scaffold-package
description: Create a new SketchMind package with the standard shape, wire it into layering/lint/test config, and verify it. Use when adding a new package under packages/ or apps/.
---

# Scaffold a new package

Generates `src/index.ts` (public API), `src/internal/` (private impl), `tests/`, `README.md`, and
a `tsconfig.json` extending the workspace base — see `scripts/scaffold-package.mjs` for the exact
template. Scaffolding alone is not enough to make the package buildable/lintable/layered; do the
follow-up steps below every time.

## Steps

```bash
# 1. Scaffold (never overwrites an existing package)
node scripts/scaffold-package.mjs <name> "<one-line responsibility>"

# 2. Register the package's dependency layer, or CI's layering check fails.
#    Edit scripts/check-layering.mjs -> LAYERS, add "@sketchmind/<name>" to the
#    correct layer array (apps < agent-orchestrator < agent < tools < core <
#    renderer < provider < foundation). See CLAUDE.md's Architecture section for
#    which layer fits a given responsibility.

# 3. Install workspace deps so pnpm links the new package
pnpm install

# 4. Verify layering, lint, types, and tests all pass for the new package
pnpm check:layering
pnpm --filter @sketchmind/<name> run lint
pnpm --filter @sketchmind/<name> run typecheck
pnpm --filter @sketchmind/<name> run test

# 5. If other packages need to depend on it, add "@sketchmind/<name>": "workspace:*"
#    to their package.json dependencies, then rerun `pnpm install` and
#    `pnpm check:layering` to confirm no upward/cyclic dependency was introduced.
```

## Rules that generated code must not violate

- Only `src/index.ts` is importable from outside the package. Nothing under `src/internal/**`
  crosses a package boundary — eslint's `no-restricted-imports` enforces this.
- No provider SDK (`openai`, `@azure/*`, `@anthropic-ai/*`, `@google/*`) may be imported outside
  `packages/llm-provider-*`.
- Shared models belong only in `packages/shared-types` — do not redefine types another package
  already owns.
- A package may depend on its own layer or any layer below; never upward, never a cycle.
