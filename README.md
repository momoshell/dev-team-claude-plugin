# dev-team

A Claude Code plugin that turns one assistant into a small, disciplined engineering org: an **orchestrator** that talks to you and delegates planning to on-demand **domain leads**, hands execution to **execute-only coders**, and gates everything through a **3-tier review ladder** — bound together by a spec contract, single-writer memory, and a deterministic multi-agent workflow.

It's a star, not a chat room: leads never talk to each other. The orchestrator spawns each agent, collects its result, and is the single writer of team memory. Disabling the plugin reverts Claude to vanilla behavior.

---

## Install

```text
/plugin marketplace add momoshell/dev-team-claude-plugin
/plugin install dev-team@dev-team
```

Then enable it (persists in `enabledPlugins`):

```text
/plugin enable dev-team@dev-team
```

**Local development** (working from a checkout instead of GitHub):

```text
/plugin marketplace add /absolute/path/to/dev-team-plugin   # dir containing .claude-plugin/marketplace.json
/plugin install dev-team@dev-team
# or, no marketplace needed:  claude --plugin-dir /absolute/path/to/dev-team-plugin
```

> **Editing the plugin while it's installed?** A directory-marketplace install **copies** the plugin into a version-pinned cache (`~/.claude/plugins/cache/dev-team/dev-team/<version>/`). Editing the source does **not** propagate — `plugin update` no-ops while the version is unchanged. So while iterating, either:
> - prefer **`claude --plugin-dir /absolute/path/to/dev-team-plugin`** — loads the source live, no cache, no install; or
> - **bump `version`** in `.claude-plugin/plugin.json`, then `claude plugin marketplace update dev-team && claude plugin update dev-team@dev-team` (restart to apply).

Once enabled, a `SessionStart` hook loads the orchestration rules each session. New components (agents/commands) load on a fresh session or `/reload-plugins` — installing mid-session won't hot-load them. No further setup.

---

## How it works

Two ways to run the team:

| Mode | When | Entry |
|------|------|-------|
| **Conversational** (semi-auto) | Day-to-day work; the orchestrator proposes the team for non-trivial requests | just talk, or `/dev-team:team` |
| **Workflow** (deterministic) | Large or repeatable batches you want fanned out and gated automatically | `/dev-team:team workflow <goal>` |

**Cost model.** Every subagent is its own context window with its own cost, so spend is driven by *how many* windows a task opens. The team economizes on **count** — Tier-1 runs direct (no window), deterministic validation runs inline on a scoped *fast* lane (the full/slow suite runs once at `/dev-team:ship`, never per coder), the low-risk QA gate is a single sonnet reviewer, and the standard reviewer runs at medium effort. It deliberately does **not** economize on the windows that prevent expensive failures: planning leads, the architecture lead, deep review, and the adversarial panel stay on opus. Cheap where it's safe, strong where it compounds.

### Activation tiers (conversational)

- **Tier 1 — trivial** (one file, obvious fix): the orchestrator edits directly and validates inline. No spec, no coder, no gate — no window spent on a one-liner.
- **Tier 2 — single domain** (multi-file): the orchestrator proposes one line — *"This looks like Tier 2 (…). Engage the team, or handle directly?"* — then runs `lead → coder → QA gate`.
- **Tier 3 — cross-domain / new architecture / phased**: `architecture-lead` drafts the smallest useful architecture package (PRD-lite/TRD/ADR only as needed) + execution plan → independent plan review → your approval → phased execution.

It never silently takes over; it proposes and waits.

---

## The team

14 agents, each scoped to one job:

| Group | Agents | Role |
|-------|--------|------|
| **Leads** (plan, read-only) | `architecture-lead`, `backend-lead`, `frontend-lead`, `devops-lead`, `qa-lead` | Read memory, scope context, emit **Handover Specs**, propose memory deltas. Never edit code; never fetch authenticated/private content (issues, private repos) — the orchestrator resolves it and passes it in. |
| **Executor** | `coder` | Implements one Handover Spec exactly, within scope. Never plans or explores. |
| **QA gate** | `code-reviewer`, `code-reviewer-deep`, `build-validator`, `test-engineer` | Review (standard/deep), independent type-check + build, test authoring. |
| **Architecture** | `architect`, `plan-reviewer`, `trd-reviewer`, `doc-writer` | Second-opinion design, independent plan/TRD review, ADR/README authoring. |

Agents are referenced as `dev-team:<name>` (e.g. `dev-team:backend-lead`).

---

## Commands

```text
/dev-team:team                  Engage the team for the current request now
/dev-team:team <request>        Engage for a specific request
/dev-team:team off              Stay direct this session (don't propose the team)
/dev-team:team auto             Run qualifying work through the team without asking
/dev-team:team status           Show activation mode + available leads
/dev-team:team workflow <goal>  Run the deterministic pipeline (below)
/dev-team:pr-review <n|url>     Work a PR like a teammate (below)
```

### PR review

`/dev-team:pr-review <number|url>` detects whose PR it is and picks the mode:

- **Someone else's PR → review mode.** The diff is risk-classified through the same review ladder the QA gate uses (standard reviewer → deep on triggers → adversarial panel on stacked risk), findings are verified against the head-ref code before anything is drafted, and the result is **one** review — a short summary plus inline comments in a polite, inquisitive register ("What do you think about…", "Is it correct that…"), each with a precise explanation, a concise fix, and a `[blocking]`/`[question]`/`[nit]` tag.
- **Your own PR → respond mode.** Unresolved review threads are triaged on evidence (valid / invalid / unclear), valid findings are fixed as one commit per logical fix, and the drafted replies cite the fix hashes (`Fixed in abc1234 — …`); pushback on invalid comments comes with `file:line` evidence, politely.

Either way, **nothing is posted until you've seen the exact drafted text and said yes** — comments go out under your name. Pass an explicit `review`/`respond` after the PR ref to override the auto-detected mode.

**One-keypress launch from gh-dash** (macOS, [Ghostty](https://ghostty.org) + [worktrunk](https://github.com/max-sixty/worktrunk)): `scripts/pr-review-window.sh` opens the PR in a fresh Ghostty window (its own instance — never a tab in your existing window), checks it out into its own worktree via `wt switch pr:N`, and runs `claude "/dev-team:pr-review <pr-url>"` there. When the session ends or the window closes, the worktree is removed — never with `--force`, so a worktree holding uncommitted changes is kept and reported instead of destroyed (merged branches are cleaned up by worktrunk; unmerged ones stay as local branches). Wire it to a key in `~/.config/gh-dash/config.yml`:

```yaml
keybindings:
  prs:
    - key: V
      name: claude pr-review
      command: >-
        <path-to-plugin>/scripts/pr-review-window.sh
        open "{{.RepoPath}}" "{{.RepoName}}" {{.PrNumber}}
```

The repo must have a `repoPaths` mapping in the same config (that's where `{{.RepoPath}}` comes from) and a local checkout — the script errors clearly when either is missing.

You don't have to wire this by hand: when `/dev-team:onboard` detects gh-dash + worktrunk + Ghostty on the machine, it offers to add the keybinding and the `repoPaths` mapping itself. It copies the launcher to `~/.claude/dev-team/bin/` first (the installed plugin's path changes on every version bump, so the keybinding never points into the plugin cache) and re-copies on each onboard refresh so the stable copy tracks plugin updates.

---

## Task sources

`/dev-team:onboard` wires the project to a task source, `/dev-team:next` picks from it, and `/dev-team:ship` closes the loop. Supported: **GitHub issues**, a **GitHub Projects board**, an **in-repo backlog file** (`TASKS.md` / `BACKLOG.md`), or a **Trello board**.

### Trello

Credentials are set up once per machine. Get an API key at <https://trello.com/power-ups/admin> (create a Power-Up), then:

```text
security add-generic-password -s trello-api -a key -w '<api key>'
scripts/trello.sh auth-url        # open the printed URL, click Allow, copy the token
security add-generic-password -s trello-api -a token -w '<token>'
```

Non-macOS: `TRELLO_KEY` / `TRELLO_TOKEN` env vars, or `KEY=` / `TOKEN=` lines in `~/.config/trello/credentials` (`chmod 600`).

Then run `/dev-team:onboard https://trello.com/b/<shortlink>/<name>` — it validates the credentials, maps the board's lists (ready / doing / done) in a single confirmation, and stores **list IDs, never credential values**, in `.claude/dev-team/config.md`. Day to day, `/dev-team:next` takes the **top card of the ready list** (drag cards to reprioritize) and folds its description, checklists, and comments into the team's shared digest; `/dev-team:ship` comments the PR URL on the card and moves it to the done list.

All board access goes through `scripts/trello.sh`, which resolves credentials internally (env → macOS Keychain → credentials file) so tokens never appear in the session transcript. Onboarding offers to allowlist the script path so daily runs don't hit permission prompts.

---

## Workflow mode

`/dev-team:team workflow <goal>` runs the bundled `team-build.workflow.mjs` via the Workflow tool. Per task it does **lead → coder (or `test-engineer` for `qa`) → gate**, where the gate runs the right reviewer tier **and** `build-validator` in parallel.

**Args** passed to the workflow:

```jsonc
{
  "goal": "string",
  "projectMemory": "<absolute path to project memory dir>",   // optional
  "tasks": [
    { "id": "be-01", "domain": "backend",  "brief": "add /orders endpoint", "files": ["src/api/orders.ts"] },
    { "id": "fe-01", "domain": "frontend", "brief": "orders list UI", "depends_on": ["be-01"] }
  ]
}
```

- **Plan-domains:** `frontend` · `backend` · `devops` · `qa`. Anything else (e.g. `mobile`, or `architecture` which is interactive Tier-3) is **rejected, not laundered** — returned in `rejectedTasks`.
- **`depends_on`** (task ids) drives **dependency-wave** scheduling: independent tasks run concurrently within a wave; a dependent waits for its prerequisites and is **skipped if any prerequisite fails its gate**. Cycles and unknown deps are skipped with a reason.
- **Risk-keyed review:** auth / migration / secrets / infra / public-API / etc. (and the whole `devops` domain) escalate to `code-reviewer-deep`; stacked risk gets a 3-reviewer adversarial panel; everything else gets `code-reviewer`.
- **Self-healing:** one amend-retry per task on a coder `insufficient` return (conversational mode allows up to two).

---

## The Handover Spec (the contract)

Every task is one spec — the only thing a lead emits and a coder consumes. 11 fields:

`task_id` · `domain` · `goal` · `files_in_scope` · `constraints` · `acceptance_criteria` · `validation_commands` · `discovery_context` · `out_of_scope` · `depends_on` · `interface_contract`

The lead's `discovery_context` must be complete enough that the coder never explores outside `files_in_scope`. The coder returns a structured result:

```text
status: done | insufficient | blocked
reason: <one line>
missing_context: <required when insufficient>
changes: <required when done — each file + one-line summary>
validation: <required when done — commands run + pass/fail>
```

Canonical definitions live in [`handover-spec.md`](./handover-spec.md); machine schemas in [`handover-spec.schema.json`](./handover-spec.schema.json) and [`coder-return.schema.json`](./coder-return.schema.json).

---

## Review ladder

Owned by `qa-lead`, applied at every gate:

1. **Standard** — `code-reviewer` (risk 0–1).
2. **Deep** — `code-reviewer-deep` (any deep trigger, or risk ≥ 2).
3. **Adversarial panel** — 3 reviewers, distinct lenses (correctness / security / rollback), majority pass — on stacked risk (≥ 3, or multiple deep triggers). Workflow mode applies this panel automatically for stacked risk.

The ladder sets review *depth*; the **bundle size** scales with risk too. Low-risk (0–1) is a single reviewer with validation folded in inline — `test-engineer` joins only when the change adds/alters behavior that isn't already covered (or the spec demands tests). Deep-trigger / stacked risk adds `test-engineer` for negative + security coverage.

**Deep triggers:** auth/authz, secrets, encryption, tokens, passwords, payments, PII; DB migrations / destructive ops; CI/CD, infra, prod; public API/contract changes; security fix / incident / hotfix. Plausible auth bypass, cross-tenant access, privilege escalation, reachable injection/RCE, prod secret exposure, destructive data loss, payment/PII leakage, or unsafe migration rollback blocks shipping.

---

## Memory (two tiers, single writer)

The orchestrator is the **sole writer**; leads only *propose* deltas.

- **Project memory** (most of it): `<project-root>/.claude/dev-team/memory/` — `conventions.md`, `{frontend,backend,devops,qa}-notes.md`, `architecture-notes.md`.
- **Global memory** (sparse, cross-project): `~/.claude/dev-team/memory/conventions.md` — durable preferences that hold across all your projects.
- **Precedence: code > project memory > global memory.** Memory is a cache; contradicted entries are marked `deprecated`, never deleted.

---

## Following progress

This plugin uses standard Claude Code surfaces — no custom UI:

- **Workflow mode:** `/workflows` — live tree of phases (Plan → Build → Gate) → per-agent labels (`plan:backend-be-01`, `gate:…`) → drill in for prompt/tools/result. Narrator lines report each wave's result.
- **Conversational mode:** the **subagent panel** below the prompt (and `/agents`) shows each active lead/coder; the orchestrator narrates one-liners (`→ backend-lead: planning be-01`, `✓ …`).
- **Optional:** set `subagentStatusLine` in your `settings.json` for a richer per-agent row (`▸ backend-lead · plan:be-01 · 1m · 12k tok`).

---

## Repository layout

```text
.claude-plugin/
  plugin.json            plugin manifest
  marketplace.json       local marketplace manifest
agents/                  the 14 agent definitions
commands/                /dev-team:team, :onboard, :next, :ship, :pr-review
scripts/trello.sh        Trello task-source helper (credential resolution + board I/O)
scripts/spec-lint.mjs    mechanical Handover Spec lint (paths, file:line refs, runnable commands)
scripts/task-cost.mjs    per-task cost readout for a custom statusLine (see § Per-task cost)
scripts/pr-review-window.sh  gh-dash keybinding target: Ghostty window + worktrunk PR worktree + /dev-team:pr-review (see § PR review)
hooks/hooks.json         SessionStart → injects orchestration.md into context; marks /clear boundaries for task-cost.mjs
orchestration.md         the orchestrator's operating rules (loaded each session)
handover-spec.md         canonical spec template + conventions
handover-spec.schema.json
coder-return.schema.json
team-build.workflow.mjs  the deterministic workflow
test/                    regression suite (node --test); CI in .github/workflows
```

---

## Tests

```text
node --test        # or: npm test
```

Dependency-free (`node:test`), no live model. Covers the workflow's wave scheduling, dependency/cycle handling, domain rejection, qa→test-engineer routing, `args`-as-string tolerance, review-tier escalation, build-validator (advisory only on a dead/no-verdict run; a reported failure blocks), a **schema lint** (no conditional JSON-Schema keywords in tool-facing schemas), agent-frontmatter validity, the **spec lint** (path/glob/file:line/command checks against a fixture project), the **task-cost** calculator (since-marker filtering, sidechain exclusion, cache-tier pricing, intro-rate expiry), and the Trello helper's offline behavior (credential-miss paths, arity checks, no token leakage). Runs on every push via GitHub Actions. `test/` and `package.json` are dev-only — not part of the plugin runtime.

---

## Cost model

The team's economics rest on two facts about how context is billed:

1. **Subagent windows are cheap because they die.** Leads, coders, and reviewers each get a fresh context that is discarded on return. Their cost is bounded by the work they do.
2. **The main window is expensive because it doesn't.** Every turn re-reads the entire transcript, so a session's cost grows with the *square* of its length. Real-world data point: an 11-day, 5,000-turn session spent ~90% of its total cost on the main window re-reading itself — the entire 80-agent team accounted for the remainder.

The rules that follow (enforced by the commands and `orchestration.md`):

- **One task per window.** `/dev-team:next` → work → `/dev-team:ship` → `/clear`. Disk memory + `config.md` + the task source carry everything between windows; the transcript carries nothing worth its re-read cost.
- **The main model doesn't need to be opus.** The thinking is pinned in the agents' frontmatter (leads/deep review on opus) regardless of the session model — a sonnet main loop routes the same opus brains at a fraction of the token weight.
- **Engage the team deliberately.** Tier-1 trivia goes direct; batches go through workflow mode (fresh bounded windows per task), not one long conversational session.
- **Cut window count, not depth** — savings come from fewer/cheaper windows on low-risk work, never from lowering effort/model on architecture, leads, or deep review (see `orchestration.md` § Scaling & effort).

### Per-task cost

Claude Code's own `$` figure (the bottom status bar, and `cost.total_cost_usd` in a statusLine script) is scoped to the whole terminal session — it does **not** reset on `/clear`, only on relaunch. That's correct behavior (it's tracking cumulative spend for the process, not per-task liability), but it means you can't read "cost of this task" off it directly.

This plugin ships the pieces for a **real** per-task readout, computed from actual token usage since your last `/clear` (not since session start):

1. A bundled `SessionStart(matcher: "clear")` hook writes a timestamp marker to `~/.claude/dev-team/task-cost/<session-id>.json` every time you run `/clear` — no setup needed, it's active whenever the plugin is enabled.
2. `scripts/task-cost.mjs` reads a statusLine JSON payload on stdin, sums the main transcript's token usage since that marker (same scope as the built-in `$` figure — subagent windows aren't included, since they're separately billed and already excluded from the built-in total), prices it against a small hardcoded table, and prints a bare `$X.XX`.

This isn't auto-installed as your statusLine — add it to your own `statusLine` command in `settings.json`. Minimal example:

```json
{
  "statusLine": {
    "type": "command",
    "command": "jq -r '\"[\\(.model.display_name)] \\(.workspace.current_dir)\"' ; node ~/.claude/plugins/cache/dev-team/dev-team/<version>/scripts/task-cost.mjs"
  }
}
```

If you already have a custom statusLine script, just call `node <plugin-root>/scripts/task-cost.mjs` with the same stdin JSON your script receives and splice the result into your existing line — the script only ever writes a bare `$X.XX` (or nothing, on any error) to stdout, so it's safe to embed.

The pricing table is a maintenance point — see `scripts/task-cost.mjs`'s `PRICING` object when new models ship or an introductory rate expires.

---

## Requirements

- **Claude Code** with plugin support.
- **Node.js** — used by the Workflow tool to run `team-build.workflow.mjs` (workflow mode only), and by `scripts/spec-lint.mjs`.
- **jq** — required by the bundled `SessionStart` hook that injects `orchestration.md` into context (degrades gracefully with a stderr warning if missing), and by `scripts/trello.sh` (Trello task source only).
- **curl** — used by `scripts/trello.sh` (Trello task source only).

---

## Contributing — invariants

**Keep agent system prompts static (prompt-cache invariant).** Every agent runs in its own context window, so the base prompt + the agent's `.md` is a prefix that prompt-caching reuses across the many spawns — *only while it stays byte-stable*. Never interpolate per-task content (paths, the Handover Spec, the memory dir, a discovery digest, the goal) **into an agent `.md` system prompt**. All variable content goes in the **spawn prompt** (the `agent()`/Task `prompt` = the user turn) — that's how `team-build.workflow.mjs` already does it (`planPrompt`/`buildPrompt`/`gatePrompt`). Baking task content into a system prompt silently busts the cache on *every* spawn, which is the dominant per-window cost. The `${`-free `agents/` tree is checked by reading; keep it that way.
