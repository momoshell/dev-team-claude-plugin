# Planner bench 3 — manifest reconciliation

Work from the repository root and produce one machine-readable reconciliation file. Do not edit tracked source files, create commits, contact an endpoint, or run a model-evaluation bench.

## Deliverable

Create `.bench-out/` if it is absent and write only `.bench-out/planner-3.json`. The file must be a closed JSON object with this exact shape:

```json
{
  "schema": 1,
  "kind": "manifest-reconciliation",
  "present": [],
  "missing": [],
  "extra": []
}
```

Reconcile the `files` list in `docs/audits/2026-09-19/bench/planner-3/fixture/manifest.json` against the files actually present in its `fixture/files/` directory. Put listed files found on disk in `present`, listed files absent from disk in `missing`, and disk files absent from the manifest in `extra`. Sort all three arrays lexicographically, and include each name at most once.

The carried fixture is the complete scan floor. Do not contact endpoints, run a bench, or edit tracked files. The output is the only authorized write. The mechanical gate reports closed shape, exact disk reconciliation, and duplicate checks.
