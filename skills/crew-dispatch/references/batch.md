# Batch dispatch

Dispatch a batch in this order, and record what refuses at each boundary:

A fence is each lane's own write surface for its scope gate and brief; it is never a lock.

1. Create one worktree per lane.
2. Compile with **one authored fence register for the whole batch**. Each entry
   defines only that lane's own write surface for scope checks and brief generation;
   worktrees isolate concurrent writes, so overlapping surfaces are allowed.
3. Keep the complete effective register available through compilation and brief
   generation; a lane-specific runtime register is written only after compilation.
4. Ask the compiler with `--discover-reads <lane>` for the reads a lane must acknowledge, write those records into the register, and perform a **single compile**. If that compile still refuses, the batch refuses `reads-unresolved` rather than retrying. A hand-authored register with spare acknowledgements remains guarded by **`stale-read-ack`**, while the coupled-source-unfenced refusal names the records discovery returns. A `where` path that does not exist refuses
   **`missing-path`** (`scripts/factory/make-brief.mjs:129`, `COUPLED_SOURCE_UNFENCED = 'coupled-source-unfenced'`; `scripts/factory/make-brief.mjs:130`, `STALE_READ_ACK = 'stale-read-ack'`). An unreadable adopted plan or gate refuses **`plan-adopt-unreadable`** before anything is copied. An adopted `gate.mjs` that resolves the repository through an absolute path — an import specifier, or a `REPO`/`ROOT`/`CHECKOUT` assignment — refuses **`plan-adopt-gate-absolute-path`** before copying or worktree creation, because `prove-mutations` runs a gate in a fresh temporary worktree and a pinned gate can kill no mutation. Its own checkout counts, not only a predecessor's. A quoted absolute literal that is merely DATA is admitted: refusing on any such literal measured 10/214 precision over the archived corpus, since bare `/` and the comment `// gate` both begin with a slash. A repo-root assignment under the system temp dir is exempt as a scratch fixture; an import from there is not.
5. Verify through **`validateScopeEntries`** and **`scopeMatcher`** for each
   lane's own-file coverage. Overlap is not a refusal: rebase reconciles shared
   edits after isolated worktrees are merged.
6. Check the protected floor with **`protectedHitsIn`** over
   **`resolveProtectedPaths`** (`crew/protected-paths.mjs:24`, `export function resolveProtectedPaths(extra)`); the floor evidence is in
   `references/tier.md`.
7. After compilation, boot each lane with a generated register containing only
   that lane's effective entry. Runtime `lane_fence` is always empty, and the
   unchanged `lane-fence` journal event reports `lanes: 0, files: 0`; then
   background `run`.
8. Check **arrival, not parsing**: `crew.json` carries the own `lane_name` and
   an empty `lane_fence`; `checkArrival` refuses any runtime entries. The journal
   carries the unchanged `lane-fence` event with `lanes: 0, files: 0`.
   **`fence=NONE`** in a write lane means a boot-only flag went to the wrong verb.

Parallelise through isolated worktrees, not by requiring file-set disjointness.
The batch's compiles run in parallel; only a baseline fallback is serialised behind
the host-load guard, and the baseline is cached by commit and command, so a
compile no longer implies a suite run. Never nest a waiter inside another
background call. Arm the watcher on the run log: `run`
emits exactly one terminal `{"status":…}` line, while a pid is only a proxy.
Merge the batch branches in a scratch worktree and run the suite before handing
them over. Size a scout brief to the **write-up**, not the reading: forbid
subagent fan-out explicitly on a read-everything sweep and ask for incremental
findings, because two scouts finished measuring and escalated with the envelope
unwritten.

**The sequence above prescribes no dry run.** `checkFences` and `resolveAdoptions`
run before `createWorktrees`, so a bad register refuses before a branch exists;
`references/flags.md` records what `--dry-run` is for and what a green one does
not mean.

## Parked conditions go stale

**`parked`** names a trigger, and triggers can be met silently, so **`audit the trigger against the code`** before repeating it. **`#291`** had both halves met
and **`#379`** had two of three; a body stale about its trigger is stale about
its steps too. Verify every clause you are about to brief, not just the blocking
one.

## Runtime state and historical vocabulary

A lane's worktree is its concurrent-write isolation boundary. Compiles use the
complete authored register and preserve each lane's own effective surface; boot
writes a lane-specific register so runtime state cannot advertise another lane's
scope. `crew.json` therefore records the lane name and `lane_fence: []`, and the
unchanged journal event reports `lanes: 0, files: 0`.

Retired by ADR-043: `external`, `externalFenceLiveness`, `crossBatchCollisions`, `cross-batch-unknown`, `sibling-leak`, `external-fence-stale`, and `external-fence-abandoned` remain decodable only as historical journal vocabulary; an authored register entry carrying the marker refuses `external-fence-retired`.

## The executable form

`scripts/factory/dispatch-batch.mjs` is this sequence as code: one entry point
over a batch directory of request JSONs and a fence register, refusing the
batch at the first failed check rather than proceeding
(`scripts/factory/dispatch-batch.mjs:33`, `FENCE_NOT_ARRIVED = 'fence-not-arrived'`).
Every refusal above has a name in its exported `REFUSAL_REASONS`; the prose here
says WHY each check exists, which the script cannot.

`anchor-pin-unfenced` is evidence, not an automatic refusal. The scan names every
`anchors.json` pin on a lane's write surface whose manifest is outside its authored
fence — the sweep that cost `b217-treefingerprint` a lane when it was done by hand —
and the dispatcher automatically admits each unheld manifest with source
`anchor-pin`. An authored holder can keep a duplicate automatic admission out of
the later lane's effective surface, while concurrent write overlap itself remains
allowed. It stopped refusing because **#635** made a shifted anchor repairable:
content found once at a new line is relocated and reported. What is still fatal is
**rot** (content nowhere) and **ambiguity** (content more than once), caught by each
skill's own `exhibits.test.mjs` when they actually happen rather than predicted
before the lane runs.

A manifest pinning only files the lane does not write is not an obligation on that lane; when the lane writes a pinned file, dispatch admits the unheld pinning manifest automatically. The sanctioned fix remains the post-merge pass the
operator runs on `main` after the wave merges:
`node skills/qa-test-writing/anchor-pin.mjs --repair-all <dir>`. The same pass
rewrites the citing doc, so citation carriers no longer have to be fenced either.
A lane that DOES change a manifest still has to leave it consistent, and rot and
ambiguity stay fatal in the skill's own `exhibits.test.mjs`.

`citation-carrier-unfenced` names every pinned carrier; only an **unpinned** path:line citation — one with no manifest keys — is hand-only. Carrier warnings remain evidence and do not widen a fence by themselves.

### Sourced fence admission

The authored register is the scan floor. Every concrete unheld candidate from the
three scans is admitted to its owning lane's effective fence exactly once, with one
source: `test-reach`, `anchor-pin`, or `census-carrier`. The admission is written to
`perLane[name].files`, the effective `dispatch.fences.json` when widening occurred,
`dispatch.warnings.json`, bounded normal and dry-run output, and the lane journal
after boot. Admitted paths widen the effective fence, scope gate, and brief, but never
the assurance floor, so admission cannot change the tier the operator asked for. No
caller may widen a fence with a bare path; `fence-admission-unsourced`
refuses a missing or unknown source. An admission records evidence only: it proves
neither scan completeness nor test intent.

Automatic duplicate admission is first-lane-wins in existing batch order. A later
unrelated lane scanning the same candidate receives a `fence-admission-arbitrated`
warning naming the first lane and file, does not widen its own effective fence, and
continues through dispatch. Related dependency lanes can each retain their own
automatic admission. A candidate held by an unrelated same-batch authored register
entry is not admitted: held anchor and census candidates stay outside the effective
fence with their existing warnings, and held test reach retains
`test-reach-unfenced`. An explicit `allow_test_reach` entry always keeps its named
test outside the effective fence; a held test records its authored-holder context,
while an unheld test warns that the operator exclusion overrode automatic admission
with `override=explicit-exclusion` and records the file and reason.


### Warning doctrine

The **anchor-pin** warning carries this exact blind spot: BLIND SPOT: an unpinned file:line citation is in no manifest key, so neither this check nor the citation-carrier check can find it; a citation the anchor corpus does not pin is still discoverable only by hand

The **citation-carrier** warning carries this exact blind spot: BLIND SPOT: this finds docs carrying a PINNED path:line citation and nothing else. A citation no manifest pins is in no key, and a doc whose exhibit set-compares a documented table against source (skills/crew-recovery/references/escalations.md and the escalate() producers) reddens with every citation in it still correct. Neither is discoverable here; read the exhibits suites of the manifests named above before choosing this fence

The **test-reach** warning carries this exact blind spot: BLIND SPOT: this is a proxy in BOTH directions and names candidates, never proof. A test can assert the changed behaviour through a higher-level entry point without importing the changed file at all, and a computed path or dynamic import is invisible to a static scan — crew/crew.mjs loads every adapter that way. A test can equally import a fenced file without asserting anything about the part being changed. The literal symbol scan sees only whole-word occurrences of an exported name, is blind to a renamed re-export, and drops any symbol naming more than 8 test files as too broad to be evidence. Read the named files before choosing this fence; an unnamed one is not cleared. An apostrophe or quote inside a // or /* */ comment opens a phantom literal and hides every real path literal after it in that file.

The **census-carrier** warning carries this exact blind spot: BLIND SPOT: this warning fires on the POSSIBILITY that a fenced *.test.mjs edit moves either repository-wide census, not on the fact; dispatch cannot inspect bytes the builder has not written and cannot predict whether either census will move.

This is a possibility-only trigger: it fires because a fenced `*.test.mjs` edit might move either repository-wide census, not because dispatch has observed a move. Its two carriers are `skills/crew-dispatch/references/batch.md` and `skills/crew-dispatch/exhibits.test.mjs`. Each concrete missing carrier is admitted with source `census-carrier` when unheld; a measured holder leaves it outside the effective fence and the possibility-only warning remains warning-only. This follows ADR-040: the warning and this exact blind spot remain visible because admission proves neither a census move nor test intent; the owed repair still updates batch.md's measurement sentence, exhibits.test.mjs's `const measurement`, and its `const pristinePairs` after the test edit.

There are two false negatives this warning does not measure. A directory-prefix fence entry such as `test/` or `crew/` is supported, including a lane whose `creates` path is a new tracked test, but the trigger reads only whole-file `*.test.mjs` fence entries. Such a lane emits no census warning even though its directory fence is the broadest test-editing surface in the batch. The second is a fence entry carrying a span: `skills/crew-dispatch/exhibits.test.mjs:START-END` is scored as held because `parseFenceScope` supplies the bare path to `matchOwn`, so that carrier is never reported missing and never admitted, while the owed `const measurement` and `const pristinePairs` repairs sit outside the authored span and the scope gate will refuse them.

Measured fact: test reach is scored against the whole carrier path, so a span fence does not buy parallelism when another lane holds a test that reaches that file. A fence such as `skills/crew-dispatch/exhibits.test.mjs:START-END` is parsed by `parseFenceScope`, which supplies the bare path to `matchOwn` for reach matching; the authored `path:START-END` spans remain in the refusal remedy. This is intentional option 3 behavior — selected whole-file reach, not a blind spot.

| Option | Result | Closed reason |
| --- | --- | --- |
| 1 | `null` | `static-path-has-no-line-information` |
| 2 | `null` | `not-measured-option-not-selected` |
| 3 | `test-reach-unfenced` | `selected-whole-file-reach` |

Silence from this check is therefore an UNMEASURED clear, not a measured one: the carrier side, `matchOwn`, honours directory prefixes, while the trigger side does not.

Re-measure with the shipped `collectTestReach` over the `git ls-files` partition.

A reader who wants the current census runs:

```sh
node --input-type=module -e "import{execFileSync}from'node:child_process';const{collectTestReach}=await import(process.cwd()+'/scripts/factory/dispatch-batch.mjs'),files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split(String.fromCharCode(0)).filter(Boolean),tests=new Set(files.filter(file=>file.endsWith('.test.mjs'))),nonTests=new Set(files.filter(file=>!tests.has(file))),reach=collectTestReach({checkout:process.cwd()}),rows=[...reach.pathByFile].filter(([file])=>nonTests.has(file)).flatMap(([file,reached])=>[...reached].filter(test=>tests.has(test)).map(test=>[file,test])),contributingTests=new Set(rows.map(([,test])=>test));console.log({tracked:files.length,nonTests:nonTests.size,tests:tests.size,owners:new Set(rows.map(([file])=>file)).size,pairs:rows.length,contributingTests:contributingTests.size})"
```

The partition separates tracked `*.test.mjs` files from tracked non-test files. The derivation reports path rows, owners, pairs and contributing tests for the current checkout. Run it again whenever current values are needed; this method publishes no rotating result or pristine baseline.

BLIND SPOT, stated rather than omitted: the census pre-filter is a LITERAL substring scan for `ls-files`/`ls-tree` in a tracked test's own source. A suite that enumerates the checkout through a HELPER, an imported constant, or a command assembled at run time contains neither token and is therefore invisible to the pre-filter AND to the register — so the unlisted-survivor tripwire never fires for it either. **Silence from this pre-filter is not a complete census of census suites**, and it reports only what the literal scan can see, not everything that exists. This is a different blind spot from the computed-path one below, which belongs to the separate `collectTestReach` scanner. The rule resolves decoded slash-bearing literals beginning `./` or `../` against the test file, repository-relative literals against checkout root, and only `join(ROOT, <all-literal segments...>)` or `join(repoRoot, <all-literal segments...>)`; absolute candidates and variable-built joins do not match tracked repository paths. This is the shipped scanner's reach, not proof of test intent; computed paths and computed dynamic imports remain invisible. Re-run the pre-filter when a tracked test changes its census-related source, but do not treat its silence as exhaustive.

The hard breadth is deliberate (#702): a single static quoted path literal anywhere in a test — including one that appears only as fixture data — is a `test-reach` admission candidate. An unheld candidate is admitted with source `test-reach`; only a measured holder keeps it outside the fence as `test-reach-unfenced`, and a valid `allow_test_reach` `{ file, why }` override applies only to that held row. This trades false refusals for missed fences on purpose (#702), while admission proves neither completeness nor test intent. Fencing `crew/model-ladder.json` now names `crew/drive-review.test.mjs` and `test/factory-dispatch-batch.test.mjs`; fencing either `crew/tree-fingerprint.mjs` or `skills/devops/references/worktrees.md` now names `test/factory-dispatch-batch-fences.test.mjs`, whose b220 fixture list carries both surface literals; do not fence `test/factory-dispatch-batch.test.mjs` for either carrier. Each of those surfaces previously refused nothing.

A reach row is identified by the outside test, the fenced file it reaches, and the reach kind (`import`, `symbol`, or `path`). Path facts are never coalesced with import or symbol facts, so a static path literal remains an independent admission candidate even when another fact for that test and surface file was found first. Same-key aggregation still retains one deterministic symbol list on the surviving import or symbol row; `dispatch.warnings.json` persists every provisional fact folded by that aggregation in `test_reach_dropped`, and `WARNING-SUMMARY` independently names the surviving row, actionable, and collapsed counts. Because path facts are no longer coalesced with import or symbol facts, a test whose own relative import specifier names a fenced file now yields a `path` row and an unheld `test-reach` admission; a holder instead retains `test-reach-unfenced`. Compile `allow_test_reach` only for a held test named by the CURRENT `dispatch-batch` run, not from prior experience of the surface. A reviewer's table can compare how many refused tests each fenced surface names, and those per-surface observations can change when path facts are split from import or symbol facts. Treat such comparisons as run-specific diagnostics rather than a durable baseline. A historical pre-split record is superseded by the post-split rows and remains only where a byte-identical retained block requires it.

The comment-desynchronisation exposure is a measured lower bound, not a second scanner reach. It scans tracked `*.test.mjs` files for apostrophes inside comments and records whether each file has any apostrophe and whether its total is odd, for both the shipped and pristine `HEAD` trees. An apostrophe inside a test comment can hide path literals from the scanner, so this exposure describes a risk rather than a reach result. Re-measure the scanner exposure when a tracked test file gains or loses an apostrophe inside a comment. A comment-stripped read can expose real `(file, test)` pairs the shipped scanner misses. The comparison is conservative because it does not strip a trailing comment on a line that also contains a string; any observed comparison belongs to the run that produced it, not to this doctrine.

Dispatch warning logs cite this subsection with `dispatch-batch: WARNING-SUMMARY`; each bounded line carries `report=<path-or-unavailable> doctrine=skills/crew-dispatch/references/batch.md`. `dispatch.warnings.json` carries complete warning rows and these exact blind spots, including the report's `blind_spots` map.

For PR carry-through, the doctrine is in `batch.md`, not the out-of-fence `fences.md` named by ask item 4. Final Acceptance supersedes the issue-body dry-run preservation clause, so dry-run warning output intentionally changes to the bounded form.

`plan-scope-outside-fence` refuses a planner's declaration wider than its own fence.
A fence bounds its own lane's declared surface, so silently narrowing
`files_in_scope` would make that fence meaningless.

## A lane can declare what it will create

A `where` path must exist, so a lane whose deliverable is a NEW file could not
be dispatched at all: the dispatcher creates the worktrees itself, so there is
no moment at which an operator can commit a stub first. A request therefore
carries an optional `creates` list, verified by the OPPOSITE condition — the
path must NOT exist and its parent directory must — which refuses
**`creates-exists`** and **`creates-parent-missing`**
(`scripts/factory/make-brief.mjs:136`, `CREATES_EXISTS = 'creates-exists'`).
`missing-path` is untouched: it still refuses every `where` path that is
absent, because that is the check which catches the commonest brief typo.
The compiler EXEMPTS and the dispatcher never seeds a stub — a seeded stub
would satisfy `missing-path` for whatever path was mistyped, making a typo
indistinguishable from an intent. A created path is still part of the lane's
write surface: it must sit inside that lane's own fence (**`where-outside-fence`**).

## A dispatched batch lets the caller choose its transport

The transport is the caller's choice. **headless is the software-factory mode and the DEFAULT**,
so an unflagged batch is unchanged and behaves exactly as before. The two
transport names and the refusal are pinned in the dispatcher:
`BOOT_TRANSPORT = 'headless-all'`, `PANE_TRANSPORT = 'panes'`, and
`TRANSPORT_CONFLICT = 'transport-conflict'`
(`scripts/factory/dispatch-batch.mjs:160`,
`scripts/factory/dispatch-batch.mjs:161`,
`scripts/factory/dispatch-batch.mjs:21`).

`--headless-all` explicitly selects the factory transport. `--panes` selects
pane mode by the ABSENCE of `--headless-all`, because `crew.mjs boot` knows no
`--panes` flag. Both flags together refuse `transport-conflict` rather than
picking silently. The pane mode exists for the interval in which a running
lane has no other surface.

A pane lane is verified by the `workspace_id` boot RETURNED, not by argv. The
closing line names each returned workspace, so an operator can go to it;
headless output instead says `workspace_id is null` and directs the operator
to the crew dir, journal and run log.

## A scout rides in a mixed-variant batch

`--variant` is the batch default and each `<lane>.request.json` may name its own
`variant`, so a `scout` no longer needs a batch directory of its own. The key is
dispatch-only: it is split off before the compiler's closed schema sees the request,
exactly as `tier` and `depends_on` are.

A `writes: 'none'` scout still declares the files it reads, while a build lane
declares the files it writes. Keep each entry to that lane's own scope and let the
worktrees isolate simultaneous edits; a shared path is resolved when branches are
rebased and merged. A `depends_on` edge controls wave order only and does not change
the own-surface meaning of either entry.

## A declared edge serialises only the waves it names

A **wave** is a topological level of the declared graph. The operator authors
an edge in the request; it is never inferred, because an inferred ordering is
one nobody can audit. Unknown names and cycles refuse by name: **dependency-unknown**
and **dependency-cycle** are the reasons pinned by `scripts/factory/dispatch-batch.mjs:37`
and `scripts/factory/dispatch-batch.mjs:36`.

A wave runs only after every predecessor reached `done`, **never on an `escalation`**.
A dependent lane briefed against work that did not land is
worse than a lane that never started, so the wave stops and reports its lanes
unstarted with the predecessor named (`predecessor-escalated`).

The register records each lane's own surface; overlap is **allowed** because
worktrees isolate concurrent writes (#881). A `depends_on` edge orders the lanes so a
dependent's base is fresh, but it does not turn the register into a lock. Rebase
and merge reconcile shared edits after the wave.

A dependent lane compiles in a worktree cut AFTER its predecessor landed, so
its ground truth, baseline, and tripwires are the moved tree's. Containment is
probed; a base that does not carry the predecessor's commit refuses
**dependent-base-stale** (`scripts/factory/dispatch-batch.mjs:38`) rather than
compiling against a stale tree.

Each wave is one invocation (`--wave`), because `run` is backgrounded and this
file already forbids nesting a waiter inside another background call. Wave
one reports later waves as deferred with the resume command, and a later
invocation enforces the predecessor outcome before it creates any worktree.
