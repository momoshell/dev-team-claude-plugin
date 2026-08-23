// `--suite` and `--keep` on `crew.mjs run`.
//  crew/crew.mjs:1798  suite: args.suite || 'node --test --test-timeout=30000'
//  crew/crew.mjs:1886  if (result.status === 'done' && !args.keep) { ...teardown... }
//  drive.mjs:3225-3228 stage('suite'); const suiteRes = io.run(ctx.suite); if (!suiteRes.ok) escalate(...)
//  seat-io.mjs:1799-1806 run(cmd) { spawnSync('/bin/sh', ['-c', cmd], ...); return { ok: res.status === 0, output } }
import { spawnSync } from 'node:child_process'
// EXACT copy of crew/seat-io.mjs:1799-1806
const run = (cmd) => {
  const res = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' })
  let output = `${res.stdout || ''}${res.stderr || ''}`
  if (res.error) output += `\n[spawn error: ${res.error.message}]`
  return { ok: res.status === 0, output }
}
console.log('assertUsage admits bare `--suite` -> value true (05-assertusage.mjs).')
for (const cmd of [true, false, '', 'echo ok', 'exit 7']) {
  console.log('io.run(' + JSON.stringify(cmd) + ')'.padEnd(4), '->', JSON.stringify(run(cmd)))
}
console.log('\n--keep truthiness (crew.mjs:1886 `!args.keep`):')
for (const v of [undefined, true, 'false', '0', '', 'no'])
  console.log('  --keep', String(JSON.stringify(v)).padEnd(10), '-> auto-teardown runs?', !v)
