# Task

---
source: operator request (Momo, 2026-10-31: prose audit — docs, manifests, unused visualizer dependencies)
closes: null
tier: judge
shape: standard
acceptance: [DM1, DM2, DM3, DM4, DM5, DM6, DM7]
out_of_scope: crew/agents/, crew/roles/, crew/guidelines/ and skills/ (other lanes); ADR bodies beyond status lines; docs/archive/ and docs/audits/
---
## The ask

Docs and manifests still describe the deleted runtime and dependencies nothing uses. Bring them in line with
the lean runtime (ADR-052) and the tree on main.

- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` descriptions say "interactive cmux panes,
  or headless workers owned by a daemon and driven from factoryctl". Keep the two in step
  (`test/version-agreement.test.mjs` checks versions only).
- `@xyflow/svelte`, `@dagrejs/dagre`, `codemirror`, `@codemirror/lang-json` and `@codemirror/lang-markdown` are
  imported nowhere under `visualizer/`. The operator approved removing them (2026-10-31). Update
  `package.json`, `package-lock.json`, the dependency paragraph in `CLAUDE.md` and the 2026-09-15 entry in
  `docs/conventions.md`.
- `docs/adr/README.md`: the intro cites deleted files (`scripts/factory/emit.mjs`, `crew/drive.mjs`,
  `crew/headless.mjs`); index rows for 029, 035, 040, 042, 044 and 046 say "ratified" while their files say
  superseded by ADR-052; the "Note on scope" calls the ledger ADRs live; ADR-041's file says "proposed" while
  the register says withdrawn.
- `visualizer/README.md` mentions a returns source and its route list omits `/api/prompts/propose`.
- Also fix, where the claim is checkable on main: `docs/conventions.md` header (the NUL entry is dated
  2026-08-02, not 08-03); `crew/README.md` (state lives under `~/.crew/dt-<lane>/<lane>/`; `hooks/skill-gate.mjs`
  is the skill-map selector, not a registered hook; name `LeanWaterfall.svelte`); `CLAUDE.md` (the
  `node scripts/<name>.mjs` line, the duplicated lane-brief rows); `test/fixtures/acp/README.md` and
  `docs/decisions-needed.md` read as current but describe deleted code — mark them historical.

Invariant: a live doc states nothing about files, routes, packages or ADR statuses that main contradicts.

## Context

- `visualizer/server/server.mjs` `ROUTE_PARAMS`: the registered routes.
- ADR status lines are the `**Status:**` line near each file's top.
- CI has no node_modules; the node suite must not import a visualizer dependency.

## Acceptance

- (DM1) neither plugin manifest description names cmux, a daemon or factoryctl
- (DM2) every `devDependencies` entry is imported under `visualizer/` or used by the vite build config
- (DM3) `CLAUDE.md` names no visualizer dependency that `package.json` does not declare
- (DM4) every ADR whose file says superseded is listed as superseded in the register index
- (DM5) ADR-041's status line agrees with its register entry
- (DM6) the ADR register intro cites only files that exist
- (DM7) `visualizer/README.md` lists exactly the routes the server registers
