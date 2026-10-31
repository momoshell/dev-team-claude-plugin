import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const failures = new Map()
let acpClient, acpSeatPaths
try {
  ({ acpClient, acpSeatPaths } = await import(pathToFileURL(resolve(process.cwd(), 'crew/acp-client.mjs')).href))
} catch (error) {
  for (const id of ['CE1', 'CE2']) failures.set(id, `client import: ${error.message}`)
}

// No worker, FIFO, reservation, or filesystem writes: the injected transport
// responds to real session/prompt frames consumed by the real response pump.
function exercise(mode, data, present) {
  const dir = resolve(process.cwd(), '.gate-in-memory-acp')
  const paths = acpSeatPaths(dir, 'builder')
  let stream = ''
  const journal = []
  const client = acpClient({
    dir, cwd: process.cwd(), role: 'builder',
    deps: {
      mkdirSync: () => {},
      existsSync: (path) => path === paths.stream,
      readFileSync: (path) => {
        assert.equal(path, paths.stream)
        return Buffer.from(stream)
      },
      writeSync: (_fd, buffer, offset, length) => {
        const frame = JSON.parse(buffer.subarray(offset, offset + length).toString())
        assert.equal(frame.method, 'session/prompt')
        const error = { code: -32000, message: 'Prompt refused', ...(present ? { data } : {}) }
        stream += `${JSON.stringify({ jsonrpc: '2.0', id: frame.id, error })}\n`
        return length
      },
      now: () => 1000,
      sleep: () => { throw new Error('unexpected wait for in-memory response') },
      log: (row) => journal.push(row),
    },
  })
  const blocks = [{ type: 'text', text: 'gate prompt' }]
  const turn = mode === 'prompt' ? client.prompt(blocks) : client.pollPrompt(client.beginPrompt(blocks))
  assert.ok(turn)
  assert.equal(turn.stopReason, null)
  assert.equal(turn.usage, null)
  assert.ok(turn.refusal)
  const rows = journal.filter((row) => row.acp_turn_refused)
  assert.equal(rows.length, 1)
  const refusal = turn.refusal
  const logged = rows[0].acp_turn_refused
  for (const value of [refusal, logged]) {
    assert.equal(value.code, -32000)
    assert.equal(value.message, 'Prompt refused')
    assert.equal(value.errorKind, data?.errorKind ?? null)
  }
  return [refusal, logged, JSON.parse(JSON.stringify(refusal)), JSON.parse(JSON.stringify(logged))]
}

if (acpClient) {
  const cases = {
    CE1: ['pi provider cause', '', 'provider failed\n原因: quota exhausted'].map((errorMessage) => ({
      present: true, data: { errorKind: 'server_error', errorMessage }, expected: errorMessage,
    })),
    CE2: [
      { present: false },
      { present: true, data: {} },
      { present: true, data: { errorKind: 'server_error' } },
      { present: true, data: null },
      ...[null, 0, false, {}, []].map((errorMessage) => ({ present: true, data: { errorKind: 'server_error', errorMessage } })),
    ],
  }
  for (const [id, samples] of Object.entries(cases)) {
    for (const mode of ['prompt', 'pollPrompt']) {
      for (const sample of samples) {
        try {
          for (const value of exercise(mode, sample.data, sample.present)) {
            assert.equal(Object.hasOwn(value, 'errorMessage'), id === 'CE1')
            if (id === 'CE1') assert.equal(value.errorMessage, sample.expected)
          }
        } catch (error) {
          if (!failures.has(id)) failures.set(id, `${mode}: ${error.message}`)
        }
      }
    }
  }
}
for (const [id, reason] of failures) console.log(`FAIL ${id}: ${reason.replace(/\s+/g, ' ')}`)
process.exitCode = failures.size ? 1 : 0
