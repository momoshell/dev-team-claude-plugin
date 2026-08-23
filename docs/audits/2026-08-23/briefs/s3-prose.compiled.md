# Task: Vertical inspection of every text file that steers an agent: the skills under skills/, the commands under commands/, the seat charters under crew/roles/, the guidelines under crew/guidelines/, and the pi agent definition under crew/pi/agents/. The question is whether each sits on the rails the code and the plan actually lay down today. For every rule or claim that cites something checkable — a file path, a file:line, a CLI flag, a constant name, an enum member, a PR or issue number, a measured number — check it against main and mark it true, stale, or false. Find contradictions between documents (two skills that give different instructions for the same situation; a charter that promises a deliverable the driver no longer reads; a command whose description does not match what its skill does). Check each skill against the format rules ratified for the skills epic: description enumerates its triggers, routing table up front, critical rules as imperatives with reason and named exception, depth in references/, posture declared. Check each charter against crew/roster.json and crew/capabilities.json: does the charter claim a tool, seat, or capability the register does not grant, or fail to mention one it does. Report overlap: prose repeated in two places that would drift.
## The ask
Vertical inspection of every text file that steers an agent: the skills under skills/, the commands under commands/, the seat charters under crew/roles/, the guidelines under crew/guidelines/, and the pi agent definition under crew/pi/agents/. The question is whether each sits on the rails the code and the plan actually lay down today. For every rule or claim that cites something checkable — a file path, a file:line, a CLI flag, a constant name, an enum member, a PR or issue number, a measured number — check it against main and mark it true, stale, or false. Find contradictions between documents (two skills that give different instructions for the same situation; a charter that promises a deliverable the driver no longer reads; a command whose description does not match what its skill does). Check each skill against the format rules ratified for the skills epic: description enumerates its triggers, routing table up front, critical rules as imperatives with reason and named exception, depth in references/, posture declared. Check each charter against crew/roster.json and crew/capabilities.json: does the charter claim a tool, seat, or capability the register does not grant, or fail to mention one it does. Report overlap: prose repeated in two places that would drift.
## Proposed tier
PROPOSAL ONLY — compiled from mechanical signals. The orchestrator confirms
or overrides this at boot; the compiler never decides the tier.
proposed tier: judge
because:
- protected paths in force: 14 · ratified profile field protected_paths_candidates (3 entries) added to the authored floor · /Users/x/.dev-team/factory/profiles/momoshell__dev-team-claude-plugin.json
- scope breadth: 66 source files named by where (≥5 → judge)
- tripwire tests pinning that scope: 26
- protected path hit: crew/capabilities.json, crew/roster.json — tier judge unchanged (already highest)
proposed shape: judge
because (risk signals):
- risk signal · 2 protected path hits: crew/capabilities.json, crew/roster.json — shape judge
proposed strength: frontier
because (complexity signals):
- complexity signal · scope breadth: 66 source file(s) named by where
- complexity signal · tripwire tests pinning that scope: 26
- complexity signal · directory where: commands/, crew/guidelines/, crew/pi/agents/, crew/roles/, skills/
- complexity judge → ratified ladder band frontier
```proposal
{
  "shape": "judge",
  "strength": "frontier"
}
```
## Where
verified · directory · skills/
verified · directory · commands/
verified · directory · crew/roles/
verified · directory · crew/guidelines/
verified · directory · crew/pi/agents/
verified · file · crew/roster.json
verified · file · crew/capabilities.json
## Done means
A per-document register: for each file, the count of checkable claims, how many verified true / stale / false, and every stale or false one quoted with the evidence from main. A contradictions section listing each pair with both quotes. A format-compliance table for the skills (one row per skill, one column per ratified rule, pass or fail with the line). A charter-versus-register table. An overlap section naming repeated prose and proposing its single home. Ranked by: false claims first (an agent acting on them does the wrong thing), then contradictions, then stale, then format. Every verdict carries the command or file:line that established it — a claim marked true without evidence is itself a finding. The register states which files were read in full; for this scout that must be all of them.
## Tripwires
candidates: commands/close-out.md, commands/commands.test.mjs, commands/dispatch.md, commands/status.md, crew/capabilities.json, crew/capabilities.test.mjs, crew/crew.test.mjs, crew/daemon.test.mjs, crew/drive.test.mjs, crew/driver.test.mjs, crew/escalation-policy.test.mjs, crew/factoryctl.test.mjs, crew/guidelines/review-do-not-flag.md, crew/guidelines/seat-pre-return-checklist.md, crew/headless-rpc.test.mjs, crew/io-contract.test.mjs, crew/pi/agents/scout.json, crew/pi/extensions/lab.test.mjs, crew/pi/extensions/subagent.test.mjs, crew/reclaim-descendants.test.mjs, crew/roles/_shared.md, crew/roles/builder.md, crew/roles/lead.md, crew/roles/planner.md, crew/roles/reviewer.md, crew/roles/tech-lead.md, crew/roster-refresh.test.mjs, crew/roster.json, crew/seat-io-runclean.test.mjs, skills/backend-node/SKILL.md, skills/backend-node/exhibits.test.mjs, skills/backend-node/references/cli-flags.md, skills/backend-node/references/closed-enums.md, skills/backend-node/references/erasable-ts.md, skills/backend-node/references/evidence.md, skills/backend-node/references/import-firewall.md, skills/backend-node/references/usage-records.md, skills/backend-node/references/zero-dep.md, skills/crew-dispatch/SKILL.md, skills/crew-dispatch/cli-contract.test.mjs, skills/crew-dispatch/references/fences.md, skills/crew-dispatch/references/flags.md, skills/crew-dispatch/references/tier.md, skills/crew-dispatch/references/variants.md, skills/crew-dispatch/references/worktree.md, skills/crew-recovery/SKILL.md, skills/crew-recovery/references/closeout.md, skills/crew-recovery/references/escalations.md, skills/crew-recovery/references/liveness.md, skills/crew-recovery/references/mutation-proof.md, skills/devops/SKILL.md, skills/devops/exhibits.test.mjs, skills/devops/references/daemon.md, skills/devops/references/evidence.md, skills/devops/references/gh.md, skills/devops/references/lane-branches.md, skills/devops/references/processes.md, skills/devops/references/worktrees.md, skills/frontend-svelte/SKILL.md, skills/frontend-svelte/references/components.md, skills/frontend-svelte/references/routing.md, skills/frontend-svelte/references/structure.md, skills/frontend-svelte/references/testing.md, skills/pr-review/SKILL.md, skills/pr-review/findings-shape.test.mjs, skills/pr-review/references/divergence.md, skills/pr-review/references/evidence.md, skills/pr-review/references/findings-shape.md, skills/pr-review/references/posture.md, skills/pr-review/references/rubric.md, skills/qa-test-writing/SKILL.md, skills/qa-test-writing/references/absence.md, skills/qa-test-writing/references/captures.md, skills/qa-test-writing/references/gates.md, skills/qa-test-writing/references/tooling.md, skills/qa-test-writing/references/tripwires.md, skills/qa-test-writing/references/vacuity.md, skills/ui-design/SKILL.md, skills/ui-design/references/contract.md, skills/ui-design/references/limits.md, skills/ui-design/references/state-colour.md, skills/ui-design/references/tokens.md, test/factory-env.test.mjs, test/factory-intake.test.mjs, test/factory-ledger.test.mjs, test/factory-make-brief.test.mjs, test/factory-reap-stale.test.mjs, test/factory-transcript.test.mjs, test/visualizer-panels.test.mjs, test/visualizer-roster-edit.test.mjs, test/visualizer-server.test.mjs, test/visualizer-shape.test.mjs
tripwire tests:
- commands/commands.test.mjs · references/flags.md
- crew/capabilities.test.mjs · capabilities.json, crew/pi/agents/scout.json, crew/pi/extensions/subagent.ts, scout.json, subagent.ts
- crew/crew.test.mjs · _shared.md, builder.md, crew/daemon.mjs, crew/pi/agents/scout.json, crew/pi/extensions/subagent.ts, daemon.mjs, lead.md, planner.md, roster.json, scout.json, seat-io.mjs, subagent.ts
- crew/daemon.test.mjs · crew/daemon.mjs, daemon.json, daemon.mjs, daemon.sock, seat-io.mjs, variants.mjs
- crew/drive.test.mjs · SKILL.md, _shared.md, builder.md, capabilities.json, crew/capabilities.json, crew/daemon.mjs, crew/daemon.test.mjs, crew/guidelines/review-do-not-flag.md, crew/roles/planner.md, crew/roster.json, crew/seat-io.mjs, daemon.mjs, daemon.test.mjs, lead.md, planner.md, review-do-not-flag.md, reviewer.md, roster.json, seat-io.mjs, variants.mjs
- crew/driver.test.mjs · lead.md, planner.md, tech-lead.md
- crew/escalation-policy.test.mjs · crew/daemon.mjs, crew/daemon.test.mjs, daemon.mjs, daemon.test.mjs
- crew/factoryctl.test.mjs · daemon.mjs, daemon.sock
- crew/headless-rpc.test.mjs · subagent.ts
- crew/io-contract.test.mjs · roster.json, seat-io.mjs
- crew/pi/extensions/lab.test.mjs · crew/pi/extensions/subagent.test.mjs, crew/pi/extensions/subagent.ts, subagent.test.mjs, subagent.ts
- crew/pi/extensions/subagent.test.mjs · capabilities.json, crew/capabilities.json, crew/pi/agents/scout.json, crew/pi/extensions/subagent.ts, scout.json, subagent.ts
- crew/reclaim-descendants.test.mjs · seat-io.mjs
- crew/roster-refresh.test.mjs · crew/roster.json, roster.json
- crew/seat-io-runclean.test.mjs · builder.md, crew/seat-io.mjs, seat-io.mjs
- skills/backend-node/exhibits.test.mjs · flags.md
- test/factory-env.test.mjs · crew/daemon.mjs, crew/daemon.test.mjs, daemon.mjs, daemon.test.mjs, reap-stale.mjs, scripts/factory/reap-stale.mjs
- test/factory-intake.test.mjs · daemon.mjs
- test/factory-ledger.test.mjs · crew/seat-io.mjs, roster.json, seat-io.mjs
- test/factory-make-brief.test.mjs · planner.md, seat-pre-return-checklist.md
- test/factory-reap-stale.test.mjs · crew/seat-io.mjs, reap-stale.mjs, scripts/factory/reap-stale.mjs, seat-io.mjs
- test/factory-transcript.test.mjs · capabilities.json, crew/capabilities.json
- test/visualizer-panels.test.mjs · crew/roster.json, roster.json
- test/visualizer-roster-edit.test.mjs · crew/roster.json, roster.json
- test/visualizer-server.test.mjs · crew/roster.json, roster.json
- test/visualizer-shape.test.mjs · crew/seat-io.mjs, seat-io.mjs
broad keys (not used as tripwires):
- crew.mjs · 57 hits
- dispatch.md · 33 hits
- node:fs · 89 hits
- node:path · 87 hits
- node:test · 67 hits
- node:url · 40 hits
declare every hit: grep -rn "../../crew/crew.mjs\|../../crew/variants.mjs\|SKILL.md\|_shared.md\|absence.md\|argument-hint\|builder.md\|capabilities.json\|captures.md\|cli-contract.test.mjs\|cli-flags.md\|close-out.md\|closed-enums.md\|closeout.md\|commands.test.mjs\|commands/close-out.md\|commands/commands.test.mjs\|commands/dispatch.md\|commands/status.md\|components.md\|contract.md\|crew-dispatch\|crew-dispatch/references/flags.md\|crew-recovery\|crew-recovery/references/closeout.md\|crew.mjs\|crew/capabilities.json\|crew/daemon.mjs\|crew/daemon.test.mjs\|crew/guidelines/review-do-not-flag.md\|crew/guidelines/seat-pre-return-checklist.md\|crew/pi/agents/scout.json\|crew/pi/extensions/subagent.test.mjs\|crew/pi/extensions/subagent.ts\|crew/roles/_shared.md\|crew/roles/builder.md\|crew/roles/lead.md\|crew/roles/planner.md\|crew/roles/reviewer.md\|crew/roles/tech-lead.md\|crew/roster.json\|crew/seat-io.mjs\|daemon.json\|daemon.md\|daemon.mjs\|daemon.sock\|daemon.test.mjs\|devops/references/gh.md\|devops/references/worktrees.md\|dispatch.md\|divergence.md\|erasable-ts.md\|escalations.md\|evidence.md\|exhibits.test.mjs\|fences.md\|findings-shape.md\|findings-shape.test.mjs\|flags.md\|gates.md\|gh.md\|import-firewall.md\|lane-branches.md\|lead.md\|limits.md\|liveness.md\|mutation-proof.md\|node:fs\|node:path\|node:test\|node:url\|planner.md\|posture.md\|processes.md\|reap-stale.mjs\|references/findings-shape.md\|references/flags.md\|references/tier.md\|references/variants.md\|review-do-not-flag.md\|reviewer.md\|roster.json\|routing.md\|rubric.md\|scout.json\|scripts/factory/reap-stale.mjs\|seat-io.mjs\|seat-pre-return-checklist.md\|skills/backend-node/SKILL.md\|skills/backend-node/exhibits.test.mjs\|skills/backend-node/references/cli-flags.md\|skills/backend-node/references/closed-enums.md\|skills/backend-node/references/erasable-ts.md\|skills/backend-node/references/evidence.md\|skills/backend-node/references/import-firewall.md\|skills/backend-node/references/usage-records.md\|skills/backend-node/references/zero-dep.md\|skills/crew-dispatch/SKILL.md\|skills/crew-dispatch/cli-contract.test.mjs\|skills/crew-dispatch/references/fences.md\|skills/crew-dispatch/references/flags.md\|skills/crew-dispatch/references/tier.md\|skills/crew-dispatch/references/variants.md\|skills/crew-dispatch/references/worktree.md\|skills/crew-recovery/SKILL.md\|skills/crew-recovery/references/closeout.md\|skills/crew-recovery/references/escalations.md\|skills/crew-recovery/references/liveness.md\|skills/crew-recovery/references/mutation-proof.md\|skills/devops/SKILL.md\|skills/devops/exhibits.test.mjs\|skills/devops/references/daemon.md\|skills/devops/references/evidence.md\|skills/devops/references/gh.md\|skills/devops/references/lane-branches.md\|skills/devops/references/processes.md\|skills/devops/references/worktrees.md\|skills/frontend-svelte/SKILL.md\|skills/frontend-svelte/references/components.md\|skills/frontend-svelte/references/routing.md\|skills/frontend-svelte/references/structure.md\|skills/frontend-svelte/references/testing.md\|skills/pr-review/SKILL.md\|skills/pr-review/findings-shape.test.mjs\|skills/pr-review/references/divergence.md\|skills/pr-review/references/evidence.md\|skills/pr-review/references/findings-shape.md\|skills/pr-review/references/posture.md\|skills/pr-review/references/rubric.md\|skills/qa-test-writing/SKILL.md\|skills/qa-test-writing/references/absence.md\|skills/qa-test-writing/references/captures.md\|skills/qa-test-writing/references/gates.md\|skills/qa-test-writing/references/tooling.md\|skills/qa-test-writing/references/tripwires.md\|skills/qa-test-writing/references/vacuity.md\|skills/ui-design/SKILL.md\|skills/ui-design/references/contract.md\|skills/ui-design/references/limits.md\|skills/ui-design/references/state-colour.md\|skills/ui-design/references/tokens.md\|state-colour.md\|status.md\|structure.md\|subagent.test.mjs\|subagent.ts\|tech-lead.md\|testing.md\|tier.md\|tokens.md\|tooling.md\|tripwires.md\|usage-records.md\|vacuity.md\|variants.md\|variants.mjs\|worktree.md\|worktrees.md\|zero-dep.md" crew/ test/ scripts/ docs/
## Coupled sources
coupling rule: a coupled source is a non-test .js/.mjs file that names an exported symbol of a where file and names that file; a key-based grep sees a coupling only when both sides share a named symbol, so this is a floor, not a proof (dynamic, string-built, or renamed couplings are invisible); a non-test code file which only CITES a where/fence path by repo path or basename, for example in a comment, is coupled too, and a citation key over the broad-key limit is reported as broad rather than coupled.
- .agents/skills/review-procedure/scripts/load-guidelines.mjs · crew/guidelines/review-do-not-flag.md, review-do-not-flag.md · no fence in play
- crew/capabilities.mjs · capabilities.json, crew/capabilities.json · no fence in play
- crew/crew.mjs · _shared.md, builder.md, capabilities.json, crew/capabilities.json, lead.md, planner.md, reviewer.md, roster.json, tech-lead.md · no fence in play
- crew/drive.mjs · crew/roles/reviewer.md, crew/roles/tech-lead.md, lead.md, reviewer.md, tech-lead.md · no fence in play
- crew/protected-paths.mjs · capabilities.json, crew/capabilities.json, crew/roster.json, roster.json · no fence in play
- crew/roster-refresh.mjs · crew/roster.json, roster.json · no fence in play
- crew/seat-io.mjs · roster.json · no fence in play
- scripts/factory/ledger.mjs · crew/roster.json, roster.json · no fence in play
- scripts/factory/make-brief.mjs · crew/roles/planner.md, planner.md · no fence in play
- visualizer/server/roster-edit.mjs · crew/roster.json, roster.json · no fence in play
- visualizer/server/roster-ladder.mjs · crew/roster.json, roster.json · no fence in play
- visualizer/server/roster-source.mjs · roster.json · no fence in play
## Baseline
lane: npm test · pass 2171 · fail 0 · status: green
lane basis: ratified profile field test_command · /Users/x/.dev-team/factory/profiles/momoshell__dev-team-claude-plugin.json
count basis: measured this compile — a recorded baseline is a fact about a commit and is never consumed
## Out of scope
No edits. No rewriting prose. No judgement on tone or length beyond the ratified format rules. crew/roles/ charters are pinned by tests — name the test when a charter change would be needed, do not propose the change. No opinion on whether a skill should exist.
## Fences
no fence register supplied (`--fences` not given)
## What the crew decides
UNFILLED SLOT
## Acceptance
A per-document register: for each file, the count of checkable claims, how many verified true / stale / false, and every stale or false one quoted with the evidence from main. A contradictions section listing each pair with both quotes. A format-compliance table for the skills (one row per skill, one column per ratified rule, pass or fail with the line). A charter-versus-register table. An overlap section naming repeated prose and proposing its single home. Ranked by: false claims first (an agent acting on them does the wrong thing), then contradictions, then stale, then format. Every verdict carries the command or file:line that established it — a claim marked true without evidence is itself a finding. The register states which files were read in full; for this scout that must be all of them. · Full suite green. · UNFILLED SLOT
## Acceptance gate
Planner authors it; **RED at baseline**, printing
`GATE-SUMMARY {"total":n,"failed":n,"errored":n}` (`GATE_SUMMARY_PREFIX`,
`crew/drive.mjs:70`) with `errored: 0` at baseline (#153). Prove the gate
discriminates (#168), resolve the repo from `process.cwd()`, name in a comment
the mutation each check kills, never assert the checkout is clean. If your
gate shells out to the suite, strip ANSI before parsing it (#240).
## Per-check mutations
A per-check mutation declaration is MACHINE-APPLIED: the driver find-and-replaces
on a scratch copy of the built tree, re-runs the gate, and requires that one check
to redden. A prose field (`"kills": "leaving the loop unconditional"`) cannot be
applied and is refused — `validateMutations` in `crew/drive.mjs` is the single
enforcement point. Each entry in `details.mutations` is EITHER a mutation OR an
exemption, never both, and at most 32 entries in all (`MUTATIONS_MAX`).

A mutation entry carries exactly:

    { "check": "C1", "file": "lib/widget.mjs", "find": "<literal text present in the file>", "replace": "<literal replacement>" }

- `check` — a stable token matching `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` (letters,
  digits, dot, underscore, hyphen; starting with a letter or digit), unique across
  all entries. The gate MUST print `FAIL <check>` on that check's failing line
  (`CHECK_FAIL_PREFIX`), matched as an exact token — the label you declare and the
  label the gate prints are one string.
  Nothing may FOLLOW that label except a colon. `checkFailureLine`
  (`crew/drive.mjs`) is the matcher that decides, and it accepts the bare line or a
  single colon delimiter — nothing else. Literally:

      FAIL <check>                  ← accepted, the bare line
      FAIL <check>: <why>           ← accepted, the ONE delimiter is a colon
      FAIL <check> — <why>          ← REJECTED, an em dash is not a delimiter
      FAIL <check> <why>            ← REJECTED, a space is not a delimiter

  The reason, not merely the prohibition: a label may not be EXTENDED by what follows
  it. Were a space or a dash a legal delimiter, `FAIL cache` would match a
  `FAIL cache-v2` line and one check's red would be credited to another — the
  whole-gate false positive #330 exists to remove. Two planners in one day each wrote
  a human-readable separator instead, costing four gate generations across three lanes
  and escalating one lane whose code was correct (#387).
- `file` — required, repo-relative, a file and not a directory, and inside
  `files_in_scope`.
- `find` — required, non-empty LITERAL text that actually occurs in that file; not
  a regex, not a description.
- `replace` — required string, and must DIFFER from `find`; an identical pair
  mutates nothing.

An exemption entry carries exactly `{ "check": "<token>", "exempt": "<non-empty reason>" }`
and no `file`, `find` or `replace`.

The human sentence saying what a mutation kills belongs in a comment beside the
check in the gate file and in `plan.md`, never in the entry. Worked example — the
gate carries, above the check that prints `FAIL C1`:

    // MUTATION C1: neutralise the standing block in renderBrief's lines array and
    // no compiled brief carries the contract any more.

and the declaration is `{ "check": "C1", "file": "scripts/factory/make-brief.mjs", "find": "standingBlocks().mutations", "replace": "standingBlocks().nothing" }`.
Rationale: #330.

A gate that shells out to `node --test` MUST pass `--test-reporter=tap`. node
--test picks its reporter by context and the summary lines differ in their
leading character; measured on this checkout, same file and same environment,
the two shapes are LITERALLY:

    ℹ pass 7      ← default reporter, no --test-reporter flag
    ℹ fail 0
    # pass 7      ← --test-reporter=tap
    # fail 0

That leading character is `ℹ` (U+2139 INFORMATION SOURCE), not the ASCII
letter `i`, so a gate greping `^# fail (\d+)$` parses NOTHING under the
default reporter and reports no failures for a suite it never read. Pin the
reporter rather than widening the regex: the default is context-dependent and a
future Node release may change it again, so a tolerant regex accepting both
shapes still silently depends on the reporter for every shape it does not
anticipate. Match the LAST summary line, not the first — an earlier echoed
`# fail 0` otherwise satisfies the check while a later real nonzero summary
passes it.

Colour is the other half: `FORCE_COLOR` OVERRIDES `NO_COLOR`, so a
colour-neutral child must DELETE `FORCE_COLOR` (and `CLICOLOR_FORCE`) from its
environment rather than only setting `NO_COLOR=1`. Under `FORCE_COLOR=3
NO_COLOR=1` the measured line is `ESC[34mℹ pass 7ESC[39m` (ESC = 0x1b), so an
`^`-anchored grep matches nothing. Strip ANSI before parsing either shape
(#240). Rationale: #399.

A declared mutation must exercise the check's NARROWEST claimed property, not
merely redden the check. The per-check proof asks only "does this mutation redden
this check?"; it cannot ask "does this mutation exercise what this check
CLAIMS?", and on 2026-08-20 four checks certified `killed` were each weaker
than their own prose. Read your own mutation as an adversary: what is the cheapest
implementation that violates the sentence beside the check and still passes it?
Two measured counter-examples, both certified `killed`:

- A mutation landing IN A COMMENT. `C1` claimed "≥3 tests are named for the
  re-ask, one naming the bound"; its declared mutation rewrote a `re-ask`
  occurrence inside a COMMENT — text the check never reads — so it reddened
  nothing the check counts and the real mutation had to be found by hand.
  Mutate the text the check actually parses; if no such `find` exists, the
  check is reading something other than what its prose claims.
- A negative-claim fixture INDISTINGUISHABLE from what already exists. `G15`
  claimed "an unknown adapter's overlay cannot silently widen another
  adapter", and injected an overlay carrying an extension the target ALREADY
  had, then asserted only that a third adapter stayed empty. An implementation
  merging every overlay into the target passes it: the duplicate dedupes and
  the third adapter is untouched. State a negative claim positively — the
  injected fixture must be DISTINCTIVE, a value nothing else in the fixture
  carries so its arrival is unambiguous, and the protected side must be
  compared BEFORE-AND-AFTER, never merely observed to be empty.

A COMPOUND CLAIM needs one mutation per half. `G15` ("cannot widen" AND
"another adapter") and `L11` ("every anchor" AND "one a resolver reads") each
had a half no declared mutation probed: `L11`'s check added every discovered RANGE
citation to its own resolved set, while its mutation used the single-line form,
so the range hole was never touched. If the sentence beside your check has two
verbs, declare two entries or write a narrower sentence.
Rationale: #409.
## Validation lane
narrow: node --test commands/commands.test.mjs crew/capabilities.test.mjs crew/crew.test.mjs crew/daemon.test.mjs crew/drive.test.mjs crew/driver.test.mjs crew/escalation-policy.test.mjs crew/factoryctl.test.mjs crew/headless-rpc.test.mjs crew/io-contract.test.mjs crew/pi/extensions/lab.test.mjs crew/pi/extensions/subagent.test.mjs crew/reclaim-descendants.test.mjs crew/roster-refresh.test.mjs crew/seat-io-runclean.test.mjs skills/backend-node/exhibits.test.mjs test/factory-env.test.mjs test/factory-intake.test.mjs test/factory-ledger.test.mjs test/factory-make-brief.test.mjs test/factory-reap-stale.test.mjs test/factory-transcript.test.mjs test/visualizer-panels.test.mjs test/visualizer-roster-edit.test.mjs test/visualizer-server.test.mjs test/visualizer-shape.test.mjs
full: npm test · measured baseline pass 2171, fail 0
## Conventions
files_in_scope (expected write surface; basis: authored where paths, no lane fence applied): commands/, crew/capabilities.json, crew/guidelines/, crew/pi/agents/, crew/roles/, crew/roster.json, skills/
read-and-keep-green (discovered tripwire surface — pinned by keys you touch; do not edit): commands/close-out.md, commands/commands.test.mjs, commands/dispatch.md, commands/status.md, crew/capabilities.test.mjs, crew/crew.test.mjs, crew/daemon.test.mjs, crew/drive.test.mjs, crew/driver.test.mjs, crew/escalation-policy.test.mjs, crew/factoryctl.test.mjs, crew/guidelines/review-do-not-flag.md, crew/guidelines/seat-pre-return-checklist.md, crew/headless-rpc.test.mjs, crew/io-contract.test.mjs, crew/pi/agents/scout.json, crew/pi/extensions/lab.test.mjs, crew/pi/extensions/subagent.test.mjs, crew/reclaim-descendants.test.mjs, crew/roles/_shared.md, crew/roles/builder.md, crew/roles/lead.md, crew/roles/planner.md, crew/roles/reviewer.md, crew/roles/tech-lead.md, crew/roster-refresh.test.mjs, crew/seat-io-runclean.test.mjs, skills/backend-node/SKILL.md, skills/backend-node/exhibits.test.mjs, skills/backend-node/references/cli-flags.md, skills/backend-node/references/closed-enums.md, skills/backend-node/references/erasable-ts.md, skills/backend-node/references/evidence.md, skills/backend-node/references/import-firewall.md, skills/backend-node/references/usage-records.md, skills/backend-node/references/zero-dep.md, skills/crew-dispatch/SKILL.md, skills/crew-dispatch/cli-contract.test.mjs, skills/crew-dispatch/references/fences.md, skills/crew-dispatch/references/flags.md, skills/crew-dispatch/references/tier.md, skills/crew-dispatch/references/variants.md, skills/crew-dispatch/references/worktree.md, skills/crew-recovery/SKILL.md, skills/crew-recovery/references/closeout.md, skills/crew-recovery/references/escalations.md, skills/crew-recovery/references/liveness.md, skills/crew-recovery/references/mutation-proof.md, skills/devops/SKILL.md, skills/devops/exhibits.test.mjs, skills/devops/references/daemon.md, skills/devops/references/evidence.md, skills/devops/references/gh.md, skills/devops/references/lane-branches.md, skills/devops/references/processes.md, skills/devops/references/worktrees.md, skills/frontend-svelte/SKILL.md, skills/frontend-svelte/references/components.md, skills/frontend-svelte/references/routing.md, skills/frontend-svelte/references/structure.md, skills/frontend-svelte/references/testing.md, skills/pr-review/SKILL.md, skills/pr-review/findings-shape.test.mjs, skills/pr-review/references/divergence.md, skills/pr-review/references/evidence.md, skills/pr-review/references/findings-shape.md, skills/pr-review/references/posture.md, skills/pr-review/references/rubric.md, skills/qa-test-writing/SKILL.md, skills/qa-test-writing/references/absence.md, skills/qa-test-writing/references/captures.md, skills/qa-test-writing/references/gates.md, skills/qa-test-writing/references/tooling.md, skills/qa-test-writing/references/tripwires.md, skills/qa-test-writing/references/vacuity.md, skills/ui-design/SKILL.md, skills/ui-design/references/contract.md, skills/ui-design/references/limits.md, skills/ui-design/references/state-colour.md, skills/ui-design/references/tokens.md, test/factory-env.test.mjs, test/factory-intake.test.mjs, test/factory-ledger.test.mjs, test/factory-make-brief.test.mjs, test/factory-reap-stale.test.mjs, test/factory-transcript.test.mjs, test/visualizer-panels.test.mjs, test/visualizer-roster-edit.test.mjs, test/visualizer-server.test.mjs, test/visualizer-shape.test.mjs
conventions of record (basis: ratified profile field conventions · /Users/x/.dev-team/factory/profiles/momoshell__dev-team-claude-plugin.json): .claude/, README.md, docs/adr/, docs/conventions.md
grep -rn "../../crew/crew.mjs\|../../crew/variants.mjs\|SKILL.md\|_shared.md\|absence.md\|argument-hint\|builder.md\|capabilities.json\|captures.md\|cli-contract.test.mjs\|cli-flags.md\|close-out.md\|closed-enums.md\|closeout.md\|commands.test.mjs\|commands/close-out.md\|commands/commands.test.mjs\|commands/dispatch.md\|commands/status.md\|components.md\|contract.md\|crew-dispatch\|crew-dispatch/references/flags.md\|crew-recovery\|crew-recovery/references/closeout.md\|crew.mjs\|crew/capabilities.json\|crew/daemon.mjs\|crew/daemon.test.mjs\|crew/guidelines/review-do-not-flag.md\|crew/guidelines/seat-pre-return-checklist.md\|crew/pi/agents/scout.json\|crew/pi/extensions/subagent.test.mjs\|crew/pi/extensions/subagent.ts\|crew/roles/_shared.md\|crew/roles/builder.md\|crew/roles/lead.md\|crew/roles/planner.md\|crew/roles/reviewer.md\|crew/roles/tech-lead.md\|crew/roster.json\|crew/seat-io.mjs\|daemon.json\|daemon.md\|daemon.mjs\|daemon.sock\|daemon.test.mjs\|devops/references/gh.md\|devops/references/worktrees.md\|dispatch.md\|divergence.md\|erasable-ts.md\|escalations.md\|evidence.md\|exhibits.test.mjs\|fences.md\|findings-shape.md\|findings-shape.test.mjs\|flags.md\|gates.md\|gh.md\|import-firewall.md\|lane-branches.md\|lead.md\|limits.md\|liveness.md\|mutation-proof.md\|node:fs\|node:path\|node:test\|node:url\|planner.md\|posture.md\|processes.md\|reap-stale.mjs\|references/findings-shape.md\|references/flags.md\|references/tier.md\|references/variants.md\|review-do-not-flag.md\|reviewer.md\|roster.json\|routing.md\|rubric.md\|scout.json\|scripts/factory/reap-stale.mjs\|seat-io.mjs\|seat-pre-return-checklist.md\|skills/backend-node/SKILL.md\|skills/backend-node/exhibits.test.mjs\|skills/backend-node/references/cli-flags.md\|skills/backend-node/references/closed-enums.md\|skills/backend-node/references/erasable-ts.md\|skills/backend-node/references/evidence.md\|skills/backend-node/references/import-firewall.md\|skills/backend-node/references/usage-records.md\|skills/backend-node/references/zero-dep.md\|skills/crew-dispatch/SKILL.md\|skills/crew-dispatch/cli-contract.test.mjs\|skills/crew-dispatch/references/fences.md\|skills/crew-dispatch/references/flags.md\|skills/crew-dispatch/references/tier.md\|skills/crew-dispatch/references/variants.md\|skills/crew-dispatch/references/worktree.md\|skills/crew-recovery/SKILL.md\|skills/crew-recovery/references/closeout.md\|skills/crew-recovery/references/escalations.md\|skills/crew-recovery/references/liveness.md\|skills/crew-recovery/references/mutation-proof.md\|skills/devops/SKILL.md\|skills/devops/exhibits.test.mjs\|skills/devops/references/daemon.md\|skills/devops/references/evidence.md\|skills/devops/references/gh.md\|skills/devops/references/lane-branches.md\|skills/devops/references/processes.md\|skills/devops/references/worktrees.md\|skills/frontend-svelte/SKILL.md\|skills/frontend-svelte/references/components.md\|skills/frontend-svelte/references/routing.md\|skills/frontend-svelte/references/structure.md\|skills/frontend-svelte/references/testing.md\|skills/pr-review/SKILL.md\|skills/pr-review/findings-shape.test.mjs\|skills/pr-review/references/divergence.md\|skills/pr-review/references/evidence.md\|skills/pr-review/references/findings-shape.md\|skills/pr-review/references/posture.md\|skills/pr-review/references/rubric.md\|skills/qa-test-writing/SKILL.md\|skills/qa-test-writing/references/absence.md\|skills/qa-test-writing/references/captures.md\|skills/qa-test-writing/references/gates.md\|skills/qa-test-writing/references/tooling.md\|skills/qa-test-writing/references/tripwires.md\|skills/qa-test-writing/references/vacuity.md\|skills/ui-design/SKILL.md\|skills/ui-design/references/contract.md\|skills/ui-design/references/limits.md\|skills/ui-design/references/state-colour.md\|skills/ui-design/references/tokens.md\|state-colour.md\|status.md\|structure.md\|subagent.test.mjs\|subagent.ts\|tech-lead.md\|testing.md\|tier.md\|tokens.md\|tooling.md\|tripwires.md\|usage-records.md\|vacuity.md\|variants.md\|variants.mjs\|worktree.md\|worktrees.md\|zero-dep.md" crew/ test/ scripts/ docs/
- The factory scripts carry a Node ≥24 floor; follow the existing
  `scripts/factory/*` conventions rather than inventing new ones.
- No version bump (#137). Commit on green only. Never push, never open a PR.
  No `Co-Authored-By` trailers.
- If interrupted, write your ReturnEnvelope first on resume — `status:
  insufficient` if incomplete. A silent seat is indistinguishable from a dead
  one.
