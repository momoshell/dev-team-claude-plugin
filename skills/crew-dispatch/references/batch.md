# Batch dispatch

Dispatch a batch in this order, and record what refuses at each boundary:

1. Create one worktree per lane.
2. Boot with **one shared fence register for the whole batch**. Boot writes the
   other lanes' files, so every write lane must be known before any seat boots.
3. Ask the compiler with `--discover-reads <lane>` for the reads a lane must acknowledge, write those records into the register, and perform a **single compile**. If that compile still refuses, the batch refuses `reads-unresolved` rather than retrying. A hand-authored register with spare acknowledgements remains guarded by **`stale-read-ack`**, while the coupled-source-unfenced refusal names the records discovery returns. A `where` path that does not exist refuses
   **`missing-path`** (`scripts/factory/make-brief.mjs:129`, `COUPLED_SOURCE_UNFENCED = 'coupled-source-unfenced'`; `scripts/factory/make-brief.mjs:130`, `STALE_READ_ACK = 'stale-read-ack'`). An unreadable adopted plan or gate refuses **`plan-adopt-unreadable`** before anything is copied. An adopted `gate.mjs` that resolves the repository through an absolute path — an import specifier, or a `REPO`/`ROOT`/`CHECKOUT` assignment — refuses **`plan-adopt-gate-absolute-path`** before copying or worktree creation, because `prove-mutations` runs a gate in a fresh temporary worktree and a pinned gate can kill no mutation. Its own checkout counts, not only a predecessor's. A quoted absolute literal that is merely DATA is admitted: refusing on any such literal measured 10/214 precision over the archived corpus, since bare `/` and the comment `// gate` both begin with a slash. A repo-root assignment under the system temp dir is exempt as a scratch fixture; an import from there is not.
4. Verify through **`validateScopeEntries`** and **`scopeMatcher`** for own-file
   coverage and zero sibling leaks.
5. Check the protected floor with **`protectedHitsIn`** over
   **`resolveProtectedPaths`** (`crew/protected-paths.mjs:24`, `export function resolveProtectedPaths(extra)`); the floor evidence is in
   `references/tier.md`.
6. Boot the lanes, then background `run`.
7. Check **arrival, not parsing**: `crew.json` carries `lane_name` for the own
   lane and `lane_fence` for siblings (`batch total minus one` batch siblings
   plus `one entry per external` fence); `checkArrival` counts only non-external
   members against `batchTotal - 1` and separately requires each external to be
   present. The journal carries the `lane-fence` event. **`fence=NONE`** in a write lane means
   a boot-only flag went to the wrong verb.

Parallelise on file-set disjointness, never on workspace count. The batch's
compiles run in parallel; only a baseline fallback is serialised behind the
host-load guard, and the baseline is cached by commit and command, so a
compile no longer implies a suite run. Never nest a waiter inside another
background call. Arm the watcher on the run log: `run`
emits exactly one terminal `{"status":…}` line, while a pid is only a proxy.
Merge the batch branches in a scratch worktree and run the suite before handing
them over. Size a scout brief to the **write-up**, not the reading: forbid
subagent fan-out explicitly on a read-everything sweep and ask for incremental
findings, because two scouts finished measuring and escalated with the envelope
unwritten.

**The sequence above prescribes no dry run.** `checkFences`, `crossBatchCollisions`
and `resolveAdoptions` all run before `createWorktrees`, so a bad register refuses
before a branch exists; `references/flags.md` records what `--dry-run` is for and
what a green one does not mean.

## Parked conditions go stale

**`parked`** names a trigger, and triggers can be met silently, so **`audit the trigger against the code`** before repeating it. **`#291`** had both halves met
and **`#379`** had two of three; a body stale about its trigger is stale about
its steps too. Verify every clause you are about to brief, not just the blocking
one.

## A fence carried in from another batch

A register entry marked `"external": true` names a live lane from ANOTHER batch: it denies every batch lane's write surface, it is not counted in the sibling total `checkArrival` derives, and a stale entry refuses `external-fence-stale` by name.

Fence isolation now spans concurrent batches. The dispatcher verifies that the named lane's crew dir persists that exact lane name and its run has not settled, and the deny set is never derived by scanning `~/.crew`. `sibling-leak` enforcement applies to externals like any other entry: the leak loop iterates every register entry, and only a `depends_on` edge exempts. While the deny SET is never derived by scanning `~/.crew`, external LIVENESS is read from `~/.crew` by `externalFenceLiveness`. It also consults the journal freshness signal: an external lane with no terminal stage whose journal has been silent for `DRIVER_GONE_PERIODS × HEARTBEAT_PERIOD_MS` refuses `external-fence-abandoned`, distinct from `external-fence-stale`; the refusal constants are `EXTERNAL_FENCE_STALE = 'external-fence-stale'` at `scripts/factory/dispatch-batch.mjs:49` and `EXTERNAL_FENCE_ABANDONED = 'external-fence-abandoned'` at `scripts/factory/dispatch-batch.mjs:50`.

`run-settled`, `run-complete`, and `run-escalated` are three distinct terminal reasons. The declared file list is compared with the external lane's own `crew.json` sibling claims and a contradiction is reported, not silently cleared. That comparison cannot measure an under-declared external because a lane's own fence is not recorded in its own `crew.json`; an unmeasured heartbeat (`heartbeat_age_ms: null`) is never read as abandoned.

## The executable form

`scripts/factory/dispatch-batch.mjs` is this sequence as code: one entry point
over a batch directory of request JSONs and a fence register, refusing the
batch at the first failed check rather than proceeding
(`scripts/factory/dispatch-batch.mjs:35`, `FENCE_NOT_ARRIVED = 'fence-not-arrived'`).
Every refusal above has a name in its exported `REFUSAL_REASONS`; the prose here
says WHY each check exists, which the script cannot.

`anchor-pin-unfenced` reports; it **does not refuse**. The scan names every
`anchors.json` pin on a lane's write surface whose manifest is outside its fence —
the sweep that cost `b217-treefingerprint` a lane when it was done by hand — and
emits it as a warning in dispatch output and in `--dry-run`, where the fence is
chosen. It stopped refusing because **#635** made a shifted anchor repairable:
content found once at a new line is relocated and reported, so a pin outside the
fence is no longer a scope the lane cannot satisfy, and refusing on it falsely
blocked three of five lanes in one batch. What is still fatal is **rot** (content
nowhere) and **ambiguity** (content more than once), caught by each skill's own
`exhibits.test.mjs` when they actually happen rather than predicted before the
lane runs.

A manifest pinning only files the lane does not write is not an obligation on that lane; when the lane writes a pinned file, the lane owes the repair and must fence the pinning manifest before dispatch. The sanctioned fix is the post-merge pass the
operator runs on `main` after the wave merges:
`node skills/qa-test-writing/anchor-pin.mjs --repair-all <dir>`. The same pass
rewrites the citing doc, so citation carriers no longer have to be fenced either.
A lane that DOES change a manifest still has to leave it consistent, and rot and
ambiguity stay fatal in the skill's own `exhibits.test.mjs`.

`citation-carrier-unfenced` names every pinned carrier; only an **unpinned** path:line citation — one with no manifest keys — is hand-only.

### Warning doctrine

The **anchor-pin** warning carries this exact blind spot: BLIND SPOT: an unpinned file:line citation is in no manifest key, so neither this check nor the citation-carrier check can find it; a citation the anchor corpus does not pin is still discoverable only by hand

The **citation-carrier** warning carries this exact blind spot: BLIND SPOT: this finds docs carrying a PINNED path:line citation and nothing else. A citation no manifest pins is in no key, and a doc whose exhibit set-compares a documented table against source (skills/crew-recovery/references/escalations.md and the escalate() producers) reddens with every citation in it still correct. Neither is discoverable here; read the exhibits suites of the manifests named above before choosing this fence

The **test-reach** warning carries this exact blind spot: BLIND SPOT: this is a proxy in BOTH directions and names candidates, never proof. A test can assert the changed behaviour through a higher-level entry point without importing the changed file at all, and a computed path or dynamic import is invisible to a static scan — crew/crew.mjs loads every adapter that way. A test can equally import a fenced file without asserting anything about the part being changed. The literal symbol scan sees only whole-word occurrences of an exported name, is blind to a renamed re-export, and drops any symbol naming more than 8 test files as too broad to be evidence. Read the named files before choosing this fence; an unnamed one is not cleared. An apostrophe or quote inside a // or /* */ comment opens a phantom literal and hides every real path literal after it in that file.

The **census-carrier** warning carries this exact blind spot: BLIND SPOT: this warning fires on the POSSIBILITY that a fenced *.test.mjs edit moves either repository-wide census, not on the fact; dispatch cannot inspect bytes the builder has not written and cannot predict whether either census will move.

This is a possibility-only trigger: it fires because a fenced `*.test.mjs` edit might move either repository-wide census, not because dispatch has observed a move. Its two carriers are `skills/crew-dispatch/references/batch.md` and `skills/crew-dispatch/exhibits.test.mjs`. This warning-only path follows ADR-040: the lane will OWE the repair, but cannot reach it from outside its fence; the owed, inaccessible repair updates batch.md's measurement sentence, exhibits.test.mjs's `const measurement`, and its `const pristinePairs` after the test edit.

There are two false negatives this warning does not measure. A directory-prefix fence entry such as `test/` or `crew/` is supported, including a lane whose `creates` path is a new tracked test, but the trigger reads only whole-file `*.test.mjs` fence entries. Such a lane emits no census warning even though its directory fence is the broadest test-editing surface in the batch. Conversely, a span-scoped carrier such as `skills/crew-dispatch/exhibits.test.mjs#L1-L50` is scored as reached because `parseFenceScope` strips the span before `matchOwn` checks the carrier, while the owed `const measurement` and `const pristinePairs` repairs in `exhibits.test.mjs` are outside that span and the scope gate will refuse them.

Silence from this check is therefore an UNMEASURED clear, not a measured one: the carrier side, `matchOwn`, honours directory prefixes, while the trigger side does not.

On the shipped 2026-09-09 tree, a fresh `git ls-files` measurement with `collectTestReach` found exact static path reach for **160 of 545 tracked non-test files**, comprising **450 distinct (file, test) pairs contributed by 87 of 89 tracked `*.test.mjs` files**. The pristine `HEAD` baseline gives 160 owners and 450 pairs. The rule resolves decoded slash-bearing literals beginning `./` or `../` against the test file, repository-relative literals against checkout root, and only `join(ROOT, <all-literal segments...>)` or `join(repoRoot, <all-literal segments...>)`; absolute candidates and variable-built joins do not match tracked repository paths. This is the shipped scanner's reach, not proof of test intent; computed paths and computed dynamic imports remain invisible. This figure is pinned by `skills/crew-dispatch/exhibits.test.mjs` and must be re-measured whenever a tracked test file gains or loses a static path literal. The superseded review-time witness literal, **164 of 542 tracked non-test files**, comprising **428 distinct (file, test) pairs contributed by 83 of 85 tracked `*.test.mjs` files**, remains only so the byte-identical pre-repair exhibit can execute while the named dynamic guard proves the replacement; it is not a current census.

The hard breadth is deliberate (#702): a single static quoted path literal anywhere in a test — including one that appears only as fixture data — is a hard `test-reach-unfenced` refusal of the batch, and clearing it costs an `allow_test_reach` `{ file, why }` override. This trades false refusals for missed fences on purpose (#702). Fencing `crew/model-ladder.json` now names `crew/drive-review.test.mjs` and `test/factory-dispatch-batch.test.mjs`; fencing either `crew/tree-fingerprint.mjs` or `skills/devops/references/worktrees.md` now names `test/factory-dispatch-batch-fences.test.mjs`, whose b220 fixture list carries both surface literals; do not fence `test/factory-dispatch-batch.test.mjs` for either carrier. Each of those surfaces previously refused nothing.

A reach row is identified by the outside test, the fenced file it reaches, and the reach kind (`import`, `symbol`, or `path`). Path facts are never coalesced with import or symbol facts, so a static path literal remains an independent hard-refusal candidate even when another fact for that test and surface file was found first. Same-key aggregation still retains one deterministic symbol list on the surviving import or symbol row; `dispatch.warnings.json` persists every provisional fact folded by that aggregation in `test_reach_dropped`, and `WARNING-SUMMARY` independently names the surviving row, actionable, and collapsed counts. Because path facts are no longer coalesced with import or symbol facts, a test whose own relative import specifier names a fenced file now yields a `path` row and is a hard `test-reach-unfenced` refusal; before this change, an import or symbol row for that test suppressed it. Compile `allow_test_reach` from the CURRENT `dispatch-batch` run's refusal list, not from prior experience of the surface. The reviewer's table, measured over those six fence surfaces on this tree, found `crew/crew.mjs` 6 -> 15 refused tests, `crew/drive.mjs` 15 -> 17, and `scripts/factory/dispatch-batch.mjs` 3 -> 8; `crew/adapters/adapter-pi.mjs` (8 -> 8), `crew/host-load.mjs` (1 -> 1), and `crew/roster.json` (5 -> 5) were unchanged. The historical pre-split record, `scripts/factory/dispatch-batch.mjs` 3 -> 4, remains only because a byte-identical retained block asserts it; its result is superseded by the post-split row.

The comment-desynchronisation exposure is a measured lower bound, not a second scanner reach: **55 of 89 tracked `*.test.mjs` files** carry at least one apostrophe inside a comment, and **32 of 89** carry an odd number on the shipped tree (**32 of 89 at pristine `HEAD`**). This figure is pinned by `test/factory-dispatch-batch.test.mjs` and must be re-measured whenever a tracked test file gains or loses an apostrophe inside a comment. The pre-split historical assertion is superseded; it remains only because a byte-identical pinned block asserts it: 51 of 85 tracked `*.test.mjs` files carry at least one apostrophe inside a comment, and 30 of those carry an odd number on the shipped tree (30 at pristine `HEAD`). A comment-stripped read of the same tree finds at least 54 real `(file, test)` pairs the shipped scanner misses (446 vs 403). The comparison is conservative because it does not strip a trailing comment on a line that also contains a string; 446 is a comment-stripped comparison figure, not the scanner's reported reach.

The **cross-batch-unknown** warning carries this exact blind spot: BLIND SPOT: a lane booted without --fences declares no surface at all and can be editing anything; a lane whose batch siblings have been reaped records no claim; and a repository whose git dir cannot be measured is not compared. None of those are cleared — they are reported unknown.

Dispatch warning logs cite this subsection with `dispatch-batch: WARNING-SUMMARY`; each bounded line carries `report=<path-or-unavailable> doctrine=skills/crew-dispatch/references/batch.md`. `dispatch.warnings.json` carries complete warning rows and these exact blind spots, including the report's `blind_spots` map.

For PR carry-through, the doctrine is in `batch.md`, not the out-of-fence `fences.md` named by ask item 4. Final Acceptance supersedes the issue-body dry-run preservation clause, so dry-run warning output intentionally changes to the bounded form.

`plan-scope-outside-fence` refuses a planner's declaration wider than its own fence. A
fence denies siblings' declared surfaces, not unclaimed paths, so silently narrowing
`files_in_scope` would make the fence meaningless.

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
write surface: it must sit inside the lane's own fence (**`where-outside-fence`**)
and outside every sibling's (**`sibling-leak`**).

## A dispatched batch lets the caller choose its transport

The transport is the caller's choice. **headless is the software-factory mode and the DEFAULT**,
so an unflagged batch is unchanged and behaves exactly as before. The two
transport names and the refusal are pinned in the dispatcher:
`BOOT_TRANSPORT = 'headless-all'`, `PANE_TRANSPORT = 'panes'`, and
`TRANSPORT_CONFLICT = 'transport-conflict'`
(`scripts/factory/dispatch-batch.mjs:169`,
`scripts/factory/dispatch-batch.mjs:170`,
`scripts/factory/dispatch-batch.mjs:22`).

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

**A scout's fence entry participates in sibling-leak, unchanged.** A `writes: 'none'`
lane writes nothing, so its entry is really its READ surface — but the register is one
list of file claims and the dispatcher cannot tell the two apart at fence-check time:
`writes` lives in the variant, and the entry is what every sibling is measured against.
Exempting read-only lanes would let a scout be granted files a build lane owns, and the
first thing that notices would be the build lane's scope gate. So fence a scout NARROWLY —
name only what it must read exclusively — or declare a `depends_on` edge, which is the
one exemption that exists.

## A declared edge serialises only the waves it names

A **wave** is a topological level of the declared graph. The operator authors
an edge in the request; it is never inferred, because an inferred ordering is
one nobody can audit. Unknown names and cycles refuse by name: **dependency-unknown**
and **dependency-cycle** are the reasons pinned by `scripts/factory/dispatch-batch.mjs:39`
and `scripts/factory/dispatch-batch.mjs:38`.

A wave runs only after every predecessor reached `done`, **never on an `escalation`**.
A dependent lane briefed against work that did not land is
worse than a lane that never started, so the wave stops and reports its lanes
unstarted with the predecessor named (`predecessor-escalated`).

Disjointness is **disjoint within a wave**, inherited across an edge: writing
what your predecessor wrote is the point, while two lanes in one wave are
never related, so one predicate gives both halves. An unrelated lane gains
nothing from someone else's edge.

A dependent lane compiles in a worktree cut AFTER its predecessor landed, so
its ground truth, baseline, and tripwires are the moved tree's. Containment is
probed; a base that does not carry the predecessor's commit refuses
**dependent-base-stale** (`scripts/factory/dispatch-batch.mjs:40`) rather than
compiling against a stale tree.

Each wave is one invocation (`--wave`), because `run` is backgrounded and this
file already forbids nesting a waiter inside another background call. Wave
one reports later waves as deferred with the resume command, and a later
invocation enforces the predecessor outcome before it creates any worktree.
