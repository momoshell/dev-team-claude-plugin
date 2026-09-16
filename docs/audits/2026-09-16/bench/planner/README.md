# Planner scout bench

This directory contains the planner scout's repeatable, offline model-evaluation inputs. The scout writes only `.bench-out/planner-scout.json` in its disposable worktree; the gate checks the closed finding shape and the complete tracked `*.mjs` citation set for `bench-sha-mismatch`.

`bench.sha` is the SHA-256 digest produced from the exact UTF-8 bytes of `task.md`, `gate.mjs`, `judge.json`, and `candidates.json` using the exported `benchSha` framing. It is provenance for those four inputs, not for scout output.

Bare CLI `model-eval.mjs compile` probes each declared local endpoint, so that command is not an offline proof. The injected-probe compile test is the offline check. `model-eval.mjs run` is operator-only and is not part of gate or contract validation.
