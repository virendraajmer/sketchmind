#!/usr/bin/env node
/**
 * Generates a SketchMind package skeleton.
 *
 * Every package gets the same shape (Volume 11): public API in src/index.ts,
 * private implementation in src/internal/, tests, README, and a tsconfig
 * extending the workspace base.
 *
 * Usage:
 *   node scripts/scaffold-package.mjs <name> "<one-line responsibility>"
 *   node scripts/scaffold-package.mjs --all      # scaffold the full Phase 1 set
 *
 * Existing packages are skipped, never overwritten.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** name -> one-line responsibility, from the plan's Package Map. */
const PACKAGES = {
  utilities: "Cross-cutting helpers: ids, Result types, logging shims.",
  "llm-provider":
    "LLMProvider interface, capability flags, structured-output fallback, retry. Zero SDK imports.",
  "llm-provider-azure-openai":
    "Azure OpenAI / AI Foundry adapter. The only place Azure types exist.",
  "llm-provider-anthropic": "Anthropic adapter. Second provider, proves the abstraction holds.",
  "agent-core":
    "Agent loop, tool registry, budgets, cancellation, tracing. Shared by both loci (AD-4).",
  "agent-memory":
    "Session working memory and persisted learned-primitive store with semantic recall (AD-7).",
  "agent-vision":
    "Canvas capture, multimodal critique, and fix proposals so the agent sees its own work (AD-3).",
  "agent-tools-reasoning": "Reasoning stages exposed as agent tools (AD-1).",
  "agent-tools-geometry": "Layout, stroke, and render stages exposed as agent tools.",
  "agent-tools-canvas":
    "Client tool surface over the rendered diagram: highlight, zoom, annotate, erase, redraw.",
  "intent-analyzer": "Natural language to IntentModel.",
  "visual-planner": "IntentModel to VisualPlan: decides what should appear.",
  "shape-intelligence":
    "VisualPlan to ShapeGraph, plus primitive discovery, generation, and learning.",
  "diagram-reasoner": "ShapeGraph to DiagramAST. Never produces coordinates.",
  "diagram-ast": "Diagram AST builder API, validator, versioning, and serialization.",
  "constraint-engine": "DiagramAST to ConstraintGraph. Derives spatial intent, computes no geometry.",
  "layout-engine":
    "ConstraintGraph to LayoutModel. Solver, collision detection, label placement, routing.",
  "stroke-planner": "LayoutModel to StrokeAST plus optimizer. Applies human drawing rules.",
  "stroke-runtime":
    "Playback: play, pause, seek, replay, undo, redo. Renderer-independent execution state.",
  "renderer-core": "Renderer adapter contract, layer model, viewport, hit-testing, registry.",
  "renderer-konva": "Konva rendering backend. First concrete renderer.",
  "renderer-svg": "SVG rendering backend skeleton. Proves the SDK is backend-agnostic.",
  "export-engine": "Export to PNG, SVG, PDF, JSON, and replay packages.",
  "session-protocol": "Typed client/server contract: events, commands, and agent traces.",
  "primitive-sdk":
    "Primitive manifest schema, validation, registry, and freeform-to-registered promotion (AD-5).",
  "plugin-sdk":
    "Plugin loading for subject packs, primitives, renderers, layout strategies, and exporters.",
  "ai-orchestrator":
    "Session lifecycle, checkpoints, caching, event bus, and observability."
};

function packageJson(name) {
  return (
    JSON.stringify(
      {
        name: `@sketchmind/${name}`,
        version: "0.0.1",
        private: true,
        type: "module",
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
        exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
        scripts: {
          build: "tsc -p tsconfig.json",
          test: "vitest run",
          lint: "eslint src tests",
          typecheck: "tsc -p tsconfig.json --noEmit"
        },
        dependencies: { "@sketchmind/shared-types": "workspace:*" }
      },
      null,
      2
    ) + "\n"
  );
}

const TSCONFIG =
  JSON.stringify(
    {
      extends: "../../tsconfig.base.json",
      compilerOptions: { outDir: "dist", rootDir: "src" },
      include: ["src"]
    },
    null,
    2
  ) + "\n";

function indexTs(name, responsibility) {
  return `/**
 * @sketchmind/${name}
 *
 * ${responsibility}
 *
 * Public API only. Implementation belongs in src/internal/ and is not
 * importable from other packages (Volume 12).
 */

export const PACKAGE_NAME = "@sketchmind/${name}";
export const PACKAGE_VERSION = "0.0.1";
`;
}

function testTs(name) {
  return `import { describe, it, expect } from "vitest";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/index";

describe("${name} package identity", () => {
  it("exposes its name and version", () => {
    expect(PACKAGE_NAME).toBe("@sketchmind/${name}");
    expect(PACKAGE_VERSION).toBe("0.0.1");
  });
});
`;
}

function readme(name, responsibility) {
  return `# @sketchmind/${name}

${responsibility}

## Public API

See \`src/index.ts\`. Internals live in \`src/internal/\` and are not importable
from other packages (Volume 12).

## Dependency rules

This package may depend only on its own layer or below. Direction is enforced
by \`scripts/check-layering.mjs\`; run \`pnpm run check:layering\`.
`;
}

function scaffold(name, responsibility) {
  const dir = join(ROOT, "packages", name);
  if (existsSync(dir)) {
    console.log(`  skip  ${name} (already exists)`);
    return false;
  }
  mkdirSync(join(dir, "src", "internal"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });

  writeFileSync(join(dir, "package.json"), packageJson(name));
  writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
  writeFileSync(join(dir, "src", "index.ts"), indexTs(name, responsibility));
  writeFileSync(join(dir, "src", "internal", ".gitkeep"), "");
  writeFileSync(join(dir, "tests", "index.test.ts"), testTs(name));
  writeFileSync(join(dir, "README.md"), readme(name, responsibility));

  console.log(`  create ${name}`);
  return true;
}

const [, , arg, description] = process.argv;

if (arg === "--all") {
  let created = 0;
  for (const [name, responsibility] of Object.entries(PACKAGES)) {
    if (scaffold(name, responsibility)) created += 1;
  }
  console.log(`\n${created} package(s) created, ${Object.keys(PACKAGES).length - created} skipped.`);
} else if (arg && description) {
  scaffold(arg, description);
} else {
  console.error("Usage: scaffold-package.mjs <name> \"<responsibility>\"  |  --all");
  process.exit(1);
}
