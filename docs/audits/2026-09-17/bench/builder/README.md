# Builder mechanical bench

This directory is the builder seat's repeatable mechanical bench. A candidate edits only the preserved work item below; the surrounding operator documentation and scaffold bytes stay unchanged.

The gate checks that the README and its work-item markers are readable exactly once, that the work item is the canonical result, and that the tracked diff contains only this README. Worktree isolation supplies the candidate's disposable checkout.

`bench.sha` is the SHA-256 digest produced from the exact UTF-8 bytes of `task.md`, `gate.mjs`, `judge.json`, and `candidates.json` using the exported `benchSha` framing. Recompute it whenever one of those four inputs changes; it is not a digest of this README.

Bare CLI `model-eval.mjs compile` probes each declared local endpoint, so that command is not an offline proof. The injected-probe compile test is the offline check. `model-eval.mjs run` is operator-only and is not part of gate or contract validation.

```BENCH_WORK_ITEM
[3, -1, 3, 2, -1]
<!-- PLACEHOLDER: replace this array with the canonical ascending unique JSON array. -->
```
