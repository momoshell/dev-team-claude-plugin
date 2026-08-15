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

## What's in this repo

- **`crew/`** — the runtime. Self-contained: a cmux driver (verified-send,
  context-aware ops), the deterministic task-loop driver (fully unit-tested
  via dependency injection), the CLI, and the seat charters.
- **`scripts/factory/`** — the run-trace mirror: a never-throwing emitter
  facade over a SQLite WAL ledger (instrumentation is never load-bearing).
- **`docs/`** — the live design record: [`docs/adr/`](docs/adr/) is the
  architecture decision register (**grep it before minting an ADR number**),
  [`docs/conventions.md`](docs/conventions.md) the cross-cutting conventions.
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

## Lineage

The crew synthesizes the strongest idea from three reference patterns —
declarative whole-team boot with a lead in the workspace; "agent proposes,
code disposes" with typed envelopes and testing-as-code; and gate-first
acceptance where the gate is written before the build and must fail red at
baseline — on top of hard-won cmux driving mechanics (build-102 flag
grammar, echo-verified sends, lazy-materialization handling) proven live in
this repo.
