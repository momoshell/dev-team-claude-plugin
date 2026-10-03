# Factory visualizer

The visualizer is a read-only runs board over the factory ledger. Start the
zero-dependency server with `npm run viz:serve` (or pass `--ledger-db` and
`--port`), and build the Svelte board with `npm run viz:build`.

Per-run billed token totals aggregate the `agent_sessions` rows rather than
`sessions.billed_*`; money is deliberately not derived because the ledger has
no honest per-token rate. An absent row renders as “predates this measurement”.

The ledger connection is always opened read-only. Archive triage is the sole
write and is kept in a separate `visualizer.db` sidecar, never in the ledger.
The ledger feed is a read-only sqlite source and the swap point for the planned
#80 daemon; the returns source is a separate read-only filesystem source over
`~/.crew`. These sources are intentionally never merged behind one interface.

`POST /api/roster/propose` validates an edit and returns an applyable unified diff; it never writes `crew/roster.json`.
A human ratifies the proposal by applying the diff with `git apply` (or `patch -p1`).

`POST /api/roster/ladder/apply` is the explicit local-control exception. It
revalidates a non-empty seat-change draft and atomically updates only the
configured runtime roster. The change is read by the next newly booted task;
running tasks are unaffected. This route never invokes Git, creates a PR, or
touches a remote repository. Policy failures can be explicitly accepted for a
local experiment with `allow_warnings`; schema, model, adapter, and boot-shape
refusals remain hard blockers. Repository patch composition stays strict.

The server permits local apply and persistent model-catalog key writes only when its plugin root resolves to a git-bearing location outside the real home `~/.claude/plugins/` tree. Otherwise it reports `installed-plugin-read-only` and refuses POST ladder/apply and persistent POST model-catalog/key requests. Session-only keys and null key clears remain available, as do propose, stage, and compose routes because they do not write files. Edits to an installed, version-pinned plugin copy would be overwritten by the next plugin update.
