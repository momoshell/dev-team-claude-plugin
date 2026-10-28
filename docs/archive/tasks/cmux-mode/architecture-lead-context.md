# Context for architecture-lead: reconcile Phase-0 spike findings against the cmux-mode TRD

Read `tasks/cmux-mode/spike-findings.md` in full first (it has every S1-S21 finding with command/output evidence). This file gives you the relevant TRD/ADR text those findings bear on, plus the user's ratification decisions from the exit-gate conversation, so you don't need to re-fetch the epic's GitHub comments (you have no `gh`/authenticated-fetch access; this digest was resolved and pasted by the orchestrator).

## Your task

Produce an amendment package: which ADRs need revision, what the corrected `dispatch.mjs`/adapter design should say, and what — if anything — still needs a new spike item before Phase 1c can start. This is architecture work only: no code, no execution. Output a markdown package (ADR amendments + updated composed-argv spec + open items), the same shape you'd produce for any Tier-3 architecture package.

## Current accepted TRD text (v2, from epic #15's design record) that your amendments apply against

### ADR set (all "accepted", several explicitly spike-gated)

- **ADR-003** — Completion is a four-rank ladder (file-watch → `notification.requested` events → adapter `EXIT`-trap → bounded Stop-hook gate). *Rationale given for dropping worker self-signal:* "hooks run outside the tool-permission system" (so the gate can call cmux regardless of the worker's own tool rules) and self-signal is "redundant, prompt-dependent, conflicts with deny-beats-allow."
- **ADR-005** (*accepted, explicitly gated on S9/S10 passing*) — "Security posture: default socket mode, orchestrator-inside-cmux, allowlist-shaped worker profiles, scoped return grant." Worker profiles are allowlist-shaped under `dontAsk` ("deny beats allow; only non-prompting mode that can't stall"). **The one write grant given to a read-only role is `Edit(//<task-dir>/returns/**)`.** Workers denied `Bash(cmux *)` entirely; no Task tool.
- **ADR-009** — Pane system prefixes must be byte-stable per role (static role file + static addendum; all per-dispatch variance travels via env vars + the kickoff message, never the system prompt) — this is why a per-dispatch-generated `--settings` blob was rejected in favor of a static worker plugin loaded via `--plugin-dir`.

### §5.3 Composed argv, executor profile (the literal text under amendment)

```
claude --model sonnet --effort medium --permission-mode dontAsk \
       --append-system-prompt-file <role body + static profile addendum, frontmatter stripped> \
       --tools Read,Edit,Write,Glob,Grep,Bash \
       --allowedTools "Edit(//abs/worktree/**)" "Edit(//abs/task-dir/returns/**)" \
                      "Bash(npm run typecheck *)" "Bash(npm test *)" \
       --disallowedTools "Bash(cmux *)" \
       --disable-slash-commands \
       --plugin-dir <plugin-root>/scripts/cmux/worker-plugin \
       --add-dir //abs/task-dir \
       "<kickoff>"
```

Roster profile shapes (`planner`/`executor`/`reviewer`) all follow the same pattern: a `tools` allowlist, an `allow` array of path/command-pattern-scoped rules (e.g. `Edit(${RETURNS_GLOB})`, `${SPEC_VALIDATION_COMMANDS}` which expands to `Bash(<cmd> *)` rules), and a `deny` array (`Bash(cmux *)` universally).

### §5.6 Worker neutralization (D10)

Adapter exports `DEVTEAM_WORKER=1` before exec; `hooks/hooks.json`'s `SessionStart` hook gets a leading guard (`[ -n "${DEVTEAM_WORKER:-}" ] && exit 0` shape) that also emits a one-line `systemMessage` so the suppression is diagnosable. This guard **does not exist yet** in this repo's actual `hooks/hooks.json` — it's tracked separately as issue #5, not something this spike could test directly.

## What this session's spike (issue #1) found that bears directly on the above

Full detail + exact commands/output in `tasks/cmux-mode/spike-findings.md`. Summary of what's load-bearing for your amendment:

1. **`--append-system-prompt-file` does not exist** on the installed `claude` (2.1.220). Only inline-string `--system-prompt`/`--append-system-prompt`. §5.3's composed argv literally cannot execute as written — every dispatch would fail at the CLI parser. **Must be rewritten** to read the role-body+addendum file into memory and pass it inline: `--system-prompt "$(cat <tmp-file>)"` (S8 found `--system-prompt`, i.e. *replace*, is closer to isolated than *append* — see item 5 below).

2. **A silent-stall bug in argv composition, confirmed and root-caused.** `--tools`/`--allowedTools`/`--disallowedTools` are variadic CLI options; placed before a bare positional prompt, they greedily consume it — the prompt is silently never submitted (`SessionStart` fires, `UserPromptSubmit` never does — no error, no dialog, indefinite idle). **Fix confirmed by direct test:** insert a bare `--` immediately before the kickoff string. §5.3's composed argv as written (kickoff as the last positional, several variadic flags before it, no `--`) **will hit this bug on every single dispatch.** This is the highest-priority literal fix.

3. **ADR-005's core mechanism does not work as specified — this is the ADR's own explicit S9/S10 gate failing.** Tested `--allowedTools "Write(<path-glob>/**)"` (both relative and absolute-path patterns, exact match) under `dontAsk`: **Write was denied every time**, even for the pattern's own matching path. Isolated further: a **bare** `--allowedTools "Write"` (no path pattern) *does* grant Write — but unscoped, anywhere. **Conclusion: the parenthetical path-glob qualifier is not honored for Write via `--allowedTools` on this CLI version.** ADR-005's `Edit(//<task-dir>/returns/**)` grant was tested as `Write(...)`, not literally `Edit(...)` — worth a quick confirm that `Edit`'s pattern support isn't different, but there's no reason to expect it behaves differently (same permission-rule engine). **This is the load-bearing security mechanism ADR-005 depends on, and it does not work.** Candidate resolutions, in the same order the original design's own failure ladder proposed: (a) test whether the same path pattern works via a `--settings` JSON permissions block instead of the CLI flag (untested this session — genuinely worth trying before giving up on scoping); (b) fall back to the documented alternative already on record: unscoped `Write` grant + a `git status --porcelain` check over the primary checkout before accepting any judgment-role return, refusing it if anything outside `returns/` changed.

4. **`--allowedTools` is not a closed allowlist — omission ≠ denial.** In the same test, `Bash` — not mentioned anywhere in `--allowedTools` — ran anyway, unprompted, undenied. Only an **explicit** `--disallowedTools` entry reliably blocks a tool: tested `--disallowedTools "Bash"` (bare tool name) and confirmed the model never even attempts the call (no `PreToolUse` event fires for it at all — it's simply not offered as an available tool), turn proceeds normally, no stall, no silent execution. **Critical caveat, not yet tested: this session only validated a *bare* tool-name deny (`Bash`), never the *command-pattern-scoped* deny the design actually needs (`Bash(cmux *)`).** Given finding 3 above (path-pattern-scoped *allow* rules for Write don't work), there's a real risk the same non-enforcement affects pattern-scoped *deny* rules for Bash — which would mean ADR-005's central containment guarantee ("workers denied `Bash(cmux *)`") may not actually hold. **This needs a dedicated test before Phase 1c, independent of anything else in this package** — call it S22: does `--disallowedTools "Bash(cmux *)"` actually block only cmux-prefixed Bash calls while leaving other Bash commands available, or does it fail open (denies nothing) or fail closed (denies all Bash)?

5. **Append vs. replace: neither isolates a role body from ambient plugin context on its own.** `--system-prompt` (replace) changed response *tone/persona* but the underlying session identity (this repo's own dev-team orchestration context, injected via this repo's `SessionStart` hook) still leaked through. `--append-system-prompt` fared worse — an appended behavioral instruction was effectively ignored under the competing context. **Conclusion: the D10/§5.6 `DEVTEAM_WORKER=1` SessionStart guard is a hard dependency for role-body isolation, not a nice-to-have** — neither system-prompt flag substitutes for it, and it doesn't exist in this repo yet (issue #5). Recommend `--system-prompt` (replace) as the base for role bodies regardless, since it's the closer of the two, but Phase 1c cannot assume clean role isolation until issue #5 lands.

6. **`--plugin-dir` hook delivery — confirmed working, no escalation needed.** Directly tested: a minimal test plugin loaded via `--plugin-dir` had its `SessionStart`/`Stop`/`UserPromptSubmit` hooks fire correctly in a dispatched pane (systemMessage rendered on-screen, log files written). ADR-009's static-worker-plugin-via-`--plugin-dir` mechanism is sound as designed.

7. **`new-surface --provider claude` is confirmed a dead end** (creates a non-terminal `agentSession` surface kind; `read-screen`/`send`/`send-key` all reject it with "not a terminal"; the verb has no `--model`/system-prompt/permission-flag passthrough at all). This validates — does not contradict — the terminal-surface + adapter-wrapper approach already the default in §5.3/5.5.

8. **No per-surface "process exited" event exists** in this cmux version's event catalog (checked the full catalog, not just this project's own experience) — ADR-003's rank-2 EXIT-trap-plus-sentinel-file approach remains necessary, not an optional nicety event improvements could retire.

9. **Cost probe (crude, single-trial):** the same tiny fixed spec cost ~2.1× the tokens and ~3.2× the wall-clock of an equivalent Agent-tool subagent dispatch — right at the edge of the "≤2× subagent cost" ceiling on the cheapest possible probe, before any real role prompt/plugin/tool-list overhead is added. Not a verdict — flagging as a real risk signal for the Phase-2 GO/NO-GO cost measurement (S15b in the original numbering), which still needs to happen with the real dispatcher.

## User-ratified decisions from the exit-gate conversation (this session, today)

1. **Archive scope — broadened beyond the original "any dispatch ended non-zero" (R8) framing.** User's ruling: archive the task dir on **any** failure at any level (dispatch, task, or otherwise), not just a dispatch's own non-zero exit code. Overrides `keep_task_artifacts: false`.
2. **Output-contract tightening (D17/ADR-related) — ratified as-is**, no change.
3. **A genuine amendment to ADR-005/D9 — this is the part needing real design work from you.** Original locked decision D9 (2026-07-31) actually specified a narrow carve-out: *"Executor profile denies `Bash(cmux *)` EXCEPT the single signal command `cmux wait-for -S <task_id>`."* The later architect Q1 review (during plan-review) recommended dropping that carve-out entirely — reasoning: self-signal is redundant given the four-rank completion ladder, is prompt-dependent (unreliable), and conflicts with deny-beats-allow. ADR-003/ADR-005's *accepted* text reflects that removal ("Workers denied `Bash(cmux *)`... entirely"). The plan-reviewer separately flagged this exact removal as an **unflagged, unratified silent deviation** from the locked D9 ("better design but the user should ratify" — never actually ratified until now).
   - **Today, the user ratified the *opposite* direction of that removal**, but for a different specific need than D9's original completion-signal carve-out (which the four-rank ladder already covers reliably without any worker cooperation, via the adapter's `EXIT`-trap — no design gap there). The user's ask is about **mid-task escalation**: a stuck worker (or a lead) being able to actively notify upward — worker→lead, lead→orchestrator, or worker→orchestrator directly — rather than only being discovered via the orchestrator's own polling/event-watch noticing a written file at full-turn-boundary (today's only path: end the turn early with `status:"insufficient"` in the return file, which the orchestrator picks up and relays to the lead itself — the star topology already in place elsewhere in this plugin, no direct worker↔lead channel exists anywhere in the design).
   - **User's explicit framing:** *"workers and leads shouldn't skip on those files, but should be able to signal to upper levels using cmux."* — i.e. the file-based return/insufficient-status contract stays the source of truth and primary mechanism, unchanged; this is **additive**, a narrow live nudge, not a replacement.
   - **What you need to design:** a scoped cmux command allowlist for this signal (plausibly `notify` and/or `wait-for -S <some-token>` only — explicitly excluding every topology-driving verb: `close-surface`, `move-surface`, `new-pane`, `new-surface`, etc. — preserving D9's original containment goal, "workers must not drive topology," even while granting the upward signal). Needs to reconcile with finding 4/S22 above: if `Bash(cmux notify *)`-style pattern-scoped rules turn out not to be reliably enforced (same failure class as the Write-pattern-scoping bug), a different enforcement mechanism (e.g. a dedicated narrow tool, or routing the signal through the worker plugin's hook layer — which runs outside the tool-permission system and is exactly why the gate itself can already call cmux regardless of worker tool rules) may be needed instead of trying to carve a hole in `--allowedTools`/`--disallowedTools`.
4. **Tier-1 pane placement — ratified as-is**, no change.
5. **`cmux hooks setup` never run automatically for Claude — ratified, confirmed by evidence** (native hook emission + no-consumer event replay both directly tested and working; Claude needs no onboard consent step, unlike future non-Claude adapters).
6. **The spike session itself — ratified.** One item (S20, restart durability) explicitly deferred with the user's sign-off — it needs a coordinated cmux quit/relaunch that would've killed the orchestrator session running it, so it's carried forward as an open follow-up, not a blocker.

## What we need back from you

1. Rewritten §5.3 composed-argv block (fixing findings 1 and 2 — the missing flag and the missing `--`).
2. A resolved position on ADR-005's scoped-grant mechanism (finding 3) — pick a path (test `--settings`-based scoping first, or adopt the unscoped-Write+`git status --porcelain` fallback now) and say which, with reasoning.
3. A concrete mechanism proposal for decision 3's amendment (mid-task upward signal) — scoped command list, which layer enforces it (tool-permission rule vs. hook-layer), and how it avoids the topology-driving risk D9 was originally written to prevent.
4. Definition of the new S22 spike item (does `Bash(cmux <verb> *)` pattern-scoped `--disallowedTools`/`--allowedTools` actually enforce correctly) — gating Phase 1c, alongside anything else you think still needs verifying before contracts (slice 1a) can freeze.
5. Anything in the existing ADR set you think needs its own amendment note given the above, even if not explicitly asked.

This becomes an amendment to the epic's design record (comments on epic #15) once you're done — the orchestrator will post it there and route it through `plan-reviewer` before Phase 1 starts, per the normal Tier-3 flow. Don't post anything yourself; you have no write/authenticated-fetch access — just produce the package.
