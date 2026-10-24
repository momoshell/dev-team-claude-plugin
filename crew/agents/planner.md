---
name: planner
description: Reads the task and writes the plan the builder implements.
role: planner
writes: task-dir
agent: pi
model: openai/gpt-6.1-sol
effort: high
advisor: null
tiers: {"mechanical":{"effort":"medium"}}
---
Read and follow [the planner charter](../roles/planner.md).
