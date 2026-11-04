# ADR-059 — Plugin hooks for the crew gates

**Status:** proposed 2026-11-04, operator decision · **Amends:** ADR-050 Amendment 1 (2026-10-17) · **Depends on:** ADR-056 and ADR-057

The operator was asked whether the hooks should go in too and answered: "yes, all; probably best as followup".

The plugin registers these hooks:

1. SessionStart adds a context line when the checkout is not onboarded or its onboarding is stale. It never blocks.
2. PreToolUse for Bash denies a `crew start` or `crew finish` resolved to a crew home whose source lacks the applicable provenance and onboarding checks. It directs the operator to the local checkout.
3. PreToolUse for Write, Edit and Bash denies recognized writes to `~/.claude/projects/` transcripts and `~/.crew/briefs/started/` snapshots.

Both hooks do nothing when `CREW_ROLE` is set or the current directory is outside a git checkout. Following ADR-028, they deny only on positive evidence and fail open on errors. Shell inspection is not a full shell parser: uncommon shell forms and symlinks into the protected roots can be missed.

A session that runs with hooks disabled bypasses them.
