# Phase 10 — Vision Self-Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent inspects its own drawing and repairs it — a deterministic geometric critique that always runs, plus an optional image critique driven by a client-side agent, both feeding one bounded repair loop (AD-3).

**Architecture:** `agent-vision` owns both critique tiers and emits one `CritiqueFinding[]` shape from either, so the repair path is identical. Tier 1 is a pure function over `LayoutModel` + `StrokeAST`, run automatically before playback and on demand as a tool. Tier 2 runs in the browser as a second `agent-core` locus that captures the canvas in a Web Worker, POSTs it to a server route which makes the one multimodal call, and reports findings back — so `agent-core`, `LLMProvider` and `/api/agent/llm` need no multimodal changes.

**Tech Stack:** TypeScript (NodeNext), Zod 4, Vitest, Fastify, React 19 + Vite (`apps/studio`), Konva, pnpm + turbo.

**Spec:** `docs/superpowers/specs/2026-08-06-phase-10-vision-self-correction-design.md`

## Global Constraints

- **Layering** (`scripts/check-layering.mjs`): `agent-vision` is in the `agent` layer. It may import `agent-core` (same layer), and `llm-provider`, `renderer-core`, `shared-types` (below). It **must not** import `layout-engine`, `stroke-planner`, `constraint-engine` or any `core`-layer package.
- **No package reads `process.env`** except `llm-provider-azure-openai`. `apps/api/src/config.ts` is the one place the server reads it.
- **No provider SDK outside `packages/llm-provider-*`** — eslint `no-restricted-imports` enforces it.
- **Only `LayoutModel` and `StrokeAST` may contain numeric geometry.** `tests/geometry-purity.test.ts` enforces the converse. `CritiqueFinding.proposal.hint` is prose, never a coordinate.
- **Only `src/index.ts` is importable from outside a package**; `src/internal/**` is private, eslint-enforced.
- **Validation returns `ValidationResult`, never throws** (AD-2). Provider transport failures are the one exception and throw `LLMProviderError`.
- **Module resolution is `NodeNext`** — every relative import needs an explicit `.js` extension. `apps/studio` uses `Bundler`.
- Run `pnpm lint && pnpm typecheck && pnpm test` from the repo root before each commit that touches more than one package.

---

## File Structure

**Create:**
- `packages/shared-types/src/critique.ts` — `CritiqueFinding`, `FixProposal`, `CritiqueTier` schemas.
- `packages/agent-vision/src/internal/geometry.ts` — shared box/segment maths for the checks.
- `packages/agent-vision/src/internal/checks.ts` — the seven deterministic checks.
- `packages/agent-vision/src/internal/critique-geometry.ts` — assembles checks into `critiqueGeometry`.
- `packages/agent-vision/src/internal/critique-image.ts` — the one multimodal call.
- `packages/agent-vision/src/internal/prompt.ts` — the critique prompt template, as data.
- `packages/agent-vision/src/tools-server.ts` — `createVisionTools`.
- `packages/agent-vision/src/tools-client.ts` — `createClientVisionTools`, `VisionWorkspace`.
- `packages/agent-vision/src/client-agent.ts` — `runVisionAgent`.
- `packages/llm-provider/src/proxy.ts` — `createProxyProvider`.
- `apps/api/src/routes/vision.ts` — `POST /api/agent/vision-critique`.
- `apps/api/src/session/repair.ts` — the bounded repair turn.
- `apps/studio/src/workers/capture.worker.ts` — OffscreenCanvas PNG encode.
- `apps/studio/src/vision/captureClient.ts` — worker handle.
- `apps/studio/src/vision/bootstrap.ts` — builds and runs the client agent.

**Modify:**
- `packages/shared-types/src/index.ts`, `src/runtime.ts` (the `VisionCritique` event).
- `packages/llm-provider/src/types.ts`, `src/registry.ts`, `src/fake.ts`.
- `packages/llm-provider-azure-openai/src/internal/config.ts`, `packages/llm-provider-anthropic/src/internal/config.ts` and their `register*` functions.
- `packages/agent-vision/package.json`, `src/index.ts`.
- `apps/api/src/config.ts`, `src/provider.ts`, `src/server.ts`, `src/session/manager.ts`, `src/session/run.ts`, `src/routes/sessions.ts`.
- `apps/studio/src/App.tsx`, `src/hooks/useSession.ts`.
- `scripts/check-client-bundle.mjs`.

---

## Task 1: Critique models in `shared-types`

**Files:**
- Create: `packages/shared-types/src/critique.ts`
- Modify: `packages/shared-types/src/index.ts`, `packages/shared-types/src/runtime.ts:110-115`
- Test: `packages/shared-types/tests/critique.test.ts`

**Interfaces:**
- Consumes: `SchemaVersionSchema` from `./primitives.js`.
- Produces: `CritiqueTierSchema`/`CritiqueTier`, `CritiqueSeveritySchema`/`CritiqueSeverity`, `FixProposalSchema`/`FixProposal`, `CritiqueFindingSchema`/`CritiqueFinding`, `CritiqueReportSchema`/`CritiqueReport`. The `VisionCritique` runtime event becomes `{ tier, findings, accepted }`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared-types/tests/critique.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CritiqueFindingSchema,
  CritiqueReportSchema,
  RuntimeEventSchema,
  SCHEMA_VERSION,
} from "../src/index.js";

const FINDING = {
  id: "f1",
  tier: "geometric",
  check: "anchor-miss",
  severity: "error",
  message: "The rope does not meet the pulley's groove anchor.",
  objectIds: ["rope_1", "pulley_1"],
  proposal: { kind: "move_object", objectId: "rope_1", hint: "attach it to the groove" },
};

describe("CritiqueFinding", () => {
  it("accepts a well-formed finding", () => {
    const parsed = CritiqueFindingSchema.safeParse(FINDING);
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown tier", () => {
    const parsed = CritiqueFindingSchema.safeParse({ ...FINDING, tier: "vibes" });
    expect(parsed.success).toBe(false);
  });

  it("defaults objectIds to an empty array", () => {
    const { objectIds, ...rest } = FINDING;
    const parsed = CritiqueFindingSchema.parse(rest);
    expect(parsed.objectIds).toEqual([]);
  });

  it("makes the proposal optional", () => {
    const { proposal, ...rest } = FINDING;
    expect(CritiqueFindingSchema.safeParse(rest).success).toBe(true);
  });

  it("rejects a coordinate smuggled into a proposal", () => {
    const parsed = CritiqueFindingSchema.safeParse({
      ...FINDING,
      proposal: { kind: "move_object", objectId: "rope_1", hint: "here", x: 10, y: 20 },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("CritiqueReport", () => {
  it("round-trips a report", () => {
    const report = { version: SCHEMA_VERSION, tier: "visual", findings: [FINDING] };
    expect(CritiqueReportSchema.safeParse(report).success).toBe(true);
  });
});

describe("VisionCritique runtime event", () => {
  it("carries structured findings and a tier", () => {
    const parsed = RuntimeEventSchema.safeParse({
      sessionId: "s1",
      at: new Date().toISOString(),
      type: "VisionCritique",
      tier: "geometric",
      findings: [FINDING],
      accepted: true,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects the old string-array shape", () => {
    const parsed = RuntimeEventSchema.safeParse({
      sessionId: "s1",
      at: new Date().toISOString(),
      type: "VisionCritique",
      findings: ["looks wrong"],
      accepted: false,
    });
    expect(parsed.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sketchmind/shared-types exec vitest run tests/critique.test.ts`
Expected: FAIL — `CritiqueFindingSchema` is not exported.

- [ ] **Step 3: Write the schemas**

Create `packages/shared-types/src/critique.ts`:

```ts
/**
 * Critique findings (AD-3, Phase 10).
 *
 * One shape for both tiers. The geometric tier is deterministic code reading
 * models the pipeline already built; the visual tier is a model reading pixels.
 * They disagree about everything except what a finding looks like, which is why
 * the repair path never has to ask which one spoke.
 *
 * `hint` is prose and never a coordinate. A proposal describes intent -- "attach
 * it to the groove" -- and the solver remains the only thing that turns intent
 * into numbers. `.strict()` on every proposal variant is what stops a model
 * quietly attaching an `x` and a `y`.
 */
import { z } from "zod";
import { SchemaVersionSchema } from "./primitives.js";

export const CritiqueTierSchema = z.enum(["geometric", "visual"]);
export type CritiqueTier = z.infer<typeof CritiqueTierSchema>;

export const CritiqueSeveritySchema = z.enum(["info", "warning", "error"]);
export type CritiqueSeverity = z.infer<typeof CritiqueSeveritySchema>;

export const FixProposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("move_object"), objectId: z.string().min(1), hint: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("resize_object"), objectId: z.string().min(1), hint: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("reposition_label"), labelId: z.string().min(1), hint: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("add_missing_component"), description: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("redraw_object"), objectId: z.string().min(1), hint: z.string().min(1) }).strict(),
]);
export type FixProposal = z.infer<typeof FixProposalSchema>;

export const CritiqueFindingSchema = z.object({
  id: z.string().min(1),
  tier: CritiqueTierSchema,
  /** Stable check name, e.g. `anchor-miss`. Groups findings across rounds. */
  check: z.string().min(1),
  severity: CritiqueSeveritySchema,
  /** Plain language, addressed to the agent that will act on it. */
  message: z.string().min(1),
  objectIds: z.array(z.string().min(1)).default([]),
  proposal: FixProposalSchema.optional(),
});
export type CritiqueFinding = z.infer<typeof CritiqueFindingSchema>;

export const CritiqueReportSchema = z.object({
  version: SchemaVersionSchema,
  tier: CritiqueTierSchema,
  findings: z.array(CritiqueFindingSchema),
});
export type CritiqueReport = z.infer<typeof CritiqueReportSchema>;

/**
 * The comparison the round cap depends on. Findings are already sorted by
 * `critiqueGeometry`, so identity is a plain structural compare over the fields
 * that describe the problem -- ids are regenerated per round and would make
 * every round look new.
 */
export function findingsEqual(
  a: readonly CritiqueFinding[],
  b: readonly CritiqueFinding[],
): boolean {
  if (a.length !== b.length) return false;
  const key = (f: CritiqueFinding): string =>
    `${f.tier}|${f.check}|${f.severity}|${f.objectIds.join(",")}`;
  return a.every((finding, index) => key(finding) === key(b[index] as CritiqueFinding));
}
```

- [ ] **Step 4: Export it and replace the runtime event**

In `packages/shared-types/src/index.ts`, add after the `./stroke.js` line:

```ts
export * from "./critique.js";
```

In `packages/shared-types/src/runtime.ts`, add to the imports at the top:

```ts
import { CritiqueFindingSchema, CritiqueTierSchema } from "./critique.js";
```

Replace lines 110-115 (the `VisionCritique` member) with:

```ts
  z.object({
    ...base,
    type: z.literal("VisionCritique"),
    tier: CritiqueTierSchema,
    findings: z.array(CritiqueFindingSchema),
    /** Whether the agent acted on these findings or judged them not worth it. */
    accepted: z.boolean(),
  }),
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @sketchmind/shared-types test`
Expected: PASS, including the existing suites.

- [ ] **Step 6: Verify nothing else depended on the old event shape**

Run: `pnpm typecheck`
Expected: PASS. The old `VisionCritique` shape was unused; if anything fails, it is a real consumer and must be updated to the new fields.

- [ ] **Step 7: Commit**

```bash
git add packages/shared-types/src/critique.ts packages/shared-types/src/index.ts packages/shared-types/src/runtime.ts packages/shared-types/tests/critique.test.ts
git commit -m "feat(shared-types): add critique findings and fix proposals"
```

---

## Task 2: Geometry helpers in `agent-vision`

**Files:**
- Modify: `packages/agent-vision/package.json`
- Create: `packages/agent-vision/src/internal/geometry.ts`
- Test: `packages/agent-vision/tests/geometry.test.ts`

**Interfaces:**
- Consumes: `BoundingBox`, `Point` from `@sketchmind/shared-types`.
- Produces: `overlapArea(a, b): number`, `boxesOverlap(a, b, tolerance): boolean`, `containsBox(outer, inner): boolean`, `segmentsIntersect(p1, p2, p3, p4): boolean`, `distance(a, b): number`, `centroidOf(boxes): Point`.

- [ ] **Step 1: Add the dependencies `agent-vision` needs**

Edit `packages/agent-vision/package.json`, replacing the `dependencies` block:

```json
  "dependencies": {
    "@sketchmind/agent-core": "workspace:*",
    "@sketchmind/llm-provider": "workspace:*",
    "@sketchmind/renderer-core": "workspace:*",
    "@sketchmind/shared-types": "workspace:*",
    "zod": "^4.0.0"
  }
```

Run: `pnpm install`

Note: `renderer-core` is imported for the `CapturedImage` type only. Do **not** add `layout-engine` — `scripts/check-layering.mjs` permits it, but the spec forbids `agent-vision` becoming a second geometry authority.

- [ ] **Step 2: Write the failing test**

Create `packages/agent-vision/tests/geometry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  boxesOverlap,
  centroidOf,
  containsBox,
  distance,
  overlapArea,
  segmentsIntersect,
} from "../src/internal/geometry.js";

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe("overlapArea", () => {
  it("is zero for disjoint boxes", () => {
    expect(overlapArea(box(0, 0, 10, 10), box(20, 20, 10, 10))).toBe(0);
  });

  it("is zero for boxes that only touch", () => {
    expect(overlapArea(box(0, 0, 10, 10), box(10, 0, 10, 10))).toBe(0);
  });

  it("measures a partial overlap", () => {
    expect(overlapArea(box(0, 0, 10, 10), box(5, 5, 10, 10))).toBe(25);
  });
});

describe("boxesOverlap", () => {
  it("ignores an overlap within tolerance", () => {
    expect(boxesOverlap(box(0, 0, 10, 10), box(9.8, 0, 10, 10), 0.5)).toBe(false);
  });

  it("reports an overlap beyond tolerance", () => {
    expect(boxesOverlap(box(0, 0, 10, 10), box(5, 0, 10, 10), 0.5)).toBe(true);
  });
});

describe("containsBox", () => {
  it("is true when inner sits wholly inside outer", () => {
    expect(containsBox(box(0, 0, 100, 100), box(10, 10, 10, 10))).toBe(true);
  });

  it("is false when inner pokes out", () => {
    expect(containsBox(box(0, 0, 100, 100), box(95, 10, 10, 10))).toBe(false);
  });
});

describe("segmentsIntersect", () => {
  it("detects a crossing", () => {
    const hit = segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 });
    expect(hit).toBe(true);
  });

  it("does not report parallel segments", () => {
    const hit = segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 });
    expect(hit).toBe(false);
  });

  it("does not report segments that merely share an endpoint", () => {
    const hit = segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 5 });
    expect(hit).toBe(false);
  });
});

describe("distance", () => {
  it("measures a 3-4-5 triangle", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});

describe("centroidOf", () => {
  it("averages box centres", () => {
    expect(centroidOf([box(0, 0, 10, 10), box(10, 10, 10, 10)])).toEqual({ x: 10, y: 10 });
  });

  it("returns the origin for no boxes", () => {
    expect(centroidOf([])).toEqual({ x: 0, y: 0 });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @sketchmind/agent-vision exec vitest run tests/geometry.test.ts`
Expected: FAIL — cannot resolve `../src/internal/geometry.js`.

- [ ] **Step 4: Write the implementation**

Create `packages/agent-vision/src/internal/geometry.ts`:

```ts
/**
 * The arithmetic the checks share.
 *
 * `agent-vision` deliberately does not import `layout-engine`, even though the
 * layer graph would allow it. Critique is an observer: it reads the solver's
 * output as data and forms its own opinion. Reusing the solver's helpers would
 * make the two agree by construction, which is precisely the bug a critique tier
 * exists to catch.
 */
import type { BoundingBox, Point } from "@sketchmind/shared-types";

export function overlapArea(a: BoundingBox, b: BoundingBox): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Tolerance is a linear slack on each axis, not an area: two boxes sharing a
 * hairline edge are touching, and touching is how adjacent components are meant
 * to look.
 */
export function boxesOverlap(a: BoundingBox, b: BoundingBox, tolerance: number): boolean {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > tolerance && height > tolerance;
}

export function containsBox(outer: BoundingBox, inner: BoundingBox): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function orientation(a: Point, b: Point, c: Point): number {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < 1e-9) return 0;
  return value > 0 ? 1 : -1;
}

/**
 * Proper intersection only. Connectors that share an endpoint are joined at a
 * node, which is the normal case and not a crossing -- so collinear and
 * touching configurations return false rather than being reported to the agent
 * as something to fix.
 */
export function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);
  if (o1 === 0 || o2 === 0 || o3 === 0 || o4 === 0) return false;
  return o1 !== o2 && o3 !== o4;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function centroidOf(boxes: readonly BoundingBox[]): Point {
  if (boxes.length === 0) return { x: 0, y: 0 };
  const sum = boxes.reduce(
    (acc, b) => ({ x: acc.x + b.x + b.width / 2, y: acc.y + b.y + b.height / 2 }),
    { x: 0, y: 0 },
  );
  return { x: sum.x / boxes.length, y: sum.y / boxes.length };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @sketchmind/agent-vision exec vitest run tests/geometry.test.ts`
Expected: PASS (16 assertions).

- [ ] **Step 6: Commit**

```bash
git add packages/agent-vision/package.json packages/agent-vision/src/internal/geometry.ts packages/agent-vision/tests/geometry.test.ts pnpm-lock.yaml
git commit -m "feat(agent-vision): add geometry helpers for critique checks"
```

---

## Task 3: The seven geometric checks

**Files:**
- Create: `packages/agent-vision/src/internal/checks.ts`
- Test: `packages/agent-vision/tests/checks.test.ts`

**Interfaces:**
- Consumes: `overlapArea`, `boxesOverlap`, `containsBox`, `segmentsIntersect`, `distance`, `centroidOf` from Task 2; `CritiqueFinding` from Task 1.
- Produces: `CheckName` (union of the seven names), `DEFAULT_OPTIONS: Required<GeometricCritiqueOptions>`, `GeometricCritiqueOptions`, `CheckInput`, and `CHECKS: readonly Check[]` where `Check = { name: CheckName; run(input: CheckInput): CritiqueFinding[] }`.

- [ ] **Step 1: Write the failing test**

Create `packages/agent-vision/tests/checks.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CHECKS, DEFAULT_OPTIONS, type CheckInput } from "../src/internal/checks.js";
import type { DiagramAST, LayoutModel, StrokeAST } from "@sketchmind/shared-types";

const node = (objectId: string, x: number, y: number, width = 20, height = 20) => ({
  objectId,
  position: { x, y },
  size: { width, height },
  rotation: 0,
  bounds: { x, y, width, height },
  anchors: [],
  zIndex: 0,
});

const ast = { objects: [], relationships: [] } as unknown as DiagramAST;

function layout(partial: Partial<LayoutModel>): LayoutModel {
  return {
    version: "1.0.0",
    diagramId: "d1",
    strategy: "manual",
    canvas: { width: 200, height: 200 },
    nodes: [],
    connectors: [],
    labels: [],
    ...partial,
  } as LayoutModel;
}

function input(model: LayoutModel, strokes?: StrokeAST): CheckInput {
  return { ast, layout: model, options: DEFAULT_OPTIONS, ...(strokes ? { strokes } : {}) };
}

const runCheck = (name: string, checkInput: CheckInput) => {
  const check = CHECKS.find((c) => c.name === name);
  if (!check) throw new Error(`no check named ${name}`);
  return check.run(checkInput);
};

describe("overlap", () => {
  it("reports two nodes sitting on top of each other", () => {
    const found = runCheck("overlap", input(layout({ nodes: [node("a", 0, 0), node("b", 10, 10)] })));
    expect(found).toHaveLength(1);
    expect(found[0]?.objectIds.sort()).toEqual(["a", "b"]);
    expect(found[0]?.proposal?.kind).toBe("move_object");
  });

  it("stays silent for separated nodes", () => {
    expect(runCheck("overlap", input(layout({ nodes: [node("a", 0, 0), node("b", 100, 100)] })))).toEqual([]);
  });

  it("stays silent for nodes that merely touch", () => {
    expect(runCheck("overlap", input(layout({ nodes: [node("a", 0, 0), node("b", 20, 0)] })))).toEqual([]);
  });
});

describe("out-of-bounds", () => {
  it("reports a node outside the canvas", () => {
    const found = runCheck("out-of-bounds", input(layout({ nodes: [node("a", 190, 10)] })));
    expect(found).toHaveLength(1);
    expect(found[0]?.objectIds).toEqual(["a"]);
  });

  it("stays silent for a node inside the canvas", () => {
    expect(runCheck("out-of-bounds", input(layout({ nodes: [node("a", 10, 10)] })))).toEqual([]);
  });
});

describe("anchor-miss", () => {
  const anchored = layout({
    nodes: [
      { ...node("pulley", 0, 0), anchors: [{ name: "groove", point: { x: 10, y: 0 } }] },
      node("weight", 100, 100),
    ],
    connectors: [
      {
        relationshipId: "rope",
        routing: "straight",
        points: [
          { x: 40, y: 40 },
          { x: 110, y: 110 },
        ],
        metadata: { sourceAnchor: "pulley:groove" },
      },
    ],
  });

  it("reports an endpoint far from its declared anchor", () => {
    const found = runCheck("anchor-miss", input(anchored));
    expect(found).toHaveLength(1);
    expect(found[0]?.check).toBe("anchor-miss");
    expect(found[0]?.objectIds).toContain("pulley");
  });

  it("stays silent when the endpoint meets the anchor", () => {
    const met = layout({
      ...anchored,
      connectors: [
        {
          ...anchored.connectors[0]!,
          points: [
            { x: 10, y: 0 },
            { x: 110, y: 110 },
          ],
        },
      ],
    });
    expect(runCheck("anchor-miss", input(met))).toEqual([]);
  });
});

describe("connector-crossing", () => {
  it("reports two connectors that cross", () => {
    const crossing = layout({
      connectors: [
        { relationshipId: "r1", routing: "straight", points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] },
        { relationshipId: "r2", routing: "straight", points: [{ x: 0, y: 100 }, { x: 100, y: 0 }] },
      ],
    });
    expect(runCheck("connector-crossing", input(crossing))).toHaveLength(1);
  });

  it("stays silent for parallel connectors", () => {
    const parallel = layout({
      connectors: [
        { relationshipId: "r1", routing: "straight", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
        { relationshipId: "r2", routing: "straight", points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] },
      ],
    });
    expect(runCheck("connector-crossing", input(parallel))).toEqual([]);
  });
});

describe("degenerate-size", () => {
  it("reports a zero-sized node", () => {
    const found = runCheck("degenerate-size", input(layout({ nodes: [node("a", 10, 10, 0, 0)] })));
    expect(found).toHaveLength(1);
    expect(found[0]?.proposal?.kind).toBe("resize_object");
  });

  it("stays silent for a normal node", () => {
    expect(runCheck("degenerate-size", input(layout({ nodes: [node("a", 10, 10)] })))).toEqual([]);
  });
});

describe("whitespace-imbalance", () => {
  it("reports content bunched into one corner", () => {
    const found = runCheck(
      "whitespace-imbalance",
      input(layout({ nodes: [node("a", 0, 0), node("b", 20, 0)] })),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("info");
    expect(found[0]?.proposal).toBeUndefined();
  });

  it("stays silent for centred content", () => {
    const centred = layout({ nodes: [node("a", 80, 80, 40, 40)] });
    expect(runCheck("whitespace-imbalance", input(centred))).toEqual([]);
  });
});

describe("stroke-coverage", () => {
  const strokes = (targets: string[]): StrokeAST =>
    ({
      version: "1.0.0",
      diagramId: "d1",
      strokes: targets.map((target, index) => ({
        id: `s${index}`,
        type: "rectangle",
        target,
        order: index,
        dependencies: [],
        points: [{ x: 0, y: 0 }],
        style: {},
        timing: {},
      })),
    }) as unknown as StrokeAST;

  it("reports a node nothing drew", () => {
    const found = runCheck(
      "stroke-coverage",
      input(layout({ nodes: [node("a", 0, 0), node("b", 100, 100)] }), strokes(["a"])),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.objectIds).toEqual(["b"]);
  });

  it("stays silent when every node is drawn", () => {
    const found = runCheck(
      "stroke-coverage",
      input(layout({ nodes: [node("a", 0, 0)] }), strokes(["a"])),
    );
    expect(found).toEqual([]);
  });

  it("is skipped when there is no stroke AST", () => {
    expect(runCheck("stroke-coverage", input(layout({ nodes: [node("a", 0, 0)] })))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sketchmind/agent-vision exec vitest run tests/checks.test.ts`
Expected: FAIL — cannot resolve `../src/internal/checks.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/agent-vision/src/internal/checks.ts`:

```ts
/**
 * The seven deterministic checks (Phase 10 tier 1).
 *
 * Each is a pure function from the models the pipeline already produced to a
 * list of findings, and each is independently switchable. They cost no tokens
 * and no model call, which is what lets them run on every diagram rather than on
 * the ones someone remembered to inspect.
 *
 * Every threshold is an option with a documented default. A check that needed a
 * magic number in its body would be untunable without an edit, and tuning is
 * exactly what these need as real diagrams arrive.
 */
import type {
  BoundingBox,
  CritiqueFinding,
  DiagramAST,
  LayoutModel,
  StrokeAST,
} from "@sketchmind/shared-types";
import {
  boxesOverlap,
  centroidOf,
  containsBox,
  distance,
  segmentsIntersect,
} from "./geometry.js";

export type CheckName =
  | "overlap"
  | "out-of-bounds"
  | "anchor-miss"
  | "connector-crossing"
  | "degenerate-size"
  | "whitespace-imbalance"
  | "stroke-coverage";

export interface GeometricCritiqueOptions {
  /** Linear slack before two boxes count as overlapping. */
  readonly overlapToleranceUnits?: number;
  /** How far a connector endpoint may sit from its declared anchor. */
  readonly anchorToleranceUnits?: number;
  /** Below this on either axis, a node is degenerate. */
  readonly minDimensionUnits?: number;
  /** Centroid offset from canvas centre, as a fraction of canvas size. */
  readonly whitespaceImbalanceRatio?: number;
  readonly checks?: Partial<Record<CheckName, boolean>>;
}

export const DEFAULT_OPTIONS: Required<Omit<GeometricCritiqueOptions, "checks">> & {
  checks: Record<CheckName, boolean>;
} = {
  overlapToleranceUnits: 0.5,
  anchorToleranceUnits: 2,
  minDimensionUnits: 1,
  whitespaceImbalanceRatio: 0.25,
  checks: {
    overlap: true,
    "out-of-bounds": true,
    "anchor-miss": true,
    "connector-crossing": true,
    "degenerate-size": true,
    "whitespace-imbalance": true,
    "stroke-coverage": true,
  },
};

export interface CheckInput {
  readonly ast: DiagramAST;
  readonly layout: LayoutModel;
  readonly strokes?: StrokeAST;
  readonly options: typeof DEFAULT_OPTIONS;
}

export interface Check {
  readonly name: CheckName;
  run(input: CheckInput): CritiqueFinding[];
}

/**
 * Ids are derived from the check and the objects rather than generated, so the
 * same problem produces the same id every round. The round-cap comparison does
 * not depend on this -- `findingsEqual` ignores ids -- but a stable id is what
 * lets a UI keep a finding selected across a re-critique.
 */
function finding(
  check: CheckName,
  severity: CritiqueFinding["severity"],
  message: string,
  objectIds: string[],
  proposal?: CritiqueFinding["proposal"],
): CritiqueFinding {
  return {
    id: `${check}:${objectIds.join("+") || "diagram"}`,
    tier: "geometric",
    check,
    severity,
    message,
    objectIds,
    ...(proposal ? { proposal } : {}),
  };
}

const canvasBox = (layout: LayoutModel): BoundingBox => ({
  x: 0,
  y: 0,
  width: layout.canvas.width,
  height: layout.canvas.height,
});

const overlap: Check = {
  name: "overlap",
  run({ layout, options }) {
    const found: CritiqueFinding[] = [];
    const { nodes, labels } = layout;

    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        // Containment is a legitimate arrangement -- Phase 6's `intersects`
        // exemption -- so only partial overlap is a finding.
        if (containsBox(a.bounds, b.bounds) || containsBox(b.bounds, a.bounds)) continue;
        if (!boxesOverlap(a.bounds, b.bounds, options.overlapToleranceUnits)) continue;
        found.push(
          finding("overlap", "error", `"${a.objectId}" and "${b.objectId}" overlap on the board.`, [
            a.objectId,
            b.objectId,
          ], { kind: "move_object", objectId: b.objectId, hint: `move it clear of "${a.objectId}"` }),
        );
      }
    }

    for (const label of labels) {
      for (const nodeItem of nodes) {
        if (label.targetId === nodeItem.objectId) continue;
        if (!boxesOverlap(label.bounds, nodeItem.bounds, options.overlapToleranceUnits)) continue;
        found.push(
          finding(
            "overlap",
            "warning",
            `Label "${label.text}" sits on top of "${nodeItem.objectId}".`,
            [label.labelId, nodeItem.objectId],
            { kind: "reposition_label", labelId: label.labelId, hint: "move it to clear space" },
          ),
        );
      }
    }

    return found;
  },
};

const outOfBounds: Check = {
  name: "out-of-bounds",
  run({ layout }) {
    const canvas = canvasBox(layout);
    const found: CritiqueFinding[] = [];

    for (const nodeItem of layout.nodes) {
      if (containsBox(canvas, nodeItem.bounds)) continue;
      found.push(
        finding("out-of-bounds", "error", `"${nodeItem.objectId}" extends past the canvas edge.`, [
          nodeItem.objectId,
        ], { kind: "move_object", objectId: nodeItem.objectId, hint: "bring it inside the canvas" }),
      );
    }

    for (const label of layout.labels) {
      if (containsBox(canvas, label.bounds)) continue;
      found.push(
        finding("out-of-bounds", "warning", `Label "${label.text}" extends past the canvas edge.`, [
          label.labelId,
        ], { kind: "reposition_label", labelId: label.labelId, hint: "bring it inside the canvas" }),
      );
    }

    return found;
  },
};

const anchorMiss: Check = {
  name: "anchor-miss",
  run({ layout, options }) {
    const found: CritiqueFinding[] = [];
    const byId = new Map(layout.nodes.map((n) => [n.objectId, n]));

    for (const connector of layout.connectors) {
      // The solver records which anchor each end was routed to. Without that
      // there is nothing to check against -- an endpoint in open space is a
      // routing choice, not a miss.
      const meta = connector.metadata ?? {};
      for (const [key, index] of [
        ["sourceAnchor", 0],
        ["targetAnchor", connector.points.length - 1],
      ] as const) {
        const ref = meta[key];
        if (typeof ref !== "string") continue;
        const [objectId, anchorName] = ref.split(":");
        if (!objectId || !anchorName) continue;

        const target = byId.get(objectId);
        const anchor = target?.anchors.find((a) => a.name === anchorName);
        if (!anchor) continue;

        const endpoint = connector.points[index]!;
        const gap = distance(endpoint, anchor.point);
        if (gap <= options.anchorToleranceUnits) continue;

        found.push(
          finding(
            "anchor-miss",
            "error",
            `Connector "${connector.relationshipId}" does not meet "${objectId}"'s ` +
              `"${anchorName}" anchor.`,
            [objectId, connector.relationshipId],
            {
              kind: "move_object",
              objectId,
              hint: `attach the connector to the "${anchorName}" anchor`,
            },
          ),
        );
      }
    }

    return found;
  },
};

const connectorCrossing: Check = {
  name: "connector-crossing",
  run({ layout }) {
    const found: CritiqueFinding[] = [];
    const connectors = layout.connectors;

    for (let i = 0; i < connectors.length; i += 1) {
      for (let j = i + 1; j < connectors.length; j += 1) {
        const a = connectors[i]!;
        const b = connectors[j]!;
        if (!crosses(a.points, b.points)) continue;
        found.push(
          finding(
            "connector-crossing",
            "warning",
            `Connectors "${a.relationshipId}" and "${b.relationshipId}" cross.`,
            [a.relationshipId, b.relationshipId],
            {
              kind: "redraw_object",
              objectId: b.relationshipId,
              hint: "route it around the other connector",
            },
          ),
        );
      }
    }

    return found;
  },
};

function crosses(a: readonly { x: number; y: number }[], b: readonly { x: number; y: number }[]): boolean {
  for (let i = 0; i < a.length - 1; i += 1) {
    for (let j = 0; j < b.length - 1; j += 1) {
      if (segmentsIntersect(a[i]!, a[i + 1]!, b[j]!, b[j + 1]!)) return true;
    }
  }
  return false;
}

const degenerateSize: Check = {
  name: "degenerate-size",
  run({ layout, options }) {
    return layout.nodes
      .filter(
        (n) => n.size.width < options.minDimensionUnits || n.size.height < options.minDimensionUnits,
      )
      .map((n) =>
        finding("degenerate-size", "error", `"${n.objectId}" has no usable size.`, [n.objectId], {
          kind: "resize_object",
          objectId: n.objectId,
          hint: "give it a visible width and height",
        }),
      );
  },
};

const whitespaceImbalance: Check = {
  name: "whitespace-imbalance",
  run({ layout, options }) {
    if (layout.nodes.length === 0) return [];

    const centre = centroidOf(layout.nodes.map((n) => n.bounds));
    const dx = Math.abs(centre.x - layout.canvas.width / 2) / layout.canvas.width;
    const dy = Math.abs(centre.y - layout.canvas.height / 2) / layout.canvas.height;
    if (dx <= options.whitespaceImbalanceRatio && dy <= options.whitespaceImbalanceRatio) return [];

    // Advisory only, and deliberately without a proposal: which object should
    // move to balance a diagram is a judgement, and inventing one here would
    // send the agent chasing a number rather than looking at the picture.
    return [
      finding(
        "whitespace-imbalance",
        "info",
        "The diagram's content is bunched to one side; the board looks unbalanced.",
        [],
      ),
    ];
  },
};

const strokeCoverage: Check = {
  name: "stroke-coverage",
  run({ layout, strokes }) {
    if (!strokes) return [];
    const drawn = new Set(strokes.strokes.map((s) => s.target));
    return layout.nodes
      .filter((n) => !drawn.has(n.objectId))
      .map((n) =>
        finding("stroke-coverage", "error", `Nothing was drawn for "${n.objectId}".`, [n.objectId], {
          kind: "redraw_object",
          objectId: n.objectId,
          hint: "plan strokes for it",
        }),
      );
  },
};

export const CHECKS: readonly Check[] = [
  overlap,
  outOfBounds,
  anchorMiss,
  connectorCrossing,
  degenerateSize,
  whitespaceImbalance,
  strokeCoverage,
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sketchmind/agent-vision exec vitest run tests/checks.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vision/src/internal/checks.ts packages/agent-vision/tests/checks.test.ts
git commit -m "feat(agent-vision): add the seven geometric critique checks"
```

---

## Task 4: `critiqueGeometry` and the server tool

**Files:**
- Create: `packages/agent-vision/src/internal/critique-geometry.ts`, `packages/agent-vision/src/tools-server.ts`
- Modify: `packages/agent-vision/src/index.ts`
- Test: `packages/agent-vision/tests/critique-geometry.test.ts`, `packages/agent-vision/tests/tools-server.test.ts`

**Interfaces:**
- Consumes: `CHECKS`, `DEFAULT_OPTIONS`, `GeometricCritiqueOptions` from Task 3; `defineTool`, `ToolDefinition` from `@sketchmind/agent-core`.
- Produces: `critiqueGeometry(input: CritiqueGeometryInput): CritiqueFinding[]`, `createVisionTools(options: VisionToolsOptions): ToolDefinition[]` where `VisionToolsOptions = { getAst: () => DiagramAST | undefined; getLayout: () => LayoutModel | undefined; getStrokes: () => StrokeAST | undefined; options?: GeometricCritiqueOptions }`.

- [ ] **Step 1: Write the failing test for `critiqueGeometry`**

Create `packages/agent-vision/tests/critique-geometry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { critiqueGeometry } from "../src/index.js";
import type { DiagramAST, LayoutModel } from "@sketchmind/shared-types";

const ast = { objects: [], relationships: [] } as unknown as DiagramAST;

const node = (objectId: string, x: number, y: number, width = 20, height = 20) => ({
  objectId,
  position: { x, y },
  size: { width, height },
  rotation: 0,
  bounds: { x, y, width, height },
  anchors: [],
  zIndex: 0,
});

const layout = (nodes: ReturnType<typeof node>[]): LayoutModel =>
  ({
    version: "1.0.0",
    diagramId: "d1",
    strategy: "manual",
    canvas: { width: 200, height: 200 },
    nodes,
    connectors: [],
    labels: [],
  }) as LayoutModel;

describe("critiqueGeometry", () => {
  it("returns nothing for a clean diagram", () => {
    expect(critiqueGeometry({ ast, layout: layout([node("a", 90, 90)]) })).toEqual([]);
  });

  it("collects findings from several checks at once", () => {
    const found = critiqueGeometry({
      ast,
      layout: layout([node("a", 0, 0), node("b", 10, 10), node("c", 195, 195, 0, 0)]),
    });
    const checks = new Set(found.map((f) => f.check));
    expect(checks.has("overlap")).toBe(true);
    expect(checks.has("degenerate-size")).toBe(true);
    expect(checks.has("out-of-bounds")).toBe(true);
  });

  it("is deterministic: the same input yields an identically ordered array", () => {
    const model = layout([node("b", 10, 10), node("a", 0, 0)]);
    const first = critiqueGeometry({ ast, layout: model });
    const second = critiqueGeometry({ ast, layout: model });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("honours a disabled check", () => {
    const found = critiqueGeometry({
      ast,
      layout: layout([node("a", 0, 0), node("b", 10, 10)]),
      options: { checks: { overlap: false } },
    });
    expect(found.some((f) => f.check === "overlap")).toBe(false);
  });

  it("honours a widened overlap tolerance", () => {
    const found = critiqueGeometry({
      ast,
      layout: layout([node("a", 0, 0), node("b", 10, 10)]),
      options: { overlapToleranceUnits: 50 },
    });
    expect(found.some((f) => f.check === "overlap")).toBe(false);
  });

  it("tags every finding as geometric", () => {
    const found = critiqueGeometry({ ast, layout: layout([node("a", 0, 0), node("b", 10, 10)]) });
    expect(found.every((f) => f.tier === "geometric")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sketchmind/agent-vision exec vitest run tests/critique-geometry.test.ts`
Expected: FAIL — `critiqueGeometry` is not exported.

- [ ] **Step 3: Implement `critiqueGeometry`**

Create `packages/agent-vision/src/internal/critique-geometry.ts`:

```ts
/**
 * Tier 1: run every enabled check and return one sorted list.
 *
 * Sorting is not cosmetic. The round cap compares this round's findings against
 * the last round's, and an unordered list would make an unchanged diagram look
 * different every time -- which would defeat the one mechanism that stops the
 * repair loop oscillating.
 */
import type {
  CritiqueFinding,
  DiagramAST,
  LayoutModel,
  StrokeAST,
} from "@sketchmind/shared-types";
import { CHECKS, DEFAULT_OPTIONS, type GeometricCritiqueOptions } from "./checks.js";

export interface CritiqueGeometryInput {
  readonly ast: DiagramAST;
  readonly layout: LayoutModel;
  readonly strokes?: StrokeAST;
  readonly options?: GeometricCritiqueOptions;
}

export function critiqueGeometry(input: CritiqueGeometryInput): CritiqueFinding[] {
  const options = {
    ...DEFAULT_OPTIONS,
    ...input.options,
    checks: { ...DEFAULT_OPTIONS.checks, ...input.options?.checks },
  };

  const checkInput = {
    ast: input.ast,
    layout: input.layout,
    options,
    ...(input.strokes ? { strokes: input.strokes } : {}),
  };

  const findings = CHECKS.filter((check) => options.checks[check.name]).flatMap((check) =>
    check.run(checkInput),
  );

  return findings.sort((a, b) =>
    a.check === b.check ? a.id.localeCompare(b.id) : a.check.localeCompare(b.check),
  );
}
```

- [ ] **Step 4: Export from the package index**

Replace the contents of `packages/agent-vision/src/index.ts`:

```ts
/**
 * @sketchmind/agent-vision
 *
 * Self-correction (AD-3): the agent looks at what it drew and says what is
 * wrong with it. Two tiers, one finding shape.
 *
 * Tier 1 is deterministic software reading the `LayoutModel` and `StrokeAST` the
 * pipeline already produced -- free, instant, and catching most of what actually
 * goes wrong. Tier 2 is a model looking at pixels, which is the only thing that
 * can notice a diagram does not *read* as a pulley system. Both emit
 * `CritiqueFinding[]`, so the repair loop never asks which one spoke.
 *
 * This package does not import `layout-engine`. Critique is an observer that
 * forms its own opinion from the solver's output; sharing the solver's helpers
 * would make the two agree by construction.
 *
 * Public API only. Implementation belongs in src/internal/ (Volume 12).
 */

export const PACKAGE_NAME = "@sketchmind/agent-vision";
export const PACKAGE_VERSION = "0.0.1";

export {
  critiqueGeometry,
  type CritiqueGeometryInput,
} from "./internal/critique-geometry.js";

export {
  DEFAULT_OPTIONS as DEFAULT_GEOMETRIC_OPTIONS,
  type CheckName,
  type GeometricCritiqueOptions,
} from "./internal/checks.js";

export { createVisionTools, type VisionToolsOptions } from "./tools-server.js";
```

- [ ] **Step 5: Write the failing test for the server tool**

Create `packages/agent-vision/tests/tools-server.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createVisionTools } from "../src/index.js";
import type { DiagramAST, LayoutModel } from "@sketchmind/shared-types";

const ast = { objects: [], relationships: [] } as unknown as DiagramAST;

const layout: LayoutModel = {
  version: "1.0.0",
  diagramId: "d1",
  strategy: "manual",
  canvas: { width: 200, height: 200 },
  nodes: [
    { objectId: "a", position: { x: 0, y: 0 }, size: { width: 20, height: 20 }, rotation: 0, bounds: { x: 0, y: 0, width: 20, height: 20 }, anchors: [], zIndex: 0 },
    { objectId: "b", position: { x: 10, y: 10 }, size: { width: 20, height: 20 }, rotation: 0, bounds: { x: 10, y: 10, width: 20, height: 20 }, anchors: [], zIndex: 0 },
  ],
  connectors: [],
  labels: [],
} as LayoutModel;

const context = {
  sessionId: "s1",
  signal: new AbortController().signal,
  locus: "server" as const,
  toolCallId: "c1",
};

describe("critique_diagram", () => {
  it("is registered under the expected name and locus", () => {
    const [tool] = createVisionTools({
      getAst: () => ast,
      getLayout: () => layout,
      getStrokes: () => undefined,
    });
    expect(tool?.name).toBe("critique_diagram");
    expect(tool?.locus).toBe("server");
    expect(tool?.readOnly).toBe(true);
  });

  it("returns findings for a flawed layout", async () => {
    const [tool] = createVisionTools({
      getAst: () => ast,
      getLayout: () => layout,
      getStrokes: () => undefined,
    });
    const result = (await tool!.handler({}, context)) as { ok: true; value: { findings: unknown[] } };
    expect(result.ok).toBe(true);
    expect(result.value.findings.length).toBeGreaterThan(0);
  });

  it("fails recoverably when no layout has been solved", async () => {
    const [tool] = createVisionTools({
      getAst: () => ast,
      getLayout: () => undefined,
      getStrokes: () => undefined,
    });
    const result = (await tool!.handler({}, context)) as {
      ok: false;
      errors: { code: string; recoverable: boolean }[];
    };
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("CRITIQUE_MISSING_INPUT");
    expect(result.errors[0]?.recoverable).toBe(true);
  });
});
```

- [ ] **Step 6: Implement the server tool**

Create `packages/agent-vision/src/tools-server.ts`:

```ts
/**
 * `critique_diagram`: tier 1 as something the agent may call whenever it likes.
 *
 * The same critique also runs automatically before playback. Having both is not
 * duplication -- the automatic pass guarantees no diagram ships uninspected, and
 * the tool lets the agent check its work mid-run, before it has spent the rest
 * of its budget planning strokes for a layout that was already wrong.
 *
 * `readOnly: true` is exact: this tool changes nothing. It reports.
 */
import { defineTool, type ToolDefinition } from "@sketchmind/agent-core";
import {
  fail,
  makeError,
  ok,
  type DiagramAST,
  type LayoutModel,
  type StrokeAST,
} from "@sketchmind/shared-types";
import { z } from "zod";
import { critiqueGeometry } from "./internal/critique-geometry.js";
import type { GeometricCritiqueOptions } from "./internal/checks.js";

export const PACKAGE = "@sketchmind/agent-vision";

export interface VisionToolsOptions {
  readonly getAst: () => DiagramAST | undefined;
  readonly getLayout: () => LayoutModel | undefined;
  readonly getStrokes: () => StrokeAST | undefined;
  readonly options?: GeometricCritiqueOptions;
}

export function createVisionTools(toolOptions: VisionToolsOptions): ToolDefinition[] {
  const critique = defineTool({
    name: "critique_diagram",
    description:
      "Inspect the solved diagram for problems a viewer would notice: objects overlapping, " +
      "things off the edge of the board, connectors that miss the anchor they were meant to " +
      "meet, connectors crossing, objects with no usable size, an unbalanced board, and objects " +
      "nothing was drawn for. Requires solve_layout to have run. Costs nothing and changes " +
      "nothing -- call it whenever you want to know whether the diagram is right before " +
      "committing more effort to it.",
    locus: "server",
    readOnly: true,
    argsSchema: z.object({}),
    handler: () => {
      const ast = toolOptions.getAst();
      const layout = toolOptions.getLayout();
      if (!ast || !layout) {
        return fail([
          makeError({
            code: "CRITIQUE_MISSING_INPUT",
            message:
              "There is no solved layout to inspect yet. Call compose_diagram_ast, " +
              "derive_constraints and solve_layout first.",
            package: PACKAGE,
            stage: "layout",
            recoverable: true,
          }),
        ]);
      }

      const strokes = toolOptions.getStrokes();
      const findings = critiqueGeometry({
        ast,
        layout,
        ...(strokes ? { strokes } : {}),
        ...(toolOptions.options ? { options: toolOptions.options } : {}),
      });

      return ok({
        findings,
        // A count the model can act on without reading the whole list.
        errorCount: findings.filter((f) => f.severity === "error").length,
      });
    },
  });

  return [critique];
}
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @sketchmind/agent-vision test`
Expected: PASS. Delete the scaffold placeholder assertions in `packages/agent-vision/tests/index.test.ts` if they assert an empty API surface; keep any that assert `PACKAGE_NAME`.

- [ ] **Step 8: Verify layering and types**

Run: `pnpm check:layering && pnpm --filter @sketchmind/agent-vision run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/agent-vision/src packages/agent-vision/tests
git commit -m "feat(agent-vision): add critiqueGeometry and the critique_diagram tool"
```

---

## Task 5: Per-role model override in `llm-provider`

**Files:**
- Modify: `packages/llm-provider/src/registry.ts`, `packages/llm-provider/src/fake.ts`
- Modify: `packages/llm-provider-azure-openai/src/internal/config.ts` and its `register` function
- Modify: `packages/llm-provider-anthropic/src/internal/config.ts` and its `register` function
- Test: `packages/llm-provider/tests/registry-model-override.test.ts`

**Interfaces:**
- Produces: `ProviderOptions { readonly model?: string }`, `ProviderFactory = (env: ProviderEnv, options?: ProviderOptions) => LLMProvider`, `ProviderRegistry.create(id, env, options?)`.
- Consumed by: Task 6's `resolveRoleProvider`.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-provider/tests/registry-model-override.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeProvider, ProviderRegistry } from "../src/index.js";

describe("ProviderRegistry model override", () => {
  it("passes the override to the factory", () => {
    const registry = new ProviderRegistry();
    registry.register("fake", (_env, options) => new FakeProvider({ model: options?.model }));

    const provider = registry.create("fake", {}, { model: "gpt-4o" });
    expect(provider.model).toBe("gpt-4o");
  });

  it("leaves the factory's own choice alone when omitted", () => {
    const registry = new ProviderRegistry();
    registry.register("fake", (_env, options) => new FakeProvider({ model: options?.model }));

    expect(registry.create("fake", {}).model).toBe("fake-model");
  });

  it("still works for a factory that ignores the second argument", () => {
    const registry = new ProviderRegistry();
    registry.register("legacy", () => new FakeProvider({ id: "legacy" }));

    expect(registry.create("legacy", {}, { model: "ignored" }).id).toBe("legacy");
  });
});

describe("FakeProvider", () => {
  it("honours a model option", () => {
    expect(new FakeProvider({ model: "claude-sonnet-5" }).model).toBe("claude-sonnet-5");
  });

  it("can declare vision", () => {
    expect(new FakeProvider({ capabilities: { vision: true } }).capabilities.vision).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sketchmind/llm-provider exec vitest run tests/registry-model-override.test.ts`
Expected: FAIL — `create` takes two arguments; TypeScript rejects the third.

- [ ] **Step 3: Add `ProviderOptions` to the registry**

In `packages/llm-provider/src/registry.ts`, replace the `ProviderFactory` type and the `create` method:

```ts
/**
 * Per-role construction options.
 *
 * Phase 10 resolves two model *roles* -- `text` and `vision` -- which may name
 * different providers, different models, or both. A role selecting a different
 * deployment on the *same* adapter is the case env alone cannot express, because
 * each adapter reads exactly one model variable. This override is the whole
 * mechanism, and it stays here rather than in the composition root so that
 * `AZURE_OPENAI_DEPLOYMENT` and `ANTHROPIC_MODEL` remain names only their own
 * packages know.
 */
export interface ProviderOptions {
  /** Overrides the model or deployment the adapter would take from env. */
  readonly model?: string;
}

export type ProviderFactory = (env: ProviderEnv, options?: ProviderOptions) => LLMProvider;
```

and in the class:

```ts
  create(id: string, env: ProviderEnv, options?: ProviderOptions): LLMProvider {
    const factory = this.factories.get(id);
    if (!factory) {
      throw providerError(
        ProviderErrorCode.Misconfigured,
        `Unknown LLM provider "${id}". Registered: ${this.ids().join(", ") || "<none>"}. ` +
          `Register the adapter at the composition root before selecting it.`,
        PACKAGE,
      );
    }
    return factory(env, options);
  }
```

- [ ] **Step 4: Thread it through the adapters**

In `packages/llm-provider-azure-openai/src/internal/config.ts`, change the config reader's signature so the deployment can be overridden. Find the line reading `AZURE_OPENAI_DEPLOYMENT` (line 101) and the function that contains it; add an `options` parameter to that function and replace the assignment:

```ts
  const deployment = options?.model?.trim() || env["AZURE_OPENAI_DEPLOYMENT"]?.trim() || "";
```

Then in the same file, make `vision` honest for the constructed deployment — replace line 80:

```ts
    // A deployment is vision-capable when it *is* the vision deployment. A role
    // that selected it explicitly gets a truthful flag; the text role pointed at
    // a text deployment still reports false.
    vision:
      (env["AZURE_OPENAI_VISION_DEPLOYMENT"]?.trim() ?? "") !== "" &&
      (options?.model?.trim() ?? env["AZURE_OPENAI_DEPLOYMENT"]?.trim() ?? "") ===
        env["AZURE_OPENAI_VISION_DEPLOYMENT"]?.trim(),
```

In `packages/llm-provider-anthropic/src/internal/config.ts`, replace line 91:

```ts
    model: options?.model?.trim() || env["ANTHROPIC_MODEL"]?.trim() || DEFAULT_MODEL,
```

In both packages, update the exported `registerAzureOpenAI` / `registerAnthropic` functions to forward the second argument, e.g.:

```ts
export function registerAzureOpenAI(registry: ProviderRegistry): void {
  registry.register("azure-openai", (env, options) => new AzureOpenAIProvider(env, options));
}
```

Adjust the provider constructors to accept and forward `options?: ProviderOptions` to their config reader.

- [ ] **Step 5: Run the affected suites**

Run: `pnpm --filter @sketchmind/llm-provider test && pnpm --filter @sketchmind/llm-provider-azure-openai test && pnpm --filter @sketchmind/llm-provider-anthropic test`
Expected: PASS. Existing tests must be unchanged — the override is additive and omitting it preserves current behaviour exactly.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-provider packages/llm-provider-azure-openai packages/llm-provider-anthropic
git commit -m "feat(llm-provider): allow a per-role model override on provider construction"
```

---

## Task 6: Vision config and role resolution in `apps/api`

**Files:**
- Modify: `apps/api/src/config.ts`, `apps/api/src/provider.ts`
- Test: `apps/api/tests/vision-config.test.ts`

**Interfaces:**
- Consumes: `ProviderOptions`, `ProviderRegistry.create` from Task 5; `GeometricCritiqueOptions` from Task 4.
- Produces: `ApiConfig.vision: VisionConfig`, `resolveRoleProvider(role, env)`, `type ProviderRole = "text" | "vision"`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/vision-config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { resolveRoleProvider } from "../src/provider.js";

describe("vision config", () => {
  it("defaults to geometric on and visual off", () => {
    const config = loadConfig({});
    expect(config.vision.geometric).toBe(true);
    expect(config.vision.mode).toBe("off");
  });

  it("reads the mode", () => {
    expect(loadConfig({ SKETCHMIND_VISION_MODE: "auto" }).vision.mode).toBe("auto");
    expect(loadConfig({ SKETCHMIND_VISION_MODE: "on" }).vision.mode).toBe("on");
  });

  it("falls back to off for an unrecognised mode", () => {
    expect(loadConfig({ SKETCHMIND_VISION_MODE: "yes please" }).vision.mode).toBe("off");
  });

  it("caps rounds and image size with documented defaults", () => {
    const config = loadConfig({});
    expect(config.vision.maxRounds).toBe(2);
    expect(config.vision.maxImageBytes).toBe(4_000_000);
    expect(config.repair.maxRounds).toBe(2);
    expect(config.repair.maxSteps).toBe(12);
  });
});

describe("resolveRoleProvider", () => {
  it("returns undefined when nothing is configured", () => {
    expect(resolveRoleProvider("text", {})).toBeUndefined();
    expect(resolveRoleProvider("vision", {})).toBeUndefined();
  });

  it("returns undefined for the vision role when the provider cannot see", () => {
    const env = { SKETCHMIND_LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", ANTHROPIC_VISION: "false" };
    expect(resolveRoleProvider("vision", env)).toBeUndefined();
  });

  it("resolves the vision role when the provider declares vision", () => {
    const env = { SKETCHMIND_LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", ANTHROPIC_VISION: "true" };
    expect(resolveRoleProvider("vision", env)?.capabilities.vision).toBe(true);
  });

  it("lets the two roles name different providers", () => {
    const env = {
      SKETCHMIND_TEXT_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "k",
      SKETCHMIND_VISION_PROVIDER: "anthropic",
      ANTHROPIC_VISION: "true",
    };
    expect(resolveRoleProvider("text", env)?.id).toBe("anthropic");
    expect(resolveRoleProvider("vision", env)?.id).toBe("anthropic");
  });

  it("applies a per-role model override", () => {
    const env = {
      SKETCHMIND_LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_VISION: "true",
      SKETCHMIND_VISION_MODEL: "claude-sonnet-5",
    };
    expect(resolveRoleProvider("vision", env)?.model).toBe("claude-sonnet-5");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sketchmind/api exec vitest run tests/vision-config.test.ts`
Expected: FAIL — `config.vision` and `resolveRoleProvider` do not exist.

- [ ] **Step 3: Extend `ApiConfig`**

In `apps/api/src/config.ts`, add above `ApiConfig`:

```ts
export type VisionMode = "off" | "auto" | "on";

/**
 * `off` never runs the image tier. `auto` runs it exactly when a vision-capable
 * provider resolves -- which is the answer to "later we may find a model that
 * can do this": point a role at it and the tier turns itself on. `on` requires
 * it, so a deployment that depends on critique fails loudly at boot instead of
 * degrading in silence.
 */
export interface VisionConfig {
  readonly geometric: boolean;
  readonly mode: VisionMode;
  readonly maxRounds: number;
  readonly maxImageBytes: number;
}

export interface RepairConfig {
  readonly maxRounds: number;
  readonly maxSteps: number;
}
```

Add to the `ApiConfig` interface:

```ts
  readonly vision: VisionConfig;
  readonly repair: RepairConfig;
```

Add the helpers and the loader entries:

```ts
function bool(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return fallback;
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

function visionMode(value: string | undefined): VisionMode {
  const normalized = value?.trim().toLowerCase();
  return normalized === "on" || normalized === "auto" ? normalized : "off";
}
```

and inside `loadConfig`'s returned object:

```ts
    vision: {
      geometric: bool(env["SKETCHMIND_GEOMETRIC_CRITIQUE"], true),
      mode: visionMode(env["SKETCHMIND_VISION_MODE"]),
      maxRounds: int(env["SKETCHMIND_VISION_MAX_ROUNDS"], 2),
      maxImageBytes: int(env["SKETCHMIND_VISION_MAX_IMAGE_BYTES"], 4_000_000),
    },
    repair: {
      maxRounds: int(env["SKETCHMIND_REPAIR_MAX_ROUNDS"], 2),
      maxSteps: int(env["SKETCHMIND_REPAIR_MAX_STEPS"], 12),
    },
```

- [ ] **Step 4: Add role resolution**

In `apps/api/src/provider.ts`, add:

```ts
export type ProviderRole = "text" | "vision";

/**
 * Resolve one model role.
 *
 * The two roles are fully independent: either may name any registered provider
 * and any model, and they need not agree on either. Setting neither leaves both
 * on `SKETCHMIND_LLM_PROVIDER`, which is the common case -- one model doing both
 * jobs -- and costs no configuration at all.
 *
 * The vision role returns `undefined` rather than an unusable provider when the
 * resolved model cannot see. That is what makes the tier *inert* when
 * misconfigured instead of failing on the first upload, and it is read from
 * `capabilities.vision`, never from a provider id.
 */
export function resolveRoleProvider(
  role: ProviderRole,
  env: NodeJS.ProcessEnv = process.env,
): LLMProvider | undefined {
  const prefix = role === "vision" ? "SKETCHMIND_VISION" : "SKETCHMIND_TEXT";
  const id = env[`${prefix}_PROVIDER`]?.trim() || env[PROVIDER_ENV_VAR]?.trim();
  if (!id) return undefined;

  const model = env[`${prefix}_MODEL`]?.trim();

  let provider: LLMProvider;
  try {
    provider = buildProviderRegistry().create(id, env, model ? { model } : {});
  } catch {
    // An unknown id or missing adapter variables leave the role unresolved. The
    // text role's absence is already handled by `resolveProvider`'s fake; the
    // vision role's absence simply keeps the tier inert.
    return undefined;
  }

  if (role === "vision" && !provider.capabilities.vision) return undefined;
  return provider;
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @sketchmind/api exec vitest run tests/vision-config.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/config.ts apps/api/src/provider.ts apps/api/tests/vision-config.test.ts
git commit -m "feat(api): add vision config and independent text/vision role resolution"
```

---

## Task 7: `critiqueImage` — the one multimodal call

**Files:**
- Create: `packages/agent-vision/src/internal/prompt.ts`, `packages/agent-vision/src/internal/critique-image.ts`
- Modify: `packages/agent-vision/src/index.ts`
- Test: `packages/agent-vision/tests/critique-image.test.ts`

**Interfaces:**
- Consumes: `LLMProvider`, `LLMProviderError` from `@sketchmind/llm-provider`; `CapturedImage` from `@sketchmind/renderer-core`; `CritiqueFindingSchema` from Task 1.
- Produces: `critiqueImage(input: CritiqueImageInput): Promise<ValidationResult<CritiqueFinding[]>>` where `CritiqueImageInput = { provider: LLMProvider; image: CapturedImage; request: string; layoutSummary: string; signal?: AbortSignal }`.

- [ ] **Step 1: Write the failing test**

Create `packages/agent-vision/tests/critique-image.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeProvider } from "@sketchmind/llm-provider";
import { critiqueImage } from "../src/index.js";

const image = {
  mimeType: "image/png",
  width: 4,
  height: 4,
  data: new Uint8Array([137, 80, 78, 71]),
};

const base = { image, request: "draw a pulley system", layoutSummary: "2 nodes, 1 connector" };

const findingJson = JSON.stringify({
  findings: [
    {
      check: "reads-wrong",
      severity: "warning",
      message: "The rope hangs beside the pulley rather than over it.",
      objectIds: ["rope_1"],
      proposal: { kind: "move_object", objectId: "rope_1", hint: "drape it over the wheel" },
    },
  ],
});

describe("critiqueImage", () => {
  it("parses findings and tags them visual", async () => {
    const provider = new FakeProvider({ capabilities: { vision: true }, responses: [findingJson] });
    const result = await critiqueImage({ provider, ...base });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.tier).toBe("visual");
    expect(result.value[0]?.id).toBeTruthy();
  });

  it("returns a validation failure for unparseable output rather than throwing", async () => {
    const provider = new FakeProvider({ capabilities: { vision: true }, responses: ["I think it looks fine!"] });
    const result = await critiqueImage({ provider, ...base });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("CRITIQUE_UNPARSEABLE");
    expect(result.errors[0]?.recoverable).toBe(true);
  });

  it("returns a validation failure for a schema-invalid finding", async () => {
    const bad = JSON.stringify({ findings: [{ check: "x", severity: "catastrophic", message: "m" }] });
    const provider = new FakeProvider({ capabilities: { vision: true }, responses: [bad] });

    const result = await critiqueImage({ provider, ...base });
    expect(result.ok).toBe(false);
  });

  it("refuses a provider that cannot see, without calling it", async () => {
    const provider = new FakeProvider({ capabilities: { vision: false } });
    const result = await critiqueImage({ provider, ...base });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("CRITIQUE_VISION_UNAVAILABLE");
    expect(provider.calls).toHaveLength(0);
  });

  it("accepts an empty findings list as a clean verdict", async () => {
    const provider = new FakeProvider({
      capabilities: { vision: true },
      responses: [JSON.stringify({ findings: [] })],
    });
    const result = await critiqueImage({ provider, ...base });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("sends the image and never the layout coordinates", async () => {
    const provider = new FakeProvider({
      capabilities: { vision: true },
      responses: [JSON.stringify({ findings: [] })],
    });
    await critiqueImage({ provider, ...base });

    const sent = JSON.stringify(provider.calls[0]);
    expect(sent).toContain("draw a pulley system");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sketchmind/agent-vision exec vitest run tests/critique-image.test.ts`
Expected: FAIL — `critiqueImage` is not exported.

- [ ] **Step 3: Write the prompt as data**

Create `packages/agent-vision/src/internal/prompt.ts`:

```ts
/**
 * The critique prompt, as data rather than a string built at the call site --
 * the pattern Phase 5 settled for the reasoning tools, for the same reason:
 * a prompt you can read in one place is a prompt you can change without
 * re-reading the code that sends it.
 */
export const CRITIQUE_SYSTEM_PROMPT = [
  "You are looking at a whiteboard drawing an assistant has just produced, and judging whether it",
  "actually communicates what was asked for.",
  "",
  "Report only problems a person looking at the board would notice: something that does not read",
  "as the thing it is meant to be, a part that is missing, a component in a place that makes the",
  "diagram misleading, a label attached to the wrong thing.",
  "",
  "Do NOT report small geometric imperfections -- overlaps, spacing, alignment, connectors that",
  "miss slightly. Those are already measured precisely by other means, and repeating them here",
  "wastes the one thing you can do that software cannot.",
  "",
  "If the drawing is good, return an empty findings list. Saying nothing is a valid and useful",
  "answer; inventing a problem to seem thorough is not.",
  "",
  "Reply with JSON only, in exactly this shape:",
  '{"findings":[{"check":"<short-kebab-name>","severity":"info|warning|error",',
  '"message":"<one sentence>","objectIds":["<id>"],',
  '"proposal":{"kind":"move_object|resize_object|reposition_label|add_missing_component|redraw_object",',
  '"objectId":"<id>","hint":"<what to change, in words>"}}]}',
  "",
  "`hint` is words, never numbers. Do not emit coordinates, sizes, or pixel values: you are",
  "describing intent, and something else turns intent into geometry.",
].join("\n");

export function critiqueUserPrompt(request: string, layoutSummary: string): string {
  return [
    `The request was: ${request}`,
    "",
    `What the drawing contains: ${layoutSummary}`,
    "",
    "Judge the image against the request.",
  ].join("\n");
}
```

- [ ] **Step 4: Implement `critiqueImage`**

Create `packages/agent-vision/src/internal/critique-image.ts`:

```ts
/**
 * Tier 2: one multimodal call, server-side, and the only place in SketchMind
 * that sends an image anywhere.
 *
 * `completeWithImages` returns prose, not tool calls -- so the contract with the
 * model is a JSON body we parse ourselves. That is also why this function exists
 * at all rather than the client agent seeing the image directly: keeping the
 * multimodal turn here means `agent-core`, the `LLMProvider` interface and the
 * browser's LLM proxy all stay text-only.
 *
 * A model that answers badly is an observation, not a crash (AD-2): every
 * failure below returns a `ValidationResult`. Only a transport failure throws,
 * and it throws `LLMProviderError` from the provider itself.
 */
import {
  LLMProviderError,
  type ImageInput,
  type LLMProvider,
} from "@sketchmind/llm-provider";
import type { CapturedImage } from "@sketchmind/renderer-core";
import {
  CritiqueFindingSchema,
  fail,
  makeError,
  ok,
  type CritiqueFinding,
  type ValidationResult,
} from "@sketchmind/shared-types";
import { z } from "zod";
import { CRITIQUE_SYSTEM_PROMPT, critiqueUserPrompt } from "./prompt.js";

const PACKAGE = "@sketchmind/agent-vision";

/** The model supplies everything but the tier and the id; we own both. */
const ModelFindingSchema = CritiqueFindingSchema.omit({ id: true, tier: true }).extend({
  objectIds: z.array(z.string().min(1)).default([]),
});

const ModelReplySchema = z.object({ findings: z.array(ModelFindingSchema) });

export interface CritiqueImageInput {
  readonly provider: LLMProvider;
  readonly image: CapturedImage;
  /** The user's original words. The image is judged against these. */
  readonly request: string;
  /** Ids and counts. Never coordinates -- the model must read the picture. */
  readonly layoutSummary: string;
  readonly signal?: AbortSignal;
}

function problem(code: string, message: string): ValidationResult<CritiqueFinding[]> {
  return fail([
    makeError({ code, message, package: PACKAGE, stage: "render", recoverable: true }),
  ]);
}

/** Models wrap JSON in prose and fences no matter how firmly asked not to. */
function extractJsonObject(text: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return undefined;
  return candidate.slice(start, end + 1);
}

function toBase64(data: Uint8Array): string {
  // Node and the browser disagree about how to do this, and this function runs
  // only on the server -- but Buffer is not in `agent-vision`'s type surface, so
  // the portable form is used deliberately.
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function critiqueImage(
  input: CritiqueImageInput,
): Promise<ValidationResult<CritiqueFinding[]>> {
  if (!input.provider.capabilities.vision) {
    return problem(
      "CRITIQUE_VISION_UNAVAILABLE",
      `Provider "${input.provider.id}" cannot accept images, so the visual critique tier ` +
        `cannot run. This is a configuration state, not a failure of the drawing.`,
    );
  }

  const images: ImageInput[] = [
    { mimeType: input.image.mimeType, base64: toBase64(input.image.data) },
  ];

  let text: string;
  try {
    const response = await input.provider.completeWithImages({
      system: CRITIQUE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: critiqueUserPrompt(input.request, input.layoutSummary) }],
      images,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    text = response.text;
  } catch (cause) {
    if (cause instanceof LLMProviderError) return fail([cause.error]);
    throw cause;
  }

  const json = extractJsonObject(text);
  if (!json) {
    return problem(
      "CRITIQUE_UNPARSEABLE",
      `The critique model replied without a JSON object. It said: ${text.slice(0, 200)}`,
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch {
    return problem("CRITIQUE_UNPARSEABLE", "The critique model's JSON did not parse.");
  }

  const reply = ModelReplySchema.safeParse(parsedJson);
  if (!reply.success) {
    return problem(
      "CRITIQUE_INVALID",
      `The critique model's findings did not match the expected shape: ` +
        reply.error.issues.map((i) => i.message).join("; "),
    );
  }

  return ok(
    reply.data.findings.map((f, index) => ({
      ...f,
      id: `visual:${index}:${f.check}`,
      tier: "visual" as const,
    })),
  );
}
```

- [ ] **Step 5: Export it**

Add to `packages/agent-vision/src/index.ts`:

```ts
export { critiqueImage, type CritiqueImageInput } from "./internal/critique-image.js";
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @sketchmind/agent-vision test`
Expected: PASS.

If `completeWithImages` on `FakeProvider` does not yet route through the `responses` queue, add it there mirroring `complete`, recording the request into `calls`.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-vision/src packages/agent-vision/tests
git commit -m "feat(agent-vision): add critiqueImage, the one multimodal call"
```

---

## Task 8: The vision-critique route

**Files:**
- Create: `apps/api/src/routes/vision.ts`
- Modify: `apps/api/src/server.ts`, `apps/api/src/session/manager.ts`
- Test: `apps/api/tests/vision-route.test.ts`

**Interfaces:**
- Consumes: `critiqueImage` (Task 7), `resolveRoleProvider` and `ApiConfig.vision` (Task 6).
- Produces: `registerVisionRoute(app, options)` where `options = { provider: LLMProvider | undefined; config: ApiConfig; sessions: SessionManager }`. `SessionRecord` gains `request: string`, `layoutSummary: string`, `visionRounds: number`, `repairRounds: number`, `lastFindings: CritiqueFinding[]`.

- [ ] **Step 1: Extend `SessionRecord`**

In `apps/api/src/session/manager.ts`, add to the `SessionRecord` interface:

```ts
  /** The user's original words, needed to judge the image against the ask. */
  request: string;
  /** Ids and counts for the critique prompt. Never coordinates. */
  layoutSummary: string;
  /** Critique rounds spent. Capped by `config.vision.maxRounds`. */
  visionRounds: number;
  /** Repair turns spent. Capped by `config.repair.maxRounds`. */
  repairRounds: number;
  /** Last round's findings, so an unchanged verdict does not re-trigger repair. */
  lastFindings: CritiqueFinding[];
```

and to `create()`:

```ts
  create(sessionId: string, request = ""): SessionRecord {
    const record: SessionRecord = {
      sessionId,
      controller: new AbortController(),
      events: [],
      listeners: new Set(),
      finished: false,
      request,
      layoutSummary: "",
      visionRounds: 0,
      repairRounds: 0,
      lastFindings: [],
    };
    this.sessions.set(sessionId, record);
    return record;
  }
```

Import `CritiqueFinding` from `@sketchmind/session-protocol` (which re-exports `shared-types`) or from `@sketchmind/shared-types`, matching the file's existing import style.

Update the `create(` call site in `apps/api/src/routes/sessions.ts` to pass the user input.

- [ ] **Step 2: Write the failing test**

Create `apps/api/tests/vision-route.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { FakeProvider } from "@sketchmind/llm-provider";
import { loadConfig } from "../src/config.js";
import { SessionManager } from "../src/session/manager.js";
import { registerVisionRoute } from "../src/routes/vision.js";

const PNG_BASE64 = "iVBORw0KGgo=";

function build(options: { vision: boolean; mode?: string } ): {
  app: FastifyInstance;
  sessions: SessionManager;
  provider: FakeProvider | undefined;
} {
  const sessions = new SessionManager();
  sessions.create("s1", "draw a pulley system");

  const provider = options.vision
    ? new FakeProvider({
        capabilities: { vision: true },
        responses: [JSON.stringify({ findings: [] })],
      })
    : undefined;

  const app = Fastify();
  registerVisionRoute(app, {
    provider,
    sessions,
    config: loadConfig({ SKETCHMIND_VISION_MODE: options.mode ?? "on" }),
  });

  return { app, sessions, provider };
}

const body = { sessionId: "s1", mimeType: "image/png", base64: PNG_BASE64, width: 4, height: 4 };

describe("POST /api/agent/vision-critique", () => {
  it("returns findings when the gate is open", async () => {
    const { app } = build({ vision: true });
    const res = await app.inject({ method: "POST", url: "/api/agent/vision-critique", payload: body });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ findings: [] });
  });

  it("returns 503 with a reason when no vision provider resolved", async () => {
    const { app } = build({ vision: false });
    const res = await app.inject({ method: "POST", url: "/api/agent/vision-critique", payload: body });

    expect(res.statusCode).toBe(503);
    expect(res.json().reason).toMatch(/vision/i);
  });

  it("returns 503 when the mode is off, even with a capable provider", async () => {
    const { app } = build({ vision: true, mode: "off" });
    const res = await app.inject({ method: "POST", url: "/api/agent/vision-critique", payload: body });

    expect(res.statusCode).toBe(503);
  });

  it("never calls the model when the gate is closed", async () => {
    const { app, provider } = build({ vision: true, mode: "off" });
    await app.inject({ method: "POST", url: "/api/agent/vision-critique", payload: body });

    expect(provider?.calls ?? []).toHaveLength(0);
  });

  it("rejects a malformed body", async () => {
    const { app } = build({ vision: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/vision-critique",
      payload: { sessionId: "s1" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects an unknown session", async () => {
    const { app } = build({ vision: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/vision-critique",
      payload: { ...body, sessionId: "nope" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("rejects an oversized image", async () => {
    const { app } = build({ vision: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/vision-critique",
      payload: { ...body, base64: "A".repeat(6_000_000) },
    });

    expect(res.statusCode).toBe(413);
  });

  it("caps critique rounds per session", async () => {
    const { app, sessions } = build({ vision: true });
    const record = sessions.get("s1")!;
    record.visionRounds = 2;

    const res = await app.inject({ method: "POST", url: "/api/agent/vision-critique", payload: body });
    expect(res.statusCode).toBe(429);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @sketchmind/api exec vitest run tests/vision-route.test.ts`
Expected: FAIL — `../src/routes/vision.js` does not exist.

- [ ] **Step 4: Implement the route**

Create `apps/api/src/routes/vision.ts`:

```ts
/**
 * The critique route: the only place an image reaches a model.
 *
 * It exists so the browser agent can *see* without the multimodal turn ever
 * entering its own message loop -- the client sends pixels, this returns JSON
 * findings, and `agent-core`, the `LLMProvider` interface and `/api/agent/llm`
 * all stay text-only.
 *
 * Validated rather than forwarded, on exactly the reasoning behind
 * `routes/llm.ts`: an endpoint that relayed whatever bytes it received to a paid
 * multimodal API would be an open relay wearing a SketchMind badge.
 *
 * A closed gate is a 503 with a reason, not a silent empty list. A tier that is
 * off should be legible from the outside; "no findings" and "critique never ran"
 * are different answers and must not look alike.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { critiqueImage } from "@sketchmind/agent-vision";
import { LLMProviderError, type LLMProvider } from "@sketchmind/llm-provider";
import type { ApiConfig } from "../config.js";
import type { SessionManager } from "../session/manager.js";

const RequestSchema = z.object({
  sessionId: z.string().min(1),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  base64: z.string().min(1),
  width: z.number().int().positive().max(20_000),
  height: z.number().int().positive().max(20_000),
});

export interface VisionRouteOptions {
  /** The vision-role provider, or undefined when none resolved. */
  readonly provider: LLMProvider | undefined;
  readonly config: ApiConfig;
  readonly sessions: SessionManager;
}

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function registerVisionRoute(app: FastifyInstance, options: VisionRouteOptions): void {
  const { provider, config, sessions } = options;
  const enabled = config.vision.mode !== "off" && provider !== undefined;

  app.post("/api/agent/vision-critique", async (request, reply) => {
    if (!enabled) {
      return reply.code(503).send({
        reason:
          config.vision.mode === "off"
            ? "Visual critique is switched off (SKETCHMIND_VISION_MODE=off)."
            : "No vision-capable provider resolved for the vision role.",
      });
    }

    const parsed = RequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ errors: parsed.error.issues });

    // Base64 inflates by 4/3; comparing the encoded length is the cheap check
    // and it is deliberately done before decoding rather than after.
    if (parsed.data.base64.length > config.vision.maxImageBytes) {
      return reply.code(413).send({ reason: "The image is larger than the configured cap." });
    }

    const record = sessions.get(parsed.data.sessionId);
    if (!record) return reply.code(404).send({ reason: "No such session." });

    if (record.visionRounds >= config.vision.maxRounds) {
      return reply.code(429).send({ reason: "This session has used its critique rounds." });
    }
    record.visionRounds += 1;

    try {
      const result = await critiqueImage({
        provider,
        image: {
          mimeType: parsed.data.mimeType,
          width: parsed.data.width,
          height: parsed.data.height,
          data: decode(parsed.data.base64),
        },
        request: record.request,
        layoutSummary: record.layoutSummary,
        signal: record.controller.signal,
      });

      if (!result.ok) return reply.code(422).send({ errors: result.errors });
      return reply.send({ findings: result.value });
    } catch (cause) {
      // The provider's own message can name a deployment, and this response
      // goes to a browser.
      if (cause instanceof LLMProviderError) return reply.code(502).send({ errors: [cause.error] });
      app.log.error({ err: cause }, "vision critique failed");
      return reply.code(502).send({ reason: "The critique model could not be reached." });
    }
  });
}
```

- [ ] **Step 5: Register it on the server**

In `apps/api/src/server.ts`, import `registerVisionRoute` and `resolveRoleProvider`, and register alongside the existing routes:

```ts
  registerVisionRoute(app, {
    provider: resolveRoleProvider("vision"),
    config,
    sessions,
  });
```

Also add a boot warning for `mode === "on"` with no provider:

```ts
  if (config.vision.mode === "on" && !resolveRoleProvider("vision")) {
    app.log.warn(
      "SKETCHMIND_VISION_MODE=on but no vision-capable provider resolved. " +
        "Set SKETCHMIND_VISION_PROVIDER / SKETCHMIND_VISION_MODEL, or use mode=auto.",
    );
  }
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @sketchmind/api test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src apps/api/tests/vision-route.test.ts
git commit -m "feat(api): add the vision-critique route behind a three-way gate"
```

---

## Task 9: Automatic geometric pass and the bounded repair turn

**Files:**
- Create: `apps/api/src/session/repair.ts`
- Modify: `apps/api/src/session/run.ts`, `apps/api/src/routes/sessions.ts`
- Test: `apps/api/tests/repair.test.ts`

**Interfaces:**
- Consumes: `critiqueGeometry`, `createVisionTools` (Task 4); `SessionRecord` fields (Task 8).
- Produces: `runRepair(options: RunRepairOptions): Promise<void>`; `POST /api/sessions/:id/findings`. `runSession` gains an `onReady` callback exposing `{ registry, geometry, reasoning }` to the session record so a later repair turn can reuse them.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/repair.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { runRepair } from "../src/session/repair.js";
import { ToolRegistry } from "@sketchmind/agent-core";
import { FakeProvider } from "@sketchmind/llm-provider";
import { loadConfig } from "../src/config.js";
import { SessionManager } from "../src/session/manager.js";
import type { CritiqueFinding } from "@sketchmind/shared-types";

const finding: CritiqueFinding = {
  id: "f1",
  tier: "geometric",
  check: "overlap",
  severity: "error",
  message: "a and b overlap.",
  objectIds: ["a", "b"],
};

function setup() {
  const sessions = new SessionManager();
  const record = sessions.create("s1", "draw two boxes");
  const emitted: string[] = [];
  sessions.subscribe("s1", (event) => emitted.push(event.type));
  return { sessions, record, emitted };
}

describe("runRepair", () => {
  it("runs an agent turn and emits a VisionCritique event", async () => {
    const { sessions, record, emitted } = setup();
    await runRepair({
      sessionId: "s1",
      findings: [finding],
      provider: new FakeProvider({ responses: ["fixed"] }),
      registry: new ToolRegistry([]),
      config: loadConfig({}),
      record,
      emit: (event) => sessions.emit("s1", event),
    });

    expect(emitted).toContain("VisionCritique");
    expect(record.repairRounds).toBe(1);
  });

  it("refuses once the repair round cap is reached", async () => {
    const { sessions, record } = setup();
    record.repairRounds = 2;
    const provider = new FakeProvider({ responses: ["fixed"] });

    await runRepair({
      sessionId: "s1",
      findings: [finding],
      provider,
      registry: new ToolRegistry([]),
      config: loadConfig({}),
      record,
      emit: (event) => sessions.emit("s1", event),
    });

    expect(provider.calls).toHaveLength(0);
    expect(record.repairRounds).toBe(2);
  });

  it("refuses when the findings repeat the previous round", async () => {
    const { sessions, record } = setup();
    record.lastFindings = [finding];
    const provider = new FakeProvider({ responses: ["fixed"] });

    await runRepair({
      sessionId: "s1",
      findings: [finding],
      provider,
      registry: new ToolRegistry([]),
      config: loadConfig({}),
      record,
      emit: (event) => sessions.emit("s1", event),
    });

    expect(provider.calls).toHaveLength(0);
  });

  it("does nothing for an empty findings list", async () => {
    const { sessions, record } = setup();
    const provider = new FakeProvider({ responses: ["fixed"] });

    await runRepair({
      sessionId: "s1",
      findings: [],
      provider,
      registry: new ToolRegistry([]),
      config: loadConfig({}),
      record,
      emit: (event) => sessions.emit("s1", event),
    });

    expect(provider.calls).toHaveLength(0);
    expect(record.repairRounds).toBe(0);
  });

  it("terminates against findings that never change", async () => {
    const { sessions, record } = setup();
    const provider = new FakeProvider({ responses: ["still broken"] });
    const emit = (event: Parameters<typeof sessions.emit>[1]) => sessions.emit("s1", event);

    for (let round = 0; round < 10; round += 1) {
      await runRepair({
        sessionId: "s1",
        findings: [finding],
        provider,
        registry: new ToolRegistry([]),
        config: loadConfig({}),
        record,
        emit,
      });
    }

    expect(record.repairRounds).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sketchmind/api exec vitest run tests/repair.test.ts`
Expected: FAIL — `../src/session/repair.js` does not exist.

- [ ] **Step 3: Implement `runRepair`**

Create `apps/api/src/session/repair.ts`:

```ts
/**
 * One bounded repair turn.
 *
 * The findings become the goal of a fresh `runAgent` over the **same registry**
 * the session already had. That is the whole design: the agent repairs by
 * calling the tools it already knows -- edit the AST, re-derive constraints,
 * re-solve layout, re-plan strokes -- so there is never a second way to author
 * geometry, and the solver stays the only thing that produces a number.
 *
 * Three guards, all of which must hold, and any of which ending the loop:
 * empty findings, the round cap, and findings identical to last round's. The
 * third is the one that stops oscillation -- an agent that "fixes" something
 * into the same state forever is the failure mode a budget alone does not catch.
 */
import { runAgent, type ToolRegistry } from "@sketchmind/agent-core";
import type { LLMProvider } from "@sketchmind/llm-provider";
import {
  findingsEqual,
  type CritiqueFinding,
  type RuntimeEventBody,
} from "@sketchmind/shared-types";
import type { ApiConfig } from "../config.js";
import type { SessionRecord } from "./manager.js";

export interface RunRepairOptions {
  readonly sessionId: string;
  readonly findings: readonly CritiqueFinding[];
  readonly provider: LLMProvider;
  readonly registry: ToolRegistry;
  readonly config: ApiConfig;
  readonly record: SessionRecord;
  readonly emit: (event: RuntimeEventBody & { sessionId: string; at: string }) => void;
}

/** What the agent is told. Prose, because that is what it reasons over. */
export function findingsAsGoal(findings: readonly CritiqueFinding[]): string {
  const lines = findings.map((f) => {
    const proposal = f.proposal ? ` Suggested fix: ${describeProposal(f.proposal)}.` : "";
    return `- [${f.severity}] ${f.message}${proposal}`;
  });
  return [
    "A review of the diagram you just drew found these problems:",
    "",
    ...lines,
    "",
    "Fix them by adjusting the diagram and re-running the geometry stages. Change only what the",
    "findings call for; the rest of the diagram was judged correct. If a finding is wrong, say so",
    "and change nothing.",
  ].join("\n");
}

function describeProposal(proposal: NonNullable<CritiqueFinding["proposal"]>): string {
  switch (proposal.kind) {
    case "add_missing_component":
      return `add ${proposal.description}`;
    case "reposition_label":
      return `reposition label "${proposal.labelId}" — ${proposal.hint}`;
    default:
      return `${proposal.kind.replace("_", " ")} "${proposal.objectId}" — ${proposal.hint}`;
  }
}

export async function runRepair(options: RunRepairOptions): Promise<void> {
  const { findings, record, config, sessionId } = options;
  const at = new Date().toISOString();

  if (findings.length === 0) return;

  if (record.repairRounds >= config.repair.maxRounds) {
    options.emit({
      sessionId,
      at,
      type: "VisionCritique",
      tier: findings[0]!.tier,
      findings: [...findings],
      accepted: false,
    });
    return;
  }

  if (findingsEqual(findings, record.lastFindings)) {
    options.emit({
      sessionId,
      at,
      type: "VisionCritique",
      tier: findings[0]!.tier,
      findings: [...findings],
      accepted: false,
    });
    return;
  }

  record.lastFindings = [...findings];
  record.repairRounds += 1;

  options.emit({
    sessionId,
    at,
    type: "VisionCritique",
    tier: findings[0]!.tier,
    findings: [...findings],
    accepted: true,
  });

  await runAgent({
    sessionId,
    goal: findingsAsGoal(findings),
    provider: options.provider,
    registry: options.registry,
    locus: "server",
    budget: {
      maxSteps: config.repair.maxSteps,
      maxTokens: config.agentBudget.maxTokens,
      timeoutMs: config.agentBudget.timeoutMs,
    },
    signal: record.controller.signal,
  });
}
```

- [ ] **Step 4: Wire the automatic pass into `runSession`**

In `apps/api/src/session/run.ts`:

Add imports:

```ts
import { createVisionTools, critiqueGeometry } from "@sketchmind/agent-vision";
import { runRepair } from "./repair.js";
```

Add `createVisionTools` to the registry construction (after `createGeometryTools`):

```ts
    ...createVisionTools({
      getAst: () => reasoning.ast,
      getLayout: () => geometry.layout,
      getStrokes: () => geometry.strokeAST,
    }),
```

Add `record: SessionRecord` to `RunSessionOptions`, and after the `strokes` guard and before `play(...)`, insert the automatic pass:

```ts
  // The free tier runs on every diagram before a single stroke is drawn. This
  // is the pass that makes "the agent checks its own work" true even with the
  // image tier switched off, and it costs nothing to be sure of.
  const layout = geometry.layout;
  if (config.vision.geometric && reasoning.ast && layout) {
    options.record.layoutSummary =
      `${layout.nodes.length} objects (${layout.nodes.map((n) => n.objectId).join(", ")}), ` +
      `${layout.connectors.length} connectors, ${layout.labels.length} labels`;

    const findings = critiqueGeometry({ ast: reasoning.ast, layout, strokes });
    if (findings.length > 0) {
      await runRepair({
        sessionId,
        findings,
        provider,
        registry,
        config,
        record: options.record,
        emit: options.emit,
      });
    }
  }

  // Repair may have replaced the plan; draw whatever the workspace now holds.
  const finalStrokes = geometry.strokeAST ?? strokes;

  // Handed to the client agent and to a later repair turn.
  options.record.registry = registry;

  await play({ ...options, strokes: finalStrokes, sleep, now });
```

Add `registry?: ToolRegistry` to `SessionRecord` in `manager.ts`.

- [ ] **Step 5: Add the findings route**

In `apps/api/src/routes/sessions.ts`, add:

```ts
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/sessions/:id/findings",
    async (request, reply) => {
      const record = sessions.get(request.params.id);
      if (!record || !record.registry) return reply.code(404).send({ reason: "No such session." });

      const parsed = z
        .object({ findings: z.array(CritiqueFindingSchema).max(50) })
        .safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ errors: parsed.error.issues });

      // 202: the repair is a background turn, and the client learns what
      // happened from the event stream it is already reading.
      void runRepair({
        sessionId: record.sessionId,
        findings: parsed.data.findings,
        provider,
        registry: record.registry,
        config,
        record,
        emit: (event) => sessions.emit(record.sessionId, event),
      });

      return reply.code(202).send({ accepted: true });
    },
  );
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @sketchmind/api test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src apps/api/tests/repair.test.ts
git commit -m "feat(api): run geometric critique before playback and add the bounded repair turn"
```

---

## Task 10: The proxy provider

**Files:**
- Create: `packages/llm-provider/src/proxy.ts`
- Modify: `packages/llm-provider/src/index.ts`
- Test: `packages/llm-provider/tests/proxy.test.ts`

**Interfaces:**
- Produces: `createProxyProvider(options: ProxyProviderOptions): LLMProvider` where `ProxyProviderOptions = { endpoint: string; fetchImpl?: typeof fetch; model?: string }`.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-provider/tests/proxy.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createProxyProvider, LLMProviderError } from "../src/index.js";

const response = {
  toolCalls: [],
  text: "ok",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  model: "proxy",
  finishReason: "stop",
};

describe("createProxyProvider", () => {
  it("POSTs a tool request to the endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    const provider = createProxyProvider({ endpoint: "/api/agent/llm", fetchImpl });

    const result = await provider.completeWithTools({ messages: [{ role: "user", content: "hi" }], tools: [] });

    expect(result.text).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/agent/llm");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("declares vision false — images never go through the proxy", () => {
    const provider = createProxyProvider({ endpoint: "/api/agent/llm" });
    expect(provider.capabilities.vision).toBe(false);
    expect(provider.capabilities.toolCalling).toBe(true);
  });

  it("throws LLMProviderError on a non-OK response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 502 }));
    const provider = createProxyProvider({ endpoint: "/api/agent/llm", fetchImpl });

    await expect(
      provider.completeWithTools({ messages: [{ role: "user", content: "hi" }], tools: [] }),
    ).rejects.toBeInstanceOf(LLMProviderError);
  });

  it("rejects the methods the proxy does not carry", async () => {
    const provider = createProxyProvider({ endpoint: "/api/agent/llm" });
    await expect(
      provider.completeWithImages({ messages: [{ role: "user", content: "x" }], images: [] }),
    ).rejects.toBeInstanceOf(LLMProviderError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sketchmind/llm-provider exec vitest run tests/proxy.test.ts`
Expected: FAIL — `createProxyProvider` is not exported.

- [ ] **Step 3: Implement it**

Create `packages/llm-provider/src/proxy.ts`:

```ts
/**
 * An `LLMProvider` backed by SketchMind's own proxy route rather than a vendor.
 *
 * This is what lets a browser run the same `agent-core` loop the server runs
 * without a key or an SDK reaching it: `completeWithTools` becomes one POST to
 * `/api/agent/llm`, and the credentials stay in the server process.
 *
 * It lives beside `fake.ts` in this package for the same reason `fake.ts` does
 * -- it imports no provider SDK, only `fetch`, so the lint rule that keeps
 * vendors out of the browser bundle has nothing to object to.
 *
 * Its capabilities are honest about the proxy's scope, which is deliberately one
 * method. In particular `vision: false`: images do not travel this route, and a
 * client agent that believed otherwise would build a request the server would
 * reject.
 */
import { ProviderErrorCode, providerError } from "./internal/errors.js";
import { LLMProviderError } from "./types.js";
import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResponse,
  LLMCapabilities,
  LLMProvider,
  StructuredRequest,
  StructuredResponse,
  ToolRequest,
  ToolResponse,
  VisionRequest,
} from "./types.js";
import type { ZodType, z } from "zod";

const PACKAGE = "@sketchmind/llm-provider";

export interface ProxyProviderOptions {
  /** Absolute or same-origin path of the proxy route. */
  readonly endpoint: string;
  /** Injected in tests; defaults to the ambient `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly model?: string;
}

const PROXY_CAPABILITIES: LLMCapabilities = {
  structuredOutput: false,
  toolCalling: true,
  parallelToolCalls: false,
  streaming: false,
  vision: false,
  maxContextTokens: 128_000,
};

function unsupported(method: string): LLMProviderError {
  return providerError(
    ProviderErrorCode.Misconfigured,
    `The LLM proxy carries tool-calling turns only; "${method}" is not routed through it. ` +
      `Scope is widened by a deliberate decision about what the browser may spend, not by need.`,
    PACKAGE,
  );
}

export function createProxyProvider(options: ProxyProviderOptions): LLMProvider {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const model = options.model ?? "proxy";

  return {
    id: "proxy",
    model,
    capabilities: PROXY_CAPABILITIES,

    async completeWithTools(req: ToolRequest): Promise<ToolResponse> {
      const response = await doFetch(options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(req.system === undefined ? {} : { system: req.system }),
          messages: req.messages,
          tools: req.tools,
          ...(req.toolChoice === undefined ? {} : { toolChoice: req.toolChoice }),
          ...(req.maxOutputTokens === undefined ? {} : { maxOutputTokens: req.maxOutputTokens }),
          ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        }),
        ...(req.signal ? { signal: req.signal } : {}),
      });

      if (!response.ok) {
        throw providerError(
          response.status === 429 ? ProviderErrorCode.RateLimited : ProviderErrorCode.Unavailable,
          `The LLM proxy answered ${response.status}.`,
          PACKAGE,
        );
      }

      return (await response.json()) as ToolResponse;
    },

    async complete(_req: CompletionRequest): Promise<CompletionResponse> {
      throw unsupported("complete");
    },
    async completeStructured<S extends ZodType>(
      _req: StructuredRequest<S>,
    ): Promise<StructuredResponse<z.infer<S>>> {
      throw unsupported("completeStructured");
    },
    async completeWithImages(_req: VisionRequest): Promise<CompletionResponse> {
      throw unsupported("completeWithImages");
    },
    stream(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
      throw unsupported("stream");
    },
  };
}
```

- [ ] **Step 4: Export it**

Add to `packages/llm-provider/src/index.ts`:

```ts
export * from "./proxy.js";
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @sketchmind/llm-provider test`
Expected: PASS.

If `providerError` returns a plain object rather than an `LLMProviderError` instance, wrap it: `new LLMProviderError(error, false)`. Check `internal/errors.ts` and match what it actually returns.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-provider/src/proxy.ts packages/llm-provider/src/index.ts packages/llm-provider/tests/proxy.test.ts
git commit -m "feat(llm-provider): add a proxy-backed provider for the browser agent"
```

---

## Task 11: The client vision agent

**Files:**
- Create: `packages/agent-vision/src/tools-client.ts`, `packages/agent-vision/src/client-agent.ts`
- Modify: `packages/agent-vision/src/index.ts`
- Test: `packages/agent-vision/tests/tools-client.test.ts`, `packages/agent-vision/tests/client-agent.test.ts`

**Interfaces:**
- Consumes: `runAgent`, `ToolRegistry`, `defineTool` from `@sketchmind/agent-core`; `createProxyProvider` (Task 10).
- Produces: `class VisionWorkspace { image?: CapturedImage; lastFindings: CritiqueFinding[] }`, `createClientVisionTools(options): ToolDefinition[]`, `runVisionAgent(options): Promise<VisionAgentResult>` where `VisionAgentResult = { reported: CritiqueFinding[]; rounds: number; stopReason: string }`.

- [ ] **Step 1: Write the failing test for the tools**

Create `packages/agent-vision/tests/tools-client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { VisionWorkspace, createClientVisionTools } from "../src/index.js";
import { ok } from "@sketchmind/shared-types";
import type { CritiqueFinding } from "@sketchmind/shared-types";

const image = { mimeType: "image/png", width: 4, height: 4, data: new Uint8Array([1, 2, 3]) };

const finding: CritiqueFinding = {
  id: "v1",
  tier: "visual",
  check: "reads-wrong",
  severity: "warning",
  message: "The rope hangs beside the pulley.",
  objectIds: ["rope_1"],
};

const context = {
  sessionId: "s1",
  signal: new AbortController().signal,
  locus: "client" as const,
  toolCallId: "c1",
};

function build(overrides: Partial<Parameters<typeof createClientVisionTools>[0]> = {}) {
  const workspace = new VisionWorkspace();
  const tools = createClientVisionTools({
    workspace,
    capture: async () => ok(image),
    critique: async () => [finding],
    report: async () => {},
    ...overrides,
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { workspace, tools, byName };
}

describe("client vision tools", () => {
  it("registers three client-locus tools", () => {
    const { tools } = build();
    expect(tools.map((t) => t.name)).toEqual(["capture_canvas", "critique_canvas", "report_findings"]);
    expect(tools.every((t) => t.locus === "client")).toBe(true);
  });

  it("capture_canvas stores the image and returns only its shape", async () => {
    const { byName, workspace } = build();
    const result = (await byName.capture_canvas!.handler({}, context)) as {
      ok: true;
      value: { width: number; height: number; byteLength: number };
    };

    expect(result.value).toEqual({ width: 4, height: 4, byteLength: 3 });
    expect(workspace.image).toBe(image);
    // The bytes must never reach the model's context.
    expect(JSON.stringify(result)).not.toContain("data");
  });

  it("critique_canvas fails recoverably before a capture", async () => {
    const { byName } = build();
    const result = (await byName.critique_canvas!.handler({}, context)) as {
      ok: false;
      errors: { code: string }[];
    };
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("CRITIQUE_NO_IMAGE");
  });

  it("critique_canvas returns findings after a capture", async () => {
    const { byName } = build();
    await byName.capture_canvas!.handler({}, context);
    const result = (await byName.critique_canvas!.handler({}, context)) as {
      ok: true;
      value: { findings: CritiqueFinding[] };
    };
    expect(result.value.findings).toEqual([finding]);
  });

  it("report_findings forwards only what it was given", async () => {
    const report = vi.fn(async () => {});
    const { byName } = build({ report });

    await byName.report_findings!.handler({ findings: [finding] }, context);
    expect(report).toHaveBeenCalledWith([finding]);
  });

  it("report_findings rejects a finding that is not well formed", async () => {
    const { byName } = build();
    const result = (await byName.report_findings!.handler(
      { findings: [{ check: "x" }] } as never,
      context,
    )) as { ok: false };
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sketchmind/agent-vision exec vitest run tests/tools-client.test.ts`
Expected: FAIL — `VisionWorkspace` is not exported.

- [ ] **Step 3: Implement the client tools**

Create `packages/agent-vision/src/tools-client.ts`:

```ts
/**
 * The client agent's three tools.
 *
 * The division of labour is the whole point. `capture_canvas` and
 * `critique_canvas` move bytes; the *judgement* -- is this finding real, is it
 * the same one I reported last round, is it worth a repair -- happens in the
 * agent's reasoning between them. That is what makes this an agent rather than a
 * pipe, and it is why `report_findings` takes a subset instead of forwarding
 * everything it was handed.
 *
 * The image never enters the agent's message history. `capture_canvas` returns
 * dimensions and a byte count; the pixels live in the workspace and travel only
 * to the server. Which is also why `agent-core` needs no multimodal support.
 */
import { defineTool, type ToolDefinition } from "@sketchmind/agent-core";
import type { CapturedImage } from "@sketchmind/renderer-core";
import {
  CritiqueFindingSchema,
  fail,
  makeError,
  ok,
  type CritiqueFinding,
  type ValidationResult,
} from "@sketchmind/shared-types";
import { z } from "zod";

const PACKAGE = "@sketchmind/agent-vision";

export class VisionWorkspace {
  image?: CapturedImage;
  lastFindings: CritiqueFinding[] = [];
}

export interface ClientVisionToolsOptions {
  readonly workspace: VisionWorkspace;
  /** Delegates to the capture worker, so encoding stays off the main thread. */
  readonly capture: () => Promise<ValidationResult<CapturedImage>>;
  readonly critique: (image: CapturedImage) => Promise<CritiqueFinding[]>;
  readonly report: (findings: CritiqueFinding[]) => Promise<void>;
}

function problem(code: string, message: string) {
  return fail([
    makeError({ code, message, package: PACKAGE, stage: "render", recoverable: true }),
  ]);
}

export function createClientVisionTools(
  options: ClientVisionToolsOptions,
): ToolDefinition[] {
  const { workspace } = options;

  const capture = defineTool({
    name: "capture_canvas",
    description:
      "Take a picture of the whiteboard as it currently looks. Returns the picture's size only " +
      "-- you will not see the image yourself. Call this first; critique_canvas works on whatever " +
      "this captured.",
    locus: "client",
    readOnly: true,
    argsSchema: z.object({}),
    handler: async () => {
      const result = await options.capture();
      if (!result.ok) return result;

      workspace.image = result.value;
      return ok({
        width: result.value.width,
        height: result.value.height,
        byteLength: result.value.data.byteLength,
      });
    },
  });

  const critique = defineTool({
    name: "critique_canvas",
    description:
      "Send the captured picture to be looked at, and get back a list of things that appear " +
      "wrong with the drawing. Requires capture_canvas to have run. Findings are suggestions, " +
      "not orders -- read them and decide which are worth acting on.",
    locus: "client",
    readOnly: true,
    argsSchema: z.object({}),
    handler: async () => {
      const image = workspace.image;
      if (!image) {
        return problem("CRITIQUE_NO_IMAGE", "Nothing has been captured yet. Call capture_canvas first.");
      }

      const findings = await options.critique(image);
      workspace.lastFindings = findings;
      return ok({ findings, count: findings.length });
    },
  });

  const report = defineTool({
    name: "report_findings",
    description:
      "Send the findings you judge genuine and worth fixing back to the drawing agent, which " +
      "will repair the diagram. Send only the ones you believe: reporting a finding you doubt " +
      "costs a redraw the viewer has to watch. Send none, and the diagram stands as drawn.",
    locus: "client",
    argsSchema: z.object({
      findings: z
        .array(CritiqueFindingSchema)
        .max(20)
        .describe("The subset of findings worth repairing."),
    }),
    handler: async (args) => {
      await options.report(args.findings);
      return ok({ reported: args.findings.length });
    },
  });

  return [capture, critique, report];
}
```

- [ ] **Step 4: Write the failing test for the loop**

Create `packages/agent-vision/tests/client-agent.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { FakeProvider } from "@sketchmind/llm-provider";
import { runVisionAgent } from "../src/index.js";
import { ok } from "@sketchmind/shared-types";

const image = { mimeType: "image/png", width: 4, height: 4, data: new Uint8Array([1]) };

function options(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    request: "draw a pulley system",
    provider: new FakeProvider({ responses: ["nothing to report"] }),
    capture: async () => ok(image),
    critique: async () => [],
    report: async () => {},
    visionEnabled: true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("runVisionAgent", () => {
  it("runs and reports its stop reason", async () => {
    const result = await runVisionAgent(options() as never);
    expect(result.rounds).toBe(1);
    expect(result.stopReason).toBeTruthy();
  });

  it("builds no capture or critique tool when vision is disabled", async () => {
    const capture = vi.fn(async () => ok(image));
    const provider = new FakeProvider({ responses: ["ok"] });

    await runVisionAgent(options({ visionEnabled: false, capture, provider }) as never);

    expect(capture).not.toHaveBeenCalled();
    // With no vision tools there is nothing for the agent to do, so it must not
    // spend a model turn either.
    expect(provider.calls).toHaveLength(0);
  });

  it("stops at its step budget rather than looping", async () => {
    // A provider that always asks for another capture. Without a budget the
    // loop would never end, so this asserts the budget is what stops it.
    const provider = new FakeProvider({
      responses: ["capturing"],
      toolCalls: Array.from({ length: 20 }, (_, i) => [
        { id: `c${i}`, name: "capture_canvas", arguments: {} },
      ]),
    });
    const capture = vi.fn(async () => ok(image));

    const result = await runVisionAgent(options({ provider, capture, maxSteps: 3 }) as never);

    expect(capture.mock.calls.length).toBeLessThanOrEqual(3);
    expect(result.stopReason).toBeTruthy();
  });

  it("surfaces a capture failure without throwing", async () => {
    const failing = async () => ({ ok: false as const, errors: [] });
    await expect(runVisionAgent(options({ capture: failing }) as never)).resolves.toBeDefined();
  });
});
```

- [ ] **Step 5: Implement the loop**

Create `packages/agent-vision/src/client-agent.ts`:

```ts
/**
 * The client agent locus.
 *
 * It is a real `agent-core` loop with its own budget and its own signal, not a
 * capture pump -- but a deliberately small one. Frontend cost is main-thread
 * work per frame; an extra model call parallelises nothing and competes for the
 * same thread. So there is exactly one agent here, and the throughput work
 * (encoding, framing, transport) is deterministic code elsewhere.
 *
 * When vision is disabled the capture and critique tools are **not built**.
 * That is stronger than a branch that declines to call them: with nothing in the
 * registry, no image can be captured, encoded, sent or logged, and the guarantee
 * is provable by inspecting the tool list.
 */
import { ToolRegistry, runAgent } from "@sketchmind/agent-core";
import type { LLMProvider } from "@sketchmind/llm-provider";
import type { CapturedImage } from "@sketchmind/renderer-core";
import type { CritiqueFinding, ValidationResult } from "@sketchmind/shared-types";
import { VisionWorkspace, createClientVisionTools } from "./tools-client.js";

const SYSTEM_PROMPT = [
  "You are watching a whiteboard an assistant has just finished drawing, and deciding whether",
  "anything about it needs fixing.",
  "",
  "Take a picture, have it looked at, then judge the findings you get back. Report only the ones",
  "you believe: every finding you report costs the viewer a redraw. If the findings repeat what",
  "you reported before, or if the drawing looks right, report nothing and say so.",
  "",
  "Doing nothing is the correct outcome most of the time.",
].join("\n");

export interface RunVisionAgentOptions {
  readonly sessionId: string;
  /** The user's original request; the drawing is judged against it. */
  readonly request: string;
  readonly provider: LLMProvider;
  readonly capture: () => Promise<ValidationResult<CapturedImage>>;
  readonly critique: (image: CapturedImage) => Promise<CritiqueFinding[]>;
  readonly report: (findings: CritiqueFinding[]) => Promise<void>;
  /** False builds no capture or critique tool at all. */
  readonly visionEnabled: boolean;
  readonly signal: AbortSignal;
  readonly maxRounds?: number;
  readonly maxSteps?: number;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly onStep?: Parameters<typeof runAgent>[0]["onStep"];
}

export interface VisionAgentResult {
  readonly reported: CritiqueFinding[];
  readonly rounds: number;
  readonly stopReason: string;
}

export async function runVisionAgent(
  options: RunVisionAgentOptions,
): Promise<VisionAgentResult> {
  if (!options.visionEnabled) {
    return { reported: [], rounds: 0, stopReason: "vision-disabled" };
  }

  const workspace = new VisionWorkspace();
  const reported: CritiqueFinding[] = [];

  const registry = new ToolRegistry(
    createClientVisionTools({
      workspace,
      capture: options.capture,
      critique: options.critique,
      report: async (findings) => {
        reported.push(...findings);
        await options.report(findings);
      },
    }),
  );

  const result = await runAgent({
    sessionId: options.sessionId,
    goal: `The request was: ${options.request}. Check the board and report anything genuinely wrong.`,
    provider: options.provider,
    registry,
    locus: "client",
    systemPrompt: SYSTEM_PROMPT,
    budget: {
      maxSteps: options.maxSteps ?? 6,
      maxTokens: options.maxTokens ?? 20_000,
      timeoutMs: options.timeoutMs ?? 60_000,
    },
    signal: options.signal,
    ...(options.onStep ? { onStep: options.onStep } : {}),
  });

  return { reported, rounds: 1, stopReason: result.stopReason };
}
```

- [ ] **Step 6: Export both**

Add to `packages/agent-vision/src/index.ts`:

```ts
export {
  VisionWorkspace,
  createClientVisionTools,
  type ClientVisionToolsOptions,
} from "./tools-client.js";

export {
  runVisionAgent,
  type RunVisionAgentOptions,
  type VisionAgentResult,
} from "./client-agent.js";
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @sketchmind/agent-vision test && pnpm check:layering`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/agent-vision/src packages/agent-vision/tests
git commit -m "feat(agent-vision): add the client vision agent and its three tools"
```

---

## Task 12: `apps/studio` wiring — capture worker and agent bootstrap

**Files:**
- Create: `apps/studio/src/workers/capture.worker.ts`, `apps/studio/src/vision/captureClient.ts`, `apps/studio/src/vision/bootstrap.ts`
- Modify: `apps/studio/package.json`, `apps/studio/src/App.tsx`, `apps/studio/src/hooks/useSession.ts`, `scripts/check-client-bundle.mjs`
- Test: `apps/studio/tests/captureClient.test.ts`, `apps/studio/tests/bootstrap.test.ts`

**Interfaces:**
- Consumes: `runVisionAgent` (Task 11), `createProxyProvider` (Task 10).
- Produces: `encodeCapture(source): Promise<ValidationResult<CapturedImage>>`, `startVisionAgent(options): Promise<void>`.

- [ ] **Step 1: Add the dependency**

Edit `apps/studio/package.json` and add to `dependencies`:

```json
    "@sketchmind/agent-vision": "workspace:*",
    "@sketchmind/llm-provider": "workspace:*"
```

Run: `pnpm install`

- [ ] **Step 2: Write the capture worker**

Create `apps/studio/src/workers/capture.worker.ts`:

```ts
/**
 * PNG encoding, off the main thread.
 *
 * This is the concrete performance decision of Phase 10. Encoding a full-board
 * canvas costs tens of milliseconds; doing it on the main thread drops frames in
 * the middle of playback, which is exactly when the user is watching. An
 * `OffscreenCanvas` transferred to a worker moves that cost out of the render
 * path entirely.
 *
 * The worker does no judgement and holds no state. It receives a bitmap and
 * returns bytes.
 */
export interface CaptureRequest {
  readonly bitmap: ImageBitmap;
}

export interface CaptureReply {
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly data: ArrayBuffer;
}

self.onmessage = async (event: MessageEvent<CaptureRequest>): Promise<void> => {
  const { bitmap } = event.data;
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  if (!context) {
    self.postMessage({ error: "OffscreenCanvas 2d context unavailable" });
    return;
  }

  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  const blob = await canvas.convertToBlob({ type: "image/png" });
  const data = await blob.arrayBuffer();

  const reply: CaptureReply = {
    mimeType: "image/png",
    width: canvas.width,
    height: canvas.height,
    data,
  };
  self.postMessage(reply, [data]);
};
```

- [ ] **Step 3: Write the failing test for the worker handle**

Create `apps/studio/tests/captureClient.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { encodeCapture } from "../src/vision/captureClient.js";

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  postMessage(): void {
    queueMicrotask(() => {
      this.onmessage?.({
        data: { mimeType: "image/png", width: 4, height: 4, data: new Uint8Array([1, 2]).buffer },
      } as MessageEvent);
    });
  }
  terminate(): void {}
}

describe("encodeCapture", () => {
  it("returns the encoded image from the worker", async () => {
    const result = await encodeCapture({
      worker: new FakeWorker() as unknown as Worker,
      toBitmap: async () => ({ width: 4, height: 4, close() {} }) as unknown as ImageBitmap,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mimeType).toBe("image/png");
    expect(result.value.data).toBeInstanceOf(Uint8Array);
  });

  it("returns a validation failure when the bitmap cannot be produced", async () => {
    const result = await encodeCapture({
      worker: new FakeWorker() as unknown as Worker,
      toBitmap: async () => {
        throw new Error("no canvas");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("CAPTURE_FAILED");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @sketchmind/studio exec vitest run tests/captureClient.test.ts`
Expected: FAIL — `../src/vision/captureClient.js` does not exist.

- [ ] **Step 5: Implement the worker handle**

Create `apps/studio/src/vision/captureClient.ts`:

```ts
/**
 * The main-thread half of the capture worker.
 *
 * Failure here is never fatal: the drawing is already on screen and the viewer
 * has what they came for. A capture that does not happen costs a critique round,
 * nothing more, so every path returns a `ValidationResult` rather than throwing.
 */
import { fail, makeError, ok, type ValidationResult } from "@sketchmind/shared-types";

const PACKAGE = "@sketchmind/studio";

export interface CapturedImage {
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface EncodeCaptureOptions {
  readonly worker: Worker;
  /** Produces the bitmap to encode. Injected so tests need no real canvas. */
  readonly toBitmap: () => Promise<ImageBitmap>;
}

export async function encodeCapture(
  options: EncodeCaptureOptions,
): Promise<ValidationResult<CapturedImage>> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await options.toBitmap();
  } catch (cause) {
    return fail([
      makeError({
        code: "CAPTURE_FAILED",
        message: `The canvas could not be captured: ${(cause as Error).message}`,
        package: PACKAGE,
        stage: "render",
        recoverable: true,
      }),
    ]);
  }

  return new Promise((resolve) => {
    options.worker.onmessage = (event: MessageEvent) => {
      const reply = event.data as { error?: string; mimeType?: string; width?: number; height?: number; data?: ArrayBuffer };
      if (reply.error || !reply.data) {
        resolve(
          fail([
            makeError({
              code: "CAPTURE_FAILED",
              message: reply.error ?? "The capture worker returned no image.",
              package: PACKAGE,
              stage: "render",
              recoverable: true,
            }),
          ]),
        );
        return;
      }

      resolve(
        ok({
          mimeType: reply.mimeType ?? "image/png",
          width: reply.width ?? 0,
          height: reply.height ?? 0,
          data: new Uint8Array(reply.data),
        }),
      );
    };

    options.worker.postMessage({ bitmap }, [bitmap as unknown as Transferable]);
  });
}
```

- [ ] **Step 6: Write the bootstrap and its test**

Create `apps/studio/tests/bootstrap.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { startVisionAgent } from "../src/vision/bootstrap.js";

describe("startVisionAgent", () => {
  it("does nothing when the server says vision is disabled", async () => {
    const fetchImpl = vi.fn();
    await startVisionAgent({
      sessionId: "s1",
      request: "draw a box",
      visionEnabled: false,
      capture: async () => ({ ok: false, errors: [] }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: new AbortController().signal,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
```

Create `apps/studio/src/vision/bootstrap.ts`:

```ts
/**
 * Builds the client agent and its transport, and starts it.
 *
 * Everything vendor-shaped stays server-side: the agent's model turns go to
 * `/api/agent/llm` through a proxy provider that is pure `fetch`, so this bundle
 * carries no SDK and no key. `pnpm check:bundle` asserts that rather than
 * trusting it.
 */
import { runVisionAgent } from "@sketchmind/agent-vision";
import { createProxyProvider } from "@sketchmind/llm-provider";
import type { CritiqueFinding, ValidationResult } from "@sketchmind/shared-types";
import type { CapturedImage } from "./captureClient.js";

export interface StartVisionAgentOptions {
  readonly sessionId: string;
  readonly request: string;
  readonly visionEnabled: boolean;
  readonly capture: () => Promise<ValidationResult<CapturedImage>>;
  readonly fetchImpl?: typeof fetch;
  readonly signal: AbortSignal;
  readonly apiBase?: string;
}

/**
 * Chunked, because `String.fromCharCode(...bytes)` spreads every byte onto the
 * call stack and a real board PNG is hundreds of kilobytes -- which overflows it.
 */
function toBase64(data: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < data.length; i += CHUNK) {
    binary += String.fromCharCode(...data.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function startVisionAgent(options: StartVisionAgentOptions): Promise<void> {
  if (!options.visionEnabled) return;

  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = options.apiBase ?? "";

  await runVisionAgent({
    sessionId: options.sessionId,
    request: options.request,
    provider: createProxyProvider({ endpoint: `${base}/api/agent/llm`, fetchImpl: doFetch }),
    visionEnabled: true,
    signal: options.signal,
    capture: options.capture as never,

    critique: async (image) => {
      const response = await doFetch(`${base}/api/agent/vision-critique`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: options.sessionId,
          mimeType: image.mimeType,
          width: image.width,
          height: image.height,
          base64: toBase64(image.data),
        }),
        signal: options.signal,
      });
      if (!response.ok) return [];
      return ((await response.json()) as { findings: CritiqueFinding[] }).findings;
    },

    report: async (findings) => {
      await doFetch(`${base}/api/sessions/${options.sessionId}/findings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ findings }),
        signal: options.signal,
      });
    },
  });
}
```

- [ ] **Step 7: Trigger it from the session hook**

In `apps/studio/src/hooks/useSession.ts`, on receiving a `SessionCompleted` event, call `startVisionAgent` with the session id, the submitted prompt, `visionEnabled` from the `SessionStarted` payload, and a capture closure built from the Konva adapter plus `encodeCapture`. Batch `FrameUpdate` handling through `requestAnimationFrame` so a burst of frames costs one paint:

```ts
  const pending = useRef<DrawingFrame | null>(null);
  const raf = useRef<number | null>(null);

  const scheduleFrame = useCallback((frame: DrawingFrame) => {
    pending.current = frame;
    if (raf.current !== null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      const next = pending.current;
      pending.current = null;
      if (next) setFrame(next);
    });
  }, []);
```

- [ ] **Step 8: Add `apps/studio` to the bundle check**

In `scripts/check-client-bundle.mjs`, add `apps/studio/dist` to the list of scanned target directories alongside the existing `apps/web` entry.

- [ ] **Step 9: Run everything**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm check:bundle`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/studio scripts/check-client-bundle.mjs pnpm-lock.yaml
git commit -m "feat(studio): add the capture worker and client vision agent bootstrap"
```

---

## Task 13: Acceptance fixtures

**Files:**
- Create: `tests/vision-self-correction.test.ts`
- Test: the same file

**Interfaces:**
- Consumes: everything above. This is the phase's acceptance gate.

- [ ] **Step 1: Write the acceptance tests**

Create `tests/vision-self-correction.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { critiqueGeometry } from "@sketchmind/agent-vision";
import { FakeProvider } from "@sketchmind/llm-provider";
import { loadConfig } from "../apps/api/src/config.js";
import type { DiagramAST, LayoutModel } from "@sketchmind/shared-types";

const ast = { objects: [], relationships: [] } as unknown as DiagramAST;

/** A pulley whose rope endpoint misses the groove anchor by 40 units. */
const MISPLACED: LayoutModel = {
  version: "1.0.0",
  diagramId: "pulley",
  strategy: "manual",
  canvas: { width: 400, height: 400 },
  nodes: [
    {
      objectId: "pulley_1",
      position: { x: 180, y: 40 },
      size: { width: 40, height: 40 },
      rotation: 0,
      bounds: { x: 180, y: 40, width: 40, height: 40 },
      anchors: [{ name: "groove", point: { x: 200, y: 80 } }],
      zIndex: 0,
    },
    {
      objectId: "weight_1",
      position: { x: 180, y: 300 },
      size: { width: 40, height: 40 },
      rotation: 0,
      bounds: { x: 180, y: 300, width: 40, height: 40 },
      anchors: [],
      zIndex: 0,
    },
  ],
  connectors: [
    {
      relationshipId: "rope_1",
      routing: "straight",
      points: [
        { x: 240, y: 80 },
        { x: 200, y: 300 },
      ],
      metadata: { sourceAnchor: "pulley_1:groove" },
    },
  ],
  labels: [],
} as LayoutModel;

/** The same diagram after the repair the findings ask for. */
const CORRECTED: LayoutModel = {
  ...MISPLACED,
  connectors: [
    {
      ...MISPLACED.connectors[0]!,
      points: [
        { x: 200, y: 80 },
        { x: 200, y: 300 },
      ],
    },
  ],
} as LayoutModel;

describe("acceptance: tier 1 alone detects and verifies a misplaced component", () => {
  it("detects the rope not meeting the pulley", () => {
    const findings = critiqueGeometry({ ast, layout: MISPLACED });
    const anchorMiss = findings.filter((f) => f.check === "anchor-miss");

    expect(anchorMiss).toHaveLength(1);
    expect(anchorMiss[0]?.objectIds).toContain("pulley_1");
    expect(anchorMiss[0]?.tier).toBe("geometric");
  });

  it("passes the corrected layout with no findings", () => {
    expect(critiqueGeometry({ ast, layout: CORRECTED })).toEqual([]);
  });

  it("proposes a fix in words, never a coordinate", () => {
    const [finding] = critiqueGeometry({ ast, layout: MISPLACED }).filter(
      (f) => f.check === "anchor-miss",
    );
    expect(finding?.proposal).toBeDefined();
    expect(JSON.stringify(finding?.proposal)).not.toMatch(/\d{2,}/);
  });
});

describe("acceptance: vision off means no image anywhere", () => {
  it("keeps the tier inert with mode off", () => {
    expect(loadConfig({}).vision.mode).toBe("off");
  });

  it("never constructs a vision request when the provider cannot see", async () => {
    const provider = new FakeProvider({ capabilities: { vision: false } });
    const { critiqueImage } = await import("@sketchmind/agent-vision");

    const result = await critiqueImage({
      provider,
      image: { mimeType: "image/png", width: 1, height: 1, data: new Uint8Array([1]) },
      request: "draw a box",
      layoutSummary: "1 object",
    });

    expect(result.ok).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("acceptance: enabling the tier is configuration, not code", () => {
  it("turns on with mode=auto and a vision-capable provider", () => {
    const config = loadConfig({ SKETCHMIND_VISION_MODE: "auto" });
    const provider = new FakeProvider({ capabilities: { vision: true } });

    const enabled = config.vision.mode !== "off" && provider.capabilities.vision;
    expect(enabled).toBe(true);
  });

  it("stays off with mode=auto and a text-only provider", () => {
    const config = loadConfig({ SKETCHMIND_VISION_MODE: "auto" });
    const provider = new FakeProvider({ capabilities: { vision: false } });

    const enabled = config.vision.mode !== "off" && provider.capabilities.vision;
    expect(enabled).toBe(false);
  });
});

describe("acceptance: provider independence", () => {
  it("drives the visual tier identically under two different provider ids", async () => {
    const { critiqueImage } = await import("@sketchmind/agent-vision");
    const reply = JSON.stringify({ findings: [] });

    for (const id of ["alpha", "beta"]) {
      const provider = new FakeProvider({ id, capabilities: { vision: true }, responses: [reply] });
      const result = await critiqueImage({
        provider,
        image: { mimeType: "image/png", width: 1, height: 1, data: new Uint8Array([1]) },
        request: "draw a box",
        layoutSummary: "1 object",
      });
      expect(result.ok).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm exec vitest run tests/vision-self-correction.test.ts --config tests/vitest.config.ts`
Expected: PASS (10 tests).

- [ ] **Step 3: Add the vendor-name guard**

Append to the same file:

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (entry === "node_modules" || entry === "dist") return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}

describe("acceptance: no vendor names outside the composition root", () => {
  const FORBIDDEN = /azure|openai|anthropic|claude|gpt-/i;

  it("agent-vision names no vendor", () => {
    for (const file of sourceFiles("packages/agent-vision/src")) {
      expect(FORBIDDEN.test(readFileSync(file, "utf8")), file).toBe(false);
    }
  });

  it("the critique route names no vendor", () => {
    expect(FORBIDDEN.test(readFileSync("apps/api/src/routes/vision.ts", "utf8"))).toBe(false);
  });

  it("the studio vision code names no vendor", () => {
    for (const file of sourceFiles("apps/studio/src/vision")) {
      expect(FORBIDDEN.test(readFileSync(file, "utf8")), file).toBe(false);
    }
  });
});
```

- [ ] **Step 4: Run the full suite**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/vision-self-correction.test.ts
git commit -m "test: add Phase 10 acceptance fixtures"
```

---

## Task 14: Documentation

**Files:**
- Modify: `CLAUDE.md`, `.env.example`, `packages/agent-vision/README.md`, `docs/superpowers/plans/2026-08-05-sketchmind-implementation-plan.md`

- [ ] **Step 1: Document the environment variables**

Add to `.env.example`:

```sh
# --- Vision self-correction (Phase 10, AD-3) ---
# Tier 1: deterministic geometric critique. Free, and on by default.
SKETCHMIND_GEOMETRIC_CRITIQUE=on
# Tier 2: image critique. off | auto | on.
#   auto = runs exactly when a vision-capable provider resolves.
SKETCHMIND_VISION_MODE=off
SKETCHMIND_VISION_MAX_ROUNDS=2
SKETCHMIND_VISION_MAX_IMAGE_BYTES=4000000
SKETCHMIND_REPAIR_MAX_ROUNDS=2
SKETCHMIND_REPAIR_MAX_STEPS=12

# Model roles. Both fall back to SKETCHMIND_LLM_PROVIDER; either may name any
# registered provider and any model, and they need not agree on either.
# SKETCHMIND_TEXT_PROVIDER=azure-openai
# SKETCHMIND_TEXT_MODEL=gpt-4o-mini
# SKETCHMIND_VISION_PROVIDER=anthropic
# SKETCHMIND_VISION_MODEL=claude-sonnet-5
```

- [ ] **Step 2: Update the package README**

Replace `packages/agent-vision/README.md` with a description of the two tiers, the four public entry points (`critiqueGeometry`, `critiqueImage`, `createVisionTools`, `runVisionAgent`), and the note that this package does not import `layout-engine`.

- [ ] **Step 3: Update `CLAUDE.md`**

In the "Project status" paragraph, change "Phases 1–9 complete" to "Phases 1–10 complete", describe Phase 10 in one sentence, and add a pointer to `docs/superpowers/specs/2026-08-06-phase-10-vision-self-correction-design.md` alongside the existing phase-decision links. Change "Phase 10 (`agent-vision` …) is next" to "Phase 11 (client agent full autonomy) is next".

- [ ] **Step 4: Mark the phase complete in the implementation plan**

In `docs/superpowers/plans/2026-08-05-sketchmind-implementation-plan.md` §Phase 10, tick the acceptance boxes and add a line noting that the spec revised 10b from a server pre-playback stage to a client locus, with a pointer to the spec.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md .env.example packages/agent-vision/README.md docs/superpowers/plans/2026-08-05-sketchmind-implementation-plan.md
git commit -m "docs: record Phase 10 vision self-correction"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Shared critique types, `VisionCritique` event | 1 |
| Tier 1 — seven checks, thresholds, determinism | 2, 3, 4 |
| `critique_diagram` server tool | 4 |
| Two model roles, `ProviderOptions` model override | 5, 6 |
| Gating (three-way, `off`/`auto`/`on`) | 6, 8 |
| `critiqueImage`, prompt as data | 7 |
| `/api/agent/vision-critique` | 8 |
| Automatic pre-playback pass | 9 |
| Repair turn, round caps, `findingsEqual` | 9 |
| Proxy provider | 10 |
| Client agent, three tools, vision-off registry proof | 11 |
| Capture worker, rAF frame batching, `check:bundle` | 12 |
| Acceptance criteria, provider-independence guard | 13 |
| Config documentation | 14 |

**Known gap, deliberately left:** the spec's cadence says the client agent also wakes "after each repair redraw settles". Task 12 wires the first wake on `SessionCompleted`; the second wake arrives free, because a repair turn ends with playback emitting `SessionCompleted` again, and `record.visionRounds` caps the total at 2 either way.

**Type consistency:** `CritiqueFinding`, `FixProposal`, `GeometricCritiqueOptions`, `CheckName`, `VisionWorkspace`, `ProviderOptions`, `ProviderRole`, `VisionConfig`, `RepairConfig` are each defined once and referenced with the same names throughout. `critiqueGeometry` takes `{ ast, layout, strokes?, options? }` in Tasks 4, 9 and 13 alike.

**One risk flagged for the implementer:** Task 5 touches `llm-provider` and both adapters — the repo's most CI-guarded seam. If `AzureOpenAIProvider`'s constructor does not currently take an options bag, add one rather than reading the override from env, or the vendor variable name leaks upward.
