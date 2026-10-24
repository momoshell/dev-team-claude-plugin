---
description: Start a crew lane from an issue or a request.
argument-hint: <issue-number-or-request>
---

Start a crew lane for: $ARGUMENTS

Load the `lane-brief` skill (`skills/lane-brief/SKILL.md`) and follow it for the
target above: one short brief, validated, then started. The skill owns the
procedure; this command only names it and passes the argument through. The
batch path stays available through the `crew-dispatch` skill until the switch
(ADR-052).
