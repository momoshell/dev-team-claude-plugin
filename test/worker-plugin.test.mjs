import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'

const pluginJsonPath = join(ROOT, 'scripts/cmux/worker-plugin/.claude-plugin/plugin.json')
const hooksJsonPath = join(ROOT, 'scripts/cmux/worker-plugin/hooks/hooks.json')
const repoPluginJsonPath = join(ROOT, '.claude-plugin/plugin.json')

const pluginJsonRaw = readFileSync(pluginJsonPath, 'utf8')
const hooksJsonRaw = readFileSync(hooksJsonPath, 'utf8')

test('hooks.json parses and has exactly Stop and UserPromptSubmit, one command each', () => {
  const hooks = JSON.parse(hooksJsonRaw)
  const eventNames = Object.keys(hooks.hooks)
  assert.deepEqual(eventNames.sort(), ['Stop', 'UserPromptSubmit'])

  for (const event of eventNames) {
    assert.equal(hooks.hooks[event].length, 1, `${event} should have exactly one hook group`)
    assert.equal(hooks.hooks[event][0].hooks.length, 1, `${event} should have exactly one command`)
  }
})

test('Stop -> return-gate.sh, UserPromptSubmit -> gate-mode.sh via ${CLAUDE_PLUGIN_ROOT}', () => {
  const hooks = JSON.parse(hooksJsonRaw)
  const stopCommand = hooks.hooks.Stop[0].hooks[0].command
  const promptCommand = hooks.hooks.UserPromptSubmit[0].hooks[0].command

  const stopMatch = stopCommand.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([^"'\s]+\.sh)/)
  const promptMatch = promptCommand.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([^"'\s]+\.sh)/)

  assert.ok(stopMatch, 'Stop command must reference ${CLAUDE_PLUGIN_ROOT}/hooks/<script>.sh')
  assert.ok(promptMatch, 'UserPromptSubmit command must reference ${CLAUDE_PLUGIN_ROOT}/hooks/<script>.sh')
  assert.equal(stopMatch[1], 'return-gate.sh')
  assert.equal(promptMatch[1], 'gate-mode.sh')
})

test('plugin.json parses and has a name distinct from the repo\'s own plugin.json', () => {
  const workerPlugin = JSON.parse(pluginJsonRaw)
  const repoPlugin = JSON.parse(readFileSync(repoPluginJsonPath, 'utf8'))

  assert.ok(workerPlugin.name, 'worker plugin.json must have a name')
  assert.notEqual(workerPlugin.name, repoPlugin.name)
})

test('byte-stability: no dispatch-specific values leaked into either manifest', () => {
  const files = [pluginJsonRaw, hooksJsonRaw]
  const forbiddenSubstrings = ['devteam-', '/Users/', '/tmp/']
  const yearRe = /\b\d{4}\b/
  const uuidRe = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/

  for (const raw of files) {
    for (const needle of forbiddenSubstrings) {
      assert.ok(!raw.includes(needle), `must not contain "${needle}"`)
    }
    assert.ok(!yearRe.test(raw), 'must not contain a 4-digit year')
    assert.ok(!uuidRe.test(raw), 'must not contain a UUID-shaped token')
  }
})
