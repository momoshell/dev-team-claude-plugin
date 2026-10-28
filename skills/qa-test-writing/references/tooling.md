# Running and reading the suite

## The suite

```bash
npm test          # node --test --test-timeout=30000 "**/*.test.mjs"
```

Builtins-only: no test framework, no runner dependency. `node --test` with
`node:test` and `node:assert/strict`. A fresh worktree with **no `node_modules`**
still runs the suite.

Do **not** symlink `node_modules` into a worktree to "fix" it. A symlink is not
matched by a `node_modules/` gitignore directory pattern, so it shows as `??`
and a crew run refuses on a dirty checkout. Measured 2026-08-22; it cost a run
restart.

If a measurement you make would differ with `node_modules` present, **say so**
rather than reporting a number that quietly assumes one state. A scout once
reported a package as "declared-but-uninstalled" purely because its worktree had
no `node_modules` — and was wrong about the repo.

## ANSI will lie to you

The harness exports `FORCE_COLOR`, and **`FORCE_COLOR` beats `NO_COLOR`**. Under
it, `node --test`'s summary carries escape sequences and becomes unparseable: a
green run reads as red (#240).

- Prefix suite greps with `FORCE_COLOR=0`, **or** drop the `^` anchor.
- An empty grep result on a pipe is **suspect decoration** until proven
  otherwise — check before concluding the thing you grepped for is absent.
- A gate that shells out to the suite strips ANSI before parsing.

## Scratch trees

To test against a mutated tree without touching the checkout:

```bash
git worktree add --detach /tmp/scratch HEAD
cd /tmp/scratch
FORCE_COLOR=0 node --test <file>          # confirm GREEN before mutating
# ...work...
cd - && git worktree remove /tmp/scratch
```

**Only a detached worktree reproduces the real baseline.** Seven strategies were
measured on this repo (`b150-permprobe`, 2026-08-22), each created and then run
unmutated:

| strategy | create | disk | git repo? | suite |
|---|---|---|---|---|
| `git worktree add --detach` | **52 ms** | 7.11 MiB | yes | **2084 / 0** |
| `git archive HEAD \| tar -x` | 59 ms | 7.11 MiB | **no** | 2051 / **33** |
| `git clone --local --shared` | 59 ms | 7.25 MiB | yes | 2083 / 1 |
| `cp -R` (incl. `.git`) | 105 ms | 7.11 MiB | yes | 2083 / 1 |
| archive + `git init` + commit | 249 ms | 10.28 MiB | yes | 2083 / 1 |
| `git clone --local --no-hardlinks` | 215 ms | 17.71 MiB | yes | 2083 / 1 |
| `git clone --local` | 285 ms | 17.71 MiB | yes | 2083 / 1 |

The archive tree is not a git repo, so repo identity resolves to the scratch
directory's own name and every profile-keyed test fails. The clone and copy
strategies each leave one failure. The fastest strategy is also the only clean
one.

A detached worktree **shares the object store and must be removed** with
`git worktree remove` — you cannot simply `rm -rf` it and forget.

## Timeouts

`--test-timeout=30000` per test. A full-suite run takes about a minute; run it in the background or
run the targeted test file instead, so one foreground call stays under the
tool timeout.

## Reading a run's results

- A seat's envelope is the JSON file at its return path in the task dir
  (`builder-2.json`, `reviewer-1.json`). Read the envelope, not a roll-up.
- Each seat turn is recorded under `lean/<role>/<id>.jsonl` in the task dir, and
  the run's journal is `journal.jsonl` beside it.

## Re-derive a surprising measurement

If a number surprises you, get it a second way before acting on it. Measured
failures of this rule in one session: process counts from `pgrep`, a lazily
opened database read as empty, an invented field name, sibling-lane pollution,
and a compound `cd` that silently changed what a relative path meant.
