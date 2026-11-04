# ADR-056 — The ask is operator words

**Status:** proposed 2026-11-04, operator request; ratified by merging this PR

**Relates to:** ADR-055 §1 (amended here), ADR-050 Amendment 1 (no Claude Code hook)

## Decision

An operator brief's `## The ask` quotes only words the operator typed, verbatim. An operator decision belongs there too. A proposal, premise or measured fact belongs in `~/.crew/notes/<lane>.md`, linked from `## Context`. Issue briefs have no ask; `crew start` fetches the issue body as before. ADR-055 §1's allowance for an approved proposal in the ask is withdrawn.

`crew start` and `crew start --check` compare each ask line containing a letter or digit with typed messages. After whitespace runs are normalised, each line must be a substring of one message. A measured miss refuses the start before agent resolution or effects and names the line. This check establishes a text match, not the intent or identity of the author.

## Measurement and limits

The source is `~/.claude/projects/*/*.jsonl`, limited to files modified in the last 30 days. On 2026-11-04, operator rows in Claude Code transcripts had `type: "user"`, `origin.kind: "human"`, `promptSource: "typed"`, and string `message.content`. ACP seat prompts also had user and human fields but used `promptSource: "sdk"`; task notifications used `promptSource: "system"`. Only typed string rows count. Pasted content blocks are removed before matching. A malformed row with a typed prompt marker makes the scan incomplete.

If the transcript directory is missing or unreadable, a project directory or transcript file cannot be read or checked, a typed row cannot be parsed, or no typed message is measured in the window, start logs that provenance is unmeasured and continues. An incomplete scan cannot establish a miss because the missing transcript might contain the ask. Pi and Muse operators have no Claude transcript to check; this decision supplies no fallback for them. A readable Claude transcript from another session does not establish provenance for those operators.

Transcripts and brief snapshots can be changed by a session. Protecting them needs a hook, but ADR-050 Amendment 1 forbids a Claude Code hook. This decision adds no hook and does not close that gap.
