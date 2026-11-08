# ADR-060: Local roster overrides

**Status:** Proposed, operator decision, issue #2256. Amends ADR-052.

## Context

Agent frontmatter supplies the committed seats. A user who cannot access a
committed model needs a local choice that survives plugin updates.

## Decision

1. Project `<checkout>/.crew/agents.json` takes precedence over personal
   `~/.crew/agents.json`, which takes precedence over plugin frontmatter. Either
   file may be absent. A project may commit its file or leave it untracked.
2. Files contain a partial object keyed by role. Only `agent`, `model`, `effort`,
   `advisor` and `tiers` may be changed. The charter body, `writes`, `skills`,
   `extensions`, `memory` and all other fields stay with the plugin.
3. Named fields replace lower layers. Tier names merge individually: a named
   entry replaces the plugin tier's run fields, while its non-run fields remain.
   Null unseats; an object can seat a tier the plugin unseated. A top-level
   override does not outrank a plugin tier entry, so a planner effort override
   leaves its judge effort at `xhigh`. Unknown roles, fields or tiers and values
   refused by the frontmatter validator stop start before worktree creation.
4. Start records the merged overrides, file hashes and effective run fields for
   every role and tier in the lane spec, even when no override files exist. The
   loop, tier raises and finish use that snapshot, not current override files or
   plugin run defaults. Charter prose and non-run fields remain plugin-owned.
5. The journal records each initial effective seat's agent, model and effort and
   each applied file's path and SHA-256 hash. Tier raises record the new cells.

The availability probe is outside this decision (issue #2257). Note: it has since shipped in `crew/seat-probe.mjs` with `crew onboard --seats`.
