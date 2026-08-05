#!/usr/bin/env node
/**
 * One-off migration: add `.js` extensions to relative import/export specifiers.
 *
 * The repo emitted ESM under `moduleResolution: Bundler`, which leaves relative
 * specifiers extensionless. Node's ESM loader refuses those, so every built
 * package was unloadable by `node` -- invisible until something actually tried,
 * because vitest resolves through its own bundler.
 *
 * NodeNext fixes the emit but requires the source to spell the extension, and
 * TypeScript's `.js`-means-`.ts` convention is what makes that work.
 *
 * Idempotent. Skips apps/web, which stays on bundler resolution for Next.js.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".turbo"]);
const SKIP_PACKAGES = new Set([join(ROOT, "apps", "web")]);

/** `from "./x"` / `from "../x"` -- but not `"./x.js"`, `"./x.json"`, `"./x.css"`. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*)(["'])(\.{1,2}\/[^"']*?)\2/g;

function needsExtension(spec) {
  return !/\.(js|mjs|cjs|json|css|svg|png)$/.test(spec);
}

/** A directory specifier resolves to its `index.js`, not `<dir>.js`. */
function resolveSpecifier(fileDir, spec) {
  const target = join(fileDir, spec);
  if (existsSync(target) && statSync(target).isDirectory()) return `${spec}/index.js`;
  return `${spec}.js`;
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

const roots = [];
for (const group of ["packages", "apps"]) {
  const dir = join(ROOT, group);
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (SKIP_PACKAGES.has(full)) continue;
    roots.push(full);
  }
}

let changed = 0;
for (const root of roots) {
  for (const file of walk(root)) {
    const source = readFileSync(file, "utf8");
    const fileDir = dirname(file);
    const next = source.replace(SPECIFIER, (match, prefix, quote, spec) =>
      needsExtension(spec) ? `${prefix}${quote}${resolveSpecifier(fileDir, spec)}${quote}` : match,
    );
    if (next !== source) {
      writeFileSync(file, next);
      changed += 1;
    }
  }
}

console.log(`Added import extensions in ${changed} file(s).`);
