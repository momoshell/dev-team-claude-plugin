# Batch dispatch

Dispatch a batch in this order, and record what refuses at each boundary:

1. Create one worktree per lane.
2. Boot with **one shared fence register for the whole batch**. Boot writes the
   other lanes' files, so every write lane must be known before any seat boots.
3. Ask the compiler with `--discover-reads <lane>` for the reads a lane must acknowledge, write those records into the register, and perform a **single compile**. If that compile still refuses, the batch refuses `reads-unresolved` rather than retrying. A hand-authored register with spare acknowledgements remains guarded by **`stale-read-ack`**, while the coupled-source-unfenced refusal names the records discovery returns. A `where` path that does not exist refuses
   **`missing-path`** (`scripts/factory/make-brief.mjs:112`, `COUPLED_SOURCE_UNFENCED = 'coupled-source-unfenced'`; `scripts/factory/make-brief.mjs:113`, `STALE_READ_ACK = 'stale-read-ack'`). An unreadable adopted plan or gate refuses **`plan-adopt-unreadable`** before anything is copied.
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

## Parked conditions go stale

**`parked`** names a trigger, and triggers can be met silently, so **`audit the trigger against the code`** before repeating it. **`#291`** had both halves met
and **`#379`** had two of three; a body stale about its trigger is stale about
its steps too. Verify every clause you are about to brief, not just the blocking
one.

## A fence carried in from another batch

A register entry marked `"external": true` names a live lane from ANOTHER batch: it denies every batch lane's write surface, it is not counted in the sibling total `checkArrival` derives, and a stale entry refuses `external-fence-stale` by name.

Fence isolation now spans concurrent batches. The dispatcher verifies that the named lane's crew dir persists that exact lane name and its run has not settled, and the deny set is never derived by scanning `~/.crew`. `sibling-leak` enforcement applies to externals like any other entry: the leak loop iterates every register entry, and only a `depends_on` edge exempts. While the deny SET is never derived by scanning `~/.crew`, external LIVENESS is read from `~/.crew` by `externalFenceLiveness`. It also consults the journal freshness signal: an external lane with no terminal stage whose journal has been silent for `DRIVER_GONE_PERIODS × HEARTBEAT_PERIOD_MS` refuses `external-fence-abandoned`, distinct from `external-fence-stale`; the refusal constants are `EXTERNAL_FENCE_STALE = 'external-fence-stale'` at `scripts/factory/dispatch-batch.mjs:47` and `EXTERNAL_FENCE_ABANDONED = 'external-fence-abandoned'` at `scripts/factory/dispatch-batch.mjs:48`.

`run-settled`, `run-complete`, and `run-escalated` are three distinct terminal reasons. The declared file list is compared with the external lane's own `crew.json` sibling claims and a contradiction is reported, not silently cleared. That comparison cannot measure an under-declared external because a lane's own fence is not recorded in its own `crew.json`; an unmeasured heartbeat (`heartbeat_age_ms: null`) is never read as abandoned.

## The executable form

`scripts/factory/dispatch-batch.mjs` is this sequence as code: one entry point
over a batch directory of request JSONs and a fence register, refusing the
batch at the first failed check rather than proceeding
(`scripts/factory/dispatch-batch.mjs:33`, `FENCE_NOT_ARRIVED = 'fence-not-arrived'`).
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

Under **ADR-040**, a shifted pin whose manifest is outside the lane's fence is a
WARNING and the lane owes nothing. The sanctioned fix is the post-merge pass the
operator runs on `main` after the wave merges:
`node skills/qa-test-writing/anchor-pin.mjs --repair-all <dir>`. The same pass
rewrites the citing doc, so citation carriers no longer have to be fenced either.
A lane that DOES change a manifest still has to leave it consistent, and rot and
ambiguity stay fatal in the skill's own `exhibits.test.mjs`.

`citation-carrier-unfenced` names every pinned carrier; only an **unpinned** path:line citation — one with no manifest keys — is hand-only.

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
(`scripts/factory/make-brief.mjs:119`, `CREATES_EXISTS = 'creates-exists'`).
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
(`scripts/factory/dispatch-batch.mjs:147`,
`scripts/factory/dispatch-batch.mjs:148`,
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
and **dependency-cycle** are the reasons pinned by `scripts/factory/dispatch-batch.mjs:37`
and `scripts/factory/dispatch-batch.mjs:36`.

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
**dependent-base-stale** (`scripts/factory/dispatch-batch.mjs:38`) rather than
compiling against a stale tree.

Each wave is one invocation (`--wave`), because `run` is backgrounded and this
file already forbids nesting a waiter inside another background call. Wave
one reports later waves as deferred with the resume command, and a later
invocation enforces the predecessor outcome before it creates any worktree.
