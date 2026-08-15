// factoryctl owns nothing — the daemon owns the workers, the registry and the projection; this is a socket client that prints.
import netDefault from 'node:net'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { splitFrames } from './headless-rpc.mjs'

export const DEFAULT_TIMEOUT_MS = 5000

// A --flag followed by another --flag (or by nothing) is a BOOLEAN true.
export function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) { out._.push(token); continue }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) { out[token.slice(2)] = true } else { out[token.slice(2)] = next; i += 1 }
  }
  return out
}

export function socketPathFor(args = {}, env = process.env) {
  const root = args.root || env.CREW_DAEMON_ROOT || join(homedir(), '.crew', 'daemon')
  return join(root, 'daemon.sock')
}

function noDaemonError(socketPath) {
  const root = dirname(socketPath)
  const error = new Error([
    `no crew daemon is listening at ${socketPath} — factoryctl never starts one.`,
    'Start a daemon first, e.g.:',
    `  node --input-type=module -e "import {daemon} from './crew/daemon.mjs'; await daemon({root:'${root}'}).start()"`,
  ].join('\n'))
  error.code = 'no-daemon'
  return error
}

function connectionError(err, socketPath) {
  if (['ENOENT', 'ECONNREFUSED', 'ENOTSOCK'].includes(err?.code)) return noDaemonError(socketPath)
  return err instanceof Error ? err : new Error(String(err))
}

function daemonTimeoutError(socketPath) {
  const error = new Error(`timed out waiting for a response from the crew daemon at ${socketPath}`)
  error.code = 'daemon-timeout'
  return error
}

export function connect(socketPath, deps = {}) {
  const net = deps.net || netDefault
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    let socket
    let connected = false
    let settled = false
    let closed = false
    let sequence = 0
    let rest = Buffer.alloc(0)
    const pending = new Map()
    const listeners = new Set()

    const rejectPending = (error) => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(error)
      }
      pending.clear()
    }

    const failConnection = (err) => {
      const error = connectionError(err, socketPath)
      if (!connected) {
        if (settled) return
        settled = true
        try { socket?.destroy?.() } catch {}
        reject(error)
        return
      }
      rejectPending(error)
    }

    const close = () => {
      if (closed) return Promise.resolve()
      closed = true
      const error = new Error('factoryctl connection closed')
      error.code = 'connection-closed'
      rejectPending(error)
      try { socket?.destroy?.() } catch {}
      return Promise.resolve()
    }

    const call = (cmd, params) => new Promise((resolveCall, rejectCall) => {
      if (closed) {
        const error = new Error('factoryctl connection is closed')
        error.code = 'connection-closed'
        rejectCall(error)
        return
      }
      const id = `factoryctl-${++sequence}`
      const timer = setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        rejectCall(daemonTimeoutError(socketPath))
      }, timeoutMs)
      pending.set(id, { resolve: resolveCall, reject: rejectCall, timer })
      const request = { id, cmd }
      if (params !== undefined) request.params = params
      try { socket.write(`${JSON.stringify(request)}\n`) }
      catch (err) {
        clearTimeout(timer)
        pending.delete(id)
        rejectCall(err)
      }
    })

    const onData = (chunk) => {
      const split = splitFrames(Buffer.concat([rest, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8')]))
      rest = split.rest
      for (const line of split.lines) {
        if (!line.trim()) continue
        let frame
        try { frame = JSON.parse(line) } catch { continue }
        if (!frame || typeof frame.id !== 'string') continue
        if (frame.ok === undefined && frame.error === undefined) {
          for (const listener of listeners) { try { listener(frame) } catch {} }
          continue
        }
        const entry = pending.get(frame.id)
        if (!entry) continue
        pending.delete(frame.id)
        clearTimeout(entry.timer)
        if (frame.ok === true) entry.resolve(frame.result)
        else {
          const detail = frame.error || {}
          entry.reject(Object.assign(new Error(detail.message), { code: detail.code }))
        }
      }
    }

    try { socket = net.connect(socketPath) }
    catch (err) { failConnection(err); return }
    socket.on?.('data', onData)
    socket.on?.('error', failConnection)
    socket.on?.('close', () => {
      if (!connected) failConnection(Object.assign(new Error('socket closed'), { code: 'ENOENT' }))
      else rejectPending(new Error(`crew daemon connection closed at ${socketPath}`))
    })
    socket.on?.('connect', () => {
      if (settled || closed) return
      connected = true
      settled = true
      resolve({ call, close, onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn) } })
    })
  })
}

export function formatRows(rows) {
  const headers = ['RUN', 'STATE', 'OUTCOME', 'TASK']
  const values = (Array.isArray(rows) ? rows : []).map((row) => [
    row?.run_id == null ? '' : String(row.run_id),
    row?.state == null ? '' : String(row.state),
    row?.outcome == null ? '' : String(row.outcome),
    row?.task == null ? '' : String(row.task),
  ])
  const widths = headers.map((header, index) => Math.max(header.length, ...values.map((value) => value[index].length)))
  const render = (value, index) => index === values[0]?.length - 1 ? value : value.padEnd(widths[index])
  const header = headers.map((value, index) => index === headers.length - 1 ? value : value.padEnd(widths[index])).join('  ')
  return [header, ...values.map((row) => row.map(render).join('  '))].join('\n')
}

function outputSink(value, fallback) {
  if (typeof value === 'function') return value
  if (value && typeof value.write === 'function') return (text) => value.write(text)
  return (text) => fallback.write(text)
}

function requireRunArgs(args) {
  if (typeof args['crew-dir'] !== 'string' || !args['crew-dir']) throw new Error('run requires --crew-dir <dir>')
  if (typeof args.brief !== 'string' || !args.brief) throw new Error('run requires --brief <file>')
}

export async function runVerb(args, deps = {}) {
  requireRunArgs(args)
  const call = deps.call || deps.connection?.call
  if (typeof call !== 'function') throw new Error('run requires a daemon connection')
  const result = await call('enqueue', {
    crew_dir: resolvePath(args['crew-dir']),
    brief_file: resolvePath(args.brief),
  })
  const stdout = outputSink(deps.stdout, process.stdout)
  stdout(`${JSON.stringify({ run_id: result?.run_id })}\n`)
  return result
}

function requireSendArgs(args) {
  if (typeof args?._?.[1] !== 'string' || !args._[1] || typeof args._?.[2] !== 'string' || !args._[2]) {
    throw new Error('send requires <run-id> and <message>')
  }
  if (args.role !== undefined && (typeof args.role !== 'string' || !args.role)) throw new Error('send requires --role <role> when --role is present')
}

export async function sendVerb(args, deps = {}) {
  requireSendArgs(args)
  const call = deps.call || deps.connection?.call
  if (typeof call !== 'function') throw new Error('send requires a daemon connection')
  const role = args.role
  const result = await call('send', { run: args._[1], message: args._[2], ...(role ? { role } : {}) })
  const stdout = outputSink(deps.stdout, process.stdout)
  stdout(`${JSON.stringify(result)}\n`)
  return result
}

export async function lsVerb(args, deps = {}) {
  const call = deps.call || deps.connection?.call
  if (typeof call !== 'function') throw new Error('ls requires a daemon connection')
  const listed = await call('list')
  const rows = []
  for (const run of Array.isArray(listed) ? listed : []) {
    const result = await call('result', { run: run.run_id })
    rows.push({ run_id: run.run_id, task: run.task, state: run.state, outcome: result?.outcome ?? null })
  }
  const stdout = outputSink(deps.stdout, process.stdout)
  if (args.json) stdout(`${JSON.stringify(rows)}\n`)
  else stdout(`${formatRows(rows)}\n`)
  return rows
}

function requireAttachArgs(args) {
  if (typeof args?._?.[1] !== 'string' || !args._[1]) throw new Error('attach requires <run-id>')
}

function attachEndMessage(run, reason) {
  if (reason === 'settled') return `attach ended: run ${run} settled — this stream is transport, not a verdict; ask \`factoryctl ls\` for the outcome\n`
  if (reason === 'dead') return `attach ended: run ${run} is dead with no envelope — ask \`factoryctl ls\` for the outcome\n`
  if (reason === 'interrupted') return `attach ended: interrupted — run ${run} was still streaming; the envelope is the record\n`
  if (reason === 'stream-closed') return `attach ended: output stream closed — run ${run} was still streaming\n`
  return `attach ended: run ${run} stream ended (${reason})\n`
}

export async function attachVerb(args, deps = {}) {
  requireAttachArgs(args)
  const run = args._[1]
  const call = deps.call || deps.connection?.call
  const onEvent = deps.onEvent || deps.connection?.onEvent
  if (typeof call !== 'function' || typeof onEvent !== 'function') throw new Error('attach requires a daemon connection')
  const stdout = outputSink(deps.stdout, process.stdout)
  const stderr = outputSink(deps.stderr, process.stderr)
  const signal = deps.signal
  let ended = false
  let reason = null
  let finish
  const done = new Promise((resolve) => {
    finish = (value) => {
      if (ended) return
      ended = true
      reason = value
      resolve(value)
    }
  })
  const listener = (frame) => {
    if (ended) return
    if (frame?.event !== undefined) {
      try { stdout(`${JSON.stringify(frame.event)}\n`) }
      catch { finish('stream-closed') }
      return
    }
    if (frame?.end !== undefined) finish(frame.end?.reason)
  }
  const unsubscribe = onEvent(listener)
  const abort = () => finish('interrupted')
  signal?.addEventListener?.('abort', abort, { once: true })
  try {
    if (signal?.aborted) finish('interrupted')
    if (!ended) {
      await call('tail', { run, since: 0 })
      if (!ended) {
        const current = await call('state', { run })
        if (!ended && current?.state === 'done') finish('settled')
        else if (!ended && current?.state === 'dead') finish('dead')
      }
    }
    if (!ended && signal?.aborted) finish('interrupted')
    const finalReason = await done
    stderr(attachEndMessage(run, finalReason))
    return { run_id: run, reason: finalReason }
  } finally {
    signal?.removeEventListener?.('abort', abort)
    try { await call('untail', { run }) } catch {}
    try { unsubscribe?.() } catch {}
  }
}

export async function main(argv, deps = {}) {
  const args = parseArgs(argv)
  const stderr = outputSink(deps.stderr, process.stderr)
  const verb = args._[0]
  if (!['run', 'ls', 'attach', 'send'].includes(verb)) {
    stderr('usage: factoryctl <run|ls|attach|send> ...\n')
    return 2
  }

  let session = null
  let controller = null
  let signalProcess = null
  let onInterrupt = null
  let onTerminate = null
  try {
    if (verb === 'run') requireRunArgs(args)
    if (verb === 'attach') requireAttachArgs(args)
    if (verb === 'send') requireSendArgs(args)
    if (verb === 'attach') {
      controller = new AbortController()
      signalProcess = deps.process ?? process
      onInterrupt = () => controller.abort()
      onTerminate = () => controller.abort()
      signalProcess.on?.('SIGINT', onInterrupt)
      signalProcess.on?.('SIGTERM', onTerminate)
    }
    session = await connect(socketPathFor(args, deps.env || process.env), { net: deps.net, timeoutMs: deps.timeoutMs })
    const commandDeps = { ...deps, call: session.call, onEvent: session.onEvent }
    if (verb === 'run') await runVerb(args, commandDeps)
    else if (verb === 'ls') await lsVerb(args, commandDeps)
    else if (verb === 'attach') await attachVerb(args, { ...commandDeps, signal: deps.signal ?? controller.signal })
    else await sendVerb(args, commandDeps)
    return 0
  } catch (err) {
    stderr(`error: ${err?.message || String(err)}\n`)
    return 1
  } finally {
    if (signalProcess) {
      const remove = signalProcess.removeListener || signalProcess.off
      remove?.call(signalProcess, 'SIGINT', onInterrupt)
      remove?.call(signalProcess, 'SIGTERM', onTerminate)
    }
    try { await session?.close?.() } catch {}
  }
}

const invokedDirectly = process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code })
}
