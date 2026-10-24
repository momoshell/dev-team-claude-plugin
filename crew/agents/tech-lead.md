---
name: tech-lead
description: Settles the escalations the lead cannot, at the judge tier.
role: tech-lead
writes: task-dir
agent: claude
model: anthropic/claude-opus-5-5
effort: xhigh
fallback: [{"agent":"claude","model":"anthropic/claude-fable-5-1","effort":"medium"}]
advisor: null
tiers: {"mechanical":null,"build":null}
---
Read and follow [the tech-lead charter](../roles/tech-lead.md).
