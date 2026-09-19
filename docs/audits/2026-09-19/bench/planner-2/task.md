# Planner bench 2 — anchor inventory

Work from the repository root and produce one machine-readable finding file. Do not edit tracked source files, create commits, contact an endpoint, or run a model-evaluation bench.

## Deliverable

Create `.bench-out/` if it is absent and write only `.bench-out/planner-2.json`. The file must be a closed JSON object with this exact shape:

```json
{
  "schema": 1,
  "kind": "anchor-inventory",
  "findings": [
    { "path": "docs/audits/2026-09-19/bench/planner-2/fixture/a.mjs", "line": 3, "anchor": "alpha-ready" }
  ]
}
```

List every `ANCHOR(<id>)` marker in `docs/audits/2026-09-19/bench/planner-2/fixture/*.mjs`, using repository-relative paths and one-based line numbers. Sort findings by path and then line. A citation must identify the line that contains its marker; include each marker exactly once and invent none.

The carried fixture is the complete scan floor. Do not contact endpoints, run a bench, or edit tracked files. The output is the only authorized write. The mechanical gate reports closed output shape, citation resolution, duplicate or invented citations, and omissions.
