# examples/

Fixtures for snapshot and regression tests (Volume 17 §Snapshot Testing):
sample Diagram ASTs, Layout Models, Stroke ASTs, and reference renders.

These are the inputs that make the deterministic half of the pipeline testable.
Per AD-6, determinism is guaranteed from `DiagramAST` onward — the same AST must
always produce the same layout, strokes, and pixels. Snapshot tests here are what
enforce that, and they are unaffected by the agent's non-deterministic reasoning
because they start from a checked-in AST rather than a prompt.
