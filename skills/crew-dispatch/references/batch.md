# Batch dispatch

Dispatch a batch in this order, and record what refuses at each boundary:

1. Create one worktree per lane.
2. Boot with **one shared fence register for the whole batch**. Boot writes the
   other lanes' files, so every write lane must be known before any seat boots.
3. Run the two-pass compile. Generate the `reads` list from the compiler's own
   refusal text: **`coupled-source-unfenced`** and the reverse spare-ack refusal
   **`stale-read-ack`**. A `where` path that does not exist refuses
   **`missing-path`** (`scripts/factory/make-brief.mjs:112`, `COUPLED_SOURCE_UNFENCED = 'coupled-source-unfenced'`; `scripts/factory/make-brief.mjs:113`, `STALE_READ_ACK = 'stale-read-ack'`).
4. Verify through **`validateScopeEntries`** and **`scopeMatcher`** for own-file
   coverage and zero sibling leaks.
5. Check the protected floor with **`protectedHitsIn`** over
   **`resolveProtectedPaths`** (`crew/protected-paths.mjs:24`, `export function resolveProtectedPaths(extra)`); the floor evidence is in
   `references/tier.md`.
6. Boot the lanes, then background `run`.
7. Check **arrival, not parsing**: `crew.json` carries `lane_name` for the own
   lane and `lane_fence` for siblings (a count of batch total minus own); the
   journal carries the `lane-fence` event. **`fence=NONE`** in a write lane means
   a boot-only flag went to the wrong verb.

Parallelise on file-set disjointness, never on workspace count. The compiler
runs the full suite on every compile, so sequence compiles and never nest a
waiter inside another background call. Arm the watcher on the run log: `run`
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

## The executable form

`scripts/factory/dispatch-batch.mjs` is this sequence as code: one entry point
over a batch directory of request JSONs and a fence register, refusing the
batch at the first failed check rather than proceeding
(`scripts/factory/dispatch-batch.mjs:30`, `FENCE_NOT_ARRIVED = 'fence-not-arrived'`).
Every refusal above has a name in its exported `REFUSAL_REASONS`; the prose here
says WHY each check exists, which the script cannot.

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
(`scripts/factory/dispatch-batch.mjs:73`,
`scripts/factory/dispatch-batch.mjs:74`,
`scripts/factory/dispatch-batch.mjs:18`).

`--headless-all` explicitly selects the factory transport. `--panes` selects
pane mode by the ABSENCE of `--headless-all`, because `crew.mjs boot` knows no
`--panes` flag. Both flags together refuse `transport-conflict` rather than
picking silently. The pane mode exists for the interval in which a running
lane has no other surface.

A pane lane is verified by the `workspace_id` boot RETURNED, not by argv. The
closing line names each returned workspace, so an operator can go to it;
headless output instead says `workspace_id is null` and directs the operator
to the crew dir, journal and run log.
