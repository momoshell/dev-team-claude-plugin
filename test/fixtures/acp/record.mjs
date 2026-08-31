// ACP Wave 0 recorder (#793). Drives ONE turn against a live ACP server and
// records every frame, both directions, as NDJSON.
//
// Framing: split on LF by hand. node:readline mis-splits around U+2028 —
// crew/headless-rpc.mjs:55 records the measured trap.
import { spawn } from 'node:child_process'
import { mkdirSync, createWriteStream } from 'node:fs'
import { dirname } from 'node:path'

export function splitFrames(buffer) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ''), 'utf8')
  const lines = []
  let start = 0
  for (;;) {
    const nl = input.indexOf(0x0a, start)
    if (nl < 0) break
    let line = input.subarray(start, nl).toString('utf8')
    if (line.endsWith('\r')) line = line.slice(0, -1)
    lines.push(line)
    start = nl + 1
  }
  return { lines, rest: input.subarray(start) }
}

export function createRecorder(outPath) {
  mkdirSync(dirname(outPath), { recursive: true })
  const sink = createWriteStream(outPath, { flags: 'w' })
  const t0 = Date.now()
  // A late notification must never crash the recorder: frames keep arriving
  // after the driver stops waiting, and ERR_STREAM_WRITE_AFTER_END would lose
  // the whole fixture over a frame we did not need.
  let closed = false
  return {
    write(dir, frame, note) {
      if (closed) return
      const row = { dir, ms: Date.now() - t0, frame }
      if (note) row.note = note
      sink.write(JSON.stringify(row) + '\n')
    },
    stderr(text) { if (!closed) sink.write(JSON.stringify({ dir: 'stderr', ms: Date.now() - t0, text }) + '\n') },
    close() { closed = true; return new Promise((r) => sink.end(r)) },
  }
}

export function createClient({ bin, args = [], cwd, env, recorder, onRequest, onNotify }) {
  const child = spawn(bin, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let rest = Buffer.alloc(0)
  let nextId = 1
  const pending = new Map()

  const send = (frame) => {
    recorder.write('client->agent', frame)
    child.stdin.write(JSON.stringify(frame) + '\n')
  }

  child.stdout.on('data', (chunk) => {
    const { lines, rest: keep } = splitFrames(Buffer.concat([rest, chunk]))
    rest = keep
    for (const line of lines) {
      if (line.trim() === '') continue
      let frame
      try { frame = JSON.parse(line) } catch { recorder.write('agent->client', line, 'UNPARSEABLE'); continue }
      recorder.write('agent->client', frame)
      if (frame.id !== undefined && frame.method === undefined) {
        const slot = pending.get(frame.id)
        if (slot) { pending.delete(frame.id); slot(frame) }
        continue
      }
      if (frame.method && frame.id !== undefined) {          // agent -> client REQUEST
        Promise.resolve(onRequest?.(frame)).then((result) => {
          send({ jsonrpc: '2.0', id: frame.id, result: result ?? {} })
        })
        continue
      }
      if (frame.method) onNotify?.(frame)                    // notification
    }
  })
  child.stderr.on('data', (c) => recorder.stderr(c.toString('utf8')))

  return {
    child,
    notify(method, params) { send({ jsonrpc: '2.0', method, params }) },
    request(method, params, timeoutMs = 180000) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)) }, timeoutMs)
        pending.set(id, (frame) => { clearTimeout(timer); resolve(frame) })
        send({ jsonrpc: '2.0', id, method, params })
      })
    },
    close() { try { child.stdin.end() } catch {} ; try { child.kill('SIGTERM') } catch {} },
  }
}
