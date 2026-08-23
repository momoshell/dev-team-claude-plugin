// boot-verb flag hostility. CREW_LOAD_THRESHOLD=0.0000001 is a HARD CIRCUIT
// BREAKER: crew/crew.mjs:1531-1537 refuses on a saturated host BEFORE
// resolveAdapters and before any cmux/pathsFor/mkdir call, so nothing here can
// ever create a workspace. HOME is redirected to a scratch dir.
import { spawn } from 'node:child_process'
const CREW = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/crew.mjs'
const CO = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo'
const HOME = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/lensA/fakehome'
const env = { ...process.env, HOME, CREW_LOAD_THRESHOLD: '0.0000001' }
const run = (extra, ms = 15000) => new Promise((res) => {
  let out = '', err = ''
  const p = spawn(process.execPath, [CREW, 'boot', '--task', 'lensa-probe', '--checkout', CO, ...extra], { env })
  p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d)
  const timer = setTimeout(() => p.kill('SIGKILL'), ms)
  p.on('close', (c, s) => { clearTimeout(timer); res({ c, s, out: out.trim(), err: err.trim() }) })
})
const cases = [
  ['CONTROL --roles lead', ['--roles', 'lead']],
  ['--roles "" (empty)', ['--roles', '']],
  ['--roles "" + --headless-rpc tech-lead', ['--roles', '', '--headless-rpc', 'tech-lead']],
  ['--roles lead + --headless-rpc tech-lead', ['--roles', 'lead', '--headless-rpc', 'tech-lead']],
  ['--roles "," ', ['--roles', ',']],
  ['--roles (bare, no value)', ['--roles']],
  ['--roles LEAD (uppercase)', ['--roles', 'LEAD']],
  ['--roles " lead "', ['--roles', ' lead ']],
  ['--tier (bare)', ['--tier']],
  ['--tier BUILD (uppercase)', ['--tier', 'BUILD']],
  ['--tier " build "', ['--tier', ' build ']],
  ['--headless-all somevalue', ['--roles', 'lead', '--headless-all', 'x']],
  ['--headless-all true', ['--roles', 'lead', '--headless-all', 'true']],
  ['--model-buidler opus (typo role)', ['--roles', 'lead,builder', '--model-buidler', 'opus']],
  ['--allow-shortfall-buidler x', ['--roles', 'lead,builder', '--allow-shortfall-buidler', 'subagents']],
  ['--fences without --lane', ['--roles', 'lead', '--fences', '/nope.json']],
  ['--lane without --fences', ['--roles', 'lead', '--lane', 'L']],
  ['--lane "  " with --fences', ['--roles', 'lead', '--fences', '/nope.json', '--lane', '   ']],
  ['repeated --roles lead then tech-lead', ['--roles', 'lead', '--roles', 'tech-lead']],
]
for (const [name, extra] of cases) {
  const r = await run(extra)
  const line = (r.err || r.out || '(silent)').split('\n')[0]
  console.log(('exit=' + r.c).padEnd(8), name.padEnd(42), line.slice(0, 130))
}
