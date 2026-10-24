# Plan: the lean runtime (ADR-052)

The goal: agents do the hard work, and code only keeps the harness correct. Sessions and subagents point a
lane in the right direction and hand it its first context; the planner, builder and reviewer seats do the
lane work with their skills. The core runtime goes from 92,321 lines to at most 10,000.

Decision record: `docs/adr/adr-052-agents-do-the-work.md`. Every test file and its fate:
`docs/plan-lean-runtime-tests.md`. Source figures measured at `416ddb2a`, test figures at `a73ab2ad`.

## Operator decisions (2026-10-24)

| Id | Decision |
|---|---|
| D1 | No cmux panes. They were an early crutch. Every seat session stays fully inspectable through its recorded session file. |
| D2 | ACP is the one seat transport on the new path (ADR-036). The bespoke headless transports and the daemon are not carried over. |
| D3 | Keep the three tiers: `mechanical`, `build`, `judge`. |
| D4 | The ledger is replaced by the lane journal at the switch. |
| D5 | Keep advisor, edit assist, codemode, lab, readgate, stepped execution, the finish shape and memory, and the pi extensions builderloop, reminders, skeletonread, subagent and fff. Each is decided in a later phase. |
| D6 | Lane b1354 finished: PR #1968 merged, issue #1961 closed. Its `crew/roster-validate.mjs` validates agent frontmatter in phase 2. |
| D7 | Build the new path beside the old one, then switch. |
| D8 | Work stays in this repository. No other project (the-power included) is touched. |
| D9 | No gates or measurements while working: no host-load gate, no dispatch-time baseline, no timing yardstick, no lane-count comparison before the switch. The operator switches when satisfied. The lane's correctness checks (acceptance gate, kill-mutations, suite, commit on green) stay. |

## Target shape

```
source (issue | operator command)
  -> operator session or brief-writer subagent, skill lane-brief      writes brief.md (P1)
  -> crew start brief.md                                               worktree + journal + boot
  -> planner   (crew/agents/planner.md)   explores, writes plan + gate      envelope P2
  -> gate baseline must be red                                         code
  -> builder   (crew/agents/builder.md)   edits the repo                    envelope P2
  -> gate must be green, kill-mutations must kill                      code
  -> reviewer  (crew/agents/reviewer.md)  verdict + findings                envelope P2
  -> full suite green -> commit -> PR                                  code
  lead (crew/agents/lead.md) answers escalations with one closed decision
  every seat: ACP session, full update stream saved (P4), readable with crew show
```

Core code surface:

| Piece | Job | Budget |
|---|---|---|
| `crew start` | read brief, create worktree, write journal header, boot seats from `crew/agents/*.md` | 300 lines |
| `crew/agents.mjs` | parse and validate P5 frontmatter, resolve tiers, run `bootRefusals` | 400 |
| `crew/protocols.mjs` | P1 and P2 schemas and validators, closed reason enums | 400 |
| `crew/loop.mjs` | the loop, the `stepped` and `finish` shapes, bounded rounds, lead consults, journal rows | 1,800 |
| `crew/checks.mjs` | gate red/green, mutation kill, suite run with timeout and process-group kill, commit, rebase, PR | 1,200 |
| `crew/acp/` | the ACP client (from `acp-client.mjs`, `acp-io.mjs`, `acp-permission.mjs`), claude and pi launch, session file writer | 1,200 |
| `crew/skills-proof.mjs` | prove `requires` skills loaded before the first write, from the session file | 200 |
| `crew/closeout.mjs` | teardown, reap orphans, archive the journal | 400 |
| `crew/status.mjs` | `crew status` (lane state) and `crew show <lane> [seat]` (full session) | 400 |

About 6,300 lines. The kept arms are counted separately until each is decided: the pi extensions
(6,758 lines), `crew/mcp/lab-server.mjs`, `crew/memory*.mjs`, and the advisor, edit assist and codemode wiring
ported into `loop.mjs` and the ACP launch.

## Inventory: what happens to each module

K = keep and slim into a core piece. A = kept arm, carried over unchanged. S = replaced; deleted at the switch.

### crew/

| Module | Lines | Fate | Into / why |
|---|---|---|---|
| `drive.mjs` | 17,902 | S | `loop.mjs` + `checks.mjs`; plan growth, carve, exemplars, coverage re-ask, adversary triggers, narration and scope gate go to the planner and reviewer skills; stepped and finish shapes are ported |
| `crew.mjs` | 5,420 | S | `crew start` + `agents.mjs`; codemode and edit-assist wiring ported |
| `seat-io.mjs` | 4,453 | S | the ACP seat path moves to `crew/acp/`; turn ceilings and suite-policy stamping dropped |
| `headless.mjs` (claude), `headless-rpc.mjs` (pi) | 4,961 | S | D2 |
| `drive-fixtures.mjs` | 2,232 | S | goes with `drive.mjs` |
| `daemon.mjs`, `factoryctl.mjs`, `child.mjs` | 3,234 | S | D2; a lane is one detached `crew` process |
| `driver.mjs` (cmux panes) | 805 | S | D1 |
| `acp-client.mjs`, `acp-io.mjs`, `acp-permission.mjs`, `pi/acp-bridge.mjs`, `pi/extensions/acp-server.ts` | 1,422 | K | `crew/acp/` |
| `pi/extensions/submit.ts` | 118 | K | the pi seat's envelope tool (P2) |
| `reclaim.mjs` | 1,347 | K | slim into `closeout.mjs` |
| `adapters/adapter-claude.mjs`, `adapters/adapter-pi.mjs` | 1,124 | K | the ACP launch half moves to `crew/acp/` |
| `capabilities.mjs` (+ `.json`, schema) | 963 | S | frontmatter `skills`, `tools`, `extensions` |
| `arms.mjs`, `harvest.mjs`, `screener.mjs`, `breaker.mjs` | 1,627 | S | experiment rotation and policy machinery (D9); the advisor itself is a frontmatter field |
| `roster.mjs`, `roster-refresh.mjs` | 797 | S | frontmatter; model refresh becomes a skill |
| `roster-validate.mjs` | 60 | K | `agents.mjs` |
| `batch.mjs`, `batch-report.mjs` | 740 | S | standalone batch executor, not on the lane path |
| `census-exhibits.mjs`, `js-tokens.mjs`, `gate-lint.mjs` | 686 | S | pin machinery |
| `escalation-policy.mjs`, `lane-red.mjs`, `converge.mjs` | 920 | S | lead charter + one closed decision enum in `protocols.mjs` |
| `shape-validator.mjs`, `envelope-repair.mjs`, `json-leaf.mjs` | 534 | K | `protocols.mjs` |
| `tree-fingerprint.mjs`, `runner-classify.mjs`, `guidelines/gate-kit.mjs` | 338 | K | `checks.mjs`; gate kit stays for planners |
| `workflows.mjs`, `variants.mjs`, `assurances.mjs`, `task-profiles.mjs`, `run-configuration.mjs` | 773 | S | one loop, P1 `tier` and `shape`, frontmatter `tiers` |
| `host-load.mjs` | 160 | S | D9; switched off in phase 0 |
| `protected-paths.mjs`, `limits.mjs`, `slug.mjs` | 196 | K | `agents.mjs` and callers |
| `fence-scope.mjs`, `prompt-claim.mjs`, `provenance.mjs`, `cache-prune.mjs` | 312 | S | nothing on the new path calls them |
| `memory.mjs`, `memory-md.mjs`, `mcp/lab-server.mjs` | 567 | A | D5 |
| `pi/extensions/` lab, readgate, builderloop, reminders, advisor, skeletonread, subagent | 6,758 | A | D5 |

### scripts/factory/

| Module | Lines | Fate | Into / why |
|---|---|---|---|
| `ledger.mjs` | 10,572 | S | D4: the journal; the visualizer is re-pointed first |
| `dispatch-batch.mjs` | 5,436 | S | `crew start` + `lane-brief` skill |
| `make-brief.mjs` | 4,154 | S | the compile step ADR-052 removes |
| `probe-repo.mjs` | 2,520 | S | an `onboard` agent and skill writing a small profile |
| `closeout.mjs` | 2,144 | K | `crew/closeout.mjs` |
| `reap-stale.mjs`, `lane-watch.mjs`, `crew-watch.mjs` | 2,013 | S | `closeout.mjs` and `status.mjs` |
| `emit.mjs` | 1,922 | K | slim into the P4 journal writer |
| `intake.mjs` | 1,869 | S | an intake agent that reads the board with `gh` |
| `prove-mutations.mjs`, `kill-redundancy.mjs` | 2,206 | K | one mutation prover in `checks.mjs` |
| `mutant-census.mjs`, `model-eval.mjs`, `seat-priors.mjs`, `suite-cost.mjs`, `extract-suite-corpus.mjs`, `seams.mjs`, `shape-scan.mjs`, `transcript.mjs`, `skill-reads.mjs`, `escalation-triage.mjs` | 6,443 | S | measurement (D9); analysis by agent over the journal when asked |
| `pr-review.mjs` | 1,115 | S | `/review` starts the reviewer agent with `pr-review` |
| `prose-lint.mjs` | 122 | K | used by the `prose-plain` skill |
| `agent-doctor.mjs`, `lean-debt.mjs`, `absence.mjs` | 518 | S | nothing on the new path calls them |

## Tests

Measured per file in `docs/plan-lean-runtime-tests.md` (179,479 lines, 132 files):

| Fate | Files | Lines | When |
|---|---|---|---|
| Delete at the switch | 72 | 133,240 | with the module each one tests, in the switch PR |
| Delete with the pin machinery | 13 | 6,485 | at the switch: 9 `skills/*` exhibit and anchor suites, `cli-contract`, `test/factory-env.test.mjs`, `test/vacuity.test.mjs`, `crew/gate-lint.test.mjs` |
| Rewrite against the new modules | 3 | 3,787 | while building: `io-contract`, `seat-io-acp`, `reclaim-descendants` cases move to `crew/acp/` and `closeout` tests |
| Keep | 25 | 15,771 | slimmed with their module |
| Keep until the arm is decided | 9 | 8,313 | later phase |
| Visualizer | 10 | 11,883 | re-pointed to journals and frontmatter in phase 4 |

After the switch 35,967 test lines remain from the existing suites (keep, arms, visualizer), from 179,479,
before the new path adds its own. Of the 4,961 cases in the suites that go, 222 name a kept arm; those behaviours get new tests when
the arm is ported into the loop.

New-path tests follow `qa-test-writing`: behaviour only, a kill-mutation per guard, no prose or line pins.

## Skills and agents

New: `crew/agents/lead.md`, `crew/agents/planner.md`, `crew/agents/builder.md`, `crew/agents/reviewer.md`, `crew/agents/tech-lead.md`
(from `crew/roles/*.md`), `agents/brief-writer.md`, and skills `lane-brief` and `plan`.
Kept: `code-less`, `qa-test-writing`, `pr-review`, `prose-plain`, `backend-node`, `frontend-svelte`,
`ui-design`, `ux`. At the switch: `crew-dispatch` is replaced by `lane-brief`; `crew-recovery`, `devops` and
`crew-onboard` shrink to what an operator still does by hand; every `anchors.json` goes.

## Phases

Each phase is one or more PRs. Phases 0 to 3 are built by hand in the operator session with subagents and a
Sol review, because the current factory is what is being replaced. From phase 4, lanes run on the new path.

### Phase 0: stop the bleeding

- [x] 0.1 Host-load gate off by default in `dispatch-batch.mjs`. `~/.crew/dispatch-defaults.sh` is shared
      with other projects and is left alone (D8).
- [x] 0.2 Drop the dispatch-time baseline suite; the driver's own gate baseline already runs.
- [x] 0.3 Ratify ADR-052 (2026-10-24).

### Phase 1: the lean entry (source, brief, planner)

- [x] 1.1 P1 brief schema and validator in `crew/protocols.mjs`.
- [x] 1.2 `lane-brief` skill and `agents/brief-writer.md`: issue or command in, P1 brief out; premises
      checked on main or marked unmeasured; acceptance ids in `(ID)` form.
- [x] 1.3 `crew start <brief.md>`: worktree, journal header, boot on today's driver with the brief as the
      planner's whole input. No compile, no baseline, no warnings pass.
- [x] 1.4 `/dispatch` routes to 1.2 then 1.3.
- Done means: 3 lanes in this repo started from issues reach a PR.

### Phase 2: seats as agent files

- [ ] 2.1 P5 schema and `crew/agents.mjs`, with `bootRefusals` from `roster-validate.mjs` run on every
      edit. `crew start` boots from `crew/agents/*.md`; the old path keeps reading `crew/roster.json`.
- [ ] 2.2 `requires` skill proof from the session file, refused in the envelope check.
- Done means: a roster swap on the new path is one frontmatter edit; one lane per role boots from it.

### Phase 3: ACP seats and the minimal loop

- [ ] 3.1 `crew/acp/`: client, claude and pi launch, a session file per seat (P4). First check: whether
      `claude-agent-acp` loads plugin skills and agent definitions as the headless claude seat does.
- [ ] 3.2 `crew show <lane> [seat]` prints a seat's full session from its file.
- [ ] 3.3 P2 envelope schemas per role in `crew/protocols.mjs`.
- [ ] 3.4 `crew/checks.mjs`: gate red and green, mutation kill, suite with timeout and process-group kill,
      commit, rebase, PR.
- [ ] 3.5 `crew/loop.mjs` behind `crew start --loop lean`, with the `stepped` and `finish` shapes and the
      arm fields (advisor, edit assist, codemode, lab, readgate, memory, extensions) wired from frontmatter.
- [ ] 3.6 Rewrite the 3 tests in the "rewrite" group against `crew/acp/` and `closeout`.
- Done means: a lane runs plan to PR on the new loop over ACP, and each seat's session reads back in full.

### Phase 4: run on the new path

- [ ] 4.1 Lanes in this repo start with `--loop lean`; failures are fixed in the new path, not the old one.
- [ ] 4.2 P4 journal writer from `emit.mjs`, never throws.
- [ ] 4.3 One `closeout.mjs` and one `status.mjs` for the new path.
- [ ] 4.4 Visualizer reads journals and session files instead of the ledger; its roster editor edits
      `crew/agents/*.md`.

### Phase 5: switch and delete

- [ ] 5.1 Operator switches the default to the new path.
- [ ] 5.2 Delete every S module above and the 85 test files filed under "delete at the switch" and "pin
      machinery", in the same PR. Close epic #1964 and issues #1960, #1962 and #1963 as subsumed.
- [ ] 5.3 Skills rewritten per "Skills and agents"; README and `crew/README.md` rewritten; retired ADRs
      marked superseded.
- Done means: `npm test` green; core at or under 10,000 lines.

### Later: the arms

Decide each kept arm (D5) one by one: keep it as a frontmatter field, or delete it with its tests.

## Not measured

- What fraction of first-round plan rejections the compiled brief context prevents. Phase 1's lanes are the
  first lanes to run without it.
- Whether `claude-agent-acp` carries plugin skills, agent definitions and the skill gate hook the way the
  headless claude seat does. Phase 3.1 checks this before anything else is built on it.
- The cause of the 6.5-minute gap between t60l's ready script and its run start.
