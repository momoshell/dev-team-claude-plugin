# Architecture notes — dev-team-claude-plugin

ADR-style log of architecture decisions and the current architecture doc set. Format: **YYYY-MM-DD** — note. *Why:* reason. [deprecated — supersedes: <prior entry>]

## Entries

- **2026-08-01** — Primary architecture references, in order of what to read for what: `orchestration.md` (core rules injected every session), `references/*.md` (on-demand deep dives: tier-3 planning, QA gate, memory, handover-spec), `handover-spec.md` (the spec contract's field definitions), `RECREATION-SPEC.md` (the full from-scratch recreation spec — largest, most complete single doc). *Why:* orients architecture-lead to the doc hierarchy instead of re-deriving it. Source: repo root listing + `references/` dir.
- **2026-08-01** — Active initiative: **cmux execution-mode** — a visible-pane substrate for the plugin, tracked as epic issue #15 with sub-issues #1–14 and 6 milestones, design record in the epic's comments. Tracked via the Projects board "Agent Orchestration" (project 3) — see `config.md` § task_source. Next step per prior planning: a Phase-0 spike session (cmux not yet installed as of this onboarding). *Why:* this is the dominant thread of upcoming work — architecture-lead should treat new tasks in this area as sub-steps of the epic, not standalone.
