# Stray processes and reclaim

Offer a reclaim command; never kill, signal, or reap an unasked process.
Exhibit: `crew/crew.mjs:664-666`.

Boot refuses stale descendants and prints the command for a human to run.
Exhibit: `crew/crew.mjs:664-666`.

The sweep is dry-run by default until `--reclaim` is supplied.
Exhibit: `scripts/factory/reap-stale.mjs:251-254`.

An explicit `--dry-run` wins even when `--reclaim` appears too.
Exhibit: `scripts/factory/reap-stale.mjs:251-254`.

Account for outcomes as `proven`, `failed`, or `unproven`.
Exhibit: `scripts/factory/reap-stale.mjs:75`.

A process that cannot be proven dead remains `unproven`, never assumed dead.
Exhibit: `scripts/factory/reap-stale.mjs:75`.

`guardedKill` refuses absolute pid or pgid values 0 and 1.
Exhibit: `scripts/factory/reap-stale.mjs:58-60`.

The guard applies in both signal directions, including negative group ids.
Exhibit: `scripts/factory/reap-stale.mjs:58-60`.

Archived lanes are swept rather than skipped.
Exhibit: `scripts/factory/reap-stale.mjs:105-107`.

The archived set was the likely leak location (#473).
Exhibit: `scripts/factory/reap-stale.mjs:105-107`.

A missing root is a refusal, not an empty proof of cleanliness.
Exhibit: `scripts/factory/reap-stale.mjs:265`.

Three-state liveness preserves `null` for an unreadable pane.
Exhibit: `crew/README.md:237`.

Treat `null` as unknown; only observed `false` contributes to a dead verdict.
Exhibit: `crew/README.md:237`.

An empty descendant list means no records were found, not that every process
was inspected.
Exhibit: `scripts/factory/reap-stale.mjs:105-107`.

An interrupted or EPERM kill remains an accounting failure or unknown result.
Status: this kill-error edge is unbacked in the checkout; see `evidence.md`.

Keep the destructive flag visible in every human-facing reclaim instruction.
Exhibit: `scripts/factory/reap-stale.mjs:257`.

The cost of collapsing `unproven` into `failed` is an unsafe kill decision.
Exhibit: `scripts/factory/reap-stale.mjs:75`.

The cost of skipping archived directories is a leak hidden by its name.
Exhibit: `scripts/factory/reap-stale.mjs:105-107`.

Never turn an offer into an automatic signal.
Exhibit: `crew/crew.mjs:664-666`.
