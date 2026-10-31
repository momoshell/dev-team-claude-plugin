import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

let provider
let loadError
try {
  provider = await import(pathToFileURL(resolve(process.cwd(), 'crew/acp/provider.mjs')).href)
} catch (error) {
  loadError = error
}

const checks = [
  ['WS1', () => {
    const { acpProviderFailureKind: classify, providerRetryDecision: decide } = provider
    for (const text of [
      'WebSocket error',
      'WebSocket idle timeout after 1ms',
      'WebSocket idle timeout after 300000ms',
      'WebSocket idle timeout after 600000ms',
    ]) {
      const kind = classify('pi-agent-error', text)
      assert.equal(kind, 'server_error', `${JSON.stringify(text)} must classify as server_error`)
      const decision = decide({ kind })
      assert.equal(decision.retry, true, `${JSON.stringify(text)} must get bounded retry`)
      assert.equal(decision.action, 'backoff')
    }
    for (const text of [
      ' WebSocket error', 'WebSocket error ', 'WebSocket error\n', 'websocket error',
      'prefix WebSocket error', 'WebSocket error: detail',
      'WebSocket idle timeout after ms', 'WebSocket idle timeout after -1ms',
      'WebSocket idle timeout after 1.5ms', 'WebSocket idle timeout after Nms',
      'WebSocket idle timeout after 300000ms ', 'WebSocket idle timeout after 300000ms\n',
      'prefix WebSocket idle timeout after 300000ms',
      null, undefined, 42, {},
    ]) assert.equal(classify('pi-agent-error', text), null, `${JSON.stringify(text)} is not an exact transport match`)
    for (const kind of ['other', '', null, undefined]) {
      for (const text of ['WebSocket error', 'WebSocket idle timeout after 300000ms']) {
        assert.equal(classify(kind, text), null, 'transport text must be pi-only')
      }
    }
  }],
  ['WS2', () => {
    const { acpProviderFailureKind: classify, providerRetryDecision: decide } = provider
    for (const text of ['Operation aborted', 'terminated', 'WebSocket closed 1000']) {
      const kind = classify('pi-agent-error', text)
      assert.equal(kind, null, `${JSON.stringify(text)} must remain unclassified`)
      assert.equal(decide({ kind }).retry, false, `${JSON.stringify(text)} must not retry`)
    }
  }],
]

let failures = 0
for (const [id, check] of checks) {
  try {
    if (loadError) throw new Error(`cannot load cwd provider: ${loadError.message}`)
    check()
  } catch (error) {
    failures += 1
    console.log(`FAIL ${id}: ${String(error.message).replace(/\s+/g, ' ')}`)
  }
}
process.exitCode = failures ? 1 : 0
