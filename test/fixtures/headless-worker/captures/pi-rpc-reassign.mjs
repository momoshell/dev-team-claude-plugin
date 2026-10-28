#!/usr/bin/env node
// pi-rpc-reassign.mjs — #148 arm: can a SETTLED pi RPC session take a second
// assignment?
//
// Kept separate from pi-rpc-driver.mjs deliberately: that file is checked in
// as #116's raw reproducibility evidence, and adding scenarios to it would
// change the artifact that produced the b5-b10 captures.
//
// The question is drive.mjs-shaped, not protocol-shaped. Every bounce path in
// the loop (plan bounce, lane bounce, review bounce, gate repair) reassigns a
// seat that ALREADY returned an envelope, so "reassign" means specifically:
// after `agent_settled`, does a second prompt land and complete?
//
// Two arms, because a crew bounce can arrive in either world:
//   A. same process — the RPC worker is still held open (the transport's point)
//   B. new process  — the worker exited between assignments, and the successor
//                     resumes the persisted session with --session
//
// usage: node pi-rpc-reassign.mjs <out.jsonl> <session-dir> <session-id>
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'

const [out, sessionDir, sessionId] = process.argv.slice(2)
if (!out || !sessionDir || !sessionId) {
  console.error('usage: pi-rpc-reassign.mjs <out.jsonl> <session-dir> <session-id>')
  process.exit(2)
}

const model = 'openai-codex/gpt-5.6-luna'
const common = ['--mode', 'rpc', '--model', model, '--thinking', 'low', '--session-dir', sessionDir,
  '--tools', 'bash,read,write', '--no-context-files', '--no-extensions', '--no-skills']

writeFileSync(out, '')
const log = (s) => appendFileSync(out, s.endsWith('\n') ? s : `${s}\n`)
const command = (child, obj) => { const raw = JSON.stringify(obj); log(`>>> ${raw}`); child.stdin.write(`${raw}\n`) }

function start(extra = [], label) {
  log(`### start ${label} :: pi ${[...common, ...extra].join(' ')}`)
  const child = spawn('pi', [...common, ...extra], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = Buffer.alloc(0)
  // Byte-level LF splitter, not node:readline — #116 recorded a readline trap
  // on this stream (pi-b5-readline-trap.txt).
  child.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    let i
    while ((i = buf.indexOf(0x0a)) >= 0) {
      const line = buf.subarray(0, i).toString('utf8').replace(/\r$/, '')
      buf = buf.subarray(i + 1)
      log(line)
      let event = null
      try { event = JSON.parse(line) } catch { /* non-JSON line is logged, not parsed */ }
      if (event) onEvent(event, child)
    }
  })
  child.stderr.on('data', (c) => log(`STDERR ${c.toString('utf8').replace(/\n$/, '')}`))
  child.on('exit', (code, signal) => log(`<<< child_exit ${label} code=${code} signal=${signal || 'none'}`))
  return child
}

// settled counts COMPLETED turns on the first process. #116 established that a
// driver needing a fully settled turn waits for agent_settled, not agent_end.
let settled = 0
let first

function onEvent(event, child) {
  if (event.type !== 'agent_settled') return
  settled += 1
  if (child === first && settled === 1) {
    // ARM A: the seat has returned. Reassign it on the same process.
    log('### ARM A — first turn settled; reassigning on the SAME process')
    command(child, { id: 'assign-2', type: 'prompt', message: 'Reply exactly B11-SECOND-SAME-PROCESS-DONE.', streamingBehavior: 'interrupt' })
    return
  }
  if (child === first && settled === 2) {
    log('### ARM A complete — ending the first process to test cross-process reassign')
    setTimeout(() => { child.stdin.end(); setTimeout(armB, 600) }, 200)
    return
  }
  if (child !== first && settled === 3) {
    // ARM C: delivery is not memory. A bounce brief says "revise YOUR plan per
    // this check" — worthless if the resumed seat cannot recall the turn it is
    // being bounced on. Ask something only prior context can answer.
    log('### ARM C — resumed seat recall probe on the SAME process as arm B')
    command(child, { id: 'assign-4', type: 'prompt', message: 'Without guessing: what exact marker string did you reply with in your FIRST reply of this session? Answer with only that string, or the single word UNKNOWN if you cannot see it.', streamingBehavior: 'interrupt' })
    return
  }
  if (child !== first) {
    log('### ARM C complete')
    setTimeout(() => child.stdin.end(), 200)
  }
}

function armB() {
  // ARM B: worker exited between assignments; the successor resumes the
  // persisted session and is handed the next assignment.
  const second = start(['--session', sessionId], 'arm-B')
  setTimeout(() => {
    command(second, { id: 'assign-3', type: 'prompt', message: 'Reply exactly B11-THIRD-NEW-PROCESS-DONE.', streamingBehavior: 'interrupt' })
  }, 500)
  setTimeout(() => { try { second.stdin.end() } catch { /* already closed */ } }, 90_000)
}

first = start(['--session-id', sessionId], 'arm-A')
setTimeout(() => {
  command(first, { id: 'assign-1', type: 'prompt', message: 'Reply exactly B11-FIRST-DONE.', streamingBehavior: 'interrupt' })
}, 400)
setTimeout(() => { log('### hard timeout'); process.exit(1) }, 120_000)
