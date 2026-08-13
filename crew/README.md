# crew — a team runtime for cmux

One task, one workspace, one whole team booted in a single declarative call —
driven by deterministic code, with agents kept for judgment.

```
node crew/crew.mjs boot --task my-task --roles lead,planner,builder,reviewer
node crew/crew.mjs run  --task my-task --brief-file /abs/path/brief.md
# ... code drives the loop; watch the workspace, read the pill ...
node crew/crew.mjs status --task my-task          # liveness
node crew/crew.mjs teardown --task my-task        # manual close (run auto-tears-down on done)
```

## The model

**Code disposes, agents decide.** `drive.mjs` owns the mechanical loop:

```
plan -> (tech-lead check when seated) -> gate-baseline(RED required)
     -> build -> scope-gate(git) -> validation lane -> acceptance gate
     -> review -> full suite -> commit-on-green(builder's message)
```

Every loop is bounded (`LIMITS`), every verdict is a closed enum, every bounce
brief is code-composed with failures pasted verbatim, every stage transition
lands in `journal.jsonl` and on the workspace's live `crew-stage` pill.

**The seats** (per-pane Claude sessions, launched as the pane process by the
boot layout — nothing is ever typed into a spawning shell):

| Seat | Charter | Repo writes |
|---|---|---|
| `lead` | the judge: consulted by code only at genuine judgment points, answers with a closed-enum decision envelope | none |
| `planner` | domain lead + architect + scout-commander; envelope carries `files_in_scope`, `validation_lane`, optional `gate_cmd` | none (task dir only) |
| `builder` | the only repo-writing seat; tests are part of building | in-scope files only (git-gated) |
| `reviewer` | conformance to plan, then correctness; also gate-defect triage and perspective duty | none |
| `tech-lead` | optional plan adversary — deliberately a different model/effort | none |

Per-seat models are boot flags (`--model-planner opus --model-builder haiku ...`)
so the crew is sized per task: cheap seats for mechanical work, capable seats
where judgment lives.

## The judgment protocol

- Code consults the **lead** with a decision brief carrying a closed option
  set (`bounce`/`accept`/`escalate` subset). Out-of-set answers escalate;
  a consult limit caps a looping judge.
- **Compounding**: on a first round the lead may answer `second-opinion`
  naming another seat; code gathers that seat's view unseeded (the lead's
  leaning structurally never exists to leak), re-asks once, and records any
  divergence as `dissents` on the task envelope. One binding rule: lead
  `accept` over an advisor's independent `escalate` recommendation escalates
  — compounding may only strengthen outcomes toward safety.
- Escalation ladder: **code → lead → orchestrator/human**, each hop only
  when an enum says so.

## The acceptance gate (gate-first)

The planner may author an executable gate in the TASK DIR (immutable to the
builder by construction): a command exiting 0 iff what-was-asked is
what-got-built. Enforced mechanically: the gate must fail **RED at baseline**
(a green baseline = vacuous acceptance or already-done work → planner
bounced; twice → escalation). Failures feed back verbatim per build round;
repeated failures trigger reviewer triage (`build` vs `gate` defect), and a
gate defect grants the planner exactly one non-weakening repair whose re-run
consumes no builder round.

## Contracts

Everything durable is a FILE; pane chat is never the record.

- **ReturnEnvelope** (every assignment): `{ assignment_id, role, status:
  done|insufficient|blocked, summary, artifacts[], details{...} }` written to
  the return path named in the assignment line.
- **Assignment line**: single line, safe charset, composed by
  `assignmentLine()` — content travels in brief files, the line only points.
- **Task envelope**: written by the driver to `task.json` — status, commit,
  stages, consults, dissents, gate record, escalation.
- **Lifecycle** (code as policy): `done` → archive the crew dir + close the
  workspace (`--keep` to inspect); `escalation` → the workspace always
  survives (it IS the context the human needs).

## Files

- `crew.mjs` — CLI: boot / run / handoff (legacy agent-driven mode) / wait /
  status / teardown, plus `realIo` wiring the driver to cmux + git.
- `drive.mjs` — the deterministic task loop (dependency-injected io; fully
  unit-tested without cmux).
- `driver.mjs` — the cmux layer: verified-send (echo-exactly-once,
  ctrl+u-guarded retype), context-aware ops, `assignmentLine`.
- `roles/*.md` — seat charters, appended as system prompts at boot.
- Tests: `drive.test.mjs` (the loop), `driver.test.mjs` (line composition).

State lives under `~/.crew/<repo>/<task>/` (crew.json, task dir, returns,
journal); archives keep the durable record after teardown.

## Posture

Seats run `--permission-mode bypassPermissions` (nobody is at their panes to
approve), contained by per-seat `--allowedTools`, the feature-branch blast
radius, `DEVTEAM_WORKER=1` anti-recursion, and the operator's global deny
rules. The driver never pushes; PR/push stays with the human's orchestrator.
