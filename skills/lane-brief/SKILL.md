---
name: lane-brief
description: Use when starting a crew lane from a GitHub issue or an operator request. Writes one short P1 brief, checks its premises on the base and starts the lane with crew start.
---

# lane-brief

A lane starts from a GitHub issue or an operator request. Write one short brief; the planner explores the code.
The brief validator is `parseBrief` in `crew/protocols.mjs`. Read it for the field and Context rules.
Before choosing `mechanical`, read both `PROTECTED` in `crew/loop.mjs` and the optional
`protectedPaths` list in the project's `.crew/project.json`. For generated files, read the
regenerate handling in `crew/checks.mjs` (`rebase-conflict` and its `regenerate` detail).

## Steps

1. Read the source: `gh issue view <N>`, or the operator's words. For an issue, put the ask in the issue body;
   `crew start` reads the title and body, refuses an empty title, and writes the title into the run brief as `Issue title:`. If the operator makes a decision after the issue was filed, append it to
   the issue body, quoting the operator. Put proposals, premises and measured facts in an issue the operator
   can read and edit. A session-filed issue opens with the operator words that asked for it. For an operator
   request, quote the operator's words verbatim,
   one whole message per quoted block; do not use excerpts or combine messages. When provenance is
   measured, `askProvenance` in `crew/brief-provenance.mjs` checks each block against a typed or queued message.
2. Fetch origin, then check premises on the base branch (`git grep`, `git show origin/main:<path>`, a quick run).
   Leave unchecked premises out or mark them unmeasured in the issue. A decision or measured answer on the
   issue must leave no behaviour undefined: when it adds or changes a setting, state its default and what
   unset means in each environment the code runs in. The planner and the reviewer otherwise each pick a
   reading, and the lane escalates.
   When the issue or a decision on it specifies a test's inputs, fixture or expected result, check on the
   base that those inputs can produce that result, by arithmetic, code-path inspection or a quick run.
   If they cannot, correct the issue before dispatch; if the check was not performed, mark that premise
   unmeasured in the issue rather than omitting it.
   For each acceptance line that tightens a shared rule, find every affected caller on the base and
   check that this lane's diff alone can satisfy the line. If it needs a later lane's work, move the
   line to that lane and record the move in both issues.
   When a key or constraint changes, check readers as well as writers. Search for joins, `GROUP BY`
   clauses and lookups that use the changed key.
   When the operator approves a proposed Measured section, rewrite each approved “Recommend …” as
   `Decided (operator, <date>)` and remove any wording that says the decision is still open or tells
   readers to wait for the owner. Do this before folding the section into the issue.
3. Write the brief to `~/.crew/briefs/<lane>.md`. Use `<project>-<issue>-<slug>` for the lane name (for example,
   `devteam-1962-lane-names`); see `LANE` in `crew/lane-core.mjs` for the allowed characters. Choose `source`, the issue bound by `closes`, whether the
   work is `mechanical`, and what is `out_of_scope`. Use Context pointers to the files and symbols the planner
   should read. A mechanical lane has no planner; use it only for work with no behaviour to judge and no
   protected paths. A new lane uses `shape: standard`.
4. Start with `crew start ~/.crew/briefs/<lane>.md`. Fix any refusal and retry. In this repo, the checkout's
   copy is `node crew/start.mjs <brief>`. Close the lane after its PR merges using `crew-recovery`.

Use bare `issue N` pointers in `## Context` for related issues. For issue and operator-request briefs alike, `crew start` fetches each distinct reference other than the source and adds its title and whole quoted body under `## Referenced issues` immediately after Context. Do not write that generated section yourself. References are context, not asks; only `closes` binds an issue. Start refuses and names any reference it cannot read before creating the worktree. Empty or whitespace-only bodies appear as `empty body` with the title. `PR N` pointers are not fetched.

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
