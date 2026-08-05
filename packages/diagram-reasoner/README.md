# @sketchmind/diagram-reasoner

Whatever reasoning exists so far, to a validated `DiagramAST`
(V03 §Diagram Composition, V04, V15 §Agent Contracts). Never produces
coordinates.

## Not "ShapeGraph → DiagramAST"

The Package Map calls it that, and under the docs' fixed pipeline that is all it
could be. Under AD-1 the shape graph is *optional*, along with the plan and the
intent: the agent decides how much reasoning a request deserves, and this stage
has to compose a valid AST from whatever it was handed — up to and including
nothing but the user's sentence.

That is what makes "draw a circle" cost one model call instead of four, and it is
stated to the model too: the prompt's Allowed Inputs section says each earlier
stage arrives "if one was produced", and its completion rules say what to do when
none did. A prompt that assumes a full pipeline is a prompt that makes the simple
case expensive.

## Repair is a normal call, not a mode

`composeDiagramAST` accepts `previousAttempt` **and** `previousErrors`. Both,
because errors alone are a riddle — "objects[3] is an orphan" means nothing
without the text it refers to. Supplying the pair is what turns AD-2's
"validation errors are observations" into a repair the model can actually
perform, and it needs no special code path: the agent's fix step is the same call
with two more fields.

## Validation is delegated, not reimplemented

The composed AST goes through `@sketchmind/diagram-ast`'s `buildDiagramAST`,
which stamps the schema version and runs that package's own schema and semantic
checks. Duplicating either here would give the agent two slightly different
definitions of a valid AST, and it would find the disagreement before we did.
`validateDiagramAST` is re-exported so a caller holding only this package can
check a hand-composed AST without reaching past it.

## Public API

See `src/index.ts`. Internals live in `src/internal/` and are not importable
from other packages (Volume 12).

## Dependency rules

Depends on `@sketchmind/diagram-ast`, `@sketchmind/llm-provider` and
`@sketchmind/shared-types`, and on no concrete provider. Direction is enforced by
`scripts/check-layering.mjs`; run `pnpm run check:layering`.
