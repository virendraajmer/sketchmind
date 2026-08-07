#!/usr/bin/env node
/**
 * Verify no LLM credential or provider SDK reached the browser bundle.
 *
 * There is already a source-level grep in CI for provider SDK imports, and it is
 * not the same check. That one asks "did anyone write the import?"; this one
 * asks "did anything end up in the file a browser downloads?" -- which is the
 * property that actually matters, and which a transitive dependency, a bundler
 * setting, or an inlined `NEXT_PUBLIC_*` variable can break without a single
 * import statement changing.
 *
 * Run after `pnpm build`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const targetDirs = process.argv.slice(2);
const BUNDLES = targetDirs.length > 0 ? targetDirs : ["apps/studio/dist"];

/**
 * Each entry is a thing that must never be in a browser bundle, and why. The
 * reason is printed on failure -- a bare pattern list teaches whoever hits this
 * nothing about what they broke.
 */
const FORBIDDEN = [
  { pattern: /AZURE_OPENAI_/, why: "Azure OpenAI configuration belongs to the server adapter." },
  { pattern: /ANTHROPIC_API_KEY/, why: "Provider credentials never leave the server." },
  { pattern: /@azure\/identity/, why: "Azure SDK must stay inside packages/llm-provider-azure-openai." },
  { pattern: /@anthropic-ai\/sdk/, why: "Anthropic SDK must stay inside packages/llm-provider-anthropic." },
  {
    pattern: /services\.ai\.azure\.com|api\.anthropic\.com|api\.openai\.com/,
    why: "The browser talks to apps/api, never to a model provider directly.",
  },
];

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(js|mjs|json|css)$/.test(entry)) yield path;
  }
}

let scanned = 0;
const violations = [];
const missingDirs = [];

try {
  for (const bundle of BUNDLES) {
    if (!existsSync(bundle)) {
      missingDirs.push(bundle);
      continue;
    }
    let scannedInBundle = 0;
    for (const file of files(bundle)) {
      scanned += 1;
      scannedInBundle += 1;
      const content = readFileSync(file, "utf8");
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(content)) violations.push({ file, pattern: String(pattern), why });
      }
    }
    if (scannedInBundle === 0) {
      missingDirs.push(`${bundle} (no bundle files found)`);
    }
  }
} catch (error) {
  console.error(`Could not read bundle directories. Run build scripts first.\n${error.message}`);
  process.exit(1);
}

if (missingDirs.length > 0) {
  console.error(`Missing target bundle directories:\n  - ${missingDirs.join("\n  - ")}\nRun \`pnpm build\` first.`);
  process.exit(1);
}

if (violations.length > 0) {
  for (const { file, pattern, why } of violations) {
    console.error(`${file}\n  matched ${pattern}\n  ${why}`);
  }
  console.error(`\n${violations.length} violation(s). The browser bundle must contain no provider credentials or SDKs.`);
  process.exit(1);
}

console.log(`Client bundle clean: ${scanned} file(s), no provider credentials or SDKs.`);
