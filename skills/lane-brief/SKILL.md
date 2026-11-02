---
name: lane-brief
description: Use when starting a crew lane from a GitHub issue or an operator request. Writes one short P1 brief (ADR-052), checks its premises on main, validates it and starts the lane with crew start. The planner does the exploring; the brief only points it.
---

# lane-brief

A lane starts from a source, a GitHub issue or an operator request. Write one short brief that points the
planner at the work, then start the lane with it. The planner reads the code itself, so the brief carries no
file list, symbol index, tripwire list or baseline; the planner declares `files_in_scope` in its own plan. The format is protocol P1 in
`docs/adr/adr-052-agents-do-the-work.md`; the validator is `parseBrief` in `crew/protocols.mjs`.

## Steps

1. Read the source: `gh issue view <N>`, or the operator's words.
2. Check every premise on main (`git grep`, `git show main:<path>`, a quick run). A premise you did not check
   is either left out or written as "unmeasured: <why>".
3. Write the brief to `~/.crew/briefs/<lane>.md`. The file name is the lane name: lowercase letters, digits
   and `-` (convention `b<next number>-<short-slug>`; the last numbers are in `git branch -a` and
   `~/.crew/briefs/started/`).
4. Validate: `crew start ~/.crew/briefs/<lane>.md --check`. In this repo, run the checkout's own copy:
   `node crew/start.mjs <brief> --check`. Fix every defect it names.
5. Start: the same command without `--check`. It creates `../dt-<lane>`, snapshots the brief, writes the lean
   spec and starts the lean loop detached. Both steps check the brief with the P1 brief check and resolve the
   agent definitions (standard shape only); they run no other parser. It prints the worktree,
   the brief snapshot, the run log and the status command.
6. Close the lane out after its PR merges with the `crew-recovery` skill, as before.

## Format

```markdown
---
source: issue 1962
closes: 1962
tier: build
shape: standard
out_of_scope: the visualizer and the roster itself
---
## The ask

What to change and why, in a few sentences. State the invariant the change must hold.

## Context

- `crew/agents.mjs` `resolveAgents`: what it already checks.
- `test/visualizer-server.test.mjs`: the test that pins the current behaviour.

```

No acceptance ids or `## Acceptance` section: the planner writes the criteria (ADR-055 §1). A brief with an `acceptance` field is refused.
Field rules (the validator refuses anything else):

- `source`: the issue or the request the lane starts from.
- `closes`: one issue number, or `null`. It is the only issue binding: `crew start` writes it into the run
  brief's bound-issue header, and the merged PR closes it. The body carries no `#N` at all; write "issue 1961" or "PR 1968".
- `tier`: `mechanical`, `build` or `judge`. Use `judge` when the change touches the loop's own enforcement
  (`crew/loop.mjs`, `crew/checks.mjs`, `crew/acp/grants.mjs`, `hooks/`) or the decision records under `docs/adr/`. Code raises the lane to judge on protected paths.
- `shape`: `standard` only. `finish` is not started from a brief.
- `out_of_scope`: what the lane must not change.
- `suite` (optional): the command line the lean lane runs as its suite, for example `suite: cargo test -p power-api`.
  Absent, the lane runs `npm test`.

## Keep it short

- Point, do not paste. Name the files and functions to read; the planner opens them.
- Say what must be true, not how to compare it. If an item compares against existing repo state, name the
  repo test that already makes that comparison.
- One lane per brief. Split work that needs two different gates.
