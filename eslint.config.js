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
 * Measured cost across 28 skeleton packages: ~1m46s cold, ~0.5s fully cached
 * by turbo. The per-package cost (~3.8s) is dominated by eslint process startup,
 * not by cycle analysis. Turbo's cache makes incremental runs cheap, so this is
 * acceptable. Re-measure once packages carry real source; if cold lint becomes a
 * CI bottleneck, scope it to changed packages rather than dropping the rule.
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
      // Honour the `_` prefix convention. Destructuring a field purely to omit
      // it (`const { version: _drop, ...rest } = x`) is deliberate, and the
      // prefix is how the author says so.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true
        }
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // Cross-package reaching only. A package importing its OWN
              // internals via "./internal/..." is the structure Volume 12
              // prescribes, so it must stay legal -- the original pattern
              // ("**/internal/*") banned that too and made the prescribed
              // layout unlintable.
              //
              // Two escape routes exist and both are covered: the package name
              // ("@sketchmind/foo/internal/x", which the exports map already
              // refuses) and a relative climb out of the package
              // ("../../foo/src/internal/x").
              group: [
                "@sketchmind/*/internal",
                "@sketchmind/*/internal/**",
                "@sketchmind/*/src/internal/**",
                "../../*/src/internal/**",
                "../../../**/internal/**"
              ],
              message:
                "Import another package's public API (its src/index.ts) only. Internals are private to their own package (Volume 12)."
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
