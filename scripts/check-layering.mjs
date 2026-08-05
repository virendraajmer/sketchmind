#!/usr/bin/env node
/**
 * Enforces SketchMind's one-way package dependency direction.
 *
 * Global Constraints require:
 *   Applications -> Agent -> Tools -> Core -> Renderer -> External
 * and forbid any upward dependency or cycle.
 *
 * This replaces eslint's `import/no-cycle`, which needs full TypeScript module
 * resolution and measured >2 minutes for a single file on this workspace. Reading
 * package.json manifests checks the constraint we actually care about -- which
 * package may depend on which -- and runs in milliseconds.
 *
 * A package may depend on packages in its own layer or any layer BELOW it.
 * Depending upward is an error. Cycles are an error.
 *
 * Run: node scripts/check-layering.mjs
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Lower index == higher layer. A package may only depend downward or sideways. */
const LAYERS = [
  { name: "app", members: ["@sketchmind/web", "@sketchmind/api"] },
  { name: "orchestrator", members: ["@sketchmind/ai-orchestrator"] },
  {
    name: "agent",
    members: ["@sketchmind/agent-core", "@sketchmind/agent-memory", "@sketchmind/agent-vision"]
  },
  {
    name: "tools",
    members: [
      "@sketchmind/agent-tools-reasoning",
      "@sketchmind/agent-tools-geometry",
      "@sketchmind/agent-tools-canvas"
    ]
  },
  {
    name: "core",
    members: [
      "@sketchmind/intent-analyzer",
      "@sketchmind/visual-planner",
      "@sketchmind/shape-intelligence",
      "@sketchmind/diagram-reasoner",
      "@sketchmind/diagram-ast",
      "@sketchmind/constraint-engine",
      "@sketchmind/layout-engine",
      "@sketchmind/stroke-planner",
      "@sketchmind/stroke-runtime",
      "@sketchmind/primitive-sdk",
      "@sketchmind/plugin-sdk",
      "@sketchmind/export-engine",
      "@sketchmind/session-protocol"
    ]
  },
  {
    name: "renderer",
    members: [
      "@sketchmind/renderer-core",
      "@sketchmind/renderer-konva",
      "@sketchmind/renderer-svg"
    ]
  },
  {
    name: "provider",
    members: [
      "@sketchmind/llm-provider",
      "@sketchmind/llm-provider-azure-openai",
      "@sketchmind/llm-provider-anthropic"
    ]
  },
  { name: "foundation", members: ["@sketchmind/shared-types", "@sketchmind/utilities"] }
];

const layerOf = new Map();
LAYERS.forEach((layer, index) => {
  for (const member of layer.members) layerOf.set(member, { index, name: layer.name });
});

function readManifests() {
  const manifests = [];
  for (const group of ["packages", "apps"]) {
    const dir = join(ROOT, group);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(dir, entry.name, "package.json");
      if (!existsSync(manifestPath)) continue;
      manifests.push(JSON.parse(readFileSync(manifestPath, "utf8")));
    }
  }
  return manifests;
}

function internalDeps(manifest) {
  return Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).filter((dep) =>
    dep.startsWith("@sketchmind/")
  );
}

function checkLayering(manifests, errors) {
  for (const manifest of manifests) {
    const from = layerOf.get(manifest.name);
    if (!from) {
      errors.push(
        `${manifest.name} is not assigned to a layer in scripts/check-layering.mjs. ` +
          `Add it to LAYERS so its dependency direction is enforced.`
      );
      continue;
    }
    for (const dep of internalDeps(manifest)) {
      const to = layerOf.get(dep);
      if (!to) {
        errors.push(`${manifest.name} depends on unlayered package ${dep}.`);
        continue;
      }
      if (to.index < from.index) {
        errors.push(
          `Upward dependency: ${manifest.name} (${from.name}) -> ${dep} (${to.name}). ` +
            `Packages may only depend on their own layer or below.`
        );
      }
    }
  }
}

function checkCycles(manifests, errors) {
  const graph = new Map(manifests.map((m) => [m.name, internalDeps(m)]));
  const state = new Map(); // name -> "visiting" | "done"

  function visit(name, path) {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      errors.push(`Dependency cycle: ${[...path, name].join(" -> ")}`);
      return;
    }
    state.set(name, "visiting");
    for (const dep of graph.get(name) ?? []) visit(dep, [...path, name]);
    state.set(name, "done");
  }

  for (const name of graph.keys()) visit(name, []);
}

const manifests = readManifests();
const errors = [];
checkLayering(manifests, errors);
checkCycles(manifests, errors);

if (errors.length > 0) {
  console.error("Package layering violations:\n");
  for (const error of errors) console.error(`  - ${error}`);
  console.error(`\n${errors.length} violation(s). See Global Constraints in the plan.`);
  process.exit(1);
}

console.log(`Layering OK: ${manifests.length} package(s), no upward dependencies, no cycles.`);
