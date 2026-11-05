# ADR-056 — The ask is operator words

**Status:** proposed 2026-11-04, operator request; ratified by merging this PR; Amendment 1 proposed 2026-11-04; Amendment 2 proposed, operator request

**Relates to:** ADR-055 §1 (amended here), ADR-050 Amendment 1 (no Claude Code hook)

## Decision

An operator brief's `## The ask` quotes only words the operator typed, verbatim. An operator decision belongs there too. A proposal, premise or measured fact belongs in `~/.crew/notes/<lane>.md`, linked from `## Context`. Issue briefs have no ask; `crew start` fetches the issue body as before. ADR-055 §1's allowance for an approved proposal in the ask is withdrawn.

`crew start` and `crew start --check` compare each ask line containing a letter or digit with typed messages. After whitespace runs are normalised, each line must be a substring of one message. A measured miss refuses the start before agent resolution or effects and names the line. This check establishes a text match, not the intent or identity of the author.

## Amendment 1 (2026-11-04, operator request)

This amendment replaces the notes and substring rules above. Context items contain only code spans, `issue N` or `PR N`, not Markdown links or prose. Code spans cannot start with `/`, `~` or a URL scheme, or contain a `..` path segment. The first code span of each item and later spans containing `/` are paths; other later spans name symbols. A real start checks each path on the local base branch used for the worktree (named by `origin/HEAD`) before reading the issue or adding a worktree. It refuses symlinks and submodules in the path, including intermediate components. `--check` validates the form without checking the base.

Each run of consecutive quoted lines in `## The ask` is one block. Blocks without a letter or digit are dropped. When typed messages are measured, each block must equal one whole typed message after whitespace normalisation and removal of pasted content from the message. A miss refuses both start and `--check`. Operator decisions belong in the ask; `## Decisions` is not a brief section.

The allowance for `~/.crew/notes` in Context is withdrawn. Put proposals, premises and measured facts in an issue the operator can read and edit. A session-filed issue opens with the operator words that asked for it. This is a convention, not an enforcement: a session holding the operator's GitHub token can file an issue as the operator, so the issue author cannot prove who wrote its body.

## Amendment 2 (operator request)

Queued operator messages count alongside typed messages under the same guards and pasted-content removal.

## Measurement and limits

The source is `~/.claude/projects/*/*.jsonl`, limited to files modified in the last 30 days. On 2026-11-04, operator rows in Claude Code transcripts had `type: "user"`, `origin.kind: "human"`, `promptSource: "typed"`, and string `message.content`. ACP seat prompts also had user and human fields but used `promptSource: "sdk"`; task notifications used `promptSource: "system"`. Typed and queued string rows count under the same type and origin guards. Pasted content blocks are removed before matching. A malformed row with a typed or queued prompt marker makes the scan incomplete.

If the transcript directory is missing or unreadable, a project directory or transcript file cannot be read or checked, a typed or queued row cannot be parsed, or no typed or queued message is measured in the window, start logs that provenance is unmeasured and continues. An incomplete scan cannot establish a miss because the missing transcript might contain the ask. Pi and Muse operators have no Claude transcript to check; this decision supplies no fallback for them. A readable Claude transcript from another session does not establish provenance for those operators.

Transcripts and brief snapshots can be changed by a session. Protecting them needs a hook, but ADR-050 Amendment 1 forbids a Claude Code hook. This decision adds no hook and does not close that gap.
