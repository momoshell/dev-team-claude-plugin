---
name: lane-brief
description: Use when starting a crew lane from a GitHub issue or an operator request. Writes one short P1 brief (ADR-052), checks its premises on main, validates it and starts the lane with crew start. The planner does the exploring; the brief only points it.
---

# lane-brief

A lane starts from a source, a GitHub issue or an operator request. Write one short brief and start the lane.
For a build lane, the planner reads the code and declares `files_in_scope` in its plan. A mechanical lane has no
planner. The brief carries no file list, symbol index, tripwire list or baseline. The format is protocol P1 in
`docs/adr/adr-055-planner-defines-the-work.md` §1; the validator is `parseBrief` in `crew/protocols.mjs`.

## Steps

1. Read the source: `gh issue view <N>`, or the operator's words. The ask comes from that source: for an issue,
   write no ask (`crew start` adds the issue body); for an operator request, quote only words the operator typed,
   verbatim. Put proposals, premises and measured facts in `~/.crew/notes/<lane>.md` and point to it in `## Context`.
2. Check every premise on main (`git grep`, `git show main:<path>`, a quick run). A premise you did not check
   is either left out or written as "unmeasured: <why>" in the notes.
3. Write the brief to `~/.crew/briefs/<lane>.md`. The file name is the lane name: lowercase letters, digits
   and `-` (convention `b<next number>-<short-slug>`; the last numbers are in `git branch -a` and
   `~/.crew/briefs/started/`).
4. Validate: `crew start ~/.crew/briefs/<lane>.md --check`. In this repo, run the checkout's own copy:
   `node crew/start.mjs <brief> --check`. Fix every defect it names. When typed messages are measured,
   `crew start` refuses an ask line not found in them (ADR-056).
5. Start: the same command without `--check`. It creates `../dt-<lane>`, snapshots the brief, writes the lean
   spec and starts the lean loop detached. Both steps check the P1 brief and ask provenance, then resolve the
   agent definitions (standard shape only). It prints the worktree,
   the brief snapshot, the run log and the status command.
6. Close the lane out after its PR merges with the `crew-recovery` skill, as before.

## Format

```markdown
---
source: issue 1962
closes: 1962
shape: standard
out_of_scope: the visualizer
---
## Context

- `crew/agents.mjs` `resolveAgents`
- `test/visualizer-server.test.mjs`
```

For an operator request:

```markdown
---
source: operator request
closes: null
shape: standard
out_of_scope: the visualizer
---
## The ask

> Check whether an edited seat definition can boot.

## Context

- `crew/agents.mjs` `resolveAgents`
```

Context items are bare pointers: each list item contains one or more code spans, Markdown links, `issue N` or `PR N`, separated by spaces or tabs. No prose or continuation lines. Rules and criteria belong to the planner.

No acceptance ids or `## Acceptance` section: the planner writes the criteria (ADR-055 §1). A brief with an `acceptance` field is refused.
Field rules (the validator refuses anything else):

- `source`: the issue or the request the lane starts from.
- `closes`: one issue number, or `null`. It is the only issue binding: `crew start` writes it into the run
  brief's bound-issue header, and the merged PR closes it. Quote the operator's words verbatim, `#N` included: a quoted `#N` binds nothing. Elsewhere in the body, write "issue 1961" or "PR 1968".
- `mechanical` (optional): write `mechanical: true` only when the issue shows no behaviour to judge and names none of the protected paths: `crew/loop.mjs`, `crew/checks.mjs`, `crew/finish.mjs`, `crew/lean.mjs`, `crew/proof.mjs`, `crew/proof-reporter.mjs`, `crew/protocols.mjs`, `crew/acp/grants.mjs`, `hooks/`, `crew/agents/`, `.github/workflows/`, and `docs/adr/` (ADR-055 §7). Without it the lane runs the build loop. Judge is reached only by the planner's `judge` reason or a path raise. A `tier` line is refused.
- `shape`: `standard` only. `finish` is not started from a brief.
- `out_of_scope` (optional): what the lane must not change. Absent means none.
- `suite` (optional): the command line the lean lane runs as its suite, for example `suite: cargo test -p power-api`.
  Absent, the lane runs `npm test`. The line is split on whitespace without a shell; quotes and backslashes are refused, so an argument cannot contain a space.
- `generated` and `regenerate` (optional, declared together): list literal repo-relative tracked files or directories
  (a trailing `/` marks a directory), for example `generated: [docs/api.json, dist/]`, and give a command line
  such as `regenerate: npm run generate`. The line is split on whitespace without a shell; quotes and backslashes are refused, so an argument cannot contain a space. On a rebase conflict limited to those paths, the lane takes the base
  copy and completes the rebase. It runs the command without a shell in a fresh scratch checkout of the rebased
  lane, with no ignored or untracked files, so it must not need an install or a prior build. Ignored output is
  discarded and never committed. An undeclared conflict or change stops with `undeclared-path`; a non-zero command
  stops with `regenerate-failed`; remaining conflict markers stop with `conflict-markers`. An interrupted or
  unmeasured command keeps its unmeasured reason. The lane restores the checkout before stopping.

## Keep it short

- Point, do not paste. Name the files and functions to read; the planner opens them.
- One lane per brief. Split work that needs different suites or loops.
