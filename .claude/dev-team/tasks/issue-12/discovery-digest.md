# Shared discovery digest — issue #12 (4b: browser singleton, D8)

Assembled 2026-08-06 by the orchestrator from three sources: (A) a live cmux 0.64.22 probe run firsthand, (B) an inline design-record sweep, (C) an `Explore` runtime-map scout. All file:line refs against the current working tree.

## The task (issue #12, verbatim body)

> **Depends on Phase 3 (#7 #8 #9). Parallel with #11. One coder, one PR** (`feat: … ; bump 0.1.NN`).
>
> One browser surface per task workspace, in its own pane (simultaneous visibility is the point — code left, preview right):
> - **Build phase:** created as a split beside the frontend coder's pane (live preview of the app under work).
> - **QA gate:** the SAME surface is driven **by ref** by the validator — `cmux browser <surface> snapshot / wait / errors list / screenshot` — no visual moving; agents address by UUID, adjacency is a human concern.
> - Session/auth continuity via `browser state save` / `state load` (one login flows from "coder previewed it" to "QA verified the same thing").
> - The gate report for frontend tasks gains browser-verify evidence: console-errors-clean + a screenshot path.
> - **Never spawned for backend-only tasks.** Singleton rule: at most one browser surface per workspace; teardown closes it with the rest.

Dependencies all shipped: #7 (PR #31), #8 (PR #32), #9 (PR #33), #11 (PRs #36/#37/#38). Ratified design depth: the TRD's whole D8 record is one line (`docs/trd-cmux-execution-mode.md:565`) + the additive-gate-evidence clause (`:486`) + a promised-but-unwritten `references/qa-gate.md` browser-verify row (`:252`). Everything else — lifecycle, singleton mechanism, evidence shape, invoker — is an open architecture decision.

## A. Live cmux 0.64.22 probe (firsthand, this session)

- `cmux browser open <url> --workspace <ref> --focus false` → `OK surface=surface:N pane=pane:N placement=split` (parseable single line). Verb family per `cmux browser --help`: `open|open-split|new`, `goto`, `snapshot`, `wait` (`--selector/--text/--url-contains/--load-state/--function`, `--timeout-ms`), `screenshot [--out <path>]`, `console <list|clear>`, `errors <list|clear>`, `state <save|load> <path>`, `eval`, `viewport`, plus interaction verbs. Surface addressing: `--surface <id|ref|index>` or first positional token.
- **No native singleton:** a second `browser open` in the same workspace returned `OK surface=surface:6 pane=pane:5 placement=reuse` — a SECOND browser surface stacked into the same pane. Singleton is entirely ours to enforce. Observed `placement` values: `split` (first), `reuse` (subsequent).
- **No anchor-pane argument** on `open`/`open-split` (nor on top-level `new-pane`): "beside pane X" requires either accepting default placement (first open split beside the currently-relevant pane in the probe) or a post-create `move-surface`/`split-off`.
- `cmux tree --id-format both` labels surfaces `[browser]` / `[terminal]` with UUIDs — the detection substrate for singleton + teardown discovery. (NB: `list-pane-surfaces` did NOT show the browser pane's surfaces in the probe — `tree` is the reliable view.)
- **Evidence output shapes (the parsing contract):** `errors list` clean → the literal line `No browser errors`; dirty → `[error] <message>` lines (prose, not JSON). `console list` mirrors (`No console entries`). `screenshot --out <path>` → `OK <path>` and writes the PNG. `state save <path>` → `OK` on a real origin; on `about:blank` → `Error: js_error: SecurityError: The operation is insecure.` (no origin → no storage access). Guard state-save against pre-navigation surfaces.
- `close-workspace` closes browser surfaces with the workspace; `close-surface --surface <ref>` works for surgical close. Top-level `open <path-or-url> --workspace --pane` also exists.
- Known WKWebView gaps (`not_supported`): `browser.network.route|requests`, `browser.trace`, `browser.screencast`, `browser.geolocation/offline`, `browser.input_*` (from vendored skill commands.md).

## B. Design-record constraints (operative rules, with sources)

1. **ADR-013 freeze:** `contract.mjs` (`CMUX_ALLOWS`, `GRANT_TOKENS`, `PANE_ROLES`, …) must stay byte-identical unless a worker-permission surface deliberately changes. `CMUX_ALLOWS` is exactly `['Bash(cmux notify *)','Bash(cmux wait-for -S *)']`. The `cmux diff` precedent (`references/qa-gate.md:79-81`, conventions.md 2026-08-04) establishes: a human/gate surface invoked BY THE ORCHESTRATOR (or dispatcher) needs no allow-list entry; a WORKER running `cmux browser …` itself is a `CMUX_ALLOWS` widening = ADR-013 amendment + adversarial panel.
2. **Validator reality:** the reviewer/validator pane flip was shipped-then-REVERTED 2026-08-04 (dirty-worktree `clean`-postcondition defect + `extractSection` runtime shadowing — both unfixed, need design; architecture-notes 2026-08-04, backend-notes 2026-08-04). `build-validator`/`code-reviewer*` are `pane:false` today and run as Agent-tool subagents. The issue's "driven by-ref by the validator" cannot mean a pane-dispatched validator worker running cmux verbs; the workable readings are (a) orchestrator-invoked browser verbs feeding evidence into the gate, and/or (b) an Agent-tool validator with Bash — but note Agent-tool subagents CAN run Bash(cmux…) unsandboxed by roster profiles; whether that's acceptable is a design decision to make explicitly.
3. **ADR-002 boundary (amended by the triage precedent, architecture-notes 2026-08-06):** no task-controlled bytes in a return, no screen-derived value in a control-flow branch. `read-screen` auto-fire is legal because `triage.mjs` reduces the frame to `{lines, last_line_sha256, matched:[closed-enum ids]}` in-process, frame text never persisted, and `triage.mjs`↔`ladder.mjs` are import-firewalled by test. **Browser console/errors/snapshot output is page-controlled bytes — same prompt-injection class.** "Console-errors-clean" as a gate-report line derived from `errors list` output needs an explicit boundary treatment (closed-enum/count reduction, or explicitly human-facing-only prose evidence).
4. **Verb-surface doctrine (conventions 2026-08-06):** cosmetic/diagnostic verbs enter `VERBS` but NOT `VERB_METHODS` (a `VERB_METHODS` entry = preflight hard-stop on older cmux; degrade-loudly instead). The complete `browser.*` RPC family IS in the frozen live capabilities capture (`test/fixtures/fake-cmux.mjs:196-217`), so gating is possible — but gate-evidence-bearing vs cosmetic tension must be decided. Also `VERBS` membership is per-verb; `browser` sub-verbs are multi-token (`cmux('browser', ['snapshot', ref])` fits `runVerb` mechanically — one `browser` entry covering all sub-verbs is a design call).
5. **UUID discipline:** persist UUIDs only, never positional refs; re-read a fresh `tree` before every topology action; fail closed on ambiguity (`findDocTabSurface`'s `{id, ambiguous}`; `RungAbortError`; `deriveTurnEndAt`'s N≥2-collision arm-none). `--focus false` is a five-times-stated invariant.
6. **Security context (ADR-005 addendum, tasks/issue-10/epic15-c9-adr005-addendum.md):** "do not keep authenticated admin browser surfaces in the same cmux instance where worker panes execute untrusted build code" — the residual risk named is literally workers driving logged-in browser surfaces. `browser state save/load` (auth continuity) sits directly on this warning; state files carry cookies/localStorage = secrets-on-disk (never log content; siting + lifecycle matter; stateDir sidecars are swept by teardown).
7. **Testing doctrine:** fake-cmux is env-switch + `_simulate*`-flag driven, zero test-specific conditionals; fidelity answers are frozen live captures; positives-first anti-vacuity (E-P1 pattern); mutation-resistant negatives; anything touching `scripts/cmux/*.mjs` routes to the 3-reviewer adversarial panel (qa-notes 2026-08-03). Doc footprint expected: `references/cmux-dispatch.md` §2 verb-table row + `test/cmux-dispatch-doc.test.mjs` assertion + the promised `references/qa-gate.md` browser-verify row.
8. **ADR-017:** no turn budgets; wall-clock `timeout_s` is the only bound. ADR-018 is the freshest workspace-creation-config precedent (config keys read fresh per `workspace` invocation, fenced-block-stripped, ambiguity-refusing, stamped once in `workspace.json` workspace-id-scoped, four named reuse-mismatch refusals).
9. **Gate report:** orchestrator-composed prose; branches only on parsed `{verdict, findings}` enums (D17, `references/qa-gate.md:65-77`); evidence lines are additive (TRD :486). `config.validate.full` runs once at ship.

## C. Runtime map (scout digest, verbatim)

[The full runtime map follows — file inventory, dispatchCmd/workspaceCmd cmux-invocation sequences, role/domain availability, resolve/record patterns, cmuxctl wrapper table, ladder/triage addressing, teardown flow, roster, gate composition, contract freeze, fixture pattern, and 13 gotchas.]

### C.1 File inventory

| File | Lines | Role |
|---|---|---|
| `scripts/cmux/cmuxctl.mjs` | 1274 | Single enumerated boundary to the cmux CLI. Frozen `VERBS` allowlist (`:25-30`), `VERB_METHODS` (`:41-64`), preflight, UUID lowercasing, tree-diff id recovery, all wrappers. Nothing else spawns `cmux`. |
| `scripts/cmux/dispatch.mjs` | 2137 | CLI, 8 verbs (`preflight workspace dispatch await close status teardown phase`). Only file spawning processes/touching git/measuring wall clock. |
| `scripts/cmux/resolve.mjs` | 643 | Pure resolution: roster merge, path derivations, grant expansion, env-file parser. |
| `scripts/cmux/record.mjs` | 936 | Record lifecycle, snapshotting, kickoff/env composition, `buildArgv`. |
| `scripts/cmux/contract.mjs` | 280 | Frozen constants + hand-rolled validator. ADR-013 target. |
| `scripts/cmux/ladder.mjs` | 748 | `collectFsState`/`classify`/`reconcile`/`evaluatePostcondition`/`validateReturn`/`renderReturn`. Pure. |
| `scripts/cmux/triage.mjs` | 69 | read-screen frame reducer, import-firewalled from ladder. |
| `scripts/cmux/adapter-claude.mjs` | 824 | Worker-side launcher. |
| `scripts/cmux/return-lint.mjs` / `return-gate.sh` / `gate-mode.sh` | 533/292/53 | Return lint + hooks. |
| Schemas | — | `dispatch-record.schema.json` (v2, additionalProperties:false, 38 required), `roster.schema.json`, `return-envelope.schema.json`, `signal-record.schema.json`. |
| `roster.default.json` | 145 | Shipped roster. |

### C.2 dispatchCmd (dispatch.mjs:876-1125) cmux sequence

1. `:921` `tree({all:true})` staleness check before any record write.
2. `:1018` `createPane({workspaceId})` → cmuxctl `:645-656`: `requireTargetPresent` (fresh tree) → tree-before → `cmux new-pane --workspace <uuid>` → tree-after → `recoverNewId` for pane AND surface (`new-pane` prints no id; ALL created-object ids come from before/after tree diffs, `cmuxctl.mjs:284-292`).
3. `:1057` `renameTab(surfaceId, '<icon> <role> · <model>')`.
4. `:1086` `sendLine(surfaceId, adapterLaunchLine)` → `send` + 30ms settle + `send-key enter`.
5. `:1098-1100` doc_tab roles: `mountDocTab`.
6. `:1107` `setPhase('building', {workspaceId})` — cosmetics in try/catch, never fail the verb.

workspaceCmd (`:651-819`): `ensureTeamWindow` (never the orchestrator's own window) → `ensureWorkspace` (`cmuxctl:599-643`, reuse-by-title fast path returns `created:false`; `cmux new-workspace --window <id> --name <taskSlug> --cwd <primaryCheckout> [--env-file] [--group <repoSlug>]` with `--group` retry) → `setWorkspaceColor(tier)` → `setPhase('planning')`. The workspace's initial surface is reserved, never reused by a dispatch (`:1015-1017`).

**Splits/adjacency: none exist today.** No split verb in `VERBS`. Geometry primitives in use: `new-pane`, `new-surface`, `move-surface --pane <id> --focus false`, `reorder-surface --before`. The live capabilities capture DOES list `surface.split`, `surface.drag_to_split`, `surface.split_off`, `browser.open_split` (`test/fixtures/fake-cmux.mjs:211,231,234`) — RPC exists, no CLI verb wired. Closest placement precedent: `attemptOpenRung` (`cmuxctl:977-1008`) — create, tree-diff id, `move-surface --focus false` if landed elsewhere, `reorder-surface --before`, `abandonOrphan` on placement failure.

**Role/domain at dispatch time:** role from `args.role` + roster (`:887-893`; gate `resolved.pane && PANE_ROLES.includes(role)`). Domain from the spec: `:908` parses the HandoverSpec whose schema REQUIRES `domain: frontend|backend|devops|qa` (`handover-spec.schema.json:6,10`) — **`spec.domain === 'frontend'` is the available, already-validated discriminator**; currently read and dropped (not in the record; record is additionalProperties:false so persisting it per-dispatch = schema event). Spec path is pinned to `specPathFor(paths, sliceId)` (`:901-904`).

**Refusal/degradation patterns:** throw-before-any-spawn for enum/arg violations (`:654-666`, cmuxctl `:755-839`); cosmetics degrade loudly never throw (`setStatus`, `readScreen`, `mountDocTab`); fail-closed on ambiguity (`findDocTabSurface`, `reorderDocTabFirst`, `presentReturn` `dispatch:1654-1662`); `RungAbortError` (`cmuxctl:947`); execution-mode gate on every mutating verb (`MUTATING_VERBS` `dispatch:585`, `assertExecutionModeCmux` `:587-595`).

### C.3 Config-key pattern (env-file precedent, the shape to copy)

Readers live in `dispatch.mjs` (NOT resolve.mjs — comment at `:96-112`): `stripFencedCodeBlocks` (`:119-121`, new readers strip; `readExecutionMode` deliberately doesn't); one regex per key (`:123-125`); `readCmuxEnvFile` (`:129-137`) — >1 line ⇒ OperationalError "ambiguous (a fenced example?), refusing", absent ⇒ null = today's behavior; `readEnvFileKeys` (`:146-167`); refusal messages name reasons never values (`:173-186`). File-level primitives in `resolve.mjs` (`ENV_FILE_RESERVED_*` `:450-482`, `parseEnvFile` `:562-632` — refuse-whole-file, read-once, sha256-of-validated-bytes). Consumed in `workspaceCmd` BEFORE `loadPreflightOrRefuse` (`:674-689`). Passed verbatim as one argv token (`cmuxctl:591-597,608`). Documented in config.md + onboard.md.

Dispatch-level config: `--config` JSON sidecar → `ctx.config` (`buildContext` `:357`): `worktree_prep`, `session` roster override, `maxGateBlocks`, `timeoutS`, `maxTurns`, `attnUpstream` (threaded `:952-965`). Roster 4-layer merge in `resolve.mjs:277-297`.

### C.4 workspace.json stamping (the pattern for recording a browser surface)

No schema — ad-hoc JSON at `<stateDir>/workspace.json`, `readJsonOrWarn` (malformed ⇒ absent + loud line, `dispatch:265-273`). **Rewritten WHOLESALE** at `:780-791`:
```js
const carried = { tier: resolvedTier }            // :779 — THE single merge point
const workspaceStateOut = { ...carried, window_id, workspace_id, initial_pane_id, initial_surface_id }
if (resolvedEnvFile !== null) workspaceStateOut.env_file = resolvedEnvFile   // no key at all when null
```
Load-bearing comments `:766-779`: always rewritten never write-once (cmux restart ⇒ new live ids; write-once = permanent wedge); anything not in `carried` is destroyed on the next `workspace` run. `env_file` block: `{path, sha256, recorded_at, workspace_id}` — **workspace-id-scoped**; stamped only when `created === true` (`ensureWorkspace` returns `created` for exactly this); reuse branch has four distinct named refusals (`:740-758`) + the silent-equal carry-forward.

### C.5 Record lifecycle

`buildRecord` `record.mjs:482-609`. Three-state monotone: create → `bindRecord` (`:880`, sets `surface` triple + `bound_at`) → `terminateRecord` (`:908`). `surface` = `(workspace_id, pane_id, surface_id)` UUID-pattern triple (`dispatch-record.schema.json:107-117`). `env` closed at 8 keys. `roster.snapshot.json` written once at first dispatch (`dispatch:977-979`); `roleDefForRecovery` (`:1611-1618`) prefers it — new role flags inherit the freeze automatically. Structural refusals in the builder (`assertStructuralPathInvariants` `record:431-449`, `assertNoNonce` `:171`, `resolveMaxTurnsOrThrow` `:458-471`).

### C.6 cmuxctl wrappers

`VERBS` (`:25-30`): `ping identify capabilities tree new-window new-workspace new-pane markdown move-surface reorder-surface send send-key rename-tab set-status close-surface close-workspace top events config wait-for new-surface read-screen clear-progress workspace-action set-progress`. `runVerb` (`:148-153`) asserts membership before spawning. **`browser` is not a member.** `VERB_METHODS` (`:41-64`): entry ⇒ preflight hard-stop if missing (`PREFLIGHT_MESSAGES.verb_missing` `:70-79,:439-445`); no entry ⇒ `UNVERIFIABLE_VERBS` (`:346`), never gated. `CMUX_BIN` (`:21`) the single seam. Result convention: `cmux(verb,args,{json,timeoutMs})` → `{ok, code, stdout, json, error}` — never throws on non-zero exit; `{json:true}` runs `normalizeIds` (lowercases every `*_id`). Key wrappers: `tree({all})` throws; `recoverNewId` throws unless exactly 1 new; `ensureWorkspace`; `createPane`; `sendLine` (charset allowlist `SAFE_LINE_RE` `:663-693` — refuses `?`/`&` so URLs can't ride `send`; `new-surface --url` bypasses via argv); `renameTab`; `setPhase` throw-before-spawn/`setStatus` degrade; `readScreen` never throws returns null; `closeSurface`/`closeWorkspace` never throw, no-op loudly when target gone, **never report success** (confirmation = fresh tree re-read; `surfaceExistsInTree` `dispatch:1591-1603`); `findDocTabSurface` `{id, ambiguous}`; `mountDocTab` (`:1025-1101`) 3-rung: markdown open → **`new-surface --type browser --url file://… --pane <id> --focus false`** (rung 2, `:1058` — nearest existing create-browser-surface call site, live-unverified, logged loudly, post-mount tree-verified) → own-pane markdown; `topTsv`/`readEvents`/`parseTurnEndEvent` never throw. `requireTargetPresent` (`:294-306`) fresh-tree re-resolve before every topology verb.

### C.7 ladder/triage addressing

`paneAlive` (`ladder:508-522`): identity is the full triple, never pane_id alone. `RECOVERY_ROWS` (`:486-501`) ten rows, six surface-liveness-discriminated. `classify({record, fsState, tree, now, turnEndAt, quietS=45})` pure; `tree===null` first-class. Turn-end attribution: `TURN_END_EVENT_NAME='agent.hook.Stop'` frozen `cmuxctl:1139`; `readTurnEndEvents` `dispatch:1211-1218` (one bounded `--after 0 --name … --limit 500 --timeoutMs 2000` read, ETIMEDOUT-kill = expected bound, keep partial stdout); `deriveTurnEndAt` `:1233-1265` — EXACT surface_id match vs non-terminal records; **N≥2 sharing a surface_id fails CLOSED, none arms, `surface_id_collision` logged (`:1246-1251`) — the closest singleton-invariant precedent.** read-screen auto-fire `:1421-1439` (transition-only, once per raise) → `detectSignatures` → logged only, frame never leaves scope. `safeTree(dispatchId, purpose)` `:1553-1560` degrades throwing tree() to null+line. `findVerifiedDocTabSibling` `:1572-1584` requires markdown/browser-typed candidate before authorizing permanent close.

### C.8 Teardown

`teardownCmd` `dispatch.mjs:1951-2001`: read preflight.json + workspace.json → `tree({all:true})` → find window→workspace → **flatMap every pane's every surface → `closeSurface` each** (`:1960-1963`) — **already closes any browser surface living in the workspace's panes** → `closeWorkspace` iff `close_workspace_available` → verify tree → archive-or-delete taskDir + stateDir wholesale (new sidecars swept for free; `sidecarPaths` `resolve:172-184` shows the `.collapsed` precedent — added to the object, swept free). Worktree reconciliation never `--force`. Ship wiring: `commands/ship.md:32-41` step 6 (refusal clause: never guess a slug). Per-dispatch `closeCmd` `:1671-1822`: non-doc_tab → flat `closeSurface`; doc_tab → collapse dance with double re-verify + `.collapsed` sidecar.

### C.9 Roster

Three profiles (`executor`/`validator`/`judgment`). `coder` = pane:true, doc_tab:false, executor, worktree, sonnet, json return. `build-validator` = **pane:false**, validator, haiku, markdown+Verdict. `code-reviewer(-deep)` = **pane:false**, judgment. Leads + plan-reviewer = pane:true, judgment, primary. **No frontend-coder role, no domain field on any role — domain lives ONLY in `spec.domain`.** Guards: `PANE_ROLES` (`contract.mjs:52`) deepEqual'd order-sensitively (`test/cmux-contract.test.mjs:479`) + set-equality vs roster (`test/roster.test.mjs:41-44`); `dispatchCmd:891` requires both. Every pane+markdown role's `required_sections` ↔ `agents/<role>.md` headings guard (`test/roster.test.mjs:68-81`).

### C.10 Gate report composition

**Orchestrator-composed prose; zero gate-report code in `scripts/cmux/`.** `references/qa-gate.md` (81 lines): `:5-9` inline validation; `:11-13` git scope (unfiltered `:57`); `:25-57` noise filtering (report repeats the one-line excluded-paths header, never filters itself); `:65-77` D17 verdict blocks (`return-lint.mjs` enforces on every cmux return; branch on parsed enum); `:79-81` `cmux diff` — orchestrator-invoked, hand-typed, no wrapper, explicitly no `CMUX_ALLOWS` entry. Validator output lands in the return envelope → parent-rendered `returns/<stem>.md` (no worker grant covers it). `references/cmux-dispatch.md`: `:45` doc-tab 3-rung chain; `:49` `phase --set gate`; `:51` four hand-typed attention moments (gate verdict is one); `:71-104` §2 verb table (`new-surface` row `:85`). Doc-drift suite `test/cmux-dispatch-doc.test.mjs` (103 lines) pins reference prose to dispatch.mjs source — **a new verb/wrapper is expected to land a §2 row + doc test.**

### C.11 Contract freeze

`contract.mjs` exports (closed-manifest deepEqual in `test/cmux-contract.test.mjs`): `BUDGET` (15 keywords; schemas can't express `propertyNames` — code is the layer), `TOOLS`, `DISALLOWED_TOOLS`, `CMUX_ALLOWS` (2 literals, byte-identical in every profile; asserted `resolve:407-410`, `record:519-523`, schema `:32`, test `:454`), `GRANT_TOKENS` (4), `OUTCOMES` (8+null), `WORKER_BLOCKED_STATUSES`, `BLOCKED_MARKDOWN_PREFIX`, `NONCE_PREFIX`, `PROTECTED_PATH_COMPONENTS`, `SIGNAL_LIMITS`, `SECTION_HEADING_RE`, `MODEL_ALIASES`, `SUBAGENT_ONLY`, `PANE_ROLES`, `SLICE_ID_RE`, `CMD_RE`, `validate`, `shouldArchive`, `slugify`. Schema-version doctrine: enum additions bump iff a consumer branches with a default/else; new fields on additionalProperties:false records are deliberate schema events; **workspace.json is schema-free and takes new keys freely (how `env_file` and `tier` landed).**

### C.12 Test fixture pattern

`test/fixtures/fake-cmux.mjs` (633 lines), the only fake binary. Env-driven only (`FAKE_CMUX_LOG` required — one `{ts,argv}` line per invocation incl. failures; `FAKE_CMUX_STATE` persisted topology; `FAKE_CMUX_FAIL`; `FAKE_CMUX_MISSING_METHODS`; …). **Hostile/degraded cases = `_simulate*` flags pre-seeded in state, never new env switches** (`_simulateConcurrentCreate` `:401` forces recoverNewId ambiguity; `_simulateBrowserSurfaceRelocateOnReorder` `:495` already gates on `type==='browser'`). Mixed-case UUIDs deliberately (`:76-82`). `LIVE_METHODS` (`:187-254`) = verbatim 255-method live capture **already including the full `browser.*` family** (`:196-217`) + `surface.split*` (`:231-234`) — no method names need inventing. `LIVE_TOP_TSV` verbatim. `new-surface` case `:433-463` (prints nothing — tree-diff recovery); unknown verb → `fail('unknown_verb')` `:629-631` — **a new `browser` verb needs a new case.** Harness (`test/cmux-dispatch.test.mjs`, 4198 lines): `CMUX_BIN` set before dynamic import; `freshCmuxEnv` deletes all `FAKE_CMUX_*` leakage; argv asserted element-by-element with exact counts; `makeSpecFile(ctx, sliceId, overrides)` default `domain:'backend'` (`:111`) — **`{domain:'frontend'}` is the one-line frontend fixture**; `setUpWorkspace(prefix, opts)` (`:163-170`) the entry point; anti-vacuity E-P1 asserted first (`:8-13,172-219`).

### C.13 Gotchas (scout's list, condensed)

1. `browser` not in `VERBS`; sub-verb membership model is a design call.
2. `VERB_METHODS` gating cuts both ways: entry = hard-stop on older cmux; absence = degrade. Gate-evidence-bearing vs cosmetic tension must be decided.
3. Singleton precedents: `deriveTurnEndAt` collision arm-none; `findDocTabSurface` `{id, ambiguous}` (ambiguous ≠ none — conflating them "is exactly the fail-open hole that let an ambiguous pane accumulate panels forever"); `RungAbortError`; `ensureWorkspace` reuse+`created` flag; `statusCmd` double-mount guard (`dispatch:1912-1927`).
4. `abandonOrphan` (`cmuxctl:959-967`) for created-but-unplaceable surfaces — says "close attempted", never "closed".
5. `closeSurface` never reports success — confirm via fresh tree.
6. `workspace.json` rewritten wholesale — a browser block must join `carried` (`:779`) and be workspace-id-scoped like `env_file` (`:713`).
7. Record is additionalProperties:false @ v2 — per-dispatch browser field = schema event; workspace.json is the schema-free home.
8. `spec.domain` read and discarded (`:908`) — later verbs (`close`/`teardown`/`status`) can't re-derive "was this frontend" without re-reading the spec or persisting the flag (e.g. in workspace.json).
9. `sendLine` charset refuses `?`/`&` — URLs can't ride `send`; argv-array verbs (`new-surface --url`, `browser open <url>`) bypass.
10. `--focus false` invariant, five statements.
11. `CMUX_ALLOWS` = 2 literals; workers denied `Bash(cmux *)`; `cmux diff` precedent = orchestrator-invoked gate surfaces need no entry.
12. TRD `:252` promises the qa-gate.md browser-verify row (unwritten); expected doc footprint = qa-gate.md row + cmux-dispatch.md §2 row + doc test.
13. ADR-005 addendum: authenticated browser surfaces + untrusted worker code in one cmux instance is the named residual risk — `state save/load` sits on it.

**Not swept by the scout:** `adapter-claude.mjs` internals, `return-lint.mjs` internals, `ladder.mjs:1-400`, `record.mjs:1-380,611-936`, bodies of preflight/ladder/record/resolve test files, `RECREATION-SPEC.md`, `worker-plugin/`.
