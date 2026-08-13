# Factory visualizer

The visualizer is a read-only runs board over the factory ledger. Start the
zero-dependency server with `npm run viz:serve` (or pass `--ledger-db` and
`--port`), and build the Svelte board with `npm run viz:build`.

The ledger connection is always opened read-only. Archive triage is the sole
write and is kept in a separate `visualizer.db` sidecar, never in the ledger.
The feed interface is the swap point for the planned #80 daemon.
