#!/usr/bin/env node
/**
 * Give every workspace package a `tsconfig.test.json` and point its `typecheck`
 * script at it.
 *
 * Why this exists: each package's tsconfig.json has `"include": ["src"]` so that
 * `dist` contains only source output. That is correct for `build`, but it meant
 * `typecheck` never looked at `tests/` -- test files were linted and executed,
 * but never typechecked. In a repo whose primary product is types, that is the
 * one place a mistake hides best.
 *
 * `tsconfig.test.json` turns off `composite`/`declaration` (it emits nothing) and
 * widens `include` to src + tests.
 *
 * Idempotent: safe to re-run after scaffolding new packages.
 */
import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const TEST_TSCONFIG = {
  extends: "./tsconfig.json",
  compilerOptions: {
    composite: false,
    declaration: false,
    declarationMap: false,
    noEmit: true,
    // The build config pins rootDir to src so dist stays flat. Tests live
    // outside it, so widen the root back to the package.
    rootDir: ".",
  },
  include: ["src", "tests"],
};

/** Apps own their tooling (next/vitest configs at the root of the app). */
const SKIP = new Set(["web"]);

let created = 0;
let rewired = 0;

for (const group of ["packages", "apps"]) {
  const groupDir = join(ROOT, group);
  if (!existsSync(groupDir)) continue;

  for (const name of readdirSync(groupDir)) {
    if (SKIP.has(name)) continue;
    const dir = join(groupDir, name);
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    if (!existsSync(join(dir, "tests"))) continue;

    const testConfigPath = join(dir, "tsconfig.test.json");
    if (!existsSync(testConfigPath)) {
      writeFileSync(testConfigPath, JSON.stringify(TEST_TSCONFIG, null, 2) + "\n");
      created++;
    }

    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const want = "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json";
    if (pkg.scripts?.typecheck !== want) {
      pkg.scripts.typecheck = want;
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
      rewired++;
    }
  }
}

console.log(`tsconfig.test.json: ${created} created, ${rewired} typecheck script(s) rewired.`);
