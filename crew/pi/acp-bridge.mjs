#!/usr/bin/env node
// The stdio binary crew/acp-client.mjs launches for a pi ACP seat (#1534):
//   node crew/pi/acp-bridge.mjs [pi seat args...]
// It makes a private socket directory, spawns
//   $CREW_PI_BIN --mode rpc --no-session -e <repo>/crew/pi/extensions/acp-server.ts <args...>
// in its own process group with CREW_ACP_SOCKET set, holds pi's stdin open
// and unwritten, sends pi's stdout and stderr to its own stderr, waits for the
// socket, then pipes its stdin to the socket and the socket to its stdout
// byte for byte. On stdin EOF, socket close or a terminating signal it
// terminates pi's process group and exits with pi's status.
//
// The pi binary: subagent.ts resolves pi from its own process (argv[1] or the
// executable), which from here would resolve THIS script. The same structural
// rule applies instead: CREW_PI_BIN must be an absolute path to an existing
// file, or the bridge refuses before spawning anything. Never a bare 'pi'.

import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { constants as osConstants } from 'node:os'
import net from 'node:net'

export const PI_BIN_ENV = 'CREW_PI_BIN'
export const STARTUP_ENV = 'CREW_ACP_BRIDGE_STARTUP_MS'
export const DEFAULT_STARTUP_MS = 120000
const TERM_GRACE_MS = 5000
const POLL_MS = 25

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const serverPath = join(repo, 'crew/pi/extensions/acp-server.ts')
// Only ever POLL_MS: short enough that a timer which lost a race costs
// nothing, and ref'd, because after pi exits it is all that keeps the
// bridge alive while the rest of pi's group is torn down.
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const say = (text) => { try { process.stderr.write(`acp-bridge: ${text}\n`) } catch {} }

export function piBinaryFrom(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return { error: `${PI_BIN_ENV} must be an absolute path to the pi executable` }
  try { if (!statSync(value).isFile()) return { error: `${PI_BIN_ENV} ${value} is not a file` } } catch { return { error: `${PI_BIN_ENV} ${value} does not exist` } }
  return { bin: value }
}

export function exitCodeOf(status) {
  if (status?.error) return 1
  if (Number.isInteger(status?.code)) return status.code
  const signo = status?.signal ? osConstants.signals[status.signal] : null
  return Number.isInteger(signo) ? 128 + signo : 1
}

function startupMs() {
  const parsed = Number(process.env[STARTUP_ENV])
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_STARTUP_MS
}

function connectOnce(path) {
  return new Promise((done) => {
    const socket = net.createConnection(path)
    socket.once('connect', () => { socket.removeAllListeners('error'); done(socket) })
    socket.once('error', () => { socket.destroy(); done(null) })
  })
}

async function main() {
  const resolved = piBinaryFrom(process.env[PI_BIN_ENV])
  if (resolved.error) { say(resolved.error); return 2 }

  // Installed before the spawn: a signal at any point tears pi down.
  const stopped = new Promise((done) => {
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, () => done(signal))
  })
  let stopSignal = null
  stopped.then((signal) => { stopSignal = signal })
  const dir = mkdtempSync(join(tmpdir(), 'crew-acp-'))
  chmodSync(dir, 0o700)
  const socketPath = join(dir, 'pi.sock')
  let child = null
  let socket = null
  try {
    child = spawn(resolved.bin, ['--mode', 'rpc', '--no-session', '-e', serverPath, ...process.argv.slice(2)], {
      detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CREW_ACP_SOCKET: socketPath },
    })
    // Attached at spawn, so an exit that happens before anyone awaits it is
    // never missed: every later path awaits this one promise.
    const childDone = new Promise((done) => {
      child.once('error', (error) => done({ error }))
      child.once('exit', (code, signal) => done({ code, signal }))
    })
    let exited = null
    childDone.then((status) => { exited = status })
    child.stdin.on('error', () => {})
    child.stdout.pipe(process.stderr, { end: false })
    child.stderr.pipe(process.stderr, { end: false })

    // The GROUP, not the child: pi may have forked and exited already, and
    // whatever it left in its group is torn down all the same.
    const groupAlive = () => {
      try { process.kill(-child.pid, 0); return true } catch (err) { return err?.code === 'EPERM' }
    }
    const terminate = async () => {
      if (Number.isSafeInteger(child.pid) && child.pid > 1) {
        try { process.kill(-child.pid, 'SIGTERM') } catch {}
        const deadline = Date.now() + TERM_GRACE_MS
        while ((!exited || groupAlive()) && Date.now() < deadline) await (exited ? sleep(POLL_MS) : Promise.race([childDone, sleep(POLL_MS)]))
        if (!exited || groupAlive()) { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
      }
      return childDone
    }

    const deadline = Date.now() + startupMs()
    while (!exited && !stopSignal && Date.now() < deadline) {
      if (existsSync(socketPath)) socket = await connectOnce(socketPath)
      if (socket) break
      await Promise.race([childDone, stopped, sleep(POLL_MS)])
    }
    if (socket && stopSignal) { socket.destroy(); socket = null }
    if (!socket) {
      if (exited) say('pi exited before its ACP socket appeared')
      else if (stopSignal) say(`${stopSignal} before the ACP socket was connected`)
      else say(`pi did not open its ACP socket within ${startupMs()}ms`)
      // A startup that never served ACP is a failure whatever pi said: keep a
      // nonzero pi status, never report a clean 0.
      const code = exitCodeOf(await terminate())
      return code === 0 ? 1 : code
    }

    const ended = new Promise((done) => {
      process.stdin.once('end', () => done('stdin-eof'))
      socket.once('close', () => done('socket-close'))
      stopped.then(done)
      childDone.then(() => done('pi-exit'))
    })
    socket.on('error', () => {})
    process.stdin.pipe(socket)
    socket.pipe(process.stdout)
    await ended
    try { process.stdin.unpipe(socket) } catch {}
    const status = await terminate()
    return exitCodeOf(status)
  } finally {
    try { socket?.destroy() } catch {}
    try { process.stdin.destroy() } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code }, (err) => { say(`failed: ${err?.message || err}`); process.exitCode = 1 })
}
