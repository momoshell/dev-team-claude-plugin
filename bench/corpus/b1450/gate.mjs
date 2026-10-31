import { spawn } from 'node:child_process'

// Every child imports the checkout under test from its inherited cwd, never this artifact's directory.
const fixture = `
import { writeSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const mode = process.argv[1]
process.argv[1] = process.execPath
const { main, StartRefusal } = await import(pathToFileURL(resolve(process.cwd(), 'crew/start.mjs')).href)
const valid = \`---
source: issue 1961
closes: 1961
tier: build
shape: standard
acceptance: [RV1]
out_of_scope: the visualizer
---
## The ask

Refuse roster edits that cannot boot.

## Acceptance

- (RV1) an edit that cannot boot is refused
\`
const deps = {
  readFileSync: () => mode === 'invalid' ? valid.replace('tier: build', 'tier: rigorous') : valid,
  existsSync: () => false,
  mkdirSync: () => {},
  writeFileSync: () => {},
  resolveAgents: () => ({ seats: {} }),
  spawnSync: () => ({ status: 0, stdout: 'origin/main\\n' }),
  spawnDetached: () => { writeSync(3, 'started\\n'); return 4242 },
  crewRoot: '/virtual/crew',
}
if (mode === 'sync-error') deps.log = () => { throw Object.assign(new Error('output denied'), { code: 'EIO' }) }
if (mode === 'sync-refusal') deps.log = () => { throw new StartRefusal('output denied') }
// Bigger than a pipe buffer: the second line cannot finish before the reader closes.
const checkout = '/virtual/' + 'x'.repeat(1024 * 1024) + '/checkout'
const argv = mode === 'invalid'
  ? ['/virtual/b1.md', '--check', '--loop', 'lean']
  : ['/virtual/b1.md', '--checkout', checkout, '--loop', 'lean']
process.exitCode = await main(argv, deps)
`

function run(mode) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', fixture, mode], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = '', started = '', spawnError = null, timedOut = false, closedAfterLine = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 10000)
    child.on('error', (error) => { spawnError = error.message })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text) => { stderr += text })
    child.stdio[3].setEncoding('utf8')
    child.stdio[3].on('data', (text) => { started += text })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (text) => {
      stdout += text
      if (mode === 'pipe' && stdout.includes('\n') && !closedAfterLine) {
        closedAfterLine = true
        child.stdout.destroy()
      }
    })
    if (mode === 'invalid') child.stdout.destroy()
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, started, spawnError, timedOut, closedAfterLine })
    })
  })
}

function infrastructure(result) {
  return result.spawnError || (result.timedOut ? 'child timed out' : null) || (result.signal ? `child signal ${result.signal}` : null)
}

const failures = new Map()
try {
  const pipe = await run('pipe')
  const reasons = []
  const broken = infrastructure(pipe)
  if (broken) reasons.push(broken)
  if (!pipe.closedAfterLine || !/^crew start: lane=b1 .*pid=4242\n/.test(pipe.stdout)) reasons.push('did not observe the first start line before closing the reader')
  if (pipe.started !== 'started\n') reasons.push('lane launch was not recorded')
  if (pipe.code !== 0) reasons.push(`closed-reader start exited ${pipe.code}; stderr=${JSON.stringify(pipe.stderr.slice(0, 700))}`)
  if (pipe.stderr !== '') reasons.push('closed-reader start wrote stderr (expected no stack trace or diagnostic)')
  for (const mode of ['sync-error', 'sync-refusal']) {
    const result = await run(mode)
    const problem = infrastructure(result)
    if (problem || result.code !== 0 || result.started !== 'started\n' || result.stderr !== '') {
      reasons.push(`${mode}: ${problem || `logging failure changed the successful start (exit ${result.code})`}`)
    }
  }
  if (reasons.length) failures.set('SE1', reasons.join('; '))
} catch (error) { failures.set('SE1', `gate fixture error: ${error.message}`) }

try {
  const result = await run('invalid')
  const reasons = []
  const problem = infrastructure(result)
  if (problem) reasons.push(problem)
  if (!Number.isInteger(result.code) || result.code === 0) reasons.push(`invalid --check with closed stdout exited ${result.code}`)
  if (!/crew start: brief .* is not a P1 brief:/.test(result.stderr) || !/tier is one of/.test(result.stderr)) reasons.push('expected brief-validation refusal was not reported')
  if (result.started !== '') reasons.push('invalid --check launched a lane')
  if (/\n\s+at |Unhandled 'error' event/.test(result.stderr)) reasons.push('refusal produced a stack trace')
  if (reasons.length) failures.set('SE2', reasons.join('; '))
} catch (error) { failures.set('SE2', `gate fixture error: ${error.message}`) }

for (const [id, reason] of failures) console.log(`FAIL ${id}: ${reason.replace(/[\r\n]+/g, ' ')}`)
process.exitCode = failures.size ? 1 : 0
