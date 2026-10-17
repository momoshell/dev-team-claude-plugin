# crew

**A team runtime: code disposes, agents decide.**

One task gets a whole team booted in a single declarative call — planner,
builder, reviewer, an optional tech-lead adversary, and a lead that serves as
the judge. A deterministic driver runs the entire task loop (plan → gate-first
acceptance → build → scope gate → validation → review → full suite →
commit-on-green); agents are consulted only where judgment genuinely lives, and
every consultation is a closed-enum decision the code branches on.

**Two modes on one backbone.** On the *shop floor* the team lives in a cmux
workspace you watch. In *factory* mode the same driver runs headless workers
owned by a long-lived daemon, and a stateless client drives it — no terminal,
no human in the loop.

**→ [crew/README.md](crew/README.md)** for the full model, verbs, seat
charters, contracts, and posture.

```bash
# shop floor — a cmux workspace per task
node crew/crew.mjs boot --task my-task --roles lead,planner,builder,reviewer
node crew/crew.mjs run  --task my-task --brief-file /abs/path/brief.md

# factory — no workspace; the daemon boots and owns the workers
node crew/factoryctl.mjs run --brief /abs/path/brief.md --tier build
node crew/factoryctl.mjs ls
```

## Install

```
/plugin marketplace add momoshell/dev-team-claude-plugin
/plugin install dev-team@dev-team
```

This brings the skills and the `/dispatch`, `/close-out`, `/status` and
`/onboard` commands into any project. The install follows `ref: main` in
`.claude-plugin/marketplace.json`, not a tag, so an installed copy tracks the
head of `main`.

There are two ways to use it:

- **Skills only.** Nothing else to set up. The knowledge skills (`pr-review`,
  `qa-test-writing`, `backend-node`, `frontend-svelte`, `ui-design`, `devops`)
  work in any repo. Most repos stop here.
- **The crew runtime.** Lanes need one clone of this repo, node 26 or newer
  (`engines` in `package.json`), and a crew root (`~/.crew`, or
  `DEVTEAM_CREW_ROOT`). Run the runtime from the clone and point it at the
  target with `--checkout`. Headless is the default transport; cmux is needed
  only to watch a lane in panes.

You do not need the operator's pinned worktree or a `crew` launcher on your
PATH (`bin/crew.mjs`). Both are the operator's own setup for running lanes from
a frozen copy. A clone run with `node crew/crew.mjs` is enough.

[`skills/crew-onboard/`](skills/crew-onboard/SKILL.md) covers the rest:
deciding what a target can use, and profiling and ratifying a foreign checkout
before its first lane.

## What's in this repo

- **`crew/`** — the runtime: a cmux driver (verified-send, context-aware ops),
  the deterministic task-loop driver (fully unit-tested via dependency
  injection), the CLI, and the seat charters. Self-contained apart from
  `scripts/factory/`, which it imports from three production modules:
  `crew/breaker.mjs` takes `NODE_FLOOR`/`openLedger` from `ledger.mjs` on the
  boot-refusal path, `crew/child.mjs` takes `emit.mjs` and `probe-repo.mjs`, and
  `crew/crew.mjs` takes `emit.mjs`, `probe-repo.mjs`, `make-brief.mjs` and
  `reap-stale.mjs`.
- **`scripts/factory/`** — the run-trace mirror: a never-throwing emitter
  facade over a SQLite WAL ledger (instrumentation is never load-bearing).
- **`skills/`, `commands/`** — the operating knowledge as Claude Code surfaces.
  The knowledge skills (`pr-review`, `qa-test-writing`, `backend-node`,
  `frontend-svelte`, `ui-design`, `devops`) work in any repo the moment the
  plugin is installed; the runtime skills (`crew-dispatch`, `crew-recovery`)
  drive the crew CLI and need this source tree. `crew-onboard` owns the split
  and the foreign-checkout procedure. Commands are thin entry points that name
  the skill owning each procedure: `/dispatch`, `/close-out`, `/status`,
  `/onboard`.
- **`docs/`** — the live design record: [`docs/adr/`](docs/adr/) is the
  architecture decision register (**grep it before minting an ADR number**);
  [`docs/decisions-needed.md`](docs/decisions-needed.md) is the open
  owner-decision register; [`docs/conventions.md`](docs/conventions.md) the
  cross-cutting conventions.
  [`CLAUDE.md`](CLAUDE.md) is the operating brief a session should read first —
  it carries only the rules that are expensive to rediscover and points at
  everything else.
- **`tasks/`, `.claude/dev-team/`** — historical design records, including the
  retired first-generation runtime (a 14-agent orchestrator/lead/coder
  hierarchy with spec contracts and a review ladder). That system was retired
  in v0.2.0 after the crew proved itself on live tasks; its full source lives
  in git history.

## Versioning

**Bump on release, not per commit.** Earlier history bumped
`.claude-plugin/plugin.json` on essentially every feature commit; with several
crews landing multi-file features in a day, that convention stopped paying for
itself and was missed five times in two days (#137). Feature commits no longer
carry a `; bump x.y.z` subject suffix.

What is enforced instead is the thing that actually shipped wrong metadata:
`plugin.json` and `.claude-plugin/marketplace.json` must always agree.
`test/version-agreement.test.mjs` asserts it, so it fails in the same
`node --test` run that gates every crew commit — bump both files or neither.

## Visualizer

The local factory visualizer reads its Artificial Analysis catalog key from
the process environment. To keep it across restarts without committing it,
copy `.env.example` to `.env.local`, set `ARTIFICIAL_ANALYSIS_API_KEY`, then
start the server normally:

```bash
cp .env.example .env.local
npm run viz:build
npm run viz:serve
```

`.env.local` and other environment files are ignored by Git; `.env.example`
is the only committed template. The roster UI can save or replace this one
variable in `.env.local`, or connect with a temporary key for the current
server process. Clearing a temporary key restores the saved environment key.

## Lineage

The crew synthesizes the strongest idea from three reference patterns —
declarative whole-team boot with a lead in the workspace; "agent proposes,
code disposes" with typed envelopes and testing-as-code; and gate-first
acceptance where the gate is written before the build and must fail red at
baseline — on top of hard-won cmux driving mechanics (build-102 flag
grammar, echo-verified sends, lazy-materialization handling) proven live in
this repo.
