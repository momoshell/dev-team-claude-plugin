# Lane branches are not publishing surfaces

Never run `git push origin --delete` on a lane branch while its PR is open.
Status: the open-PR deletion rule is unbacked here; register it in `evidence.md`.

That deletion can close the live PR; the platform behavior is marked unbacked
in `evidence.md`, rather than presented as a local source fact.
Status: no checkout exhibit proves the platform close behavior.

Preserve the open review until its outcome and teardown policy are decided.
Status: this preservation rule is unbacked here; see `evidence.md`.

Never publish from a worker path — except the DRIVER, which publishes from the lane worktree after cold-verify as the last stage before teardown (ADR-034, ratified 2026-08-29 on #679). Every seat is still forbidden.
Status: ratified posture; the driver's publish stage is the implementation (`crew/drive.mjs`, the #679 lane) and `evidence.md` records the ratification.

The worker-path gate runs before branch resolution or construction of push argv.
Status: this ordering rule is unbacked here; see `evidence.md`.

The linked-worktree probe compares the two Git directory locations.
Status: no reachable checkout implementation performs this probe; see `evidence.md`.

A checkout under the crew root is also treated as a worker path.
Status: this crew-root rule is unbacked here; see `evidence.md`.

A missing checkout refuses publication instead of guessing its location.
Status: this fail-closed publication rule is unbacked here; see `evidence.md`.

An unresolved branch refuses publication instead of pushing a default.
Status: this branch-resolution rule is unbacked here; see `evidence.md`.

Keep lane work and host publication as separate lifecycle stages: publication is the run's LAST stage (`rebase → suite → suite:cold → publish`), never interleaved with building, and it ends at an open PR — merge, reap and issue closing belong to the batch closeout (#758).
Status: ratified by ADR-034; see `evidence.md`.

Do not treat a green local test as permission to delete a remote branch.
Status: this deletion safeguard is unbacked here; see `evidence.md`.

Do not treat an absent PR lookup as proof that deletion is harmless.
Status: this absent-lookup safeguard is unbacked here; see `evidence.md`.

An interrupted network request leaves the PR state unknown.
Status: this interrupted-network edge is unbacked here; see `evidence.md`.

An empty branch name is an invalid publication input.
Status: this input-validity rule is unbacked here; see `evidence.md`.

Use the evidence register when an operational platform behavior lacks a checkout
exhibit.
Register: `skills/devops/references/evidence.md`.

The cost of a premature close is lost review context and an altered PR state.
Status: this platform cost is unbacked here; see `evidence.md`.

The cost of worker-path publishing is a lane writing to the host remote.
Status: this publication cost is unbacked here; see `evidence.md`.

No local exhibit proves the worker refusal, and none proves GitHub's close
behavior; both remain explicitly unbacked.
Register: `skills/devops/references/evidence.md`.
