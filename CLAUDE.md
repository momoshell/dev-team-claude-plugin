# CLAUDE.md

Operating instructions for this repo. The doctrine lives in the documents this
file points at; what is written out here is only what a session gets wrong when
it has to rediscover it.

## What this is

`dev-team` — a Claude Code plugin whose subject is a **team runtime**. One brief
starts a lane (`crew start`): a planner, builder and reviewer, and a lead on
escalation, play their seats over ACP. Code only checks the result — the gate is
red at baseline and green after the build, each check has a kill-mutation, the
full suite is green — then commits and opens the PR (ADR-052). A stopped lane is
finished with `crew finish`.

`README.md` is the map. `crew/README.md` is the full model, verbs, seats and
contracts.

## Commands

```bash
npm test              # node --test over **/*.test.mjs — gates every commit
npm run viz:build     # release-time check: operator runs it on main before tagging
npm run viz:serve     # local visualizer, reads .env.local
crew lanes            # lane state, from the lane journals
```

`npm test` is the lane gate. `npm run viz:build` is a RELEASE-TIME check the
operator runs on main before tagging; it is never a lane's done-means.

## Rules that are easy to get wrong

**Run this repo's own scripts from the local checkout, never from
`$CLAUDE_PLUGIN_ROOT`.** The installed plugin cache is version-pinned and can
sit dozens of versions behind `main`. This is not hypothetical: a stale cache
once reproduced a false positive that HEAD had already fixed, 31 versions of
skew. Prefer `node bin/crew.mjs <verb>` from the repo root, and treat any
finding from a cache-path invocation as unverified until cross-checked against
HEAD. (`docs/conventions.md`, entry 2026-08-08.)

**`.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` must always
agree.** `test/version-agreement.test.mjs` enforces it. Bump both or neither.
Do **not** bump on a feature commit — bump on release. Earlier history bumped
per-commit, and it was missed five times in two days (#137).

**Grep `docs/adr/README.md` before minting an ADR number.** A number is burned
once *proposed*, and the register lists proposed and abandoned numbers for
exactly that reason. Two decisions have collided here before. ADR numbers are
cited from shipped code as the authority for invariants, so a citation that
resolves to nothing is a real defect.

**The runtime ships zero dependencies; the visualizer may take build-time ones.** `package.json` has no
`dependencies` key at all and `crew/acp-client.test.mjs` refuses one: nothing under `crew/` or `scripts/`
may import a package. `devDependencies` exist only for the visualizer, which vite bundles into `dist/`
(`svelte`, `vite`, `@sveltejs/vite-plugin-svelte` and `lucide-svelte` for icons). A visualizer
dependency is still a decision: name it in `docs/conventions.md` with the page that needs it. `jq` is
not available either — use `node -p` for JSON in shell recipes.

## Honesty doctrine

This codebase treats measurement as load-bearing, and the rules below are
enforced by tests, not just preferred:

- **Unknown is never a guess and never a zero.** An unmeasured cell carries
  `null` and one closed reason. A null beats a value nobody measured — the
  visualizer says "heartbeat unavailable" rather than inventing one.
- **A guard is vacuous unless proven by mutation.** A gate check without a
  kill-mutation is not evidence.
- **Never report a rate without its denominator.**
- **Instrumentation is never load-bearing.** Writing the lane journal and the
  session files never throws into the caller.
- **A blind spot is stated, not omitted.** Tools here print what they could not
  measure and refuse to call that a clear.

## Working on a lane

Lanes start from a brief, not from hand edits. `skills/lane-brief/SKILL.md` owns
writing the brief and starting the lane; `/dispatch` names it.

- **Scope is context, not enforcement** (ADR-045). A lane may write any file;
  worktrees isolate lanes and `rebase` resolves them.
- Rebase onto `main` before opening the PR.

## Where the doctrine lives

| Looking for | Read |
|---|---|
| The model, verbs, seat charters | `crew/README.md` |
| Cross-cutting conventions | `docs/conventions.md` |
| Architecture decisions | `docs/adr/` (register in `README.md`) |
| Review rubric and findings shape | `skills/pr-review/` |
| Writing briefs, tiers and starting a lane | `skills/lane-brief/` |
| Lane recovery and closeout | `skills/crew-recovery/` |
| Worktrees, PRs, orphans | `skills/devops/` |
| Test authoring | `skills/qa-test-writing/` |
| The review *procedure* layer | `.agents/skills/review-procedure/` |

Much of `docs/conventions.md` describes runtimes the lean runtime replaced. Its
header names the entries that still bind; read that header before citing
anything from it.

## Commit conventions

Conventional-commit subjects (`feat(crew):`, `fix(factory):`, `test(viz):`,
`chore(roster):`, `docs(adr):`). No `; bump x.y.z` suffix — see the versioning
rule above. Do not add a `Co-Authored-By: Claude` trailer.
