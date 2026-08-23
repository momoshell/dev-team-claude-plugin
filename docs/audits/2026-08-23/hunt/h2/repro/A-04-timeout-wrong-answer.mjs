// The sharp edge: with a REAL settled envelope on disk, `wait --timeout-s <non-numeric>`
// never polls it even once and reports still-running (exit 1).
// crew/crew.mjs:2009-2011.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCli } from './run.mjs'
const BASE = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/lensA/fakehome'
const CREW = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/crew.mjs'
const CHECKOUT = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo'
const returns = join(BASE, '.crew', 'repo', 'lensa-task', 'returns')
mkdirSync(returns, { recursive: true })
writeFileSync(join(returns, 'task.json'), JSON.stringify({ status: 'done', summary: 'the run finished green', artifacts: [], details: {} }))
const env = { ...process.env, HOME: BASE }
const { spawn } = await import('node:child_process')
const run = (extra, ms = 8000) => new Promise((res) => {
  const t0 = Date.now(); let out = '', err = ''
  const p = spawn(process.execPath, [CREW, 'wait', '--task', 'lensa-task', '--checkout', CHECKOUT, ...extra], { env })
  p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d)
  const timer = setTimeout(() => p.kill('SIGKILL'), ms)
  p.on('close', (c, s) => { clearTimeout(timer); res({ c, s, out: out.trim(), err: err.trim(), ms: Date.now() - t0 }) })
})
for (const [name, extra] of [['(absent, control)', []], ['--timeout-s 600', ['--timeout-s', '600']], ['--timeout-s abc', ['--timeout-s', 'abc']], ['--timeout-s 8080abc', ['--timeout-s', '8080abc']], ['--timeout-s -1', ['--timeout-s', '-1']], ['--timeout-s 0', ['--timeout-s', '0']]]) {
  const r = await run(extra)
  console.log(name.padEnd(22), 'exit=' + r.c, (r.ms + 'ms').padEnd(7), r.out.slice(0, 110))
}
