# Context digest — dev-team-claude-plugin repo internals (scouted 2026-08-03)

Repo root: `/Users/x/Development/dev-team-claude-plugin` · plugin version `0.1.48` · HEAD `0e21025` · clean tree.

Layout correction: there is no `hooks/spec-lint.mjs` etc. — `hooks/` contains ONLY `hooks.json`. All scripts live under `scripts/` (`spec-lint.mjs`, `task-cost.mjs`, `cmux/`, `pr-review-window.sh`, `trello.sh`). `tasks/` holds architecture packages, not a task queue.

## 1. Repo layout

| Path | Role |
|---|---|
| `.claude-plugin/plugin.json` | Manifest; `version: 0.1.48` (:3). **Bumped on every functional commit.** |
| `.claude-plugin/marketplace.json` | Own independent `metadata.version: 0.1.40` (:6) — stale by design, NOT kept in sync. |
| `.claude/dev-team/config.md` | This repo's own dev-team config (task_source = GitHub Project 3, validate.fast/full, review_defaults, `## current_task`, notes). |
| `.claude/dev-team/memory/` | Team memory: `conventions.md`, `architecture-notes.md` (ADR log), `{backend,frontend,devops,qa}-notes.md`. **Highest-value prior art — read conventions + backend-notes + qa-notes before designing.** |
| `.github/workflows/test.yml` | CI: setup-node **20** → `node --test`. No lint/typecheck step. |
| `agents/*.md` (14) | Agent defs w/ YAML frontmatter (`name, model, description, tools, effort`, sometimes `maxTurns, permissionMode`). Also the byte-stable pane prompt body in cmux mode. |
| `commands/*.md` (5) | `next, onboard, pr-review, ship, team`. Frontmatter `description:` required by test. |
| `coder-return.schema.json` | Coder return contract (§3). |
| `handover-spec.md` (84) | Spec template + conventions + 8-item self-check + worked example. |
| `handover-spec.schema.json` | Machine shape of the 11 fields. |
| `hooks/hooks.json` | Only file in hooks/. Two SessionStart entries (§2). |
| `orchestration.md` (67) | Core orchestrator rules, injected by SessionStart hook. **Hard 69-line ceiling enforced by `test/orchestration.test.mjs:9-13`.** |
| `package.json` | Dev-only, 8 lines (§2). |
| `RECREATION-SPEC.md` (37KB) | Harness-agnostic rebuild blueprint. Parts 1–3 mental model + harness primitives (P1…); 4–13 mechanisms; 14 build checklist. |
| `references/` | `tier3-planning.md` (37), `qa-gate.md` (35), `memory.md` (26), `cmux-dispatch.md` (91). Test asserts exactly ONE `cmux-*.md` (`test/orchestration.test.mjs:31-34`). |
| `scripts/spec-lint.mjs` (212) | Mechanical Handover Spec lint. |
| `scripts/task-cost.mjs` (113) | statusLine per-task cost readout. |
| `scripts/trello.sh` (188) / `pr-review-window.sh` (171) | Task-source helper / gh-dash → Ghostty+worktrunk PR review. |
| `scripts/cmux/` | The cmux runtime — **closest existing analog to a phase-chain runner** (§6). |
| `tasks/cmux-mode/*.md` (8, 2441 lines) | Architecture-lead/plan-review/spike output parked here. Naming: `<slice>-<artifact>.md`. |
| `team-build.workflow.mjs` (316) | Deterministic Workflow-tool pipeline (§2). |
| `test/*.mjs` (18 files + helpers + fixtures) | `node --test`; ~771 tests, ~60s (`config.md:36`). |

## 2. Node conventions

package.json: `{"type":"module"}`, no deps/devDeps/lockfile/engines. Node 20 floor implied by CI and `scripts/cmux/ladder.mjs:2`.

- **Zero-dependency is a hard invariant**: `conventions.md:24` — "This repo has no JSON-Schema validator and will not gain one… ajv would need node_modules, a lockfile and CI changes." Every cmux module restates "Zero dependencies: node builtins only."
- **No lint, no typecheck** (`conventions.md:12`).
- Style: no semicolons, 2-space, single quotes, `node:`-prefixed imports, long load-bearing header comment blocks stating the module contract + why (strong norm; a new runner must carry one).
- **Named exported constants for every refusal/usage message**, tests assert against the exported constant + a source-text drift guard (`qa-notes.md:12`).
- **CLI-as-library**: export pure functions + `invokedDirectly` guard calling `main(process.argv.slice(2))`. Gotcha `backend-notes.md:21`: the guard must `realpathSync` both sides or silently no-ops under symlinked paths (macOS TMPDIR).
- Error classes: `UsageError`/`OperationalError` (dispatch.mjs:139,146), `PreflightError` (cmuxctl.mjs:96), `StaleReturnError`/`RecordInvalidError`/`RecordLockError` (record.mjs).
- **Exit codes** (dispatch.mjs:19-21): one JSON object to stdout, human lines to stderr; 0 success, 1 operational, 2 usage/lock-contention.
- **Atomic writes mandatory**: tmp + `rename` in the destination dir, never rm-then-recreate. `conventions.md:28`: existsSync-then-rename is always a TOCTOU; exclusive create = `writeFileSync(tmp)` + `linkSync(tmp,dest)` (EEXIST = loser).

### spec-lint.mjs
Hand-rolled: 11 required field names duplicated as a literal (:18-21) — **does NOT read handover-spec.schema.json**; checks fields, path existence (`checkFilesInScope`), `file:line` resolution (`checkDiscoveryRefs`), command runnability (`checkValidationCommands`). Output: FAIL/WARN lines + `spec-lint: PASS|FAIL` summary; exit 1 on failures, 2 on usage. **Not wired into hooks.json** — invoked by the orchestrator by instruction (`orchestration.md:52`, `commands/next.md:37`). Known bugs (`backend-notes.md:17,22`): false-positives on absolute hyphenated paths and `path:line)` forms; double-extension filenames chopped wrongly; a to-be-created `dir/name.ext` in `discovery_context` hard-FAILs (:147-152) — workaround: cite new files by basename.

### task-cost.mjs
Reads statusline JSON from stdin; **prints nothing + exit 0 on any failure** ("a broken cost readout should never blank a statusline"). Hardcoded PRICING table + intro-pricing mechanism. Sums `$HOME/.claude/dev-team/task-cost/<session_id>.json` `since` → transcript assistant entries → `$X.XX`. Not auto-installed.

### hooks/hooks.json
Only SessionStart, two entries, order asserted (`test/hooks.test.mjs:13-17`):
1. No matcher — jq one-liner injecting `orchestration.md` as additionalContext; `DEVTEAM_WORKER=1` guard prints top-level `{"systemMessage": …}` and exits 0 (suppresses orchestration in worker panes).
2. `matcher: "clear"` — writes `{"since": ISO}` for task-cost.
No PreToolUse/PostToolUse/Stop hooks in the main plugin (worker plugin has Stop + UserPromptSubmit, §6). `backend-notes.md:23`: hook stdout processed only on exit 0; `systemMessage` is top-level.

### team-build.workflow.mjs (the existing deterministic chain)
Workflow-tool script body (globals `args, log, parallel, agent, pipeline`); `export const meta` first (helpers.mjs regex-strips it). LEAD map domain→agent; **unroutable domains rejected, not laundered** (architecture is not a workflow domain). Four FLAT inline schemas: SPEC_SCHEMA (:49-66), RETURN_SCHEMA (:68-82), BUILD_SCHEMA, VERDICT_SCHEMA (`{pass, findings[]}`). **:79-81: structured-output input_schema rejects if/then/allOf/anyOf/oneOf/$ref — schemas stay FLAT; status-conditional requirements enforced in prose + code, never schema** (guarded by `test/schema.test.mjs`). Review ladder in code: DEEP_TRIGGER_GROUPS (7 regex groups), RISK_FACTORS (5), `reviewRouteFor(spec)` (:130-138) — devops auto-adds infra; triggers≥2||risk≥3→adversarial, ≥1||≥2→deep, else standard. `runTask`: Stage 1 lead→spec; Stage 2 executor + **one** amend-retry on `insufficient`; Stage 3 gate (review tier + build-validator via parallel(); adversarial = 3 lenses correctness/security/rollback, majority≥2; build-validator advisory unless it reports failure). Dependency-wave scheduler (:258-293): ready = all deps finished; cycle ⇒ remaining failed; dep-not-passed ⇒ skipped; `parallel()` barrier between waves; `log("wave N: …")` is the test seam. **Known gap (`commands/team.md:12`): "the workflow can't run spec-lint mid-script — it relies on the schema's field-presence check + one amend-retry."**

### Tests
`node --test`, `node:test` + `assert/strict`. helpers.mjs: ROOT, loadWorkflowSource, listAgents, makeRunner, mockAgent, waves; re-exports MODEL_ALIASES from contract.mjs. Fixtures: `fake-cmux.mjs`, `fake-claude.mjs` behind `CMUX_BIN`/`CLAUDE_BIN` env seams, JSON-line invocation logs, env-switch-varied only; frozen live captures answer "what does the real system say" (`qa-notes.md:16`). CLI tests: `spawnSync(process.execPath, …)` over mkdtemp fixture + `node --check` parse test first. **Cross-file constant agreement via source-text extraction, never import** (`backend-notes.md:12`). Doc-enforcing tests: orchestration 69-line ceiling + 4 pinned substrings + exactly-one-cmux-ref; hooks byte-literals + 3 behavioral runs; commands frontmatter; agents name==filename, model ∈ MODEL_ALIASES or `claude-*`, workflow-referenced agents exist.

## 3. Contracts

### coder-return.schema.json (14 lines)
draft 2020-12, `additionalProperties:false`, required `[status, reason]`; `status` enum `[done, insufficient, blocked]`; `missing_context` (required-if-insufficient — **description only, not schema-enforced**); `changes[]` ("`<path> — <summary>`", required-if-done); `validation` (required-if-done). Conditionals live in prose + workflow prompt text only (flat-schema rule).

### handover-spec.schema.json (20 lines)
All 11 fields required: `task_id, domain (enum frontend|backend|devops|qa), goal, files_in_scope[], constraints[], acceptance_criteria[], validation_commands[], discovery_context, out_of_scope[], depends_on[], interface_contract`. `[]` = none for arrays, literal `none` for strings.

### Validation map
| Consumer | Mechanism |
|---|---|
| spec-lint.mjs | Does NOT read the schema; hand-rolled. |
| team-build.workflow.mjs | Inlines both schemas (duplicated, not imported) for structured-output `agent({schema})`. |
| scripts/cmux/* | `roster.default.json` sets `return:{kind:'json',schema:'coder-return.schema.json'}` for coder/test-engineer/doc-writer; `ladder.validateReturn` step 2 validates body with `contract.validate()`. **The one place coder-return is machine-validated. handover-spec.schema.json is machine-validated NOWHERE.** |
| test/schema.test.mjs | Both: valid JSON + no conditional keywords. Keyword-BUDGET walk applies only to the four cmux schemas (hardcoded list — an unlisted schema is checked by nothing). |

**No ajv. Only validator: `contract.mjs` `validate(schema, instance) -> Violation[]` ({path, keyword, message}).**

### handover-spec.md self-check (8 items)
concrete paths; discovery_context names every external symbol + pattern excerpt + file:line + gotchas; verifiable acceptance criteria; criterion↔command coverage; risky paths name negative/security checks; commands run + scoped; interface_contract if shape shared (producer authoritative); depends_on complete; assumptions stated. Items 1/3/6 = mechanical half (spec-lint's coverage); rest = orchestrator's semantic eyeball. Insufficiency caps: conversational 2 amend→rebuild cycles then escalate; workflow mode 1.

## 4. QA gate (references/qa-gate.md, 35 lines)
- Spec-anchored; reviewers get acceptance_criteria + diff.
- **Inv 1:** deterministic validation runs INLINE by the orchestrator (Bash), scoped fast lane, never full suite; `validate.full` exactly once at ship. build-validator = isolated-env/workflow mode; advisory only when no verdict; reported failure blocks.
- **Inv 2:** scope compliance via git (`status --porcelain`/`diff --name-only` vs files_in_scope); out-of-scope ⇒ changes-needed bounce.
- **Inv 3 bundle:** risk 0–1 no trigger → single code-reviewer (test-engineer only when behavior added/uncovered); deep trigger or risk≥2 → code-reviewer-deep + test-engineer parallel; stacked (≥3/multiple) → adversarial panel + test-engineer. Model pins: reviewer sonnet, deep+panel opus, build-validator haiku.
- **Ladder owned by qa-lead:** Standard → Deep → Adversarial (3 reviewers, odd majority; lenses correctness/security/rollback).
- Deep triggers: auth/authz, secrets, encryption, tokens, passwords, payments, PII; DB migrations/destructive; CI/CD/infra/prod; public API contract; security fix/incident/hotfix; domain=devops. Risk +1: multi-module, untested touched behavior, unclear rollback, complex control flow, cross-domain new feature.
- Always-block classes: auth bypass, cross-tenant, privesc, RCE, injection with reachable source→sink, prod secret exposure, destructive data loss, unsafe migration rollback, payment/PII leakage.
- Verdicts: lead with one-line `pass`/`changes-needed`; **no verdict ⇒ inconclusive ⇒ re-run scoped to diff, never assume pass**. Coverage-first + severity + confidence; only Must-fix blocks.
- Machine counterpart: cmux verdict block `{"verdict":"pass|changes-needed|inconclusive","findings":[{severity:"critical|warning|suggestion",file,line,summary}]}` — one fenced json block in Verdict section; enforced by return-lint.mjs (5 named violations).
- **Ladder exists in 3 copies** (qa-gate.md canonical trigger list per agents/qa-lead.md:31; qa-lead.md prose; workflow code) — a chain runner must decide which is authoritative.

### references/memory.md
Single writer (orchestrator), leads propose. Precedence code > project > global. Sequential writes only. Owning domain wins reconcile; architecture-lead wins conventions.md. Size: soft 150, hard ~300 → archive deprecated entries; combined lead read >500 → prune. Archive GC git-gated: >500 lines + ≥1 prior commit ⇒ FIFO-trim to ~250; never-committed ⇒ skip. Memory deltas committed BEFORE ship's push.

## 5. Orchestration rules (orchestration.md, 67/69 lines)
- Reference-file trigger table (:5-13) — read at trigger, never preload.
- Roles (:15-19): leads opus read-only no-Bash; runtime facts scouted by orchestrator and injected as verified facts. Coder sonnet execute-only returns `{status, reason, missing_context?, changes?, validation?}`. QA executors pinned (reviewer sonnet / deep opus / build-validator haiku / test-engineer sonnet); architecture team (architect opus, plan-reviewer opus, trd-reviewer legacy, doc-writer haiku, Explore built-in). Pins verbatim in `{agent type} ({model})` description prefix. Cmux roster overrides pins for pane:true; Explore always Agent-tool.
- Tiers (:28-33): T1 single-file → do it yourself; T2 multi-file one domain → lead; T3 ≥2 domains / new pattern / phased → architecture-lead. Propose in fixed template line and wait.
- Flow (:35-42): T2: lead → spec(s) → spec-lint → coder(s) → QA gate → memory deltas → summarize. T3: tier3-planning.md flow. Parallel coders only for independent specs; worktree isolation on overlap; ~4–6 cap → workflow mode beyond. Execution substrate (:42): cmux mode dispatches every pane:true role via dispatch.mjs, never Agent tool; join with `await --all` re-invoking until resolved; preflight failure = hard stop, remediation verbatim.
- Progress (:44-46): `→ {agent}: {what}` / ✓ / ✗; `{agent type} ({model})` prefix = pane tab title in cmux.
- Spec section (:48-54): leads get handover-spec.md path; leads return Assumptions & unknowns; **spec-lint two layers: mechanical (run it, don't eyeball) + semantic**; insufficiency loop ≤2 amend→rebuild then escalate with spec + both returns + concrete question; generalizable insufficiency → memory delta.
- Session hygiene (:64-68): one task per window; /clear after ship; cut window count, not depth.

**A chain runner would replace:** manual T2/T3 sequencing, manual spec-lint invocation, manual insufficiency counting, manual gate bundle selection. **Must respect:** read-only-lead boundary, narration prefix, single-writer memory, 4–6 cap, execution_mode routing, preflight-hard-stop.

## 6. cmux runtime (scripts/cmux/ — 13 files + prompts/ + worker-plugin/)

| File | Lines | Role |
|---|---|---|
| contract.mjs | 272 | Frozen contract + validator. `validate(schema, instance) -> Violation[]`; throws on schema-author error, returns violations on data error. BUDGET = 15 keywords. `shouldArchive` (fail-closed), `slugify` (throws on empty). Frozen: TOOLS, DISALLOWED_TOOLS, CMUX_ALLOWS, GRANT_TOKENS, OUTCOMES(8), WORKER_BLOCKED_STATUSES, NONCE_PREFIX, PROTECTED_PATH_COMPONENTS, SIGNAL_LIMITS {5/dispatch, 30s min, 200 chars}, SECTION_HEADING_RE, MODEL_ALIASES [opus,sonnet,haiku,fable], SUBAGENT_ONLY [architect,trd-reviewer], PANE_ROLES(7), SLICE_ID_RE, CMD_RE. **`schema_version` > schema's const ⇒ refuse whole doc, single `schema_version_too_new` violation, no other checks.** |
| resolve.mjs | 423 | Pure path/roster resolution; 4-layer roster precedence; `expandGrants` tokens→rule strings; taskPaths/stemOf(`<slice>.<attempt>`)/specPathFor/returnPathFor/signalsPathFor/recordPathFor/renderPathFor (single derivation site); assertSafePath. |
| record.mjs | 919 | Record lifecycle create→bind→terminate (atomic, monotone); per-dispatch worker-plugin snapshot; `buildArgv` (the ONLY argv source); isoMs; assertNoNonce; assertWithinDir (containment via path.join normalization). |
| cmuxctl.mjs | 976 | Single boundary to cmux CLI. `CMUX_BIN` env seam; frozen VERBS allowlist, no dynamic verbs; VERB_METHODS gated vs frozen live capture; PREFLIGHT_MESSAGES (5 byte-exact, single site + drift guard); normalizeId (uppercase→lower); tree/recoverNewId (before/after tree diff); preflight. |
| ladder.mjs | 723 | **Evidence layer — single authority on completion.** Detail below. |
| dispatch.mjs | 1549 | The CLI; only file spawning processes/touching git/measuring wall-clock. 8 verbs. |
| return-lint.mjs | 526 | Worker-side lint + single writer of `blocked` envelopes; thin over ladder.mjs; adds only the verdict-block rule. |
| adapter-claude.mjs | 824 | Worker pane process (`run <record>`). 5 ordered PRE-1C-VERIFY preconditions (validate record; sha256 role prompt; closed-manifest snapshot walk refusing extras/symlinks/non-regular; read-and-unlink nonce; nonce sweep of argv+env). `CLAUDE_BIN` seam. |
| return-gate.sh | 292 | Worker Stop hook. **Fails OPEN** on every dependency problem (`set -u` only); block-slot via noclobber exclusive create; ≤2 blocks then writes blocked return itself + exit 0. |
| gate-mode.sh | 53 | UserPromptSubmit: first = enforce, later = observe, sticky, atomic exclusive create. |
| prompts/return-contract.{json,markdown}.md | 24/48 | Worker-facing return contract. `backend-notes.md:24`: addendum text + its validator are ONE artifact, same commit; only prompt-byte edit permitted in such a slice (every edit invalidates judgment roles' cached prefixes). |
| worker-plugin/ | — | Per-dispatch snapshot skeleton: plugin.json + hooks.json wiring Stop→return-gate.sh, UserPromptSubmit→gate-mode.sh. |

### Schemas (typed-envelope prior art)
- **return-envelope.schema.json**: required `[schema_version(const 1), dispatch_id(UUID), slice_id(SLICE), attempt(1-99), role(kebab), produced_at(ISO), body]`, addProps false; `body: {"type":["object","string"]}` — validated in step 2. Description carries the two-step doctrine + schema-evolution rule.
- **dispatch-record.schema.json** (123 lines, const 2): 40 required fields; `return:{kind:'json'|'markdown', schema_path (plugin-root source), required_sections[], verdict_block}`; `profile:{name, permission_mode:'dontAsk', grants[], allow[], postcondition:'clean'|'changes_expected', postcondition_ignore[]}`; closed exactly-8-key env; outcome enum (8+null); monotone 3-state lifecycle.
- **signal-record.schema.json**: JSONL `{ts, level: progress|blocked|question, message(1-2000), escalate_to: lead|orchestrator|user}`; no dispatch_id (filename carries it).
- **roster.schema.json** (75): profiles/roles open-keyed maps — key sanitization code-side (propertyNames not in BUDGET).

### roster.default.json
3 profiles (executor/validator/judgment, "one profile per distinct grant-token set"); 11 roles; pane:true (7): coder, plan-reviewer, architecture-lead, backend/frontend/devops/qa-lead. Return kinds: coder/test-engineer/doc-writer json vs coder-return.schema.json; others markdown with required_sections (build-validator ["Verdict"]+verdict_block; reviewers ["Verdict","Must-fix","Notes"]+verdict_block; plan-reviewer ["Must Fix","Should Fix"]; architecture-lead ["Architecture Package","Recommended team dispatch","Proposed memory deltas"]; domain leads ["Handover Spec","Proposed memory deltas","Assumptions & unknowns"]; qa-lead ["QA Plan",…]). Precedence: default → ~ → project → session; **agents/*.md frontmatter is NOT a precedence layer in cmux mode** (prompt body + model/effort only).

### Two-step validation (ladder.validateReturn — never throws)
1 empty → `empty_return`; 2 JSON.parse fail → `invalid_json`; 3 envelope schema; 4 `checkIdentity` full four-tuple {dispatch_id, slice_id, attempt, role}, each mismatch a named violation, produced_at never compared; 5 `validateBody`: json → plain object + `schemaInWorkerWritableTree` guard + read/parse schema (`schema_unreadable`) + validate (`schema_tampered`, never propagated); markdown → non-string type violation / empty ⇒ MARKDOWN_BODY_EMPTY / `checkSections` (fence-strip first — ``` and ~~~, unclosed→EOF; level ≥2 case-folded anchored-PREFIX match; empty section = MISSING never vacuous).

### Completion/outcome
`isFresh` = `Math.floor(stat.mtimeMs) > Date.parse(record.created_at)` (strict, int ms). **completed ⟺ isFresh ∧ validateReturn().ok** — nothing a worker can write moves it. `collectFsState` lstat-based (symlink/dir at return_path ⇒ `return_path_not_regular_file`). `classify` pinned order: terminal (outcome≠null, never reopened) → completed → timeout (wall from created_at) → crashed (exit sentinel ∧ ¬completed) → attention (turn-end + 45s quiet + top idle, latched) → running. `.exit`/`.gate` never decide completion. `OUTCOME_MAPPING` single ordered table: worker_blocked → ok → exit_nonzero → timeout → invalid_return → no_return; `applyPostconditionOverride` (violated clean ⇒ refused_postcondition, never demotes non-ok). `reconcile`: 10-row RECOVERY_ROWS matrix, order load-bearing; **reports — the CLI decides**; tree/worktreeDirty are parameters. `evaluatePostcondition` filters porcelain vs postcondition_ignore globs, every ignored line returned. `relaySignals` enforces SIGNAL_LIMITS at relay; worker ts advisory, baseline clamped to now.

### dispatch.mjs verbs
preflight → workspace → dispatch → await → close --dispatch <id> → teardown; status read-only; `phase --set planning|building|gate` (workspace fires planning, dispatch fires building; **gate never fired from code — orchestrator invokes it**). `await` foreground chunked loop, re-invoked while `{status:'still-running'}`; --max-block-s floor 5s. Mutating verbs refuse without cached preflight.json. execution_mode: `['agent-tool','cmux']`, alias subagent→agent-tool, default agent-tool; **>1 `execution_mode:` line in config.md ⇒ refused ambiguous** (fenced example trap).

### Surfaces/gotchas
`cmux send` does NOT auto-submit (send then send-key enter); sendLine charset allowlist, **refuses rather than escapes**; uuids UPPERCASE normalized at ingestion; markdown open has no --json — id recovery via tree diff. Triage ladder: top --format tsv → read-screen (diagnostics only) → extend / one-line nudge / close-surface + re-dispatch new id reusing worktree. Teardown: tree → close-surface each → close-workspace → verify → archive/delete; worktrees removed only clean AND merged; never --force. Any file backing a live panel: tmp+rename, never rm-then-recreate. Doc-tab three-rung fallback, failure degrades to logged no-op. Shared context written once to task dir `context.md`, referenced by absolute path. Interjection ⇒ observe-mode sticky. Carve-outs: Explore stays Agent tool; workflow mode stays Workflow tool — **neither goes through dispatch.mjs**.

### Filesystem layout (cmux)
Root `~/.dev-team` (task_artifacts_root). TASK_DIR `<root>/tasks/<repo-slug>/<task-slug>/` = spec/ returns/ signals/ + parent render only. STATE_DIR `~/.dev-team/state/<repo-slug>/<task-slug>/` parent-side. spec per slice (no attempt); stem `<slice>.<attempt>` for returns/signals/render. Sidecars: .exit, .gate, .nonce (0600 read-and-unlinked), .signal-log. Worktrees `<root>/worktrees/<repo>/<task>/<slice>`, branch `dt/<task>/<slice>`, keyed to slice_id, reused across attempts, outside every checkout. **Never site agent-writable dirs under `.claude/ .git/ .vscode/ .idea/ .husky/ .devcontainer/`** (`conventions.md:20`) — dontAsk workers denied even with exact-match allow.

## 7. Gotchas
- **Version bump every functional commit** in `.claude-plugin/plugin.json`, commit ends `; bump 0.<maj>.<min>` (`conventions.md:11`, `config.md:57`). marketplace.json version stale by design. Commit sequence: `feat: … ; bump` → `chore: reconcile dev-team memory deltas — …` → `chore: clear current_task — …` (separate commits, per `commands/ship.md:18`).
- `## current_task` in `.claude/dev-team/config.md` is the task pointer (next.md writes, ship.md clears; doubles as handoff note). Task source = GitHub Project 3; run the stored `gh project item-list | jq` literally; epic exclusion by label/title.
- Validate lanes: fast = full = `node --test` (in practice fast = per-file filtering; bare node --test reserved for ship). ~771 tests ~60s (don't size against stale "87 tests" figure).
- Test conventions: positives-first; conjunctive predicates need named degenerate implementations + independence sweep with hand-written oracle; collector seams tested with real FS + utimesSync; mutation testing runs alone, revert from saved byte copy never `git checkout --`; parallel coders never run full suite mid-wave; new schemas must be added to test/schema.test.mjs's hardcoded list; orchestration >69 lines fails; hooks.json edits fail byte+behavioral tests; command w/o description fails; agent name/model rules.
- **Inertness guard** (`test/cmux-contract.test.mjs`, `architecture-notes.md:31`): exactly two surfaces may mention cmux/roster (orchestration.md, commands/team.md — closed deepEqual manifest); team-build.workflow.mjs, hooks.json, every other command must stay cmux-free. **A new cmux-aware command trips this guard.**
- No ajv ever; schemas inside 15-keyword BUDGET; minLength/maxLength out of budget (use pattern `\\S` / quantifiers). Prefer structural impossibility to test assertion; whitelist to blacklist. Validators throw on author error, return violations on data error; shape-check keywords before recursing. Violation = {path, keyword, message}. Slugs throw on degenerate input. Node never dispatches signal handlers while blocked in sync calls — sync supervisors write exit evidence on the sync return path. Sanitize reason strings interpolated into markdown (collapse newlines, strip leading fence) or blocked envelopes go invalid_return. NUL as separator makes files "binary" to grep. Idempotent mount/create loops resolve current state from the authority; absent vs ambiguous distinguishable, fail closed. required_sections reconciled TO the agent definition (agents/*.md never edited to fit roster); known exposure: extractSection first-match-wins under prefixing (`## Verdict summary` shadows `## Verdict`) — reconcile before flipping verdict_block roles to panes.
