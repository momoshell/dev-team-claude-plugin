# s1-runtime — horizontal inspection of `crew/`

Read-only recon. Zero files changed in the checkout.
Scope: the eleven files named by the brief, plus the shared leaves they could
have imported from (`slug.mjs`, `variants.mjs`, `limits.mjs`,
`protected-paths.mjs`, `escalation-policy.mjs`, `host-load.mjs`, `arms.mjs`,
`breaker.mjs`, `driver.mjs`) and the two adapters.

Every `file:line` below was printed back with `sed -n 'Np'` at authoring time.
Where a scout's claim did not survive that check it was corrected or dropped;
three such corrections are marked **[corrected]** in place.

---

## 0. READ THIS BEFORE ACTING ON ANY FINDING — the import firewall

`crew/daemon.mjs` is under a **mechanically enforced import allowlist**:
`crew/daemon.test.mjs:238-242` asserts that *every* import in `daemon.mjs`,
side-effect imports included, is a `node:` builtin or exactly one of
`./headless-rpc.mjs`, `./slug.mjs`, `./escalation-policy.mjs`, `./variants.mjs`.

Consequences that invalidate the obvious fix for several findings below:

- `daemon.mjs` **cannot** import from `crew.mjs`, `drive.mjs`, `seat-io.mjs`,
  `reclaim.mjs`, `capabilities.mjs`, `breaker.mjs` or `scripts/factory/*`.
- Any "just import it instead of re-declaring it" proposal touching
  `daemon.mjs` is wrong as stated. The available moves are: (a) a **new leaf
  module** added to the allowlist, or (b) keep the copy and add a **cross-module
  equality test** — tests are not behind the firewall.
- `crew/child.mjs` carries the same posture by intent
  (`crew/child.mjs:280-282`: *"never import resolveLaneFence from crew.mjs; the
  import firewall is deliberate"*).

The repo already contains the correct pattern for both moves, and findings are
graded against it:

- **Leaf module**: `crew/slug.mjs`, `crew/limits.mjs`, `crew/protected-paths.mjs`.
- **Equality test on a deliberate copy**: `crew/crew.test.mjs:1032` drives
  `resolveValidationLane` and its `child.mjs` twin through one shared table;
  `crew/daemon.test.mjs:508` asserts `PANE_TRANSPORT === DEFAULT_TRANSPORT`.
  These two are the standard. **Almost nothing else in the eleven has one.**

`crew/drive.mjs` is not firewalled by a test, but its import list is
deliberately thin (`converge`, `escalation-policy`, `variants`,
`protected-paths` — all leaves). Importing `headless.mjs` or `daemon.mjs` into
it would drag `node:child_process`, `reclaim.mjs` and the claude adapter into
the driver. Treat it as firewall-adjacent: leaf, not edge.

**Protected floor.** `crew/drive.mjs` and `crew/reclaim.mjs` are on
`PROTECTED_PATHS` (`crew/protected-paths.mjs:8`). Any task acting on findings
touching those two files is **judge-tier** at dispatch.

---

## 1. Coverage declaration

| file | lines | coverage |
|---|---|---|
| `crew/converge.mjs` | 140 | **read in full** (planner) |
| `crew/capabilities.mjs` | 314 | sampled + full export census |
| `crew/child.mjs` | 307 | sampled (9 anchor sites) + full export census |
| `crew/headless.mjs` | 338 | sampled (11 anchor sites) + full export + full helper census |
| `crew/factoryctl.mjs` | 376 | sampled (4 anchor sites) + full export census |
| `crew/headless-rpc.mjs` | 755 | sampled (12 anchor sites) + full export + full helper census |
| `crew/reclaim.mjs` | 1088 | sampled (7 anchor sites) + full export census |
| `crew/daemon.mjs` | 1438 | sampled (18 anchor sites) + full export census |
| `crew/seat-io.mjs` | 2156 | sampled (22 anchor sites) + full export census |
| `crew/crew.mjs` | 2206 | sampled (24 anchor sites) + full export census |
| `crew/drive.mjs` | 3250 | sampled (19 anchor sites) + full export census |

"Full export census" = every `export` enumerated and grepped across the whole
checkout (tests, `skills/`, `scripts/`, `visualizer/`, `docs/`, `.claude/`).
No file over 400 lines was read line-by-line end to end; claims about those
files rest on targeted reads at the cited anchors, and every cited anchor was
printed back. **Nothing here is inferred from a name.**

---

## 2. Ranked register

Ranked by behaviour risk first, then lines removed.
Categories: `duplicate` / `grammar-drift` / `dead-export` / `oversize` /
`re-derivation` / `stale-anchor`.

| # | category | risk | finding | files to touch |
|---|---|---|---|---|
| F1 | duplicate + grammar-drift | **high** | `crew.json` has three writers with three durability contracts | 3 |
| F2 | duplicate | **high** | `#522` trap: `NODE_FLOOR` duplicated under a test that pins a literal, not the pair | 1 test (+1 code) |
| F3 | duplicate | **high** | lane-fence rehydration copied into both run entrypoints and already drifted | 2 |
| F4 | re-derivation | **high** | `crew.roles` recorded at boot, re-derived three ways, one of them ignoring the record | 3 |
| F5 | grammar-drift | med-high | `crew.json` read five ways with three absence grammars | 5 |
| F6 | grammar-drift | med-high | the journal carries two row grammars; `normalizeEvent` must sniff | 4 |
| F7 | duplicate | med-high | six JSON-read-or-null helpers; only `reclaim`'s is tri-state | 6 |
| F8 | grammar-drift | medium | `envelopeAt` — same name, inverted argument order across two modules | 2 |
| F9 | grammar-drift | medium | absence in usage reducers: `addTotals` zeroes, `addUsage` preserves null | 2 |
| F10 | duplicate | medium | `logLine` creates the parent dir; the two hand-rolled copies do not | 3 |
| F11 | dead-export + duplicate | medium | `RESEAT_REASONS` — fully unreferenced *and* a divergent copy of `MODIFIER_OUTCOMES` | 1 |
| F12 | grammar-drift | medium | four discriminator field names for one concept: `.reason`, `.code`, `.stage`, `.usage` | 6 |
| F13 | stale-anchor | medium | 13 verified-stale `file:line` citations, two inside user-facing refusal strings | 6 |
| F14 | duplicate | medium | severity set declared three times; `converge` silently drops an unknown severity | 3 |
| F15 | oversize | medium | `emitAdapter` — a 15-arm `event.kind` ladder that is pure table material | 1 |
| F16 | oversize | medium | `driveTask` is 1785 lines — the whole tail of `drive.mjs` | 1 |
| F17 | duplicate | low-med | the tier ladder `['mechanical','build','judge']` exists five times, cross-pinned zero times | 2-5 |
| F18 | duplicate | low-med | `versionAtLeast` byte-identical in `breaker.mjs` and `daemon.mjs`, over two different floors | 2 |
| F19 | duplicate | low-med | `WAIT_POLL_MS = 5000` declared three times under one name | 3 |
| F20 | duplicate | low | the blocking-sleep body appears eight times; one copy is untestable | 1-8 |
| F21 | grammar-drift | low | `windowLabel` has a minutes branch; `budgetWindowLabel` does not | 1 |
| F22 | dead-export | low | 2 dead re-export specifiers + 49 gratuitous exports | 6 |
| F23 | duplicate | low | four plain-object predicates, two of which are not predicates | 4 |
| F24 | duplicate | low | daemon socket root + `daemon.sock` spelled out in two modules | 2 |
| F25 | oversize | low | five 6-to-9-arm string ladders with an in-repo table precedent | 4 |

---

## 3. Findings in detail

### F1 — `crew.json` has three writers with three durability contracts · duplicate + grammar-drift · **high**

| site | contract |
|---|---|
| `crew/seat-io.mjs:909` `saveCrew(paths, crew, fs)` | **atomic** (`tmp` + `renameSync`), writes whether or not the file exists, **throws** on failure |
| `crew/headless.mjs:172` `persistCrew(crew, paths, writeFileSync)` | **non-atomic** direct write, **only if the file already exists**, swallows every error |
| `crew/headless-rpc.mjs:179` `persistCrew(crew, paths, write)` | identical to the above, restructured guard, different comment |

Two distinct defects in one place:

1. The two `persistCrew` copies are semantically the same function under the
   same name in two modules — and `headless-rpc.mjs:15` **already imports from
   `headless.mjs`** (`import { shq, classifyRun } from './headless.mjs'`), so
   the import edge exists and only the `export` keyword is missing.
2. `saveCrew` drifts hard from both: atomic vs not, create vs require-existing,
   throw vs swallow — **and its first two positional parameters are swapped**
   (`(paths, crew)` vs `(crew, paths)`). A crash between `write` and `rename`
   cannot truncate `crew.json` via `saveCrew`; via either `persistCrew` it can.
   Callers: `headless.mjs:264,303`, `headless-rpc.mjs:398`, `seat-io.mjs:2084,2145`.

**Simplification.** Export one writer from `seat-io.mjs` (or a new leaf) with an
explicit `{ atomic, requireExisting, swallow }` posture, and delete both
`persistCrew` copies.
**Pinned by.** Nothing pins the three against each other. `saveCrew`'s atomicity
is exercised only indirectly through `seat-io` fixtures.
**Cost.** 3 files.

---

### F2 — the `#522` `NODE_FLOOR` trap · duplicate · **high**

`scripts/factory/ledger.mjs:114` — `export const NODE_FLOOR = '24.0.0'` (source of truth)
`crew/daemon.mjs:133` — `export const LEDGER_NODE_FLOOR = '24.0.0'` (firewall-forced copy)

The copy is deliberate and documented at `crew/daemon.mjs:127-132`. The defect
is the **pin**:

```
crew/daemon.test.mjs:1321   assert.equal(LEDGER_NODE_FLOOR, '24.0.0')
```

That is a restatement of the literal, not a comparison of the two symbols —
even though the same test file **already imports the real one** at
`crew/daemon.test.mjs:21` (`import { NODE_FLOOR, openLedger } from '../scripts/factory/ledger.mjs'`).
Move `NODE_FLOOR` to `'26.0.0'` and `crew/daemon.mjs:133` stays at `'24.0.0'`
with a green suite. Below its floor `usageWindow` (`crew/daemon.mjs:260-264`)
fails closed and every budget window reads as unmeasured — so the daemon would
silently stop measuring while the ledger happily wrote.

**Simplification.** One character-level change:
`assert.equal(LEDGER_NODE_FLOOR, NODE_FLOOR)`. Tests are not behind the
firewall, so no leaf module and no code change are needed.
**Pinned by.** `crew/daemon.test.mjs:1321` — and that pin is the bug.
**Cost.** 1 file (a test). This is the single cheapest high-value fix in the register.

---

### F3 — lane-fence rehydration copied into both run entrypoints, already drifted · duplicate · **high**

```
crew/crew.mjs:1778    const laneFence = Array.isArray(crew.lane_fence) ? crew.lane_fence : null
crew/crew.mjs:1779    if (laneFence) {
crew/crew.mjs:1780      logLine(journal, { at: new Date().toISOString(), event: 'lane-fence',
crew/crew.mjs:1781        lane_name: crew.lane_name ?? null, lanes: laneFence.length,
crew/crew.mjs:1782        files: laneFence.reduce((n, record) => n + record.files.length, 0) })

crew/child.mjs:283          const laneFence = Array.isArray(crew.lane_fence) ? crew.lane_fence : null
crew/child.mjs:284          if (laneFence) {
crew/child.mjs:287            try {
crew/child.mjs:288              io.log?.({ at: new Date().toISOString(), event: 'lane-fence',
crew/child.mjs:289                lane_name: crew.lane_name ?? null, lanes: laneFence.length,
crew/child.mjs:290                files: laneFence.reduce((n, record) => n + (record.files?.length ?? 0), 0) })
crew/child.mjs:291            } catch { /* instrumentation is never load-bearing */ }
```

Two copies of one emitter, and they have **already diverged twice**:

- `crew.mjs:1782` does `record.files.length`; `child.mjs:290` does
  `record.files?.length ?? 0`. A `lane_fence` record without a `files` array
  throws a `TypeError` out of the attended `run` verb and is counted as `0` by
  the daemon-forked runner.
- `child.mjs` wraps the emit in `try/catch` ("instrumentation is never
  load-bearing"); `crew.mjs` does not. A journal write failure aborts one
  entrypoint and not the other.

`crew.json` is described at `crew/crew.mjs:2165` as *"the run's single source of
fence truth"*, so the two entrypoints are supposed to agree exactly.

**Simplification.** Extract the four lines into a leaf both entrypoints import
(`child.mjs` may not import `crew.mjs`; a leaf is the only legal move), keeping
the null-safe child semantics.
**Pinned by.** Each side separately — `crew/crew.test.mjs:2323` and
`crew/daemon.test.mjs:1761,1819` — and **nothing pins them against each other**,
unlike the `resolveValidationLane` twin at `crew/crew.test.mjs:1032`.
**Cost.** 2 files + 1 new leaf.

---

### F4 — `crew.roles` recorded at boot, re-derived three ways · re-derivation · **high**

Boot records it: `crew/crew.mjs:1625` — `roles, members, task_return: …`.

| re-derivation | expression |
|---|---|
| `crew/daemon.mjs:335` (`paneSeat`) | `crew?.roles \|\| Object.keys(crew?.members \|\| {})` |
| `crew/child.mjs:122` | `crew.roles \|\| Object.keys(crew.members \|\| {})` |
| `crew/daemon.mjs:1138` (`send`) | `Object.keys(members)` — **the recorded list is ignored** |

The first two are the same expression written twice (differing only in optional
chaining). The third is a genuine behavioural divergence: `crew.roles` is an
**ordered** list written at boot, while `Object.keys(members)` is the members
object's own insertion order. At `crew/daemon.mjs:1138` that order drives two
things — the candidate iteration for auto-picking a steerable seat
(`crew/daemon.mjs:1151-1157`) and the `seated roles: …` listing in the
`not-found` refusal (`crew/daemon.mjs:1145`). When the two orders differ, `send`
without `--role` can adjudicate the candidates in a different order from every
other reader of the same file.

**Simplification.** One `rolesOf(crew)` accessor in a leaf; `daemon.mjs:1138`
uses it and stops ignoring the record.
**Pinned by.** No test compares the three, and none pins `daemon.mjs:1138`'s
ordering.
**Cost.** 3 files (+1 leaf).

---

### F5 — `crew.json` read five ways with three absence grammars · grammar-drift · med-high

| reader | on missing / unreadable |
|---|---|
| `crew/crew.mjs:312` `loadCrew` | `existsSync` guard → **throws** plain `Error('no crew booted for this task (missing …)')`; a *parse* failure escapes as a raw `SyntaxError` |
| `crew/child.mjs:121` | **throws** plain `Error('cannot read crew.json at …: <msg>')` — no `.reason`, no `.code` |
| `crew/daemon.mjs:1083` | **throws** `runError('invalid-spec', 'cannot read crew.json at …: <msg>')` — carries `.code` |
| `crew/daemon.mjs:661` `crewConfig` | **returns `null`** for every failure, behind an `mtimeMs:size` cache |
| `crew/harvest.mjs:58-62` | **returns null-ish**, swallowing — *"invalid metadata is treated as absent"* |

Three grammars (throw-plain / throw-coded / return-null) and two message
spellings for one file. `crew/daemon.mjs:1136` adds a sixth shape: the same
prose `cannot read crew.json at …` is reused for a *different* condition
(`members` is not an object), so one message covers two causes.

**Simplification.** One reader with an explicit absence contract; callers that
want `null` ask for `null`. Note the firewall: this needs a leaf, not an import
edge into `daemon.mjs`.
**Pinned by.** Each site separately by its own module's tests; nothing pins the
grammar.
**Cost.** 5 files (+1 leaf).

---

### F6 — the journal carries two row grammars · grammar-drift · med-high

Most rows are discriminated by an `event` key — ~30 kinds, e.g.
`crew/crew.mjs:1643` `event: 'boot'`, `crew/seat-io.mjs:1186`
`event: 'seat-teardown'`, `crew/headless.mjs:306` `event: 'headless-spawn'`.

Three row families carry **no `event` key at all** and are identified only by
the presence of a payload field:

```
crew/headless.mjs:234       log({ at: now(), headless_outcome: outcome, exit_code, signal, … })
crew/headless-rpc.mjs:616   log({ at: now(), rpc_outcome: outcome, role, id, exit_code })
crew/drive.mjs:1670,1824    io.log({ at: io.now(), no_lead_escalation: why })
```

`crew/headless.mjs` uses **both** grammars — `:306` discriminated, `:234` not.

The cost lands in one place: `crew/daemon.mjs:186-231` `normalizeEvent` cannot
switch on `event`; it must sniff for key presence (`crew/daemon.mjs:204-205`)
and additionally fold two spellings of one concept —
`outcome: row.headless_outcome ?? row.rpc_outcome` (`crew/daemon.mjs:207`).
A new transport adds a third spelling and a fourth `if`.

**Simplification.** Give the three families an `event` key
(`event: 'terminal-result'`, `event: 'no-lead-escalation'`) with the outcome as
a payload field. **This changes journal event shape**, which the brief's *Out of
scope* forbids — so record it as a design finding for a future ADR, not as a
change to make now.
**Pinned by.** `crew/daemon.test.mjs` exercises `normalizeEvent`'s sniffing;
`crew/factoryctl.test.mjs:318,344` writes bare `headless_outcome` rows as fixtures.
**Cost.** 4 files + a journal-shape ADR. **Blocked by the brief's own scope bar.**

---

### F7 — six JSON-read-or-null helpers, only one tri-state · duplicate · med-high

| site | existence check | coercion | shape filter | unreadable vs absent |
|---|---|---|---|---|
| `crew/arms.mjs:112` `readJson` | none — ENOENT falls into the parse `catch` | no | none | collapsed |
| `crew/seat-io.mjs:251` `readMarker` | none — same collapse | `String()` | `typeof === 'object'` (**accepts arrays**) | collapsed |
| `crew/headless.mjs:200` `readState` | `exists()` | no | none | collapsed |
| `crew/headless-rpc.mjs:254` `readJson` | `exists()` | `String()` | none | collapsed |
| `crew/daemon.mjs:306` `jsonAt` | `!path \|\| !exists()` | `String()` | `isObject` (**rejects arrays**) | collapsed |
| `crew/reclaim.mjs:347` `readJson` | `existsSync()` | `String()` | none | **`null` = absent, `undefined` = unreadable** |

`crew/reclaim.mjs:347-352` is the only one that distinguishes *absent* from
*present-but-unreadable*, and that distinction is load-bearing:
`crew/reclaim.mjs:976` `readMarker` and `crew/reclaim.mjs:998` `verdictOf` branch
on it to tell `FREE` from `UNRESOLVABLE`. Substituting any other copy silently
turns an unresolvable reservation into a free one.

**Simplification.** One leaf reader with the tri-state contract; the five
collapsing callers opt into `?? null`. Do **not** move `reclaim`'s semantics
onto the others by unifying downward.
**Pinned by.** `crew/reclaim.test.mjs` pins the tri-state via `VERDICTS`;
nothing pins the other five against each other.
**Cost.** 6 files (+1 leaf). `reclaim.mjs` is protected-floor → judge tier.

---

### F8 — `envelopeAt`: same name, inverted argument order · grammar-drift · medium

**[corrected]** — a scout reported this as an argument-order bug at the call
sites. It is not; both call sites are correct. The real finding is narrower and
still worth having:

```
crew/headless.mjs:146   function parseExit(path, readFileSync, existsSync)   → called (path, read, exists)
crew/headless.mjs:154   function envelopeAt(path, existsSync, readFileSync)  → called (path, exists, read)
crew/headless-rpc.mjs:158 function parseExit(path, read, exists)
crew/headless-rpc.mjs:166 function envelopeAt(path, read, exists)
```

Two helpers defined eight lines apart in `headless.mjs` take their two injected
dependencies in **opposite order**, and `headless-rpc.mjs` normalises both to
`(path, read, exists)`. So `envelopeAt` means two different call shapes in two
modules joined by a live import edge. Both are correct where they stand; the
transposition fires the moment anyone consolidates them — which F1/F10 invite.
`headless-rpc`'s copies additionally add a `!path ||` guard and a `String()`
coercion that `headless.mjs`'s lack.

**Simplification.** Normalise `headless.mjs:154` to `(path, read, exists)` and
fix its one call site (`crew/headless.mjs:205`), then export both from
`headless.mjs` and delete the `headless-rpc.mjs` copies.
**Pinned by.** Behaviour is pinned at each call site; the signatures are pinned
by nothing.
**Cost.** 2 files.

---

### F9 — absence in the usage reducers: zero vs null · grammar-drift · medium

Four reducers over the same four-field billed-token shape:

```
crew/headless.mjs:97      foldUsage      → returns null when nothing was measured
crew/headless-rpc.mjs:131 foldRpcUsage   → `return measured ? total : null`
crew/headless-rpc.mjs:147 addUsage(a,b)  → null-preserving: null+x = x, null+null = null
crew/seat-io.mjs:900      addTotals(prev, delta) → `(prev?.x ?? 0) + (delta?.x ?? 0)`
```

`crew/headless-rpc.mjs:115-120` states the intent explicitly — *"an unrecognised
frame must never inflate a billed total that prices into `cost_usd` … the two
reducers are IDENTICAL rather than merely compatible."* Both folds honour it.
`addTotals` (`crew/seat-io.mjs:900`, called at `crew/seat-io.mjs:1148`) then
**destroys exactly that distinction**: an unmeasured seat folds to an explicit
`0` total rather than staying `null`, so "we billed nothing" and "we never
measured" become the same record downstream.

**Simplification.** Make `addTotals` null-preserving like `addUsage`, or replace
it with `addUsage` lifted to a leaf. Either way the four reducers then agree.
**Pinned by.** `crew/headless-rpc.test.mjs` pins `foldRpcUsage`'s null;
`crew/headless.test.mjs` pins `foldUsage`'s null. **Nothing pins `addTotals`'
zeroing**, so the change is testable but currently unguarded.
**Cost.** 2 files. Verify against the ledger's `measured` flag before changing —
a downstream reader may already depend on the zero.

---

### F10 — `logLine` creates the parent directory; the hand-rolled copies do not · duplicate · medium

```
crew/driver.mjs:224   export function logLine(file, obj) {
crew/driver.mjs:226     mkdirSync(dirname(file), { recursive: true })
crew/driver.mjs:227     appendFileSync(file, `${JSON.stringify(obj)}\n`)

crew/headless.mjs:229      function log(obj)   { … write(join(paths.dir,'journal.jsonl'), …, {flag:'a'}) }
crew/headless-rpc.mjs:247  function log(value) { … write(join(paths.dir,'journal.jsonl'), …, {flag:'a'}) }
```

`crew/crew.mjs:43` and `crew/seat-io.mjs:14` import `logLine` from
`driver.mjs`. `headless.mjs:15` and `headless-rpc.mjs:14` **already import from
`driver.mjs`** (`assignmentLine`) — the edge exists, only the symbol is missing.
The two hand-rolled copies omit the `mkdirSync`, so a journal line written
before the crew dir exists is silently lost in the headless transports and
preserved in the attended path.

**Simplification.** Import `logLine`; keep the `injectedLog` seam as a wrapper.
**Pinned by.** Nothing pins the dir-creation difference.
**Cost.** 2 files (3 if the seam moves).

---

### F11 — `RESEAT_REASONS` is dead *and* divergent · dead-export + duplicate · medium

```
crew/seat-io.mjs:838   export const RESEAT_REASONS = Object.freeze(['transport','exhausted','no-tier','agent-change'])
crew/drive.mjs:287     export const MODIFIER_OUTCOMES = Object.freeze(['applied','transport','exhausted','no-tier','agent-change','spent'])
scripts/factory/ledger.mjs:261                                        'applied','transport','exhausted','no-tier','agent-change','spent',
```

```
$ rg -n --no-heading -g '!node_modules' 'RESEAT_REASONS' .
crew/seat-io.mjs:838:export const RESEAT_REASONS = Object.freeze([…])
```

**One hit in the whole checkout — its own declaration.** No importer, no test,
no doc. And it is a *two-member-short* copy of `MODIFIER_OUTCOMES`: whoever next
reads it as the reseat vocabulary gets a set missing `applied` and `spent`.
The live literals are written inline instead (`crew/seat-io.mjs:1971`
`'no-tier'`, `crew/seat-io.mjs:2020` `'agent-change'`).

Note the contrast: `MODIFIER_OUTCOMES` and the ledger's copy **are** cross-pinned
— `test/factory-ledger.test.mjs:857` does
`assert.deepEqual(MODIFIER_ATTEMPT_OUTCOMES, MODIFIER_OUTCOMES)`. That is the
standard `RESEAT_REASONS` fails.

**Simplification.** Delete the line.
**Pinned by.** Nothing.
**Cost.** 1 file, 1 line.

---

### F12 — four discriminator field names for one concept · grammar-drift · medium

A machine-readable refusal kind is spelled four ways across the eleven:

| field | sites |
|---|---|
| `.reason` | `crew/capabilities.mjs:26`, `crew/limits.mjs:21`, `crew/drive.mjs:64`, `crew/crew.mjs:642`, `crew/crew.mjs:669`, `crew/reclaim.mjs:294` |
| `.code` | `crew/daemon.mjs:40` `runError`, `crew/factoryctl.mjs:36,47,89,98`, `crew/crew.mjs:668`, `crew/host-load.mjs:62`, `crew/breaker.mjs:202` |
| `.stage` | `crew/headless.mjs:238,245,249`, `crew/headless-rpc.mjs:187`, `crew/seat-io.mjs:1338,1416,1424` |
| `.usage` | `crew/crew.mjs:2123` `UsageError` (`this.usage = true`) |

Underneath sit **four byte-identical closed-set refusal factories**:

```
crew/capabilities.mjs:24  export function refuse(reason, message) {
crew/limits.mjs:19        export function refuseLimit(reason, message) {
crew/drive.mjs:62         export function refuseWait(reason, message) {
crew/crew.mjs:640         export function refuseBandFloor(reason, message) {
```

all four with the identical body —

```
  if (!<SET>.includes(reason)) throw new Error(`unknown <noun> refusal reason ${JSON.stringify(reason)}`)
  return Object.assign(new Error(`${message} [${reason}]`), { reason })
```

— differing only in the allowlist constant and one noun. All four **return**;
the caller throws.

`crew/crew.mjs:661` `refuseStaleDescendants` is the drifted fifth: it **throws
instead of returning**, sets **both** `.code` and `.reason`, formats the suffix
as `[reason: X]` rather than `[X]`, and its meta-error drops the
`JSON.stringify` (`unknown boot descendant refusal: ${reason}`). A caller
copying the `throw refuseX(...)` idiom onto it writes an unreachable `throw`.

Fifth and sixth spellings of `refuse` exist as local closures returning *records*
rather than errors: `crew/drive.mjs:635` `(reason, why) => ({reason, why})`,
`crew/seat-io.mjs:188` `(liveness, reason) => ({signalable:false, …})` — note the
first parameter there is a *liveness*, not a reason — and `crew/seat-io.mjs:2067`
with arity 1. `crew/crew.mjs:67` imports `refuse` from `capabilities.mjs`, so a
reader moving between these files sees one identifier meaning "throwable error"
and "verdict record".

**Simplification.** One `refusalFactory(SET, noun)` in a leaf produces the four
identical ones; align `refuseStaleDescendants` to return-not-throw and to the
`[X]` suffix; rename the record-returning locals so they do not read as `refuse`.
**Pinned by.** `crew/capabilities.test.mjs:185`, `crew/crew.test.mjs:3403`,
`crew/drive.test.mjs:277`, `crew/crew.test.mjs:884` pin each factory's
unknown-reason throw. `refuseLimit` is pinned only indirectly, via
`crew/crew.test.mjs:1112,1132` asserting `LIMIT_REFUSALS.includes(err.reason)`.
Nothing pins the four against each other.
**Cost.** 6 files (+1 leaf). `drive.mjs` is protected-floor → judge tier.

---

### F13 — thirteen verified-stale `file:line` citations · stale-anchor · medium

75 cross-file `file:line` citations appear in the eleven. Each was resolved with
`sed -n`. **Thirteen do not land on what the citing text claims:**

| citer | cites | actually there | truth is at |
|---|---|---|---|
| `crew/daemon.mjs:127` | `scripts/factory/ledger.mjs:78` (`NODE_FLOOR`) | blank line | `ledger.mjs:114` |
| `crew/daemon.mjs:50` | `drive.mjs:830-848` (the scope-defect twin) | `MAX_QUESTIONS` / `REFUTATION_EVIDENCE_MAX` | `drive.mjs:1250-1269` |
| `crew/daemon.mjs:258` | `ledger.mjs:1378` (SUM-over-rows) | mirror error handling | elsewhere |
| `crew/crew.mjs:443` | `crew/drive.mjs:66` (`SHAPE_SOURCES`) | blank line | `drive.mjs:155` |
| `crew/crew.mjs:653` | `reap-stale.mjs:120` (the verdicts) | a `readdirSync` | `reap-stale.mjs:16` |
| `crew/crew.mjs:1516` | `crew/seat-io.mjs:679` (`swept_at`) | `return parts.join(' ')` | `seat-io.mjs:316,331,344,354` |
| `crew/drive.mjs:836` | `ledger.mjs:1266` (the 500-char bound) | `let dbOpenAttempted = false` | `ledger.mjs:1715,1769` |
| `crew/drive.mjs:1652` | `crew/child.mjs:96` (the lead strip) | blank line | `child.mjs:131` |
| `crew/seat-io.mjs:835` | `crew/crew.mjs:364-371` (the rung rule) | files_in_scope inheritance | elsewhere |
| `crew/seat-io.mjs:842` | `crew/headless.mjs:128` (command composition) | `let terminal = false` | elsewhere |
| `crew/seat-io.mjs:842` | `crew/headless-rpc.mjs:122` (same claim) | inside `carriesOwnSpend` | elsewhere |
| `crew/capabilities.mjs:286` | `adapter-claude.mjs:61-63` (the tool merge) | `NO_GRANTS`; merge is at `:64` | off by 1-3 |
| **`crew/seat-io.mjs:935`** | `spike-findings.md:39-48` | **no such file at the repo root** (three exist under `tasks/*/`) | — |

Two of these are **not comments** — they are strings a human reads at runtime:

- `crew/seat-io.mjs:935` is inside a thrown `Error`: *"no frozen headless worker
  binary found: checked --claude-bin, $CREW_CLAUDE_BIN, and … (spike-findings.md:39-48)"*
  — pointing an operator at a path that does not resolve.
- `crew/seat-io.mjs:1966` is inside a refusal `why` string citing
  `crew/crew.mjs:265`, which is `tripwires,` in an advisor-manifest object.

**Simplification.** Correct the thirteen; drop the line numbers from the two
runtime strings (a filename without a line number cannot rot). A cheap tripwire
test could parse `<path>:<n>` out of `crew/*.mjs` comments and assert the file
exists and has at least `n` lines — that catches the deleted-file and
past-EOF classes mechanically, though not "lands on the wrong line".
**Pinned by.** **Nothing.** `test/factory-make-brief.test.mjs:296-323` treats a
citation as a *coupling* for fence purposes but never checks that it resolves.
**Cost.** 6 files, comments only, zero behaviour risk. Highest value-per-risk in
the register.

---

### F14 — the severity set declared three times; `converge` drops unknowns silently · duplicate · medium

```
crew/drive.mjs:702             export const FINDING_SEVERITIES = Object.freeze(['must-fix','should-fix','consider'])
crew/escalation-policy.mjs:9   const PANEL_SEVERITIES        = Object.freeze(['must-fix','should-fix','consider'])
crew/converge.mjs:6            export const SEVERITY_RANK    = Object.freeze({ 'must-fix':0, 'should-fix':1, consider:2 })
```

Three declarations of one closed set under three names. The behavioural edge is
at `crew/converge.mjs:47`:

```
if (!entry || typeof entry !== 'object' || !Object.hasOwn(SEVERITY_RANK, entry.severity)) continue
```

`SEVERITY_RANK` is doing duty as the **validator** on the converge side while
`FINDING_SEVERITIES` is the validator on the drive side. Add a fourth severity
to `FINDING_SEVERITIES` — which `crew/drive.mjs:700-701` explicitly anticipates
("Phase 1 makes it machine-readable; it does not add a fourth") — and
`residualList` **silently drops** every finding carrying it from the draft-PR
body. A dropped residual is an unresolved finding that no longer appears in the
record.

`converge.mjs:1-3` declares itself import-free by design, so the fix is an
equality test, not an import.

**Simplification.** Add `assert.deepEqual(Object.keys(SEVERITY_RANK), FINDING_SEVERITIES)`;
separately, make `converge.mjs:47` count what it drops rather than `continue`
silently.
**Pinned by.** `crew/drive.test.mjs:599` pins `FINDING_SEVERITIES`;
`crew/converge.test.mjs:127` pins `SEVERITY_RANK`. `PANEL_SEVERITIES` is pinned
by nothing. No test pins the three together.
**Cost.** 1 test + optionally 1 file.

---

### F15 — `emitAdapter` is a 15-arm `event.kind` ladder · oversize · medium

`crew/seat-io.mjs:990-1168` (179 lines). The body is one `if / else if` chain on
`event.kind` inside the returned closure, `crew/seat-io.mjs:1003-1166`:

```
1003:    if (event.kind === 'stage') {
1007:    } else if (event.kind === 'assign') {
1009:    } else if (event.kind === 'envelope') {
```

Exactly 15 arms (counted: `grep -c "event.kind === "` over `1003,1166` → 15).
This is the cleanest table candidate in the eleven: a frozen
`{ stage(event, ctx){…}, assign(…){…}, … }` map plus a three-line
`HANDLERS[event.kind]?.(event, ctx)` dispatcher removes the 15 `} else if (…) {`
lines (**~18-20 lines**) and turns adding an event kind into a data edit.

**Pinned by.** `crew/crew.test.mjs`, `crew/seat-io-runclean.test.mjs`,
`test/factory-ledger.test.mjs` and `test/visualizer-shape.test.mjs` all exercise
`emitAdapter`, so the refactor is well covered.
**Cost.** 1 file.

---

### F16 — `driveTask` is 1785 lines · oversize · medium

`crew/drive.mjs:1466-3250` — the function begins at line 1466 and the file ends
at 3250, so `driveTask` **is the entire tail of the file**. Inside it:
~240 lines of setup closures, a plan loop (`2228-2332`), ~330 lines of gate-proof
machinery (`2407-2737`), panel machinery (`2739-2952`) and a 266-line build loop
(`2954-3219`).

Mostly shape (b) — a sequential state machine, not a branch ladder — so a table
does not apply and the honest simplification is a phase split, which is a large
change to a **protected-floor** file. Two bounded pieces are worth extracting on
their own:

- Six repeated `if (c.decision === 'escalate') … if (c.decision === 'bounce') …`
  blocks at `2240`, `2314-2315`, `2967`, `3112-3117`, `3175-3180`, `3215` — one
  `applyLeadDecision(c, where)` removes ~40 lines.
- `panelReview` (nested, `2759-2940`, 182 lines) is three near-identical
  compose-brief → `assignAndWait` → guard → return blocks (`2769-2777`,
  `2779-2797`, `2809-2835`) differing only in role, brief filename and
  instruction literal — one `panelSeatRound({role, file, instructions})` removes
  ~45 lines.

**Pinned by.** `crew/drive.test.mjs` extensively (it is the largest test file
against the largest function). **Cost.** 1 file, judge tier.

---

### F17 — the tier ladder exists five times, cross-pinned zero times · duplicate · low-med

```
crew/crew.mjs:622                       const LADDER_TIERS   = Object.freeze(['mechanical','build','judge'])
crew/seat-io.mjs:837             export const RESEAT_LADDER  = Object.freeze(['mechanical','build','judge'])
scripts/factory/make-brief.mjs:63 export const TIER_NAMES    = Object.freeze(['mechanical','build','judge'])
visualizer/server/roster-ladder.mjs:12  const REQUIRED_TIERS = ['mechanical','build','judge']
visualizer/server/roster-edit.mjs:153   (inline fallback)
```

Five identical copies under four names; a sixth is written inline in a test
(`crew/crew.test.mjs:3168`). Nothing pins any pair. `crew/crew.mjs:618-621`
documents the visualizer copies as "mirrored, not imported" — with no test
enforcing the mirror.

**Simplification.** A `crew/tiers.mjs` leaf for `crew.mjs` + `seat-io.mjs`;
equality tests for the two visualizer mirrors and `make-brief`.
**Cost.** 2 files minimum, 5 for the full sweep.

---

### F18 — `versionAtLeast` byte-identical over two different floors · duplicate · low-med

`diff <(sed -n '33,47p' crew/breaker.mjs) <(sed -n '242,256p' crew/daemon.mjs)` →
**empty**. Two byte-identical 15-line comparators:

- `crew/breaker.mjs:33` compares against `NODE_FLOOR` imported from
  `scripts/factory/ledger.mjs:3` → used at `crew/breaker.mjs:125`.
- `crew/daemon.mjs:242` compares against `LEDGER_NODE_FLOOR` re-declared at
  `crew/daemon.mjs:133` → used at `crew/daemon.mjs:261`.

A third lives at `scripts/factory/ledger.mjs:991`. So a duplicated *helper* sits
on top of a duplicated *constant* (F2) — the same policy evaluated by two
comparators against two floors. The helper duplication is firewall-forced and
harmless; **the constant duplication is not, and F2 is the fix.**
**Pinned by.** Each side's own tests; no cross-pin.
**Cost.** 0 if F2 is done (the helper copy can stay).

---

### F19 — `WAIT_POLL_MS = 5000` declared three times under one name · duplicate · low-med

`crew/seat-io.mjs:26`, `crew/headless.mjs:19`, `crew/headless-rpc.mjs:19` — same
name, same value, same meaning. The import graph already permits one owner:
`seat-io.mjs:16` imports from `headless.mjs`, and `headless-rpc.mjs:15` imports
from `headless.mjs`. All three test importers
(`crew/crew.test.mjs:3509`, `crew/io-contract.test.mjs:12`,
`crew/seat-io-runclean.test.mjs:877`) resolve `seat-io`'s copy only, so a drift
in the other two would be invisible.

**Simplification.** Declare once in `headless.mjs`; re-export from `seat-io.mjs`
to keep the test import paths intact.
**Cost.** 3 files.

---

### F20 — the blocking-sleep body appears eight times · duplicate · low

`SharedArrayBuffer(4)` + `Atomics.wait` — `crew/headless.mjs:74`,
`crew/reclaim.mjs:21`, `crew/seat-io.mjs:55`, `crew/seat-io.mjs:1298`,
`crew/seat-io.mjs:1491`, `crew/headless-rpc.mjs:225`, `crew/crew.mjs:1922`,
`crew/driver.mjs:79`. Seven are parameterised `(ms)` behind a `deps.sleep ||`
seam and are functionally identical.

The eighth is different and worth the finding on its own:

```
crew/crew.mjs:2021    const sab = new SharedArrayBuffer(4)
crew/crew.mjs:2022    Atomics.wait(new Int32Array(sab), 0, 0, 5000)
```

Inside `waitCmd`, inline, **with the 5000 ms interval hard-coded and no
`deps.sleep` seam** — the one sleep in the eleven that a test cannot stub, so
`waitCmd`'s poll loop cannot be driven by a fake clock.

**Simplification.** A `blockingSleep(ms)` leaf; give `waitCmd` the injection
seam every other caller has.
**Pinned by.** Nothing pins the copies together.
**Cost.** 1 file for the `waitCmd` seam; up to 8 for the full sweep.

---

### F21 — `windowLabel` has a minutes branch; `budgetWindowLabel` does not · grammar-drift · low

```
crew/breaker.mjs:208   hours → `${hours}h`; minutes → `${minutes}m`; else `${windowMs}ms`
crew/daemon.mjs:1038   hours → `${hours}h`; else `${windowMs}ms`
```

A 30-minute window renders as `30m` in a breaker refusal and `1800000ms` in a
daemon budget refusal. Refusal prose only — no control flow depends on it.
**Pinned by.** Nothing compares them. **Cost.** 1 file.

---

### F22 — dead and gratuitous exports · dead-export · low

Census: **342 exports across the eleven** — 64 LIVE (imported by ≥1 non-test
module), 10 test-only with no self-use, 216 test-only but used inside their own
module, 49 gratuitous (`export` keyword unconsumed by anything, code live),
**3 fully dead**.

Two caveats that survived checking and constrain any deletion:

- The complete set of importers of the eleven from **outside `crew/`** is two
  files: `visualizer/server/roster-edit.mjs:4` and
  `scripts/factory/reap-stale.mjs:11-12`. Everything else that greps as a
  consumer is a comment, a prompt string, or an independently-defined local of
  the same name (`crew/pi/extensions/*.ts` re-implement `foldUsage`,
  `carriesOwnSpend`, `scopeMatcher`, `SAFE_MODEL` as their own;
  `scripts/factory/make-brief.mjs` has its own `LADDER_PATH:65` and
  `validateScopeEntries:865`).
- `SCOPE_DIR_MIN_SEGMENTS` (`crew/drive.mjs:1249`) and `scopeMatcher`
  (`crew/drive.mjs:1388`) are invoked by hand from
  `skills/crew-dispatch/references/fences.md:51,59` via
  `node --input-type=module -e "import {…} from './crew/drive.mjs'"`. **They have
  a real non-code consumer** and must not be un-exported.

Fully dead (delete):

| symbol | site | grep |
|---|---|---|
| `RESEAT_REASONS` | `crew/seat-io.mjs:838` | 1 hit — see F11 |
| `validateCapabilities` specifier | `crew/crew.mjs:69` | re-exported but **not imported by `crew.mjs:65-68`**; `crew/capabilities.test.mjs:8` imports it from `capabilities.mjs` directly; no consumer of `crew.mjs` names it |
| `LOAD_ENV` specifier | `crew/crew.mjs:71` | re-exported but **not imported by `crew.mjs:70`**; only real users are `host-load.mjs` itself and `host-load.test.mjs`, which imports from `host-load.mjs` |

`crew/crew.mjs:71` is a dead re-export **line**: no importer of `crew.mjs` names
`LOAD_ENV`, `hostLoad`, `loadPolicy` or `assertHostQuiet`. (The `import` at
`:70` is live — `crew.mjs` uses those three itself.)

The 49 gratuitous exports are listed in §4. The largest by definition span are
`memoryExtracts` (`crew/crew.mjs:1266`, 35 lines),
`assertAdvisorCellLive` (`crew/crew.mjs:224`, 23),
`reaskBrief` (`crew/seat-io.mjs:1365`, 19),
`lsVerb` (`crew/factoryctl.mjs:247`, 14).
Dropping the `export` keyword removes no code; it removes a false public surface.

**Pinned by.** Nothing pins any of the three dead entries.
**Cost.** 1 file for the three deletions; 6 for the gratuitous sweep.

---

### F23 — four plain-object predicates, two of which are not predicates · duplicate · low

```
crew/daemon.mjs:234           export function isObject(value)   → returns the VALUE, not a boolean (`isObject(0)` is `0`)
crew/daemon.mjs:236           function isPlainObject(value)     → boolean, prototype-checked
crew/drive.mjs:844            const isPlainObject = (value)     → same, plus try/catch for proxy-hostile input
crew/escalation-policy.mjs:156 function object(value)           → returns the value or `null` — an accessor, not a predicate
```

Two more inline copies of the same test are spelled longhand at
`crew/reclaim.mjs:372,374`. `crew/child.mjs:20` imports `isObject` from
`daemon.mjs`, so the truthy-not-boolean version is already crossing a module
boundary.
**Simplification.** One leaf predicate; the coercing accessor keeps its own name.
**Cost.** 4 files (+1 leaf).

---

### F24 — the daemon socket path is spelled out twice · duplicate · low

```
crew/daemon.mjs:371     const root = resolvePath(options.root || join(homedir(), '.crew', 'daemon'))
crew/daemon.mjs:372     const socketPath = join(root, 'daemon.sock')
crew/factoryctl.mjs:25    const root = args.root || env.CREW_DAEMON_ROOT || join(homedir(), '.crew', 'daemon')
crew/factoryctl.mjs:26    return join(root, 'daemon.sock')
```

Server and client each construct the rendezvous path from literals, with no
shared constant and nothing pinning them equal. They also disagree on one input:
`factoryctl` honours `CREW_DAEMON_ROOT`, the daemon does not. `factoryctl.mjs`
already imports `./headless-rpc.mjs` and `./variants.mjs`, so a
`crew/daemon-paths.mjs` leaf is legal under the firewall for both sides.
**Pinned by.** Nothing. **Cost.** 2 files (+1 leaf).

---

### F25 — string ladders with an in-repo table precedent · oversize · low

| site | key | arms | note |
|---|---|---|---|
| `crew/daemon.mjs:1328-1344` | `cmd` | 9 + default throw | `crew/crew.mjs:2186` already does exactly this: `const COMMANDS = { boot: bootCmd, run: runCmd, … }`. ~10 lines. |
| `crew/daemon.mjs:188-230` | `source` × row kind | 9 | `normalizeEvent`; a `{daemon, journal, stream, worker}` map makes each source independently testable. ~8 lines. |
| `crew/daemon.mjs:506-534` | `record.kind` | 7 | `applyRecord`. ~7 lines. |
| `crew/seat-io.mjs:959-969` | stage-label head | 7 + default | `phaseForStage` is already half data-driven via `VARIANT_STAGE_PHASES` (`crew/seat-io.mjs:956`); folding the rest in makes it a pure lookup. ~8 of 13 lines. |
| `crew/factoryctl.mjs:342-358` | `verb` | 4 verbs tested twice | validation at `342-345`, execution at `355-358`. A `{verb: {require, run}}` map kills the double test. ~6 lines. |
| `crew/seat-io.mjs:977-988` | `err.stage` / tail | 6 | `cellFailureKind`. ~5 lines. |

Adjacent, below the bar but worth recording: `crew/drive.mjs:1254-1264`
(`validateScopeEntries`) and `crew/daemon.mjs:56-66` (`scopeEntryDefects`) are
character-identical 5-arm mirrors. The duplication is deliberate (firewall,
comment at `crew/daemon.mjs:50-52` — whose own citation is stale, see F13) and
pinned by `daemon.test.mjs`. Turning both into a `[{test, why}]` data literal
would not cross the firewall and would make the mirror a *data* comparison,
which a pinning test can enforce far more cheaply than a code comparison.

---

## 4. Appendix — the 49 gratuitous exports

`export` keyword with zero consumers anywhere (no module, no test, no doc); the
definitions are live inside their own file. Dropping `export` removes no code.

**`crew/crew.mjs` (16)** — `HEADLESS_TRANSPORT:51`, `HEADLESS_RPC_TRANSPORT:51`,
`CAPABILITY_DELIVERY:69`, `effectiveCapabilities:69`, `refuse:69`, `hostLoad:71`,
`loadPolicy:71`, `assertHostQuiet:71`, `advisorBootRecord:198`,
`assertAdvisorCellLive:224`, `seatShortfalls:518`, `SHADOW_PICK_SCHEMA:867`,
`SHADOW_RATE_FLOOR:868`, `memoryExtracts:1266`, `READY_CHROME:1906`, `slug:281`.

**`crew/seat-io.mjs` (15)** — `REASK_MAX:37`, `REASK_TIMEOUT_S:38`,
`DESCENDANT_PS_TIMEOUT_MS:48`, `DESCENDANT_SETTLE_MS:49`,
`DESCENDANT_SETTLE_POLLS:50`, `RESEAT_LADDER:837`, `modelStringFor:849`,
`docOpenArgs:938`, `phaseForStage:958`, `PANE_SAMPLE_LINES:1222`,
`PANE_SAMPLE_TIMEOUT_MS:1223`, `normaliseScreenText:1226`, `paneSampleRow:1252`,
`reaskBrief:1365`, `colorNeutralEnv:1459`.
(`docOpenArgs` and `phaseForStage` are reachable via `crew.mjs:51`'s
pass-through, which `crew/crew.test.mjs:10` imports — their *seat-io* export is
redundant with that, not unreachable.)

**`crew/drive.mjs` (6)** — `GATE_REAP_OUTCOMES:327`, `GATE_REAP_LAUNCH_EOF:329`,
`GATE_REAP_SHELL:339`, `SCOPE_DIR_MIN_SEGMENTS:1249` *(has a documented operator
consumer — do not remove)*, `DIRECTED_BLOCK:1274`, `DIRECTED_KEYS:1275`.

**`crew/headless-rpc.mjs` (5)** — `WAIT_POLL_MS:19`, `EXIT_MARKER_WINDOW_MS:31`,
`EXIT_MARKER_POLL_MS:32`, `TERM_REPEAT_MS:33`, `SEAT_COMMAND_FILE:47`.

**`crew/factoryctl.mjs` (5)** — `DEFAULT_TIMEOUT_MS:10`, `socketPathFor:24`,
`sendVerb:236`, `lsVerb:247`.

**`crew/headless.mjs` (1)** — `WAIT_POLL_MS:19`.
**`crew/daemon.mjs` (1)** — `SETTLED_FEED_RETENTION:115`.
**`crew/child.mjs` (1)** — `VALIDATION_LANE_REFUSAL:63` (duplicates
`crew/crew.mjs:416`).

`crew/converge.mjs`, `crew/capabilities.mjs` and `crew/reclaim.mjs` have **zero**
dead or gratuitous exports — the three cleanest modules of the eleven.

---

## 5. What is already right (checked, do not "fix")

Recorded so a later pass does not re-open them:

- **`resolveValidationLane`** — byte-identical in `crew/crew.mjs:418` and
  `crew/child.mjs:65`, deliberate under the firewall, and **pinned against one
  shared table** at `crew/crew.test.mjs:1032`. The standard for every other
  duplicate here.
- **`PANE_TRANSPORT` / `DEFAULT_TRANSPORT`** — duplicate literal `'pane'`
  (`crew/daemon.mjs:330`, `crew/seat-io.mjs:23`) with a real cross-pin at
  `crew/daemon.test.mjs:508`.
- **`PROTECTED_PATHS`** — single owner `crew/protected-paths.mjs:8`, re-exported
  at `crew/drive.mjs:135`, and guarded by a *source-grep tripwire*
  (`crew/drive.test.mjs:910-912` asserts `drive.mjs` contains no
  `export const PROTECTED_PATHS` **and** that the two objects are identical).
  The strongest pin in the repo.
- **`VARIANTS` / `VARIANT_NAMES` / `DEFAULT_VARIANT`, `LIVENESS` / `PHASES` /
  `VERDICTS` / `EVIDENCE_KINDS`, `LIMITS` vs `*_ROUNDS_MAX`** — all single-owner
  and correctly imported. `LIMITS` and `*_ROUNDS_MAX` look like a duplicated
  triple but are default-vs-ceiling, documented at `crew/limits.mjs:8-9`.
- **`MODIFIER_OUTCOMES`** ↔ ledger's copy — cross-pinned at
  `test/factory-ledger.test.mjs:857`.
- **`pathExists`** (`crew/capabilities.mjs:153`) and **`slug`**
  (`crew/slug.mjs:13`) — single definition, correctly reused, no copies.
- **`assign` / `wait`** in `headless.mjs` and `headless-rpc.mjs` — the
  intentional shared transport interface, not a duplicate.
- **`text`** — `crew/converge.mjs:18` returns a string, `crew/drive.mjs:645`
  returns a boolean, and `drive.mjs:1` imports six symbols from `converge.mjs`.
  **[corrected]** A scout ranked this first; it cannot cause a defect — both are
  module-private and `text` is not among the six imported. A readability wart,
  not a finding.

---

## 6. Suggested order of work

1. **F2** — one line in one test. Unblocks `#522` and is the only finding whose
   absence has a dated, scheduled consequence.
2. **F13** — comments only, zero behaviour risk, 13 corrections.
3. **F11** — delete one dead line.
4. **F1, F3, F4** — the three real correctness drifts. Each needs a leaf module;
   none may be fixed with an import into `daemon.mjs` or `child.mjs`.
5. **F14, F9, F10** — narrow behavioural fixes with obvious tests.
6. **F15** — the one clean table conversion, well covered by existing tests.
7. Everything else is hygiene; **F16** should not be attempted as one change.
