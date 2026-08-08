// Fixture: holds the Node event loop open well past any test timeoutMs so
// SIGKILL (via spawnSync's `timeout` option) is what actually ends it,
// exercising the 124 timeout classification path in chain/evidence.mjs.
//
// Guarded behind an explicit 'run' argv so `node --test`'s auto-discovery of
// files under test/fixtures/ doesn't spawn this standalone and hold the
// event loop open for the full 30s on every full-suite run (mirrors
// huge-output.mjs's identical guard). Only test/chain-evidence.test.mjs
// invokes this deliberately, passing 'run'.
if (process.argv[2] !== 'run') {
  process.exit(0)
}

setTimeout(() => {}, 30000)
