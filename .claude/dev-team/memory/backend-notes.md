# Backend notes — dev-team-claude-plugin

Domain-local notes for backend/logic work. Format: **YYYY-MM-DD** — note. *Why:* reason. [deprecated — supersedes: <prior entry>]

## Entries

- **2026-08-01** — The plugin's "backend" is `agents/*.md` (agent definitions), `commands/*.md` (slash commands), and `scripts/*.{mjs,sh}` (runtime tooling: `trello.sh`, `spec-lint.mjs`, `task-cost.mjs`, `pr-review-window.sh`, `team-build.workflow.mjs`). *Why:* orients a lead unfamiliar with a plugin-repo layout vs. a typical app backend. Source: repo root listing.
- **2026-08-01** — `scripts/trello.sh` resolves credentials internally (env → macOS Keychain → credentials file) and must never print them to stdout/stderr. *Why:* credentials must not leak into the session transcript. Source: `scripts/trello.sh`, README.md § Trello.
