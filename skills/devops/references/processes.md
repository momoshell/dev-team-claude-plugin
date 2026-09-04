# Stray processes and reclaim

Offer a reclaim command; never kill, signal, or reap an unasked process.
Exhibit: `crew/crew.mjs:801-667`.

Boot refuses stale descendants and prints the command for a human to run.
Exhibit: `crew/crew.mjs:801-667`.

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
Exhibit: `crew/crew.mjs:801-667`.

## Stopping a live lane

There is no verb that stops a live lane. `teardown` archives the crew dir and
reclaims the seats, but it leaves the driver process running, so the operator
sequence is teardown, then signal the driver by pid, then confirm the session
reached a terminal row. Measured 2026-09-02 stopping `b389-mutanchor`.

Do not expect SIGTERM to stop a driver. `run` arms SIGTERM and SIGINT handlers
for the exit marker, and an armed handler suppresses the signal's default
disposition while being unable to dispatch inside a synchronous nap, so the
driver absorbs the signal and keeps driving.
Exhibit: `crew/crew.mjs:1987`.

The driver's waits are synchronous blocks, which is the window that swallows a
signal.
Exhibit: `crew/drive.mjs:5720`.

The signalled exit codes the marker reports are 143 and 130, so an absorbed
signal is visible as neither.
Exhibit: `crew/crew.mjs:1953`.

A teardown sweep over a headless crew proves nothing about the driver and says
so; read its withheld claim rather than treating teardown as a stop.
Exhibit: `crew/crew.mjs:2771`.

A SIGKILLed driver lands no terminal row, because the ledger's finalizer is the
only writer that can and it is opt-in.
Exhibit: `scripts/factory/ledger.mjs:5370`.

The finalizer that a graceful stop would reach records `fail`/`failed` with the
signal as its reason.
Exhibit: `scripts/factory/ledger.mjs:5396`.

An operator who stops a run by hand settles the session as `operator`, which is
already a terminal actor; a session left `running` is a measured-looking claim
that a dead driver is working.
Exhibit: `scripts/factory/ledger.mjs:146`.

The cost of skipping the terminal row is a session that reads `running`
forever: two were found in the live ledger, one of them 4.4 days old (#877).
