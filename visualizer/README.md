# Factory visualizer

The visualizer is a read-only board over lean lanes. Start the zero-dependency
server with `npm run viz:serve` (or pass `--port`, `--host`, `--crew-root`,
`--checkout`), and build the Svelte board with `npm run viz:build`.

Lanes, their events and their seat sessions are read from the lane journals
under `~/.crew` by `server/lean-source.mjs`; the returns and journal sources are
separate read-only filesystem sources. The ledger is no longer read: a lane that
only the ledger knew is not listed (its journal stays in the archive), a
non-lean `/api/events` request answers `degraded: true` with an `absent` reason,
and `/api/health` reports `ledger: { readable: false, absent }`. A value the
server cannot read is `null` with a reason, never a guess or a zero.

Kept routes: `/api/sessions`, `/api/events` (lean lanes), `/api/returns`,
`/api/journal`, `/api/seat-sessions`, `/api/agents` (+ `/api/agents/propose`,
`/api/skills/propose`), `/api/agent-library*`,
`/api/harness-settings`, `/api/skill-library*`, `/api/skill-rules`,
`/api/model-catalog*`, `/api/plugin-write-mode` and `/api/health`.

The server permits persistent model-catalog key writes, agent, harness and skill saves only when its plugin root resolves to a git-bearing location outside the real home `~/.claude/plugins/` tree. Otherwise it reports `installed-plugin-read-only` and refuses those writes. Session-only keys and null key clears remain available, as do propose routes because they do not write files. Edits to an installed, version-pinned plugin copy would be overwritten by the next plugin update.
