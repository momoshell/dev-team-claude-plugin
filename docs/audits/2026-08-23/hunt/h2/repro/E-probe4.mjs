// The harm chain, end to end, with no mocks of the code under test:
//   crew/seat-io.mjs:1800  io.run() -> spawnSync with NO maxBuffer (default 1 MiB)
//   -> a chatty command is SIGTERM'd at 1 MiB, ok:false, tail replaced
//   crew/drive.mjs:3015    the lane bounce pastes laneRes.output.slice(-4000)
//   -> the builder is bounced with "the lane is RED" and shown nothing about why.
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const colorNeutralEnv = (base = process.env) => {
  const env = { ...base }
  delete env.FORCE_COLOR
  delete env.CLICOLOR_FORCE
  env.NO_COLOR = '1'
  return env
}

// Verbatim from crew/seat-io.mjs:1799-1806.
const run = (cmd) => {
  const res = spawnSync('/bin/sh', ['-c', cmd], { cwd: tmpdir(), encoding: 'utf8', timeout: 900_000, env: colorNeutralEnv(process.env) })
  let output = `${res.stdout || ''}${res.stderr || ''}`
  if (res.error) output += `\n[spawn error: ${res.error.message}]`
  if (res.signal) output += `\n[killed by ${res.signal}${res.signal === 'SIGTERM' ? ' — likely the 900s run timeout' : ''}]`
  return { ok: res.status === 0, output }
}

// A lane that is genuinely red and REPORTS WHY — but is chatty (>1 MiB), the way
// this suite becomes when a shared module breaks ~126 tests at ~4 KB of TAP each.
const cmd = `node -e '
const pad = "passing chatter ".repeat(14) + "\\n";
for (let i = 0; i < 70000; i++) process.stdout.write(pad);
console.log("not ok 1207 - resolveScope refuses a .. segment");
console.log("  AssertionError: expected refusal, got null");
console.log("  at crew/drive.test.mjs:1841:5");
' ; exit 1`

const res = run(cmd)
console.log('io.run().ok            =', res.ok, '   (red — but for the WRONG reason)')
console.log('output bytes retained  =', Buffer.byteLength(res.output))
console.log('does the output carry the real failure? ', res.output.includes('resolveScope refuses'))
console.log()
console.log('--- what crew/drive.mjs:3015 writes into the builder\'s bounce brief ---')
console.log(`# Lane bounce (round 2)\n\nThe validation lane is RED. Make it green:\n\n    npm test\n\nFailures:\n${res.output.slice(-4000)}\n\nPlan: /…/plan.md`.slice(0, 1400))
console.log('--- end (truncated for legibility; the tail is what matters) ---')
console.log()
console.log('last 160 chars of what the builder is shown:')
console.log(JSON.stringify(res.output.slice(-160)))
