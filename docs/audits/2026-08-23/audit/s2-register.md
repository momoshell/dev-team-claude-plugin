# s2-factory — horizontal inspection of the factory scripts and the visualizer server

Read-only recon. Nothing in the checkout was created, edited or deleted;
`git status --porcelain` is empty at return.

Scope: `scripts/factory/{ledger,emit,intake,make-brief,probe-repo,ci-watch,ci-repair}.mjs`
plus `visualizer/server/*.mjs` — 16 files, 15,218 lines.

---

## Read coverage

| File | Lines | Coverage |
|---|---|---|
| `scripts/factory/ledger.mjs` | 4322 | **Structurally mapped in full** (every top-level and every `openLedger`-inner definition enumerated mechanically); ~900 lines read verbatim (constants, DDL, writers 1425–2030, readers 2426–2942, CLI 3865–4210) |
| `scripts/factory/emit.mjs` | 1639 | Sampled — header, CLI tail, cited anchors, helper bodies |
| `scripts/factory/intake.mjs` | 1870 | Sampled — config block, sweep/dispatch path 975–1000, helper tail 1520–1710 |
| `scripts/factory/make-brief.mjs` | 1582 | Sampled — `proposeTier` 1083–1110, refusal vocabulary, CLI parse |
| `scripts/factory/probe-repo.mjs` | 1427 | Sampled — profile refusal paths, protected-path block |
| `scripts/factory/ci-watch.mjs` | 593 | Sampled — profile refusal mapping 24–95, deps, entry-point check |
| `scripts/factory/ci-repair.mjs` | 641 | Sampled — constants 20–50, brief compile 176–260, entry-point check |
| `visualizer/server/shape.mjs` | 1143 | Read in full |
| `visualizer/server/ledger-feed.mjs` | 387 | Read in full |
| `visualizer/server/server.mjs` | 439 | Read in full |
| `visualizer/server/{roster-edit,roster-ladder,roster-source,returns-source,triage,feed}.mjs` | 1165 | Read in full |

Method: four parallel read-only scouts with disjoint lenses (duplicated helpers /
refusal shapes and enums / dead exports / visualizer re-derivation), plus direct
mechanical analysis of `ledger.mjs`. **Every claim below was re-derived independently
before inclusion.** Two scout claims did not survive that check and are corrected in
place (F4 note, F15 note).

---

# Ranked findings register

Ranked by behaviour risk, then lines removed.

---

## F1 · The entire CI loop — 1,234 lines — has no production entry point
**Category:** dead module · **Behaviour risk: HIGHEST**

`scripts/factory/ci-repair.mjs` (641 lines) and `scripts/factory/ci-watch.mjs`
(593 lines) cannot be reached from anywhere in production:

- **Neither has a CLI guard.** Every other factory module ends with one;
  these two do not:
  ```
  ci-watch     invokedDirectly occurrences: 0
  ci-repair    invokedDirectly occurrences: 0
  intake  2 · emit  4 · make-brief  3 · probe-repo  2 · ledger  3
  ```
  `ci-repair.mjs` has no `main` at all — the file ends mid-helper at
  `:641` with `return finish(cycles, dispatches, null, 'cycle-bound-reached', false)`.
- **Nothing imports them but each other and tests.** The only importer of
  `ci-repair.mjs` repo-wide is `test/factory-ci-repair.test.mjs:17`. The only importer
  of `ci-watch.mjs` is `scripts/factory/ci-repair.mjs:19` (`{ ciShape, ciWatchRun }`)
  — i.e. into the orphan.
- **No `package.json` script runs either.** `package.json:9-19` lists eight
  `ledger:*` recipes and three `viz:*` recipes; no `ci:*` recipe exists.

So `ci-watch.mjs`'s only two production-facing exports feed exclusively into a module
nothing can invoke. All 12 of `ci-repair.mjs`'s exports are reachable only from its
own test.

**This is invisible to the reader** because `crew/crew.mjs` is written as though the
loop were live, and — unusually for this codebase (F9) — those two anchors are
*accurate*:
- `crew/crew.mjs:375` — *"Mirror `scripts/factory/ci-repair.mjs:108-110`: prefer
  `files_in_scope` whenever the key is present"* → `ci-repair.mjs:108-110` is exactly that.
- `crew/crew.mjs:410` — *"a bare `--lane` keeps working because
  `scripts/factory/ci-repair.mjs:270` dispatches a repair run that way"* →
  `ci-repair.mjs:270` is `'--lane', laneValue,`.

A live constraint in `crew/crew.mjs` is being justified by the behaviour of a module
that never runs.

**Simplification:** decide the intent, then either give `ci-watch.mjs` the
`main` + `invokedDirectly` guard its siblings have and add a `ci:*` recipe, or retire
both files and drop the two `crew/crew.mjs` justifications. **Do not "clean up" by
deleting silently** — `test/factory-ci-repair.test.mjs` and
`test/factory-ci-watch.test.mjs` are substantial suites pinning real behaviour, and
the brief places test edits out of scope.
**Pinning test:** the behaviour is heavily pinned; the *reachability* is pinned by
nothing.
**Cost:** decision first; 2 files either way.

---

## F2 · Intake's protected-path guard runs against an empty floor — the refusal is unreachable
**Category:** divergent policy for one guard · **Behaviour risk: HIGH**

`proposeTier` defaults to the 12-entry authored floor, but intake explicitly
overrides it with a frozen empty array, so `protectedHits` is always `[]`.

- `scripts/factory/make-brief.mjs:1083` — `export function proposeTier({ where, discovery, protectedPaths = DEFAULT_PROTECTED_PATHS, ... })`
- `scripts/factory/make-brief.mjs:1543-1544` — the CLI path passes the real floor.
- `scripts/factory/intake.mjs:56` — `protectedPaths: Object.freeze([]),`
- `scripts/factory/intake.mjs:983` — `protectedPaths: Array.isArray(settings.protectedPaths) ? settings.protectedPaths : [],`
- Dead consequence 1: `scripts/factory/intake.mjs:994-996` — the `protected-path`
  refusal branch can never fire.
- Dead consequence 2: the protected-hit → judge escalation (`make-brief.mjs:84`
  `JUDGE_PROTECTED_FLOOR`) never fires at sweep time.
- Floor owner: `crew/protected-paths.mjs:8-13` (12 entries incl. `.github/workflows/`,
  `docs/adr/`, `crew/drive.mjs`).

Verified: those two lines are the only `protectedPaths` assignments in all of
`scripts/`, `crew/` and `visualizer/`; the sole other occurrence repo-wide is
`test/factory-intake.test.mjs:230`. Introduced whole at `7967273` (2026-08-17). Crew
boot *is* floored (`crew/crew.mjs:1795`, `crew/child.mjs:263`), so this fails safe
downstream at plan-accept — but not at intake, which is where it was meant to bite.
Directly checkable: a brief compiled through the CLI path states `protected paths in
force: 14`; the same compile through intake would state `protected paths in force: 0
· authored floor (no profile basis supplied)` (`make-brief.mjs:1086`).

**Simplification:** delete the `protectedPaths` key from `DEFAULT_INTAKE_CONFIG` and
stop passing it, letting `proposeTier` use its own default.
**Pinning test:** none asserts a non-empty intake floor.
**Cost:** 2 files.

---

## F3 · The visualizer still emits a cause the ledger deleted as false (#433)
**Category:** fix applied to one of two emission sites · **Behaviour risk: HIGH**

- `scripts/factory/ledger.mjs:300-306` — *"telling such a run it 'predates per-agent
  token measurement (#119)' is a **false cause** (#433) … **Exported so both emission
  sites draw one wording from one place.**"*
- `scripts/factory/ledger.mjs:315-322` — `usageAbsentCause(transports)`, the
  replacement; used by the CLI at `ledger.mjs:3898`.
- `visualizer/server/shape.mjs:777` — still emits the deleted wording verbatim:
  `? 'no agent_sessions rows for any run in this window — predates per-agent token measurement (#119), not a measured zero'`

Verified by grepping the literal repo-wide: exactly two hits — the ledger comment
saying it is false, and the visualizer still saying it. The comment claims both
emission sites draw from one place; only one does.

**Simplification:** `shapeRunSet` takes the run's transports (the feed can already
call `transportsFor`) and calls `usageAbsentCause`.
**Pinning test:** `usageAbsentCause` is pinned in `test/factory-ledger.test.mjs`; the
visualizer wording by nothing.
**Cost:** 2 files.

---

## F4 · `/api/cell-health` and `/api/roster/ladder` answer different failure counts for one cell in one process
**Category:** copied query, one column dropped · **Behaviour risk: HIGH**

- `scripts/factory/ledger.mjs:2561-2570` — `cellFailures` selects `run_less` **and**
  `host_attributed`:
  `SUM(CASE WHEN attribution = 'host' AND adw_id IS NOT NULL THEN 1 ELSE 0 END) AS host_attributed`
- `visualizer/server/ledger-feed.mjs:124-132` — the same query, copied, **without that
  column**.
- `crew/breaker.mjs:181-187` — reads the ledger's version and subtracts it:
  `const counted = failures - runLess - hostAttributed`
- `visualizer/server/shape.mjs:1125` — reads the feed's version and cannot:
  `in_run: undetermined ? null : failures - run_less,`
- Both are served from one process: `visualizer/server/server.mjs:359` (cell-health,
  via the feed) and `:375` (ladder → breaker → `openLedger.cellFailures`).

**Simplification:** add `host_attributed` to the feed's SELECT and subtract it in
`shape.mjs:1125` — or let the feed delegate to `openLedger.cellFailures` (F7), which
makes it automatic.
**Pinning test:** `test/factory-ledger.test.mjs:872-880` pins `host_attributed` on the
ledger side only; nothing pins the two views equal.
**Cost:** 2 files.

*Note: the scout also claimed the two disagree on run-less handling; only the
`host_attributed` half survives verification and is what is reported here.*

---

## F5 · Same profile situation, three different reasons and three different control-flow shapes
**Category:** refusal shape divergence · **Behaviour risk: MEDIUM-HIGH**

**(a) "no profile file" has two names.**
`scripts/factory/ci-watch.mjs:94-95` says `reason: 'profile-missing'`;
`scripts/factory/make-brief.mjs:683` returns `reason: PROFILE_UNREADABLE` for the same
absence and `:690` refuses with it. `PROFILE_REFUSALS` (`ci-watch.mjs:29-34`) carries
both names; make-brief's `REFUSAL_REASONS` (`:114-132`) carries only
`profile-unreadable` and collapses absence into unreadability.

**(b) `profile-ratification-refused` is silently re-labelled.** Thrown at
`probe-repo.mjs:1022-1023`, handled correctly at `make-brief.mjs:723`, and at
`ci-watch.mjs:48-53` — because `PROFILE_REFUSALS` omits it — it falls through to
`'profile-field-unknown'`, the true reason surviving only in `detail`. A
ratified-but-commit-scoped field is reported as an *unknown field*: the wrong
operator action.

**(c) One concept, four field sets.** Throw path carries `{name, reason, message}`
(`probe-repo.mjs:1014-1034`); `ci-watch.mjs:36-38` returns
`{ok, reason, field, detail, message, profilePath}`; `make-brief.mjs:710` returns
`{used, value, basis, reason}`; `probe-repo.mjs:1059` returns
`{paths, used, reason, basis}`. No shared renderer or log filter is possible.
`probe-repo.mjs:1416` already catches two classes for one situation:
`if (err instanceof ProbeUsageError || err instanceof ProfileRefusal)`.

**Simplification:** one exported `PROFILE_REFUSALS` owned by `probe-repo.mjs` (owner
of `ProfileRefusal`), imported by both consumers, plus one
`profileRefusal({reason, field, detail, path})` record factory.
**Pinning test:** `test/factory-ci-watch.test.mjs:439-440` and
`test/factory-make-brief.test.mjs:1176-1177` pin each side separately; nothing pins
them equal.
**Cost:** 3 files.

---

## F6 · `server.mjs`'s direct-invocation guard uses `resolve()` where every sibling uses `realpath` — the documented symlink bug
**Category:** duplicated idiom, one copy wrong · **Behaviour risk: MEDIUM**

`scripts/factory/ledger.mjs:1002-1006` documents exactly why:
> *"realpath both sides: the ESM loader realpaths `import.meta.url` while `argv[1]`
> stays literal, so under a symlinked path component (macOS TMPDIR is
> `/var -> /private/var` …) a literal compare is silently false and the CLI would
> no-op."*

- Correct: `ledger.mjs:1007-1013` + `:4316`, `emit.mjs:1626-1632` + `:1634`,
  `intake.mjs:1861-1863`, `make-brief.mjs:1575-1577`, `probe-repo.mjs:174-176`,
  `ci-watch.mjs:221-223` (renamed `realPathOr`, dep-injected, different fallback).
- Wrong: `visualizer/server/server.mjs:419` —
  `const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))`

Under a symlinked path component `npm run viz:serve` silently no-ops instead of
starting the server.

**Simplification:** one `realpathOr` + `isMain(importMetaUrl)` in a shared leaf; six
copies and one latent bug go.
**Pinning test:** none — no test invokes the server through a symlinked path.
**Cost:** 7 files (or 1 file for the bug alone).

---

## F7 · The visualizer re-writes four ledger queries as raw SQL and opens the database by a second door
**Category:** visualizer re-derives what the ledger already answers · **Behaviour risk: MEDIUM** · **~70 lines**

| Feed's raw SQL | Ledger method |
|---|---|
| `visualizer/server/ledger-feed.mjs:124-132` | `scripts/factory/ledger.mjs:2558-2571` `cellFailures` |
| `visualizer/server/ledger-feed.mjs:317-330` | `scripts/factory/ledger.mjs:2749-2765` `runSet` |
| `visualizer/server/ledger-feed.mjs:224-231` | `scripts/factory/ledger.mjs:2651-2660` `intakeSweeps` |
| `visualizer/server/ledger-feed.mjs:260-267` | `scripts/factory/ledger.mjs:2662-2671` `intakeRefusals` |

`ledger-feed.mjs:319` says *"Keep this in lockstep with
scripts/factory/ledger.mjs:1575-1585"* and the body is byte-identical to
`ledger.mjs:2754-2756`. That citation is itself rotten: `:1575` is inside
`startPhase`; `runSet` is at `:2749` (F9).

**Three doors onto one database file, with different schema assumptions:**

| Door | Site | Mode | Assumption |
|---|---|---|---|
| raw `DatabaseSync` | `ledger-feed.mjs:33-35` | `{ readOnly: true }` | none — probes at runtime (`:43-54`), treats nine tables as optionally absent (`:9`) |
| `openLedger` | `server.mjs:112-113` (`recordBrake`) | read-write | runs `applyMigrations`, creates the dir, chmods |
| `openLedger` | `crew/breaker.mjs:141` via `server.mjs:375,390` | read-write | same |

They disagree: `ledger.mjs:1338-1341` **creates** on open what the read path is busy
declaring *"predates this ledger mirror"*. Because `probe.latched`
(`ledger-feed.mjs:52`) only latches when nothing is missing, a probe that ran before
the first `POST /api/intake/brake` keeps re-probing, and the two views can flip
mid-session. Separately, the startup banner claims `readonly_reads: true`
(`server.mjs:414`) while the brake path can create the database file, its directory
and its WAL.

`triage.mjs:10,18-21` is the clean counter-example: a deliberately separate sidecar
(`visualizer.db`), documented at `triage.mjs:1-3`, with `run_triage` correctly absent
from `ledger.mjs`'s `TABLES`.

**Simplification:** add a read-only mode to `openLedger` (it has none —
`ledger.mjs:1317` always opens writable) and route all three doors through it. That
one addition also unlocks F4 and F8.
**Pinning test:** both sides tested independently
(`test/factory-ledger.test.mjs:872-880` vs `test/visualizer-server.test.mjs:285`);
nothing asserts them equal. `test/visualizer-shape.test.mjs:742-751` guards only that
`node:sqlite` stays inside `ledger-feed.mjs`/`triage.mjs` — it does not catch
`openLedger`, which reaches sqlite transitively from `server.mjs:13`.
**Cost:** 3 files.

---

## F8 · Nine ledger readers are one SQL template written nine times
**Category:** queries re-implementing each other · **Behaviour risk: LOW** · **~85 → ~25 lines**

Eight are provably identical after normalising only the table name and the
group-column list — machine-checked, all eight collapse to one string:

```
    return queryRows(`
      SELECT <COLS>
        COUNT(*) AS count, MIN(created_at) AS first_at, MAX(created_at) AS last_at
      FROM <T>
      WHERE (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?)
      GROUP BY <COLS>
      ORDER BY <COLS>
    `, [since, since, until, until])
```

`ciCycles` `:2629-2638` · `ciDispatches` `:2640-2649` · `intakeSweeps` `:2651-2660` ·
`intakeRefusals` `:2662-2671` · `intakeBrakes` `:2673-2682` ·
`intakeDispatches` `:2684-2693` · `seatTeardowns` `:2710-2719` ·
`seatReclaims` `:2721-2730` — 80 lines, and `GROUP BY` equals `ORDER BY` in all
eight. `modifierAttempts` `:2613-2627` is the same template with a wrapped column list.

**Simplification:** one `windowTally(table, groupCols, {since, until})` over the
existing `queryRows`; the nine become nine one-liners.
**Pinning test:** none names these methods — they are reached only through CLI verbs
(`test/factory-ledger.test.mjs:2327` iterates the verb names), so the refactor is free.
**Cost:** 1 file.

---

## F9 · Comment anchors have rotted wholesale: 75 `file:line` citations, 34 of the 40 checked are wrong, 3 name deleted modules
**Category:** inconsistent with itself · **Behaviour risk: LOW as documentation — but it is the mechanism behind F3, F4 and F7**

The 16 scope files carry **75** `file:line` citations. I hand-verified 40; **34 are
stale**. Three name modules that no longer exist anywhere in the repo:

| Citing site | Cites | Status |
|---|---|---|
| `scripts/factory/ledger.mjs:1005` | `scripts/task-cost-log.mjs:284-296` | **file deleted** |
| `scripts/factory/ledger.mjs:3699` | `task-cost-log.mjs` | **file deleted** |
| `scripts/factory/emit.mjs:1204` | `ladder.mjs:719` ("Mirrors … exactly — one shared enum") | **file deleted** |
| `scripts/factory/emit.mjs:1461` | `gates.mjs:689-694` | **file deleted** |

Ten land on a blank line or a bare closing brace — wrong with no judgement required:
`ledger.mjs:1440`→`emit.mjs:936` (blank), `intake.mjs:1571`→`ledger.mjs:1089` (`}`),
`intake.mjs:1618`→`make-brief.mjs:1229` (`}`),
`intake.mjs:1672`→`test/factory-intake.test.mjs:847` (`})`),
`make-brief.mjs:139`→`crew/drive.mjs:902` (`}`),
`make-brief.mjs:861`→`crew/drive.mjs:997` (blank),
`probe-repo.mjs:464`→`make-brief.mjs:528` (`}`).

The rest point at unrelated code. Verified pairs, with the true target:

| Citing site | Claims | Cited line actually is | True location |
|---|---|---|---|
| `ledger.mjs:257` | `crew/drive.mjs` `MODIFIER_OUTCOMES` | `// Measured seconds: 1459 / 1800.` | `crew/drive.mjs:287` |
| `ledger.mjs:326` | cell_failures' own columns `(:1575-1580)` | inside `startPhase` | `ledger.mjs:546` |
| `ledger.mjs:372`, `emit.mjs:659` | the boot record `crew/crew.mjs:831` writes | `let definition` | `crew/crew.mjs:313` / `:1657` |
| `ledger.mjs:2746` | `crew/daemon.mjs:105` budget-window delimiter | `return mod.capabilitiesFor(...)` | — |
| `ledger.mjs:2748`, `:2853` | `endAgentSession` overwrites `(:1129)` | a bare `}` | `ledger.mjs:2318` |
| `ledger.mjs:3397` | `isoMs()` `(:394)` | `{ name: 'adw_id', … }` | `ledger.mjs:955` |
| `ledger.mjs:3873` | the `task` verb's degraded refusal `(:1839)` | inside `recordCiCycle` | `ledger.mjs:4206` |
| `emit.mjs:22` | `nextSeq` seq allocator `(ledger.mjs:624-643)` | a TABLES column decl | `ledger.mjs:1380` |
| `emit.mjs:37` | `id` `(ledger.mjs:1131)` | `DRIFT_INTEGER_LITERAL` | — |
| `emit.mjs:38` | `dumpTable` natural-key order `(ledger.mjs:1148)` | a drift comment | `ledger.mjs:2509` |
| `emit.mjs:1337` | `BOOLEAN_FLAGS`/`parseArgs` `(ledger.mjs:1479)` | `args.adw_id === undefined …` | `:3332` / `:3376` |
| `intake.mjs:795` | `crew/crew.mjs:634` prints `crew_json` | `'ladder-unreadable'` | `crew/crew.mjs:1657` |
| `intake.mjs:1600` | the ledger's own actor bound `(ledger.mjs:1728)` | `const args = redact({` | `ledger.mjs:2015` |
| `intake.mjs:1689` | `INTAKE_REFUSALS (ledger.mjs:149)` | `ADVISOR_AB_INCOMPLETE_REASONS` members | `ledger.mjs:171` |
| `ledger-feed.mjs:319` | `runSet` `(ledger.mjs:1575-1585)` | inside `startPhase` | `ledger.mjs:2749` |
| `ledger-feed.mjs:349` | daemon burn query `(crew/daemon.mjs:234-243)` | `isObject` | `crew/daemon.mjs:275-283` |
| `shape.mjs:14` | `SEAT_TEARDOWN_OUTCOMES` `(ledger.mjs:134)` | a comment line | `ledger.mjs:137` |
| `shape.mjs:151` | `ledger-feed.mjs:76` | off by one | `ledger-feed.mjs:77` |
| (adjacent) `crew/daemon.mjs:127` | `NODE_FLOOR` `(ledger.mjs:78)` | — | `ledger.mjs:114` |

This matters beyond tidiness: **every deliberate copy in this codebase documents its
source by line number, and the "keep in lockstep" instruction is the only thing
holding the copies together.** All four such instructions now point at the wrong
place — which is exactly how F4 (dropped column) and F3 (fix applied to one of two
sites) happened. The counter-example that proves the point is F1: the two
`crew/crew.mjs` anchors into `ci-repair.mjs` are still accurate, and they are the only
reason that dead module still looks alive.

**Simplification:** cite the symbol name, never the line. Line numbers cannot be kept
true by review and no test checks them.
**Cost:** 8 files, comments only.

---

## F10 · Refusal classes: two lack `this.name`, and two call sites depend on it
**Category:** refusal shape divergence · **Behaviour risk: MEDIUM** · **~50 lines**

| Class | Site | Fields | Default reason |
|---|---|---|---|
| `LedgerUsageError` | `ledger.mjs:916` | `reason` — **no `name`** | `'usage'` |
| `EmitUsageError` | `emit.mjs:1325` | `reason` — **no `name`** | `'usage'` |
| `IntakeUsageError` | `intake.mjs:1585` | `name`, `reason` | *none* |
| `ProbeUsageError` | `probe-repo.mjs:162` | `name`, `reason` | `'usage'` |
| `ProfileRefusal` | `probe-repo.mjs:154` | `name`, `reason` | `'profile-unratified'` |
| `BriefUsageError` | `make-brief.mjs:284` | `name`, `reason` | `MISSING_LINE` |
| `ServerUsageError` | `server.mjs:33` | `name`, **`usage: true`, no `reason`** | — |

Two modules use a name-string fallback for cross-realm robustness —
`scripts/factory/intake.mjs:1200` and `scripts/factory/ci-repair.mjs:207`, both
`if (err instanceof BriefUsageError || err?.name === 'BriefUsageError')`. That
fallback silently cannot work for `LedgerUsageError` or `EmitUsageError`, whose
`err.name` is `'Error'`.

`ServerUsageError` is the only one carrying a boolean flag instead of a reason, so
`server.mjs:430-432` can print a message but never a machine-readable reason — unlike
every `scripts/factory` CLI, which prints `[reason: ${err.reason}]`
(`make-brief.mjs:1567`).

The five `refuse` helpers differ in ways that change output:
```
ledger.mjs:923      refuse(message, reason = 'usage')          → `ledger: …`
emit.mjs:1332       refuseUsage(message, reason = 'usage')     → `emit: …`
probe-repo.mjs:170  refuseUsage(message, reason = 'usage')     → `probe-repo: …`
make-brief.mjs:292  refuseUsage(message, reason = MISSING_LINE)→ `brief: …`
intake.mjs:1593     refuseUsage(message, reason)               → `intake: …`
```
An unlabelled `refuseUsage('…')` in make-brief reports `missing-line` (a *content*
reason) where every sibling reports `usage`; in intake it reports `undefined`.

**Simplification:** one `UsageError` base `{name, reason}` plus a
`makeRefuser(prefix, Class, defaultReason)`; the five `main()` catch blocks
(`ledger.mjs:4305-4312`, `emit.mjs:1612-1619`, `intake.mjs:1848-1855`,
`make-brief.mjs:1565-1572`, `probe-repo.mjs:1415-1422` — byte-identical but for the
class name) collapse into one `runCli(fn, argv)`.
**Cost:** 6 files.

---

## F11 · Dead exports: 4 referenced nowhere at all, 49 dead, and 55% of the export surface is a test seam
**Category:** dead export · **Behaviour risk: LOW**

Classification was built from the **real import graph** — every
`import {…} from '<relative path>'` in all 105 `.mjs`, 9 `.js`, 3 `.ts` and 21
`.svelte` files, resolved to absolute paths — not from name-greps, which produce false
LIVEs for `main`, `normalDeps`, `runner`, `LADDER_PATH`, `REFUSAL_REASONS`,
`ROLE_ORDER`, `SEAT_TEARDOWN_OUTCOMES`, `UNKNOWN_REASONS`, `NODE_FLOOR` and
`PROPOSAL_BLOCK`, all of which have independent redeclarations elsewhere. Cross-checks:
only 4 `export … from` re-exports repo-wide (none targeting these modules); 9
namespace imports, all in tests; 10 dynamic `await import()` sites, all in tests —
one of which corrected a result (`STOP_SWITCH_PATH` is TEST-ONLY, not dead, via
`test/visualizer-server.test.mjs:1332`); zero bracket/string property access.

| | count |
|---|---|
| LIVE | 59 |
| TEST-ONLY | 132 |
| DEAD (self-only or wholly unreferenced) | 49 |

**Referenced nowhere at all, including inside their own module (4).** Each grep is
`grep -rnw --include='*.mjs' --include='*.js' <SYM> .` with `node_modules` excluded;
the first three return exactly one line — their own declaration:

```
$ grep -rnw DISPATCH_OUTCOMES .
./scripts/factory/ci-repair.mjs:26:export const DISPATCH_OUTCOMES = Object.freeze(['done', 'escalation', 'converge', 'refused', 'unreadable'])

$ grep -rnw PUSH_REFUSALS .
./scripts/factory/ci-watch.mjs:28:export const PUSH_REFUSALS = Object.freeze(['worker-path', 'checkout-missing', 'branch-unresolved', 'push-failed'])

$ grep -rnw LADDER_CHECKS .
./visualizer/server/roster-ladder.mjs:10:export const LADDER_CHECKS = Object.freeze(['band_floor', 'vendor_diversity', 'breaker_state', 'cost_ceiling'])

$ grep -rnw REFUSAL_REASONS .
./scripts/factory/make-brief.mjs:114:export const REFUSAL_REASONS = Object.freeze([
./scripts/factory/ci-repair.mjs:27:export const REFUSAL_REASONS = Object.freeze([
./test/factory-make-brief.test.mjs:16,549,1171-1178      ← all against make-brief's copy
```
(ci-repair's `REFUSAL_REASONS` has zero references; the test imports make-brief's.)
`ci-repair.mjs:26` is additionally an exact duplicate of `ledger.mjs:166`
`CI_DISPATCH_OUTCOMES` in a file that already imports from `./ledger.mjs` at `:20`.

**Modules with no non-test importer at all.** The complete non-test import surface of
all 16 files fits in one screen; these three appear in it zero times:
`scripts/factory/intake.mjs` (CLI-only — all 31 exports test-facing or self-only),
`visualizer/server/server.mjs` (CLI-only — 4 of 7 exports pure self-use), and
`scripts/factory/ci-repair.mjs` (**not even CLI-reachable** — F1).

**`ledger.mjs` carries 15 dead exports**, mostly frozen enum vocabularies consumed
only by its own `requireEnum`: `LEDGER_VERSION`, `REQUEST_SOURCES`, `PHASE_STATUSES`,
`PROCESS_STATES`, `ADVISOR_AB_VERDICTS`, `ADVISOR_AB_DISPATCH_FLOOR`,
`ACCEPT_DECISION_OUTCOMES`, `CI_DISPATCH_OUTCOMES`, `INTAKE_BRAKE_TRANSITIONS`,
`INTAKE_BRAKE_OUTCOMES`, `RETIRED_TABLES`, `defaultDbPath`, `advisorAbNotes`,
`advisorAbReadout`, `main`. Example:
```
$ grep -rnw PHASE_STATUSES .
./scripts/factory/ledger.mjs:129:export const PHASE_STATUSES = Object.freeze(['running', 'ok', 'fail', 'skipped'])
./scripts/factory/ledger.mjs:1584:    requireEnum(input.status, PHASE_STATUSES, 'endPhase', 'status')
./.claude/dev-team/tasks/issue-41/be-41-01.spec.json:44   (historical prose)
```

**Retained by design — do not remove.** `ledger.mjs:126-127` documents two dead
surfaces itself: `envelopes` (*"never wired since the legacy runtime was retired
(81dee7c, 0.2.0)"*) and `processes` (*"`startProcess` has no caller outside
`scripts/factory/ledger.mjs` itself and its own tests (#405)"*). Confirmed —
`grep -rn 'startProcess\|recordEnvelope' --include='*.mjs' .` minus `ledger.mjs` and
`*.test.mjs` returns nothing. Both are kept because the schema fence is additive-only
and `replayJsonl` depends on the closed `WRITERS` set. This is correct.

**132 of 240 exports (55%) exist solely so tests can reach them** — the `export`
keyword on those is a test seam, not an API. Removing any of them is a test edit,
which the brief places out of scope.

**Simplification:** delete the four zero-reference constants; leave the
retained-by-design pair alone; treat the 15 ledger enum exports as a separate
question that F1 and the split (below) should settle first.
**Cost:** 3 files for the safe subset.

---

## F12 · `mkdirpBounded` exists to prevent an unbounded main-thread spin, and five call sites bypass it
**Category:** duplicated helper, hazard documented then ignored · **Behaviour risk: MEDIUM** · **0 net lines**

`scripts/factory/ledger.mjs:81-87`:
> *"`fs.mkdirSync` with recursive directory creation is NOT bounded: on a filesystem
> that answers ENOENT to mkdir for a path whose parent exists (Linux procfs does
> exactly this), Node walks up … forever, spinning a CPU, on the main thread, where
> no timer or `--test-timeout` can interrupt it."*

- Uses it: `ledger.mjs:1282`, `emit.mjs:178` (imported at `emit.mjs:93`).
- Bypasses it: `probe-repo.mjs:1357`, `intake.mjs:1195`, `ci-repair.mjs:202`,
  `ci-repair.mjs:406`, `server.mjs:314` — all `mkdirSync(…, { recursive: true })`.

**Simplification:** route the five through `mkdirpBounded`; zero net lines, one
documented hazard removed.
**Cost:** 4 files.

---

## F13 · `ROLE_ORDER` exported three times, and two visualizer tests import different symbols under one name
**Category:** enum declared twice · **Behaviour risk: MEDIUM**

- `crew/crew.mjs:135` — `['lead', 'planner', 'builder', 'reviewer', 'tech-lead']` (5, seating order)
- `visualizer/server/shape.mjs:4` — `['planner', 'builder', 'reviewer', 'tech-lead', 'lead', 'driver']` (6, lane order)
- `visualizer/web/src/lib/trace.js:3` — byte-identical to `shape.mjs:4`

`test/visualizer-roster-edit.test.mjs:8` imports `ROLE_ORDER` **from `crew/crew.mjs`**
while `test/visualizer-shape.test.mjs:7` imports it **from `shape.mjs`** — two
different arrays, one name, both in visualizer tests. And `shape.mjs:51` does
arithmetic on the length: `lanes.set(key, 6 + (n % (PALETTE_SIZE - ROLE_ORDER.length)))`
with `PALETTE_SIZE = 8` (`shape.mjs:3`), so substituting crew's 5-member list silently
changes the modulus from 2 to 3.

**Simplification:** rename crew's to `SEAT_ORDER`; have `trace.js` import shape's —
they are byte-identical.
**Pinning test:** `test/visualizer-shape.test.mjs:252` and
`test/visualizer-panels.test.mjs:755` pin each to the same literal independently, so
drift is caught but the duplication is not removed.
**Cost:** 3 files.

---

## F14 · Enums declared twice: the complete list
**Category:** enum declared twice · **Behaviour risk: LOW–MEDIUM**

| Enum | Sites | Members | Pinned equal? |
|---|---|---|---|
| `INTAKE_REFUSALS` / `INTAKE_REFUSAL_REASONS` | `ledger.mjs:171-176` / `shape.mjs:17-22` | identical 11, same order (machine-verified) | **yes** — `test/visualizer-shape.test.mjs:844` `assert.deepEqual([...INTAKE_REFUSAL_REASONS].sort(), [...INTAKE_REFUSALS].sort())`. *The model the rest should follow.* |
| `SEAT_TEARDOWN_OUTCOMES` | `ledger.mjs:137` / `shape.mjs:16` | identical 3 | **yes** — `test/visualizer-teardown.test.mjs:155`; also pinned equal to `GATE_DISCRIMINATION_VERDICTS` (`ledger.mjs:131`, a deliberate third copy) by `test/factory-ledger.test.mjs:2832` |
| `CI_DISPATCH_OUTCOMES` / `DISPATCH_OUTCOMES` | `ledger.mjs:166` / `ci-repair.mjs:26` | identical 5 | **no** — and both are dead (F11) |
| `SESSION_STATUSES` / `RUN_SET_STATUSES` | `ledger.mjs:122` / `shape.mjs:632` (unfrozen) / `web/src/lib/panels.js:2` (unfrozen) | identical 4 | **no**. A fourth inline copy at `ledger.mjs:3876` `const settled = { running: 0, ok: 0, fail: 0, aborted: 0 }` |
| `REFUSAL_REASONS` | `make-brief.mjs:114-132` (17) / `ci-repair.mjs:27-30` (7) | **fully disjoint, same name, same directory** | make-brief's only. `ci-repair.mjs:22` imports `BriefUsageError` from make-brief, so they are one import away from colliding; ci-repair's copy is unreferenced and omits `'cycle-bound-reached'`, which it does emit (`:576,637,638,640`) |
| `UNKNOWN_REASONS` | `probe-repo.mjs:56-71` (14, **snake_case**) / `ci-watch.mjs:24-27` (4, **kebab-case**) | disjoint | both pinned separately. Note `probe-repo.mjs:64` `'not_a_git_repo'` vs `make-brief.mjs:102` `'not-a-git-repo'` — one condition, two spellings, sibling modules |
| `LADDER_PATH` | `crew/crew.mjs:616` / `make-brief.mjs:65` / `roster-ladder.mjs:8` | three independent decls of the same path | only crew's is imported anywhere |
| `normalDeps` | `intake.mjs:547`, `ci-watch.mjs:193`, `ci-repair.mjs:33`, `reap-stale.mjs:39`, `lane-watch.mjs:57`, `crew-watch.mjs:25` (+2 private in `crew/`) | 6 **public** exports of one name, different shapes | an importer that grabs the wrong one gets a silently degraded dep bag |
| `PROPOSAL_BLOCK` / `PROPOSAL_KEYS` | `emit.mjs:568-569` / `make-brief.mjs:143-144` | duplicated | neither imports the other; both copies TEST-ONLY |
| billed-token column list | `shape.mjs:633`, `ledger.mjs:3880`, `ledger.mjs:2864-2866`, `ledger-feed.mjs:14`, `crew/arms.mjs:40` | 5 copies | **no** |
| `PROTECTED_PATH_PATTERNS` vs `DEFAULT_PROTECTED_PATHS` | `probe-repo.mjs:76-102` (26 discovery patterns) / `crew/protected-paths.mjs:8-13` (12 enforced paths) | one shared member | not a bug — one proposes, one enforces — but the names invite conflation, and `probe-repo.mjs:42` already imports the other |
| `NODE_FLOOR` | `ledger.mjs:114` / `crew/daemon.mjs:133` `LEDGER_NODE_FLOOR` / `package.json:6` | all `'24.0.0'` | daemon's pinned to the literal at `crew/daemon.test.mjs:1321`; `package.json` engines pinned by nothing. The import firewall makes the duplication unavoidable; the pin is the mitigation |

The house rule is stated explicitly at `ledger.mjs:927-931` — *"The tier VOCABULARY …
lives in `crew/roster.json` … this deliberately declares no enum of its own rather
than becoming a second source of truth."* Every row above except the first two
violates it.

**Simplification:** delete `ci-repair.mjs:26` and `:27-30`; extract one
`BILLED_TOKEN_COLUMNS`; make `ledger.mjs:3876` use `SESSION_STATUSES`; add a
`deepEqual` pin for each copy that must stay dependency-free.
**Cost:** 5 files.

---

## F15 · Duplicated helpers: the full inventory
**Category:** duplicated helper · **Behaviour risk: LOW** · **~350 lines**

Ranked by call sites collapsed. Every pair below was read on both sides.

1. **CLI window preamble, ledger** — 6 verbatim copies of a 6-line block
   (`ledger.mjs:3928-3933`, `:3941-3946`, `:4073-4078`, `:4086-4091`, `:4115-4120`,
   `:4152-4157`), plus a 7th variant at `:3866-3871` where `--since` is required.
   `windowBound` already exists at `:3400`; only the wrapper is copied. **~30 lines.**
   *Latent trap:* `windowBound(value, flagName, verb = 'run-set')` defaults the verb
   name, so any caller that forgets the third argument mislabels its own refusal as
   `run-set`. `ledger.mjs:3868` relies on that default today.
2. **HTTP window preamble, visualizer** — 5 byte-identical blocks:
   `server.mjs:210-215`, `:222-227`, `:256-261`, `:270-275`, `:284-289`. **~28 lines.**
3. **The mirror-insert idiom** — 21 sites of
   `const cols = tableColumnNames('<t>').filter(c => c !== 'id'); conn.prepare(\`INSERT OR IGNORE INTO <t> …\`).run(...)`
   (`ledger.mjs:1457` … `:2418`). One `insertRow(conn, table, args)` collapses all 21. **~60 lines.**
4. **Strict `parseCliArgs`** — three near-identical 27-line parsers with three
   different reason vocabularies: `intake.mjs:1621-1646`, `make-brief.mjs:1435-1461`,
   `probe-repo.mjs:1362-1391`. **~55 lines.**
5. **Loose `parseArgs` + `refuseUnknownFlags`** — `ledger.mjs:3376-3395` /
   `emit.mjs:1364-1383` and `ledger.mjs:3364-3374` / `emit.mjs:1352-1362`,
   byte-identical but for `{}` vs `Object.create(null)`. `emit.mjs:1332-1335` says so
   in a comment. **~40 lines.**
6. **`main()` catch block** — 5 byte-identical copies (F10). **~50 lines.**
7. **Test-lane runner** — `colourNeutralEnv` (`make-brief.mjs:653-666` /
   `probe-repo.mjs:463-475`, byte-identical; probe-repo's comment says *"Copied from
   make-brief.mjs:528"*) and the spawn+ANSI-strip+parse block
   (`make-brief.mjs:779-799` / `probe-repo.mjs:486-511`) with a byte-identical regex
   `/^\s*(?:ℹ\s*)?pass\s+(\d+)\s*$/m` at `make-brief.mjs:795` / `probe-repo.mjs:504`. **~45 lines.**
8. **`gh` invocation** — four spellings, four result shapes, four error vocabularies:
   `probe-repo.mjs:736-762` (the only one honouring `GH_BIN` and a 30s timeout),
   `intake.mjs:394-407`, `intake.mjs:528-545`, `ci-watch.mjs:174-191`. **~35 lines.**
9. **`lastJsonLine` + `outcomeForStatus`** — `intake.mjs:1064-1084` vs
   `ci-repair.mjs:214-234`, byte-identical but for one comment word. **~21 lines.**
10. **Safe JSON read** — five spellings: `emit.mjs:147-155`, `ci-repair.mjs:47-53`,
    `returns-source.mjs:9-11`, `roster-ladder.mjs:53-62`, `probe-repo.mjs:308-314`,
    plus inline copies at `make-brief.mjs:767-772` and `:1465-1470`. **~25 lines.**
11. **`default*Window`** — four identical factories differing only in a constant, and
    three of the constants hold the same value (`shape.mjs:11-13`, all
    `24*60*60*1000`): `shape.mjs:373-379`, `:381-387`, `:389-395`, `:818-824`. **~16 lines.**
    *Contradiction:* `ledger.mjs:3868` **refuses** an implicit run-set window as making
    the numbers unattributable, while `defaultRunSetWindow` silently supplies one for
    `/api/run-set`.
12. **Dependency normalisers** — six public `normalDeps` exports of one name (F14). **~20 lines.**
13. **Numeric coercion** — five helpers, two byte-identical modulo a local variable
    name: `shape.mjs:340-343` `countValue` / `shape.mjs:397-400` `intakeNumber`; plus
    `shape.mjs:650-653`, `roster-ladder.mjs:22-25` (the parameterised superset, already
    written), `crew/breaker.mjs:72-75`. **~12 lines.**
14. **`record()` ×3 / `clone()` ×2** — `roster-source.mjs:7-9`,
    `roster-ladder.mjs:14-16`, `roster-edit.mjs:9-11` byte-identical;
    `roster-edit.mjs:161-163` / `roster-ladder.mjs:27-29` byte-identical.
    `probe-repo.mjs:192-194` is a third, different `clone`. **~13 lines.**
15. **`sleepSync`** — three copies of the `SharedArrayBuffer` + `Atomics.wait` spin:
    `ledger.mjs:3243-3246`, `emit.mjs:226-229` (byte-identical), `intake.mjs:556-559`. **~9 lines.**
16. **`chmodIfExists`** — `ledger.mjs:1015-1021` / `emit.mjs:139-145`, byte-identical. **~7 lines.**
17. **`nonEmptyString` / `normaliseRepoPath`** — `make-brief.mjs:296-298` /
    `probe-repo.mjs:178-180` and `make-brief.mjs:305-309` / `probe-repo.mjs:182-186`,
    both byte-identical. `repoRelative` diverges: `make-brief.mjs:300-303` maps `''`→`'.'`,
    `probe-repo.mjs:188-190` does not. **~12 lines.**
18. **Default path resolution re-derived** — `defaultDbPath` is exported at
    `ledger.mjs:3217-3221` and re-implemented at `server.mjs:26-27`;
    `join(homedir(), '.crew')` appears at `ci-watch.mjs:230`, `returns-source.mjs:13`,
    `server.mjs:27`. **~10 lines.**
19. **ANSI-strip regex** — `make-brief.mjs:53` and `probe-repo.mjs:503` byte-identical;
    `emit.mjs:414` is a **narrower third** that misses sequences the other two catch.
20. **`nowValue` / `watchNow`** — `intake.mjs:743-745` / `ci-watch.mjs:470-472`,
    byte-identical, two names, both redundant given `d.now` already defaults. **~6 lines.**
21. **`{ ...DEFAULT_INTAKE_CONFIG, ...(config || {}) }`** — 7 copies in one file:
    `intake.mjs:681, 885, 1208, 1323, 1381, 1410, 1706`.
22. **Checkout-root resolution** — `intake.mjs:165, 483, 496, 511, 530, 891, 1417, 1707`
    all spell `typeof checkout === 'string' && checkout.length > 0 ? checkout : process.cwd()`;
    `make-brief.mjs:761` and `ci-repair.mjs:99` spell it `resolve(checkout || process.cwd())`
    — and only the latter resolves.

*Note: a scout reported `emit.mjs:1337`'s citation as correct; it is not —
`ledger.mjs:1479` is `if (args.adw_id === undefined) args.adw_id = null`, while
`BOOLEAN_FLAGS` is at `:3332` and `parseArgs` at `:3376`. Corrected in F9.*

---

## F16 · Absence grammar: one fact, at least six wordings
**Category:** inconsistent with itself · **Behaviour risk: LOW**

- `'<X> readout is unavailable'` — `shape.mjs:449`, `:488`, `:537`, `:877`, `:935`, `roster-ladder.mjs:180`
- `'<X> is unavailable from this feed'` — `server.mjs:250`, `:264`, `:292` — the *same*
  absence, worded differently on the other side of the same call. Compare
  `shape.mjs:935` `'cell attribution readout is unavailable'` with `server.mjs:292`
  `'cell attribution is unavailable from this feed'`.
- `'—'` placeholder — `shape.mjs:333`, `:1052`
- `'unknown-task'` / `'unknown-time'` — `intake.mjs:286-287`
- `display(value, 'null')` / `'unknown'` / `'recorded check'` — `ci-repair.mjs:145-157`
- `unknownCell(reason)` — `probe-repo.mjs:239-241`; `unknownBaseline(…)` — `make-brief.mjs:749-757`
- Hyphen/underscore split inside one object literal: `shape.mjs:903` emits
  `'not-measured'` while `:904`'s key is `not_measured_why`

The correct model already exists and is used nowhere else: `USAGE_ABSENT_CAUSES`
(`ledger.mjs:307-313`), whose comment says it is *"exported so both emission sites
draw one wording from one place."*

Also eight inline copies of `typeof absent === 'string' && absent.length > 0 ? absent : null`
in `shape.mjs` (`:447, 449, 487, 537, 718, 876, 934, 1016`) when
`cellAttributionAbsence` (`:933-936`) is already the extracted form, used once.

**Simplification:** one exported absence vocabulary beside `USAGE_ABSENT_CAUSES`; have
`server.mjs` pass `null` so `shape.mjs` words every absence exactly once.
**Cost:** 4 files.

---

## F17 · SQL identifier quoting is applied to 7 of 21 inserts, by authorship order rather than by rule
**Category:** inconsistent with itself · **Behaviour risk: LOW (latent)**

`quoteSqlIdentifier` (`ledger.mjs:844-846`) exists because exactly one declared column
is a SQL keyword — machine-verified across all 21 tables / 297 columns:
`ci_dispatches.commit`.

- DDL quotes **everything**: `ledger.mjs:861, 862, 865, 868, 901`.
- Of the 21 mirror INSERTs, **7 quote** (`:1925, 1962, 1988, 2020, 2077, 2105, 2155` —
  `ci_dispatches` onwards, i.e. everything added after the helper was introduced) and
  **14 do not** (`:1457, 1563, 1631, 1659, 1692, 1719, 1747, 1773, 1790, 1825, 1879, 2195, 2221, 2312`).
- Two reads interpolate unquoted: `applyMigrations` at `:894` `PRAGMA table_info(${table})`
  — in a function whose every other interpolation is quoted — and `dumpTable` at `:2519`
  `SELECT * FROM ${name} ORDER BY ${naturalKey.join(', ')}`.
- `ledger.mjs:1457` is a further one-off: it calls `tableColumnNames('sessions')` three
  times and omits the `.filter(c => c !== 'id')` every sibling applies.

Harmless today; the rule is stated in the file header (`ledger.mjs:57-64`) and followed
unevenly, so the next keyword-named column is a silent syntax error.

**Simplification:** the single `insertRow` helper of F15.3 makes the quoting uniform by
construction.
**Cost:** 1 file.

---

## F18 · `dumpTable` and `queryRows` carry the same 10-line error bookkeeping twice
**Category:** duplicated helper · **Behaviour risk: LOW** · **~10 lines**

`ledger.mjs:2521-2530` and `:2537-2545` are the same `catch` — increment
`stats.mirror_errors`, latch `stats.mirror_first_code`, return `[]`.
**Simplification:** `dumpTable` builds its SQL and delegates to `queryRows`.
**Cost:** 1 file.

---

## F19 · A fold that is green in test and unreachable in production
**Category:** dead code · **Behaviour risk: LOW**

`shape.mjs:228-231` folds `last_heartbeat_at` over `agentSessions` rows, but
`ledger-feed.mjs:77`'s SELECT never selects that column. `shape.mjs:151` already admits
it in a pending string. The column exists (`ledger.mjs:540`).
`test/visualizer-shape.test.mjs:279-281` supplies it in a synthetic fixture, so the loop
is exercised by a test and dead in production.
**Simplification:** add the column to the SELECT (4 lines become live) or delete the
loop and its pending branch (~6 lines).
**Cost:** 2 files.

---

# `scripts/factory/ledger.mjs` — section table

4,322 lines, 57 top-level exports, 21 tables / 297 columns, 28 writers.
Boundaries verified line by line.

| # | Section | Lines | Count | Owns | Exports leaving it | Depends on |
|---|---|---|---|---|---|---|
| S1 | Header + `mkdirpBounded` | 1–108 | 108 | Module doctrine (mirror-never-authority, scoped Node floor, retention, library-vs-CLI, SQL-identifier rule); the bounded mkdir | `mkdirpBounded` | nothing |
| S2 | Frozen constants, `TABLES`, `WRITERS` | 109–835 | 727 | The entire interface contract: 21 table declarations, the writer/mirror maps, every enum | **45** — `LEDGER_VERSION`, `NODE_FLOOR`, `EVENT_TYPES`, … `TABLES`, `WRITERS`, `WRITER_MIRROR_TABLES`, `UPDATE_ONLY_WRITERS`, `DRIFT_REMEDY`, plus `variantFromFirstMessage`, `usageAbsentCause` | **nothing** |
| S3 | DDL generation | 836–906 | 71 | `CREATE TABLE`/index SQL built from `TABLES`; additive `ADD COLUMN` upgrade | `MIGRATIONS`, `applyMigrations` | S2 |
| S4 | Small helpers / refusal | 907–1031 | 125 | `LedgerUsageError`, `refuse`, name/text normalisation, `isoMs`, version compare, `realpathOr`, `chmodIfExists`, `isLockedError` | `LedgerUsageError`, `isoMs`, `isLockedError` | nothing |
| S5 | Redaction + drift encoding | 1032–1221 | 190 | `redact`, `applyPayloadAllowlist`, `toBindable`, the drift affinity/type machinery | — | S2, S4 |
| S6a | `openLedger` plumbing | 1222–1424 | 203 | Lazy `node:sqlite` require, floor check, degrade latch, `ensureDb`, `appendJsonl`, `mirror`, `nextSeq`, `requireFields`, `requireEnum` | `openLedger` | S2–S5 |
| S6b | Writers | 1425–2425 | **1001** | 28 dual-write recorders, one per JSONL `kind` | — (reachable via the handle) | S6a, S2 |
| S6c | Readers | 2426–2942 | 517 | `dumpTable`, `queryRows`, and 22 query methods | — (via the handle) | S6a, S2 |
| S6d | `jsonlDrift` | 2943–3035 | 93 | The JSONL-vs-mirror drift readout | — (via the handle) | S6a–c, S5 |
| S6e | Handle assembly + `_probeFts5` | 3036–3107 | 72 | The public handle object; FTS5 capability probe | — | S6a–d |
| S7 | `replayJsonl` | 3108–3140 | 33 | Rebuild the mirror by dispatching over the public write API | `replayJsonl` | S2, S6 |
| S8 | `installFinalizer` | 3141–3209 | 69 | Opt-in signal handlers sourcing truth from the in-process registry | — (handle method only) | S6 |
| S9 | `defaultDbPath` | 3210–3222 | 13 | CLI-only path resolution | `defaultDbPath` | nothing |
| S10 | `kill` helper | 3223–3326 | 104 | The operator refusal gate: `ps` identity compare, TERM→KILL escalation | — | S2, S4, S6 |
| S11 | CLI parse + `advisor-ab` | 3327–3699 | 373 | `BOOLEAN_FLAGS`, `VERB_FLAGS`, `parseArgs`, `windowBound`, price catalog, the A/B readout | `advisorAbNotes`, `advisorAbReadout` | S2, S4 |
| S12 | `main` + entry guard | 3700–4322 | 623 | 18 CLI verbs, JSON rendering, exit-code mapping | `main` | all |

**Which sections re-implement each other:** S6c's eight window-tally readers are one
query (F8); S12's six window preambles are one block (F15.1); S6b's 21 mirror inserts
are one statement (F15.3, F17); S6c's two `catch` blocks are one (F18).

---

# Recommended split — three modules, no importer changes

Both cut lines were verified mechanically for dependency direction.

### Cut 1 — `scripts/factory/ledger-schema.mjs` ← S2 + S3 (lines 109–906, ~798 lines)
Carries **47 of the 57 exports** (82%), including `TABLES`, `WRITERS`, `MIGRATIONS`,
`applyMigrations` and every enum.

**Verified clean:** the only identifier in 109–906 defined below it is `replayJsonl`,
and it appears **only inside a string literal and comments** (`ledger.mjs:834`
`DRIFT_REMEDY`, plus `:126`, `:127`, `:789`, `:833`) — never as a call. The region
references nothing from S1. It is pure data plus SQL-string building: no I/O, no
`node:sqlite`, no closure state.

### Cut 2 — `scripts/factory/ledger-cli.mjs` ← S10 + S11 + S12 (lines 3223–4322, ~1100 lines)
The `kill` helper, argument parsing, the advisor-A/B readout and `main`.

**Verified clean and one-directional:** the region references exactly 33 names defined
above it — all enums, plus `openLedger`, `replayJsonl`, `defaultDbPath`, `isoMs`,
`usageAbsentCause`, `versionAtLeast`, and three currently-private helpers (`refuse`,
`realpathOr`, `_probeFts5`) which must become exports of the core module. They need
**not** be re-exported from `ledger.mjs`'s public surface, so the public API is unchanged.

### What stays in `scripts/factory/ledger.mjs` (~2,420 lines)
S1, S4, S5, S6, S7, S8, S9 — the redaction/drift encoders, `openLedger` and its
closure, `replayJsonl`, the finalizer. It re-exports everything from the other two, so
**every one of the 57 export names stays reachable from `scripts/factory/ledger.mjs`
and no importer changes.**

Compatible with the import firewalls: `ci-watch.mjs` and `ci-repair.mjs` are pinned to
exact, *ordered* import lists naming only `./ledger.mjs`
(`test/factory-ci-watch.test.mjs:204` `assert.deepEqual(…, ['./ledger.mjs', './emit.mjs', './probe-repo.mjs'])`;
`test/factory-ci-repair.test.mjs:195`), and both keep importing only `./ledger.mjs`.
The `export * from` ban at `test/factory-ci-watch.test.mjs:202` applies to
`ci-watch.mjs`'s own source, not to `ledger.mjs`.

## The blocking caveat — four whole-file source scans hardcode `scripts/factory/ledger.mjs`

**A split silently weakens four invariants unless the scans are widened first.** All
four read the single file and would keep passing over a smaller file — which is worse
than failing:

| Scan | Site | Asserts |
|---|---|---|
| Destructive-SQL ban | `test/factory-ledger-floor.test.mjs:205-219` | no `DELETE FROM` / `DROP TABLE` / `VACUUM` anywhere in `ledger.mjs`, **including comments** |
| Signal-handler containment | `test/factory-ledger-floor.test.mjs:274-279` | no `process.on(SIG…)` outside `installFinalizerImpl`, computed by slicing `LEDGER_SOURCE` around that function |
| Update ban | `test/factory-ledger.test.mjs:202` | no `UPDATE review_outcomes` |
| Directory-listing ban | `test/factory-ledger.test.mjs:3365` | no `readdir` / `opendir` / `globSync` |

Both files build the path identically — `const SCRIPT = join(ROOT, 'scripts', 'factory', 'ledger.mjs')`
(`factory-ledger-floor.test.mjs:21`, `factory-ledger.test.mjs:42`) — and nothing else
in the suite reads `ledger.mjs` as text.

**Therefore the split must land in two steps:** (1) widen the four scans to cover every
`scripts/factory/ledger*.mjs`, proving them still green; (2) move the code. Step 1 edits
two files in the read-and-keep-green set, which the brief places on another scout's
surface — so **the split is a separate task, not a rider on this one.**

## Is the split worth it?

**Yes for Cut 1, marginally for Cut 2.** Cut 1 moves 82% of the export surface into a
dependency-free leaf importable by anything — including the visualizer, which today
keeps hand-copied enums specifically to avoid importing the ledger (F14) — removes the
largest single obstacle to reading the file, and is provably side-effect-free. Cut 2 is
a clean lift but buys less: the CLI is already last in the file and nothing imports it.

**A fourth module is not worth it.** S6b (writers, 1001 lines) and S6c (readers, 517
lines) both live inside `openLedger`'s closure and depend on `ensureDb`, `appendJsonl`,
`mirror`, `stats` and `seqAllocators`; extracting them means either threading that
context through 50 functions or exporting the closure's internals. The far better win
on those two sections is F8, F15.3 and F18 — ~150 lines removed *without moving anything*.

---

# Summary

| Rank | Finding | Risk | Files | Lines |
|---|---|---|---|---|
| F1 | The whole CI loop has no production entry point | **HIGHEST** | 2 | 1,234 |
| F2 | Intake's protected-path floor is empty | HIGH | 2 | ~3 |
| F3 | Visualizer emits a cause deleted as false (#433) | HIGH | 2 | ~5 |
| F4 | Two endpoints, two failure counts for one cell | HIGH | 2 | ~2 |
| F5 | Profile refusals: 3 reasons, 4 field sets | MED-HIGH | 3 | ~40 |
| F6 | `server.mjs` `resolve()` where siblings realpath | MED | 7 | ~45 |
| F7 | Visualizer re-writes 4 ledger queries; 3 DB doors | MED | 3 | ~70 |
| F10 | Refusal classes without `this.name` | MED | 6 | ~50 |
| F12 | `mkdirpBounded` bypassed 5× | MED | 4 | 0 |
| F13 | `ROLE_ORDER` ×3, tests import different symbols | MED | 3 | ~5 |
| F8 | Nine readers, one SQL template | LOW | 1 | ~60 |
| F11 | 4 zero-reference exports; 49 dead; 55% test seam | LOW | 3 | ~10 |
| F14 | Enums declared twice (12 groups) | LOW-MED | 5 | ~30 |
| F15 | Duplicated helpers (22 groups) | LOW | 12 | ~350 |
| F16 | Absence grammar, 6 wordings | LOW | 4 | ~20 |
| F17 | Identifier quoting on 7 of 21 inserts | LOW | 1 | ~10 |
| F9 | 34 stale comment anchors, 3 deleted modules | LOW | 8 | 0 |
| F18 | `dumpTable`/`queryRows` duplicate catch | LOW | 1 | ~10 |
| F19 | Fold green in test, dead in production | LOW | 2 | ~6 |

**~700 lines removable without behaviour change**, plus a ~800-line module lift gated
on widening four source scans — and a 1,234-line reachability question (F1) that is a
decision, not a refactor.
