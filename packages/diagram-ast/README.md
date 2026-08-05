# @sketchmind/diagram-ast

Builds, validates, and serializes the Diagram AST — the single source of truth
for what a diagram contains (Volume 04).

## Public API

| Function | Purpose |
| --- | --- |
| `buildDiagramAST(input)` | Stamp the schema version and validate. The agent never supplies a version. |
| `validateDiagramAST(input)` | Schema + semantic validation of an existing AST |
| `serializeDiagramAST(ast)` | Deterministic JSON with sorted keys |
| `parseDiagramAST(json)` | Parse and validate; malformed JSON is an error, not a throw |
| `collectObjects(ast)` | Depth-first flatten, parents before children |
| `findObject(ast, id)` | Locate a nested object |

## Nothing here throws

Every entry point returns a `ValidationResult<DiagramAST>` carrying structured
`SketchMindError`s. Per AD-2, a validation failure is an observation the agent
acts on, not a pipeline halt: it reads the errors, fixes its AST, and calls
again. Errors accumulate — an agent that gets one error per round trip burns a
round trip per mistake.

Callers that genuinely cannot continue can use `assertValid` from
`@sketchmind/shared-types`.

## Semantic checks

The schema checks shape; these check meaning, which no per-field schema can see:

| Code | Rule |
| --- | --- |
| `AST_DUPLICATE_ID` | Object and relationship ids unique, including across nesting levels |
| `AST_UNKNOWN_REFERENCE` | Relationships, groups, and annotations point at objects that exist |
| `AST_UNKNOWN_ANCHOR` | Labels and connectors name anchors the target actually exposes |
| `AST_ORPHAN_OBJECT` | Every object is connected by relationship, parent, child, or group |
| `AST_SELF_REFERENCE` | No relationship connects an object to itself |
| `AST_MALFORMED_JSON` | Input was not JSON |

A single-object diagram is not an orphan — "draw a circle" is a legitimate
request, and failing it would be the validator enforcing a rule the product does
not have.

## Determinism

`serializeDiagramAST` sorts keys. Snapshot tests and the layout cache both key
off that string, and `JSON.stringify` emits keys in insertion order — so two
semantically identical ASTs assembled in different orders would otherwise
produce different bytes and miss the same cache entry forever (AD-6).

## Dependency rules

This package may depend only on its own layer or below. Direction is enforced
by `scripts/check-layering.mjs`; run `pnpm run check:layering`.
