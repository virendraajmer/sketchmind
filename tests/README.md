# tests/

Root-level tests that span multiple packages. Package-local unit tests live in
`packages/<name>/tests/` (Volume 11 §Testing Strategy, Volume 17).

What belongs here:

- **Contract tests** — a package's public API behaves as its consumers expect.
- **Integration tests** — several packages composed, e.g. `DiagramAST → LayoutModel → StrokeAST`.
- **System tests** — the full flow: a request through the agent, pipeline, and renderer.

Snapshot fixtures (sample ASTs, reference renders) live in `examples/`.
