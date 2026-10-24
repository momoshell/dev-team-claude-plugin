---
name: lead
description: The crew's judge: reads envelopes and decides, while code drives the loop.
role: lead
writes: task-dir
agent: pi
model: openai/gpt-6-astra
effort: high
fallback: [{"agent":"pi","model":"openai/gpt-6.1-sol","effort":"high"}]
advisor: null
tiers: {"mechanical":null}
---
Read and follow [the lead charter](../roles/lead.md).
