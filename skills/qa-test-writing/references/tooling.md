# Running and reading the suite

## The suite

```bash
npm test          # node --test --test-timeout=30000
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

## Scratch archives

To test against a mutated tree without touching the checkout:

```bash
mkdir -p /tmp/scratch && cd /tmp/scratch
git -C <repo> archive HEAD | tar -x
ln -s <repo>/node_modules node_modules    # scratch only — never a worktree
FORCE_COLOR=0 node --test <file>          # confirm GREEN before mutating
```

`git archive HEAD` gives a committed tree, so the scratch cannot contain
uncommitted state you forgot about.

## Timeouts

`--test-timeout=30000` per test. The brief compiler's baseline has a fixed 300s
timeout and runs the **whole suite on every compile** (~50s alone; longer when
several compiles contend). Compile briefs separately or in the background —
three in one foreground shell call will exceed a two-minute tool timeout.

## Reading a run's results

- A driver run's roll-up is `returns/task.json`, but it records only **which
  fields** a seat envelope carried.
- **Scout findings live in `returns/d1.planner.json`**, not `task.json`. Reading
  `task.json` shows `findings: 0` and means nothing.
- The journal is `journal.jsonl` in the task dir; the boot journal is one level
  up, beside `crew.json`.

## Re-derive a surprising measurement

If a number surprises you, get it a second way before acting on it. Measured
failures of this rule in one session: process counts from `pgrep`, a lazily
opened database read as empty, an invented field name, sibling-lane pollution,
and a compound `cd` that silently changed what a relative path meant.
