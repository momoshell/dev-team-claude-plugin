// FULL CHAIN for the bare `--suite` defect, one runnable file.
// argv shape taken from skills/crew-dispatch/references/flags.md:42, whose
// canonical dispatch line ENDS in `--suite "npm test"`.
const R = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/'
const { assertUsage } = await import(R + 'crew.mjs')
const { parseArgs } = await import(R + 'factoryctl.mjs') // byte-identical to crew.mjs:2127-2137
import { spawnSync } from 'node:child_process'
const ioRun = (cmd) => { const r = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' }); return { ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}` } } // seat-io.mjs:1799-1806

for (const [label, argv] of [
  ['GOOD  --suite "npm test"', ['--task', 't', '--brief-file', 'b.md', '--suite', 'npm test']],
  ['BAD   --suite (last token)', ['--task', 't', '--brief-file', 'b.md', '--suite']],
  ['BAD   --suite --keep', ['--task', 't', '--brief-file', 'b.md', '--suite', '--keep']],
  ['BAD   --suite $EMPTY unquoted', ['--task', 't', '--brief-file', 'b.md', '--suite', '--plan-rounds', '1']],
]) {
  const a = parseArgs(argv)
  let usage = 'ACCEPTED'
  try { assertUsage('run', a) } catch (e) { usage = 'REFUSED: ' + e.message.slice(0, 40) }
  const ctxSuite = a.suite || 'node --test --test-timeout=30000' // crew.mjs:1798
  const res = ioRun(ctxSuite)                                     // drive.mjs:3226
  console.log(label.padEnd(30), 'usage=' + usage.padEnd(10), 'ctx.suite=' + JSON.stringify(ctxSuite).slice(0, 34).padEnd(36), 'suite green? ' + res.ok)
}
