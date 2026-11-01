# Dev-team repository evidence

These exhibits are evidence from the dev-team repository, not requirements for other repositories. Historical exhibits are labelled where no live exhibit remains. Commands and workflow details below describe the measured repository, not a universal recipe; use the current general references for guidance.

## Vacuity

# Vacuity: checks that cannot fail

A vacuous check passes whether the behaviour it names is present or absent. It
is worse than no check, because it is trusted.

Measured in this repo by the `b131-vacuity` scout (2026-08-22, issue #476):
**12 candidates examined, 9 vacuous, 3 proven-discriminating, 75%**, with the
neutralisation recorded for every one. The ratio is quoted with its denominator
on purpose; "several tests are weak" is not a finding.

### What a check may assert

A check may assert only against an authoritative stream or mutable data,
never against the presence of a service, method, key or symbol. Asserting that
a name exists, a key, an export, a method, passes whether the behaviour
behind it works or not: #578 shipped a `doesNotMatch`
against a key that is never serialised, #603's tripwire matched only a column-0
`function`, and #581's guard could only pass by finding hits. The kill-mutation proof in
`crew/checks.mjs` (`proveMutations`) is what catches that shape now: a check
the planner declares must go red when its mutation is applied.

### The method: mutation, not reading

You cannot see vacuity by reading. Neutralise the behaviour and re-run.

Do it in a **disposable scratch tree, never the working checkout**:

```bash
git worktree add --detach /tmp/vac HEAD          # see the warning below
cd /tmp/vac
FORCE_COLOR=0 node --test <the affected test file>   # confirm GREEN first
# ...apply the mutation...
FORCE_COLOR=0 node --test <the affected test file>   # did it go red?
cd - && git worktree remove /tmp/vac              # it is a real worktree: remove it
```

**Use a detached worktree, not `git archive`.** Measured over seven scratch
strategies (`b150-permprobe`, 2026-08-22): `git archive HEAD | tar -x` produces
a tree that is **not a git repo**, so repo identity resolves to the scratch
directory's name and the profile tests fail, **2051 pass / 33 fail** on an
unmutated tree. Every other strategy leaves at least one failure too. Only
`git worktree add --detach` reproduces the real baseline, **2084/0**, and it is
also the fastest to create (52 ms, 7.11 MiB). A detached worktree shares the
object store and **must be removed**, unlike an archive you can `rm -rf`.

Confirm green **before** mutating. A scratch that was already red proves
nothing, and this is the step people skip, it is also what catches a bad
scratch strategy before it wastes an afternoon.

Two independent scratches beat one: the b131 sweep ran every candidate twice,
which is what makes its ratio quotable rather than anecdotal.

Pair the neutralisation with a **direct probe** showing the behaviour really is
gone. A mutation you believe worked, but did not, reads exactly like a
discriminating check.

### The three shapes

#### 1. The fixture cannot reach the subject

The assertion is fine; the input never exercises the code.

- **V9**, a check pinned a sort, over a fixture that **was already sorted**.
  Removing the sort left it green.
- **V3**, a historical stale-reaping fixture returned before reaching its
  process-kill seam, leaving a security boundary unpinned (no live exhibit).

**The fix changes the FIXTURE, not the assertion.** Strengthening an assertion
over input that never arrives produces a more confident vacuous check.

#### 2. The expected value comes from the implementation

The check compares the implementation to itself.

- **V7**, a mirror check compared a vocabulary to itself.
  Removing a member changed both sides.
- **V8**, a loop iterated exactly the keys the implementation produced, then
  asserted each was produced.

**The fix takes the expected value from somewhere the implementation cannot
edit**: a literal written out in the test, a committed fixture, a recorded
capture.

#### 3. The detector's key is the only guard

A drift guard that greps for a literal is blind to every spelling that is not
that literal.

- **V5**, a historical ledger-sandbox detector keyed on one literal spelling (no live exhibit). Measured
  blind to: an alias, an indirect caller, a block comment, a JSDoc body, a
  template literal, and an assignment pointing *at* the real ledger. Defeated in
  the sweep by aliasing.

V5 was hit independently by **three scouts on disjoint briefs in one batch**
(`b130-postmerge`, `b131-vacuity`, `b132-contention`). Convergence from
independent angles is a strong signal; treat it as one.

**The fix pins the detector itself**, or replaces the key with something drift
cannot rename.

This repository's own documentation had the same shape: a guard that reads
existence and range, never content, passes over a citation that points at the
wrong line. `references/citations.md` carries the rule that replaced it: cite a
path or a symbol, not a line.

### The three verified negatives

Recorded so no later sweep re-spends them, these **do** discriminate:

- the billed-money null assertion (`crew/pi/extensions/subagent.test.mjs`, the absent-usage case: omitting the key and keeping usage `null` reddens when the null becomes a zero)
- historical transcript and kill-helper checks (no live exhibit)

Note V4/N2 as a pair: that guard genuinely pins `tools` and does **not** pin
`deny` at all. A check can discriminate for one field and be vacuous for the
field beside it. Establish which field you are pinning.

### What to do with a vacuous check

Either make it redden when the behaviour is removed, or **delete it and say what
it was supposed to stop**. Do not delete checks to move a number.

The two from the sweep that were more than test debt, two historical security boundaries (no live exhibit), are the argument for
this whole file: both are security-shaped boundaries that could have been
deleted with a fully green suite.

### Not in scope of a vacuity pass

"There is no test for X" is a coverage gap, not vacuity. A vacuity pass is only
about checks that **cannot fail**. Keep them separate; they have different fixes
and different urgency.


## Gates

# Acceptance gates

An acceptance gate is a program the planner authors per task, which the loop
runs (`runGate` in `crew/checks.mjs`). It is the task's definition of done, expressed as something that runs.

### The four properties

1. **RED at baseline.** The gate must fail on the tree before the work lands. A
   gate that is green at baseline accepts a tree that has not changed.

2. **`errored: 0` at baseline.** Red is not enough. A gate that *crashes* also
   reports failure, and a wholly broken gate, a syntax error, a bad import ,
   passes a naive baseline-red check while testing nothing. This is #153: the
   baseline check proved the gate **exited**, not that it **ran**. The gate
   prints `GATE-SUMMARY {"total":n,"failed":n,"errored":n}` and `errored` must be
   `0` at baseline.

3. **Discrimination is proved by the loop, once per gate version**, not
   asserted in prose in the brief (#168). A gate that claims to discriminate and
   was never made to, is a claim.

4. **Every declared mutation kills its own check.** Declare `{check, file, find,
   replace}` for each acceptance id; `proveMutations` in `crew/checks.mjs` applies
   it in a scratch copy and requires that check to go red. The `find` must occur
   exactly once in the file.

A failing check must print `FAIL <label>` ending the line, or `FAIL <label>: <why>`. Nothing else matches. The strict separator prevents a shorter check label from falsely matching a longer prefix label.

### Mechanics that bite

- **Resolve the repo from `process.cwd()`.** A gate that hard-codes a path runs
  against the wrong tree in a worktree.

- **Never assert the checkout is clean.** The gate runs mid-work by design.

- **Require no bespoke environment.** Every check must pass with no bespoke environment, because that is how `npm test` and CI run it.

- **Strip ANSI before parsing.** If the gate shells out to the suite, the
  harness may export `FORCE_COLOR`, which beats `NO_COLOR`, and `node --test`'s
  summary becomes unparseable, a green gate reads as red (#240). See
  `references/tooling.md`.

- **Safe restoration matters.** `git checkout --` after a manual mutation can
  wipe an escalated lane's work. Use a saved copy in a disposable tree instead.

- **The gate runs in a git-free tree.** `proveMutations` in `crew/checks.mjs`
  copies the tree for every mutation, and for its green preflight, without the
  top-level `.git`. A gate that shells out to `git` (`git grep`, `git ls-files`,
  `git diff`) exits with "not a git repository" there and cannot complete the
  proof, even when it works at baseline and after the build. Inspect the
  filesystem rooted at `process.cwd()` instead.

- **An absence check must distinguish "no match" from "the search broke."**
  Read each file with `readFileSync` and test it with `includes`. A path that
  is missing throws `ENOENT`, which is the search breaking: let it propagate
  rather than reading it as clean. A tool that signals "no match" through exit
  status (`grep`) makes the check error exactly when the criterion is
  satisfied, because `execFileSync` throws on a non-zero exit. `errored` and
  `failed` are different columns in `GATE-SUMMARY`: an errored check is not a
  failed check, and the loop requires failed checks and refuses a baseline with errors
  (#581, PR #577).

An absence check MUST be demonstrated red by ADDING the thing it forbids, not merely observed red at baseline.
"red at baseline" is not evidence for an absence check when it can be red by ERRORING instead of failing.

### The absence-check shape (copy this)

Copy this self-contained shape; it imports only node built-ins, needs no git
metadata, and runs in the scratch copy the loop proves mutations in:

```js
    import { readFileSync } from 'node:fs'
    import { join } from 'node:path'
    const REPO = process.cwd()
    // PATHS are repo-relative files. A missing file throws ENOENT: the search broke, not "clean".
    const hits = PATHS.filter((path) => readFileSync(join(REPO, path), 'utf8').includes(NEEDLE))
    if (hits.length) return `expected no reference to ${NEEDLE}, found in ${hits.join(', ')}`
```

To cover a directory, list it with `readdirSync(dir, { recursive: true })` and
keep the files you mean to read. Do not walk `node_modules` or `.git`.

Wrong, shells out to git, which the proof copy does not have:

    // WRONG: throws "not a git repository" inside proveMutations' scratch copy.
    execFileSync('git', ['grep', '-c', '-F', '-e', NEEDLE, '--', ...PATHS], { cwd: REPO })

Pair the absence check with a positive control: the same read for a needle
that MUST be present in a file that must exist, failing loudly if it is not.
An empty `PATHS`, or a path list that names the wrong files, is otherwise
byte-identical to a genuine absence.

### The proof loop

```
baseline  → gate runs, exits non-zero, GATE-SUMMARY errored: 0
mutate    → the behaviour the check names is neutralised
re-run    → the specific check reddens (not merely "the suite is red")
restore   → the tree is back
```

"The suite went red" is not a discrimination proof if you cannot say *which*
check reddened and that it was the one naming that mutation.

The planner authors the gate in every variant.


## Captures

# Vendor stream captures

**Rule: a test for a reducer over a vendor's event stream uses a recorded
capture. Never hand-build the frames.** A fixture encodes what you believe the
format is, but that belief is precisely what needs testing.

### Historical lesson

A retired usage reducer counted nested tool results as well as assistant usage;
hand-built frames omitted the role field that distinguished them. The suite
missed the over-count (#493, fixed in PR #496). No live exhibit. Existing
own-spend fixture tables are hand-built, not recorded vendor captures. The #493
fix asserted both reducers against one shared fixture table, excluding nested
frames while still folding assistant frames, so neither direction could invert.

### Recording a capture

1. Run a real seat through the path you want to pin. Lean session records are
   at `task/lean/<role>/<id>.jsonl`; `crew/show.mjs` discovers them.
2. Inspect the session to establish what it preserves. These are session records,
   not automatically raw vendor frames. If the desired frames are absent,
   capture them separately at the actual vendor transport boundary.
3. Trim to the frames the test needs without editing their shape: drop whole
   lines, never fields. Preserve provenance and commit the fixture beside the test.

### What the test asserts

Pin both the frames carrying the subject's own data and real examples of frames
that must be excluded. Both directions prevent an over-count fix from becoming an
under-count. Capture and prove each vendor adapter separately; do not assume
formats agree. Where reducers share a rule, assert agreement behaviourally over
one fixture table, not just in a comment.


## Absence

# Absent is not zero

A zero is a measurement; absence means no measurement was obtained. Never
fabricate zero for an unknown value. An unmeasured value is `null` with one
closed reason (CLAUDE.md, honesty doctrine). Where a contract has no reason
field yet, as the subagent usage below, say so; do not treat that as the rule.

### Live usage contract

In `crew/pi/extensions/subagent.ts`, `createStreamReducer` exposes complete
usage or null when unmeasured. Internal details may contain `usage: null`;
the public result omits the `usage` key when unmeasured. The pre-spawn budget
refusal writes a journal row with `usage: null` via `usageRow`. It is not a
measured zero. See `crew/pi/extensions/subagent.test.mjs`, especially `usage is
a complete pi Usage or absent, never partial` and `the journal records exactly
one row per spawn`.

### Complete-or-absent and pinning

Partial token or cost records can be mistaken for complete ones. Pin both an
unmeasured absence and a genuinely measured zero, so neither can be silently
converted into the other. When a reason exists, explain what was missing and
why; an emitter that never ran is an absence, not a failed write. Distinguish
retired counts from genuinely empty ones when reporting them; the old doctor
example is historical, with no live exhibit.


## Affordances

# Test affordances

**IF YOU CANNOT EXPRESS THE MALFORMED INPUT, YOU HAVE NOT TESTED THE GUARD.**

The 2026-08-23 defect hunt filed eight defects, and every one ended with the
same sentence: *no existing test can reach this line*. That was not
carelessness; it was a missing affordance for the input class. A test can only
prove a guard if its harness can produce the hostile or malformed value that
reaches the guard.

This batch names five affordances:

1. **Raw-socket client (`net.Socket`)**, produces a literal request line and
   an arbitrary `Host` header. `fetch` normalises the target and writes its own
   `Host`, so this serves the request-target and Host input class in defects
   #543/#544. It is built in `test/helpers.mjs` and exercised by
   `test/helpers.test.mjs`.
2. **second process writer harness**, produces two independent processes
   writing one file, including the interleaving and truncation-window input
   class. It serves the durability and concurrent-reader defects and is
   generalised from
   `docs/audits/2026-08-23/hunt/h1/repro/r6-crewjson-two-durability-contracts.mjs`.
   It is built in `test/helpers.mjs`.
3. **torn-file fixture**, produces bytes that exist but do not parse, then
   publishes the complete artefact and exercises recovery. It serves malformed
   file and parser-recovery defects. It is built in `test/helpers.mjs` and
   exercised by `test/helpers.test.mjs`.
4. **An argv input matrix**, would produce unsupported, missing,
   and combined flag input classes for flag-guard defects. It is not built
   here; no live exhibit.
5. **A fixture-symmetry lint**, would produce the input class where one side
   of a mirrored fixture is missing or asymmetric, serving fixture-drift
   defects. It is not built here; it lands as tests in place elsewhere in this
   batch.

The first three are input-producing helpers, while the last two are planned
checks. The shared rule is to make the input class expressible before claiming
that its guard is tested. `skills/qa-test-writing/references/vacuity.md`
covers the detector side ("the detector's key is the only guard"); this file is
the same lesson on the **input** side.


## Citations

# Citation discipline

### Cite a file by path and a code site by symbol

A line number rots on the next insertion above it, and nothing in the lean loop
re-checks a prose citation. Write ``crew/checks.mjs (CHECK_REASONS)`` or just
``crew/checks.mjs``; do not write ``crew/checks.mjs:9``. A symbol names what the
text relies on and survives an unrelated edit. The `prose-plain` skill states
the same rule for skill prose.

A comment that cites another file follows the same rule: name the symbol and
drop the line number.

### Every cited path must name a tracked file

A path written in the text (``crew/``, ``scripts/``, ``visualizer/``, ``skills/``,
``test/``, ``hooks/`` or ``bin/`` prefix, ending in a source or doc extension)
must exist on the lane tree. Check it before you return: a citation to a
deleted file teaches a rule that nothing enforces any more.

### A stale citation moves; the file does not

- If a citation goes stale the CITATION moves. Holding a file's line count
  constant is never a goal.
- When the cited code is gone, repoint the citation to a kept file that shows
  the same thing, or drop the claim.
- Do not keep a citation for a mechanism that no longer exists. Say what the
  lean gate or the kill-mutation proof (`crew/checks.mjs`) checks instead.


## Tripwires

# Tripwires and scope

A **tripwire** is a test that pins something inside a lane's write surface. Find
them before you edit, so you know what the change will break.

### The rule that costs the most when missed

**A change that alters a DETECTOR owns whatever that detector newly flags.**

A detector is anything that scans the tree and reports hits: a drift guard, a
lint-shaped check, a source grep, a schema validator. Widen it, and it starts
flagging files nobody asked you to touch. Those files belong in the plan's
`files_in_scope`, or the builder either leaves the suite red or edits outside
the permitted surface.

This is computable **before the build**: run the widened detector, identify what it
newly flags, and put those files in `files_in_scope`.

### Source-grep tripwires when code moves

When a change moves code between modules, include affected **source-grep** tests
in `files_in_scope`, alongside behavioural tests. A test that greps for a
symbol's location fails when the symbol relocates, even though behaviour is
unchanged.

### Directory entries

List files, not bare directories, in `files_in_scope` unless the whole directory
is meant. A directory entry that the builder reads as a single file leaves an
empty write surface.

### New files

A plan that creates files declares them in `files_in_scope` like any other. Name
the existing files the work relates to beside them, so the builder starts from
code that already exists.

### Protected paths

A change that touches the loop's own enforcement (`crew/loop.mjs`,
`crew/checks.mjs`, `crew/acp/grants.mjs`, `hooks/`) belongs at the judge tier.
Decide that when you plan, not after the build.


## Tooling

# Running and reading the suite

### The suite

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
no `node_modules`, and was wrong about the repo.

### ANSI will lie to you

The harness exports `FORCE_COLOR`, and **`FORCE_COLOR` beats `NO_COLOR`**. Under
it, `node --test`'s summary carries escape sequences and becomes unparseable: a
green run reads as red (#240).

- Prefix suite greps with `FORCE_COLOR=0`, **or** drop the `^` anchor.
- An empty grep result on a pipe is **suspect decoration** until proven
  otherwise, check before concluding the thing you grepped for is absent.
- A gate that shells out to the suite strips ANSI before parsing.

### Scratch trees

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
`git worktree remove`, you cannot simply `rm -rf` it and forget.

### Timeouts

`--test-timeout=30000` per test. A full-suite run takes about a minute; run it in the background or
run the targeted test file instead, so one foreground call stays under the
tool timeout.

### Reading a run's results

- A seat's envelope is the JSON file at its return path in the task dir
  (`builder-2.json`, `reviewer-1.json`). Read the envelope, not a roll-up.
- Each seat turn is recorded under `lean/<role>/<id>.jsonl` in the task dir, and
  the run's journal is `journal.jsonl` beside it.

### Re-derive a surprising measurement

If a number surprises you, get it a second way before acting on it. Measured
failures of this rule in one session: process counts from `pgrep`, a lazily
opened database read as empty, an invented field name, sibling-lane pollution,
and a compound `cd` that silently changed what a relative path meant.



## Live vocabulary

`CHECK_REASONS` in `crew/checks.mjs` and `crew/checks.test.mjs` is a live vocabulary with independent expectations.
