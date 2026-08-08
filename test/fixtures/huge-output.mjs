// Fixture: writes >4MB to BOTH stdout and stderr via a bounded loop of
// buffered writes (never one giant string) so chain/evidence.mjs's
// fd-backed runner (shared fd, no pipe, no maxBuffer) is exercised against
// a real large-output process, and the shared-fd interleaving between
// stdout and stderr is exercised too. Exits with a distinctive real code
// so the runner's classification can be asserted against it.
//
// Guarded behind an explicit 'run' argv so `node --test`'s auto-discovery of
// files under test/fixtures/ doesn't spawn this standalone and treat the
// real exit(7) as a failing test. Only test/chain-evidence.test.mjs invokes
// this deliberately, passing 'run'.
if (process.argv[2] !== 'run') {
  process.exit(0)
}

const CHUNK = 'x'.repeat(5 * 1024) // 5KB
const ITERATIONS = 1000 // 5MB total per stream, well over the 4MB floor

for (let i = 0; i < ITERATIONS; i += 1) {
  process.stdout.write(CHUNK)
  process.stderr.write(CHUNK)
}

process.exit(7)
