---
name: reviewer
description: Reviews the built diff against the plan and its acceptance checks.
role: reviewer
writes: task-dir
agent: claude
model: anthropic/claude-opus-5-5
effort: high
advisor: null
tiers: {"judge":{"effort":"xhigh"}}
---
Read and follow [the reviewer charter](../roles/reviewer.md).
