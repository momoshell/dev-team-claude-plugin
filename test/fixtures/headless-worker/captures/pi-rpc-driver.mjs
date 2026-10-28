#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'

const scenario = process.argv[2]
const out = process.argv[3]
const sessionDir = process.argv[4]
const model = 'openai-codex/gpt-5.6-luna'
const common = ['--mode', 'rpc', '--model', model, '--thinking', 'low', '--session-dir', sessionDir, '--tools', 'bash,read,write', '--no-context-files', '--no-extensions', '--no-skills']
writeFileSync(out, '')
const log = s => appendFileSync(out, s.endsWith('\n') ? s : s + '\n')
const command = (child, obj, raw = JSON.stringify(obj)) => { log(`>>> ${raw}`); child.stdin.write(raw + '\n') }

function start(extra = []) {
  const child = spawn('pi', [...common, ...extra], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = Buffer.alloc(0)
  const events = []
  child.stdout.on('data', chunk => {
    buf = Buffer.concat([buf, chunk])
    let i
    while ((i = buf.indexOf(0x0a)) >= 0) {
      const line = buf.subarray(0, i).toString('utf8').replace(/\r$/, '')
      buf = buf.subarray(i + 1)
      log(line)
      try { events.push(JSON.parse(line)) } catch {}
      onEvent(events.at(-1), child)
    }
  })
  child.stderr.on('data', chunk => log(`STDERR ${chunk.toString('utf8').replace(/\n$/, '')}`))
  child.on('exit', (code, signal) => log(`<<< child_exit code=${code} signal=${signal || 'none'}`))
  return { child, events }
}

let current
let action = 0
let settled = 0
let firstEntry
function onEvent(event, child) {
  if (!event) return
  if (scenario === 'b5') {
    if (event.type === 'response' && event.id === 'state-1') {
      command(child, { id: 'bad-1', type: 'not-a-command' })
      child.stdin.write('{"id":"malformed"\n')
      log('>>> {"id":"malformed"')
      command(child, { id: 'prompt-1', type: 'prompt', message: 'Reply B5-DONE in one sentence.' })
    }
    if (event.type === 'agent_settled') setTimeout(() => child.stdin.end(), 200)
  }
  if (scenario === 'b6' && current && action === 0 && event.type === 'tool_execution_start') {
    action = 1
    command(child, { id: 'steer-1', type: 'steer', message: 'Steer now: after the sleep, tell me exactly what steering message you saw, then reply B6-DONE.' })
    command(child, { id: 'prompt-error-1', type: 'prompt', message: 'This prompt has no streamingBehavior and should be rejected.' })
  }
  if (scenario === 'b6' && event.type === 'agent_settled') setTimeout(() => child.stdin.end(), 200)
  if (scenario === 'b7' && current && action === 0 && event.type === 'tool_execution_start') {
    action = 1
    command(child, { id: 'abort-1', type: 'abort' })
  }
  if (scenario === 'b7' && action === 1 && event.type === 'response' && event.id === 'abort-1') {
    command(child, { id: 'state-after-abort', type: 'get_state' })
  }
  if (scenario === 'b7' && action === 1 && event.type === 'response' && event.id === 'state-after-abort') {
    command(child, { id: 'fresh-1', type: 'prompt', message: 'Reply B7-FRESH-DONE.' })
    action = 2
  }
  if (scenario === 'b7' && action === 2 && event.type === 'agent_settled') setTimeout(() => child.stdin.end(), 200)
  if (scenario === 'b9' && action === 0 && event.type === 'agent_settled') {
    command(child, { id: 'entries-1', type: 'get_entries' })
    action = 1
  }
  if (scenario === 'b9' && action === 1 && event.type === 'response' && event.id === 'entries-1') {
    firstEntry = event.data?.entries?.at(-1)?.id
    log(`### cursor=${firstEntry || 'none'}`)
    command(child, { id: 'bad-since-1', type: 'get_entries', since: 'does-not-exist-116' })
    setTimeout(() => { child.stdin.end(); setTimeout(startSecondB9, 400) }, 300)
    action = 2
  }
  if (scenario === 'b10' && current && action === 0 && event.type === 'tool_execution_start') {
    action = 1
    setTimeout(() => { log('### sending SIGKILL mid-turn'); child.kill('SIGKILL'); setTimeout(startSecondB10, 500) }, 1500)
  }
}

function startSecondB9() {
  const second = start(['--session', process.argv[5]])
  current = second
  setTimeout(() => {
    command(second.child, { id: 'entries-since-1', type: 'get_entries', since: firstEntry || 'none' })
    command(second.child, { id: 'bad-since-2', type: 'get_entries', since: 'does-not-exist-116' })
    setTimeout(() => second.child.stdin.end(), 1500)
  }, 400)
}
function startSecondB10() {
  const second = start(['--session', process.argv[5]])
  current = second
  setTimeout(() => command(second.child, { id: 'resume-1', type: 'prompt', message: 'The previous process was killed. Reply B10-RESUMED-DONE.' }), 400)
  setTimeout(() => second.child.stdin.end(), 15000)
}

if (scenario === 'b9') {
  current = start(['--session-id', process.argv[5]])
  setTimeout(() => {
    command(current.child, { id: 'prompt-1', type: 'prompt', message: 'Reply B9-SEEDED-DONE.' })
  }, 300)
} else {
  current = start()
  setTimeout(() => {
    if (scenario === 'b5') command(current.child, { id: 'state-1', type: 'get_state' })
    if (scenario === 'b6') command(current.child, { id: 'prompt-1', type: 'prompt', message: 'Use bash to run sleep 25, then reply B6-DONE and state what you saw.' })
    if (scenario === 'b7') command(current.child, { id: 'prompt-1', type: 'prompt', message: 'Use bash to run sleep 25, then reply B7-SLOW-DONE.' })
    if (scenario === 'b10') command(current.child, { id: 'prompt-1', type: 'prompt', message: 'Use bash to run sleep 25, then reply B10-SLOW-DONE.' })
  }, 300)
}
