// Proof that `--roles ""` silently seats DEFAULT_ROLES (4 seats), not a refusal.
// crew/crew.mjs:1495-1497:  roles = (args.roles ? args.roles.split(',') : [...DEFAULT_ROLES]).map(...)
// The discriminator: --headless-rpc reviewer refuses only when `reviewer` is NOT seated.
import { spawn } from 'node:child_process'
const CREW = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/crew.mjs'
const CO = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo'
const HOME = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/lensA/fakehome'
const env = { ...process.env, HOME, CREW_LOAD_THRESHOLD: '0.0000001' }
const run = (extra) => new Promise((res) => {
  let out = '', err = ''
  const p = spawn(process.execPath, [CREW, 'boot', '--task', 'lensa-probe', '--checkout', CO, ...extra], { env })
  p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d)
  const t = setTimeout(() => p.kill('SIGKILL'), 15000)
  p.on('close', (c) => { clearTimeout(t); res({ c, line: (err || out || '(silent)').split('\n')[0] }) })
})
for (const [n, e] of [
  ['--roles lead        --headless-rpc reviewer', ['--roles', 'lead', '--headless-rpc', 'reviewer']],
  ['--roles ""          --headless-rpc reviewer', ['--roles', '', '--headless-rpc', 'reviewer']],
  ['--roles ""          --headless-rpc tech-lead', ['--roles', '', '--headless-rpc', 'tech-lead']],
]) console.log(n.padEnd(46), (await run(e)).line.slice(0, 110))
