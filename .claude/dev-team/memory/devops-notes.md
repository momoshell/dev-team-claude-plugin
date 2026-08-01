# DevOps notes — dev-team-claude-plugin

Domain-local notes for CI/CD, infra, deployment. Format: **YYYY-MM-DD** — note. *Why:* reason. [deprecated — supersedes: <prior entry>]

## Entries

- **2026-08-01** — CI is a single GitHub Actions workflow, `.github/workflows/test.yml`: checkout → Node 20 → `node --test`, on every push and PR. *Why:* orients devops-lead to the entire CI surface — there is no build/deploy pipeline beyond this. Source: `.github/workflows/test.yml`.
- **2026-08-01** — `hooks/hooks.json` wires a `SessionStart` hook that injects `orchestration.md` (+ referenced files) into every session. *Why:* this is the mechanism that makes the plugin's orchestration rules active at all — changes here are high-blast-radius (affects every session, every project with the plugin enabled). Source: `hooks/hooks.json`, README.md.
