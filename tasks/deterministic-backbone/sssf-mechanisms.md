# Context digest: sssf (disler/super-simple-software-factory) mechanisms to port

Source: full firsthand read of the repo clone (branch main, `.claude/skills/sssf/templates/adws/`), 2026-08-03. ~1,500 lines Python total. We port the *invariants and protocol* to Node/.mjs, not the code. Reference clone: `/private/tmp/claude-501/-Users-x-Development-dev-team-claude-plugin/b371ea22-e0d9-4cd7-9d5d-24b7532178d0/scratchpad/sssf/`.

## Architecture in one paragraph

Deterministic scripts ("chains") own sequencing; agents are bounded nodes. A chain is a flat sequence of `run.phase(...)` context-manager blocks of three kinds: `engineer` (capture the ask), `agent` (one agent call → typed envelope), `code` (deterministic subprocess: tests, git commits, diff capture). All state lives per-run under `sessions/<id>/` (files) mirrored into one WAL SQLite db (observability only). Chains are invocable in segments: `ensure(cfg, id)` joins an existing run — phase seq continues, agent sessions resume — so an external judgment authority (our orchestrator) can sit *between* chain segments.

## The invariants (these are the product)

1. **Success must be earned.** Every phase record defaults to `status: "fail"`; only a clean context-manager exit flips it. An exception path records the failure, finalizes the trace, and re-raises.
2. **Phase status ≠ run acceptance.** `run.finish(accepted, reason)` — a test phase that ran a red suite *succeeded as a phase*; the run is only accepted if every phase passed AND the chain's own acceptance predicate holds. One call settles db status + console banner + exit code atomically (their docstring documents the real bug where a `succeeded` property let the three disagree).
3. **Typed envelopes at every boundary.** Every agent call declares `output_type` (subclass of `EnvelopeBase {status, summary, artifacts[], notes_for_next_agent}`). Subtypes: `PlanOutput{commit_message}`, `BuildOutput{changed_files, commit_message}`, `ScoutOutput{findings[{file,note}]}`, `ReviewOutput{approved, findings[{requirement,met,evidence}], blocking[]}`, `DocumentOutput`, `VerifyOutput{passed, failures[]}` (the adapter for deterministic results), `ChangesOutput` (diff as envelope). **Deterministic results are adapted into the same envelope shape** (`quality.as_envelope`, `changes.as_envelope`) so a consuming agent cannot tell code output from agent output.
4. **Correction-not-respawn.** Malformed final JSON → up to 2 corrections re-sent into the SAME agent session (list of required fields, "no prose, no fences"). Gate violations → correction with the violations list, bounded by `PhaseParams.retries`. Session id is create-or-continue; model drift invalidates resume (fresh session instead of a bad resume).
5. **Gates verify claims, return evidence.** `gate(envelope, run) -> GateReport`; a report is per-check `{item, ok, note}` — note is evidence on pass ("exists, 2.1KB") and reason on fail. Violations derived from failed checks. Library: `artifacts_exist`, `files_non_empty`, `json_parses`, `diff_matches_claims` (claimed changed files exist), `verdict_consistent` (approved⊥blocking, approved⊥unmet-findings, rejection-names-a-problem — refutable without reading the diff), `tests_pass(cmd)` factory.
6. **Write boundaries enforced after the fact** (`permissions.py`, ~180 lines, pure git — directly portable): `snapshot()` = `git diff HEAD --numstat` fingerprints + untracked list, taken before the agent's FIRST send (one baseline covers all retries). `enforce()` compares change-SETS after: appeared/vanished/changed all count — **a reversion is a modification** (real incident: builder ran `git checkout adws/`, discarding the quality check about to judge it). Breach ≠ gate violation: cannot be corrected by re-prompting; rolls back only agent-introduced changes (pre-existing dirty files left alone; if the agent reverted one, loudly reported as unrestorable), then aborts the phase naming every path. Glob semantics: `*` stops at `/`, `**` crosses, trailing `/` = prefix. `protected_files` default = the factory's own machinery ("an agent must not edit the thing that judges it"). `always_writable` = the session runtime dir, granted in code not via gitignore.
7. **Known commands are code** (`quality.py`): argv list (never shell string), bare binary names resolved via `operator_env()` (strips uv's ephemeral venv from PATH so children see the engineer's real toolchain — same bug class exists for any launcher), timeout → exit 124, missing binary → 127 with real message (no preflight probe). Full log written to an artifact file; last 4,000 chars ride in the envelope as `output_tail`, deliberately unparsed ("a generic parser would be confidently wrong"). `run_quality` collects ALL failures in one pass; **a failing block does not fail the phase** — the runner did its job, the code failed; the result goes to the builder's repair loop.
8. **Audit-before-execute.** The exact rendered system/user prompts are saved to disk BEFORE the agent runs. Envelopes persisted per attempt, invalid ones with raw tail.
9. **Killability + honest traces** (`session.py`): the chain process registers its own pid in a `processes` table before any phase opens; SIGTERM/SIGINT handlers convert to SystemExit so a killed run finalizes its own trace (no eternal "running").
10. **Construction-time metadata lint.** `PhaseParams.description` is pydantic-validated: empty or name-restating descriptions rejected before the run starts — the description is the only intent the trace shows.
11. **Segment join** (`session.ensure(cfg, adw_id)` + `agent_map.json` + `tracer.max_phase_seq`): rejoin a run by id — phase numbering continues, per-agent session ids (with model recorded) resume warm contexts across separately-invoked chain scripts. This is the mechanism that lets an orchestrator own judgment between code-owned segments.
12. **Pinned-baseline diff capture** (`changes.py` via `ChangeCapture`/`BaseRef`): baseline sha pinned at run start (the run moves the branch); `BaseRef.reason` records WHY that base was chosen so the trace never leaves you guessing.
13. **Per-phase commits in the author's words:** plan committed before code exists; code committed only after green suite + approved review + retest-if-revised (a revision after the last green suite makes the green light stale — chains track `revised` and re-run); each commit message comes from that agent's own `commit_message` field.
14. **Fail-fast config validation** (`agents.validate`): every required agent name must resolve, prompts must exist, model must resolve — before anything spawns.

## Chain script shape (the template for our segments)

A chain is 40–180 lines: load config → validate roster → `session.ensure` → sequence of `with run.phase(PhaseParams(name, kind, owner, description, retries)) as ph:` blocks → bounded loops in plain Python (`MAX_FIX_LOOPS=3` test/fix, `MAX_REVISION_LOOPS=2` review/revise) → `run.finish(accepted=verified, reason=...)`. CLI: `<script> "<prompt>" [--adw-id X]`.

## What sssf deliberately lacks (we must add)

- Strictly serial top level; no parallel fan-out (our scouts / cmux lanes need concurrency).
- No task source (CLI prompt only; ours is GitHub issues).
- Single working tree — concurrent runs mutually destructive (ours: task-scoped workspaces per the cmux design).
- claude_code transport unimplemented — but `agent_cc.py`'s stub names it: `claude -p --output-format stream-json --resume <session_id>`.
- Single-tier review; no escalation ladder (ours: standard/deep reviewer split per qa-gate.md).
- No cross-run memory (ours: team memory, orchestrator-only writes).
- Shipped quality commands are placeholder echoes ("until you wire this, your test phase is theater").

## Node mapping decisions already ratified by the user

- .mjs on the existing repo stack; envelopes validated with ajv against the repo's existing JSON Schemas (coder-return.schema.json, handover-spec.schema.json) — schemas stay language-neutral contract artifacts; zod only for ad-hoc internal shapes.
- Ledger via stdlib `node:sqlite` (no native deps in a plugin).
- Transport: cmux pane kickoff over the socket (primary, per epic #15 design), `claude -p --output-format stream-json --resume` for headless/fallback contexts — subject to the epic's "no silent Agent-tool fallback" invariant (preflight failure = remediation message).
- Orchestrator = judgment node between chain segments + user interface + acceptance authority + sole memory writer. Judgment envelopes may be gated (refuted for inconsistency) but never resolved by code.
- `protected_files` equivalent must cover: the chain runner itself, the gates, hooks, AND team-memory files.
