import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ids = ['PK1', 'PK2', 'PK3']
const failures = new Map()
let classify, wired = false
try {
  const provider = await import(pathToFileURL(resolve(process.cwd(), 'crew/acp/provider.mjs')).href)
  classify = provider.acpProviderFailureKind
  assert.equal(typeof classify, 'function')
  const lean = await readFile(resolve(process.cwd(), 'crew/lean.mjs'), 'utf8')
  // Pin the actual runSeat call, not a second classifier hidden in this gate.
  wired = /const\s+kind\s*=\s*acpProviderFailureKind\(\s*turn(?:\?\.|\.)refusal(?:\?\.|\.)errorKind\s*,\s*turn(?:\?\.|\.)refusal(?:\?\.|\.)errorMessage\s*,?\s*\)/.test(lean)
} catch (error) {
  for (const id of ids) failures.set(id, `cannot load cwd implementation: ${error.message}`)
}

const overload = 'Codex error: Our servers are currently overloaded. Please try again later.'
const usage = 'Codex error: The usage limit has been reached'
const checks = {
  PK1() {
    assert.equal(classify('pi-agent-error', overload), 'server_error')
  },
  PK2() {
    assert.equal(classify('pi-agent-error', usage), 'rate_limit')
  },
  PK3() {
    for (const message of ['unrecognised provider failure', 'WebSocket error', '', undefined, null, 429, {}]) {
      assert.equal(classify('pi-agent-error', message), null)
    }
    assert.equal(classify('unknown-kind', overload), null)
    assert.equal(classify('unknown-kind', usage), null)
  },
}
for (const id of ids) {
  if (failures.has(id)) continue
  try {
    checks[id]()
    assert.ok(wired, 'runSeat must forward refusal.errorKind and refusal.errorMessage to the classifier')
  } catch (error) {
    failures.set(id, error.message)
  }
}
for (const [id, why] of failures) console.log(`FAIL ${id}: ${String(why).replace(/\s+/g, ' ')}`)
process.exitCode = failures.size ? 1 : 0
