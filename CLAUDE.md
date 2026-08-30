# CLAUDE.md

Operating instructions for this repo. The doctrine lives in the documents this
file points at; what is written out here is only what a session gets wrong when
it has to rediscover it.

## What this is

`dev-team` — a Claude Code plugin whose subject is a **team runtime**. A
deterministic driver runs the whole task loop (plan → gate-first acceptance →
build → scope gate → validation → review → full suite → commit-on-green), and
agents are consulted only where judgment lives, through closed-enum decision
envelopes. Two transports on one backbone: cmux panes you watch, or headless
workers owned by a daemon.

`README.md` is the map. `crew/README.md` is the full model, verbs, seat
charters and contracts.

## Commands

```bash
npm test              # node --test over **/*.test.mjs — gates every commit
npm run viz:build     # the visualizer must build; it is part of the release gate
npm run viz:serve     # local visualizer, reads .env.local
npm run crew:watch    # lane state
npm run crew:reap     # stale-descendant sweep
```

`npm test` and `npm run viz:build` are the two release gates. Both must pass
before anything lands.

## Rules that are easy to get wrong

**Run this repo's own scripts from the local checkout, never from
`$CLAUDE_PLUGIN_ROOT`.** The installed plugin cache is version-pinned and can
sit dozens of versions behind `main`. This is not hypothetical: a stale cache
once reproduced a false positive that HEAD had already fixed, 31 versions of
skew. Prefer `node scripts/<name>.mjs` from the repo root, and treat any
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

**This plugin ships zero runtime dependencies.** `package.json` has an empty
`dependencies`; the only devDependencies are svelte/vite for the visualizer.
Do not add one. `jq` is not available either — use `node -p` for JSON in
shell recipes.

## Honesty doctrine

This codebase treats measurement as load-bearing, and the rules below are
enforced by tests, not just preferred:

- **Unknown is never a guess and never a zero.** An unmeasured cell carries
  `null` and one closed reason. A null beats a value nobody measured — the
  visualizer says "heartbeat unavailable" rather than inventing one.
- **A guard is vacuous unless proven by mutation.** A gate check without a
  kill-mutation is not evidence.
- **Never report a rate without its denominator.**
- **Instrumentation is never load-bearing.** The emitter facade over the ledger
  never throws into the caller.
- **A blind spot is stated, not omitted.** Tools here print what they could not
  measure and refuse to call that a clear.

## Working on a lane

Lanes are dispatched, not hand-edited. `skills/crew-dispatch/SKILL.md` owns the
procedure; `/dispatch` names it.

- **Fence the tests that ASSERT what the lane changes** (#702). A fence that
  omits the test guarding the changed behaviour is an operator error, and it
  costs the lane a full boot.
- Fences within a batch must be **mutually disjoint**.
- Verify a fence **arrived** in `crew.json` and `journal.jsonl` — not merely
  that it parsed.
- Rebase onto `main` before opening the PR.
- Judge tier only where a protected file forces it.

## Where the doctrine lives

| Looking for | Read |
|---|---|
| The model, verbs, seat charters | `crew/README.md` |
| Cross-cutting conventions | `docs/conventions.md` |
| Architecture decisions | `docs/adr/` (register in `README.md`) |
| Review rubric and findings shape | `skills/pr-review/` |
| Dispatch, fences, tiers, flags | `skills/crew-dispatch/` |
| Lane recovery and closeout | `skills/crew-recovery/` |
| Worktrees, PRs, orphans | `skills/devops/` |
| Test authoring and anchor pinning | `skills/qa-test-writing/` |
| The review *procedure* layer | `.agents/skills/review-procedure/` |

Most of `docs/conventions.md` predates v0.2.0 and describes the **retired**
first-generation runtime. Its header names the entries that are still binding;
read that header before citing anything from it.

## Commit conventions

Conventional-commit subjects (`feat(crew):`, `fix(factory):`, `test(viz):`,
`chore(roster):`, `docs(adr):`). No `; bump x.y.z` suffix — see the versioning
rule above. Do not add a `Co-Authored-By: Claude` trailer.
