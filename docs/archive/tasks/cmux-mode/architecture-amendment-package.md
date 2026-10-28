# Architecture Package — cmux execution mode: Phase-0 spike reconciliation & ADR-005/D9 amendment

**Author:** architecture-lead · **Date:** 2026-08-01 · **Applies to:** epic #15 design record (TRD v2), issues #1 (spike), #3 (dispatcher), #4 (profiles/argv), #5 (worker neutralization)
**Status:** draft for `plan-reviewer` · not ratified · read-only output, nothing written or posted

---

## 1. Problem / goal

The Phase-0 spike (issue #1) returned five escalations against accepted TRD v2 text, plus one user-ratified amendment to ADR-005/D9. Three of the escalations claim an accepted mechanism is broken. This package decides which claims survive contact with the platform's actual contract, rewrites the affected spec text, and defines what must still be measured before slice 1a (contracts) can freeze.

**Headline result: two of the three "broken mechanism" findings are almost certainly false negatives caused by permission-rule syntax errors in the test, not by the platform.** The corrective is a syntax fix plus one re-test — not the coarse fallback the spike proposed. Conversely, one finding the spike treated as settled (finding 4, "allowlists don't close") is *also* a misreading, and one finding the spike treated as a conclusion (finding 5, replace-vs-append) is a confounded experiment whose recommendation I am reversing.

---

## 2. Artifact decision

| Artifact | Needed? | Why |
|---|---|---|
| **ADR amendments** (ADR-003, ADR-005, ADR-009) | Yes | Three accepted ADRs change in substance. ADR-005 changes twice (mechanism + D9 carve-out). |
| **New ADR-010** (containment layer) | Yes | "Where containment is enforced" becomes a durable, revisitable decision that all three amended ADRs now depend on. |
| **TRD §5.3 patch** (composed argv) | Yes | The literal block cannot execute as written. |
| **New spike items S22–S24** | Yes | Three load-bearing premises remain unverified; two of them gate slice 1a. |
| **PRD-lite** | No | No product/behavior ambiguity — the user's ask in decision 3 is behaviorally clear. |
| **New TRD/RFC** | No | This amends an existing accepted TRD; a second document would fork the record. |

---

## 3. Ground truth established this session (Claude Code platform contract)

All verified against current published docs (`code.claude.com/docs/en/permissions`, `/permission-modes`, `/cli-reference`, `/hooks`) — **not** against the installed 2.1.220 binary except where the spike tested it. Version-gated claims are marked.

| # | Fact | Bears on |
|---|---|---|
| G1 | **Path rules are consulted for `Edit(path)` and `Read(path)` only.** A `Write(path)`, `NotebookEdit(path)`, or `MultiEdit(path)` rule "is accepted but never consulted", and warns at startup. `Edit` rules cover *all* file-editing tools including Write. **Requires ≥ v2.1.210; installed is 2.1.220.** | S9 / ADR-005 |
| G2 | **`//path` = filesystem-absolute. A single leading `/` is NOT absolute** — for rules passed as CLI flags it anchors at the original cwd. Docs call this out explicitly: "A pattern like `/Users/alice/file` isn't an absolute path." | S9 / ADR-005 |
| G3 | **Precedence is deny → ask → allow, first match wins; a deny rule cannot carry allowlist exceptions.** `Bash(aws *)` in deny blocks `Bash(aws s3 ls)` in allow. | D9 amendment |
| G4 | **A bare tool-name deny removes the tool from context entirely; a scoped deny (`Bash(rm *)`) leaves the tool available and blocks only matching calls.** Documented behavior — matches the spike's `--disallowedTools "Bash"` observation exactly. | finding 4 / S22 |
| G5 | **`dontAsk` runs three things: calls matching `permissions.allow`, the built-in read-only Bash set, and calls approved by a PreToolUse hook.** The read-only set includes `ls, cat, echo, pwd, head, tail, grep, find, wc, which, diff, stat, du, cd` and read-only `git` — **in every mode, not configurable except by an ask/deny rule.** | finding 4 |
| G6 | **`--allowedTools` is an allow-*rule* list, not a capability list.** Docs: "To restrict which tools are available, use `--tools` instead." | finding 4 |
| G7 | **PreToolUse hook exit code 2 blocks the call *before* permission rules are evaluated and overrides allow rules.** Conversely a hook's `"allow"` never overrides a deny rule. Hooks load from plugins' `hooks/hooks.json`. | ADR-010 |
| G8 | **Bash argument-pattern rules are documented as fragile** (options reordering, variables, extra spaces, protocol variants) and the docs' own recommended remedy is a **PreToolUse hook**. Compound commands are split on `&& || ; |&` and newlines and each subcommand must match; wrappers `timeout/time/nice/nohup/stdbuf/command/builtin/noglob` and bare `xargs` are stripped before matching; `sh -c`, `eval`, `npx`, `docker exec` are **not** stripped. | D9 amendment / ADR-010 |
| G9 | **Protected paths are denied in `dontAsk` and `permissions.allow` does not override them.** Protected dirs include `.git`, `.claude` (except `.claude/worktrees`), `.vscode`, `.idea`, `.husky`, `.devcontainer`. | new constraint |
| G10 | **`AskUserQuestion` is denied in `dontAsk` even if allowed.** A worker in `dontAsk` has *no* in-band way to ask a question mid-turn. | D9 amendment (justification) |
| G11 | **`--add-dir` loads `.claude/skills/` and `.claude/agents/` from the added directory** (settings only for `enabledPlugins`/`extraKnownMarketplaces`). | new constraint |
| G12 | **`--bare` skips auto-discovery of hooks, skills, plugins, MCP servers, auto memory and CLAUDE.md**; `--strict-mcp-config` without `--mcp-config` loads no MCP servers; `--tools` does not affect MCP tools (`--disallowedTools "mcp__*"` does). | S23 (isolation/cost) |
| G13 | **Read/Edit deny rules apply to built-in file tools and to file commands Claude Code recognises in Bash (`cat`, `head`, `tail`, `sed`) — not to arbitrary subprocesses** (a node/python script that opens a file itself). OS-level enforcement requires the sandbox. | ADR-005 verification |
| G14 | The published CLI reference **documents `--system-prompt-file` and `--append-system-prompt-file`**, contradicting S8's read of `claude --help` on 2.1.220. Unresolved — see U1. | §5.3 |

---

## 4. Finding-by-finding verdict

| Spike finding | Verdict | Basis |
|---|---|---|
| **1 — `--append-system-prompt-file` missing** | **Contested, resolve by probe.** Docs list it; installed `--help` reportedly doesn't. Do not build on either belief — capability-probe at adapter init and branch. | G14 vs S8 |
| **2 — variadic flags swallow the bare prompt; `--` fixes it** | **Confirmed, adopt verbatim.** Four reproductions, one fix confirmation, and mechanistically obvious. Highest-priority literal fix. | S7/S9 |
| **3 — path-scoped grant "does not work"** | **Rejected as stated — almost certainly a false negative.** The test made *two* independent documented errors: it used `Write(...)` (never consulted at ≥2.1.210, G1) and a single-leading-slash "absolute" path (anchors at cwd, G2). ADR-005's own text — `Edit(//<task-dir>/returns/**)` — has neither error. Re-test before changing anything. | G1, G2 |
| **4 — `--allowedTools` is not a closed allowlist** | **Half right, wrong conclusion.** True and important: `--allowedTools` is not a capability list (G6). But the un-listed Bash call ran because `echo` is in the built-in read-only set that runs in *every* mode (G5) — not because allow rules fail. The corrective is `--tools` (capability closure), not "always pair with `--disallowedTools`". | G5, G6 |
| **5 — neither `--system-prompt` nor `--append-system-prompt` isolates the role body** | **Diagnosis right, recommendation reversed.** Both arms ran with `orchestration.md` injected, so the experiment is confounded and cannot rank replace vs append. Its *real* finding — hook-injected `additionalContext` survives a system-prompt replace — stands and is the important one. See §7.4: I recommend **append**, not replace, and a re-test after isolation lands. | S16, G12 |
| **6 — `--plugin-dir` hook delivery works** | **Accepted, with a scope caveat.** Only `SessionStart`/`Stop`/`UserPromptSubmit` were tested. **`PreToolUse`/`PostToolUse` from a plugin-dir plugin remain untested**, and ADR-010 below rests entirely on them. → S22e. | S11 |
| **7 — `new-surface --provider claude` dead end** | Accepted, confirms existing design. No change. | S21 |
| **8 — no process-exit event** | Accepted, standing constraint. No change. | S2 |
| **9 — cost ~2.1× / ~3.2×** | Accepted as a risk signal. §7.5 proposes a concrete lever (G12) rather than leaving it to the Phase-2 gate. | S15a |

---

## 5. Deliverable 1 — rewritten §5.3 composed argv

### 5.3 Composed argv (v3 — supersedes v2)

Hard rules, in priority order:

1. **A bare `--` immediately precedes the kickoff positional, always, on every dispatch, regardless of which flags are present.** No exceptions, no conditionals. This is a correctness rule, not a defensive one: without it the pane starts, `SessionStart` fires, `UserPromptSubmit` never does, and the dispatch idles forever with no error, no dialog, and no downstream liveness signal to detect it with.
2. **One argv token per permission rule.** Never comma-join permission rules — a rule may legitimately contain a comma. `--tools` is the exception and takes one comma-joined token (tool names cannot contain commas).
3. **Every path inside a permission rule is `//`-prefixed and absolute.** A single leading `/` silently anchors at the cwd and matches nothing (G2). The argv builder must assert this and refuse to dispatch otherwise.
4. **File-path rules are written as `Edit(...)` / `Read(...)` only** — never `Write(...)`, `MultiEdit(...)`, `NotebookEdit(...)`, `Glob(...)` (G1). `Edit(...)` covers Write. The argv builder must reject these rule kinds at composition time.
5. **Capability-probe the system-prompt flag once per adapter session**; never assume either shape.

```sh
# ── adapter init, once per session ───────────────────────────────────────────
#  CAP_SYSPROMPT_FILE=1  iff  `claude --help` advertises --append-system-prompt-file
#  (recorded in the adapter's `capabilities` output; drives the branch below)

# ── per dispatch ─────────────────────────────────────────────────────────────
#  ROLE_PROMPT : <plugin-root>/scripts/cmux/roles/<role>.txt
#                role body + static profile addendum, frontmatter stripped.
#                Byte-stable per role — ADR-009. No per-dispatch value ever enters it.
#  WORKTREE    : absolute path to this dispatch's git worktree
#  TASK_DIR    : absolute path to the task dir.  MUST NOT contain, or sit under,
#                any protected directory name (.claude, .git, .vscode, .idea,
#                .husky, .devcontainer …) — writes there are denied in dontAsk and
#                allow rules do not override (G9). MUST NOT contain a `.claude/`
#                subdirectory of its own — --add-dir would load skills/agents
#                from it (G11).

claude \
  --model "$MODEL" \
  --effort "$EFFORT" \
  --permission-mode dontAsk \
  $( [ -n "$CAP_SYSPROMPT_FILE" ] \
       && printf '%s %s' --append-system-prompt-file "$ROLE_PROMPT" \
       || printf '%s %s' --append-system-prompt "$(cat "$ROLE_PROMPT")" ) \
  --tools "Read,Edit,Write,Glob,Grep,Bash" \
  --allowedTools \
      "Edit(//$WORKTREE/**)" \
      "Edit(//$TASK_DIR/returns/**)" \
      "Edit(//$TASK_DIR/signals/**)" \
      "Bash(npm run typecheck *)" \
      "Bash(npm test *)" \
  --disallowedTools \
      "Bash(cmux *)" \
      "mcp__*" \
      "Task" "Agent" \
  --strict-mcp-config \
  --disable-slash-commands \
  --plugin-dir "$PLUGIN_ROOT/scripts/cmux/worker-plugin" \
  --add-dir "$TASK_DIR" \
  -- \
  "$KICKOFF"
```

**Changes from v2, and why:**

| Change | Reason |
|---|---|
| `-- ` before `$KICKOFF` | S7/S9 silent-stall bug. Mandatory. |
| `--append-system-prompt-file` → capability-probed branch | G14 vs S8 contradiction; do not bet either way. |
| replace → **append** as the base | §7.4. S16 is confounded; append preserves Claude Code's built-in tool-use scaffolding, which a worker depends on. |
| `Edit(//abs/…)` everywhere; `Write(…)` rules banned | G1 + G2 — this is the actual fix for S9. |
| `Edit(//$TASK_DIR/signals/**)` added | Carries the mid-task upward signal (§7.3). |
| `Read(//$TASK_DIR/**)` **not** added | Reads inside cwd + `--add-dir` never prompt, so `dontAsk` never denies them. A rule here would be noise. |
| `+ --strict-mcp-config`, `+ --disallowedTools "mcp__*"` | S14 found panes inherit the user's full MCP set. `--tools` does not cover MCP tools (G12). Also a direct cost lever against S15a. |
| `+ --disallowedTools "Task" "Agent"` | Belt for ADR-005's "no Task tool"; `--tools` omission is the brace. Tool-name ambiguity is U11. |
| No change to `--disallowedTools "Bash(cmux *)"` | The D9 amendment is satisfied **without** carving a hole here — see §7.3. |
| `--disable-slash-commands` kept | Docs confirm it disables "all skills and commands"; S8's flag/description naming worry is resolved, no S13 follow-up needed. |

**Judgment-role variant (planner / reviewer):** identical, with `--tools "Read,Edit,Glob,Grep"` (Bash dropped entirely rather than restricted — see below) and the `Edit(//$WORKTREE/**)` grant removed, leaving only `returns/` and `signals/`.

> **Note on "judgment roles lose Bash":** dropping Bash from `--tools` is materially different from denying it with rules. If Bash stays in `--tools` with no allow rule, the built-in read-only set (`cat`, `git log`, `grep`, …) still executes in `dontAsk` (G5). That's benign, but it is not "no Bash," and the profile documentation must not claim it is. If a judgment role genuinely needs `git log`/`git diff`, keep Bash in `--tools` and rely on G5 rather than writing allow rules for it.

---

## 6. Deliverable 2 — resolved position on ADR-005's scoped-grant mechanism

### Options

**A. Re-test with corrected rule syntax (`Edit(//abs/**)`), keep the CLI-flag mechanism.**
Optimizes: no design change, no new moving parts, matches ADR-005's already-accepted text. Sacrifices: one more spike cycle before 1a freezes; if it fails, we've spent a cycle.

**B. Move the rules into a per-task `--settings` JSON permissions block.**
Optimizes: richer rule surface, survives any CLI-flag-specific parsing quirk. Sacrifices: a per-dispatch generated artifact (partially against ADR-009's grain, though a *permissions-only* settings file touches no prompt bytes and so does not actually break prefix stability); adds a second path-anchoring regime (`/path` anchors at the settings file's directory) — a fresh footgun of exactly the class that caused this whole detour.

**C. Adopt the coarse fallback now: unscoped write + `git status --porcelain` refusal.**
Optimizes: certainty, ships today. Sacrifices: it discards a working mechanism on the strength of a mis-syntaxed test; detection-after-the-fact instead of prevention; and it doesn't actually cover the case it's sold as covering (a judgment role writing *outside* the checkout is invisible to `git status`).

**D. Enforce path scoping in the worker plugin's `PreToolUse` hook.**
Optimizes: deterministic, version-independent, immune to rule-syntax regressions, and it covers rule kinds the permission layer refuses to consult at all. Sacrifices: a hook process per file-tool call; depends on plugin-dir `PreToolUse` actually firing (untested).

### Recommendation: **A + D, with C demoted from "fallback" to "standing post-condition". B held as the fallback if A fails.**

Reasoning:

1. **A first, because the evidence says the mechanism was never actually tested.** S9 tested `Write(<single-slash path>)`. Per G1 that rule kind is accepted-and-never-consulted on this exact version, and per G2 that path form resolves to `<cwd>/abs/path/...`. Two independent, documented reasons for the observed denial, both of which ADR-005's own text avoids. The correct reading of S9 is *"the S9 test was invalid,"* not *"ADR-005 is invalid."* Changing an accepted security mechanism on the basis of a mis-syntaxed test would be the more expensive error. A dispatcher-side assertion (rule kind ∈ {Edit, Read}, path starts with `//`) makes the class of error unrepeatable.
2. **D regardless of A's outcome, because the permission layer cannot deliver the guarantee ADR-005 claims.** G13 is explicit: Read/Edit rules cover built-in file tools and a handful of recognised Bash file commands — *not* arbitrary subprocesses. Any role with Bash can write anywhere via `node -e`, `python -c`, or a redirect. So even a fully working `Edit(//…/returns/**)` grant is a fence, not a wall, for Bash-enabled roles. If we want a *guarantee*, it has to sit where the platform says guarantees sit (G7/G8: PreToolUse hooks). See ADR-010.
3. **C becomes a post-condition, not a fallback.** `git status --porcelain` over the primary checkout before accepting any judgment-role return is cheap, catches every prevention-layer failure including ones we haven't imagined, and should run *whether or not* scoping works. As a *replacement* for scoping it's weak (blind outside the repo); as a **verification** layer it's exactly right. Pair it with a hard reset of the worktree on refusal.
4. **B only if A fails**, and if used, restrict the file to a `permissions` object and keep `//`-absolute paths so the anchoring difference never bites.

**Net effect on ADR-005:** the ADR's *decision* is unchanged (allowlist-shaped profiles, one scoped write grant to `returns/`). What changes is (i) the rule spelling, (ii) where the guarantee lives, and (iii) an unconditional post-condition. The S9/S10 gate on ADR-005 is **not** discharged — it is re-armed as S22, with a corrected test.

---

## 7. Deliverable 3 — mid-task upward signal (ADR-005/D9 amendment)

### 7.1 What the capability actually has to be

The four-rank completion ladder is entirely **turn-end or process-end triggered**. Every rank fires when something *stops*. There is therefore a real, structural gap, and it is not the one D9 originally addressed:

- A worker 20 minutes into a long task that hits a wall has no way to say so until it ends its turn.
- In `dontAsk`, `AskUserQuestion` is denied by the mode itself (G10) — the model's only built-in "ask a human" affordance is switched off by our own profile.
- The star topology has no worker↔lead channel; today's only escalation path is end-the-turn-with-`status:"insufficient"` and wait to be noticed.

So the amendment is justified on architecture, not only on preference: **it fills the one hole the ladder cannot reach — attention *without* termination.** That framing also bounds it: the signal is an *attention* channel, never a *completion* channel (see ADR-003 amendment, §8.1).

### 7.2 Why the literal ask ("scoped `cmux` verb allowlist") should not be built

The user's framing asked for a narrow enumerated cmux allowlist — `notify`, `wait-for -S` — with topology verbs excluded. Three platform facts make that specific shape a poor container for the goal:

1. **G3 — a deny rule cannot carry exceptions.** `deny Bash(cmux *)` + `allow Bash(cmux notify *)` resolves to *denied*. Keeping the carve-out therefore forces us to **delete** the blanket `Bash(cmux *)` deny and replace it with an enumeration of forbidden verbs. That inverts the failure mode from fail-closed to **fail-open**: every cmux verb we didn't think of, and every verb a future cmux release adds, becomes reachable. D9's containment goal ("workers must not drive topology") would be strictly weakened by the mechanism meant to preserve it.
2. **G8 — Bash argument patterns are documented as fragile** and are not a security boundary. `cmux  notify` (two spaces), `CMUX_X=1 cmux notify`, `sh -c 'cmux close-surface …'`, `eval`, or a one-line shell script all defeat prefix rules in ways the docs enumerate themselves.
3. **It doesn't generalise to judgment roles.** Planner/reviewer profiles may carry no Bash at all, so a Bash-delivered signal is unavailable to precisely the roles most likely to return `insufficient`.

### 7.3 Recommended mechanism: **write-triggered signal, hook-delivered**

**The model gets zero new tool surface. `Bash(cmux *)` stays fully denied. The worker's only action is a file write it is already permitted to make.**

```
worker (any role)                worker plugin (static, --plugin-dir)         parent
──────────────────               ────────────────────────────────────         ──────
Write/Edit →
  $TASK_DIR/signals/
    <dispatch_id>.jsonl   ──►    PostToolUse (matcher: Write|Edit)
    {level, message,               ├─ path under $DEVTEAM_TASK_DIR/signals/ ? else exit 0
     escalate_to}                  ├─ validate: level ∈ {progress, blocked, question},
                                   │            message ≤ 200 chars, ≤5 signals/dispatch,
                                   │            ≥30 s since last  → else exit 0 quietly
                                   ├─ cmux wait-for -S "devteam-<dispatch_id>-attn-<n>"   ──►  releases
                                   └─ if level ∈ {blocked, question}:                          the await
                                        cmux notify "<role> · <task>: <message>"          ──►  human
```

**Contract:**

| Element | Value |
|---|---|
| Worker-visible surface | One directory: `$TASK_DIR/signals/`. One JSON-line schema: `{level, message, escalate_to}`. Nothing else. |
| `level` | `progress` \| `blocked` \| `question` — closed enum, hook-validated. |
| `escalate_to` | `lead` \| `orchestrator` \| `user` — **routing intent only.** Transport is always to the immediate dispatcher; the parent relays. No new edge in the topology. |
| Identity | `dispatch_id`, `task_id`, `role`, signal token all come from **env** (`DEVTEAM_*`), never from the file. A worker cannot address another dispatch's token. |
| Rate limit | Hook-enforced: ≤5 signals per dispatch, ≥30 s apart. Over-limit signals are recorded in the file and simply not amplified. |
| Shell safety | Hook builds the cmux argv as an array from validated fields; worker text never reaches a shell interpreter, never reaches a cmux verb slot. |
| cmux verbs reachable | Exactly two, both hard-coded in the hook: `wait-for -S`, `notify`. Topology verbs are unreachable **by construction**, not by rule. |

**Why this is the right shape:**

- **It preserves D9 exactly.** No hole in `Bash(cmux *)`. The containment argument D9 made ("a coder that can close surfaces can close its reviewer") never has to be re-litigated.
- **It is immune to the S22 outcome.** Whether pattern-scoped Bash rules enforce correctly no longer matters for this feature. That decoupling is worth a lot of schedule risk.
- **It honours the user's framing precisely** — "workers and leads shouldn't skip on those files, but should be able to signal to upper levels using cmux." The file *is* the record; cmux *is* the nudge; the two are the same action.
- **It works for every role**, Bash or not.
- **It uses the mechanism the design already relies on:** hooks run outside the tool-permission system, which is exactly the property ADR-003 cited for the Stop-hook gate.

**Deviation flag — needs user ratification.** This delivers the *capability* the user ratified while declining the *mechanism* the user sketched (an enumerated cmux verb allowlist). I judge it strictly better against the user's own stated goal, but it is a deviation from a ratified decision and must be surfaced as one, not folded in silently — the same class of unflagged substitution the plan-reviewer caught in the original D9 removal.

**Parent-side re-arm (design detail for #3):** tokens latch permanently (S5), so a fixed token gives exactly one live nudge per dispatch. Use a sequenced token: worker's hook signals `devteam-<dispatch_id>-attn-<n>` where *n* is the new line count of the signals file; the parent awaits `attn-<lines+1>` with its chunk timeout, and the adapter `EXIT` trap signals the then-current *n+1* as well, so one blocking primitive covers both attention and completion wakes. Stale-token wakes cost one wasted loop iteration and cannot deadlock. If this proves fiddly in build, the degraded form — fixed token, guaranteed live nudge for the first signal only, everything else picked up at the next poll — is acceptable and should be the fallback rather than a reason to add machinery.

**Deferred, explicitly:** a `devteam-signal` wrapper binary on PATH for Bash-enabled executors (nicer ergonomics, same guarantees, but requires a Bash grant and a second enforcement path). Also deferred: `set-status` / `set-progress` pane badges driven from the same hook — Phase-2 polish.

### 7.4 Reversal: append, not replace, for role bodies

S16 concluded "use `--system-prompt` (replace)". I'm reversing that recommendation and the reasoning is worth recording:

- Both S16 arms ran with `orchestration.md` injected as `additionalContext`. The comparison measures "which flag loses less badly to a competing 20 KB injection," not "which flag composes a role body better." **The experiment cannot rank the flags** and its ranking should not be carried into the design.
- `--system-prompt` **replaces the entire system prompt** — including Claude Code's own tool-use scaffolding. For a worker whose entire job is disciplined Edit/Bash/Read use, that is a quality risk we have no measurement of, taken to solve a problem (ambient context bleed) that it demonstrably does not solve.
- The finding that *does* survive is the important one: **hook-injected `additionalContext` survives a full system-prompt replace.** Isolation is therefore an isolation problem, not a prompt-flag problem.

**Position:** default to `--append-system-prompt(-file)`; re-run the replace/append comparison **after** isolation exists (S23/issue #5), as a one-line A/B on a real role body. ADR-009's byte-stability requirement is satisfied identically either way.

### 7.5 Isolation and the cost signal — one lever for both

S15a's ~2.1× tokens / ~3.2× wall-clock is a real risk against the ≤2× ceiling, and S14 identified the cause: a pane is a *full* session with the user's entire plugin/MCP/skill environment loaded. G12 gives three unpulled levers — `--strict-mcp-config`, `--setting-sources`, `--bare` — that attack the isolation problem and the cost problem simultaneously.

Most consequentially: **if `--setting-sources` (excluding `user`) prevents `enabledPlugins` from loading, the dev-team plugin's `SessionStart` injection never fires in a worker pane at all — and the hard dependency on issue #5's `DEVTEAM_WORKER` guard disappears.** `--bare` would do the same more bluntly, if it still honours an explicit `--plugin-dir`. Both are unverified. This is high-value enough to spike (S23) but must not block 1a.

Keep issue #5's guard on the roadmap regardless: it is the correct fix for the *general* case (a worker pane launched by any path), and `--setting-sources` is a dispatcher-side convenience layered on top.

---

## 8. Deliverable 5 — other ADR amendment notes

### 8.1 ADR-003 (completion ladder) — Amendment 1

- **The attention channel is orthogonal to the ladder and is never completion evidence.** On an attention wake the parent must re-derive completion solely from the ladder (return file present *and* schema-valid, EXIT sentinel, Stop-hook gate). Without this invariant a worker could "complete" by signalling. State it as an explicit non-goal in the ADR text.
- **Rank-2 (EXIT trap) confirmed necessary, not provisional** — no per-surface process-exit event exists in the event catalogue (S2). Remove any "may be retired by future cmux events" hedge.
- **Rank-3's rationale strengthens.** "Hooks run outside the tool-permission system" is now doing double duty: it justifies the Stop gate *and* it is the delivery mechanism for §7.3 and the enforcement point for ADR-010. Cross-reference them so a future editor can't weaken one without noticing the others.
- **Rank-0 chunk sizing:** S17 raises the Bash ceiling to 600 s (120 s default). The 90 s chunk stands as conservative-safe; widening is tuning, not a blocker.

### 8.2 ADR-005 (security posture) — Amendment 1 (mechanism) + Amendment 2 (D9)

- **Amendment 1 (mechanism):** rule spelling is normative — `Edit(...)`/`Read(...)` only, `//`-absolute paths only, enforced by a composition-time assertion in the argv builder (G1, G2). `--allowedTools` is explicitly **not** a capability list; **`--tools` closes the tool set** (G6). Remove the "pair every allow with a matching deny" guidance the spike proposed — it's the wrong corrective for finding 4 and adds rules that can only mis-fire under deny-beats-allow.
- **Amendment 1 (cont.):** add the read-only-Bash carve-out (G5) as a **documented, accepted residual**: in every mode, `cat`/`ls`/`grep`/`git log`-class commands execute without an allow rule. Any profile description claiming a role "cannot run commands" must be corrected to "cannot run state-changing commands."
- **Amendment 1 (cont.):** the **`git status --porcelain` post-condition is unconditional**, not a fallback (§6.3), with a hard worktree reset on refusal, and a documented blind spot (writes outside the checkout).
- **Amendment 1 (cont.):** new **protected-path constraint (G9)** — `returns/`, `signals/`, and the task dir itself must not sit under `.claude`, `.git`, `.vscode`, `.idea`, `.husky`, or `.devcontainer`. `~/.claude/dev-team/…` is specifically disqualified as a task-dir root: writes there are denied in `dontAsk` and allow rules do not override. Given the repo already keeps `.claude/dev-team/memory/` and `~/.claude/dev-team/task-cost/`, this is a live trap, not a theoretical one. Also: the task dir must contain no `.claude/` subdirectory (G11).
- **Amendment 1 (cont.):** add **`--strict-mcp-config` + `--disallowedTools "mcp__*"`** to every worker profile — S14 established panes inherit the ambient MCP set and `--tools` does not cover MCP tools.
- **Amendment 2 (D9 / worker cmux access):** supersedes both the original D9 carve-out *and* the architect-Q1 removal. Workers remain denied `Bash(cmux *)` in full; the upward signal is delivered by the write-triggered hook of §7.3. Record the deviation flag from §7.3 alongside it.

### 8.3 ADR-009 (byte-stable pane prefixes) — Amendment 1

- **Holds, and its rejection of a per-dispatch `--settings` blob is reaffirmed** — but the rationale should be narrowed to what's true: what must stay byte-stable is the *prompt*. A `--settings` file containing **only** a `permissions` object touches no prompt bytes and is therefore admissible as the §6 Option-B fallback without violating this ADR. Say so explicitly so a future reader doesn't over-apply the ban.
- **The worker plugin's `hooks/hooks.json` must be static** — no per-dispatch path interpolation, including in `if:` filters. The §7.3 hook therefore reads `$DEVTEAM_TASK_DIR` from env and does its own path check rather than relying on an `if: "Edit(//…/signals/**)"` filter.
- **`--plugin-dir` delivery confirmed** for `SessionStart`/`Stop`/`UserPromptSubmit` (S11); `PreToolUse`/`PostToolUse` remain unconfirmed and are now load-bearing → S22e.
- **Operational caveat:** the managed setting `disableSideloadFlags` rejects `--plugin-dir` at startup. Not a concern on this machine, but the adapter's `capabilities` probe should detect it and fail fast with remediation text rather than silently dispatching un-hooked workers.

### 8.4 Ratified operational decisions — recording notes

- **Archive on any failure (decision 1):** amends D6/R8 from "dispatch exited non-zero" to "any failure at any level — dispatch, task, or otherwise," overriding `keep_task_artifacts: false`. Needs one concrete definition in the TRD of what "failure at task level" means mechanically (non-zero dispatch exit **or** a refused/invalid return **or** a `blocked`-level signal that ends unresolved **or** an orchestrator-declared abort), otherwise implementers will each pick a different set.
- **Decisions 2, 4, 5, 6:** ratified as-is, no architectural consequence. Decision 5 is now evidence-backed (S6) rather than assumed.

### 8.5 Forward-looking, explicitly **not** building now

OS-level sandboxing (`sandbox.filesystem`) is the only mechanism that closes G13's subprocess gap — permission rules and hooks both see tool calls, not the file syscalls of a `node -e` child. Worth an ADR **later**, if judgment-role containment ever needs to be a wall rather than a fence. Not now: it adds a platform-specific enforcement layer for a threat model (a confused-but-not-adversarial worker) that the `git status` post-condition already covers adequately.

---

## 9. Deliverable 4 — new spike items

### S22 — Permission-rule enforcement matrix *(gates slice 1a; blocks Phase 1c)*

**Question:** with corrected syntax, which permission mechanisms actually enforce on `claude 2.1.220` under `--permission-mode dontAsk`?
**Cost:** ~7 short `claude` launches, trivial prompts. Real but small API spend.
**Method:** one throwaway dir outside the repo; every run verified via `~/.cmuxterm/events.jsonl` (`PreToolUse`/`Stop`), **never** via `read-screen` (S7's lag caveat).

| Sub | Test | Pass condition |
|---|---|---|
| **S22a** | `--tools "Read,Edit,Write,Glob,Grep" --allowedTools "Edit(//<abs>/returns/**)" -- "<write inside; then write outside>"` | Write **inside** succeeds; write **outside** denied. Both directions required — inside-only proves nothing. |
| **S22b** | Same rule, but `Write(//<abs>/returns/**)` instead of `Edit(...)` | Expected: denied **and** a startup warning ("is not matched by file permission checks"). Confirms G1 on this build and confirms the warning is detectable, so the argv builder can fail fast. |
| **S22c** | `--allowedTools "Bash"` + `--disallowedTools "Bash(cmux *)"` -- "run `cmux ping`, then run `date`" | `cmux ping` blocked; `date` runs; turn completes, no stall. Answers the original S22 question. |
| **S22d** | `--disallowedTools "Bash(cmux *)"` **plus** `--allowedTools "Bash(cmux notify *)"` | Expect **denied** (G3, deny-beats-allow). Confirms on this build that the enumerated-carve-out design of §7.2 is genuinely unavailable. |
| **S22e** | Minimal `--plugin-dir` plugin registering `PreToolUse` (returns `permissionDecision:"deny"` for one command; `"allow"` for another that no allow rule matches) **and** `PostToolUse` (matcher `Write\|Edit`, writes a log line) | Deny actually blocks; allow actually permits under `dontAsk`; PostToolUse fires on a Write. **This is the keystone — ADR-010 and §7.3 both fail without it.** |
| **S22f** | Full v3 argv from §5.3, real role file, trivial kickoff | `UserPromptSubmit` fires; turn completes. End-to-end smoke of the rewritten block. |
| **S22g** | `claude --help | grep -E -- '--(append-)?system-prompt-file'` | Resolves U1 definitively. Free, run first. |

**On-no ladder:** S22a fails → §6 Option B (`--settings` permissions block), re-test; B fails → Option C (unscoped + `git status`) *and* raise D's priority from defense-in-depth to sole mechanism. S22e fails → ADR-010 is withdrawn, §7.3's signal must fall back to the deferred `devteam-signal` wrapper + a re-opened D9 carve-out question, and §6's D layer disappears — **escalate before proceeding**, this is the widest-blast-radius failure in the set.

### S23 — Worker isolation & context-cost profile *(gates Phase-2 GO/NO-GO, not 1a)*

**Question:** which of `--setting-sources`, `--strict-mcp-config`, `--bare` actually suppress ambient plugin/MCP/CLAUDE.md loading in a dispatched pane, what does each cost in tokens, and does any of them make issue #5's `DEVTEAM_WORKER` guard unnecessary for the dispatch path?
**Method:** same trivial fixed spec as S15a, four arms (baseline / `--strict-mcp-config` / `--setting-sources` minus `user` / `--bare`), each with an explicit `--plugin-dir`, comparing `cache_creation + cache_read + input + output` tokens and checking whether the dev-team `SessionStart` injection still fires.
**Also answers:** does `--bare` still honour an explicit `--plugin-dir`? (If yes, `--bare` + worker plugin is the strongest worker profile available and directly attacks S15a's 2.1×.)
**Then:** re-run the S16 append-vs-replace comparison in whichever arm achieves clean isolation.

### S24 — Cross-workspace signal delivery *(gates slice 1a; free, no API spend)*

**Question:** does a `cmux wait-for -S <token>` fired **from inside workspace B** release a waiter armed **in workspace A**?
**Why it's load-bearing:** S5 inferred a global token namespace from the absence of a `--workspace` flag plus tmux precedent — it never ran two workspaces. The design puts workers in a separate workspace from their parent, so *every* completion signal and *every* §7.3 attention signal crosses that boundary. If the namespace is workspace-scoped, ADR-003's rank-2 EXIT trap and the entire §7.3 mechanism both silently no-op.
**Method:** `new-workspace`, arm a backgrounded waiter in A, fire from a shell in B, and repeat in the latched order. Two minutes, no model calls.
**On-no:** all cross-workspace liveness reverts to rank-0 file watch; the attention channel degrades to `cmux notify` only (human-visible, not parent-visible) — a materially weaker amendment that the user would need to re-ratify.

### Carried forward (unchanged)

- **S20 — restart durability.** Still deferred; needs a coordinated cmux quit/relaunch. Not blocking (the rank-0 file watch is the recovery path either way). Should be run before anything depends on in-memory `wait-for` latch durability.
- **S15b — full cost measurement.** Phase-2 GO/NO-GO, with the real dispatcher, after S23's levers are applied.

---

## 10. Phases & gating impact

| Slice | Gated on | Status after this package |
|---|---|---|
| **1a — contracts freeze** (profile schema, argv builder, signal-record schema, return schema) | S22a, S22c, S22e, S22g, S24 | **Blocked.** S22g and S24 are free/cheap; S22a/c/e are ~5 launches. One short session unblocks 1a. |
| **1b — dispatcher (#3)** | 1a + S24 | Unblocked once 1a freezes. Token re-arm design (§7.3) lands here. |
| **1c — profiles/argv (#4)** | 1a + S22b/f | Was the item the spike said S22 gates; still true, now with a concrete test list. |
| **#5 — worker neutralization guard** | none | **Downgraded from hard blocker to parallel work**, *if* S23 shows `--setting-sources`/`--bare` suppresses the injection dispatcher-side. Still the right general-case fix; keep it. |
| **Phase 2 GO/NO-GO** | S23 → S15b | S23 should run before S15b so the cost measurement reflects the isolated profile, not the ambient one. Measuring the un-tuned profile against the ≤2× ceiling would likely produce a false NO-GO. |

---

## 11. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| S22e fails — plugin-dir `PreToolUse`/`PostToolUse` don't fire or aren't honoured | **High** — ADR-010, §6 layer D and §7.3 all collapse together | Run S22e first among the paid tests; explicit escalation path in the on-no ladder; §7.3 fallback (wrapper binary) already sketched |
| S24 fails — workspace-scoped token namespace | High | Rank-0 file watch covers completion; attention channel degrades to human-only notify; needs user re-ratification of the amendment's value |
| S22a also fails with correct syntax | Medium | Option B, then Option C; the `git status` post-condition already exists either way so the security floor doesn't move |
| Cost ceiling breached even after S23's levers | Medium | S23 quantifies the headroom *before* the GO/NO-GO rather than at it |
| Hook-per-tool-call latency compounds the 3.2× wall-clock | Low–Medium | Keep hooks to a single small script with an early `exit 0` on non-matching paths; measure in S23's arms |
| Amendment scope creep — the signal channel becomes a control channel | Medium | The §7.3 contract is closed by construction (enum + env-sourced identity + two hard-coded verbs); the ADR-003 amendment forbids treating it as completion evidence |
| Deviation in §7.3 lands without user ratification | Medium | Flagged explicitly in §7.3 and in the memory delta; the orchestrator must put it to the user, not fold it in |

---

## 12. Open unknowns & assumptions

**Assumptions this design rests on:**

| # | Assumption | Status |
|---|---|---|
| A1 | Precedence is deny → ask → allow; deny cannot carry exceptions | **Verified** (docs, `permissions.md` §Manage permissions) |
| A2 | `Edit(path)` covers all file-editing tools; `Write(path)` rules are accepted-but-never-consulted at ≥ 2.1.210 | **Verified** (docs); *applies to installed 2.1.220* |
| A3 | `//` = filesystem-absolute; single `/` anchors at original cwd for CLI-flag rules | **Verified** (docs, incl. explicit warning) |
| A4 | `dontAsk` runs allow-matched calls, the built-in read-only Bash set, and PreToolUse-hook-approved calls; always denies `AskUserQuestion` | **Verified** (docs, `permission-modes.md`) |
| A5 | Hook exit 2 blocks before rules and overrides allow; a deny rule beats a hook's allow | **Verified** (docs) |
| A6 | Protected-path writes (incl. `.claude`) are denied in `dontAsk` and allow rules don't override | **Verified** (docs) |
| A7 | A bare `--` before the positional fixes the variadic swallow | **Verified** (spike, 4 reproductions + 1 fix confirmation) |
| A8 | plugin-dir `SessionStart`/`Stop`/`UserPromptSubmit` hooks fire in a dispatched pane | **Verified** (spike S11, live) |
| A9 | S9's failure was *purely* syntactic (rule kind + path anchoring), with no third cause | **Unverified** — the entire §6 recommendation rests on this. → S22a/S22b |
| A10 | plugin-dir `PreToolUse`/`PostToolUse` fire and their decisions are honoured | **Unverified** — keystone for ADR-010 and §7.3. → S22e |
| A11 | `wait-for` tokens are globally namespaced across workspaces | **Unverified** — inferred from a missing flag + tmux precedent. → S24 |
| A12 | `cmux notify` from a worker pane reaches the human as a visible notification | **Unverified** — `notify` exists (S2) but was never invoked |
| A13 | Replacing the default system prompt degrades worker tool-use quality | **Unverified inference** from "replaces the entire system prompt" — it is *why* I recommend append, so if someone wants replace, this is the thing to measure |
| A14 | A worker's role body can reliably drive a structured file write it was instructed to make | **Unverified** — §7.3's usability (not its safety) depends on it; prompt-dependence was the original argument against self-signal and it applies here too, mitigated by the file contract being the primary path regardless |
| A15 | The published docs describe the installed 2.1.220 behaviour | **Partially contradicted** — see U1. Every doc-derived fact above should be treated as high-confidence-but-build-specific until S22 confirms on-machine |

**Unknowns needing scouting, a consult, or a decision:**

| # | Unknown | Route |
|---|---|---|
| U1 | Do `--system-prompt-file` / `--append-system-prompt-file` exist on 2.1.220? Docs say yes, S8's `--help` read says no. | S22g (free, run first). Until resolved, the capability-probe branch in §5.3 stands. |
| U2 | Where does the design put the task dir? If it's under `~/.claude/dev-team/` or any protected name, worker writes are denied outright and no allow rule can fix it (G9). | **Needs an answer from the epic's #3/#6 text before 1a.** Orchestrator to confirm. |
| U3 | Is the subagent-spawn tool named `Task` or `Agent` in permission-rule space on this build? | Minor; deny both, rely on `--tools` omission. Confirm opportunistically in S22. |
| U4 | Does `--setting-sources` excluding `user` actually prevent `enabledPlugins` from loading? Does `--bare` still honour an explicit `--plugin-dir`? | S23 |
| U5 | Are ADR numbers 010+ free in the epic's design record? | Orchestrator — I can't read the epic. Renumber on commit if taken. |
| U6 | Restart durability of `wait-for` latches and moved panels | S20, still deferred |
| U7 | Whether the user accepts §7.3's deviation from the literal "scoped cmux allowlist" ask | **User decision — must be put to them explicitly, before build.** |
| U8 | What "failure at task level" means mechanically for the broadened archive rule | Needs one sentence of definition in the TRD (§8.4) |

---

## 13. Acceptance criteria

**For this amendment package:**
1. `plan-reviewer` confirms every claimed platform fact in §3 carries a doc or spike citation, and that no recommendation rests on an unverified assumption without a marked spike item.
2. The §7.3 deviation is put to the user as a deviation and ratified or rejected explicitly.
3. U2 (task-dir location vs. protected paths) is answered before 1a freezes.

**For S22 (unblocks 1a):**
4. Every sub-item has a yes/no with the exact command and event-log evidence (not `read-screen`).
5. S22a demonstrates the grant in **both** directions (allowed path succeeds, adjacent path denied).
6. S22e demonstrates hook deny **and** hook allow under `dontAsk`, plus PostToolUse firing.

**For the built dispatcher (Phase 1):**
7. The argv builder refuses to compose a dispatch that violates any §5.3 hard rule (missing `--`, non-`//` path in a rule, a `Write(...)`/`Glob(...)`/`MultiEdit(...)` path rule, a task dir under a protected name) — with a test per rule.
8. No worker profile can reach any cmux verb other than `wait-for -S` and `notify`, and neither via a model-issued tool call.
9. Every judgment-role return is refused if `git status --porcelain` over the primary checkout is non-empty outside `returns/`, with the worktree hard-reset on refusal.
10. An attention signal never satisfies completion: a test dispatches, signals `blocked`, and asserts the parent wakes, relays, and continues awaiting rather than marking the dispatch complete.

---

## Recommended team dispatch

- **research:** none. Prior art and the platform contract are established above; further reading has diminishing returns against actually running S22.
- **feasibility consults:**
  - **devops lead** — packaging of the worker plugin's `PreToolUse`/`PostToolUse` scripts (POSIX sh + `jq`, matching this repo's existing hook style in `/Users/x/Development/dev-team-claude-plugin/hooks/hooks.json`); per-call latency budget; whether `--plugin-dir` at `<plugin-root>/scripts/cmux/worker-plugin` survives the version-pinned marketplace cache path convention.
  - **backend lead** — the dispatcher await/re-arm state machine in §7.3 (sequenced token, atomic rename, stat-after-arm), and the signal-record schema alongside the existing `coder-return.schema.json`.
  - **qa lead** — S22's evidence format and the acceptance tests 7–10 above; specifically how to assert "no `PreToolUse` fired" from the events log as a negative test.
- **review gate:** `dev-team:plan-reviewer` (mandatory), **plus `dev-team:architect` for a second opinion** — §6 and §7.3 both reject a previously-accepted mechanism in favour of an alternative, and §7.3 deviates from a user-ratified decision. Those are exactly the cases where an independent design read is worth the round trip.

---

## Proposed memory deltas

**→ `/Users/x/Development/dev-team-claude-plugin/.claude/dev-team/memory/conventions.md`** (cross-cutting; any lead composing a `claude` argv needs these)

- **2026-08-01** — When composing a `claude` CLI invocation programmatically, always place a bare `--` immediately before the prompt positional. *Why:* `--tools`/`--allowedTools`/`--disallowedTools`/`--add-dir`/`--plugin-dir` are variadic and greedily consume the following positional; the prompt is then silently never submitted — `SessionStart` fires, `UserPromptSubmit` never does, no error, indefinite idle. Source: spike S7/S9 (4 reproductions, 1 fix confirmation).
- **2026-08-01** — Claude Code permission-rule syntax, normative for this repo: file-path rules are written `Edit(...)`/`Read(...)` **only** (`Write`/`NotebookEdit`/`MultiEdit`/`Glob` path rules are accepted but never consulted at ≥ v2.1.210, and `Edit` covers all file-editing tools); absolute paths use a **double** leading slash (`//abs/...`) — a single leading slash anchors at cwd/settings-source, not the filesystem root. *Why:* both errors fail silently as "permission denied" and cost a spike cycle to diagnose. Source: `code.claude.com/docs/en/permissions`, cross-checked against spike S9.
- **2026-08-01** — `--allowedTools` is an allow-*rule* list, not a capability list; use `--tools` to close the available tool set, and remember the built-in read-only Bash set (`ls cat echo grep git-read-only …`) executes in every mode including `dontAsk` regardless of rules. *Why:* omission from `--allowedTools` is not denial; a profile claiming a role "cannot run commands" is wrong unless Bash is absent from `--tools`. Source: docs + spike S10.
- **2026-08-01** — Permission-rule precedence is deny → ask → allow, and **a deny rule cannot carry allowlist exceptions**; to grant a narrow exception inside a broad category, use a differently-named entry point plus a PreToolUse hook, never `deny(broad)` + `allow(narrow)`. *Why:* the natural carve-out shape silently resolves to denied. Source: docs.
- **2026-08-01** — Writes to protected paths (`.claude`, `.git`, `.vscode`, `.idea`, `.husky`, `.devcontainer`, and a listed set of dotfiles) are denied in `dontAsk` and `permissions.allow` does not override them. Never site an agent-writable directory under `~/.claude/` or any repo `.claude/`. *Why:* this repo already writes to `.claude/dev-team/` and `~/.claude/dev-team/task-cost/`, so the trap is live. Source: docs.

**→ `/Users/x/Development/dev-team-claude-plugin/.claude/dev-team/memory/architecture-notes.md`**

- **2026-08-01** — **ADR-010 (proposed, spike-gated on S22e): containment for cmux worker panes is enforced in the worker plugin's `PreToolUse` hook; CLI permission flags are defense-in-depth and UX, not the guarantee.** Scope: cmux execution mode, all worker profiles. Supersedes: nothing; ADR-005 depends on it. *Why:* the platform documents Bash argument-pattern rules as fragile and names PreToolUse hooks as the stronger enforcement; hook exit-2 blocks before permission rules are evaluated; and Read/Edit rules don't reach subprocess writes at all. One mechanism resolves the path-scoping gap, the cmux-verb gap, and the D9 carve-out together. Status: **proposed, blocked on S22e** (plugin-dir PreToolUse/PostToolUse delivery is unverified).
- **2026-08-01** — **ADR-005 Amendment 1 (proposed): the S9 "scoped grant doesn't work" finding is a false negative** — the test used a `Write(...)` rule (never consulted at ≥ 2.1.210) with a single-slash "absolute" path (anchors at cwd). ADR-005's own `Edit(//task-dir/returns/**)` form has neither defect. Decision: re-test with corrected syntax (S22a) before adopting any fallback; adopt the `git status --porcelain` return check unconditionally as a post-condition rather than a fallback; add `--strict-mcp-config` + `mcp__*` deny to every profile; forbid task dirs under protected path names. Status: proposed.
- **2026-08-01** — **ADR-005 Amendment 2 (proposed, needs user ratification): mid-task upward signal is delivered by a write-triggered `PostToolUse` hook, not by a cmux verb allowlist.** Workers stay fully denied `Bash(cmux *)`; they write a validated JSON line to `<task-dir>/signals/`, and the static worker plugin's hook fires `cmux wait-for -S` (+ `cmux notify` for `blocked`/`question`). Supersedes: D9's `wait-for` carve-out **and** the architect-Q1 removal of it. *Why:* deny-beats-allow makes an enumerated carve-out fail-open, Bash arg patterns aren't a boundary, and the hook path works for roles with no Bash. **This is a deviation from the user's literal ask (an enumerated cmux allowlist) and must be ratified as such.** Status: proposed, deviation flagged.
- **2026-08-01** — **ADR-003 Amendment 1 (proposed): the attention channel is orthogonal to the completion ladder and is never completion evidence** — on an attention wake the parent re-derives completion solely from the ladder. Also: rank-2's EXIT sentinel is confirmed permanent (no process-exit event exists in cmux 0.64.20's catalogue). Status: proposed.
- **2026-08-01** — **ADR-009 Amendment 1 (proposed): byte-stability applies to prompt bytes, not to all per-dispatch files** — a `--settings` file containing only a `permissions` object is admissible; the worker plugin's `hooks/hooks.json` must remain static (env-driven path checks, no interpolated `if:` filters). Status: proposed.
- **2026-08-01** — Recommendation reversed vs. spike S16: role bodies use **`--append-system-prompt`**, not `--system-prompt` (replace). *Why:* S16's comparison is confounded (both arms ran under the `orchestration.md` injection), and a full replace discards Claude Code's built-in tool-use scaffolding for no isolation benefit — the bleed-through is hook-injected `additionalContext`, which survives a replace. Re-test after isolation lands (S23). Status: proposed.

---

**Files read for this package:** `tasks/cmux-mode/architecture-lead-context.md`, `tasks/cmux-mode/spike-findings.md`, `.claude/dev-team/memory/architecture-notes.md`, `.claude/dev-team/memory/conventions.md`, `.claude/dev-team/config.md`, `hooks/hooks.json`.
