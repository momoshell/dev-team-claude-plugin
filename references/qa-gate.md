# QA gate (read when a coder returns and you run the gate)

Spec-anchored: reviewers get the spec's `acceptance_criteria` + the diff and verify the contract. Each phase ends with this quality pass before the next.

## Deterministic validation runs inline, not as a window

The coder already ran the spec's `validation_commands` and reported `validation:` — you (the orchestrator) re-run them directly via Bash to confirm independently. Type-check, lint, build, and test execution are deterministic, so an orchestrator Bash call is cheaper than a subagent and just as independent of the coder's self-report. **These are the scoped `fast` lane, never the full suite** — the spec's `validation_commands` are scoped to `files_in_scope` (drawn from `config.validate.fast`), so both the coder's self-check and this inline re-verify stay in the seconds range even when the project's full suite runs for tens of minutes. **The full `config.validate.full` suite runs exactly once — at `/dev-team:ship`, not in this flow** — so a slow suite isn't paid per coder or twice per task; iteration gets fast/scoped signal + reviewers, and ship is the authoritative full-suite backstop before the PR.

**Don't spawn `dev-team:build-validator` for routine validation** — reserve it for validation that needs an isolated environment, or workflow mode (where the script can't run Bash itself, so it dispatches build-validator instead). There, "advisory" means *only when it returns no verdict* (a dead run doesn't block, since the coder already ran `validation_commands` and the reviewer checked the criteria) — a build-validator that *does* return and reports failure blocks the gate like any other check.

## Scope compliance is verified by git, not the coder's self-report

After a coder returns, diff the actually-touched files against the spec: `git status --porcelain` (or `git diff --name-only` since the pre-dispatch state; in the coder's worktree if isolated). Any touched file outside `files_in_scope` → treat as `changes-needed` and bounce to the coder to revert the out-of-scope edits (or, if the extra file was genuinely required, route back to the lead to amend the spec) — don't wait for a reviewer to maybe notice.

## Size the gate to risk — don't spawn a window that won't change the verdict

The review *depth* follows the ladder below; the *bundle* (how many windows) scales with risk:

- **Risk 0–1, no deep trigger:** a **single** `dev-team:code-reviewer`. Validation is inline (above). **Spawn `dev-team:test-engineer` only when the change adds or alters behavior not already covered** (or the spec's `acceptance_criteria` demand tests) — skip it for refactors, config, and docs where existing tests hold.
- **Deep trigger / risk ≥ 2:** `dev-team:code-reviewer-deep` **+** `dev-team:test-engineer` (negative + security coverage), in parallel.
- **Stacked risk (≥ 3 / multiple deep triggers):** the adversarial panel (below) + `dev-team:test-engineer`.

**Model scales with risk:** standard `dev-team:code-reviewer` on **sonnet**, `dev-team:code-reviewer-deep` + the adversarial panel on **opus**, `dev-team:build-validator` on **haiku**. Reserve opus reviewer windows for genuine risk — the standard sonnet reviewer covers risk 0–1.

## Noise filtering — what the reviewer bundle and cmux diff leave out

**Filters apply to what an agent reads, never to what a check verifies.** Exactly two read points drop generated and vendored content so a reviewer spends its window on the change instead of the machine's exhaust: the diff you hand the reviewer bundle, and the cmux diff patch view below. The gate report is not a third filtered view — it only repeats the one-line excluded-paths header from whichever of those two it draws from; it doesn't filter anything itself.

**One shared definition, no script.** The shipped defaults are data: ${CLAUDE_PLUGIN_ROOT}/scripts/noise-globs.json, shaped {"globs": [...]} — lockfiles, vendored trees, minified/generated assets, build output. A project extends them (never replaces them) with noise_globs: in .claude/dev-team/config.md; empty or absent means the shipped defaults alone. No script parses that key — you read it and append it, the same way you read the rest of config.md.

**Compose them as git pathspec exclusions, piped through `xargs -0 -r` — never a bare `$EXCLUDES`.** An unquoted `$EXCLUDES` silently no-ops under zsh (this environment's shell: unquoted parameters don't word-split, so git receives one multi-line non-matching pathspec and applies zero exclusions — no error) and silently drops every glob containing `*` under `bash -O nullglob`. That is exactly the "never hide the omission" failure this section exists to prevent, except worse: the header would still claim exclusions happened. The `tr '\n' '\0' | xargs -0 -r` form below has no arrays and no process substitution, so it runs identically in bash, zsh and POSIX `sh` — don't reach for an array form instead (it would need an explicit `bash -c` wrapper and prose stating the snippet assumes bash). The `-r` matters: without it, GNU `xargs` (Linux) still runs `git diff` once on a completely empty glob stream — e.g. an unreadable `noise-globs.json` — producing a fully unfiltered diff while the header still claims exclusions happened; `-r` skips the command entirely on empty input instead, and is accepted by both GNU and BSD/macOS `xargs`. Run this from the repo root — pathspecs match relative to the current working directory, not the repo root, and the data file carries no `:(top)` magic to compensate.

Reviewer-bundle diff (state the range explicitly — the same revision the scope-compliance check above already diffs against — so staged/committed work in an isolated coder worktree is included too, not just the unstaged tree):

```
jq -r '.globs[] | ":!" + .' "$CLAUDE_PLUGIN_ROOT/scripts/noise-globs.json" | tr '\n' '\0' |
  xargs -0 -r git diff --name-only <pre-dispatch-sha-or-ref> -- .
```

Pathspecs go after the `.`; append each `config.md` `noise_globs:` entry the same way (see below) so it flows through the same pipeline, not a separately-quoted tail.

No jq on the box? Same tail, same mechanic — only the glob-producing command changes:

```
node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).globs.map(g=>":!"+g).join("\n")' "$CLAUDE_PLUGIN_ROOT/scripts/noise-globs.json" | tr '\n' '\0' |
  xargs -0 -r git diff --name-only <pre-dispatch-sha-or-ref> -- .
```

— this plugin ships zero dependencies and jq is not in the always-available read-only command set. (These are git pathspecs: `*` crosses `/`, so `*.min.*` catches nested files, while `node_modules/**` catches only a root-level `node_modules` — and a bare literal like `package-lock.json` is the same: root-level only, never a nested one. A monorepo adds its own patterns via `noise_globs:` for the nested cases the shipped ten can't reach.)

**A project's own `noise_globs:` entries join the same newline-separated list before it's piped through `tr` — filtered, not quoted.** `.claude/dev-team/config.md` is a tracked file that travels with a cloned repo, so treat its `noise_globs:` list as untrusted input, not pre-vetted config: before adding an entry to the list, drop (don't add) any entry that doesn't match the allow-list `[A-Za-z0-9._/*-]+` in full — a glob is built only from filename/path characters, a wildcard and a dash, so anything outside that set (spaces, quotes, `$`, backticks, `;`, `|`) is rejected outright rather than escaped.

**Suppression overrides everything.** A noise path the spec names in files_in_scope was intentional: before you run the command, drop from the exclusion list every glob that matches it — in every view, bundle and cmux diff alike (the gate report only repeats the header, above — it never filters on its own). A dependency-bump task's only meaningful diff IS the lockfile. Dropping a glob can un-filter more than the named path (naming a build-output file matching both a directory glob and an extension glob drops both); showing extra noise is the safe direction, hiding a named file is not.

**Never hide the omission.** Every filtered view opens with one line naming the excluded paths and their count, e.g. `excluded 2 noise path(s): package-lock.json, some-generated-file`, and the gate report repeats that line. The failure mode here is silent: a reviewer that passes a diff it never saw. That header is the only thing that makes the omission auditable.

**The scope-compliance check above stays unfiltered.** It exists to catch edits nobody asked for, so noise paths there are labelled, never dropped. A scope check that hides files is a scope check that lies.

## Review ladder (owned by `dev-team:qa-lead`)

- **Standard** `dev-team:code-reviewer` (risk 0–1) → **Deep** `dev-team:code-reviewer-deep` (any trigger / risk ≥ 2) → **Adversarial panel** on stacked risk (≥ 3 or multiple deep triggers): **3 reviewers** (odd, for a clean majority) with distinct lenses — correctness / security / rollback; pass = majority.
- **Deep triggers:** auth/authz, secrets, encryption, tokens, passwords, payments, PII; DB migrations / destructive ops; CI/CD, infra, prod access; public API/contract; security fix / incident / hotfix; **domain = devops** (workflow mode auto-escalates every devops task). Risk +1 each: multi-module, untested touched behavior, unclear rollback, complex control flow, cross-domain new feature.
- **Critical issue classes always block shipping when plausible:** auth bypass, cross-tenant data access, privilege escalation, remote code execution, injection with a reachable source→sink path, prod secret exposure, destructive data loss, unsafe migration rollback, or payment/PII leakage.

**Mechanical tier floor — size, not semantics.** The ladder above scores what a change *touches*. On top of it sits one mechanical floor that scores how *much* it changes, and it can only ever RAISE the tier: `depth = max(semantic_row, mechanical_floor_row)`. A diff of **more than 100 changed lines (insertions + deletions)** floors the reviewer at **Deep** (`dev-team:code-reviewer-deep`) even at semantic risk 0–1. Below 100 lines nothing is floored, and a semantic Deep or panel routing is never demoted by this rule.

**Measure it from the same filtered range § Noise filtering already defines, with `--shortstat` in place of `--name-only`** — same glob source, same pipeline, same `<pre-dispatch-sha-or-ref>`. Read insertions + deletions off its `N files changed, X insertions(+), Y deletions(-)` line. The file count that line also reports is *not* a floor input (see the rejected arm below).

**The floor's measurement is suppression-blind, deliberately.** § Noise filtering's suppression rule — a noise path the spec names in `files_in_scope` is un-filtered in every human-facing view — does **not** apply here. The floor always measures the noise-excluded range, whatever the spec names. So the reviewer's bundle and the floor legitimately see two different diffs: the bundle suppression-respecting, the floor suppression-blind. That divergence is the design, not a bug to tidy away later — a dependency-bump task naming a lockfile in `files_in_scope` must still *see* its 5,000-line diff, and must still not be escalated into an opus window by it.

**The floor moves the reviewer lane only.** It never adds `dev-team:test-engineer`; that member keeps its own trigger — new or altered behavior not already covered. Read *behavior* there as including **doc-prose behavior**: in this repo a large diff is often prose that itself carries tested behavior (required headings, config keys, doc-embedded shell snippets asserted by structural tests), so a big doc diff that changes such behavior does call for `test-engineer` — via that trigger, not via this floor. Read it as code-only and large doc diffs slip both lanes.

**Two options considered and rejected — don't re-add either by symmetry.** *A panel floor:* diff size is evidence of volume, never of *stacked* risk, and the panel spends three opus windows; only stacked semantic triggers buy those. *A `>50 changed files` arm:* nearly unreachable without also crossing 100 lines, except in pure rename/move refactors — exactly the change class where a deep opus read buys least, and where the unfiltered scope-compliance check above is already the control that matters.

## Reviewer verdicts — branch on the parsed enum, never on prose

Every verdict-carrying role (build-validator, code-reviewer, code-reviewer-deep — the roles the roster marks verdict_block: true) returns its verdict as a fenced json block under a ## Verdict heading: {"verdict": "pass | changes-needed | inconclusive", "findings": [{"severity": "critical | warning | suggestion", "file": "<path>", "line": 123, "summary": "<one line>"}]}. scripts/cmux/return-lint.mjs enforces presence/parse/enum on every cmux return: a missing, duplicated, unparseable or off-schema block is a rejected return, however good the prose is. Read the parsed block and branch on it — the prose is evidence for you, never the decision.

Agent-tool mode has no envelope and no lint. There, a subagent reviewer leads with 'VERDICT: pass | changes-needed' (its own definition requires it). Read that first line as the enum by literal token match — anything absent, hedged, or spelled otherwise is inconclusive and takes the re-run path below. That token is the only prose the gate ever reads.

Severity -> the three bands (table): critical -> Must-fix -> Blocks (bounce to the coder, or escalate per the ladder; one anywhere in findings[] is enough, whatever the top-level verdict says); warning -> Should-fix -> does not block, route into the task summary, fix now if cheap else carry forward; suggestion -> Consider -> informational, pass with notes, never spawn a window to re-litigate one. A verdict:pass carrying a critical finding is a contradiction, not a pass — severity wins and the gate blocks.

inconclusive is never a pass, and neither is a missing verdict. Treat identically: verdict:inconclusive; no ## Verdict section; zero/several/unparseable/off-schema fenced blocks; an agent-tool reviewer with no verdict token. Re-run the same reviewer scoped to the diff — same role, same acceptance criteria, no widened brief. Bounded at 2 re-runs (the bound orchestration.md already puts on amend->rebuild cycles); then stop and escalate to the user with the diff and every return so far. Never advance the phase on an inconclusive, never substitute your own reading of the review body for the verdict it failed to emit. One check before re-running in cmux mode: {"verdict":"inconclusive","findings":[]} is also exactly what the dispatcher writes for a blocked dispatch (return-lint.mjs writeBlockedReturn), whose body opens 'status: blocked - <reason>'. Fix the reason the dispatch died before spending an identical re-run on it.

Adversarial panel: the majority is counted, not judged. Pass = a strict majority of members whose verdict field is literally 'pass' — 3 reviewers -> 2. An inconclusive member (still inconclusive after its bounded re-runs) counts as a non-pass, never an abstention that shrinks the denominator. A critical finding from any single member blocks regardless of the count.

Reviewers report coverage-first — you are the filter. They surface every finding, including uncertain and low-severity ones, tagged with severity + confidence. Only critical blocks. Don't ask for a narrower report; filter it here.

## The human patch view (cmux diff)

When you want eyes on the actual patch at the gate, open it: cmux diff [<patch-file>|-] [--source unstaged|staged|branch|last-turn] [--workspace <id>] [--surface <id>]. It is orchestrator-invoked from the interactive session — a human-facing surface, not a worker capability — so it needs no CMUX_ALLOWS entry (that constant stays the frozen two-element allow list in scripts/cmux/contract.mjs; widening it is a permission change, not a convenience). It is a viewer, not a verdict: it never substitutes for a reviewer's parsed block. Apply the noise exclusions above when you open it — same shared list, same suppression rule, same one-line excluded-paths header.

## An optional gate adjunct: browser-verify evidence (issue #12/D5, ADR-019)

Beside `cmux diff` above — same shape, same reasoning: `node dispatch.mjs browser-verify --task <slug>` is orchestrator-invoked only, never a worker capability, so it needs no CMUX_ALLOWS entry either. Available whenever `cmux_preview_url` is configured and a preview singleton is live for the task; run it before the gate when you want console-error and screenshot captured evidence for a frontend slice.

**This is evidence, never a verdict input.** The gate still branches on the parsed `{verdict, findings}` enum alone — browser-verify's JSON is never fed into that decision, and a dirty console or `load_state_confirmed: false` never blocks the gate on its own; read it, then let the reviewer's parsed verdict decide.

Total wall-clock budget: <= 90 000 ms (<= 90s) for the whole verb. Every field it reports is origin-only (`scheme://host[:port]`, never a full URL with path or query) — the same discipline the preview singleton itself follows.

**Caveats before you read a screenshot as a rendering claim:** cmux 0.64.22 still prints its own `OK` line and writes a full-size PNG even on a surface that never became ready — a blank/white PNG is a REACHABLE outcome, not a bug, and `console_errors: {clean:true, count:0}` on a never-loaded page is equally reachable (a page that never navigated has nothing to log an error about). A screenshot captured and a clean console together prove only that the verb ran; they are never a stand-in for a human actually looking at the patch and deciding for themselves whether the change is good.

**Cross-read rule:** a gate-time `no_preview_recorded` from browser-verify should be read against the dispatch JSON's own `preview.reason` — the dispatch-time enum is closed at five members (`preview_lock_contended`, `preview_surface_ambiguous`, `preview_topology_unverifiable`, `preview_double_create_detected`, `preview_landed_in_worker_pane`); if dispatch never even attempted a preview for one of those reasons, browser-verify reporting `no_preview_recorded` is the expected, consistent downstream consequence, not a second, independent failure to chase.

**browser-verify's own gate-time enum is closed at three members**, distinct from the five dispatch-time members above: `preview_disabled` (`cmux_preview_url` is not configured — the feature is inert), `no_preview_recorded` (no sidecar exists, or it was malformed — cross-read against `preview.reason` per the rule above), `preview_surface_gone` (a sidecar exists but fails corroboration against a fresh tree: gone, wrong workspace, or not browser-typed).

**Credentials:** log the preview into dev/staging accounts only, never production or admin credentials — the same rule the preview singleton's own config-key documentation states.
