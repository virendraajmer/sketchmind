# scripts/

CI and repository automation.

| Script | Purpose |
|---|---|
| `check-layering.mjs` | Enforces one-way package dependency direction and detects cycles by reading package.json manifests. Runs as part of `pnpm run lint`, or standalone via `pnpm run check:layering`. |
| `scaffold-package.mjs` | Generates a package skeleton with the standard shape. `node scripts/scaffold-package.mjs <name> "<responsibility>"`, or `--all` for the Phase 1 set. Never overwrites an existing package. |

## Why layering is a script, not an eslint rule

`import/no-cycle` catches file-level import cycles *within* a package but cannot
see package-level layering. `check-layering.mjs` checks the constraint we actually
care about — which package may depend on which — in ~0.3s. The two are
complementary and both run.
