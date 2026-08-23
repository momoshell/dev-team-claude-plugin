# Lane branches are not publishing surfaces

Never run `git push origin --delete` on a lane branch while its PR is open.
Status: the open-PR deletion rule is unbacked here; register it in `evidence.md`.

That deletion can close the live PR; the platform behavior is marked unbacked
in `evidence.md`, rather than presented as a local source fact.
Status: no checkout exhibit proves the platform close behavior.

Preserve the open review until its outcome and teardown policy are decided.
Status: this preservation rule is unbacked here; see `evidence.md`.

Never publish from a worker path.
Exhibit: `scripts/factory/ci-watch.mjs:265`.

The worker-path gate runs before branch resolution or construction of push argv.
Exhibit: `scripts/factory/ci-watch.mjs:265`.

The linked-worktree probe compares the two Git directory locations.
Exhibit: `scripts/factory/ci-watch.mjs:240`.

A checkout under the crew root is also treated as a worker path.
Exhibit: `scripts/factory/ci-watch.mjs:246`.

A missing checkout refuses publication instead of guessing its location.
Exhibit: `scripts/factory/ci-watch.mjs:265`.

An unresolved branch refuses publication instead of pushing a default.
Exhibit: `scripts/factory/ci-watch.mjs:265`.

Keep lane work and host publication as separate lifecycle stages.
Exhibit: `scripts/factory/ci-watch.mjs:265`.

Do not treat a green local test as permission to delete a remote branch.
Status: this deletion safeguard is unbacked here; see `evidence.md`.

Do not treat an absent PR lookup as proof that deletion is harmless.
Status: this absent-lookup safeguard is unbacked here; see `evidence.md`.

An interrupted network request leaves the PR state unknown.
Status: this interrupted-network edge is unbacked here; see `evidence.md`.

An empty branch name is an invalid publication input.
Exhibit: `scripts/factory/ci-watch.mjs:277`.

Use the evidence register when an operational platform behavior lacks a checkout
exhibit.
Register: `skills/devops/references/evidence.md`.

The cost of a premature close is lost review context and an altered PR state.
Status: this platform cost is unbacked here; see `evidence.md`.

The cost of worker-path publishing is a lane writing to the host remote.
Exhibit: `scripts/factory/ci-watch.mjs:265`.

The source exhibit proves the worker refusal; it does not prove GitHub's close
behavior, which remains explicitly unbacked.
Register: `skills/devops/references/evidence.md`.
