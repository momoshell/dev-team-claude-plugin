# Conventions — dev-team-claude-plugin

Cross-cutting conventions and decisions. The orchestrator is the sole writer — leads only propose deltas. Mark superseded entries `deprecated` (`supersedes: <entry>`) rather than deleting them.

## Format

- **YYYY-MM-DD** — decision/convention. *Why:* reason. [deprecated — supersedes: <prior entry>]

## Entries

- **2026-08-01** — Every functional commit bumps the `version` field in `.claude-plugin/plugin.json` and the commit message ends with `; bump 0.<major>.<minor>`. *Why:* a directory-marketplace install caches the plugin at a version-pinned path (`~/.claude/plugins/cache/dev-team/dev-team/<version>/`) and `plugin update` no-ops while the version is unchanged — an unbumped version means the fix never reaches installed copies. Source: `.claude-plugin/plugin.json` + observed git history (e.g. commit `f7b6cef`).
- **2026-08-01** — No lint or typecheck tooling exists (no `tsconfig.json`, no eslint config) — the repo is plain JS (Node `--test`) + Markdown. *Why:* the plugin ships agent/command definitions as Markdown and a handful of `.mjs` scripts; there's no compiled/typed surface to check. Source: repo root listing.
- **2026-08-01** — Test suite (`node --test`) runs the full 87-test suite in under 1 second. *Why:* means `validate.fast` and `validate.full` are identical here — no separate slow/fast split is needed. Source: timed run at onboarding.
- **2026-08-01** — This repo is the dev-team plugin's own source; `/dev-team:onboard`/`next`/`ship` run here manage the plugin's own development. *Why:* affects how leads should read structural references — `agents/`, `commands/`, `references/` etc. are the plugin's *product*, not consumer app code.
