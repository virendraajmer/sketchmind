import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";

/**
 * SketchMind lint configuration.
 *
 * The `no-restricted-imports` provider-SDK pattern below is a load-bearing
 * architectural constraint, not style. It makes LLM independence mechanical:
 * provider SDKs are physically un-importable outside `packages/llm-provider-*`,
 * which turns "swap any LLM anytime" from an intention into a guarantee.
 *
 * `import/no-cycle` catches file-level import cycles WITHIN a package.
 * Package-level dependency direction (Applications -> Agent -> Tools -> Core
 * -> Renderer -> External) is a different constraint and is enforced by
 * `scripts/check-layering.mjs`, which reads package.json manifests in ~0.3s.
 * The two are complementary: no-cycle cannot see package layering, and the
 * layering script cannot see file cycles.
 *
 * NOTE: `import/no-cycle` requires full TypeScript module resolution and is
 * known to be slow on large workspaces. Its real cost here is unmeasured --
 * there were no .ts files at the time this config was written. Measure
 * `pnpm run lint` once packages carry real source; if it becomes a bottleneck,
 * scope it to changed files in CI rather than dropping it.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/*.config.js",
      "**/*.config.mjs",
      "**/*.config.ts"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { import: importPlugin },
    settings: {
      "import/resolver": {
        typescript: { alwaysTryTypes: true, project: ["packages/*/tsconfig.json", "apps/*/tsconfig.json"] }
      }
    },
    rules: {
      "import/no-cycle": ["error", { maxDepth: 10 }],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/internal/*", "**/internal"],
              message:
                "Import a package's public API (src/index.ts) only. Internals are private (Volume 12)."
            },
            {
              group: ["openai", "@azure/*", "@anthropic-ai/*", "@google/*", "@google-cloud/*"],
              message:
                "Provider SDKs may only be imported inside packages/llm-provider-*. All model access goes through the LLMProvider interface (Global Constraints: LLM independence)."
            }
          ]
        }
      ]
    }
  },
  {
    // Adapter packages are the one place provider SDKs are allowed to exist.
    files: ["packages/llm-provider-*/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": "off" }
  },
  {
    files: ["**/tests/**/*.{ts,tsx}"],
    rules: { "@typescript-eslint/no-explicit-any": "off" }
  }
);
