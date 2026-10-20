import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, scratchDir } from '../test/helpers.mjs'

// Kill mutation: replace the final existsSync(..., false) with true and this
// guard accepts a leaked crew-rpc instead of failing.
test('seat runtime suites leave no crew-rpc entry under a fresh TMPDIR', () => {
  const scratch = scratchDir('seat-runtime-tmpdir-')
  try {
    const env = { ...process.env, TMPDIR: scratch, NO_COLOR: '1' }
    delete env.FORCE_COLOR
    delete env.CLICOLOR_FORCE
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'crew/acp-client.test.mjs', 'crew/headless-rpc.test.mjs', 'crew/seat-io-acp.test.mjs'], { cwd: ROOT, env, timeout: 600000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const out = String(result.stdout || '') + String(result.stderr || '')
    const tail = out.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-6).join(' | ')
    const spawnProblem = result.error ? ` error ${result.error.code || result.error.message}` : ''
    assert.equal(result.status, 0, `expected nested suites to exit 0, found status ${String(result.status)}${spawnProblem}: ${tail}`)
    assert.equal(existsSync(join(scratch, 'crew-rpc')), false)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
