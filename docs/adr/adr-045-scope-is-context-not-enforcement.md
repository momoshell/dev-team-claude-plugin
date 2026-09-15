# ADR-045 — Scope is context, not enforcement: a lane may write any file

**Status:** ratified 2026-09-15 (operator decision) · **Owner:** operator · **Partly supersedes:** ADR-043 "What stays"

## Decision

**A lane's file scope — the request's `where` and `creates`, the dispatcher's fence, and the plan's
`files_in_scope` — tells the seats what to read and what the change is about. It never refuses a write.**
Git worktrees already isolate every lane (ADR-043); collision is settled at `rebase` and at merge. A
builder may edit any file its change needs, including a test or an inventory the plan did not name, and
the gate, review, mutation proof and full suite decide whether the result is right.

Retired, as refusals:

- **The scope gate's out-of-scope write refusal.** An edit outside `files_in_scope` is recorded, never
  escalated.
- **The plan scope lock.** `PLAN_SCOPE` widened/narrowed verdicts no longer refuse or cap a plan;
  `PLAN_SCOPE_WIDEN_MAX` and its refusals go. A plan may name any files; a later round may touch more.
- **Scope admission as a gate.** Suite-red and seat-request admission, `held` and sibling-fence refusals
  and the widening limits stop deciding whether a lane may continue. A suite red bounces the builder on
  its own budget; there is nothing to admit.
- **The dispatcher's pre-dispatch file refusals.** `missing-path`, `creates-parent-missing`,
  `coupled-source-unfenced`, `reads-unresolved`, `stale-read-ack`, `scope-entry-invalid`, and the fence
  arrival checks (`fence-not-arrived`, `fence-count-mismatch`, `fence-register-mismatch`) stop blocking a
  dispatch. Their findings may still be reported as brief context or warnings.

## Grounds, measured

- Of **109** escalated lanes on disk on 2026-09-15, **30** were stopped by a file rule: 13 fence or
  sibling crossings, 10 out-of-scope edits at the scope gate, 10 admission, seat-request or held refusals,
  2 widened or malformed plan scopes (reason-text classification; the classes overlap).
- On 2026-09-15 alone, b763 (#1290) and b771 (#1286) each spent every build round because their plans
  dropped a fenced inventory file and scope could not widen after acceptance; b773 was refused twice
  before dispatch (`reads-unresolved`, then `brief-too-large`), b742 once (`creates-parent-missing`).
- None of those refusals protected another lane: each lane runs in its own worktree (ADR-043), and every
  change still passes gate, review, mutation proof, the full suite and the cold suite before it publishes.

## What stays

- **The protected floor.** Touching a protected path still forces the stronger assurance tier and a
  kill-mutation on the changed behaviour. That buys review strength on the files that run the factory; it
  is not a rule about where a lane may write.
- **Writes-none shapes stay write-free.** `scout`, `review_only` and `verify_only` keep their zero-write
  proof — that is the shape's contract, not a scope rule.
- **Mutation anchor binding** stays where it runs today: an unbound anchor is a proof problem.
- **Tests that pin derived values** — reach census, vacuity digests, anchor manifests, recorded reports —
  stay tests. When one pins a value that goes stale, fix the pin (as #1327 and #1330 did); do not
  suppress the test.
- **`brief-too-large`** stays: it bounds a seat's context, not its writes.
- **Scope as brief context** stays: `where`, `creates` and test-reach discovery still decide what the
  planner and builder are told to read.

## Consequences

- Two lanes implement this: a driver lane (scope-gate refusal, plan scope lock, admission gates) and a
  dispatcher lane (pre-dispatch file refusals). Both touch the protected floor, so both run at the
  stronger tier.
- Code that cites ADR-043's "What stays" for the scope gate, admission or those dispatcher refusals now
  cites this ADR.
- Recording stays: out-of-scope edits, what was touched, and why remain journaled and visible, so the
  change is measurable after the fact.

## Reverses if

A lane's out-of-scope write reaches `main` and breaks something the gate, review, mutation proof, full
suite and cold suite all passed — measured, not predicted. Then the narrowest guard that would have caught
that case returns, with its kill-mutation.

## Supersedes

ADR-043 "What stays": the scope gate's refusal, test-reach/anchor-pin/census *admission as a gate*, and
`coupled-source-unfenced`, `stale-read-ack` and `missing-path` as dispatch refusals. ADR-043's decision
(worktrees are the isolation; a fence is never a lock) stands and is the ground for this one.
