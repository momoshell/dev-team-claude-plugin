# Architecture Package v2 (final) — cmux execution mode: spike reconciliation, ADR-003/005/006/009 amendments, ADR-012

**Author:** architecture-lead · **Date:** 2026-08-01 · **Supersedes:** v1 (`/Users/x/Development/dev-team-claude-plugin/tasks/cmux-mode/architecture-amendment-package.md`) in full
**Applies to:** epic #15 design record (TRD v2) · issues #1 (spike), #3 (dispatcher), #4 (profiles/argv), #5 (worker neutralization), #6 (task artifacts)
**Status:** reconciled against plan-review REVISE verdict (`/Users/x/Development/dev-team-claude-plugin/tasks/cmux-mode/plan-review.md`) and against the two live-test addenda in `/Users/x/Development/dev-team-claude-plugin/tasks/cmux-mode/spike-findings.md`. Read-only output — nothing written, nothing posted.

This document stands alone. Where it disagrees with v1, v2 wins; v1 should be treated as superseded in the design record, not as a companion.

---

## 0. Resolution of plan-review findings

| # | Finding | v2 disposition | Where |
|---|---|---|---|
| **MF1** | U2 is a live conflict; task dir under `.claude/` can't receive worker writes | **Resolved by design decision.** Task artifacts relocate to an external root `~/.dev-team/tasks/<repo-slug>/<task-slug>/`; ADR-006 amended. Verification probe S25c at the real path before 1a freezes. | §6, §10.3 |
| **MF2** | `$( )` composition bug reintroduces the failure class | **Resolved.** Hard rule 2: argv is a **string array** built programmatically; the doc block is illustrative only. Builder test per hard rule. Dual capability-probe branch dropped (SF18) — replaced by a fail-fast existence assertion. | §5, AC-3 |
| **MF3** | argv still carries `--disallowedTools "Bash(cmux *)"` | **Resolved.** v4 argv is byte-aligned with the shape S22f smoke-tested: **no cmux deny anywhere**, two precise cmux allows. Change-table row rewritten. | §5 |
| **MF4** | `Bash(cmux wait-for -S *)` lets a worker forge its own completion token | **Resolved.** Completion token becomes an unguessable per-dispatch nonce, delivered to the adapter by a **read-and-unlinked nonce file outside the task dir**, never in the worker's env/argv/kickoff/role body/task dir. Parent re-derives completion from the ladder on **every** wake regardless of which token released it. Acceptance test AC-8. | §7.1, §7.4, AC-8 |
| **MF5** | Nothing validates/rate-limits the signal; two emitters may fire | **Resolved via SF15.** Exactly one emitter for all roles: the worker. The worker plugin's PostToolUse hook is **record/attest-only, never emits**. Schema + rate limits become parent-side read-time enforcement (advisory at write time). Residual (unbounded worker-authored notify text) stated. | §8, R5 |
| **MF6** | §13 criterion 8 false by design | **Resolved.** Rewritten to transcript-testable form (attempt a third verb, assert `is_error=true`). | AC-7 |
| **MF7** | `git status` post-condition false-positives, then hard-resets | **Resolved.** Explicit ignore set; task dir now outside the repo so no carve-out is even needed; reset scoped strictly to the worker's own worktree with three identity assertions; **primary-checkout dirt never triggers an automatic reset** — it refuses and escalates. | §9.2 |
| **MF8** | Wrong subprocess vector; post-condition under-scoped to judgment roles | **Resolved.** Vector restated as `Bash(npm run …)`/`Bash(npm test …)` spawning repo-controlled scripts; post-condition extended to **all roles, every dispatch**; residual (writes outside the repo remain invisible) stated explicitly. | §9.2, R6 |
| **SF9** | Citation audit: G9/G11/G13 doc-only | **Resolved/partial.** G9 now **live-verified** (U2 probe). G11 and G13 marked doc-derived-unverified residuals with their consequences named. G5 membership: only `echo` confirmed on-machine → S25d enumerates it, because SF15 makes it the reviewer's real capability surface. | §4, §11 |
| **SF10** | `Glob(...)` in the ban list is unsourced | **Resolved by inversion.** The blacklist is replaced with a whitelist: path-scoped rules only for `Edit`/`Read`, command-pattern rules only for `Bash`; every other `Tool(arg)` form is rejected. No unsourced claim survives. | §5 hard rule 5 |
| **SF11** | A12 not fully verified; `notify *` wildcards its flag surface | **Adopted.** A12 downgraded to "executes + emits socket event, GUI visibility unconfirmed"; S25a = free GUI eyeball + `cmux notify --help` flag enumeration, with a tightening rule if any flag has side effects. | §11, §14 |
| **SF12** | A14 got worse; attention channel is prompt-dependent | **Adopted.** A14 re-stated: **the attention channel is best-effort and unreliable by construction; the `signals/` file record and the completion ladder carry every guarantee.** Written into the ADR-003 amendment, not just the assumption table. | §8, §10.1, §14 |
| **SF13** | Sequenced-token machinery unworkable; adopt fixed token | **Adopted.** Sequenced tokens dropped. Fixed per-dispatch attention tokens, delivered as **literals in the kickoff** (not env — the `-S "$VAR"` match form is untested, G8; noted as the reason for the choice). Two-phase parent await makes the design correct under either latch semantics. | §7.2, §7.3 |
| **SF14** | ADR-012 re-scope | **Adopted verbatim.** ADR-012 re-titled *"CLI permission rules are the primary enforcement layer; hooks enforce the invariants rules cannot express."* No PreToolUse hook on file tools in the default profile → the per-call latency risk disappears. | §9.1, §10.5 |
| **SF15** | Judgment roles get Bash + the two cmux allows | **Adopted, no blocker found.** `--tools` is now **identical across all roles**; profiles differ only in `--allowedTools`. Hook-relay emitter retired (kept as a documented contingency only). | §5, §8 |
| **SF16** | worker→orchestrator direct was silently narrowed | **Resolved — direct path designed, not narrowed.** The orchestrator's currently-armed attention token propagates down the dispatch chain and rides each worker's kickoff alongside the immediate dispatcher's. Worker→orchestrator is a first-class path. | §7.2, §7.3 |
| **SF17** | Unowned items (U8, U5, U3, `mcp__*`, `--disable-slash-commands`, plugin-root staleness) | **All owned.** U8 given a mechanical predicate + 1a owner; U5 orchestrator pre-post check; U3 + `mcp__*` + slash-commands folded into one **profile-closure smoke test** (S25d, slice 1c); plugin-root staleness resolved by **snapshotting the worker plugin per task into parent-side state**. | §7.5, §10.6, §11, §12 |
| **SF18** | Sections requiring rewrite before posting | **All rewritten.** §4 verdicts refreshed; capability-probe branch → fail-fast assertion; change table rebuilt; judgment-role variant reversed; v1 §7.2 **deleted** (its premise 1 is void); v1 §7.3 demoted to the `signals/` file contract; §8.2 Amendment 2 replaced with text consistent with the recorded memory entry; phase table, risks, assumptions and memory deltas all reconciled. | throughout |

---

## 1. Problem / goal

The Phase-0 spike (issue #1) returned five escalations against accepted TRD v2 text plus one user-ratified amendment to ADR-005/D9. Since v1 of this package, every platform question it raised has been answered live: S22a/b/c/e/f/g and S24 all passed with transcript or file evidence, Tests A/B validated the user-directed signal mechanism, and the U2 probe confirmed a hard, non-negotiable design break in the task-artifacts location.

**What is left is not measurement, it is design.** Slice 1a (contracts) is unblocked on platform gates and blocked only on four decisions: where task artifacts live, what identifies a completed dispatch, who emits the attention nudge and who validates it, and what the return post-condition actually checks. This package makes all four, rewrites the normative text they touch, and defines the residual verification set that runs alongside build rather than ahead of it.

---

## 2. Artifact decision

| Artifact | Needed? | Why |
|---|---|---|
| **ADR amendments** (ADR-003, ADR-005, **ADR-006**, ADR-009) | Yes | Four accepted ADRs change in substance. ADR-006's task-dir location is a hard break (MF1), not a refinement. |
| **New ADR-012** (enforcement layering) | Yes | "Which layer enforces what" is now a durable decision with a *different* answer than v1 proposed (SF14) — it must be recorded so the next editor doesn't re-add per-call hooks. |
| **TRD §5.3 patch** (composed argv v4) | Yes | The accepted block cannot execute; v1's replacement had a shell-composition bug. |
| **TRD §5.x addition** (token & identity model) | Yes | New normative content with no home in the accepted TRD: completion nonce, attention tokens, parent await loop. |
| **Verification set S25** | Yes, but **not gating 1a** | Five cheap checks, three of them free; two run before 1a's first commit, three inside 1c. |
| **PRD-lite** | No | No product/behavior ambiguity. The user's decision-3 ask is behaviorally clear and now mechanically ratified. |
| **New TRD/RFC** | No | This amends an accepted TRD. A second document forks the record. |

---

## 3. Ground truth (platform contract, current status)

Verification status is now first-class: **L** = live-verified on this machine (`claude 2.1.220` / `cmux 0.64.20`), **D** = doc-derived only.

| # | Fact | Status | Bears on |
|---|---|---|---|
| G1 | Path rules are consulted for `Edit(path)` / `Read(path)` only. `Write(...)`/`NotebookEdit(...)`/`MultiEdit(...)` rules are accepted but never consulted, and warn on stderr with remediation text: *"is not matched by file permission checks — only Edit(path) rules are."* `Edit` covers all file-editing tools. | **L** (S22b) | hard rule 5, builder fail-fast |
| G2 | `//path` = filesystem-absolute; a single leading `/` anchors at cwd. | **L** (S22a, by construction of the passing rule) | hard rule 4 |
| G3 | Precedence deny → ask → allow, first match wins; a deny cannot carry allowlist exceptions. | **D** + moot | why no cmux deny exists |
| G4 | A bare tool-name deny removes the tool from context; a scoped deny leaves the tool and blocks matching calls. | **L** (S10 follow-up, Test B) | `--disallowedTools` semantics |
| G5 | `dontAsk` runs: calls matching `permissions.allow`, the **built-in read-only Bash set**, and PreToolUse-hook-approved calls. Set is documented as `ls cat echo pwd head tail grep find wc which diff stat du cd` + read-only `git`. | **L for `echo`** (S22e arm 2 had to hook-override it); **D** for the rest | reviewer capability surface → **S25d** |
| G6 | `--allowedTools` is an allow-*rule* list, not a capability list; `--tools` closes the tool set. | **L** (Test A: `--tools "Read,Bash"` + one allow ⇒ everything else denied) | §5 |
| G7 | PreToolUse exit-2 / `permissionDecision:"deny"` blocks before rules and overrides the read-only auto-allow; `"allow"` permits a call no rule matches. | **L** (S22e arms 1–2) | ADR-012 |
| G8 | Bash argument-pattern rules are documented-fragile (spacing, variables, wrappers, `sh -c`, `eval`). Under an **allow-only** regime this cuts fail-*closed*. | **D** for the enumeration; **L** for the direction (Test A) | signal allows; token literal form |
| G9 | Protected paths are denied in `dontAsk` and `permissions.allow` does not override. `.claude/**` included (documented carve-out: `.claude/worktrees`). | **L** (U2 probe: exact-match `Edit(//…/.claude/dev-team/tasks/probe-test/returns/**)` ⇒ **denied**) | **MF1 / ADR-006** |
| G10 | `AskUserQuestion` is denied in `dontAsk` even if allowed. | **D** | justifies an out-of-band attention channel |
| G11 | `--add-dir` loads `.claude/skills/` and `.claude/agents/` from the added directory. | **D, unverified** | builder assertion (kept: cheap) |
| G12 | `--bare` skips auto-discovery of hooks/skills/plugins/MCP/CLAUDE.md; `--strict-mcp-config` without `--mcp-config` loads no MCP servers; `--tools` does not cover MCP tools. | **D** | S23, cost |
| G13 | Read/Edit rules cover built-in file tools and the file commands Claude Code recognises in Bash — **not arbitrary subprocesses**. Hooks see tool calls, not what a subprocess spawns. | **D, unverified** | post-condition, sandbox deferral |
| G14 | `--append-system-prompt-file` and `--system-prompt-file` **exist** on 2.1.220; they are simply absent from the main `--help` listing. | **L** (S22g; exercised in anger by S22f) | §5, ADR-009 |
| G15 | In `dontAsk`, **omission is denial** for anything outside the read-only set. A precise argument-scoped allow (`Bash(cmux notify *)`) is honored while sibling verbs stay denied. | **L** (Tests A/B, S22f) | the whole containment model |
| G16 | `wait-for` tokens are a **global namespace across workspaces**, in both orders (signal-then-arm latches). | **L** (S24, both directions) | every liveness signal |
| G17 | A plugin loaded via `--plugin-dir` fires `SessionStart`/`UserPromptSubmit`/`Stop` **and** `PreToolUse`/`PostToolUse` in a dispatched pane. | **L** (S11, S22e) | ADR-009, ADR-012 |
| G18 | The TUI's collapsed "Ran N shell commands" line counts **denied** attempts as ran. Permission verdicts must come from the session transcript (`~/.claude/projects/<slug>/<session>.jsonl`, `is_error`). | **L** (method correction) | every acceptance test |
| G19 | Whether a latched `wait-for` token is **consumed** by the first waiter (tmux semantics) or persists permanently is **not established**. S5 fired twice and armed once — ambiguous. | **Unknown** | await loop → **S25b** |

---

## 4. Finding-by-finding verdict (final)

| Spike finding | Final verdict |
|---|---|
| 1 — `--append-system-prompt-file` missing | **Overturned.** The flag exists (S22g); S8 read the wrong surface. Use the file form; ADR-009 byte-stability becomes trivial. |
| 2 — variadic swallow, `--` fixes it | **Confirmed, normative.** Hard rule 1, and already committed to `conventions.md`. |
| 3 — path-scoped grant "does not work" | **Overturned; v1's false-negative diagnosis proven.** S22a passed both directions with `Edit(//abs/**)`. The S9 test was invalid (rule kind + anchoring). |
| 4 — `--allowedTools` is not a closed allowlist | **Half right, wrong conclusion, now settled empirically.** `--allowedTools` is not a capability list (G6), but omission **is** denial outside the read-only set (G15). The corrective is `--tools` + precise allows — never "pair every allow with a deny." |
| 5 — replace beats append | **Reversed and now moot for the mechanism.** S16 was confounded (both arms carried the `orchestration.md` injection). Default is `--append-system-prompt-file`; re-test the A/B after isolation lands (S23). The surviving finding — hook-injected `additionalContext` survives a system-prompt replace — is the important one and stands. |
| 6 — `--plugin-dir` hook delivery | **Fully confirmed**, including `PreToolUse`/`PostToolUse` (S22e). |
| 7 — `new-surface --provider claude` dead end | Accepted; confirms terminal-surface + adapter. |
| 8 — no process-exit event | Accepted; standing constraint. Rank-2 EXIT sentinel is permanent. |
| 9 — cost ~2.1× / ~3.2× | Accepted risk signal; S23 supplies the levers before the Phase-2 GO/NO-GO. |

---

## 5. Deliverable 1 — §5.3 composed argv (**v4**, supersedes v2 and v1's v3)

### 5.1 Hard rules (normative, each with a builder test)

1. **A bare `--` immediately precedes the kickoff positional, always, on every dispatch.** Without it the pane starts, `SessionStart` fires, `UserPromptSubmit` never does, and the dispatch idles forever with no error and no downstream signal.
2. **The argv is a string array constructed programmatically in the adapter/dispatcher and passed to `spawn`/`execve` without a shell.** No `$( )` composition, no string concatenation, no word-splitting, no glob expansion anywhere in the path from profile → argv. **The code block below is illustrative only and is not the contract** — the array builder is. (MF2.)
3. **One array element per permission rule.** Never comma-join permission rules; a rule may legitimately contain a comma. `--tools` is the single exception and takes one comma-joined element.
4. **Every path inside a permission rule is `//`-prefixed and absolute.** The builder asserts and refuses to dispatch otherwise.
5. **Rule-kind whitelist:** path-scoped rules may name only `Edit` or `Read`; command-pattern rules may name only `Bash`. Any other `Tool(argument)` form is rejected at composition time. Runtime belt: the adapter greps the child's stderr for `is not matched by file permission checks` and fails the dispatch fast with the CLI's own remediation text. (This replaces v1's unsourced blacklist — SF10.)
6. **No cmux deny rule exists anywhere in any profile.** Exactly two cmux allows, byte-identical literals: `Bash(cmux notify *)` and `Bash(cmux wait-for -S *)`. Containment of every other cmux verb — including verbs future cmux releases add — comes from omission-denial (G15).
7. **`--append-system-prompt-file` is asserted to exist at adapter init** (probe by passing a nonexistent path: a real flag errors *"file not found"* before any API call; a fake one errors *"unknown option"*). Fail fast with remediation if it ever disappears. **No dual-composition branch** — the flag exists (G14) and a second code path is untested surface. (SF18.)
8. **Path assertions:** `TASK_DIR` and `WORKTREE` are absolute; contain no protected path component (`.claude`, `.git`, `.vscode`, `.idea`, `.husky`, `.devcontainer`); `TASK_DIR` contains no `.claude/` subdirectory (G11) and lies **outside every git checkout the dispatch touches** (§6); `WORKTREE` is not the primary checkout.
9. **Secret hygiene:** the completion nonce (§7.1) must not appear in the argv array, in the child process environment, in the kickoff, in the role body, or anywhere under `TASK_DIR`. The builder asserts this by substring scan over the composed argv and env map before spawn.

### 5.2 The block (illustrative — the array builder is normative)

```
# Inputs (all absolute, all asserted by the builder):
#   ROLE_PROMPT  <plugin-snapshot>/scripts/cmux/worker-plugin/../roles/<role>.txt
#                role body + static profile addendum, frontmatter stripped.
#                BYTE-STABLE per role (ADR-009). No per-dispatch value ever enters it.
#   WORKTREE     this dispatch's git worktree (executor roles)
#   TASK_DIR     ~/.dev-team/tasks/<repo-slug>/<task-slug>   (§6)
#   PLUGIN_SNAP  ~/.dev-team/state/<task-slug>/worker-plugin (per-task snapshot, §7.5)

claude
  --model                    <MODEL>
  --effort                   <EFFORT>
  --permission-mode          dontAsk
  --append-system-prompt-file <ROLE_PROMPT>
  --tools                    Read,Edit,Write,Glob,Grep,Bash
  --allowedTools
      Edit(//<WORKTREE>/**)                 # executor roles only
      Edit(//<TASK_DIR>/returns/**)
      Edit(//<TASK_DIR>/signals/**)
      Bash(cmux notify *)
      Bash(cmux wait-for -S *)
      Bash(npm run typecheck *)             # executor roles only, from profile config
      Bash(npm test *)                      # executor roles only, from profile config
  --disallowedTools          mcp__*  Task  Agent
  --strict-mcp-config
  --disable-slash-commands
  --plugin-dir               <PLUGIN_SNAP>
  --add-dir                  <TASK_DIR>
  --
  <KICKOFF>
```

### 5.3 Changes from the accepted v2 text, and why

| Change | Reason |
|---|---|
| `--` before the kickoff | S7/S9 silent-stall bug. Mandatory, 4 reproductions + fix confirmation. |
| `--append-system-prompt-file` kept (not replaced by an inline `$(cat …)`) | G14 — the flag exists on 2.1.220 and was exercised end-to-end in S22f. Keeps ADR-009 byte-stability trivial and avoids MF2's whole failure class. |
| append, not replace | S16 is confounded; a full replace discards Claude Code's tool-use scaffolding for no isolation benefit (the bleed is hook-injected `additionalContext`, which survives a replace). Re-test after S23. |
| `Edit(//abs/…)` everywhere; `Write(...)`/`MultiEdit(...)`/`NotebookEdit(...)` rules banned | G1 + G2, both live-confirmed. This is the actual fix for S9. |
| `Edit(//<TASK_DIR>/signals/**)` added | Carries the mandatory signal record (§8). |
| `Read(//<TASK_DIR>/**)` **not** added | Reads inside cwd + `--add-dir` never prompt, so `dontAsk` never denies them. A rule here would be noise. |
| **`--disallowedTools "Bash(cmux *)"` removed entirely** | **Superseded by the user-directed, live-validated mechanism** (Tests A/B, S22f; already recorded in `architecture-notes.md`). Deny + carve-out is impossible (G3); allow-only needs no deny list and fails closed by omission (G15). *This replaces v1's "no change to the cmux deny" row, which was false.* (MF3.) |
| `+ Bash(cmux notify *)`, `+ Bash(cmux wait-for -S *)` | The ratified attention channel. Exactly two verbs, enumerated. |
| `+ --strict-mcp-config`, `+ --disallowedTools "mcp__*"` | S14: panes inherit the ambient MCP set; `--tools` does not cover MCP tools (G12). Also a direct cost lever. Effectiveness asserted in S25d, not assumed. |
| `+ --disallowedTools "Task" "Agent"` | Belt for "no Task tool"; `--tools` omission is the brace. Both names carried because the rule-space name is unconfirmed (U3) — S25d decides whether the denies can be dropped as redundant. |
| `--disable-slash-commands` kept | Docs confirm it disables skills and commands; effectiveness asserted in S25d (if it were wrong, G11's `.claude/skills` exposure becomes live again). |
| `--plugin-dir` points at a **per-task snapshot**, not `$CLAUDE_PLUGIN_ROOT` | The marketplace cache path is version-pinned; a `plugin update` mid-task would invalidate a baked path (SF17). §7.5. |

### 5.4 Role variants

**`--tools` is identical for every role: `Read,Edit,Write,Glob,Grep,Bash`. Profiles differ only in `--allowedTools`.** (SF15 adopted; v1's "judgment roles drop Bash" note is reversed.)

| Role class | Allow rules |
|---|---|
| **Executor** (coder) | worktree Edit grant + returns + signals + the two cmux allows + the profile's validation commands (`Bash(npm run typecheck *)`, `Bash(npm test *)`) |
| **Judgment** (planner, reviewer, leads) | returns + signals + the two cmux allows. **No** worktree Edit grant, **no** validation commands. |

A judgment role therefore gets: the built-in read-only Bash set (`git log`, `git diff`, `grep`, `cat` — genuinely useful for a reviewer, G5), write access to exactly two directories, and the signal path. Nothing else. This collapses two enforcement mechanisms into one and retires the hook-relay emitter.

**Documentation correction that must ride with this:** no profile description may claim a role "cannot run commands." The accurate statement is *"cannot run state-changing commands; the built-in read-only set executes in every mode regardless of rules."* S25d enumerates that set so the claim is precise rather than doc-copied.

---

## 6. Deliverable 2 — task-artifacts location (ADR-006 amendment) — **MF1**

### 6.1 The break

The U2 probe used the exact rule form that passed S22a minutes earlier, against ADR-006's exact location:

```
--permission-mode dontAsk
--allowedTools "Edit(//Users/x/Development/dev-team-claude-plugin/.claude/dev-team/tasks/probe-test/returns/**)"
  → Write to that path: DENIED (transcript-visible, file never created)
```

Same rule shape, same session type; the only difference is that the path sits under `.claude/`. **G9 is confirmed on-machine and `permissions.allow` does not override it.** Under ADR-006 as accepted, every dispatch would fail to write its return file, the rank-0 file watch would have nothing to watch, and the worker would most likely narrate the denial rather than escalate. The boundary is asymmetric: the orchestrator's own session writes to `.claude/dev-team/` fine (interactive/auto modes prompt rather than hard-deny); the hard denial bites **worker panes in `dontAsk`**, which is precisely where the return files live.

### 6.2 Options

**A. External root — `~/.dev-team/tasks/<repo-slug>/<task-slug>/`.**
Optimizes: no protected-path exposure; **invisible to `git status`**, which removes the entire false-positive class from MF7 rather than papering over it; no mutation of the consumer's repo or `.gitignore`; survives `git clean -fdx`, branch switches and worktree teardown; per-repo namespacing prevents task-slug collisions across repos.
Sacrifices: artifacts no longer sit next to the code (mitigated — the doc tab, S18, opens absolute paths and is the human's actual viewport); a new top-level `~/.dev-team/` alongside the existing `~/.claude/dev-team/`; the `.dev-team` dot-name is not on any protected list but has not itself been probed.

**B. In-repo gitignored dir — `<repo-root>/dev-team-tasks/`, excluded via `.git/info/exclude`.**
Optimizes: artifacts next to code; `info/exclude` avoids touching the consumer's tracked `.gitignore`.
Sacrifices: the dispatcher must manage a file inside `.git/` (protected for tool writes; only reachable from a subprocess — a mechanism we would be leaning on precisely where G13 is a *residual*, not a feature); `git clean -fdx` destroys live task state; still inside the checkout the post-condition inspects, so the ignore-set carve-out returns; a worktree of the same repo may or may not inherit the exclude.

**C. Split — orchestrator artifacts stay in `.claude/dev-team/tasks/`, worker-writable `returns/` + `signals/` move out.**
Optimizes: minimal ADR-006 churn; keeps the existing convention for everything that already works.
Sacrifices: two roots to correlate, two roots to archive, two roots to garbage-collect, and a permanent invitation to put the wrong file in the wrong place. Buys nothing that A doesn't, because A's only real cost (distance from the code) applies to the orchestrator's artifacts too.

### 6.3 Recommendation: **A**

`~/.dev-team/tasks/<repo-slug>/<task-slug>/`, with the root configurable as `task_artifacts_root` in `/Users/x/Development/dev-team-claude-plugin/.claude/dev-team/config.md` (default `~/.dev-team`).

```
~/.dev-team/
  tasks/<repo-slug>/<task-slug>/          ← TASK_DIR, --add-dir'd, worker-readable
    task.json            plan.md  spec/            (orchestrator-written)
    dispatch/<id>.json   dispatch records — NO completion nonce, ever
    returns/<id>.json    worker-written, Edit-granted
    signals/<id>.jsonl   worker-written, Edit-granted
  state/<task-slug>/                      ← parent-side only, NEVER --add-dir'd
    worker-plugin/       per-task snapshot of the worker plugin (§7.5)
    <dispatch-id>.nonce  read-and-unlinked by the adapter at spawn (§7.1)
    <dispatch-id>.exit   adapter EXIT sentinel (rank-2), unforgeable by tool calls
    <dispatch-id>.signal-log  hook-attested signal record (§8)
  archive/<task-slug>-<utc-timestamp>/    ← archive-on-any-failure target
```

Justification against the constraints: no protected component anywhere (G9); `TASK_DIR` contains no `.claude/` subdirectory, satisfying G11's `--add-dir` constraint; parent-side state is outside both cwd and `--add-dir`, so worker tool-reads of it are denied by `dontAsk`; and because `TASK_DIR` is outside every checkout, the §9.2 post-condition needs no task-dir carve-out at all.

**Explicitly not in conflict with this repo's root `tasks/`.** `/Users/x/Development/dev-team-claude-plugin/tasks/cmux-mode/*.md` are deliberately committed human-facing design documents — a repo artifact. The ADR-006 task dir is ephemeral machine state for a dispatch. Different lifecycle, different location, no convention clash. `.claude/dev-team/{memory,config.md}` and `~/.claude/dev-team/task-cost/` are unchanged: they are orchestrator-only and no `dontAsk` worker touches them.

**Verification before 1a's first commit: S25c** — one `dontAsk` launch with `Edit(//<HOME>/.dev-team/tasks/probe/returns/**)`, write inside and outside. This is a five-minute repeat of S22a at the real path, and it also settles whether a `.dev-team` dot-name is affected by the protected-dotfile list.

---

## 7. Deliverable 3 — token & identity model (new normative TRD content)

### 7.1 Completion nonce — **MF4**

**Threat.** `Bash(cmux wait-for -S *)` wildcards the token, and S24 proved the namespace is global. Under any scheme where the completion token is derivable from values the worker can see, a worker can end its own dispatch by firing that token without writing a return — and can reach sibling dispatches too.

**Decision.**

- The completion token is `COMPLETION_NONCE = devteam-done-<24 hex chars from a CSPRNG>`. It encodes nothing; it is not derived from `dispatch_id`, `task_id`, role, or time.
- **It never appears in:** the worker's process environment, the composed argv, the kickoff text, the byte-stable role body, or any file under `TASK_DIR` (including `dispatch/<id>.json`). Builder hard rule 9 asserts this.
- **Delivery to the adapter — the tension resolved.** The adapter's EXIT trap *must* fire the nonce, so the adapter needs it, and the adapter is the worker's own parent process. Three delivery routes were considered:

  | Route | Leak surface | Verdict |
  |---|---|---|
  | Adapter argv (`adapter.sh --nonce X`) | Visible in `ps` to any same-uid process for the dispatch's whole lifetime | Rejected |
  | Pane/workspace env (`cmux new-pane --env`) | Not in `ps` argv, and the adapter can `unset` before spawning `claude` so the child env is clean — **but on macOS `ps eww` reports a process's *exec-time* env snapshot, so the unset does not retract it** | Rejected as primary |
  | **Nonce file outside the task dir, read-and-unlinked** | Exists for the sub-second window between dispatcher write and adapter read, before `claude` exists at all | **Adopted** |

  **Precise mechanism.** The dispatcher writes `~/.dev-team/state/<task-slug>/<dispatch-id>.nonce`, mode `0600`, outside `TASK_DIR` and outside every `--add-dir` root. The pane command line carries only the *path*. The adapter's first two statements are `NONCE=$(cat "$NONCE_FILE"); rm -f "$NONCE_FILE"` — read into a **shell variable, never exported**, and the file unlinked before `claude` is spawned. `set -x` is prohibited in the adapter; the nonce is never echoed. The child `claude` process therefore has the nonce in neither its argv, its env, nor any readable file.

- **Firing.** `trap 'cmux wait-for -S "$NONCE"; cmux wait-for -S "$ATTN_PARENT"' EXIT` in the adapter, which runs `claude` as a **child** (never `exec`, which would discard the trap). The adapter also writes `~/.dev-team/state/<task-slug>/<dispatch-id>.exit` with the child's exit code — rank-2 sentinel, sited parent-side so a worker tool call cannot forge it.

- **Parent invariant (the actual protection).** On **every** wake — attention token, completion nonce, or chunk timeout, indistinguishably — the parent re-derives completion **exclusively from the ladder**: a return file at `<TASK_DIR>/returns/<dispatch_id>.json` that (i) exists, (ii) has mtime ≥ dispatch start, (iii) parses, (iv) validates against the return schema, and (v) carries a `dispatch_id` matching this dispatch. A wake is never itself evidence of anything. The nonce's job is not to authorise completion; it is to ensure that a forged wake buys the attacker exactly one wasted loop iteration.

- **Residual (stated, accepted):** a `Bash(npm test *)` subprocess can `ps eww` its own ancestors and read parent-side state files — G13's subprocess vector reaches everything the OS lets the uid reach. The nonce raises the cost from "guess a string" to "execute arbitrary code in a repo-controlled npm script," which is the correct place for the line against a confused-but-not-adversarial worker. Closing it requires OS-level sandboxing (§10.7).

### 7.2 Attention tokens — **SF13 + SF16**

Fixed, per-dispatch, **not** sequenced. Two of them, both delivered as **literal strings in the kickoff text**:

| Token | Value | Awaited by | Purpose |
|---|---|---|---|
| `ATTN_PARENT` | `devteam-<dispatch_uuid>-attn` | the immediate dispatcher (lead, or orchestrator for a lead dispatch) | worker → its dispatcher |
| `ATTN_UPSTREAM` | the `ATTN_PARENT` of the ancestor dispatch the orchestrator is currently blocked on | the orchestrator | **worker → orchestrator, directly** |

**Why kickoff and not env.** ADR-009 forbids per-dispatch values in the byte-stable role body. Env was the alternative, but it forces the worker to write `cmux wait-for -S "$DEVTEAM_ATTN_PARENT"`, and the variable form of a `Bash(...)` argument-pattern match is **untested** — G8 names variables as a documented fragility, and S22f only exercised a literal token. Kickoff delivery keeps the call byte-identical to the form that passed live. (Listed as a residual anyway: if a future profile needs env delivery, the variable-form match must be tested first.)

**Why direct worker→orchestrator works and is not a new topology edge.** `ATTN_UPSTREAM` propagates *downward* along the dispatch chain: the orchestrator sets `DEVTEAM_ATTN_UPSTREAM` when it dispatches a lead; the lead's dispatcher copies that value into every worker kickoff it composes and re-propagates it. No worker learns anything about its siblings, no worker can address a specific other pane, and the token is an *inbox*, not a channel — firing it wakes the orchestrator, which then reads files. The user's verbatim requirement — *"if orchestrator is needed then team lead can ping the orchestrator; workers should be able to ping the orchestrator"* — is satisfied literally, with the same one-line action for both.

**Forgery surface.** Attention tokens are guessable if `dispatch_id` is. Consequence of a forged attention fire: one wasted parent loop iteration. Mitigation: `dispatch_id` is a UUID (`--id-format uuids` already exists in cmux), which makes cross-dispatch spoofing impractical without eliminating a harm that is already bounded.

### 7.3 Parent await loop (two-phase, correct under either latch semantics)

G19 is open: we do not know whether a latched token is consumed by the first waiter or persists. The loop is designed to be correct either way.

```
arm-before-kickoff:  (S22f order — latching covers the race, S5/S24)
  phase 1: cmux wait-for <ATTN_PARENT> --timeout <chunk>
           # released by: a worker attention signal, OR the adapter EXIT trap
           #              (which fires ATTN_PARENT as well as the nonce), OR timeout
  on wake (any cause):
      1. re-derive completion from the ladder  (§7.1 invariant) → done? exit loop
      2. read new lines from <TASK_DIR>/signals/<dispatch>.jsonl
         + the hook-attested log in parent state; validate, rate-limit, relay
      3. switch to phase 2
  phase 2 (all later iterations):
           cmux wait-for <COMPLETION_NONCE> --timeout <chunk>
           # attention signals fired from here on land in signals/ and are picked up
           # at the next chunk boundary (≤ chunk, default 90–120 s; S17 allows up to 600 s)
```

Phase 2 exists because if latches persist permanently (G19, pessimistic branch), re-awaiting an already-fired `ATTN_PARENT` would return instantly on every iteration and degenerate the loop into a token-burning spin. If **S25b** shows latches are consumed, phase 1 may simply repeat and every attention signal gets a live nudge — a pure improvement requiring no other change. **The guaranteed contract is the pessimistic one: the first signal gets a live nudge; later signals are picked up at the next poll.** That is exactly SF13's accepted degradation, promoted from fallback to design.

### 7.4 What this makes true

- A dispatch is complete **iff** the ladder says so. No token, forged or genuine, can substitute for a fresh schema-valid return (AC-8).
- A worker's total signalling power is: wake my dispatcher, wake the orchestrator, post an OS notification. All three are idempotent-ish, bounded, and observable.

### 7.5 Worker-plugin snapshot (resolves SF17's plugin-root item)

`$CLAUDE_PLUGIN_ROOT` resolves to a **version-pinned** marketplace cache path (`~/.claude/plugins/cache/dev-team/dev-team/<version>/`, per `conventions.md`), and it is exported for hook commands, not for arbitrary Bash-tool subprocesses — the orchestrator only knows it because `hooks/hooks.json` injects it into context.

Decision: **at task start, the dispatcher copies the worker plugin to `~/.dev-team/state/<task-slug>/worker-plugin/` and every dispatch in that task uses the snapshot path.** A `plugin update` mid-task can no longer invalidate a live task; the hook scripts a worker runs under are immutable for the task's lifetime; and the snapshot sits outside the worker's roots so tool calls cannot tamper with it. Minimum acceptable alternative if snapshotting is rejected in build: resolve the plugin root at dispatch time (never from a persisted artifact) plus a fail-fast existence assertion — but the snapshot is one `cp -R` and strictly better.

The adapter's `capabilities` probe additionally detects the managed setting `disableSideloadFlags` (which rejects `--plugin-dir` at startup) and fails fast with remediation text rather than silently dispatching un-hooked workers.

---

## 8. Deliverable 4 — the signal channel (supersedes v1 §7.2 and §7.3)

v1 §7.2 is **deleted**: its premise 1 (a deny wildcard must exist, so a carve-out fails open) is void — there is no deny wildcard, and allow-only containment fails *closed*. Its premise 2 (G8 fragility) now cuts the opposite way: under allow-only rules, a weirdly-quoted call is denied, and `sh -c 'cmux …'` matches no allow rule and is denied. Only premise 3 (works for Bash-less roles) survived, and SF15 removes the Bash-less role class entirely.

### 8.1 Contract

| Element | Value |
|---|---|
| **Record (mandatory, primary)** | The worker appends one JSON line to `<TASK_DIR>/signals/<dispatch_id>.jsonl`: `{ts, level, message, escalate_to}`. This is the source of truth and satisfies the user's standing rule that workers and leads never skip the files. |
| **Nudge (best-effort, additive)** | Then, for a signal it wants seen live: `cmux wait-for -S <ATTN_PARENT literal>` and/or `cmux wait-for -S <ATTN_UPSTREAM literal>`; and, for `blocked`/`question` only, `cmux notify --title "devteam · <role> · <task>" …`. |
| **`level`** | `progress` \| `blocked` \| `question`. Closed enum, **enforced parent-side at read time**; advisory at write time. |
| **`escalate_to`** | `lead` \| `orchestrator` \| `user`. Now genuinely routable: the worker fires the corresponding token. Not "intent only." |
| **Emitter** | **The worker, and only the worker.** For every role. |
| **Hook role** | The worker plugin's `PostToolUse` (matcher `Write|Edit`) is **record/attest-only and never emits**: on a write under `<TASK_DIR>/signals/`, it appends an attested entry (hook-observed timestamp, tool, path, `dispatch_id` from env) to `~/.dev-team/state/<task-slug>/<dispatch-id>.signal-log`, which the worker cannot write. Early `exit 0` on any non-matching path. This resolves MF5's double-notification by construction: there is exactly one emitter. |
| **Rate limit / schema** | Parent-side, at read time: ≤5 relayed signals per dispatch, ≥30 s apart, `message` truncated to 200 chars before any onward relay, unknown `level` treated as `progress`. Over-limit lines are recorded and simply not relayed. |
| **Relay** | The parent relays into its own context (lead's or orchestrator's), **never as a second OS notification** — the worker's `cmux notify` already reached the human. |
| **cmux verbs reachable by any worker** | Exactly two, by enumerated allow. Every other verb — including verbs future cmux versions add — is denied by omission (G15, live-verified for `ping` and `close-surface`). |

### 8.2 Reliability posture — **SF12, and it must be stated in the ADR, not just here**

**The attention channel is prompt-dependent and therefore best-effort by construction. The `signals/` file record and the four-rank completion ladder carry every guarantee.** A worker that never signals, signals malformed content, or signals nothing at all must produce exactly the same eventual outcome as one that signals perfectly — via the return file, the EXIT sentinel, and the chunk timeout. S22f is weak evidence of worker compliance (a haiku model explicitly instructed to run both verbs in a smoke test), and the original architect-Q1 objection to self-signalling ("prompt-dependent, unreliable") is **not** answered by the ratified mechanism — it is *accepted*, because the mechanism is additive and its failure mode is "the parent notices at the next poll instead of instantly."

### 8.3 Residuals

- **Unbounded worker-authored text reaches the human's notification center.** The worker fires `notify` directly, so nothing can filter it. Mitigation is prompt-level convention (title prefix, ≤200-char message) plus **S25a**: enumerate `cmux notify --help` and, if any flag does more than post a notification, tighten the allow to a narrower literal prefix.
- **The hook-relay emitter is retired.** It remains documented as the contingency if a future profile ever drops Bash; S22e proved it viable, so re-adopting it is a config change, not a redesign.
- Deferred, explicitly: a `devteam-signal` wrapper on PATH (nicer ergonomics, second enforcement path — not worth it now); `set-status`/`set-progress` pane badges (Phase-2 polish).

---

## 9. Deliverable 5 — enforcement layering and the return post-condition

### 9.1 ADR-012, re-scoped — **SF14**

**Title: "CLI permission rules are the primary enforcement layer; hooks enforce the invariants rules cannot express."**

v1 proposed the inverse ("hooks are the guarantee, rules are defense-in-depth"). The evidence moved: S22a proved path scoping works, Tests A/B and S22f proved omission-denial is real containment, and S22e proved hooks *can* enforce — feasibility strengthened, necessity weakened. Making hooks primary would mandate a hook process on every file-tool call to buy a guarantee whose only remaining justification (G13's subprocess gap) hooks do not close either.

| Layer | Owns | Evidence |
|---|---|---|
| **CLI permission rules (primary)** | Tool-set closure (`--tools`); path scoping of writes; cmux verb containment; MCP/skill/subagent closure | S22a, S22b, Tests A/B, S22f, G15 |
| **Hooks (invariants rules cannot express)** | The bounded Stop-hook completion gate (rank 3); PostToolUse signal attestation; startup fail-fast diagnostics | S11, S22e, G17 |
| **Neither layer** | Writes performed by subprocesses that a permitted Bash command spawns (`npm test` → repo-controlled scripts) | G13 (doc-derived) |
| **Post-condition (§9.2)** | Detection of everything the first two layers missed, inside the repo | — |

**Explicitly out of scope for the default worker profile: a `PreToolUse` hook on file tools.** It is available (S22e proved allow and deny both work, including overriding the read-only auto-allow) and remains the escape hatch if a future invariant needs it, but it is not in the default profile. This retires v1's per-call-latency risk row entirely.

### 9.2 The `git status` post-condition, redesigned — **MF7 + MF8**

v1 had two defects: it fired false positives (task artifacts inside the checkout are legitimate writes) and then hard-reset a worktree on them; and it applied only to judgment roles, i.e. exactly the roles without the vector that motivates it.

**Vector, correctly named (MF8).** Under the old broad-Bash model the escape was `node -e`. Under allow-only, `node -e` is denied by omission. The live vector is `Bash(npm run typecheck *)` / `Bash(npm test *)`: these execute **repo-controlled scripts** that can write anywhere the uid can reach. That is an *executor* capability. ADR-012's hook layer does not see it (hooks see tool calls, not what npm spawns). The post-condition is the only control.

**Decision — applies to ALL roles, every dispatch, unconditionally:**

1. **Primary checkout must be clean.** `git -C "$PRIMARY" status --porcelain` must be empty, modulo an explicit ignore set:
   - The task dir is **outside every checkout** (§6), so it contributes nothing. This is the main reason to prefer location option A: the false-positive class is designed away, not filtered away.
   - Gitignored paths are already absent from `--porcelain` (no `--ignored` flag is passed).
   - A per-profile `postcondition_ignore` list (globs, default empty) exists for repos with generated-but-tracked artifacts. Every entry is logged in the dispatch record so an ignore never hides silently.
2. **Worker's own worktree.** Executor roles: changes expected; the return's file list is cross-checked against `git -C "$WORKTREE" status --porcelain`. Judgment roles: must be clean.
3. **Remedy on refusal, scoped strictly:** `git -C "$WORKTREE" reset --hard && git -C "$WORKTREE" clean -fd`, guarded by three assertions that all must hold — `WORKTREE` is a git worktree; its `git rev-parse --git-common-dir` matches the expected repo; and `WORKTREE != PRIMARY`. **If the primary checkout is dirty, the dispatch is refused and escalated to the human. There is no automatic destructive action on a checkout the user owns.**
4. **Outcome recorded** in `dispatch/<id>.json` as `refused_postcondition`, which feeds the archive predicate (§10.6).

**Residuals, stated (MF8's requirement):**
- Writes **outside the repo** (`$HOME`, `/tmp`, another checkout) are invisible to this check. Nothing short of OS-level sandboxing sees them (§10.7).
- Inside the worktree, an npm-script write is indistinguishable from a legitimate executor edit. The check catches *escape*, not *misbehaviour in place*.
- Narrowing `SPEC_VALIDATION_COMMANDS` to the repo's declared validate lane (here: `node --test`, per `config.md`) reduces the vector's breadth but does not close it. A stronger variant — the **adapter** runs validation commands and feeds results back, so the model never gets a shell grant at all — is a real option that changes the executor loop materially; deferred, recorded, not built now.

---

## 10. ADR amendment notes

### 10.1 ADR-003 (completion ladder) — Amendment 1

- **The attention channel is orthogonal to the ladder and is never completion evidence.** On any wake, from any token, the parent re-derives completion solely from the ladder (§7.1's five-part return test, plus the parent-side EXIT sentinel, plus the Stop gate). Non-goal, stated explicitly in the ADR text.
- **The attention channel is additionally best-effort and not guaranteed to arrive** (SF12). A dispatch whose worker never signals must reach the same outcome, later.
- **The completion token is an unguessable per-dispatch nonce** delivered to the adapter out of band (§7.1) and never exposed to the worker. Rank-2's sentinel file moves to parent-side state so it cannot be forged by a tool call.
- **Rank-2 (EXIT trap) is permanent, not provisional** — no per-surface process-exit event exists in cmux 0.64.20's catalogue (S2). Remove any "may be retired by future cmux events" hedge.
- **Rank-3's rationale is cross-referenced** with ADR-012: "hooks run outside the tool-permission system" now justifies the Stop gate *and* the signal attestation. A future editor weakening one must see the other.
- **Rank-0 chunk sizing:** S17 raises the Bash ceiling to 600 s (120 s default). 90 s stands as conservative-safe; widening is tuning.
- **New: the two-phase await loop** (§7.3) is normative for #3, with its behaviour under both branches of G19 documented.

### 10.2 ADR-005 (security posture) — Amendment 1 (mechanism)

*Extends — does not supersede — the ADR-005/D9 entry already recorded in `architecture-notes.md` on 2026-08-01.*

- Rule spelling is normative: `Edit(...)`/`Read(...)` only, `//`-absolute only, whitelist-checked at composition time, with stderr fail-fast on the CLI's own warning (G1/G2, both live-verified).
- `--allowedTools` is **not** a capability list; `--tools` closes the tool set (G6). Remove the spike's "pair every allow with a matching deny" guidance — it is the wrong corrective and adds rules that can only misfire under deny-beats-allow.
- **Omission is denial** outside the built-in read-only set (G15). The read-only carve-out (G5) is a documented, accepted residual: every role can run `cat`/`grep`/`git log`-class commands regardless of rules. Profile docs must say "cannot run state-changing commands," never "cannot run commands."
- **`--tools` is identical across roles; profiles differ only in allow rules** (SF15).
- The **`git status` post-condition is unconditional and applies to all roles**, with the scoping and remedy rules of §9.2 and the residuals named.
- **Protected-path constraint (G9, now live-verified):** no worker-writable directory may sit under `.claude`, `.git`, `.vscode`, `.idea`, `.husky`, or `.devcontainer`. `~/.claude/dev-team/…` is specifically disqualified as a task-dir root.
- `--strict-mcp-config` + `--disallowedTools "mcp__*"` on every profile (S14; G12).

### 10.3 ADR-006 (task artifacts) — Amendment 1 — **new, MF1**

- **The task-artifacts dir relocates out of `.claude/` to `~/.dev-team/tasks/<repo-slug>/<task-slug>/`**, configurable as `task_artifacts_root`. Layout, rationale and rejected alternatives per §6. Parent-side state (`~/.dev-team/state/…`) is a sibling and is never `--add-dir`'d.
- Archive-on-any-failure targets `~/.dev-team/archive/<task-slug>-<utc>/` and captures the task dir **and** the parent-side state dir (the exit sentinels and signal attestation are the debugging evidence).
- Rationale recorded so it cannot be casually reverted: `.claude/**` hard-denies `dontAsk` worker writes even with an exact-match allow rule, live-verified.

### 10.4 ADR-009 (byte-stable pane prefixes) — Amendment 1

- **Holds, and is now cheap to satisfy:** `--append-system-prompt-file` exists (G14), so the role body is a static file passed by path — no interpolation, no inline `$(cat …)`, no MF2 exposure.
- **The rationale is narrowed to what is true:** what must stay byte-stable is the *prompt*. A `--settings` file containing only a `permissions` object touches no prompt bytes and would not violate this ADR — recorded so a future reader doesn't over-apply the ban. (Not needed now: S22a made CLI-flag rules the working mechanism.)
- **All per-dispatch variance travels via env vars and the kickoff.** Specifically: the two attention tokens, the task-dir path, the return-file path and the signals-file path ride the **kickoff as literals**; the completion nonce rides **neither** (§7.1).
- **The worker plugin's `hooks/hooks.json` must be static** — no per-dispatch path interpolation, including in `if:` filters. The PostToolUse hook reads `$DEVTEAM_TASK_DIR` from env and does its own path check.
- `--plugin-dir` delivery is fully confirmed, including `PreToolUse`/`PostToolUse` (S11 + S22e). The plugin path is a **per-task snapshot** (§7.5), not a version-pinned cache path.

### 10.5 ADR-012 (new) — enforcement layering

> **Numbering note (U5 resolved by the orchestrator, 2026-08-01):** epic #15's design record already carries ADR-010 (machine-readable verdicts, D17) and ADR-011 (shared noise-glob, D16). This enforcement-layering ADR — proposed as "ADR-010" in v2's first draft — is therefore assigned **ADR-012**, the next free number. All references to it in this document read ADR-012.

Title, layer table, and the explicit exclusion of per-file-call PreToolUse hooks: §9.1. Status: **proposed, unblocked** (S22e discharged the keystone), but with a *different decision* than v1 proposed — the review's SF14 framing is adopted intact.

### 10.6 Ratified operational decisions — recording notes

**U8 — "failure at task level," mechanically defined (SF17).** Every dispatch record `dispatch/<id>.json` carries a terminal field `outcome ∈ {ok, exit_nonzero, no_return, invalid_return, refused_postcondition, timeout, aborted}`. The task record carries the same enum. The archive predicate is a single expression:

> **archive := (task.outcome ≠ ok) OR (∃ dispatch : dispatch.outcome ≠ ok)** — evaluated at task end, overriding `keep_task_artifacts: false`.

Mapping the fuzzy phrasings onto it: "any dispatch exited non-zero" → `exit_nonzero`; "a refused or invalid return" → `invalid_return` / `refused_postcondition`; "a `blocked`-level signal that ends unresolved" → the dispatch that emitted it terminates with `no_return` or `timeout` (a `blocked` signal is never itself an outcome — this removes the dependency on a term that nothing validates); "an orchestrator-declared abort" → `aborted`. A per-dispatch failure counts even if a later retry of the same slice succeeds. **Owner: slice 1a** (dispatch-record schema), acceptance: a unit test over the predicate with one case per enum value.

Decisions 2, 4, 5, 6 from the exit gate: ratified as-is, no architectural consequence. Decision 5 is evidence-backed by S6. Decision 3 is implemented by §7 + §8 and is already recorded in memory.

### 10.7 Forward-looking, explicitly **not** building now

OS-level sandboxing (`sandbox.filesystem`) is the only mechanism that closes G13 — permission rules and hooks both see tool calls, not the file syscalls of an npm-spawned child. Worth an ADR **later**, if worker containment ever needs to be a wall rather than a fence. Not now: it adds a platform-specific enforcement layer against a threat model (a confused-but-not-adversarial worker) that the §9.2 post-condition covers adequately for writes inside the repo, which is where the damage that matters happens.

---

## 11. Spike scoreboard and remaining verification set

### 11.1 Discharged

| Item | Result |
|---|---|
| **S22a** — `Edit(//abs/**)` scoped grant, corrected syntax | **PASS both directions.** Inside succeeded, adjacent denied. v1's false-negative diagnosis proven. |
| **S22b** — `Write(...)` rule warning | **PASS.** Detectable stderr string with remediation text; drives the builder's fail-fast. |
| **S22c** — scoped deny enforcement | **PASS** (Test B). Now moot for the design — no cmux deny exists. |
| **S22d** — deny + carve-out | **Mooted.** No deny wildcard in the design. |
| **S22e** — plugin-dir `PreToolUse`/`PostToolUse` | **PASS, all three arms** (hook-allow, hook-deny overriding the read-only auto-allow, PostToolUse firing). ADR-012's keystone. |
| **S22f** — full composed-argv smoke | **PASS end-to-end.** Return written under the Edit rule, both cmux allows honored, `cmux ping` denied, waiter released, `--append-system-prompt-file` consumed. |
| **S22g** — system-prompt file flags | **PASS.** Both flags exist; U1 resolved. |
| **S24** — cross-workspace `wait-for` | **PASS both orders.** Global token namespace. A11 verified. |
| **U2 probe** — `.claude/**` denial | **CONFIRMED denial.** Drives MF1 / ADR-006. |
| **Tests A/B** — allow-only cmux containment | **PASS.** Precise allow honored, siblings denied, scoped deny attributed. |

### 11.2 Remaining — set S25 (none of it gates 1a's design; two items gate 1a's first commit)

| Item | Question | Cost | Owner / when |
|---|---|---|---|
| **S25a** | `cmux notify --help` flag enumeration + **one GUI eyeball** that a notify from a worker pane is visible to the human (A12's unverified half, SF11). If any notify flag does more than post a notification, tighten the allow to a literal prefix. | free | orchestrator + user, before 1c |
| **S25b** | **G19 latch semantics:** `cmux wait-for -S t` then `wait-for t --timeout 3` (expect instant) then `wait-for t --timeout 3` again — does the second waiter **block**? Decides whether phase 1 of the await loop can repeat. | free, ~30 s | before 1b |
| **S25c** | Task-dir relocation probe at the **real** chosen path: `dontAsk` + `Edit(//<HOME>/.dev-team/tasks/probe/returns/**)`, write inside and outside. Also settles the `.dev-team` dot-name question. | 1 launch | **before 1a's first commit** |
| **S25d** | **Profile-closure smoke** — one dispatch with the real v4 argv asserting, from the transcript: no `mcp__*` tool_use and no MCP auth banner; no `Skill` invocation (`--disable-slash-commands` effective); no subagent spawn with `Task`/`Agent` omitted from `--tools` (resolves U3 and decides whether the denies are redundant); `cmux ping` → `is_error=true` while the two allowed verbs succeed (AC-7); and an enumeration of the built-in read-only Bash set (`git log`, `ls`, `cat`, `grep` allowed; `ps`, `curl` denied) to make G5's membership on-machine truth rather than doc copy (SF9). | 1 dispatch | slice 1c |
| **S25e** | If worker worktrees are sited under `.claude/worktrees/`, probe that G9's documented carve-out actually holds for a `dontAsk` worker. The U2 probe verified denial under `.claude/dev-team/`, not the carve-out. | 1 launch | slice 1c, only if that siting is chosen |

### 11.3 Carried forward, unchanged

- **S23 — isolation & context-cost arms** (`--setting-sources`, `--strict-mcp-config`, `--bare`; does `--bare` still honour an explicit `--plugin-dir`; does excluding `user` prevent `enabledPlugins` loading and thereby make issue #5's guard unnecessary *for the dispatch path*). Gates the Phase-2 GO/NO-GO, not 1a. Re-run the S16 append/replace A/B in whichever arm achieves clean isolation.
- **S15b — full cost measurement.** Phase-2 GO/NO-GO, with the real dispatcher, **after** S23's levers are applied. Measuring the un-tuned profile against the ≤2× ceiling would likely produce a false NO-GO.
- **S20 — restart durability.** Deferred; needs a coordinated cmux quit/relaunch. Not blocking — the rank-0 file watch is the recovery path either way. Must run before anything depends on in-memory `wait-for` latch durability.

---

## 12. Phases & gating

| Slice | Gated on | Status after v2 |
|---|---|---|
| **1a — contracts freeze** (profile schema, argv builder + assertions, task-dir layout, dispatch-record schema incl. `outcome` enum, return schema alignment with `coder-return.schema.json`, signal-record schema, token model, post-condition spec) | Platform gates: **all discharged.** Design gates: **all decided in this package** (§6 location, §7 tokens, §8 emitter/authority, §9.2 post-condition). | **Unblocked on ratification of this package.** S25c should run alongside 1a's first commit as a confirmation, not a gate. |
| **1b — dispatcher (#3)** | 1a + S25b | Inherits: two-phase await (§7.3), nonce lifecycle (§7.1), token propagation (§7.2), archive predicate (§10.6). |
| **1c — profiles/argv (#4)** | 1a + S25a/S25d (+S25e if applicable) | Inherits: v4 argv + 9 hard rules with a test each, the identical-`--tools` simplification, the profile-closure test. |
| **#5 — worker neutralization guard** | none | **Parallel work, not a blocker** — but keep it: it is the correct general-case fix for a worker pane launched by any path. Whether `--setting-sources`/`--bare` also suppress the injection dispatcher-side is S23's question, and that is a convenience layered on top, not a replacement. |
| **Phase 2 GO/NO-GO** | S23 → S15b, in that order | S23 first so the cost measurement reflects the isolated profile. |

---

## 13. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **R1 — npm-script subprocess writes outside the worktree** (G13; `Bash(npm test *)` runs repo-controlled code) | Medium–High | §9.2 post-condition over the primary checkout, all roles; narrow `SPEC_VALIDATION_COMMANDS` to the declared validate lane; residual (writes outside the repo) stated, not hidden; sandboxing deferred with an explicit trigger condition (§10.7) |
| **R2 — completion-nonce leak via the same subprocess vector** (`ps eww`, parent-side state files) | Medium | Nonce never in argv/env/task dir; read-and-unlinked before `claude` exists; parent re-derives from the ladder on every wake, so a leaked nonce still cannot complete a dispatch without a valid return (AC-8) |
| **R3 — G19 latch semantics unknown** | Medium | Two-phase await is correct under both branches; S25b is free and runs before 1b; worst case is the already-accepted "first signal live, rest at next poll" |
| **R4 — attention channel is prompt-dependent and may simply not be used** (A14) | Medium | Stated as best-effort by construction (§8.2, ADR-003 amendment); every guarantee rides the file record + ladder; no design decision anywhere depends on a signal arriving |
| **R5 — unbounded worker-authored text reaches the human's notification center** | Low–Medium | Single emitter (no double-notify); prompt-level title/length convention; S25a enumerates notify's flag surface and tightens the allow if warranted |
| **R6 — post-condition false positive triggers a destructive reset** | Medium (was High in v1) | Task dir outside every checkout removes the class; reset guarded by three worktree-identity assertions; primary-checkout dirt **never** auto-resets — it refuses and escalates |
| **R7 — cost ceiling breached** (~2.1× tokens / ~3.2× wall-clock on the cheapest probe) | Medium | S23's levers quantified *before* the GO/NO-GO, not at it; `--strict-mcp-config` and slash-command/skill suppression already in the profile and asserted by S25d |
| **R8 — plugin-root staleness mid-task** (version-pinned cache) | Low (was unowned) | Per-task worker-plugin snapshot (§7.5); `disableSideloadFlags` detected by the adapter's capability probe |
| **R9 — worker worktrees under `.claude/worktrees` rely on a documented carve-out we did not verify** | Low | S25e, one launch, only if that siting is chosen; alternative siting outside `.claude/` is available at no cost |
| **R10 — doc-derived facts G11/G13 turn out build-specific** | Low | G11 drives only a cheap builder assertion we would keep anyway; G13 turning out *false* would only make containment stronger than assumed |

---

## 14. Open unknowns & assumptions

### Assumptions this design rests on

| # | Assumption | Status |
|---|---|---|
| A1 | Precedence is deny → ask → allow; a deny cannot carry exceptions | **Verified** (docs). Now moot for the design — no deny rules on cmux |
| A2 | `Edit(path)` covers all file-editing tools; `Write(...)` rules are accepted-but-never-consulted | **Verified live** (S22a + S22b, incl. the exact stderr string) |
| A3 | `//` = filesystem-absolute; single `/` anchors at cwd | **Verified** (docs + S22a's passing rule form) |
| A4 | `dontAsk` runs allow-matched calls, the built-in read-only Bash set, and PreToolUse-approved calls; always denies `AskUserQuestion` | **Verified** for the first and third (S22e); `AskUserQuestion` doc-only |
| A5 | Hook deny blocks before rules and overrides the read-only auto-allow; a deny rule beats a hook allow | **Verified live** for both hook directions (S22e); "deny beats hook allow" doc-only |
| A6 | Protected-path writes (incl. `.claude/**`) are denied in `dontAsk`; allow rules don't override | **Verified live** (U2 probe) |
| A7 | A bare `--` before the positional fixes the variadic swallow | **Verified** (4 reproductions + fix confirmation; also in `conventions.md`) |
| A8 | plugin-dir hooks fire in a dispatched pane, all five event kinds used | **Verified live** (S11 + S22e) |
| A9 | S9's failure was purely syntactic (rule kind + anchoring), no third cause | **Verified** (S22a passed both directions with the corrected form) |
| A10 | plugin-dir `PreToolUse`/`PostToolUse` fire and their decisions are honored | **Verified** (S22e, all three arms) |
| A11 | `wait-for` tokens are globally namespaced across workspaces | **Verified** (S24, both orders) |
| A12 | `cmux notify` from a worker pane reaches the human as a **visible** notification | **Partially verified** — it executes and emits a `notification.requested` socket event (Test A); GUI visibility is unobserved → **S25a** |
| A13 | Replacing the default system prompt degrades worker tool-use quality | **Unverified inference.** It is *why* append is the default; if someone wants replace, this is the thing to measure (S23's re-run) |
| A14 | A worker reliably issues the signal it is instructed to issue | **Unverified, and materially weaker under the ratified mechanism** than under v1's write-triggered design. **Accepted, not mitigated:** the channel is best-effort by construction; the file record and ladder carry all guarantees (§8.2). S22f is weak evidence (instructed haiku smoke test) |
| A15 | Published docs describe installed 2.1.220 behaviour | **Mostly upheld, one contradiction resolved in the docs' favour** (G14). Every remaining **D**-status fact in §3 is high-confidence-but-build-specific |
| A16 | `--add-dir` skill/agent discovery is scoped to the added directory, not its ancestors (G11) | **Unverified, low-consequence.** Even if ancestors were walked, `~/.claude/skills|agents` already load via user scope in every session — `--setting-sources`/`--bare` (S23) is the lever for both, not the task-dir location |
| A17 | The nonce file's write→read→unlink window (dispatcher to adapter, before `claude` exists) is not observable by the worker | **Verified by construction** — the worker process does not exist during the window. Residual is the ancestor-`ps` vector (R2), not this window |

### Unknowns needing scouting, a consult, or a decision

| # | Unknown | Route |
|---|---|---|
| U1 | System-prompt file flags on 2.1.220 | **RESOLVED** — both exist (S22g), used in anger (S22f) |
| U2 | Task-dir location vs. protected paths | **RESOLVED, and it was a break** — relocated per §6; confirmation probe S25c |
| U3 | Is the subagent tool `Task` or `Agent` in rule space, and does `--tools` omission alone close it? | **Owned: S25d**, slice 1c. Both denies carried until then; drop as redundant if omission proves sufficient |
| U4 | Does `--setting-sources` excluding `user` prevent `enabledPlugins` loading? Does `--bare` honour an explicit `--plugin-dir`? | S23 (Phase-2 gate) |
| U5 | Are ADR numbers 010+ free in the epic's design record? | **Owned: orchestrator**, one lookup before posting; renumber on commit if taken. I have no authenticated access to the epic |
| U6 | Restart durability of `wait-for` latches and moved panels | S20, deferred, coordinated relaunch |
| U7 | User ratification of the signal mechanism | **RESOLVED** — user-directed, live-validated, already recorded in `architecture-notes.md` |
| U8 | Mechanical definition of "failure at task level" | **RESOLVED** — outcome enum + single archive predicate (§10.6); owner slice 1a with a unit test |
| U9 | Does `--disallowedTools "mcp__*"` actually remove MCP tools, and does `--disable-slash-commands` actually disable skills? | **Owned: S25d**. Both currently ride on S22f's "the turn completed," which asserts neither |
| U10 | Is a latched `wait-for` token consumed by the first waiter, or permanent? (G19) | **Owned: S25b**, free, before 1b. Design correct either way |
| U11 | Exact membership of the built-in read-only Bash set (G5) — now the reviewer's real capability surface under SF15 | **Owned: S25d** enumeration arm |
| U12 | Full flag surface of `cmux notify` (the allow wildcards it) | **Owned: S25a**, free |
| U13 | Does `Bash(cmux wait-for -S "$VAR")` match when the token comes from env rather than a literal? | **Residual, deliberately avoided** — tokens ride the kickoff as literals precisely so this is never exercised (G8). Must be tested before any future profile switches to env delivery |
| U14 | Does G9's `.claude/worktrees` carve-out hold for a `dontAsk` worker? | **Owned: S25e**, only if worktrees are sited there |

---

## 15. Acceptance criteria

**For this package (before it is treated as ratified):**
1. Every normative claim in §3 carries a status of **L** (live evidence, with the item that produced it) or **D** (doc-derived), and no recommendation rests on a **D** fact without either a named owner slice or an explicitly stated residual.
2. U5 (ADR numbering) — **resolved:** epic #15 already uses ADR-010 (verdicts) and ADR-011 (noise-glob); the enforcement-layering ADR is assigned **ADR-012** (§10.5 note).

**For slice 1a (contracts) — testable at freeze:**
3. **Builder tests, one per hard rule 1–9.** In particular: (rule 2) the builder returns a **string array** and a test asserts that a role body containing spaces, `*`, `$(`, and newlines produces exactly the expected element count with byte-identical content; (rule 6) a test asserts no composed profile contains any `Bash(cmux` deny and contains exactly the two allows; (rule 9) a test asserts the nonce appears in neither the argv array nor the child env map.
4. The dispatch-record schema carries the `outcome` enum, and a unit test exercises the archive predicate (§10.6) once per enum value.
5. The signal-record schema is frozen with parent-side read-time validation (closed `level` enum, ≤5/dispatch, ≥30 s apart, 200-char truncation before relay) and a test that malformed/over-limit lines are recorded but not relayed, and that **no path in the system emits a nudge from the hook**.

**For slice 1c (profiles/argv):**
6. **S25d profile-closure test passes**, asserting in one transcript: no `mcp__*` tool_use, no MCP auth banner, no `Skill` invocation, no subagent spawn, and the read-only Bash membership enumeration.
7. **(rewrites v1 criterion 8 — MF6)** For each profile, a dispatch that attempts a third cmux verb records `is_error=true` for that `tool_use` in the pane's session transcript (`~/.claude/projects/<slug>/<session>.jsonl`), while `cmux notify --title …` and `cmux wait-for -S <literal token>` record success. Evidence is the transcript, **never** `read-screen` (G18).

**For slice 1b (dispatcher):**
8. **(MF4)** A dispatch that fires a plausible completion token (e.g. `devteam-done-<dispatch-uuid>`, and a literal captured from a *previous* dispatch's parent-side state) **without** writing a valid return file is **not** marked complete: the parent wakes, re-derives from the ladder, finds no fresh valid return, and continues awaiting. Asserted on the parent's state machine, not on logs.
9. **(MF7/MF8)** Every dispatch's return, for every role, is refused if `git -C "$PRIMARY" status --porcelain` is non-empty outside the declared ignore set. On refusal: the outcome is `refused_postcondition`; a **worktree** reset runs only when all three identity assertions hold; a dirty **primary checkout** escalates to the human and never triggers an automatic reset. Tests cover: clean primary (pass), dirt in the worktree for an executor (pass), dirt in the worktree for a judgment role (refuse + reset), dirt in the primary (refuse + escalate, **no reset**).
10. **(SF16)** A worker fires `ATTN_UPSTREAM` and the orchestrator — not merely the immediate dispatcher — wakes, reads the `signals/` record, and relays. Direct worker→orchestrator is covered by a test, not by prose.
11. **(SF12)** A dispatch that emits **no** signal at all reaches the same terminal outcome as one that signals, within one chunk of the same wall-clock. The attention channel is provably not load-bearing.

---

## Recommended team dispatch

- **research:** none. Every remaining question is a measurement (S25) or a build decision, not a reading task.
- **feasibility consults:**
  - **devops lead** — packaging and per-task snapshotting of the worker plugin (§7.5); the PostToolUse attestation hook as POSIX sh + `jq` matching this repo's existing style in `/Users/x/Development/dev-team-claude-plugin/hooks/hooks.json`; whether `~/.dev-team/` is the right root or whether an XDG-style location is preferred; the nonce file's permissions and cleanup on crash.
  - **backend lead** — the two-phase await state machine (§7.3), the nonce lifecycle (§7.1), token propagation down the dispatch chain (§7.2), and the signal-record schema alongside the existing `coder-return.schema.json`.
  - **qa lead** — the acceptance set above, especially AC-8 (negative test: forged token, no return) and AC-9's four post-condition cases; the transcript-assertion helper that every test in this package depends on (G18).
- **review gate:** `dev-team:plan-reviewer` (mandatory, author ≠ reviewer). **`dev-team:architect` second opinion is no longer recommended** — the two decisions that warranted it in v1 (the signal mechanism and the scoped-grant question) have both been settled by the user and by live evidence; the remaining design calls are narrower and the review round-trip is better spent on the plan-reviewer's reconciliation check.

---

## Proposed memory deltas

Reconciled against what is already recorded — nothing below re-proposes an existing entry.

**→ `/Users/x/Development/dev-team-claude-plugin/.claude/dev-team/memory/conventions.md`**

- **UPDATE the existing 2026-08-01 permission-rule-syntax entry** (currently marked *"on-machine confirmation pending — spike S22a"*): confirmed live on 2.1.220 (S22a passed both directions with `Edit(//abs/**)`; S22b showed a `Write(...)` rule is rejected on stderr with *"is not matched by file permission checks — only Edit(path) rules are. Use Edit(…) instead"*). Add: **grep a child `claude`'s stderr for `is not matched by file permission checks` to fail fast on a bad rule kind.**
- **NEW — 2026-08-01** — Never site an agent-writable directory under `.claude/`, `.git/`, `.vscode/`, `.idea/`, `.husky/`, or `.devcontainer/`. Live-verified: a `dontAsk` worker with an **exact-match** `Edit(//<repo>/.claude/dev-team/tasks/x/returns/**)` allow rule is **denied** — `permissions.allow` does not override protected-path denial. The boundary is asymmetric: an interactive/`auto` orchestrator session writes `.claude/dev-team/` fine, so the trap only bites the dispatched-worker path, which is exactly where return files live. *Why:* it silently breaks every worker return with a message the worker will narrate rather than escalate.
- **NEW — 2026-08-01** — `--allowedTools` is an allow-*rule* list, not a capability list; `--tools` is what closes the available tool set, and `--tools` does not cover MCP tools (use `--strict-mcp-config` + `--disallowedTools "mcp__*"`). A profile claiming a role "cannot run commands" is wrong unless Bash is absent from `--tools` — with Bash present, the built-in read-only set still executes in every mode. *Why:* omission from `--allowedTools` is denial for *execution*, but the tool is still in the model's context and the read-only set still runs.
- **NEW — 2026-08-01** — Any token that authorises a state transition must be an unguessable per-run nonce delivered out of band to the process that fires it, and must never reach the supervised process's argv, environment, or any directory that process can read. Prefer a mode-0600 file that the consumer reads and unlinks before the supervised process exists: on macOS, `ps eww` reports a process's **exec-time** environment, so unsetting an inherited env var after exec does not retract it. *Why:* discovered while closing a completion-token forgery hole in cmux mode.
- **NEW — 2026-08-01** — Never auto-`git reset --hard` a checkout the user owns. Automatic destructive recovery is permitted only on a path proven to be an agent-created worktree (is a worktree, shares the expected `git-common-dir`, is not the primary checkout); anything else refuses and escalates. *Why:* an over-broad cleanliness post-condition plus an automatic reset is a data-loss bug waiting on one false positive.

**→ `/Users/x/Development/dev-team-claude-plugin/.claude/dev-team/memory/architecture-notes.md`**

- **UPDATE the existing 2026-08-01 package-location entry** (currently *"not yet plan-reviewed; several §7 recommendations partially superseded"*): the package was plan-reviewed (verdict **REVISE**, `tasks/cmux-mode/plan-review.md`) and reconciled into **v2**, which supersedes v1 in full. All 1a platform gates (S22a/b/c/e/f/g, S24) are **discharged, PASS**; the remaining checks are S25a–e (two free, three cheap, none gating 1a's design). Read v2 + `spike-findings.md`'s two addenda; treat v1 as historical.
- **NEW — ADR-006 Amendment 1 (proposed): task artifacts relocate out of `.claude/` to `~/.dev-team/tasks/<repo-slug>/<task-slug>/`**, with parent-side-only state at `~/.dev-team/state/<task-slug>/` (nonce files, EXIT sentinels, hook attestation, per-task worker-plugin snapshot) which is never `--add-dir`'d. Configurable as `task_artifacts_root`. Supersedes ADR-006's `.claude/dev-team/tasks/<task-slug>/`. *Why:* `.claude/**` hard-denies `dontAsk` worker writes even with an exact-match allow rule (live-verified) — the accepted location would have broken the return-file contract on every dispatch; siting outside every checkout additionally removes the entire false-positive class from the `git status` post-condition. Status: proposed.
- **NEW — ADR-003 Amendment 1 (proposed): the completion token is an unguessable per-dispatch nonce, and completion is re-derived from the ladder on every wake regardless of which token released it.** The nonce reaches the adapter via a mode-0600 file outside the task dir that the adapter reads and unlinks before spawning `claude`; it never enters the worker's env, argv, kickoff, role body, or task dir. Rank-2's EXIT sentinel moves to parent-side state. The attention channel is orthogonal to the ladder, is never completion evidence, **and is best-effort by construction** — the `signals/` file record and the ladder carry every guarantee. Rank-2 is permanent (no process-exit event exists in cmux 0.64.20). Status: proposed.
- **NEW — ADR-005 Amendment 1 (proposed, extends the recorded 2026-08-01 D9 entry; does not supersede it): `--tools` is identical across all worker roles (`Read,Edit,Write,Glob,Grep,Bash`); profiles differ only in `--allowedTools`.** Judgment roles keep Bash and gain the built-in read-only set (`git log`, `git diff`, `grep`) plus the two cmux allows — which retires the hook-relay as a signal emitter and leaves exactly one emitter (the worker) for every role. The `git status --porcelain` post-condition is unconditional and applies to **all** roles (the live escape vector is `Bash(npm test *)` spawning repo-controlled scripts, an executor capability), with the reset scoped strictly to the worker's own worktree and a documented residual for writes outside the repo. Status: proposed.
- **NEW — ADR-012 (proposed, unblocked): "CLI permission rules are the primary enforcement layer; hooks enforce the invariants rules cannot express."** Rules own tool-set closure, path scoping, cmux verb containment and MCP/skill/subagent closure (all live-verified). Hooks own the bounded Stop gate, signal attestation, and startup fail-fast — **no PreToolUse hook on file tools in the default worker profile**, so there is no per-call latency cost. Neither layer closes G13's subprocess gap; the post-condition covers it inside the repo and OS sandboxing is deferred. *Note:* this **replaces** the v1 package's proposed ADR-012 framing ("hooks are the guarantee, CLI flags are defense-in-depth"), which was never committed — S22a and Tests A/B showed the CLI layer closes, weakening the necessity half of that argument while S22e strengthened its feasibility half. Status: proposed.
- **NEW — ADR-009 Amendment 1 (proposed): byte-stability applies to prompt bytes.** `--append-system-prompt-file` exists on 2.1.220 (S22g), so role bodies are static files passed by path — no interpolation. All per-dispatch variance rides env + the kickoff, and **attention tokens ride the kickoff as literals** (env delivery would require the untested `Bash(cmux wait-for -S "$VAR")` match form). The worker plugin's `hooks/hooks.json` stays static (env-driven path checks, no interpolated `if:` filters), and `--plugin-dir` points at a **per-task snapshot** rather than the version-pinned marketplace cache path. A `permissions`-only `--settings` file would not violate this ADR (recorded so the ban isn't over-applied), but is not needed. Status: proposed.
- **NEW — 2026-08-01** — Recommendation reversed vs. spike S16: role bodies use **`--append-system-prompt-file`**, not `--system-prompt` (replace). *Why:* S16's comparison is confounded (both arms ran under the `orchestration.md` injection), and a full replace discards Claude Code's built-in tool-use scaffolding for no isolation benefit — the bleed-through is hook-injected `additionalContext`, which survives a replace. Re-test after isolation lands (S23). Status: proposed.

---

**Files this package was reconciled against (all absolute):** `/Users/x/Development/dev-team-claude-plugin/tasks/cmux-mode/architecture-amendment-package.md` (v1, superseded), `/Users/x/Development/dev-team-claude-plugin/tasks/cmux-mode/plan-review.md`, `/Users/x/Development/dev-team-claude-plugin/tasks/cmux-mode/spike-findings.md`, `/Users/x/Development/dev-team-claude-plugin/tasks/cmux-mode/architecture-lead-context.md`, `/Users/x/Development/dev-team-claude-plugin/.claude/dev-team/memory/architecture-notes.md`, `/Users/x/Development/dev-team-claude-plugin/.claude/dev-team/memory/conventions.md`, `/Users/x/Development/dev-team-claude-plugin/.claude/dev-team/config.md`, `/Users/x/Development/dev-team-claude-plugin/hooks/hooks.json`, `/Users/x/Development/dev-team-claude-plugin/.gitignore`.

One fact worth flagging to the orchestrator before posting: `/Users/x/Development/dev-team-claude-plugin/.gitignore` contains no `tasks/` entry, so this repo's root `tasks/cmux-mode/*.md` are **tracked** files. That is fine for committed design documents, and it is a second, independent reason not to site ephemeral dispatch artifacts under a root `tasks/` directory.
