import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Independent behavioral gate: real lean launch, real plugin commands, no agent/model.
const repo = resolve(process.cwd())
const artifacts = dirname(fileURLToPath(import.meta.url))
const assets = '/Users/momoshell/.crew/briefs/assets'
const ids = ['CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6']
let runner, captures, transcript, table, setupError
try {
  runner = (await import(pathToFileURL(join(repo, 'crew/acp/seat.mjs')).href)).runAcpSeat
  captures = readFileSync(join(assets, 'b1386-hook-captures.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  transcript = readFileSync(join(assets, 'b1386-transcript.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  table = JSON.parse(readFileSync(join(repo, 'crew/pi/extensions/reminders.json'), 'utf8'))
} catch (error) { setupError = error }
const copy = (v) => structuredClone(v)
const sample = (event, tool) => {
  const result = captures.find((r) => r.hook_event_name === event && (!tool || r.tool_name === tool))
  assert.ok(result, `missing recorded ${event}/${tool ?? ''}`)
  return copy(result)
}
const textLines = (s) => s === '' ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0)
const advisor = { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high' }

function sandbox() {
  const root = mkdtempSync(join(artifacts, 'gate-scratch-'))
  const cwd = join(root, 'checkout'), taskDir = join(root, 'task'), runtimeRoot = join(root, 'runtime')
  for (const p of [cwd, taskDir, runtimeRoot]) mkdirSync(p)
  // Real reminder rule sources remain readable; all mutable scenario files live in artifacts.
  for (const p of ['crew', 'test']) symlinkSync(join(repo, p), join(cwd, p), 'dir')
  const large = ['export function example() { return 1 }', ...Array.from({ length: 400 }, (_, i) => `// large line ${i + 2}`)].join('\n') + '\n'
  writeFileSync(join(cwd, 'large.mjs'), large)
  writeFileSync(join(cwd, 'a.txt'), 'alpha\nCOBALT-file-derived-sentinel\n')
  writeFileSync(join(cwd, 'gate.test.mjs'), "import { test } from 'node:test'\ntest('fixture', () => {})\n")
  const anchor = Date.now() - 60_000
  writeFileSync(join(taskDir, 'journal.jsonl'), JSON.stringify({ event: 'run-start', at: anchor, run_id: 'hook-gate' }) + '\n')
  writeFileSync(join(taskDir, 'plan.md'), '# plan\nRead large.mjs:1-2.\n')
  writeFileSync(join(taskDir, 'gate.mjs'), 'process.exitCode = 0\n')
  const details = {
    subject: 'test(crew): exercise Claude hooks', plan_path: join(taskDir, 'plan.md'), gate_path: join(taskDir, 'gate.mjs'),
    acceptance: ['CH1'], mutations: [{ check: 'CH1', file: 'large.mjs', find: 'return 1', replace: 'return 2' }],
    files_in_scope: ['large.mjs', 'a.txt', 'gate.test.mjs'], validation_lane: 'node --test gate.test.mjs', gate_cmd: `node ${join(taskDir, 'gate.mjs')}`,
  }
  const planner = join(taskDir, 'planner-1.json')
  writeFileSync(planner, JSON.stringify({ role: 'planner', id: 'gate.planner.1', status: 'done', summary: 'fixture', details }))
  utimesSync(planner, (anchor + 5000) / 1000, (anchor + 5000) / 1000)
  const transcriptPath = join(root, 'transcript.jsonl')
  writeFileSync(transcriptPath, '')
  const originalCwd = captures[0].cwd
  function relocate(value) {
    if (typeof value === 'string') return value.replaceAll(originalCwd, cwd).replaceAll('nonexistent-zzz', 'alpha\nmissing')
    if (Array.isArray(value)) return value.map(relocate)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, relocate(v)]))
    return value
  }
  const rows = transcript.map(relocate)
  const failedEdit = rows.findIndex((r) => Array.isArray(r.message?.content) && r.message.content.some((c) => c.type === 'tool_result' && c.is_error && String(c.content).includes('String to replace not found')))
  assert.ok(failedEdit > 0, 'recorded failed Edit is present')
  const frame = (event, tool) => {
    const r = sample(event, tool)
    r.cwd = cwd
    r.transcript_path = transcriptPath
    if (tool === 'Read') {
      r.tool_input.file_path = join(cwd, 'large.mjs')
      if (r.tool_response?.file) Object.assign(r.tool_response.file, { filePath: join(cwd, 'large.mjs'), content: large, numLines: 401, totalLines: 401 })
    }
    return r
  }
  const writeTranscript = (end) => writeFileSync(transcriptPath, rows.slice(0, end).map((r) => JSON.stringify(r)).join('\n') + '\n')
  return { root, cwd, taskDir, runtimeRoot, large, frame, rows, failedEdit, writeTranscript, transcriptPath,
    cleanup() { rmSync(root, { recursive: true, force: true }) } }
}

function seat(s, arms, inspect) {
  let launch, created = 0, inspected = false
  const result = runner({
    definition: { role: 'builder', agent: 'claude', model: 'anthropic/claude-opus-4-6', effort: 'high', writes: 'repo', skills: [], ...arms },
    cwd: s.cwd, taskDir: s.taskDir, prompt: 'ASSIGNMENT hook-gate: exercise arms', sessionFile: join(s.taskDir, 'session.jsonl'),
    binaries: { claudeAcp: process.execPath, claude: process.execPath },
    deps: { root: repo, env: { PATH: process.env.PATH }, runtimeRoot: s.runtimeRoot,
      clientFactory(input) {
        created += 1
        launch = input.launch
        return { start() {}, initialize() {}, newSession() {}, setMode() {}, beginPrompt() { return 1 },
          pollPrompt() { inspected = true; inspect?.(launch); return { stopReason: 'end_turn', refusal: null } },
          close() { return { outcome: 'proven' } },
        }
      },
    },
  })
  assert.equal(created, 1)
  assert.ok(inspected)
  assert.equal(result.stopReason, 'end_turn')
  return launch
}

function hooksFor(launch, event) {
  const hooks = []
  for (const plugin of launch.sessionParams?._meta?.claudeCode?.options?.plugins ?? []) {
    assert.equal(plugin.type, 'local')
    assert.ok(existsSync(join(plugin.path, '.claude-plugin/plugin.json')), 'materialized plugin manifest')
    const manifest = JSON.parse(readFileSync(join(plugin.path, '.claude-plugin/plugin.json'), 'utf8'))
    let config
    if (manifest.hooks && typeof manifest.hooks === 'object') config = manifest.hooks
    else {
      const p = typeof manifest.hooks === 'string'
        ? resolve(plugin.path, manifest.hooks.replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin.path))
        : join(plugin.path, 'hooks/hooks.json')
      if (!existsSync(p)) continue // a skills-only plugin
      config = JSON.parse(readFileSync(p, 'utf8'))
    }
    for (const entry of (config.hooks ?? config)[event.hook_event_name] ?? []) {
      if (entry.matcher && !new RegExp(`^(?:${entry.matcher === '*' ? '.*' : entry.matcher})$`).test(event.tool_name ?? event.source ?? '')) continue
      for (const hook of entry.hooks ?? []) {
        assert.equal(hook.type, 'command', 'arms are process hooks')
        hooks.push({ command: hook.command, root: plugin.path })
      }
    }
  }
  return hooks
}
function fire(s, launch, event, raw) {
  const outputs = []
  for (const hook of hooksFor(launch, event)) {
    const result = spawnSync('/bin/sh', ['-c', hook.command], {
      cwd: s.cwd,
      env: { ...process.env, CREW_ADVISOR: '0', CREW_EDIT_ASSIST: 'off', CREW_READGATE_MAX_LINES: '350', ...launch.env, CLAUDE_PLUGIN_ROOT: hook.root },
      input: raw ?? JSON.stringify(event), encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, `hook exit: ${result.stderr}`)
    const out = result.stdout.trim()
    if (!out) continue
    const parsed = JSON.parse(out)
    if (parsed.hookSpecificOutput) {
      assert.equal(parsed.hookSpecificOutput.hookEventName, event.hook_event_name)
      outputs.push(parsed.hookSpecificOutput)
    } else assert.deepEqual(parsed, {}, 'a no-op must not change the turn')
    assert.notEqual(parsed.decision, 'block', 'no turn-blocking generic hook decision')
    assert.notEqual(parsed.continue, false, 'no aborting the seat')
  }
  return outputs
}
const contexts = (out) => out.map((o) => o.additionalContext ?? '').join('\n')
const denial = (out) => out.find((o) => o.permissionDecision === 'deny')
const rewrite = (out) => out.findLast((o) => Object.hasOwn(o, 'updatedToolOutput'))?.updatedToolOutput
function noEffect(out) {
  for (const effect of out) assert.equal(effect.permissionDecision, undefined)
  assert.equal(rewrite(out), undefined)
  assert.equal(contexts(out).trim(), '')
}
function inSandbox(fn) { const s = sandbox(); try { fn(s) } finally { s.cleanup() } }
function lacksContext(arms) {
  inSandbox((s) => {
    rmSync(join(s.taskDir, 'planner-1.json'))
    let created = false
    assert.throws(() => runner({
      definition: { role: 'builder', agent: 'claude', model: 'anthropic/claude-opus-4-6', effort: 'high', writes: 'repo', ...arms },
      cwd: s.cwd, taskDir: s.taskDir, prompt: 'fixture', sessionFile: join(s.taskDir, 'session.jsonl'),
      binaries: { claude: process.execPath, claudeAcp: process.execPath },
      deps: { runtimeRoot: s.runtimeRoot, clientFactory() { created = true; throw new Error('should not boot') } },
    }), { reason: 'grant-unsupported' })
    assert.equal(created, false, 'context preflight happens before client construction')
  })
}

const checks = {
  CH1() {
    inSandbox((s) => {
      seat(s, { extensions: ['readgate'] }, (launch) => {
        const pre = s.frame('PreToolUse', 'Read')
        const d = denial(fire(s, launch, pre))
        assert.ok(d, 'granted readgate must deny a large whole-file read')
        assert.match(d.permissionDecisionReason, /^Refusing whole-file read of /)
        assert.match(d.permissionDecisionReason, /401 lines exceeds threshold 350/)
        assert.match(d.permissionDecisionReason, /ranged read/)
        const ranged = copy(pre); ranged.tool_input.offset = 1; ranged.tool_input.limit = 2
        assert.equal(denial(fire(s, launch, ranged)), undefined)
        const missing = copy(pre); missing.tool_input.file_path = join(s.cwd, 'missing.mjs')
        noEffect(fire(s, launch, missing))
        noEffect(fire(s, launch, pre, '{malformed'))
      })
      seat(s, {}, (launch) => noEffect(fire(s, launch, s.frame('PreToolUse', 'Read'))))
    })
  },
  CH2() {
    inSandbox((s) => {
      seat(s, { extensions: ['skeletonread'] }, (launch) => {
        const post = s.frame('PostToolUse', 'Read')
        const r = rewrite(fire(s, launch, post))
        assert.ok(r && typeof r === 'object', 'skeleton must replace Read with an object')
        assert.equal(r.type, post.tool_response.type)
        assert.equal(r.file.filePath, post.tool_response.file.filePath)
        assert.equal(r.file.startLine, post.tool_response.file.startLine)
        assert.match(r.file.content, /^Skeleton read: large\.mjs/m)
        assert.match(r.file.content, /example/)
        assert.match(r.file.content, /large\.mjs:1-2/)
        assert.notEqual(r.file.content, s.large)
        assert.equal(r.file.numLines, textLines(r.file.content))
        assert.equal(r.file.totalLines, textLines(r.file.content))
        const ranged = copy(post); ranged.tool_input.offset = 1; ranged.tool_input.limit = 2
        assert.equal(rewrite(fire(s, launch, ranged)), undefined)
        const missing = copy(post); missing.tool_input.file_path = join(s.cwd, 'missing.mjs')
        assert.equal(rewrite(fire(s, launch, missing)), undefined)
      })
      seat(s, {}, (launch) => noEffect(fire(s, launch, s.frame('PostToolUse', 'Read'))))
    })
    lacksContext({ extensions: ['skeletonread'] })
  },
  CH3() {
    inSandbox((s) => {
      const fail = (launch, ordinal) => {
        const pre = s.frame('PreToolUse', 'Bash'), post = s.frame('PostToolUse', 'Bash')
        for (const r of [pre, post]) { r.tool_use_id = `gate-bash-${ordinal}`; r.tool_input.command = 'node --test gate.test.mjs' }
        // Clone the recorded Bash frame; vary result data, not the protocol envelope.
        Object.assign(post.tool_response, { stdout: 'not ok 1 - hook gate repeated failure\n', stderr: 'Error: hook gate repeated failure\n', exitCode: 1 })
        fire(s, launch, pre)
        return contexts(fire(s, launch, post))
      }
      seat(s, { advisor }, (launch) => {
        assert.doesNotMatch(fail(launch, 1), /Repeated validation failure/)
        assert.match(fail(launch, 2), /Repeated validation failure/)
        assert.doesNotMatch(fail(launch, 3), /Repeated validation failure/)
      })
      seat(s, {}, (launch) => {
        assert.doesNotMatch(fail(launch, 4), /Repeated validation failure/)
        assert.doesNotMatch(fail(launch, 5), /Repeated validation failure/)
      })
    })
    lacksContext({ advisor })
  },
  CH4() {
    inSandbox((s) => {
      seat(s, { extensions: ['builderloop'], edit_assist: true }, (launch) => {
        s.writeTranscript(s.failedEdit)
        const next = s.frame('PreToolUse', 'Bash'); next.tool_input.command = 'echo ok'
        assert.doesNotMatch(contexts(fire(s, launch, next)), /COBALT-file-derived-sentinel/)
        s.writeTranscript(s.failedEdit + 1)
        next.tool_use_id = 'next-after-failed-edit'
        const hint = contexts(fire(s, launch, next))
        assert.match(hint, /COBALT-file-derived-sentinel/, 'hint must contain current file text absent from transcript')
        assert.match(hint, /alpha/)
        next.tool_use_id = 'following-tool'
        assert.doesNotMatch(contexts(fire(s, launch, next)), /COBALT-file-derived-sentinel/, 'failed Edit hinted only once')
      })
      seat(s, { extensions: ['builderloop'], edit_assist: false }, (launch) => {
        s.writeTranscript(s.failedEdit + 1)
        assert.doesNotMatch(contexts(fire(s, launch, s.frame('PreToolUse', 'Bash'))), /COBALT-file-derived-sentinel/)
      })
    })
    lacksContext({ extensions: ['builderloop'], edit_assist: true })
  },
  CH5() {
    inSandbox((s) => {
      const expected = table.rules.filter((r) => r.roles.includes('builder')).map((r) => r.reminder)
      assert.ok(expected.length)
      seat(s, { extensions: ['reminders'] }, (launch) => {
        const context = contexts(fire(s, launch, s.frame('SessionStart')))
        for (const reminder of expected) assert.ok(context.includes(reminder), `missing shared reminder: ${reminder}`)
        noEffect(fire(s, launch, s.frame('SessionStart'), '{malformed'))
      })
      seat(s, {}, (launch) => noEffect(fire(s, launch, s.frame('SessionStart'))))
    })
  },
  CH6() {
    inSandbox((s) => {
      let constructed = 0
      assert.throws(() => runner({
        definition: { role: 'builder', agent: 'claude', model: 'anthropic/claude-opus-4-6', effort: 'high', writes: 'repo', extensions: ['subagent'] },
        cwd: s.cwd, taskDir: s.taskDir, prompt: 'fixture', sessionFile: join(s.taskDir, 'session.jsonl'),
        binaries: { claude: process.execPath, claudeAcp: process.execPath },
        deps: { root: repo, runtimeRoot: s.runtimeRoot, clientFactory() { constructed += 1; throw new Error('subagent launched') } },
      }), { reason: 'grant-unsupported' })
      assert.equal(constructed, 0, 'subagent must refuse before constructing a client')
    })
  },
}

let failed = false
for (const id of ids) {
  try {
    if (setupError) throw setupError
    checks[id]()
  } catch (error) {
    failed = true
    const message = String(error?.message ?? error).split('\n')[0].replace(/\s+/g, ' ')
    console.log(`FAIL ${id}: ${message}`)
  }
}
process.exitCode = failed ? 1 : 0
