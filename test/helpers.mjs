// Shared test helpers for the surviving suites.
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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
