// Does io.run()'s spawnSync truncate/kill a command whose output exceeds maxBuffer?
// Mirrors crew/seat-io.mjs:1800 exactly (same options), against a scratch cwd.
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const colorNeutralEnv = (base = process.env) => {
  const env = { ...base }
  delete env.FORCE_COLOR
  delete env.CLICOLOR_FORCE
  env.NO_COLOR = '1'
  return env
}

// A command that PASSES (exit 0) but prints ~4 MiB, then the summary line last.
const cmd = `node -e 'const l="x".repeat(200)+"\\n"; for(let i=0;i<21000;i++) process.stdout.write(l); console.log(String.fromCharCode(71)+"ATE-SUMMARY {\\"total\\":3,\\"failed\\":0,\\"errored\\":0}")' ; exit 0`

const res = spawnSync('/bin/sh', ['-c', cmd], { cwd: tmpdir(), encoding: 'utf8', timeout: 900_000, env: colorNeutralEnv(process.env) })
let output = `${res.stdout || ''}${res.stderr || ''}`
if (res.error) output += `\n[spawn error: ${res.error.message}]`
if (res.signal) output += `\n[killed by ${res.signal}]`
const ok = res.status === 0

console.log('child truly exited 0? intended yes')
console.log('res.status      =', JSON.stringify(res.status))
console.log('res.signal      =', JSON.stringify(res.signal))
console.log('res.error       =', res.error ? res.error.code || res.error.message : null)
console.log('io.run().ok     =', ok)
console.log('output bytes    =', Buffer.byteLength(output))
console.log('summary present =', output.includes('GATE-SUMMARY'))
console.log('last 200 chars  =', JSON.stringify(output.slice(-200)))
