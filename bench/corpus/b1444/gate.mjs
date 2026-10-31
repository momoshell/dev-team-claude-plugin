import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Resolve all code under test from the checkout the loop selected, never this artifact's location.
const root = process.cwd()
const ids = ['SR1', 'SR2', 'SR3', 'SR4', 'SR5']
const failed = new Map()
let scratch
try {
  const { writeArmsPlugin } = await import(pathToFileURL(join(root, 'crew/adapters/claude-arms.mjs')).href)
  scratch = mkdtempSync(join(tmpdir(), 'claude-read-steering-gate-'))
  const plugins = new Map()
  let sequence = 0
  function fire(arms, command) {
    const key = arms.join('-')
    if (!plugins.has(key)) {
      plugins.set(key, writeArmsPlugin({ taskDir: join(scratch, key), role: 'builder', arms, cwd: root }))
    }
    const plugin = plugins.get(key)
    const hooks = JSON.parse(readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8')).hooks.PreToolUse
    assert.ok(Array.isArray(hooks) && hooks.length, `${key} must register PreToolUse`)
    const outputs = []
    const payload = JSON.stringify({
      session_id: `steering-${++sequence}`, hook_event_name: 'PreToolUse', cwd: root,
      tool_name: 'Bash', tool_use_id: `bash-${sequence}`, tool_input: { command },
    })
    for (const entry of hooks) for (const hook of entry.hooks ?? []) {
      assert.equal(hook.type, 'command')
      const result = spawnSync('/bin/sh', ['-c', hook.command], {
        cwd: root, input: payload, encoding: 'utf8', timeout: 20000,
        env: { ...process.env, CREW_ROLE: 'builder' },
      })
      assert.ifError(result.error)
      assert.equal(result.status, 0, result.stderr)
      if (result.stdout.trim()) {
        const output = JSON.parse(result.stdout).hookSpecificOutput
        assert.equal(output?.hookEventName, 'PreToolUse')
        outputs.push(output)
      }
    }
    return outputs.find((out) => out.permissionDecision === 'deny')
  }
  function denied(arms, command, ranged = false) {
    const output = fire(arms, command)
    assert.ok(output, `expected refusal: ${arms}: ${command}`)
    assert.match(output.permissionDecisionReason, /\bRead tool\b/)
    if (ranged) {
      assert.match(output.permissionDecisionReason, /\boffset\b/i)
      assert.match(output.permissionDecisionReason, /\blimit\b/i)
    }
  }
  const rangedCommand = 'cd T; sed -n 95,125p crew/loop.mjs'
  const writeCommand = "cat > task/builder-2.json <<'EOF'\n{\"role\":\"builder\",\"summary\":\"cat task/plan.md; sed -n 1,2p crew/loop.mjs\"}\nEOF"
  const checks = {
    SR1() {
      for (const arm of ['readgate', 'skeletonread']) denied([arm], rangedCommand, true)
    },
    SR2() {
      for (const arm of ['readgate', 'skeletonread']) denied([arm], 'cat task/plan.md; ls task')
    },
    SR3() {
      for (const arm of ['readgate', 'skeletonread']) {
        assert.equal(fire([arm], 'node ../task/gate.mjs 2>&1 | tail -20'), undefined, 'stdin tail is not a file read')
      }
    },
    SR4() {
      for (const arm of ['readgate', 'skeletonread']) {
        assert.equal(fire([arm], writeCommand), undefined, 'heredoc writer is not a file read')
      }
    },
    SR5() {
      // builderloop registers PreToolUse but grants neither reading arm: exercise dispatch, not an absent hook.
      assert.equal(fire(['builderloop'], rangedCommand), undefined, 'ungranted steering must not refuse')
    },
  }
  for (const id of ids) {
    try { checks[id]() } catch (error) { failed.set(id, error.message) }
  }
} catch (error) {
  for (const id of ids) if (!failed.has(id)) failed.set(id, error.message)
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
}
for (const id of ids) if (failed.has(id)) {
  console.log(`FAIL ${id}: ${String(failed.get(id)).replace(/[\r\n]+/g, ' ').slice(0, 500)}`)
}
process.exitCode = failed.size ? 1 : 0
