// Shared test helpers for the surviving suites.
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync, readdirSync, statSync, readFileSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { after } from 'node:test'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'

// Scratch directories, drained without the caller remembering. The suite leaked
// 142 directories per run because cleanup was wired per call site: a file with
// twenty creates and one rmSync looks clean and leaks nineteen (#572). Three
// drains, because the leaks that matter come from runs that do not finish:
// the node:test root `after` hook (normal completion), `process.on('exit')`
// (a test that throws, or hard-exits past every after hook), and the three
// catchable interrupt signals, re-raised so the exit status is unchanged.
// SIGKILL is unreachable by construction and is the one hole.
const SCRATCH_DIRS = new Set()
const SCRATCH_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']

function drainScratchDirs() {
  for (const dir of SCRATCH_DIRS) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
  SCRATCH_DIRS.clear()
}

after(drainScratchDirs)
process.on('exit', drainScratchDirs)
for (const signal of SCRATCH_SIGNALS) {
  process.on(signal, () => {
    drainScratchDirs()
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
  })
}

export function scratchDir(prefix = 'crew-test-', { parent = tmpdir() } = {}) {
  const dir = mkdtempSync(join(parent, prefix))
  SCRATCH_DIRS.add(dir)
  return dir
}

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { writeFileSync, renameSync } from 'node:fs'

const UNREACHABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EACCES', 'EHOSTUNREACH'])

export async function rawRequest({ port, host = '127.0.0.1', requestLine, headers = [], body = '', timeoutMs = 5000 }) {
  const wire = `${requestLine}\r\n${headers.map((h) => `${h}\r\n`).join('')}\r\n${body}`
  return new Promise((resolve, reject) => {
    const chunks = []
    let settled = false
    let timedOut = false
    let errorCode = null
    const socket = connect(port, host, () => { socket.write(wire) })
    const timer = setTimeout(() => { timedOut = true; socket.destroy() }, timeoutMs)
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      // A server that refuses and closes is an input class, not a test bug:
      // only an unreachable peer rejects.
      if (chunks.length === 0 && UNREACHABLE.has(errorCode)) {
        reject(new Error(`rawRequest could not reach ${host}:${port}: ${errorCode}`))
        return
      }
      const raw = Buffer.concat(chunks)
      resolve({ raw, text: raw.toString('latin1'), closedWithoutResponse: raw.length === 0, errorCode, timedOut })
    }
    socket.on('data', (c) => chunks.push(c))
    socket.on('end', () => done())
    socket.on('close', () => done())
    socket.on('error', (err) => { errorCode = err.code ?? 'ERR'; done() })
  })
}

export async function startFileWriter({ file, text, mode = 'plain', counterToken = '%N%', maxMs = 15000, readyTimeoutMs = 10000 }) {
  const stop = `${file}.stop`
  const write = mode === 'atomic'
    ? "writeFileSync(file + '.tmp', body); renameSync(file + '.tmp', file)"
    : 'writeFileSync(file, body)'
  const source = `
const { writeFileSync, renameSync, existsSync } = require('node:fs')
const file = ${JSON.stringify(file)}, stop = ${JSON.stringify(stop)}
const text = ${JSON.stringify(text)}, token = ${JSON.stringify(counterToken)}
const deadline = Date.now() + ${Number(maxMs)}
let n = 0
while (Date.now() < deadline && !existsSync(stop)) {
  const body = text.split(token).join(String(n))
  ${write}
  n += 1
  if (n === 1) process.stdout.write('ready\\n')
}
process.stdout.write(JSON.stringify({ writes: n }) + '\\n')
`
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (c) => { out += c })
  let exited = null
  child.once('exit', (code) => { exited = code ?? 0 })
  await new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (out.includes('ready')) { clearInterval(timer); resolve(); return }
      if (exited !== null) { clearInterval(timer); reject(new Error(`writer child exited before its first write: ${out}`)); return }
      if (Date.now() - started > readyTimeoutMs) { clearInterval(timer); child.kill('SIGKILL'); reject(new Error(`writer child was not ready in ${readyTimeoutMs}ms`)) }
    }, 5)
  })
  const stopFn = async () => {
    if (exited === null) writeFileSync(stop, '')
    const code = exited !== null ? exited : await new Promise((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000)
      child.once('exit', (c) => { clearTimeout(kill); resolve(c ?? 0) })
    })
    const line = out.trim().split('\n').at(-1)
    let writes = null
    try { writes = JSON.parse(line).writes } catch { writes = null }
    return { writes, exitCode: code }
  }
  return { pid: child.pid, stop: stopFn }
}

export function writeTornFile({ file, completeText, keepBytes = Math.max(1, Math.floor(completeText.length / 2)) }) {
  const prefix = completeText.slice(0, keepBytes)
  if (prefix.length === 0) throw new Error(`writeTornFile: the torn prefix is empty, so the bytes would not exist at ${file}`)
  let parses = false
  try { JSON.parse(prefix); parses = true } catch { parses = false }
  if (parses) throw new Error(`writeTornFile: the torn prefix parses, so it is not a torn artefact at ${file}`)
  writeFileSync(file, prefix)
  return {
    tornBytes: prefix.length,
    complete: () => { writeFileSync(`${file}.tmp`, completeText); renameSync(`${file}.tmp`, file) },
  }
}

const require = createRequire(import.meta.url)

// D1: one implementation of the node:sqlite probe. The per-file SKIP message,
// which interpolates that file's own NODE_FLOOR, stays where it is.
export function sqliteAvailable() {
  try { require('node:sqlite'); return true } catch { return false }
}

// D2: the one git contract. Six copies disagreed about the -c flags, the
// primitive and the argument shape; these two are the A/B pair that already
// agreed on every observable, and they keep both return conventions because
// the callers use both. NOT trimmed: crew/arms.test.mjs:20 trims and its callers
// depend on that, which is why arms cannot adopt `git` unchanged.
const GIT_CONFIG = [
  '-c', 'user.email=crew@example.invalid',
  '-c', 'user.name=Crew Test',
  '-c', 'protocol.file.allow=always',
]
export function git(repoDir, ...args) {
  return execFileSync('git', [...GIT_CONFIG, '-C', repoDir, ...args], { encoding: 'utf8' })
}
export function gitResult(repoDir, ...args) {
  return spawnSync('git', [...GIT_CONFIG, '-C', repoDir, ...args], { encoding: 'utf8' })
}

// D4: byte-identical bodies.
export function treeDigest(root) {
  const hash = createHash('sha256')
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = statSync(path)
      hash.update(name)
      if (stat.isDirectory()) walk(path)
      else hash.update(readFileSync(path))
    }
  }
  walk(root)
  return hash.digest('hex')
}

// D4: seedLane's only free variable is the caller's NOW. A factory keeps every
// existing `seedLane(root, …)` call site unchanged.
export function makeSeedLane(now) {
  return function seedLane(root, {
    repo = 'dt-demo',
    task = 'demo-lane',
    journalLines = [],
    artifacts = [],
    settled = false,
  } = {}) {
    const dir = join(root, repo, task)
    const taskDir = join(dir, 'task')
    mkdirSync(taskDir, { recursive: true })
    mkdirSync(join(dir, 'returns'), { recursive: true })
    writeFileSync(join(dir, 'crew.json'), JSON.stringify({ schema_version: 3, task, checkout: `/tmp/${repo}` }))
    writeFileSync(join(dir, 'journal.jsonl'), journalLines.map((line) => JSON.stringify(line)).join('\n') + (journalLines.length ? '\n' : ''))
    for (const artifact of artifacts) {
      const path = join(taskDir, artifact.name)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, artifact.body ?? 'x')
      const when = (now - artifact.ageS * 1000) / 1000
      utimesSync(path, when, when)
    }
    if (settled) writeFileSync(join(dir, 'returns', 'task.json'), '{}')
    return { dir, taskDir, journal: join(dir, 'journal.jsonl') }
  }
}
