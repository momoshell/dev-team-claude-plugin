---
name: lane-brief
description: Use when starting a crew lane from a GitHub issue or an operator request. Writes one short P1 brief, checks its premises on the base and starts the lane with crew start.
---

# lane-brief

A lane starts from a GitHub issue or an operator request. Write one short brief; the planner explores the code.
The brief validator is `parseBrief` in `crew/protocols.mjs`. Read it for the field and Context rules.
For protected paths, read `PROTECTED` in `crew/loop.mjs`. For generated files, read the regenerate handling
in `crew/checks.mjs` (`rebase-conflict` and its `regenerate` detail).

## Steps

1. Read the source: `gh issue view <N>`, or the operator's words. For an issue, put the ask in the issue body;
   `crew start` reads only the body. If the operator makes a decision after the issue was filed, append it to
   the issue body, quoting the operator. Put proposals, premises and measured facts in an issue the operator
   can read and edit. A session-filed issue opens with the operator words that asked for it. For an operator
   request, quote the operator's words verbatim,
   one whole message per quoted block; do not use excerpts or combine messages. When provenance is
   measured, `askProvenance` in `crew/brief-provenance.mjs` checks each block against a typed or queued message.
2. Fetch origin, then check premises on the base branch (`git grep`, `git show origin/main:<path>`, a quick run).
   Leave unchecked premises out or mark them unmeasured in the issue.
3. Write the brief to `~/.crew/briefs/<lane>.md`. Use `<project>-<issue>-<slug>` for the lane name (for example,
   `devteam-1962-lane-names`); see `LANE` in `crew/lane-core.mjs` for the allowed characters. Choose `source`, the issue bound by `closes`, whether the
   work is `mechanical`, and what is `out_of_scope`. Use Context pointers to the files and symbols the planner
   should read. A mechanical lane has no planner; use it only for work with no behaviour to judge and no
   protected paths. A new lane uses `shape: standard`.
4. Start with `crew start ~/.crew/briefs/<lane>.md`. Fix any refusal and retry. In this repo, the checkout's
   copy is `node crew/start.mjs <brief>`. Close the lane after its PR merges using `crew-recovery`.

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
