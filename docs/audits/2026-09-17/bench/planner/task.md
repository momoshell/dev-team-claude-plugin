# Planner scout work item

Work from the repository root and produce one machine-readable scout finding file. Do not edit tracked source files, create commits, contact an endpoint, or run a model-evaluation bench.

## Deliverable

Create `.bench-out/` if it is absent and write only `.bench-out/planner-scout.json`. The file must be a closed JSON object with this exact shape:

```json
{
  "schema": 1,
  "target": "bench-sha-mismatch",
  "findings": [
    { "path": "repository-relative/file.mjs", "line": 1, "classification": "one nonblank line" }
  ]
}
```

Use repository-relative paths, one-based integer line numbers, and a nonblank single-line classification for every finding. Find every occurrence of the literal target in tracked worktree `*.mjs` files. The list must contain each citation exactly once and no invented citations. A citation resolves only when its path and line still contain the target in the checkout being gated.

The scan floor is `git ls-files`: include tracked `*.mjs` files only. Exclude `.git`, `node_modules`, `.bench-out`, and `docs/audits/2026-09-17/bench` (the bench inputs and its generated material are not scout findings). Read files incrementally if needed, and treat a missing, unreadable, or interrupted read as a reason to stop rather than guessing. The output is the only authorized write; leave all source bytes unchanged.

The mechanical gate reports P1 shape, P2 citation resolution and classification, P3 duplicate or invented citations, and P4 omitted occurrences or source edits. A missing or malformed output is a failed check, not an error.
