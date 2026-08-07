# Architecture Package v2 — issue #12 (4b: browser singleton, epic #15 / D8)

**CONSOLIDATED NORMATIVE PACKAGE.** This document replaces `architecture-package-v1.md`, the v1.1 amendment, and the v1.2 delta **outright**. Those three are historical; nothing in them is normative. Handover Specs are generated from this document alone. Anything not restated here is dead.

**Author:** architecture-lead · **Date:** 2026-08-07 · **Status:** revised after `plan-review-r1.md` (REVISE: 3 Must Fix, 9 Should Fix — all resolved below) · **Repo:** `/Users/x/Development/dev-team-claude-plugin` · **Base:** `main` @ `b0dcb40`, plugin `0.1.62`

**Inputs consumed:** issue #12 body; `discovery-digest.md`; `u2-scout-findings.md` + its timing addendum; `consult-architect.md`; `consult-qa-lead.md`; `consult-backend-lead.md`; `plan-review-r1.md`. All under `/Users/x/Development/dev-team-claude-plugin/.claude/dev-team/tasks/issue-12/`.

**One design change beyond what the review asked for**, flagged here so the panel sees it deliberately: **the adopt outcome is deleted from the singleton** (§3 D4). Should Fix 8 asked me to name the cmux-restart edge and give it an arm; deleting adopt subsumes that edge, deletes the record-pane machinery it required, and replaces a data-loss failure mode with a skip. Rationale in D4's rejected-alternatives.

---

## §1 Problem / goal

Epic #15's D8 record is one line (`/Users/x/Development/dev-team-claude-plugin/docs/trd-cmux-execution-mode.md:565`), plus an additive-gate-evidence clause (`:486`) and a promised-but-unwritten `references/qa-gate.md` browser-verify row (`:252`). Issue #12 asks for: one browser surface per task workspace (live preview at build; the same surface driven by-ref at the gate), session continuity via `state save/load`, browser-verify evidence in the gate report, never for backend-only tasks, singleton, torn down with the workspace.

Three of those asks cannot be built as written:

- **"driven by the validator"** — the reviewer/validator pane flip shipped and was reverted 2026-08-04 (architecture-notes.md). No validator runs in a pane, and `CMUX_ALLOWS` is a frozen two-element list whose widening is an ADR-013 amendment.
- **"a split beside the frontend coder's pane"** — cmux 0.64.22 has no anchor-pane argument on `browser open`, `open-split`, or `new-pane`.
- **`state save`/`state load`** — writes cookies and localStorage to disk, landing on the residual risk ADR-005's addendum names by name, for a benefit the same-surface build→gate flow already provides.

**Goal of this package:** ship the live-preview half and a mechanized, byte-disciplined gate-evidence half; reinterpret the validator clause; descope `state save/load` with a written re-entry condition. The feature is **opt-in and off by default** — absent one config key, every code path is inert and this repo's behavior is byte-identical.

---

## §2 Ground truth

Verified facts only. Everything below was read in the working tree this session, or captured firsthand in the live cmux 0.64.22 probe and its timing addendum. Assumptions that remain unverified live in §10.

### §2.1 Live cmux 0.64.22 — probe + timing addendum

| Fact | Consequence |
|---|---|
| `browser open <url> --workspace <UUID> --focus false` → `OK surface=surface:N pane=pane:N placement=split`. **UUID accepted.** | Creation path viable; the printed ids are **positional refs**, unusable for persistence. |
| A second `browser open` in the same workspace → `placement=reuse` and a **second surface stacked into the same pane**. | No native singleton. Creating when a browser surface already exists is a **stacking** operation. |
| **Stacked surfaces are both undrivable** — `errors list` and `wait` on either return `js_error: Timed out waiting for the browser document to become ready`; screenshot blank. The identical single-surface flow in an equally unfocused workspace loads, waits, reports and screenshots correctly (verified both directions, same session). | The singleton is an **operational requirement**, not hygiene. A double-create disables the feature for the rest of the task. |
| `--load-state load` is **INVALID**; accepted literals are `interactive\|complete`. `--load-state complete` verified working (returns ~instantly on a loaded page). | `complete` is the frozen literal. |
| `rename-tab --surface <browser-uuid>` → `Error: not_found: Tab not found` (two surfaces tried; the verb works on terminal surfaces). | No preview tab title is settable. |
| A browser surface's `title` in `tree --json` **tracks the page hostname** — dynamic, navigation-controlled. | Titles are page-controlled text; unusable as a topology key. |
| `screenshot --out <arbitrary abs path>` works. **On a surface whose document never became ready it still returned `OK` and wrote a full-size (2560×1440, 68 KB) pure-white PNG.** | `existsSync` proves a file, never a render. |
| `errors list` clean → the literal `No browser errors`; dirty → `[error] <msg>` lines. `console list` mirrors it. | The reduction's frozen capture. |
| **`browser open` is fire-and-forget: 0.06 s even against a dead port.** | Lock-hold cost of a create is trivial. |
| **`goto` on a dead port self-bounds at ~15.5 s** with `Error: navigation_timeout: …`. | Spawn bound for `goto` must exceed ~15 s. |
| **A failed navigation leaves the console CLEAN** — `errors list` on the dead-port surface returns `No browser errors` in 0.04 s (connection-refused is not a console error). | `clean (0)` on a never-loaded page is reachable. Only a load-state flag prevents a vacuous clean claim. |
| Browser sub-verb failures arrive as `Error: <code>: <detail>` on stderr, exit 1. Observed codes: `js_error`, `navigation_timeout`, `not_found`, plus documented `invalid_params`, `invalid_state`, `not_supported`. Parses under cmuxctl's existing `ERROR_LINE_RE`. | No regex change needed; codes are a closed, cmux-authored vocabulary. |
| `state save` on `about:blank` → `Error: js_error: SecurityError: The operation is insecure.` | Any future state save needs an origin guard. |
| Positional refs renumber mid-session (`close-surface --surface surface:8` → `not_found` after later topology changes). | Reinforces UUID-only persistence. |
| `close-workspace` closes browser surfaces with the workspace. | Teardown's existing sweep reaches the preview. |

### §2.2 Code facts (each read this session, with `file:line`)

| Fact | Site |
|---|---|
| `VERBS` is a frozen 25-entry array; `runVerb` asserts membership before spawning; `browser` is absent | `scripts/cmux/cmuxctl.mjs:25-30`, `:148-153` |
| `cmux(verb, args, opts)` passes `opts.timeoutMs` straight to `spawnSync` and it is **undefined by default** | `cmuxctl.mjs:152` |
| `tree()` passes **no** `timeoutMs` — every tree read today is unbounded | `cmuxctl.mjs:224-230` |
| `ERROR_LINE_RE = /^Error:\s*([^:]+):\s*(.+)$/m` | `cmuxctl.mjs:155` |
| `UNVERIFIABLE_VERBS = VERBS.filter(v => !(v in VERB_METHODS)).sort()` — adding to `VERBS` changes recorded `preflight.json` content | `cmuxctl.mjs:346` |
| `recoverNewId` throws unless exactly one new object of the kind appears | `cmuxctl.mjs:284-292` |
| `abandonOrphan` says "close attempted", never "closed" | `cmuxctl.mjs:959-967` |
| `mountDocTab` rung 2 creates a `type:'browser'` surface **inside a worker's pane** via `new-surface --type browser --url file://…` | `cmuxctl.mjs:1058` |
| `withRecordLock` throws `RecordLockError` immediately on contention and **steals any lock older than `LOCK_STALE_MS = 30 000` without checking holder liveness**; already imported by `dispatch.mjs:39`; non-record precedent at `dispatch.mjs:485,550` (worktrees.json) | `scripts/cmux/record.mjs:807-873` |
| `MUTATING_VERBS = new Set([...])`, sole consumer `assertExecutionModeCmux`; **no test in `test/` references it** (grep, definitive — closes A9) | `scripts/cmux/dispatch.mjs:585-594` |
| `dispatch.mjs:4` says "the seven lifecycle verbs"; `COMMANDS` holds eight since `phase`. The `:8-14` usage block already omits `phase`. | `dispatch.mjs:4`, `:8-14` |
| ADR-018 reader shape: `stripFencedCodeBlocks` → one regex per key → >1 match refuses as ambiguous → absent returns `null` | `dispatch.mjs:119-167` |
| `spec.domain` is parsed and dropped; `dispatchCmd` never schema-validates the spec | `dispatch.mjs:908` |
| `dispatchCmd`'s `liveTree` at `:921` **predates** this dispatch's own `createPane`/`mountDocTab` surfaces | `dispatch.mjs:921` |
| `workspace.json` is rewritten **wholesale**; `carried` (`:779`) is the sole merge point; one writer (`:791`), five readers | `dispatch.mjs:766-791` |
| `initial_pane_id` is written at `:783` and read **nowhere** in `scripts/cmux/` | grep, whole dir |
| `phaseCmd`'s workspace-binding refusal shape: `readJsonOrWarn` → `OperationalError('no workspace bound for this task — run \`workspace\` first')` | `dispatch.mjs:2043-2046` |
| `teardownCmd` flatMaps every pane's every surface → `closeSurface` each; the verify pass at `:1972` has no assertion | `dispatch.mjs:1960-1963`, `:1972` |
| `archiveOrDelete` **renames** stateDir into `<stateRoot>/.archive/<slug>-<date>` on the archive branch | `dispatch.mjs:1998`, `:2015-2027` |
| `shouldArchive` returns true if **any** record's outcome ≠ `'ok'` — common on bounced tasks | `scripts/cmux/contract.mjs:253-259` |
| `findVerifiedDocTabSibling` accepts a markdown **or browser** typed sibling, but only within `paneId` (pane-scoped) | `dispatch.mjs:1572-1584` |
| `reconcile` / `paneAlive` are record-driven; identity is the full `(workspace_id, pane_id, surface_id)` triple | `scripts/cmux/ladder.mjs:508-522`, `:535-554` |
| `sidecarPaths` precedent for stateDir-nested per-dispatch files (`.collapsed`) | `scripts/cmux/resolve.mjs:172-184` |
| The fake's `LIVE_METHODS` already carries the full `browser.*` family verbatim | `test/fixtures/fake-cmux.mjs:196-217` |
| Hostile/degraded fixture cases are **pre-seeded `_simulate*` state flags, never new env switches**; `FAKE_CMUX_EVENTS_HANG` is the hang precedent (`Atomics.wait`) | `fake-cmux.mjs:401`, `:495`, `:610-618` |
| `test/cmux-dispatch.test.mjs` owns `setUpWorkspace` / `freshCmuxEnv` / `makeSpecFile` (default `domain:'backend'`); **importing a test file re-registers its whole suite** (backend-notes 2026-08-01) | `test/cmux-dispatch.test.mjs:111`, `:163-170` |
| `test/cmux-dispatch.test.mjs` `deepEqual`s the whole workspace-state object at ~12 sites: 3459, 3492, 3500, 3584, 3762, 3777, 3790, 3873, 3887, 3940, 4110, 4142 | grep |
| `test/cmux-preflight.test.mjs:242-255` `deepEqual`s `result.unverifiable_verbs` | grep |
| `onboard.md` is already in `CMUX_WIRED_SURFACES` (no A9-guard narrowing needed) | `test/cmux-contract.test.mjs:614-619` |
| `test/cmux-dispatch-doc.test.mjs` is literal-pin-only — it asserts nothing a new claim doesn't explicitly add | `test/cmux-dispatch-doc.test.mjs`, whole file |
| Suite facts: ~780 tests, ~60 s wall; fast lanes are per-file `node --test test/<files>` | qa-notes.md 2026-08-03 |

### §2.3 Binding doctrine (operative, with sources)

ADR-013 contract freeze (`contract.mjs` byte-identical unless a worker-permission surface deliberately changes). ADR-002 data-plane boundary as clarified 2026-08-06 (no task-controlled bytes in a return; no screen-derived value in a control-flow branch; the `triage.mjs` reducer + import-firewall is the shape). ADR-005 addendum (authenticated browser surfaces near worker panes = the named residual). ADR-003 Am.1 Rider E (confidentiality is bounded by **lifetime**, not achieved by location — mode/location buy nothing against a same-uid subprocess, G13). ADR-017 (no turn budgets; wall-clock only). ADR-018 (config-reader shape; predict-never-repair parsing; refusals name reasons not values). D17 / ADR-010 (the gate branches on parsed `{verdict, findings}` enums alone). UUID-only persistence + fresh-tree re-read + fail-closed ambiguity. `--focus false` invariant. Cosmetic/diagnostic verbs enter `VERBS` but never `VERB_METHODS`. Every cmuxctl wrapper takes its target id explicitly and refuses without it. Allowlist over denylist. Version-bump convention. Fake-cmux fixture doctrine (frozen live captures; `_simulate*` state flags; positives-first anti-vacuity; mutation-resistant negatives). Any `scripts/cmux/*.mjs` edit routes the PR to the 3-reviewer adversarial panel.

---

## §3 Decisions (final)

### D1 — `browser` is one `VERBS` entry, guarded by a frozen sub-verb allowlist, and never enters `VERB_METHODS`

`VERBS` gains exactly one element, `'browser'`. Sub-verbs ride as argv tokens — `cmux('browser', ['errors','list', surfaceId], { timeoutMs })` — the `markdown open` shape already precedented at `cmuxctl.mjs:1038`. A module-private frozen constant guards the family one level down:

```
const BROWSER_SUBVERBS = Object.freeze(['open', 'goto', 'wait', 'errors', 'screenshot'])
```

`browserVerb(sub, args, opts)` throws **before any spawn** on anything outside that set — the same shape `runVerb` applies to `VERBS`. `eval`, `state`, `console`, `snapshot`, `viewport` and every interaction verb are structurally unreachable.

**No `VERB_METHODS` entry.** Two reasons, the second decisive:
1. Non-load-bearing verbs degrade rather than hard-stop preflight (conventions.md 2026-08-06). Nothing in the dispatch lifecycle, no completion decision, and no gate verdict depends on the browser.
2. **`VERB_METHODS` maps one CLI verb to one RPC method.** `browser` spans five (`browser.open`, `browser.goto`, `browser.wait_for`, `browser.errors`, `browser.screenshot`). Any single mapping gates five capabilities on one name. The map cannot express a family — this is structural, not conservatism.

Availability is read **at each point of use** from the already-cached `preflight.json`, exactly as `teardownCmd` reads `close_workspace_available`: `readPreflightCache(join(paths.stateDir,'preflight.json')) || {}`, then `Array.isArray(cached.methods) && cached.methods.includes('browser.open')`. Absent, unreadable, malformed, or missing the method → **skip the preview, one loud stderr line naming the remediation** (`brew upgrade --cask cmux`, or re-run `preflight`). Zero `preflight.json` shape change; every existing cache keeps working.

> **Rejected — a `VERB_METHODS` entry on `browser.open`:** buys a preflight hard-stop on every dispatch, including backend-only ones that will never open a browser, to detect a condition we already detect where it is free.
> **Rejected — a derived `browser_available` boolean in `preflight.json`:** changes a cached artifact's shape (`isValidPreflightCache`, `cmuxctl.mjs:366`) for information the `methods` array already carries verbatim.

**Known consequence:** `UNVERIFIABLE_VERBS` changes, so `test/cmux-preflight.test.mjs:242-255`'s `deepEqual` goes red **expectedly** and must be updated in the same slice.

### D2 — Creation uses `cmux browser open`; the id comes from a tree diff, never from stdout

`browserOpen(url, { workspaceId })` issues `cmux browser open <url> --workspace <ws-uuid> --focus false`, then recovers the surface id and pane id by a before/after `tree` diff via `recoverNewId`. The printed line is parsed for **`placement=(\w+)` only** — logged, never persisted, never branched on. `surface=` and `pane=` tokens are never read, not even as a cross-check.

Two independent reasons the printed id is unusable: it is a **positional ref** (`surface:6`), which this repo never persists, and positional refs renumber mid-session (§2.1). Resolving one to a UUID needs a tree read anyway, so the diff is strictly simpler.

`browser open` beats `new-surface --type browser --url` because the former is **live-verified with an http URL and a UUID workspace**, while the latter is live-unverified even for the `file://` case its own call site admits (`cmuxctl.mjs:1047-1051`). `browser` must enter `VERBS` regardless, so there is no marginal cost.

> **Rejected — `new-surface --type browser --url <http> --workspace <id> --focus false`:** already allowlisted and fixture-modeled, but trades a live-verified call for an unverified one to save an entry we are adding anyway.

### D3 — The dispatcher is the only invoker at both ends; `contract.mjs` stays byte-identical

**Build phase:** `dispatchCmd` calls `ensurePreviewBrowser(...)` in the cosmetic-degradation zone — after `sendLine` and `mountDocTab`, immediately before `setPhase('building')` (`dispatch.mjs:1097-1110`) — inside a `try/catch` that logs and continues. A preview failure can never fail a dispatch.

**Gate phase:** a new CLI verb, `node dispatch.mjs browser-verify --task <slug>`, joins `MUTATING_VERBS`. The orchestrator invokes it at the gate from its interactive session, exactly as it invokes `phase --set gate`.

This is the `cmux diff` precedent (`references/qa-gate.md:81`, conventions.md 2026-08-04) applied one notch further — an orchestrator-invoked gate surface needs **no `CMUX_ALLOWS` entry**. `contract.mjs` is byte-identical; ADR-013's freeze holds; no worker ever runs a `cmux browser` verb.

**The issue's "driven by-ref by the validator" is reinterpreted on the record:** the dispatcher drives the surface by UUID at the gate, and the *reduced* evidence reaches the validator's bundle and the gate report as data. The validator stays an Agent-tool subagent with no cmux reach.

Required siting and comments (architect):
- `browser-verify` is **not** added to `references/cmux-dispatch.md`'s lifecycle-order line. It is documented in `references/qa-gate.md` beside `cmux diff` as an **optional gate adjunct**, plus one `cmux-dispatch.md` §1 paragraph.
- The `MUTATING_VERBS` addition carries a comment: the set means *"requires `execution_mode: cmux`"* — its only consumer is `assertExecutionModeCmux` — **not** *"mutates a record"*. `browser-verify` is the first member for which the name misleads.
- `dispatch.mjs:4` ("the seven lifecycle verbs") and the `:8-14` usage block are both already stale; both are corrected in the same slice, `:4` phrased to name `COMMANDS` with **no number** so it cannot go stale again.

> **Rejected — the orchestrator hand-types the sequence:** conventions.md 2026-08-01 puts mechanical, failure-prone verb sequences in a tested script, not orchestration prose. Decisively, hand-typing pipes **unreduced page bytes into the orchestrator's own context** — the agent that composes the gate report and decides bounce-vs-pass — which is *closer* to control flow than the rejected Agent-tool validator, not farther. `cmux diff` transfers on the **permission half only**: it renders to a GUI for human eyes, while `errors list` lands in a model transcript.
> **Rejected — an Agent-tool validator running the verbs:** technically possible (Agent-tool subagents are not roster-profile-sandboxed) and strictly worse — unreduced page bytes into the context of the agent that emits the verdict enum the gate branches on.
> **Rejected — ship PR 1 and defer PR 2** (architect's fair counter): see the anti-deferral rule in §8 and the fallback cost in §7.5.

### D4 — Singleton: sidecar + lock + a pre-create authority scan. **There is no adopt outcome.**

The record lives in a **single-writer sidecar** `<stateDir>/browser.json`, and the whole `resolve → decide → create → verify → stamp` runs inside `withRecordLock`.

**Why the lock.** Parallel `dispatchCmd` against one workspace is reachable today (dispatch returns non-blocking; nothing serializes two processes; the await lock covers `await` only). `writeJsonAtomic` prevents torn writes, not lost updates. Two racers both seeing "no record" both create → `placement=reuse` → stacked → **both undrivable**. `withRecordLock` throws `RecordLockError` immediately on contention (never waits) → catch → log → skip, inside the cosmetic zone.

**Why a sidecar rather than `workspace.json`.** `workspace.json` has exactly one writer (`:791`) and five readers, and is rewritten wholesale from `carried`. A second writer there would mean a lost-update race with `workspace --tier`, two merge doctrines in one file, and — if fixed properly — `workspaceCmd` joining the same lock, a load-bearing behavioral change to a core verb for a cosmetic feature. Consequences of the sidecar: **`workspaceCmd` needs no edit at all**; `carried` is untouched; the ~12 whole-object `deepEqual` sites in `test/cmux-dispatch.test.mjs` stay green because `workspace.json` gains no key.

**Bounded critical section (Must Fix 1).** `withRecordLock` **steals** any lock older than `LOCK_STALE_MS = 30 000 ms` without checking holder liveness, and every `tree()` today is unbounded. Both halves of the fix ship — a stated spawn budget *and* a post-create idempotence check — because the failure they prevent is unrecoverable for the task:

| Step inside the lock | Spawn | `timeoutMs` |
|---|---|---|
| scan / before-tree (one read serves both) | `tree({ all: true, timeoutMs: 3000 })` | 3 000 |
| `browser open` | `browserOpen` | 5 000 |
| after-tree (id recovery **and** idempotence re-scan) | `tree({ all: true, timeoutMs: 3000 })` | 3 000 |
| abandon path only: `closeSurface` (its own `requireTargetPresent` tree + the close) | | 3 000 + 5 000 |

**Stated invariant, as a comment at the lock site:** *worst case 19 000 ms, 11 s of margin under `LOCK_STALE_MS` (30 000 ms); measured healthy costs are ~50 ms per `tree` and 0.06 s per `open`, i.e. ~60–80× headroom per bound. Any future spawn added inside this section must be bounded and the budget recomputed.* Reuse and skip paths cost one bounded tree (3 000 ms).

`tree()` gains an **optional** `timeoutMs` (default `undefined` = today's behavior byte-for-byte at every existing call site).

**Post-create idempotence check (second line of defense).** The after-tree is re-scanned before stamping. If our new surface is not alone in its pane, or a second free browser surface now exists, a racer won despite the lock (stolen lock, or a hang) → **abandon**: do not stamp, best-effort `closeSurface` our own surface (the `abandonOrphan` shape — "close attempted", never "closed"), log `preview_double_create_detected`, return `code: 0`. The winner's record stays intact, so the gate sees a valid preview.

**The scan (authority = a fresh tree, taken by `ensurePreviewBrowser` itself — never `dispatch.mjs:921`'s `liveTree`, which predates this dispatch's own surfaces).**

Partition every browser-typed surface in the bound workspace:

- **worker-pane browsers** — those in the pane holding `workspace.json.initial_surface_id`, or in a pane id belonging to a dispatch record **whose `surface.workspace_id` equals the live bound workspace id** and whose pane id resolves in the current tree. Ignored entirely.
- **free browsers** — everything else.

Then, exactly three outcomes:

1. Recorded `surface_id` present in the tree, browser-typed, `workspace_id` matching both the sidecar and the live binding → **reuse.** Zero creates, nothing re-stamped. (Steady state, silent.)
2. No valid record **and zero free browsers** → **create** (D2), verify (idempotence check), stamp.
3. No valid record **and ≥1 free browser** → **fail closed.** Create nothing, adopt nothing, skip the preview, log the reason: `preview_topology_unverifiable` when any same-workspace record's pane id failed to resolve in the current tree (topology changed under us — the cmux-restart / deleted-record class), otherwise `preview_surface_ambiguous`. Ambiguous is not absent.

**Why there is no adopt outcome.** Adopting a free browser surface means handing `browser-verify` a surface it will `goto` — and if that surface is a `mountDocTab` rung-2 doc tab whose record went unreadable, or a collapsed doc-tab pane (ADR-004 collapse leaves a browser surface alone in its pane), the `goto` **navigates a rendered return document away**. The cost of a wrong adopt is data loss; the cost of a wrong skip is no preview plus a log line telling a human to close the stray surface. Asymmetric costs settle it. Deleting adopt also removes the collapsed-doc-tab special case, the `.collapsed`-sidecar reasoning, and the cmux-restart edge (Should Fix 8) in one move — every residual in that family now degrades to a skip.

**The scan itself survives and is mandatory**, because `browser open --workspace` **stacks** into an existing browser pane: "create because we have no record" is a data-loss operation, not an idempotent one. The scan is what makes create safe; the record-derived worker-pane exclusion is what keeps a rung-2 doc tab from *blocking* creation forever. Only the adopt outcome is deleted.

**Post-create pane check.** If the recovered pane falls in the worker-pane set (stacked onto a doc tab — see §10 A12), treat it exactly like the idempotence failure: **abandon** (close attempted, no stamp), log `preview_landed_in_worker_pane`. Stacking onto a doc tab breaks the return doc; un-stacking is the correct response.

Both exclusion keys are UUID-derived: the initial pane is located via `initial_surface_id`, **never** via `workspace.json.initial_pane_id`. `initial_pane_id` therefore keeps zero readers, `workspaceCmd`'s `panes[0]` derivation (`:764`) stays inert, and pane reordering cannot misclassify.

> **Rejected — a frozen tab title as the singleton key:** live-falsified. `rename-tab` fails on browser surfaces (`not_found`), and a browser surface's title tracks the page hostname, i.e. it is navigation-controlled text. Selecting a topology target with page-controlled bytes violates D5's own boundary.
> **Rejected — an `http(s)`-vs-`file://` title heuristic:** same reason. Available, mostly workable, wrong kind of correct.
> **Rejected — record-only with no scan:** `placement=reuse` makes an unguarded create a stacking operation.
> **Rejected — "a documented single-preview-per-wave invariant" instead of the lock:** the roster imposes no such limit (one `coder` role, N dispatches). A documented invariant is the fail-open the stacked-undrivable finding punishes.
> **Rejected — a spawn budget alone, or an idempotence check alone:** the budget cannot cover a `spawnSync` timeout that itself misbehaves; the idempotence check cannot prevent the window, only detect it. Ship both.

### D5 — Evidence: a reduced tuple, an unverified capture, and a liveness flag. It never gates the verdict.

**New pure module** `scripts/cmux/browser-evidence.mjs` — the `triage.mjs` pattern applied to page bytes:

```
BROWSER_ERRORS_CLEAN_LINE = 'No browser errors'      // frozen live capture, 0.64.22
reduceBrowserErrors(stdout) -> { clean, count, shape }
```

- trimmed stdout **equals** the clean literal → `{ clean:true, count:0, shape:'clean' }`
- ≥1 line matching `/^\[error\]/` → `{ clean:false, count:N, shape:'errors' }` — `N` counts **matching lines**, so a multiline stack trace is one error
- anything else (empty, whitespace-only, non-string, a raw `Error: js_error: …` payload) → `{ clean:false, count:null, shape:'unrecognized' }` — **fails toward not-clean, never toward clean**

**No message text ever leaves the function.** `browserErrorsList` is the only wrapper returning raw page bytes; its JSDoc names `reduceBrowserErrors` as its single legal consumer, and a test asserts it has **exactly one call site** outside its definition (a JSDoc is a comment, not a control). The module imports nothing from this repo and is imported by no decision module — asserted by a source-text firewall test in **both** directions.

**Screenshot** → `<stateDir>/browser/verify-<compact-ISO>.png`, path composed entirely by the dispatcher. `stateDir` because it is parent-side and never `--add-dir`'d: a screenshot of a logged-in app in `taskDir` would be published to every concurrently dispatched worker. Existence is confirmed by an independent `existsSync`, never by cmux's `OK <path>` line.

**Liveness flag — `load_state_confirmed`.** The timing probe proved a connection-refused navigation leaves the console **clean**, so `clean (0)` on a never-loaded page is reachable and reads exactly like success; and a never-ready surface still yields `OK` plus a full-size white PNG. The `browserWaitReady` result is therefore the **only** non-vacuous liveness signal, and it is reported alongside — never merged into — the console reduction, so "loaded with 3 errors" stays distinguishable from "never loaded."

**Sequence, fixed:** `errors clear → goto <configured url> → wait --load-state complete --timeout-ms 20000 → errors list → screenshot --out <path>`. `errors clear` before `goto` gives a clean, attributable window that excludes the pre-server failed load (the dev server is started by the coder, in its own pane — the dispatcher never starts a server). A `wait` failure sets `load_state_confirmed:false` and the verb **proceeds and still exits 0**.

**Gate-report line composition, normative:**

- `load_state_confirmed:false` → the caveat **leads** and the clean claim is **suppressed**:
  `browser-verify: page never reached load-state complete (wait timed out) — console-error and screenshot evidence are UNRELIABLE for this run · screenshot captured at <path>`
- true, clean → `browser-verify: page reached load-state complete · console errors clean (0) · screenshot captured at <path>`
- true, dirty → `browser-verify: page reached load-state complete · 3 console error(s) · screenshot captured at <path>`
- absent preview → the line is omitted; the reason enum is reported instead.

**Prohibited wording, stated verbatim in `references/qa-gate.md`:** never "verified", "renders correctly", or "the app works". A screenshot is an artifact for a human to open; **screenshot success means a file exists, nothing more.**

**It never gates the verdict.** D17 stands: the gate branches on the parsed `{verdict, findings}` enum alone. Browser evidence is additive (TRD `:486`). A dirty console does not block; `load_state_confirmed:false` is not a failure; `browser-verify` exits 0 in both cases. The orchestrator, a judgment agent, may choose to bounce after reading it — that is judgment, not a mechanical branch, and the distinction is stated in the doc **and** in a code comment, because branching on it is precisely the ADR-002 violation a future reader will try to "fix in."

**`snapshot` is a named non-goal** — a large page-controlled blob with no reduction that is both non-vacuous and non-injecting.

**Logging rule.** Browser wrappers log `res.error?.code` + the sub-verb + the surface id. **Never `res.error?.message`** — a deliberate divergence from the house pattern, stated at the definition site. Browser error details are page-influenced and `dispatch.mjs`'s stderr is an orchestrator-context ingress. The code is logged only if it matches `^[a-z_]{1,32}$`, else the literal `<unparsed>`, so the closed-vocabulary claim is structural rather than trusted. The code is surfaced upward into IC-4's `warnings` (e.g. `errors_list:js_error`) so a wedged preview is visible, not silent.

> **Rejected — passing `errors list` prose through "for the human":** prose in a gate report is prose in the orchestrator's context, which does drive control flow.
> **Rejected — a `triage.mjs`-style closed-enum signature table over error messages:** a count is the whole actionable signal; a signature table invites growth into a decision input.
> **Rejected — a sanitized, truncated error detail (`safeDetail`, proposed in an earlier draft and self-rejected):** truncation bounds volume, not content; a prompt injection fits in 120 characters. It contradicted AC17 as written.

### D6 — `browser state save` / `state load` does not ship

Descoped deliberately, against a line of the issue body.

The stated purpose is auth continuity coder→gate, but **the same surface persists across build and gate in one cmux instance**, so the live session already carries it. The verbs add value only across a cmux restart or a surface re-creation. Against that: state files carry cookies and localStorage — secrets on disk in a `stateDir` reachable by a same-uid worker subprocess (G13) — and ADR-005's addendum names *authenticated browser surfaces near worker panes* as **the** residual risk of the whole cmux posture. `state load` is the verb that manufactures exactly that, from a file, with no human in the loop.

**Stated plainly, not hedged: the descope does not avoid ADR-005's residual — PR 1 walks into it the moment a human logs into the preview.** That *is* an authenticated browser surface in the same cmux instance as worker panes. D6 declines a **replayable on-disk artifact**; it does not decline the configuration. Mitigation is documentary: `commands/onboard.md` and `.claude/dev-team/config.md` gain one line beside `cmux_preview_url` — **log the preview into dev/staging accounts only, never production or admin credentials.**

**Re-entry condition (rewritten to ratified doctrine).** Trigger: an observed case where a cmux restart **or a surface re-creation** (D4's create arm firing on a stale recorded surface — likelier than a restart) between build and gate discarded an expensive login. At that point the design owes, per **ADR-003 Am.1 Rider E — confidentiality is bounded by lifetime, not achieved by location**: the state file written immediately before `state load`, unlinked immediately after, and unlinked on **every** abort path (the 1b nonce lifecycle verbatim); never logged; and an origin guard, because `state save` throws `SecurityError` on `about:blank`. **Mode-0600 and clever siting buy nothing against G13, and unlink-at-teardown is far too late** — an earlier draft of this package prescribed exactly that hardening and was wrong.

> **Rejected — shipping it because the verbs exist:** verb availability is not a reason; it is the shape of over-architecting.
> **Counter, stated fairly:** for auth-walled apps the preview lands on a login page and the evidence channel is thinnest exactly where the app is most interesting. It does not win, because nobody drives login programmatically (`BROWSER_SUBVERBS` excludes interaction verbs) — a human logs in in the pane, and the live surface carries it. The vacuity risk is handled by non-overclaiming report lines, not by adding verbs.

### D7 — Trigger, teardown, non-interactions, placement

**Trigger** — all four conjuncts, evaluated in `dispatchCmd`:

1. `readCmuxPreviewUrl(configText)` returns a URL (absent = feature off = today's behavior exactly);
2. `spec?.domain === 'frontend'` — **exact match**, defensive read; `'Frontend'`, `'frontend '`, missing, or non-string all mean no preview. `dispatchCmd` never schema-validates the spec, so exactness is enforced here;
3. `resolved.isolation === 'worktree'` — the role actually builds code. In today's roster that is `coder`, i.e. literally "the frontend coder's pane"; expressed as a property so it does not go stale when roles change;
4. `browser.open ∈ cached preflight methods` (D1).

"Never spawned for backend-only tasks" is then structural. **Accepted consequence, named:** a full-stack slice authored `domain: backend` gets no preview.

**Teardown — exactly one teardown-specific deletion (Must Fix 2).** `teardownCmd`'s existing surface sweep (`:1960-1963`) already closes the preview surface, since it lives in a pane of the bound workspace. But **"swept for free" was false on the archive path**: `archiveOrDelete` *renames* `stateDir` into `<stateRoot>/.archive/<slug>-<date>`, and `shouldArchive` returns true whenever any record's outcome ≠ `'ok'` — common on bounced tasks. Screenshots of an authenticated dev app would persist indefinitely, contradicting this package's own exposure reasoning (the very argument that put them in `stateDir` rather than `taskDir`).

Therefore, **before** `archiveOrDelete`, `teardownCmd` deletes `<stateDir>/browser/` (recursive, force) and `<stateDir>/browser.json`. Both branches are tested. Both artifacts go: the sidecar's `origin` can name an internal hostname, and a record pointing at dead surfaces has no post-mortem value.

**Verified non-interactions** (each pinned by a regression test, not by prose):

| Surface | Why the preview is invisible |
|---|---|
| `reconcile` / `classify` / `paneAlive` | Record-driven; identity is the full triple. The preview is in no dispatch record. **No record-level invisibility mechanism is needed.** |
| `closeCmd`'s doc-tab collapse | `findDocTabSurface` is **pane-scoped** (`dispatch.mjs:1572-1584`). The preview lives in its own pane, so it can never be read as a doc-tab sibling or authorize a terminal close. |
| `statusCmd` | Builds rows from records only. |
| `workspaceCmd` | Untouched by this feature; `workspace.json` gains no key. |

**Placement:** accept cmux's default. No `move-surface`, no `split-off`. There is no anchor-pane argument, and moving the preview *into* the coder's pane would stack it as a tab and destroy the simultaneous visibility that is the entire point. `--focus false` on create; **no browser wrapper ever issues a focus verb.** The reported `placement` token is logged so a live acceptance run can observe what actually happened. Adjacency stays a human concern — the issue's own words.

### D8 — Preview URL: a config key, origin-only on every output path

`cmux_preview_url` in `.claude/dev-team/config.md`, read by `readCmuxPreviewUrl(configText)` in `dispatch.mjs` beside `readCmuxEnvFile` — the ADR-018 reader shape verbatim: fenced-block-stripped, one regex, **>1 line ⇒ `OperationalError` "ambiguous (a fenced example?), refusing"**, absent/blank ⇒ `null`. Read fresh on every invocation that needs it.

**Validator, throw before any spawn** (refusals name the reason and the scheme, never the value):

- `.trim()` first (strips a trailing `\r`);
- refuse any `@` outright — userinfo is never needed and `https://user:token@host/` passes every looser shape;
- full-match `^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~:\/?#\[\]!$&'()*+,;=%-]*)?$` — host charset separate from path charset, so hostless forms (`https://?`, `https://#`, `https://@`) no longer full-match;
- port, when present, additionally ≤ 65535 (an explicit numeric check — the regex cannot express it inside the 15-keyword schema budget doctrine this repo applies to hand-rolled validation);
- refuse any `%` not followed by two hex digits (predict-never-repair, ADR-018);
- length ≤ 2048.

**Comment the two deliberate exclusions** so nobody "fixes" them: backslash is excluded because WHATWG treats `\` as `/` in special schemes (admitting it would let the value we validated differ from what the browser resolves — the ADR-018 parser-divergence class), and the `https?` anchor is deliberately case-sensitive.

**Origin-only on every output path.** A dev URL can carry a token query param. Refusing to echo a value on the reject path while printing it in full on the accept path is the same leak. So: **IC-4's field, the sidecar's field, every gate-report line, and the configured-vs-recorded divergence warning all carry the origin only** (`scheme://host[:port]`). The full URL exists in exactly two places — the config file and the `goto` argv array.

**Who starts the dev server: the coder, in its own pane**, per its own spec. The dispatcher never starts a server — that would be a new execution surface with no permission model. The browser is therefore very likely created before the server listens; that is accepted and handled by `browser-verify`'s `errors clear → goto` re-navigation.

> **Rejected — a `handover-spec.schema.json` field:** a root-schema contract edit (deep-review class), a workflow-mode coupling, and every lead authoring it — for a value that is a property of the project, not the task.
> **Rejected — the `--config` JSON sidecar:** that layer is per-dispatch; this is per-project.

---

## §4 Interface contracts

### IC-1 — `<stateDir>/browser.json` (the preview record)

Written **only** by `ensurePreviewBrowser`, under `withRecordLock`. Read by `ensurePreviewBrowser` and (read-only) by `browser-verify`. Absent file = no preview; malformed = absent + one loud line (`readJsonOrWarn`).

```json
{ "surface_id": "<lowercase-uuid>", "pane_id": "<lowercase-uuid>",
  "workspace_id": "<lowercase-uuid>", "origin": "http://localhost:3000",
  "created_at": "<ISO8601 with ms>" }
```

Every consumer corroborates against a **fresh tree** and checks `workspace_id` equality against the live binding before use. Deleted by `teardownCmd` before `archiveOrDelete`.

### IC-2 — cmuxctl browser wrappers

All take ids explicitly and **throw before any spawn** on a missing or malformed id. All degrade loudly — one stderr line with the **code only**, plus a `null`/`false` return — and **never throw** on a cmux failure (the `setStatus`/`readScreen` shape). All pass an explicit `timeoutMs` **exceeding** any cmux-side bound, so a spawn kill (`spawn_error`) stays distinguishable from cmux's own timeout (`js_error` / `navigation_timeout`).

```
BROWSER_SUBVERBS  = ['open','goto','wait','errors','screenshot']   // frozen
BROWSER_LOAD_STATE = 'complete'                                     // frozen; no caller supplies one

browserOpen(url, { workspaceId })            -> { surfaceId, paneId, placement } | null   //  5 000 ms
browserGoto(surfaceId, url)                  -> boolean                                   // 20 000 ms (cmux self-bounds ~15.5 s)
browserWaitReady(surfaceId, { timeoutMs })   -> boolean                                   // 25 000 ms (cmux-side --timeout-ms 20000)
browserErrorsClear(surfaceId)                -> boolean                                   // 10 000 ms
browserErrorsList(surfaceId)                 -> string | null    // RAW page bytes; sole consumer reduceBrowserErrors
browserScreenshot(surfaceId, outPath)        -> boolean                                   // 20 000 ms
```

`browserOpen` uses 5 000 ms inside the lock (measured 0.06 s; 80× headroom). Outside the lock the same wrapper is not reused. `browserErrorsList`'s 10 000 ms applies at the gate.

**Return types are part of the contract** (Should Fix 4): `cmux()` returns `error.message`, which is page-influenced, so a wrapper that leaked its raw result object would be a leak channel. Every wrapper returns `boolean`, `{ids…}`, or `null` — **only** `browserErrorsList` returns a string, and only page bytes.

`tree()` gains an optional `timeoutMs` (default `undefined` = unchanged behavior at every existing call site).

### IC-3 — `scripts/cmux/browser-evidence.mjs`

```
BROWSER_ERRORS_CLEAN_LINE = 'No browser errors'
reduceBrowserErrors(stdout) -> { clean: boolean, count: number|null, shape: 'clean'|'errors'|'unrecognized' }
```

Imports nothing from this repo; imported by no decision module (`ladder.mjs`, `triage.mjs`, `contract.mjs`). Firewall asserted by a source-text test in both directions. `count` counts `^\[error\]` **lines**.

### IC-4 — `dispatch.mjs browser-verify` stdout JSON

```json
{ "preview_present": true, "surface_id": "…", "origin": "http://localhost:3000",
  "load_state_confirmed": true,
  "console_errors": { "clean": true, "count": 0, "shape": "clean" },
  "screenshot_path": "/abs/…/verify-20260807T142530123Z.png",
  "warnings": [] }
```

Absent-preview form: `{ "preview_present": false, "reason": <enum>, "warnings": [] }` with the **gate-time** enum `preview_disabled | no_preview_recorded | preview_surface_gone`.

**Exit codes:** 0 whenever the verb ran — including a dirty console, `load_state_confirmed:false`, and `preview_present:false`. The verb reports; it never judges. Exit 1 on operational failure (no workspace bound, unreadable preflight, cmux unreachable); exit 2 on usage error. **Total wall-clock budget ≤ 90 s**, stated at the verb and in `references/qa-gate.md` so the orchestrator sizes its Bash-tool timeout.

Between a ready and a never-ready run the JSON **key set is identical**; only `load_state_confirmed`, `warnings`, and `screenshot_path` differ.

### IC-5 — `dispatchCmd` stdout JSON gains `preview` *(new, resolves Should Fix 5)*

```json
"preview": { "state": "reused"|"created"|"skipped", "reason": <enum|omitted> }
```

Dispatch-time enum: `preview_disabled`, `preview_lock_contended`, `preview_surface_ambiguous`, `preview_topology_unverifiable`, `preview_double_create_detected`, `preview_landed_in_worker_pane`, `preview_capability_missing`.

**Justification for siting it here rather than in IC-4** (Should Fix 5 said "add the member or justify"): `preview_lock_contended` is a *dispatch-time* event, and `browser-verify` does not take the lock, so it can never observe it. Placing it in IC-4 would create a dead enum member; placing it here gives the orchestrator the reason at the moment it happens. `references/qa-gate.md` states that a `no_preview_recorded` at the gate should be cross-read against the dispatch JSON's `preview.reason` — which closes the "a persistently contended lock reads as feature-off" gap the review named.

---

## §5 Execution plan

**Three slices, two PRs, plus a named orchestrator memory step.** Every `scripts/cmux/*.mjs` edit routes the PR to the 3-reviewer adversarial panel, and the panel is per-PR. One PR would put ~700 lines across 12 files — frozen-allowlist widening, dispatch-lifecycle wiring, concurrency, and a prompt-injection byte boundary — under one panel, diluting lenses. Three PRs would give slice A alone no observable behavior (argv-shape review only). Two panels; revert granularity stays one-directional (C → B → A).

### Slice 0 — memory commit *(orchestrator, not a coder; resolves Should Fix 7)*

Not a dispatch. After plan approval, **before** `be-12-01` is dispatched, the orchestrator commits the §8 ADR-019 text into `.claude/dev-team/memory/architecture-notes.md` and the §9 conventions entries into `.claude/dev-team/memory/conventions.md`, as its own `chore:` commit (memory-only; no version bump — precedent `75356e8`). This exists because the memory writes were in no slice's `files_in_scope` and had no validation lane; leaving them "implied for doc-writer post-review" is how they get lost.

### PR 1 — live preview · `feat: cmux 4b browser preview singleton; bump 0.1.63`

#### Slice `be-12-01` — cmuxctl browser family + fixture

`domain: backend` · `isolation: worktree` · `depends_on: []`

**files_in_scope**
- `/Users/x/Development/dev-team-claude-plugin/scripts/cmux/cmuxctl.mjs`
- `/Users/x/Development/dev-team-claude-plugin/test/fixtures/fake-cmux.mjs`
- `/Users/x/Development/dev-team-claude-plugin/test/cmux-dispatch.test.mjs`
- `/Users/x/Development/dev-team-claude-plugin/test/cmux-preflight.test.mjs`

**Work items**
1. `VERBS += 'browser'` (`:25-30`).
2. `BROWSER_SUBVERBS` frozen constant + `browserVerb()` throw-before-spawn guard.
3. The six IC-2 wrappers, each with its explicit `timeoutMs`; `BROWSER_LOAD_STATE = 'complete'`; `browserOpen` parses `placement=(\w+)` only.
4. Code-only error logging + the `^[a-z_]{1,32}$` shape guard, with the deliberate-divergence comment at the definition site.
5. `tree()` gains an optional `timeoutMs` (default `undefined`).
6. A comment at the `VERB_METHODS` definition site (`:58-63`) stating **why** `browser` is excluded, in the existing decision-not-omission voice.
7. Fixture: a `case 'browser'` handling `open|goto|wait|errors|screenshot`; unknown sub-verb → `fail('bad_args')`.
8. Fixture fidelity (all frozen live captures, all state-flag driven — **never new env switches**):
   - `open` prints `OK surface=surface:<n> pane=pane:<n> placement=split` with **positional** refs, so any implementation parsing the printed id produces a non-UUID and fails;
   - a second `open` in a workspace holding a browser surface prints `placement=reuse` and **stacks into that pane**;
   - any `wait`/`errors` on a surface in a pane holding ≥2 browser surfaces → `fail('js_error','Timed out waiting for the browser document to become ready')`; `screenshot` there still succeeds (models the blank-PNG reality);
   - **`--load-state` rejects wrong values** — `load` → `fail('js_error', …)`; only `interactive|complete` succeed;
   - browser surface `title` tracks the URL **hostname**, set on `open`, updated on `goto`;
   - `rename-tab` → `fail('not_found','Tab not found')` when the target surface's `type !== 'terminal'` (general fidelity fix; no production caller is affected);
   - `navigation_timeout` modeled alongside `js_error`;
   - `_simulateScreenshotOkNoWrite` — prints `OK <path>` **without writing** the file;
   - `_simulateTreeHang` / `_simulateBrowserOpenHang` — `Atomics.wait` hangs, the `FAKE_CMUX_EVENTS_HANG` precedent (`fake-cmux.mjs:610-618`).
9. Update `test/cmux-preflight.test.mjs:242-255`'s `unverifiable_verbs` `deepEqual` — an **expected** red.

**Tests** — positives first, argv asserted element-by-element with exact counts.
Happy path per wrapper · `--focus false` in `browserOpen`'s argv · `--load-state complete` byte-pinned and the literal `'load'` **absent from all of `scripts/cmux/`** (source-text) · each wrapper's `timeoutMs` asserted, **and** a hang test per bounded call proving it returns `spawn_error` within its bound (the mutation-resistant form; the source-text assertion is the cheap companion) · each wrapper throws before spawn on a missing id with **zero** logged invocations · an out-of-allowlist sub-verb throws before spawn · a `js_error`/`navigation_timeout` degrades without throwing and logs **code only** (assert the detail string is absent from stderr) · an out-of-vocabulary code logs `<unparsed>` · **return-type assertions** for all six wrappers (only `browserErrorsList` returns a string) · `browserOpen` under `_simulateConcurrentCreate` surfaces the `recoverNewId` ambiguity rather than guessing.
**Mutations that must go red:** remove the `BROWSER_SUBVERBS` guard (the only structure keeping `eval`/`state` unreachable); remove any wrapper's `timeoutMs`; restore `err.message` logging.

**validation_commands**
`node --test test/cmux-dispatch.test.mjs test/cmux-preflight.test.mjs test/cmux-contract.test.mjs`

**discovery_context**
`test/cmux-dispatch.test.mjs` owns `setUpWorkspace`/`freshCmuxEnv`/`makeSpecFile` and **must not be imported from a new test file** (importing a test file re-registers its whole suite — backend-notes 2026-08-01), so browser tests live in it. `UNVERIFIABLE_VERBS` is derived from `VERBS` (`cmuxctl.mjs:346`), so `test/cmux-preflight.test.mjs:242-255` goes red by design. Fixture hostile cases are pre-seeded state flags, never env switches (`fake-cmux.mjs:401,495`). `cmux()` never throws on non-zero exit; `{ok, code, stdout, json, error}` is the convention.

#### Slice `be-12-02` — config key, sidecar, lock, singleton, dispatch wiring

`domain: backend` · `isolation: worktree` · `depends_on: [be-12-01]`

**files_in_scope**
- `/Users/x/Development/dev-team-claude-plugin/scripts/cmux/dispatch.mjs`
- `/Users/x/Development/dev-team-claude-plugin/test/cmux-dispatch.test.mjs`
- `/Users/x/Development/dev-team-claude-plugin/.claude-plugin/plugin.json` → `0.1.63`

**Work items**
1. `readCmuxPreviewUrl(configText)` + `PREVIEW_URL_LINE_RE` + the D8 validator, sited beside `readCmuxEnvFile` (`:123-137`), with the two deliberate-exclusion comments.
2. `ensurePreviewBrowser({ paths, workspaceId, initialSurfaceId, url, cachedMethods })` — the D4 resolution, entirely inside `withRecordLock`, with the **stated spawn-budget invariant comment** at the lock site.
3. The pre-create authority scan (its **own** fresh tree, never `:921`'s `liveTree`); worker-pane exclusion via `initial_surface_id` + same-workspace records' resolvable pane ids; three outcomes only (reuse / create / fail-closed); **no adopt**.
4. Post-create idempotence check + post-create pane check, both on the abandon path (no stamp, close attempted, loud line).
5. `<stateDir>/browser.json` read/write (IC-1).
6. The `dispatchCmd` hook with the four-part D7 trigger, sited between `mountDocTab` (`:1100`) and `setPhase('building')` (`:1107`), in a `try/catch` that logs and continues; the preflight-cache read mirroring `teardownCmd:1953`.
7. `dispatchCmd`'s returned JSON gains `preview` (IC-5).
8. `teardownCmd`: delete `<stateDir>/browser/` and `<stateDir>/browser.json` **before** `archiveOrDelete`.
9. A comment at `:764` recording that this slice deliberately declined to give `initial_pane_id` a reader.
10. **No `workspaceCmd` edit; `carried` untouched.**

**Tests**
*A/B, same fixture, one flag flipped:* key absent → **zero** `browser` invocations, no `browser.json`, and `deepEqual` of the written `workspace.json` against a pre-feature baseline.
*Singleton:* 0 free → create, stamped · recorded surface live → reuse, zero opens · recorded surface gone → create · `workspace_id` mismatch → create · ≥1 free browser, no record → **zero opens**, `preview_surface_ambiguous` · a same-workspace record's pane id unresolvable in the live tree while a free browser exists → `preview_topology_unverifiable` · a rung-2 doc-tab browser inside a worker pane neither blocks creation nor is adopted · a **collapsed** doc-tab pane is excluded via its record's `surface.pane_id` · the initial pane is excluded via `initial_surface_id`, and a reordered `panes[]` does not change the outcome · **no reachable path leaves two browser surfaces in one pane.**
*Concurrency (PR-1 hold condition):* pre-created lock → zero opens, `preview_lock_contended` in the dispatch JSON, `code: 0` · `_simulateTreeHang` inside the section → the bounded tree returns `spawn_error` and the section aborts well under 30 s · after-tree showing a second free browser → **abandon** (no stamp, close attempted, `preview_double_create_detected`, `code: 0`) · recovered pane in the worker-pane set → abandon with `preview_landed_in_worker_pane`.
**Mutations that must go red:** remove the lock; narrow the lock to the write only; remove the idempotence check; remove any in-section `timeoutMs`.
*Trigger conjuncts, one at a time with the others held true:* non-worktree role → zero calls · `'Frontend'` and `'frontend '` → zero calls · preflight cache lacking `browser.open` / absent / unreadable / malformed → zero calls, `code: 0`, **exactly one** stderr remediation line. Dropping `domain === 'frontend'` must fail a test, or the issue's hard requirement is unverified.
*URL validator:* `@` refused · hostless forms refused · port > 65535 refused · `%` without two hex digits refused · trailing `\r` trimmed · **mutations:** unanchor the regex; swap the scheme allowlist for a denylist; make `readCmuxPreviewUrl` take-first on ambiguity — all red.
*Teardown:* on **both** branches (`shouldArchive` true and false), no file matching `browser/**` or `browser.json` survives; the preview surface id appears in the fake's `close-surface` log.
*Non-interactions:* `closeCmd`'s collapse decision unchanged with a live preview; `reconcile` rows unchanged.

**validation_commands**
`node --test test/cmux-dispatch.test.mjs test/cmux-preflight.test.mjs test/cmux-contract.test.mjs`

**discovery_context**
`withRecordLock` is at `record.mjs:834`, already imported at `dispatch.mjs:39`; the non-record precedent is worktrees.json at `dispatch.mjs:485,550`; it **steals** locks older than `LOCK_STALE_MS = 30 000` with no liveness check (`record.mjs:807-873`). `tree()` is unbounded today (`cmuxctl.mjs:224-230` → `:152`). `ensurePreviewBrowser` must take its **own** fresh tree; `:921`'s `liveTree` predates this dispatch's `createPane`/`mountDocTab`. `test/cmux-dispatch.test.mjs` `deepEqual`s the whole workspace-state object at 3459, 3492, 3500, 3584, 3762, 3777, 3790, 3873, 3887, 3940, 4110, 4142 — green under the sidecar, but grep before touching anything near them. `archiveOrDelete` **renames** stateDir (`:2015-2027`); `shouldArchive` is true if any outcome ≠ `'ok'` (`contract.mjs:253-259`). `spec.domain` is never schema-validated at dispatch (`:908`). `readJsonOrWarn` treats malformed as absent + a loud line (`:265-273`).

### PR 2 — gate evidence · `feat: cmux 4b browser-verify gate evidence, ADR-019; bump 0.1.64`

#### Slice `be-12-03` — reducer, `browser-verify`, full doc footprint

`domain: backend` · `isolation: worktree` · `depends_on: [be-12-02]`

**files_in_scope**
- `/Users/x/Development/dev-team-claude-plugin/scripts/cmux/browser-evidence.mjs` *(new)*
- `/Users/x/Development/dev-team-claude-plugin/scripts/cmux/dispatch.mjs`
- `/Users/x/Development/dev-team-claude-plugin/references/qa-gate.md`
- `/Users/x/Development/dev-team-claude-plugin/references/cmux-dispatch.md`
- `/Users/x/Development/dev-team-claude-plugin/commands/onboard.md`
- `/Users/x/Development/dev-team-claude-plugin/.claude/dev-team/config.md`
- `/Users/x/Development/dev-team-claude-plugin/test/cmux-browser-evidence.test.mjs` *(new)*
- `/Users/x/Development/dev-team-claude-plugin/test/cmux-dispatch.test.mjs`
- `/Users/x/Development/dev-team-claude-plugin/test/cmux-dispatch-doc.test.mjs`
- `/Users/x/Development/dev-team-claude-plugin/.claude-plugin/plugin.json` → `0.1.64`

**Work items**
1. `browser-evidence.mjs` (IC-3).
2. `browserVerifyCmd` + CLI wiring + `MUTATING_VERBS` membership **with the semantics comment** (D3).
3. **Workspace binding sited**, not merely asserted: `readJsonOrWarn(join(paths.stateDir,'workspace.json'), 'workspace.json')` → absent ⇒ `OperationalError('no workspace bound for this task — run \`workspace\` first')`, following `phaseCmd`'s shape at `dispatch.mjs:2043-2046`. The live `workspace_id` is what IC-1's equality check compares against.
4. The fixed D5 sequence with the IC-2 timeouts; screenshot siting, `mkdirSync`, `existsSync` confirmation; the ≤90 s budget comment.
5. Fix `dispatch.mjs:4` (name `COMMANDS`, no number) **and** the `:8-14` usage block (already missing `phase`; adding `browser-verify` would make it 2-of-9 stale).
6. Docs — `references/qa-gate.md`: the TRD-promised browser-verify row beside `cmux diff` (`:79-81`) as an **optional gate adjunct**; the invocation; the three report-line shapes; the prohibited wording; the ≤90 s budget; origin-only; the cross-read rule (a gate-time `no_preview_recorded` should be read against the dispatch JSON's `preview.reason`); the explicit "this is evidence, never a verdict input — the gate still branches on the parsed `{verdict, findings}` enum alone" sentence.
   `references/cmux-dispatch.md`: a `| browser <sub> …` §2 row noting the `complete` literal and the `js_error`/`navigation_timeout` shapes; a §2 footer note that `browser` is not capabilities-gated and why; a §1 paragraph on the preview singleton, `browser-verify`, and the `state save/load` non-goal; **not** the lifecycle-order line; and the fact that `rename-tab` is terminal-surfaces-only on 0.64.22.
   `commands/onboard.md` + `.claude/dev-team/config.md`: document `cmux_preview_url` (fenced examples only; this repo's key stays **unset**) plus the **dev/staging accounts only, never production or admin credentials** line.

**Tests**
*Reducer, both degenerates as a named comment block* (qa-notes 2026-08-02): `clean ⟺ stdout === CLEAN_LINE` and `clean = !stdout.includes('[error]')`. The second reads empty, whitespace-only, `null`, and a raw `Error: js_error: …` payload as CLEAN — exactly the stacked-undrivable live failure — so each of those four must assert `shape:'unrecognized'`, `clean:false`. Anchored/trimmed equality kills an `includes()` implementation on a page-authored line containing the clean literal as a substring.
*Count correctness:* `'boom\n    at foo.js:1\n    at bar.js:2'` → `count: 1` (kills `split('\n').length`).
*Leak test, positive first, same run:* (a) `browserErrorsList`'s raw return **contains** the seeded marker; (b) `console_errors.count === 3`; (c) the marker is absent from the JSON, from stderr, **and from every file under `stateDir` and `taskDir`**.
*Firewall:* inversion in **both** directions (add a repo import into `browser-evidence.mjs`; add a `browser-evidence` import into `ladder.mjs`) — the guard needs its own red. Plus `browserErrorsList` has **exactly one** call site outside its definition.
*Mutations red:* invert the unrecognized fail-direction; drop `existsSync` and trust the `OK` line (red against `_simulateScreenshotOkNoWrite`).
*Verb:* argv order exactly `errors clear → goto → wait → errors list → screenshot` · `load_state_confirmed:false` when `wait` fails, verb still `code: 0`, screenshot still emitted · dirty console → `code: 0` · `preview_present:false` for each of the three gate-time reasons → `code: 0` · refuses under `execution_mode: agent-tool` · refuses with no workspace bound · a configured origin differing from the recorded one navigates to the configured URL, warns **in origins only**, and does not rewrite the sidecar · ready-vs-never-ready runs have an identical **key set**, differing only in `load_state_confirmed`, `warnings`, `screenshot_path` · no full URL appears in any field, log line, or the sidecar.
*Doc tests — **red-first requirement** (Should Fix 9):* `test/cmux-dispatch-doc.test.mjs` is literal-pin-only, so each new doc claim needs its own explicit assertion added, and the coder must observe each new assertion **fail before the doc edit lands**. Pin: "screenshot captured" present and "verified rendering"/"renders correctly" absent; the ≤90 s budget; origin-only; the dev/staging-credentials line; the `browser` §2 row; the cross-read rule; and that `browser-verify` does **not** appear in the lifecycle-order line.

**validation_commands**
`node --test test/cmux-browser-evidence.test.mjs test/cmux-dispatch.test.mjs test/cmux-dispatch-doc.test.mjs test/commands.test.mjs test/cmux-contract.test.mjs`

**discovery_context**
`onboard.md` is already in `CMUX_WIRED_SURFACES` (`test/cmux-contract.test.mjs:614-619`) — **no A9-guard narrowing needed**. `MUTATING_VERBS` has exactly one consumer and **no test references it** (grep — definitive). `phaseCmd:2043-2046` is the binding-refusal shape to copy. `references/qa-gate.md:79-81` is the `cmux diff` section to sit beside. `triage.mjs` (69 lines) is the reducer + firewall model. A `config.md` fenced example is safe because the reader strips fences, but a bullet like `- **\`cmux_preview_url\`** — …` also does not match `^cmux_preview_url:`.

**Ship-time only:** the full `node --test` suite (~780 tests, ~60 s) runs once at `/dev-team:ship`, never in a slice lane.

---

## §6 Acceptance criteria

1. With `cmux_preview_url` **absent**, behavior is byte-identical to today: zero `browser` invocations on any dispatch, no `browser.json`, and `deepEqual` of the written `workspace.json` against a pre-feature baseline.
2. `contract.mjs` is byte-identical across all three slices (`git diff --stat` shows it untouched); `CMUX_ALLOWS` remains the frozen two-element list.
3. `workspace.json` gains no key and `workspaceCmd` is untouched in the diff.
4. The singleton has exactly three outcomes — reuse, create, fail-closed — and **no adopt path exists**. A free browser surface with no valid record never becomes a preview.
5. No reachable path leaves two browser surfaces in one pane. Two concurrent frontend dispatches produce **at most one** `browser open` across both processes; the loser skips with `preview_lock_contended` and exits `code: 0`.
6. Every spawn inside the lock's critical section carries an explicit `timeoutMs`; the stated worst case (19 000 ms) is asserted against `LOCK_STALE_MS` in a test, and removing the lock, narrowing it to the write, or removing the idempotence check each turns a test red.
7. A rung-2 doc-tab browser inside a worker pane neither blocks creation nor is ever adopted, including after ADR-004 collapse leaves it alone in its pane.
8. Every `browser open` argv contains `--focus false`; no browser wrapper issues any focus verb (source-text assertion).
9. **`teardownCmd` performs exactly one teardown-specific deletion** — `<stateDir>/browser/` and `<stateDir>/browser.json` removed before `archiveOrDelete` — and a test asserts both are gone on **both** the delete and archive branches. The preview surface id appears in the `close-surface` log.
10. The preview surface's id is never sourced from cmux stdout; a fixture printing positional refs proves the parse path would fail.
11. No page-controlled byte reaches JSON, a log line, stderr, or disk outside the screenshot PNG — proven by the seeded-marker test across all three channels (JSON, stderr, every file under `stateDir` + `taskDir`), not by inspection.
12. Every browser wrapper's return type is `boolean` / `{ids}` / `null` except `browserErrorsList`, asserted by test; wrappers log the error **code** only, shape-guarded, never `error.message`.
13. Only the URL **origin** appears in any JSON field, log line, report line, or the sidecar. No full configured URL leaves the config file or the `goto` argv.
14. Every browser wrapper passes an explicit `timeoutMs` exceeding its cmux-side bound; `browser-verify`'s total budget is ≤ 90 s and is stated in `references/qa-gate.md`.
15. `--load-state complete` appears in every `browserWaitReady` argv; the literal `'load'` appears nowhere in `scripts/cmux/`; the fixture **rejects** wrong `--load-state` values.
16. `browser-verify` returns `load_state_confirmed`, exits 0 on a dirty console and on `load_state_confirmed:false`, and refuses (exit ≠ 0) without the execution-mode gate or without workspace binding.
17. Browser evidence never appears in any control-flow branch. `references/qa-gate.md` states so explicitly, carries the white-PNG caveat, forbids "verified"/"renders correctly", carries the dev/staging-credentials line, and notes that `clean (0)` on a never-loaded page is reachable — each pinned by a doc-test assertion the coder observed failing first.
18. The doc footprint is complete: `references/cmux-dispatch.md` §2 row + §1 prose (and **not** the lifecycle-order line), `references/qa-gate.md` browser-verify row (discharging TRD `:252`), `commands/onboard.md` + `config.md` key docs, `dispatch.mjs:4` and `:8-14` corrected.
19. Both PRs bump `.claude-plugin/plugin.json` and end their commit message with `; bump 0.1.NN`. The slice-0 memory commit is a `chore:` with no bump.

---

## §7 QA route

### §7.1 Wave order (both PRs)

`test-engineer` **first and alone** (mutation runs must not share a working tree with reviewers), then the 3-reviewer adversarial panel in parallel on the frozen tree — qa-notes.md 2026-08-03. Reviewers therefore also see the final tests.

### §7.2 PR 1 — panel

Lenses: **permission-boundary** / **cmux-surface-discipline** / **contract-coherence**.
**Blocking-class overrides (any one blocks regardless of majority):** any `contract.mjs` or `CMUX_ALLOWS` diff · any focus verb · any persisted positional ref · **any fail-open on singleton ambiguity** · **any lock-scope narrowing** (locking the write instead of the side effect) · any unbounded spawn inside the critical section.
**Hold condition (qa-lead, adopted): PR 1 must not merge with a reachable double-create.** Discharged by AC5 + AC6.

### §7.3 PR 2 — panel

Lenses: **ADR-002 data-plane boundary** (primary) / **cmux-surface-discipline** / **doc-contract-coherence**. The swap is a rename, not a scope deletion — lens 1 carries a **permission/exposure sub-charter**: `browser-verify`'s `MUTATING_VERBS` membership *is* the execution-mode authorization gate; `stateDir`-vs-`taskDir` siting is exposure reasoning; `onboard.md` is in `CMUX_WIRED_SURFACES`; and the `contract.mjs` byte-identity claim spans both PRs.
**Blocking-class overrides:** any page-controlled byte reaching JSON / a log line / stderr / disk outside the PNG · **`browser-verify` reachable without the execution-mode gate or without workspace binding** · any `contract.mjs`/`CMUX_ALLOWS` diff · **any screenshot written outside `stateDir`** · any teardown path that leaves a screenshot in `.archive`.

### §7.4 PR-2 live-acceptance gate (hard merge condition)

One **orchestrator-run live pass** against real cmux 0.64.22 of the exact sequence `errors clear → goto → wait --load-state complete → errors list → screenshot`, using `python3 -m http.server` in a scratch directory for a real `http://` origin — **happy path plus the stacked case** — with transcript-first evidence (qa-notes.md 2026-08-03: CLI output, on-disk artifacts; screenshots corroborating-only). While the harness is up, also resolve **A12**: does `browser open --workspace` reuse a pane containing a rung-2 `file://` doc-tab browser?

This supersedes an earlier claim in this package's history that live acceptance was impossible here. It is not: the repo has no dev server, but it does not need one. Both live scouts so far overturned a settled-looking assumption; shipping fake-only would be the largest residual risk in the plan.

### §7.5 Defer-PR-2 fallback, if the live pass fails

If the live pass contradicts the design (e.g. `errors list` is unreliable on an unfocused surface, or the sequence cannot complete inside 90 s), **PR 2 is held, not patched under time pressure.** PR 1 ships alone and is coherent by itself: an opt-in live preview, inert without the config key, with `browser-verify` absent. The written cost of that fallback, so it is a decision and not a drift:

> The gate keeps the status quo — no browser evidence, discharging neither TRD `:252` nor the D8 evidence clause, and issue #12 closes partially with an explicit follow-up. The real cost is that the **byte-reduction boundary stays unbuilt while the byte-provenance analysis is loaded in this package**; the next attempt will most likely be a hand-typed `cmux browser errors list` at a gate, composed under time pressure by the same agent that then decides bounce-vs-pass — the precise failure D3 exists to prevent. So the fallback is acceptable only with the reason recorded in `architecture-notes.md` and a re-entry trigger (the next frontend task in any consumer project), never as a silent drop. `browser-evidence.mjs` and its tests should still land with PR 1 if the failure is in the *verb sequence* rather than in the reduction, so the boundary survives the deferral.

### §7.6 Orchestrator-side, before any dispatch

Post the §11 comment to issue #12 (four items). Precedent: the superseding comment on #2, PRE-1C-VERIFY on #4.

---

## §8 ADR-019 — final assembled text

> **ADR-019 — The task-workspace browser is a singleton preview surface, dispatcher-created under a lock and dispatcher-driven at the gate; its page bytes are reduced before they exist as evidence, and they never gate a verdict.**
>
> **Status:** proposed · **Date:** 2026-08-07 · **Scope:** cmux execution mode, Phase 4b (issue #12, epic #15 D8) · **Supersedes:** nothing; refines TRD D8 (`docs/trd-cmux-execution-mode.md:565`) and discharges the `:252` `references/qa-gate.md` promise. **Number:** 019 is free — 014/015/016 are claimed by the parked deterministic-backbone epic #23 (`tasks/deterministic-backbone/architecture-package-v2.1.md`); 017 and 018 are ratified in this epic; v1's ADR-017–019 were absorbed into v2's 014–016, the same reasoning that freed 018; epic #39's sub-issues claim only ADR-007 (grep, confirmed firsthand).
>
> **Opt-in, off by default.** One config key, `cmux_preview_url`, read with the ADR-018 reader doctrine (fenced-block-stripped, one line or refuse-as-ambiguous, absent = today's behavior exactly). Scheme restricted to `http`/`https` by allowlist; userinfo (`@`) refused outright; hostless forms, out-of-range ports and malformed percent-escapes refused; refusals name the reason and the scheme, never the value. A preview is created only when the key is set **and** the spec's `domain` is exactly `frontend` **and** the role's isolation is `worktree` **and** the cached preflight's methods include `browser.open` — so backend-only tasks are structurally incapable of spawning one. An accepted consequence: a full-stack slice authored `backend` gets no preview.
>
> **`browser` enters `VERBS` as a single entry guarded by a frozen sub-verb allowlist** (`open goto wait errors screenshot` — no `eval`, `state`, `console`, `snapshot`, or interaction verbs), and **never enters `VERB_METHODS`**: that map is one-verb-to-one-method and cannot represent a five-method family, and the preview is non-load-bearing, so it must degrade loudly rather than hard-stop preflight on every dispatch including the ones that will never open a browser. Availability is read at the point of use from the already-cached `preflight.json` methods array, the way teardown reads `close_workspace_available`.
>
> **The created id comes from a tree diff, never from stdout.** `cmux browser open` prints `OK surface=surface:N pane=pane:N placement=split` — positional refs, which this repo may not persist and which renumber mid-session. Only `placement` is parsed, and only to be logged. `browser open` is chosen over `new-surface --type browser --url` because it is live-verified for an `http` URL with a UUID workspace, while the latter is unverified even for `file://`.
>
> **The singleton is a single-writer sidecar under a lock, with a mandatory pre-create authority scan and no adopt path.** The record lives at `<stateDir>/browser.json`, not in `workspace.json`: that file has one writer and five readers and is rewritten wholesale from `carried`, so a second writer there would be a lost-update race with `workspace --tier` and would force `workspaceCmd` to join the lock — a load-bearing change to a core verb for a cosmetic feature. Parallel `dispatchCmd` against one workspace is reachable today and `writeJsonAtomic` prevents torn writes, not lost updates, so the whole resolve→decide→create→verify→stamp runs inside `withRecordLock`, and **the lock spans the side effect, not the write** — locking only the stamp leaves both racers having created. Because `withRecordLock` steals any lock older than `LOCK_STALE_MS` (30 s) without checking holder liveness, and because `tree()` is otherwise unbounded, every spawn inside the critical section carries an explicit `timeoutMs` summing to a stated 19 s worst case, **and** a post-create idempotence re-scan detects a stolen-lock loser and abandons its own surface rather than stamping. Both halves ship: a budget cannot cover a misbehaving spawn timeout, and a detector cannot prevent the window.
>
> A pre-create fresh-tree authority scan is nonetheless mandatory, because `browser open --workspace` **reuses an existing browser pane rather than creating a second**, and two stacked browser surfaces are **both undrivable** (live-verified in both directions: `js_error`/`navigation_timeout` on `wait` and `errors list`, blank screenshot, while the identical single-surface flow in an equally unfocused workspace works). "Create because we have no record" is therefore a data-loss operation, not an idempotent one, and the singleton is an operational requirement, not hygiene.
>
> **There is no adopt outcome — this is deliberate.** The three outcomes are reuse (recorded surface corroborated against a fresh tree and a matching workspace id), create (zero free browser surfaces), and fail closed (any free browser surface with no valid record: skip, create nothing, log `preview_surface_ambiguous`, or `preview_topology_unverifiable` when a same-workspace record's pane id no longer resolves). Adopting a free browser surface would mean `browser-verify` issuing a `goto` against it — and if it were a `mountDocTab` rung-2 doc tab whose record went unreadable, or a pane that ADR-004's collapse-on-close reduced to a lone browser surface, that `goto` would **navigate a rendered return document away**. The cost of a wrong adopt is data loss; the cost of a wrong skip is one missing preview and a log line. Asymmetric costs settle it, and deleting the outcome also deletes the cmux-restart edge, the collapsed-doc-tab special case, and the unreadable-record case in one move — every residual in that family now degrades to a skip.
>
> Worker panes are excluded by UUID — the pane holding `initial_surface_id`, and every same-workspace dispatch record's resolvable `surface.pane_id` — **never by a surface title.** Titles were the first design and are live-falsified: `rename-tab` returns `not_found` on a browser surface, and a browser surface's `tree` title tracks the page hostname, i.e. it is navigation-controlled text. Selecting a topology target with page-controlled bytes is the boundary violation this ADR exists to prevent, so an available `http(s)`-vs-`file://` title heuristic is rejected on principle, not on capability.
>
> **The dispatcher is the only invoker at both ends.** `dispatchCmd` creates, in the cosmetic zone — a preview failure never fails a dispatch. A new orchestrator-invoked `dispatch.mjs browser-verify` verb collects evidence at the gate, documented in `references/qa-gate.md` beside `cmux diff` as an optional adjunct and deliberately kept out of the lifecycle-order line. No worker ever runs a `cmux browser` verb; `contract.mjs` and `CMUX_ALLOWS` are byte-identical; ADR-013's freeze holds. The issue's "driven by-ref by the validator" is reinterpreted: the dispatcher drives the surface by UUID and the *reduced* evidence reaches the validator's bundle as data — the validator itself has no cmux reach, so the reverted pane flip is not a dependency. Hand-typing the sequence was rejected for a stronger reason than convention: it pipes **unreduced page bytes into the orchestrator's own context** — the agent that composes the gate report and decides bounce-vs-pass — which is *closer* to control flow than the also-rejected Agent-tool validator. The `cmux diff` precedent transfers on the **permission half only** (orchestrator-invoked ≠ worker capability, no `CMUX_ALLOWS` entry); it does not transfer on output handling, because `cmux diff` renders to a GUI for human eyes while `errors list` lands in a model transcript. `browser-verify` joins `MUTATING_VERBS`, whose name misleads here: the set means "requires `execution_mode: cmux`", not "mutates a record".
>
> **Bounded spawns.** `cmux()` has no default spawn timeout. Every browser wrapper passes one explicitly, exceeding any cmux-side `--timeout-ms`, so a spawn kill (`spawn_error`) stays distinguishable from cmux's own bound (`js_error`, `navigation_timeout`). `browser-verify` states a total wall-clock budget (≤ 90 s): an unbounded verb at the gate stalls the orchestrator's interactive session, not a background job.
>
> **ADR-002 boundary, extended from screen frames to page bytes.** `browser errors list` output is task-controlled, prompt-injection-class text. `scripts/cmux/browser-evidence.mjs` reduces it in-process to `{clean, count, shape}` — a count and a closed three-value enum, never a message — and is import-firewalled from `ladder.mjs`/`triage.mjs`/`contract.mjs` by test in both directions, exactly as `triage.mjs` is. Unrecognized output fails toward *not clean*. Raw bytes never reach JSON, a log line, stderr, or disk. Wrappers log the error **code** only, shape-guarded to `^[a-z_]{1,32}$`, never the detail — a deliberate divergence from the house `err.message` pattern, because browser error details are page-influenced and `dispatch.mjs`'s stderr is an orchestrator-context ingress. Truncating or sanitizing the detail was considered and rejected: it bounds volume, not content. Likewise only the URL **origin** ever appears in JSON, a report line, or the sidecar — a dev URL can carry a token query param, and refusing to echo a value on the reject path while printing it on the accept path is the same leak.
>
> **Screenshot success is not evidence of a rendered page.** On a surface that never became ready, `screenshot` returns `OK` and writes a full-size white PNG; and a connection-refused navigation leaves the console **clean**, so `clean (0)` on a never-loaded page is reachable and reads exactly like success. `browser-verify` therefore reports `load_state_confirmed` — the `wait --load-state complete` result, the only non-vacuous liveness signal — alongside and never merged into the console reduction, and the gate report **suppresses any clean claim when it is false**. Report lines never say "verified" or "renders correctly": screenshot success means a file exists, nothing more. **None of this gates the verdict** — the gate branches on the parsed `{verdict, findings}` enum alone (D17); an unconfirmed load state and a dirty console are both evidence, and the verb exits 0. The orchestrator may exercise judgment after reading it; that is judgment, not a mechanical branch, and the distinction is stated in the doc and in the code because "fixing" it into a branch is the predictable regression.
>
> **Screenshots and the sidecar are deleted at teardown, not merely swept.** `archiveOrDelete` *renames* `stateDir` into `.archive` whenever any record's outcome ≠ `ok` — common on bounced tasks — so "swept for free" was false on the archive path and screenshots of an authenticated dev app would persist indefinitely, contradicting the exposure reasoning that put them in `stateDir` in the first place. `teardownCmd` performs exactly one feature-specific deletion, before archiving, tested on both branches.
>
> **`browser state save`/`state load` does not ship.** The same surface persists build→gate in one cmux instance, so the live session already carries auth; the verbs add value only across a cmux restart or a surface re-creation. Against that, state files are cookies and localStorage on disk in a `stateDir` reachable by a same-uid worker subprocess (G13) — precisely the residual ADR-005's addendum names, authenticated browser surfaces near worker panes. **The descope does not avoid that residual: PR 1 walks into it the moment a human logs into the preview.** What it declines is a *replayable on-disk artifact* that would let a file manufacture an authenticated surface with no human in the loop. Mitigation is documentary — `commands/onboard.md` and `config.md` state: log the preview into dev/staging accounts only, never production or admin credentials. *Re-entry condition:* an observed cmux restart **or surface re-creation** between build and gate that discarded an expensive login. At that point the design owes, per **ADR-003 Am.1 Rider E (confidentiality is bounded by lifetime, not achieved by location)**: the state file written immediately before `state load`, unlinked immediately after and on every abort path (the 1b nonce lifecycle verbatim), never logged, with an origin guard because `state save` throws `SecurityError` on `about:blank`. Mode-0600 and clever siting buy nothing against G13, and unlink-at-teardown is far too late — an earlier draft of this decision prescribed exactly that and was wrong.
>
> **`snapshot` is a named non-goal** — a large page-controlled blob with no reduction that is both non-vacuous and non-injecting.
>
> **Placement is cmux's default; no `move-surface` is issued.** No anchor-pane argument exists on 0.64.22, and moving the preview into the coder's pane would stack it as a tab and destroy the simultaneous visibility that is the point. Adjacency stays a human concern (the issue's own words); `--focus false` on create; the reported `placement` is logged for live acceptance.
>
> **The preview is invisible to the ladder by construction:** `reconcile`/`paneAlive` are record-driven and the preview is in no dispatch record; `closeCmd`'s collapse is pane-scoped and the preview has its own pane. No record-level invisibility mechanism was built — only regression tests pinning those non-interactions.
>
> **Distinguishing rule (why one thing is descoped and another pre-paid).** This ADR descopes `state save/load` for an unobserved need while shipping the gate half for an equally unobserved one. The rule: the byte-reduction boundary is judgment-dense and would be built **wrongly** under pressure later — a hand-typed sequence, at a gate, by the agent that then decides bounce-vs-pass. A credential-on-disk would be built **at all** only under pressure later. One is worth pre-paying; the other is not. Deferring the reduction boundary does not preserve the decision, it pre-decides it wrongly.
>
> **Frozen literals and platform facts (cmux 0.64.22, live-verified):** `--load-state complete` (`load` is invalid; accepted set is `interactive|complete`); `No browser errors` is the clean literal; error codes `js_error`, `navigation_timeout`, `not_found`, `invalid_params`, `invalid_state`, `not_supported`, plus `spawn_error` from a spawn kill; `rename-tab` is terminal-surfaces-only; `browser open` is fire-and-forget (~0.06 s) while `goto` self-bounds at ~15.5 s.
>
> *Why this ADR exists:* D8's ratified record was one line, and each of its three under-specified parts had a wrong-looking obvious answer — gate the family on one RPC method, let the validator drive the browser, save the session to disk. Each is recorded here with its rejection reason so a future slice does not re-derive them, and two mechanisms (a frozen tab title, a sanitized error detail) are recorded as *falsified* rather than quietly dropped.

---

## §9 Memory deltas

### `.claude/dev-team/memory/architecture-notes.md`

The §8 ADR-019 text, appended to the `## Entries` section, dated 2026-08-07, status `proposed` until PR 2 merges (then `ratified`, matching the ADR-017/018 pattern).

### `.claude/dev-team/memory/conventions.md` — four entries

> - **2026-08-07** — **A cmux verb family whose sub-verbs are argv tokens enters `VERBS` as ONE entry, is guarded by its own frozen sub-verb allowlist one level down, and never enters `VERB_METHODS`.** `VERB_METHODS` is a one-verb→one-RPC-method map, so a family (`browser` → `browser.open|goto|wait_for|errors|screenshot`) cannot be represented in it without gating five capabilities on one name — the exclusion is structural, not merely the non-load-bearing-verb policy. A single `VERBS` entry would otherwise unlock the whole family including `eval` and `state`, so the wrapper module asserts membership in a frozen `<FAMILY>_SUBVERBS` array and throws before any spawn, mirroring `runVerb`'s own check. Availability is read at the point of use from the cached `preflight.json` `methods` array (the `close_workspace_available` shape), never by widening the preflight gate. *Why:* extends the 2026-08-06 cosmetics rule from a policy argument to a structural one, and closes the over-widening the single entry would otherwise create. Source: ADR-019, issue #12 (`be-12-01`).
> - **2026-08-07** — **A created object's id is recovered by tree diff even when cmux prints one — printing an id is not a reason to skip `recoverNewId`.** `cmux browser open` is the one creation verb that prints its result (`OK surface=surface:6 pane=pane:5 placement=split`), and the printed ids are **positional refs**, which this repo may never persist and which were observed renumbering mid-session. Parse such a line only for non-identifying tokens (`placement`), log them, and discard. A fixture modelling such a verb must print the positional form verbatim, so an implementation that parses the id instead of diffing produces a non-UUID and fails. *Why:* the 2026-08-02 "all created-object id recovery goes through a tree diff" rule was justified by "no verb prints its id"; one now does, and the rule survives for a different reason (UUID-only persistence) that a future reader would otherwise not reconstruct. Source: ADR-019, issue #12 (`be-12-01`).
> - **2026-08-07** — **Every family of task-controlled bytes gets its own import-firewalled reducer module, and the "raw bytes never leak" claim is proven by a seeded-marker mutation test, never by inspection.** `triage.mjs` established the shape for screen frames; `browser-evidence.mjs` repeats it for browser console output. Rules: the reducer imports nothing from the repo and is imported by no decision module (`ladder`/`triage`/`contract`), asserted by a source-text test **in both directions**; exactly one wrapper returns the raw bytes and a test asserts it has exactly one call site (a JSDoc is a comment, not a control); the reduction is a count plus a closed enum, never a message; an unrecognized shape fails toward the *unsafe* reading; and a test seeds a unique marker into the hostile fixture and asserts it appears in neither the produced JSON, nor stderr, nor any file under `stateDir`/`taskDir`. **Sibling rule:** for an error family whose *detail* is influenced by the untrusted side, log the **code** only, shape-guarded to a closed pattern, and note the deliberate divergence from the house `err.message` pattern at the definition site — truncating or sanitizing the detail is not a substitute, because it bounds volume, not content. *Why:* "never logs the untrusted bytes" is vacuous unless removing the reducer fails a test (2026-08-02 mutation rule), and the second instance of a pattern is where it becomes a convention rather than a one-off. Source: ADR-019, issue #12 (`be-12-03`).
> - **2026-08-07** — **A create verb that silently *reuses* an existing target needs a pre-create authority scan, and a critical section that spans a spawn needs a stated spawn budget under the lock's own stale threshold.** `cmux browser open --workspace` stacks into an existing browser pane (`placement=reuse`) and stacked surfaces are both undrivable, so "create because we have no record" is a data-loss operation, not an idempotent one — verify a creation verb's collision behavior live before treating a duplicate as merely cosmetic. Where the guard is a lock: `withRecordLock` **steals** any lock older than `LOCK_STALE_MS` without checking holder liveness, and `cmux()` passes `opts.timeoutMs` straight to `spawnSync` where it is undefined by default — so every spawn inside the section carries an explicit bound, the worst-case sum is stated as an invariant comment at the lock site, and a post-side-effect idempotence re-scan detects the stolen-lock loser so it abandons rather than commits. Ship the budget **and** the detector: a budget cannot cover a misbehaving spawn timeout, and a detector cannot prevent the window. Prefer failing closed to adopting an unrecorded object whose misidentification would destroy data. *Why:* the lock alone read as sufficient until the stale-steal semantics and the unbounded `tree()` were traced together. Source: ADR-019, issue #12 (`be-12-02`).

### `.claude/dev-team/memory/backend-notes.md` *(post-ship, endorsed from the backend-lead consult)*

`workspace.json` has exactly one writer and five readers, and `writeJsonAtomic` prevents torn writes, not lost updates — a second writer belongs in its own single-writer sidecar under `stateDir`, not in the shared file · `cmux()` has no default spawn timeout · `withRecordLock` span + `RecordLockError` semantics (throws immediately, steals at 30 s, no liveness check) · code-only logging for page-influenced error families · `initial_pane_id` still has no reader, deliberately.

### `.claude/dev-team/memory/qa-notes.md` *(post-ship, endorsed from the qa-lead consult + the timing probe)*

Model the refusal, not just the success — frozen live captures per object type; a fake must reject wrong enumerated-literal values · "duplicate is merely cosmetic" must be live-verified before licensing a fail-open arm · `existsSync` proves a file, never a render — the wait result is the only non-vacuous liveness signal · **a negative result that looks like evidence of health must be checked against the not-loaded case** (connection-refused leaves a browser console clean, so "0 errors" on a page that never loaded reads identically to success).

---

## §10 Residual risks and named non-goals

**Unverified assumptions, all mitigated in-design, none blocking:**

- **A10** — the first `browser open` in a workspace always yields `placement=split` (a new pane). Mitigated by the post-create pane check: a recovered pane in the worker-pane set triggers abandon, not stamp.
- **A12** — does `browser open --workspace` reuse a pane holding a rung-2 `file://` doc-tab browser? Same mitigation; one command added to the §7.4 live pass.
- **A5** — `No browser errors` stability across cmux versions. The `unrecognized` arm fails toward not-clean.
- **A9** — **resolved definitively:** no test in `test/` references `MUTATING_VERBS` (grep). No drift guard exists; adding a member is a one-line change with no expected red.

**Accepted residuals, named:**

- **ADR-005's residual is entered, not avoided** (D6). A human logging into the preview creates an authenticated browser surface in the same cmux instance as worker panes. Mitigation is documentary (dev/staging accounts only). The page's JS runs in a WKWebView with no cmux socket access, so page bytes can reach us only through `errors list`, which is reduced to `{clean, count, shape}` and never logged — that is the bounded blast radius, and it is the security argument for the whole design.
- **Auth-walled apps make the evidence channel thinnest where the app is most interesting** — the preview lands on a login page, yielding `clean (0)` plus a screenshot of a login screen. Handled by non-overclaiming report lines and `load_state_confirmed`, not by adding verbs.
- **A full-stack slice authored `domain: backend` gets no preview** (D7 trigger, exact match).
- **A screenshot is page-controlled pixels on disk.** Nothing reads it mechanically; a human opens it; teardown deletes it on both branches.
- **This repo never exercises the feature in normal operation** — `cmux_preview_url` stays unset here. The §7.4 live pass is what covers the gap; a consumer project running a frontend task is the first real end-to-end.

**Named non-goals (do not re-litigate):** `state save`/`state load` (re-entry condition in §8) · `snapshot` as evidence · anchored/adjacent placement · any browser evidence gating a verdict · any worker-side `cmux browser` capability · any adopt path for an unrecorded browser surface · `browser eval`, `console`, `viewport`, and every interaction verb.

---

## §11 Issue #12 comment — draft, ready to post

> **Design record for #12 (4b), posted before dispatch.** Full package: `.claude/dev-team/tasks/issue-12/architecture-package-v2.md`; decision record: ADR-019 in `.claude/dev-team/memory/architecture-notes.md`. Four points in this issue's body change, each deliberately:
>
> **1. "Driven by-ref by the validator" is reinterpreted as dispatcher-driven at the gate.** The reviewer/validator pane flip shipped and was reverted on 2026-08-04 (two independent unfixed defects: the shared-worktree `clean` postcondition and `extractSection` runtime shadowing), so no validator runs in a pane, and a worker running `cmux browser …` would be a `CMUX_ALLOWS` widening — an ADR-013 amendment. Instead, a new orchestrator-invoked `dispatch.mjs browser-verify` verb drives the same surface **by UUID** and hands the validator's bundle and the gate report a *reduced* evidence tuple. `contract.mjs` stays byte-identical. This is not a workaround for the revert: hand-typing `cmux browser errors list` at a gate would pipe unreduced, page-controlled bytes into the orchestrator's own context — the agent that then decides bounce-vs-pass — which is closer to control flow than any validator would be.
>
> **2. `browser state save` / `state load` is descoped from this slice.** The same browser surface persists build→gate in one cmux instance, so the live session already carries auth; the verbs add value only across a cmux restart or a surface re-creation. State files carry cookies and localStorage — secrets on disk in a directory a same-uid worker subprocess can reach (G13) — which is exactly the residual ADR-005's addendum names. A written re-entry condition and the required lifetime-bounded design (per ADR-003 Am.1 Rider E) are recorded in ADR-019. To be explicit: the descope does **not** avoid that residual — a human logging into the preview enters it — so `onboard.md` and `config.md` will state: log the preview into dev/staging accounts only, never production or admin credentials.
>
> **3. "A split beside the frontend coder's pane" is best-effort, not guaranteed.** cmux 0.64.22 has no anchor-pane argument on `browser open`, `open-split`, or `new-pane`, and moving the preview *into* the coder's pane would stack it as a tab and destroy the simultaneous visibility that is the point. We accept cmux's default placement (observed `placement=split`), log what it reports, and issue no `move-surface` — adjacency stays a human concern, as this issue's own body says. Two live findings raised the stakes on the singleton itself: `browser open` **reuses** an existing browser pane rather than creating a second, and two stacked browser surfaces are **both undrivable**. The singleton is therefore an operational requirement, enforced by a `stateDir` sidecar under a lock plus a pre-create tree scan that fails closed on any ambiguity.
>
> **4. The whole feature is opt-in and inert in this repo.** It activates only on a new `cmux_preview_url` config key. Absent that key, every path is off and behavior is byte-identical to today — this repo has no dev server, so the key stays unset here and the feature ships exercised against the fake plus one orchestrator-run live acceptance pass (a `python3 -m http.server` origin) that is a hard merge condition on the second PR.
>
> **Delivery:** three slices, two PRs (`be-12-01` cmuxctl browser family + fixture, `be-12-02` config key + sidecar/lock singleton + dispatch wiring → PR 1; `be-12-03` evidence reducer + `browser-verify` + docs → PR 2), each PR through the 3-reviewer adversarial panel per the contract-freeze rule. This departs from the body's "one coder, one PR" for the same reason #11 did — the panel is per-PR, and the byte-reduction boundary deserves an undiluted one.


---

# Architecture Package v2.1 — ERRATA

**Appends to `architecture-package-v2.md`.** Mechanical corrections only; no design change. Each entry is edit-precise. Where an entry contradicts v2, this errata wins.

---

### E1 — Tree ownership: two trees, shared. *(Must Fix 1)*

The v2 text stated the tree count three different ways. **Resolution: `browserOpen` receives the before-tree and returns the after-tree**, so the critical section holds exactly **two** `tree` spawns.

**§4 IC-2, replace the `browserOpen` line with:**

```
browserOpen(url, { workspaceId, treeBefore })
  -> { surfaceId, paneId, placement, treeAfter } | null            //  5 000 ms
```

**§4 IC-2, add below the code block:** *`treeBefore` is supplied by the caller (`ensurePreviewBrowser`'s scan tree, already bounded at 3 000 ms) and `treeAfter` is returned to it, so the create path performs exactly two `tree` spawns and `browserOpen` performs none. This is the only wrapper that takes or returns a tree; the coupling is deliberate and is what makes §3 D4's budget invariant true.*

**§3 D2, replace** "then recovers the surface id and pane id by a before/after `tree` diff via `recoverNewId`" **with:** "then recovers the surface id and pane id via `recoverNewId` against the caller-supplied `treeBefore` and a single `tree` read it returns as `treeAfter`. `browserOpen` owns neither tree: the caller supplies the before-tree (its own scan tree) and consumes the after-tree for both id recovery and the post-create checks. **Two `tree` spawns per create, total.**"

**§3 D4, replace the budget table and the invariant sentence with:**

| Step inside the lock | Spawn | `timeoutMs` |
|---|---|---|
| scan tree — **also serves as `treeBefore`** | `tree({ all: true, timeoutMs: 3000 })` | 3 000 |
| `browser open` | `browserOpen(url, { workspaceId, treeBefore })` | 5 000 |
| after tree — **returned as `treeAfter`; serves id recovery, the idempotence re-scan and the pane check** | `tree({ all: true, timeoutMs: 3000 })` | 3 000 |

> **Stated invariant, as a comment at the lock site:** *the critical section performs at most three bounded spawns — two `tree` reads and one `browser open` — for a worst case of **11 000 ms**, leaving **19 000 ms** of margin under `LOCK_STALE_MS` (30 000 ms). Measured healthy costs are ~50 ms per `tree` and 0.06 s per `open`, i.e. 60–80× headroom per bound. The abandon close is deliberately outside this section (see E2). Any future spawn added inside must be bounded and this budget recomputed.*

Reuse and fail-closed paths cost one bounded tree (3 000 ms).

---

### E2 — The abandon close moves outside the lock. *(Must Fix 2)*

`closeSurface` takes no `opts` (`cmuxctl.mjs:872-875`) and its `requireTargetPresent` issues a bare `tree()`; neither is bounded, and threading a timeout through both would widen `be-12-01`'s surface for no safety gain. **Chosen fix: the close leaves the critical section.** It is idempotent, its target id is ours alone, and no mutual exclusion is needed — so it cannot contribute to lock theft.

**§3 D4, replace the post-create idempotence paragraph's final sentence with:** *"…→ **abandon**: the section releases the lock **without stamping**, and the best-effort `closeSurface` of our own surface is attempted **after release** (the `abandonOrphan` shape — 'close attempted', never 'closed'), followed by the `preview_double_create_detected` log line and `code: 0`. The close is deliberately outside the critical section: it is idempotent, its target is a surface only this process knows about, and keeping it out is what lets the budget stay at two trees. The winner's record stays intact, so the gate sees a valid preview."*

**§3 D4, post-create pane check paragraph, append:** *"— same placement as the idempotence abandon: decided inside the section on `treeAfter`, executed after release."*

**§5 `be-12-01` work items, item 3, append:** *"`closeSurface` is unchanged — no `opts` parameter is added."*

**§5 `be-12-02` work item 4, replace with:** *"Post-create idempotence check and post-create pane check, both decided inside the section on `treeAfter`; on either abandon verdict the section exits without stamping and the best-effort close runs after lock release."*

**§6 AC6, replace with:** *"Every spawn inside the lock's critical section carries an explicit `timeoutMs`; the section holds at most two `tree` reads and one `browser open` for a stated 11 000 ms worst case, asserted against `LOCK_STALE_MS` in a test; the abandon close is asserted to occur **after** lock release; and removing the lock, narrowing it to the write, removing the idempotence check, or moving the close back inside each turns a test red."*

---

### E3 — The fail-closed skip is not self-healing; the log line is the recovery mechanism. *(required addition)*

**§3 D4, outcome 3, append:**

> **This skip does not self-heal.** Every later dispatch re-scans, re-sees the same free browser surface, and re-skips — the preview stays off **for the remainder of the task** until a human closes the stray surface. The log line is therefore the entire recovery mechanism and must meet D1's remediation standard: it names **every stray surface UUID** and the exact command to clear it. Frozen shape:
>
> `ensurePreviewBrowser: <N> browser surface(s) outside this workspace's worker panes and no valid preview record — refusing to create a second (two stacked browser surfaces are both undrivable). Preview is disabled for this task until they are closed: cmux close-surface <uuid>[ · cmux close-surface <uuid>…]`
>
> `preview_topology_unverifiable` uses the same shape with its own leading clause naming the unresolvable record pane id.

**§5 `be-12-02` tests, Singleton block, replace the two ambiguity assertions with:** *"…→ **zero opens**, reason `preview_surface_ambiguous`, **and** one stderr line naming every stray surface UUID and an exact `cmux close-surface <uuid>` command for each · a same-workspace record's pane id unresolvable in the live tree while a free browser exists → `preview_topology_unverifiable`, same remediation-line assertion, plus the unresolvable pane id named."*

**§6 AC4, append:** *"and each fail-closed skip emits a remediation line naming every stray surface UUID and its `cmux close-surface` command."*

---

### E4 — Qualify the doc-tab-sibling non-interaction row. *(Should Fix 3)*

**§3 D7, non-interactions table, replace the `closeCmd`'s doc-tab collapse row's right-hand cell with:**

> `findDocTabSurface` is pane-scoped (`dispatch.mjs:1572-1584`), and the preview lives in its own pane — **except transiently on the A10/A12 landing path**, where a preview that lands inside a worker pane *would* be a browser-typed sibling there. The post-create pane check abandons that surface within the same `dispatchCmd` invocation, so the window closes before any `close` runs; but the row is qualified, not absolute, until A12 resolves in the §7.4 live pass. Unqualify it only then.

---

### E5 — A13: closing one stacked surface may not restore the survivor. *(Should Fix 4)*

**§7.4, append to the live-pass scope:** *"Third case: with two surfaces stacked, `close-surface` one of them and re-drive the survivor (`wait --load-state complete`, `errors list`, `screenshot`) — does drivability return?"*

**§10, add to the unverified list:**

- **A13** — closing the loser of a stacked pair restores the survivor's drivability. Assumed by the abandon path. *If false:* the abandon leaves a stamped-but-dead preview, which surfaces at the gate as `load_state_confirmed: false` with the suppression caveat — fail-safe, so **non-blocking**; the remedy would be to abandon *and* clear the sidecar so the next dispatch re-creates.

---

### E6 — AC1 vs IC-5: omit the `preview` key when no attempt was made. *(Should Fix 5)*

**§4 IC-5, replace the enum line and add a rule:**

> Dispatch-time enum: `preview_lock_contended`, `preview_surface_ambiguous`, `preview_topology_unverifiable`, `preview_double_create_detected`, `preview_landed_in_worker_pane`, `preview_capability_missing`.
>
> **The `preview` key is omitted entirely unless trigger conjuncts 1, 2 and 3 are all true** — i.e. it appears only when an attempt was actually made. This preserves AC1's byte-identity when `cmux_preview_url` is absent (the omitted-when-null precedent, `dispatch.mjs:785-790`), and avoids inventing a "not applicable" member for the backend-spec and non-worktree-role cases, which are structural non-attempts rather than outcomes. `preview_disabled` is **not** a dispatch-time member; it remains in IC-4's gate-time enum, where the gate genuinely observes it.

**§6 AC1, append:** *"…including the `preview` key's absence from `dispatchCmd`'s JSON."*

**§5 `be-12-02` tests, A/B block, append:** *"…and the dispatch JSON carries no `preview` key at all. Same assertion for a backend spec and for a non-worktree role with the key set."*

---

### E7 — Teardown deletion must cover the lock sidecar. *(Should Fix 6)*

`withRecordLock` creates `<path>.lock` (`record.mjs:835`), so a crash mid-section leaves `browser.json.lock` behind, which the archive branch would preserve.

**§3 D7, teardown paragraph, replace** "`<stateDir>/browser.json`" **with** "`<stateDir>/browser.json*` (the glob is load-bearing: `withRecordLock` writes a sibling `browser.json.lock`, which a crash can strand)".

**§5 `be-12-02` work item 8, same replacement.**

**§6 AC9, replace the file list with** "`<stateDir>/browser/` and `<stateDir>/browser.json*`" **and append:** *"The deletion is **unconditional, including under `--keep-artifacts`** — exposure of an authenticated app's screenshot outweighs the post-mortem value of the artifacts, and the dispatch records that carry the diagnostic value are unaffected."*

**§5 `be-12-02` tests, Teardown block, append:** *"…a stranded `browser.json.lock` is also gone on both branches; and a `--keep-artifacts` run still removes all three."*

---

### E8 — Restore two guard-removal mutations dropped in consolidation. *(Should Fix 7)*

IC-1 states both as contract; behavioral positives exist, but the mutation rule (qa-notes 2026-08-02) requires the guard-removal red.

**§5 `be-12-02` tests, Concurrency block, append to the mutation list:** *"drop the fresh-tree corroboration of the recorded `surface_id` (trust the sidecar alone); drop the `workspace_id` equality check — each must turn a test red."*

---

### E9 — Nits. *(Should Fix 8)*

**§4 IC-2**, move `browserErrorsList`'s bound into the code block so AC14 is checkable in one place:

```
browserErrorsList(surfaceId) -> string | null    // 10 000 ms; RAW page bytes; sole consumer reduceBrowserErrors
```

and delete the trailing prose sentence that stated it separately.

**§6 AC6, append:** *"The sum assertion is non-vacuous **only in combination with** the per-call hang tests: on its own it merely adds constants. The hang tests are what prove the constants are passed and enforced."*

**§1, append a one-line artifact decision for the panel:** *"**Artifacts:** ADR-019 (durable decision) + this execution plan. No PRD-lite (product behavior is fully specified by the issue body and TRD D8) and no standalone TRD (§§2–4 are the TRD-lite; a separate doc would be a second copy of the epic TRD's D8 row)."*

---

### E10 — Round-1 SF7b closed.

**§5 `be-12-02`, `validation_commands`, append as a comment:** *"`test/commands.test.mjs` is deliberately **not** in this lane: it carries no version or `plugin.json` assertions (grep, confirmed by the orchestrator), so the `0.1.63` bump needs no coverage there. It stays in `be-12-03`'s lane only for the `onboard.md` edit."*

---

### E11 — New residual from E2.

**§10, add to the accepted residuals:**

- **A14 — the abandon close is unbounded.** `closeSurface` takes no `opts` and its `requireTargetPresent` issues a bare `tree()`. Moving the close outside the critical section removes the lock-theft risk entirely; the remaining failure mode is a stalled `dispatchCmd` return in the cosmetic zone, requiring cmux itself to hang on `close-surface` — never observed. Adding `closeSurface(id, { timeoutMs })` is a named follow-up candidate, deliberately not shipped here: it would widen `be-12-01` beyond the browser family for a hazard that no longer touches correctness.
