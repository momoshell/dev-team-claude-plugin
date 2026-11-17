import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { probeAlive, selfStartedAt } from './run-pid.mjs'

const exec = promisify(execFile)
const WAIT_MS = 2 * 60 * 60 * 1000
const POLL_MS = 2000
const host = hostname()
const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms))

// The gate cannot start a command until its process group has been published.
// If the launcher dies before publication, EOF closes the gate without running anything.
const GATE = `
const { spawn } = require('node:child_process');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk });
process.stdin.on('end', () => {
  if (input !== 'go\\n') return;
  const [command, args] = JSON.parse(process.argv[1]);
  const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('error', error => {
    process.send({ type: 'spawn-error', code: error.code, message: error.message });
    process.disconnect();
    process.exitCode = 127;
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.send({ type: 'signal', signal }, () => process.kill(process.pid, signal));
      process.exitCode = 1;
    } else process.exitCode = code;
  });
});
`

function read(path) {
  try { return { value: JSON.parse(readFileSync(path, 'utf8')) } } catch (error) {
    return { missing: error.code === 'ENOENT' }
  }
}

function holderState(record, path) {
  const unknown = { ...record, state: 'unknown' }
  if (!record || typeof record.token !== 'string'
    || !Number.isSafeInteger(record.pid) || record.pid <= 1 || !Number.isFinite(record.startedAt)) return unknown
  if (read(`${path}.released`).value?.token === record.token) return { ...record, state: 'dead' }
  if (record.host !== host) return unknown
  const alive = probeAlive(record.pid, record.startedAt)
  const group = read(`${path}.group`)
  const pgid = group.value?.token === record.token ? group.value.pgid : null
  const holder = { ...record, pgid, state: alive === true ? 'live' : 'unknown' }
  if (alive !== false) return holder
  // A missing group is safe: the gate has never been permitted to launch a suite.
  if (group.missing) return { ...holder, state: 'dead' }
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return holder
  try { process.kill(-pgid, 0); return { ...holder, state: 'live' } } catch (error) {
    return { ...holder, state: error.code === 'ESRCH' ? 'dead' : error.code === 'EPERM' ? 'live' : 'unknown' }
  }
}

export async function acquireSuiteLock({ cwd, lane }) {
  const started = performance.now()
  const fields = (holder) => ({ suite_lock_wait_s: (performance.now() - started) / 1000, ...(holder ? { suite_lock_holder: holder } : {}) })
  let dir, holder
  try {
    const git = await exec('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', timeout: 10_000 })
    dir = join(realpathSync(resolve(cwd, git.stdout.trim())), 'crew-suite-lock')
    mkdirSync(dir, { recursive: true })
    for (;;) {
      if (performance.now() - started >= WAIT_MS) return { ok: false, reason: 'suite-lock-timeout', ...fields(holder) }
      // Fenced exclusive publication, as in reclaim.mjs. Keep epoch records so a
      // delayed contender can never recreate an old epoch (or delete a successor).
      const epochs = readdirSync(dir).filter((name) => /^[1-9]\d*\.json$/.test(name)).map((name) => Number(name.slice(0, -5)))
      const fence = epochs.reduce((max, epoch) => Math.max(max, epoch), 0)
      if (!Number.isSafeInteger(fence + 1)) throw new Error('suite lock epoch exhausted')
      const current = fence ? join(dir, `${fence}.json`) : null
      holder = current ? holderState(read(current).value, current) : null
      if (!holder || holder.state === 'dead') {
        const token = randomUUID()
        const record = { token, pid: process.pid, startedAt: selfStartedAt(), host, lane: lane ?? null }
        const path = join(dir, `${fence + 1}.json`)
        const tmp = join(dir, `.${token}.tmp`)
        let published = false
        try {
          writeFileSync(tmp, JSON.stringify(record), { flag: 'wx' })
          linkSync(tmp, path)
          published = true
        } catch (error) { if (error.code !== 'EEXIST') throw error } finally {
          try { unlinkSync(tmp) } catch { /* no ownership was published by this cleanup */ }
        }
        if (published) {
          // Group publication is atomic and precedes permission to execute.
          return {
            ok: true, ...fields(),
            command: (command, args) => ({ command: process.execPath, args: ['-e', GATE, JSON.stringify([command, args])] }),
            start(child) {
              const tmpGroup = `${path}.${token}.tmp`
              try {
                writeFileSync(tmpGroup, JSON.stringify({ token, pgid: child.pid }), { flag: 'wx' })
                renameSync(tmpGroup, `${path}.group`)
                child.stdin.end('go\n')
              } finally { try { unlinkSync(tmpGroup) } catch {} }
            },
            release() {
              // This epoch is never reused. A release cannot overwrite another owner.
              writeFileSync(`${path}.released`, JSON.stringify({ token }), { flag: 'wx' })
            },
          }
        }
      }
      if (performance.now() - started >= WAIT_MS) return { ok: false, reason: 'suite-lock-timeout', ...fields(holder) }
      await sleep(Math.min(POLL_MS, WAIT_MS - (performance.now() - started)))
    }
  } catch (error) {
    return { ok: false, reason: 'suite-lock-unavailable', ...fields(holder), error: { code: error.code ?? null, message: error.message } }
  }
}
