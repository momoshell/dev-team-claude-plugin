import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, appendFileSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ROOT, git, scratchDir } from '../../test/helpers.mjs'
import { runAcpSeat } from '../acp/seat.mjs'
import { acpLaunch, headlessCommand, seatCommand, writeSeatArms } from './adapter-claude.mjs'
import { CLAUDE_ARMS, armsPluginDir, claudeArmsOf, failedEdits, runHook, writeArmsPlugin } from './claude-arms.mjs'

// Every frame below is a recorded Claude Code hook input (or the session transcript) cloned with only scenario data
// changed: paths, tool ids, sizes and failure output. The hooks run as the real commands the plugin names, one process each.
const fixtureLines = (name) => readFileSync(join(ROOT, 'test', 'fixtures', 'acp', name), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
const CAPTURES = fixtureLines('claude-hooks.jsonl')
const TRANSCRIPT = fixtureLines('claude-hook-transcript.jsonl')
const ADVISOR = { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high' }
// Claude counts a newline-terminated text one line more (the recorded Read responses: 'alpha\n' is 2 lines, fifty lines are 51).
const textLines = (text) => text.split('\n').length

function sandbox({ links = true } = {}) {
  const root = scratchDir('claude-arms-')
  const cwd = join(root, 'checkout')
  const taskDir = join(root, 'task')
  const runtimeRoot = join(root, 'runtime')
  for (const dir of [cwd, taskDir, runtimeRoot]) mkdirSync(dir)
  // The reminders table checks its sources in the checkout it runs in.
  if (links) for (const dir of ['crew', 'test']) symlinkSync(join(ROOT, dir), join(cwd, dir), 'dir')
  const large = ['export function example() { return 1 }', ...Array.from({ length: 400 }, (_, i) => `// large line ${i + 2}`)].join('\n') + '\n'
  writeFileSync(join(cwd, 'large.mjs'), large)
  writeFileSync(join(cwd, 'other.mjs'), large)
  writeFileSync(join(cwd, 'a.txt'), 'alpha\nCOBALT-file-derived-sentinel\n')
  writeFileSync(join(cwd, 'gate.test.mjs'), "import { test } from 'node:test'\ntest('fixture', () => {})\n")
  const anchor = Date.now() - 60_000
  writeFileSync(join(taskDir, 'journal.jsonl'), `${JSON.stringify({ event: 'run-start', at: anchor, run_id: 'hook-run' })}\n`)
  writeFileSync(join(taskDir, 'plan.md'), '# plan\nRead large.mjs:1-2.\n')
  writeFileSync(join(taskDir, 'gate.mjs'), 'process.exitCode = 0\n')
  const details = {
    subject: 'test(crew): exercise Claude hooks', plan_path: join(taskDir, 'plan.md'), gate_path: join(taskDir, 'gate.mjs'), acceptance: ['CH1'],
    mutations: [{ check: 'CH1', file: 'large.mjs', find: 'return 1', replace: 'return 2' }], files_in_scope: ['large.mjs', 'a.txt', 'gate.test.mjs'],
    validation_lane: 'node --test gate.test.mjs', gate_cmd: `node ${join(taskDir, 'gate.mjs')}`,
  }
  const planner = join(taskDir, 'planner-1.json')
  writeFileSync(planner, JSON.stringify({ role: 'planner', id: 'hook.planner.1', status: 'done', summary: 'fixture', details }))
  utimesSync(planner, (anchor + 5000) / 1000, (anchor + 5000) / 1000)
  const transcriptPath = join(root, 'transcript.jsonl')
  writeFileSync(transcriptPath, '')
  const recordedCwd = CAPTURES[0].cwd
  const relocate = (value) => {
    if (typeof value === 'string') return value.replaceAll(recordedCwd, cwd).replaceAll('nonexistent-zzz', 'alpha\nmissing')
    if (Array.isArray(value)) return value.map(relocate)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item)]))
    return value
  }
  const rows = TRANSCRIPT.map(relocate)
  const failedEdit = rows.findIndex((row) => Array.isArray(row.message?.content) && row.message.content.some((block) => block.type === 'tool_result' && block.is_error))
  assert.ok(failedEdit > 0, 'the recorded failed Edit is present')
  const frame = (event, tool, session = null) => {
    const record = structuredClone(CAPTURES.find((row) => row.hook_event_name === event && (!tool || row.tool_name === tool)))
    assert.ok(record, `recorded ${event}/${tool}`)
    record.cwd = cwd
    record.transcript_path = transcriptPath
    if (session) record.session_id = session
    if (tool === 'Read') {
      record.tool_input.file_path = join(cwd, 'large.mjs')
      if (record.tool_response?.file) Object.assign(record.tool_response.file, { filePath: join(cwd, 'large.mjs'), content: large, numLines: 401, totalLines: 401 })
    }
    return record
  }
  return {
    root, cwd, taskDir, runtimeRoot, large, frame, rows, failedEdit, transcriptPath, journal: join(taskDir, 'journal.jsonl'),
    writeTranscript(end) { writeFileSync(transcriptPath, rows.slice(0, end).map((row) => JSON.stringify(row)).join('\n') + '\n') },
    stateFiles() { try { return readdirSync(join(taskDir, 'claude-arms')).flatMap((seat) => readdirSync(join(taskDir, 'claude-arms', seat)).filter((name) => name.endsWith('.json')).map((name) => join(taskDir, 'claude-arms', seat, name))) } catch { return [] } },
  }
}

const definitionOf = (arms, role = 'builder') => ({ role, agent: 'claude', model: 'anthropic/claude-opus-4-6', effort: 'high', writes: role === 'builder' ? 'repo' : 'task-dir', skills: [], ...arms })

// A real lean launch with a recording client. The runtime is kept (an unproven close), so the hooks stay runnable.
function seat(sb, arms, { role = 'builder', ...options } = {}) {
  let launch = null
  let created = 0
  runAcpSeat({
    definition: definitionOf(arms, role), cwd: sb.cwd, taskDir: sb.taskDir, prompt: 'ASSIGNMENT hook: exercise arms', sessionFile: join(sb.taskDir, 'session.jsonl'),
    binaries: { claudeAcp: process.execPath, claude: process.execPath },
    deps: {
      root: ROOT, env: { PATH: process.env.PATH }, runtimeRoot: sb.runtimeRoot, ...options.deps,
      clientFactory(input) {
        created += 1
        launch = input.launch
        return { start() {}, initialize() {}, newSession() {}, setMode() {}, beginPrompt() { return 1 }, pollPrompt() { return { stopReason: 'end_turn', refusal: null } }, close() { return { outcome: 'unproven' } } }
      },
    },
  })
  assert.equal(created, 1)
  return launch
}

function refused(sb, arms, { role = 'builder', ...options } = {}) {
  let created = 0
  assert.throws(() => runAcpSeat({
    definition: definitionOf(arms, role), cwd: sb.cwd, taskDir: sb.taskDir, prompt: 'p', sessionFile: join(sb.taskDir, 'session.jsonl'),
    binaries: { claudeAcp: process.execPath, claude: process.execPath },
    deps: { root: ROOT, env: { PATH: process.env.PATH }, runtimeRoot: sb.runtimeRoot, ...options.deps, clientFactory() { created += 1; throw new Error('client constructed') } },
  }), { reason: 'grant-unsupported' }, JSON.stringify(arms))
  assert.equal(created, 0, 'a refused seat constructs no client')
}

const pluginsOf = (launch) => launch.sessionParams._meta.claudeCode.options.plugins ?? []
function commandsFor(launch, eventName) {
  const commands = []
  for (const plugin of pluginsOf(launch)) {
    const file = join(plugin.path, 'hooks', 'hooks.json')
    if (!existsSync(file)) continue
    for (const entry of JSON.parse(readFileSync(file, 'utf8')).hooks[eventName] ?? []) for (const hook of entry.hooks) commands.push(hook.command)
  }
  return commands
}
const hookEnv = (launch, extra = {}) => ({ ...process.env, ...launch.env, ...extra })
function fire(sb, launch, event, { raw, env } = {}) {
  const outputs = []
  for (const command of commandsFor(launch, event.hook_event_name)) {
    const result = spawnSync('/bin/sh', ['-c', command], { cwd: sb.cwd, env: hookEnv(launch, env), input: raw ?? JSON.stringify(event), encoding: 'utf8', timeout: 20_000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, `a hook always exits 0: ${result.stderr}`)
    if (!result.stdout.trim()) continue
    const parsed = JSON.parse(result.stdout)
    assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput'], 'the only output is the hook-specific one')
    assert.equal(parsed.hookSpecificOutput.hookEventName, event.hook_event_name)
    outputs.push(parsed.hookSpecificOutput)
  }
  return outputs
}
const contexts = (outputs) => outputs.map((output) => output.additionalContext ?? '').join('\n')
const denial = (outputs) => outputs.find((output) => output.permissionDecision === 'deny')
const replacement = (outputs) => outputs.findLast((output) => Object.hasOwn(output, 'updatedToolOutput'))?.updatedToolOutput
function assertNoEffect(outputs) {
  assert.deepEqual(outputs, [])
}

test('CH1 a claude seat granted readgate gets readgate\'s own refusal for a read it refuses, and nothing else', () => {
  const sb = sandbox()
  const launch = seat(sb, { extensions: ['readgate'] })
  const pre = sb.frame('PreToolUse', 'Read')
  const denied = denial(fire(sb, launch, pre))
  assert.ok(denied, 'a whole-file read above the threshold is denied')
  assert.match(denied.permissionDecisionReason, /^Refusing whole-file read of .*large\.mjs: 401 lines exceeds threshold 350\. Use a ranged read/)
  const ranged = structuredClone(pre); Object.assign(ranged.tool_input, { offset: 1, limit: 2 }); ranged.tool_use_id = 'toolu_ranged'
  assertNoEffect(fire(sb, launch, ranged))
  const small = structuredClone(pre); small.tool_input.file_path = join(sb.cwd, 'a.txt')
  assertNoEffect(fire(sb, launch, small))
  const missing = structuredClone(pre); missing.tool_input.file_path = join(sb.cwd, 'missing.mjs')
  assertNoEffect(fire(sb, launch, missing))
  // The shell reads the gate also refuses are refused through the same arm.
  const cat = sb.frame('PreToolUse', 'Bash'); cat.tool_input.command = 'cat large.mjs'
  assert.match(denial(fire(sb, launch, cat)).permissionDecisionReason, /^Refusing/)
  // Not granted: no plugin, so nothing can run.
  const bare = seat(sandbox(), {})
  assert.deepEqual(pluginsOf(bare), [])
})

test('CH1 readgate remembers a delivered range across hook processes and refuses the repeat', () => {
  const sb = sandbox()
  const launch = seat(sb, { extensions: ['readgate'] })
  const range = (id) => { const pre = sb.frame('PreToolUse', 'Read'); Object.assign(pre.tool_input, { offset: 1, limit: 2 }); pre.tool_use_id = id; return pre }
  assertNoEffect(fire(sb, launch, range('toolu_first')))
  const post = sb.frame('PostToolUse', 'Read')
  Object.assign(post.tool_input, { offset: 1, limit: 2 }); post.tool_use_id = 'toolu_first'
  Object.assign(post.tool_response.file, { content: 'export function example() { return 1 }\n// large line 2\n', numLines: 2, startLine: 1 })
  assertNoEffect(fire(sb, launch, post))
  assert.match(denial(fire(sb, launch, range('toolu_second'))).permissionDecisionReason, /^Refusing repeated read of .*range 1-2/)
})

test('CH2 a claude seat granted skeletonread gets the skeleton in Read\'s own output shape', () => {
  const sb = sandbox()
  const launch = seat(sb, { extensions: ['skeletonread'] })
  const post = sb.frame('PostToolUse', 'Read')
  for (const recorded of CAPTURES.filter((row) => row.hook_event_name === 'PostToolUse' && row.tool_response?.file)) {
    assert.equal(recorded.tool_response.file.numLines, textLines(recorded.tool_response.file.content), 'the count convention is the recorded one')
  }
  const replaced = replacement(fire(sb, launch, post))
  assert.equal(typeof replaced, 'object', 'a string would be dropped silently')
  assert.deepEqual(Object.keys(replaced), Object.keys(post.tool_response))
  assert.deepEqual(Object.keys(replaced.file), Object.keys(post.tool_response.file))
  assert.equal(replaced.type, post.tool_response.type)
  assert.equal(replaced.file.filePath, post.tool_response.file.filePath)
  assert.equal(replaced.file.startLine, post.tool_response.file.startLine)
  assert.match(replaced.file.content, /^Skeleton read: large\.mjs/m)
  assert.match(replaced.file.content, /large\.mjs:1-2/)
  assert.match(replaced.file.content, /^Retrieve usage: this seat has no retrieve tool; read the lines you need with the Read tool/m)
  assert.doesNotMatch(replaced.file.content, /retrieve\(/)
  assert.ok(replaced.file.content.length < sb.large.length)
  assert.equal(replaced.file.numLines, textLines(replaced.file.content))
  assert.equal(replaced.file.totalLines, textLines(replaced.file.content))
  assert.equal(post.tool_response.file.content, sb.large, 'the recorded response is cloned, not edited')
  // Not replaced: a ranged read, a file outside the fence, a small file, a missing one and output that is not text.
  const ranged = structuredClone(post); Object.assign(ranged.tool_input, { offset: 1, limit: 2 })
  const outside = structuredClone(post); outside.tool_input.file_path = join(sb.cwd, 'other.mjs')
  const small = structuredClone(post); small.tool_input.file_path = join(sb.cwd, 'a.txt')
  unlinkSync(join(sb.cwd, 'gate.test.mjs'))
  const missing = structuredClone(post); missing.tool_input.file_path = join(sb.cwd, 'gate.test.mjs')
  const image = structuredClone(post); image.tool_response.type = 'image'
  for (const frame of [ranged, outside, small, missing, image]) assert.equal(replacement(fire(sb, launch, frame)), undefined, JSON.stringify(frame.tool_input))
  // A builder-only arm: another role's skeleton read is not rewritten.
  const planner = sandbox()
  assert.equal(replacement(fire(planner, seat(planner, { extensions: ['skeletonread'] }, { role: 'planner' }), planner.frame('PostToolUse', 'Read'))), undefined)
})

test('Bash literal reads share readgate coverage and skeletonread preserves Bash output', () => {
  const sb = sandbox()
  const gate = seat(sb, { extensions: ['readgate'] })
  const input = { command: "sed -n '1,2p' large.mjs" }
  const pre = sb.frame('PreToolUse', 'Bash', 'bash-range'); pre.tool_input = input; pre.tool_use_id = 'range'
  assert.match(denial(fire(sb, gate, pre)).permissionDecisionReason, /Read tool/)
  assert.match(denial(fire(sb, gate, pre)).permissionDecisionReason, /Read tool/)
  // Synthetic post remains supported for compatibility with previously executed calls.
  const post = sb.frame('PostToolUse', 'Bash', 'bash-range'); post.tool_input = input; post.tool_use_id = 'range'; post.tool_response.stdout = 'one\ntwo\n'; post.tool_response.stderr = ''
  assertNoEffect(fire(sb, gate, post))
  for (const command of ["sed -n '1,2p' large.mjs | cat", 'head -n2 large.mjs | cat', 'cat large.mjs | cat']) {
    pre.tool_input = { command }; assertNoEffect(fire(sb, gate, pre))
  }
  const skeleton = seat(sb, { extensions: ['skeletonread'] })
  const bash = sb.frame('PostToolUse', 'Bash'); bash.tool_input.command = 'cat large.mjs'; bash.tool_response.stdout = sb.large; bash.tool_response.stderr = ''
  const rewritten = replacement(fire(sb, skeleton, bash))
  assert.deepEqual(Object.keys(rewritten), Object.keys(bash.tool_response))
  assert.match(rewritten.stdout, /^Skeleton read: large\.mjs/m)
  assert.match(rewritten.stdout, /this seat has no retrieve tool/)
  for (const command of ['cat large.mjs | cat', 'cat large.mjs other.mjs', 'cat $(echo large.mjs)', 'head large.mjs']) {
    bash.tool_input.command = command; assert.equal(replacement(fire(sb, skeleton, bash)), undefined)
  }
  bash.tool_input.command = 'cat large.mjs'; bash.tool_response.stderr = 'diagnostic'
  assert.equal(replacement(fire(sb, skeleton, bash)), undefined)
})

test('Bash file segments are steered only for reading arms', () => {
  const sb = sandbox()
  const commands = [
    'cd T; sed -n 95,125p crew/loop.mjs', 'cat task/plan.md; ls task',
    'head -n 2 "a; b" && ls', 'ls || tail -20 file', 'echo ok\nnl -ba file',
    'cat a.txt | head -n 2 other.mjs', "printf '%s' x; sed -n '1,2p' file", 'sed -n 5p f; sed -n \'$p\' f',
    'echo ok; cat -- "a|b"', 'head -n 2 - < input; tail file',
    'cat a\\;b', "cat <<'EOF'\ndata\nEOF\nhead file",
    'cd T; (sed -n 95,125p crew/loop.mjs)', 'LC_ALL=C cat task/plan.md; ls task',
    '(LC_ALL=C head -qn 2 file)', 'cat f 2> errors',
    'cd T; { cat task/plan.md; }', '{ { head file; }; }',
    'if true; then cat crew/loop.mjs; fi', 'if cat first; then echo ok; elif head second; then tail third; else nl fourth; fi',
    'while true; do sed -n 1p file; done',
  ]
  const safe = [
    'node ../task/gate.mjs 2>&1 | tail -20', "cat > task/builder-2.json <<'EOF'\ncat secret\nsed -n 1p file\nEOF",
    'echo "cat file; sed -n 1p file"', 'echo ok # ; cat secret',
    'echo x | cat | head -n 2 | tail -20 | sed -n 1p | nl -ba',
    'cat < input', 'head --lines 2 < input', 'sed -n -e 1p < input', 'nl -w 2 < input',
    'tail -20 2>&10', 'echo cat\\;file',
    'printf x | head -qn 2', 'printf x | tail -qn 2',
    'printf x | head -qc 2', 'printf x | tail -qc 2',
    'echo "{ cat secret; }"', 'echo { cat secret; }', 'echo \\{; echo cat',
    'cat 123> output', 'cat "123"> output', 'cat \\123> output',
    // Fails open: output sent to a file, non-printing or -e/-f sed scripts and zero counts are not reads.
    'cat f | wc -l', 'cat f |& wc -l', 'head -n 5 f | grep x', 'cat source.txt > copy.txt', 'cat a >> b', 'cat a 1> b', 'cat f &> out', "sed -n 'd' source.txt",
    "sed -n -e '1,2p' file", "sed -n -e'l' crew/loop.mjs", 'sed -nel crew/loop.mjs', 'sed -ne l crew/loop.mjs',
    'tail -n 0 source.txt', 'head -n0 f', 'head --lines=0 f', 'tail -c 0 f',
    "printf 'x\\n' | sed -n -l 80 '1p'", "printf 'x\\n' | sed -n --line-length 80 '1p'",
    "printf 'x\\n' | sed -nl 80 '1p'", "echo 'then cat file'", "'then' cat file", 'echo then cat file',
  ]
  for (const arm of ['readgate', 'skeletonread']) {
    const launch = seat(sb, { extensions: [arm] })
    assert.equal(commandsFor(launch, 'PreToolUse').length, 1)
    const pre = sb.frame('PreToolUse', 'Bash', `segments-${arm}`)
    for (const command of commands) {
      pre.tool_input.command = command
      assert.match(denial(fire(sb, launch, pre))?.permissionDecisionReason ?? '', /Read tool.*offset.*limit/, command)
    }
    for (const command of safe) { pre.tool_input.command = command; assertNoEffect(fire(sb, launch, pre)) }
  }
  for (const grants of [{}, { extensions: ['builderloop'] }]) {
    const launch = seat(sb, grants)
    const pre = sb.frame('PreToolUse', 'Bash'); pre.tool_input.command = commands[0]
    assert.equal(denial(fire(sb, launch, pre)), undefined)
  }
})

test('CH2 a result-transforming arm keeps Bash\'s own output shape', () => {
  const sb = sandbox()
  const launch = seat(sb, { extensions: ['builderloop'] })
  const post = sb.frame('PostToolUse', 'Bash')
  post.tool_input.command = 'node --test gate.test.mjs'
  post.tool_response.stdout = '✔ one (0.5ms)\n✔ two (0.2ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0\n'
  const replaced = replacement(fire(sb, launch, post))
  assert.deepEqual(Object.keys(replaced), Object.keys(post.tool_response))
  assert.match(replaced.stdout, /^ℹ tests 2/)
  assert.match(replaced.stdout, /\[test output filtered: dropped 2 passing-test lines/)
  assert.doesNotMatch(replaced.stdout, /✔/)
  for (const key of ['interrupted', 'isImage', 'noOutputExpected']) assert.equal(replaced[key], post.tool_response[key])
  // Output no arm changes is left alone.
  const plain = sb.frame('PostToolUse', 'Bash')
  assert.equal(replacement(fire(sb, launch, plain)), undefined)
})

test('CH3 a claude seat granted an advisor gets the repeated-failure note once, across fresh processes', () => {
  const sb = sandbox()
  const launch = seat(sb, { advisor: ADVISOR })
  const fail = (id, { event = 'PostToolUse' } = {}) => {
    const pre = sb.frame('PreToolUse', 'Bash')
    pre.tool_use_id = id; pre.tool_input.command = 'node --test gate.test.mjs'
    fire(sb, launch, pre)
    const post = sb.frame(event, 'Bash')
    post.tool_use_id = id; post.tool_input.command = 'node --test gate.test.mjs'
    if (event === 'PostToolUse') Object.assign(post.tool_response, { stdout: 'not ok 1 - hook repeated failure\n', stderr: 'Error: hook repeated failure\n', exitCode: 1 })
    else { delete post.tool_response; post.hook_event_name = 'PostToolUseFailure'; post.error = 'Exit code 1\nnot ok 1 - hook repeated failure\n'; post.is_interrupt = false }
    return contexts(fire(sb, launch, post))
  }
  assert.doesNotMatch(fail('toolu_f1'), /Repeated validation failure/)
  const note = fail('toolu_f2')
  assert.match(note, /Repeated validation failure at hook repeated failure: hook repeated failure/)
  assert.doesNotMatch(fail('toolu_f3'), /Repeated validation failure/, 'the same failure is noted once')
  assert.ok(readFileSync(sb.journal, 'utf8').includes('advisor_note'), 'the note is journaled as pi journals it')
  // A failing call Claude reports as a tool failure counts the same.
  const second = sandbox()
  const other = seat(second, { advisor: ADVISOR })
  const failure = (id) => {
    const event = second.frame('PostToolUse', 'Bash')
    delete event.tool_response; Object.assign(event, { hook_event_name: 'PostToolUseFailure', tool_use_id: id, error: 'Exit code 1\nnot ok 1 - hook failure path\n', is_interrupt: false })
    event.tool_input.command = 'node --test gate.test.mjs'
    return contexts(fire(second, other, event))
  }
  assert.equal(failure('toolu_g1'), '')
  assert.match(failure('toolu_g2'), /Repeated validation failure/)
  // A healthy call, and a seat that was not granted the advisor, never get the note.
  const healthy = sb.frame('PostToolUse', 'Bash'); healthy.tool_input.command = 'node --test gate.test.mjs'
  assert.equal(contexts(fire(sb, launch, healthy)), '')
  const bare = sandbox()
  const ungranted = seat(bare, { extensions: ['reminders'] })
  for (const id of ['toolu_u1', 'toolu_u2']) {
    const post = bare.frame('PostToolUse', 'Bash'); post.tool_use_id = id
    Object.assign(post.tool_response, { stdout: 'not ok 1 - hook repeated failure\n', exitCode: 1 })
    assert.doesNotMatch(contexts(fire(bare, ungranted, post, { env: { CREW_ADVISOR: '1' } })), /Repeated validation failure/, 'an ambient flag grants nothing')
  }
})

test('CH4 a claude builder granted edit assist gets the file-derived hint on the call after a failed Edit, once', () => {
  const sb = sandbox()
  const launch = seat(sb, { extensions: ['builderloop'], edit_assist: true })
  const next = sb.frame('PreToolUse', 'Bash'); next.tool_input.command = 'echo ok'
  sb.writeTranscript(sb.failedEdit)
  assert.doesNotMatch(contexts(fire(sb, launch, next)), /COBALT/, 'no hint before the failed result exists')
  sb.writeTranscript(sb.failedEdit + 1)
  next.tool_use_id = 'toolu_after_failed_edit'
  const hint = contexts(fire(sb, launch, next))
  assert.match(hint, /COBALT-file-derived-sentinel/, 'the hint carries the current file text, which the transcript does not')
  assert.doesNotMatch(readFileSync(sb.transcriptPath, 'utf8'), /COBALT/)
  assert.match(hint, /Edit of .*a\.txt failed/)
  next.tool_use_id = 'toolu_following'
  assert.doesNotMatch(contexts(fire(sb, launch, next)), /COBALT/, 'one hint per failed tool call')
  assert.match(readFileSync(sb.journal, 'utf8'), /"builder_edit_failure":\{"cause":"never-seen".*"assist":"on"/, 'the failure is journaled as pi journals it')
  // Another seat in the same lane has its own record of what it hinted.
  const again = seat(sb, { extensions: ['builderloop'], edit_assist: true })
  next.tool_use_id = 'toolu_other_seat'
  assert.match(contexts(fire(sb, again, next)), /COBALT/)
})

test('CH4 edit assist off, ungranted and an unreadable transcript give no hint, and the failure is still journaled when off', () => {
  const sb = sandbox()
  sb.writeTranscript(sb.failedEdit + 1)
  const next = sb.frame('PreToolUse', 'Bash'); next.tool_input.command = 'echo ok'
  const off = seat(sb, { extensions: ['builderloop'], edit_assist: false })
  assert.doesNotMatch(contexts(fire(sb, off, next)), /COBALT/)
  assert.match(readFileSync(sb.journal, 'utf8'), /"assist":"off"/)
  const unset = seat(sandbox(), { extensions: ['builderloop'] })
  assert.deepEqual(JSON.parse(readFileSync(join(unset.sessionParams._meta.claudeCode.options.plugins[0].path, 'config.json'), 'utf8')).edit_assist, null)
  // Another arm alone does not run edit assist, whatever flag is ambient.
  const ungranted = seat(sandbox(), { extensions: ['readgate'] })
  assertNoEffect(fire(sb, ungranted, next, { env: { CREW_EDIT_ASSIST: 'on' } }))
  // No transcript, an unreadable one and a relative path are all no-ops.
  const granted = seat(sb, { extensions: ['builderloop'], edit_assist: true })
  for (const transcript_path of [join(sb.root, 'nowhere.jsonl'), sb.root, 'relative.jsonl', 7]) assertNoEffect(fire(sb, granted, { ...next, transcript_path }))
  // A builder-only arm.
  const planner = sandbox()
  planner.writeTranscript(planner.failedEdit + 1)
  assertNoEffect(fire(planner, seat(planner, { extensions: ['builderloop'], edit_assist: true }, { role: 'planner' }), planner.frame('PreToolUse', 'Bash')))
})

test('CH4 failedEdits pairs a failed Edit result with its input, once, and ignores every other failure', () => {
  const sb = sandbox()
  sb.writeTranscript(sb.failedEdit + 1)
  const [failure, ...rest] = failedEdits(sb.transcriptPath, [])
  assert.equal(rest.length, 0)
  assert.equal(failure.path, join(sb.cwd, 'a.txt'))
  assert.deepEqual(failure.event.input, { path: join(sb.cwd, 'a.txt'), edits: [{ oldText: 'alpha\nmissing', newText: 'x' }] })
  assert.equal(failure.event.isError, true)
  assert.match(failure.event.content[0].text, /^Could not find the exact text in .*a\.txt\.$/)
  assert.deepEqual(failedEdits(sb.transcriptPath, [failure.id]), [])
  // A cloned failure whose output reports duplicates reads as builderloop's not-unique failure.
  const rows = structuredClone(sb.rows.slice(0, sb.failedEdit + 1))
  const result = rows[sb.failedEdit].message.content[0]
  result.content = '<tool_use_error>Found 2 matches of the string to replace, but replace_all is false.</tool_use_error>'
  const path = join(sb.root, 'duplicates.jsonl')
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  assert.match(failedEdits(path, [])[0].event.content[0].text, /^Found 2 occurrences of the text in /)
  // An errored result of another tool, and a result with no recorded input, are not an Edit failure.
  rows[sb.failedEdit - 1].message.content[0].name = 'Bash'
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  assert.deepEqual(failedEdits(path, []), [])
})

test('builderloop refuses an unchanged rerun of the lane\'s test command, remembered across hook processes', () => {
  const sb = sandbox({ links: false })
  git(sb.cwd, 'init', '-q')
  git(sb.cwd, 'add', '.')
  git(sb.cwd, 'commit', '-qm', 'fixture')
  const launch = seat(sb, { extensions: ['builderloop'] })
  const run = (id) => { const pre = sb.frame('PreToolUse', 'Bash'); pre.tool_use_id = id; pre.tool_input.command = 'node --test gate.test.mjs'; return fire(sb, launch, pre) }
  assertNoEffect(run('toolu_run1'))
  assert.match(denial(run('toolu_run2')).permissionDecisionReason, /^builder-rerun-refusal: rerun of node --test gate.test.mjs/)
  // The tree changed, so the rerun is not the same one.
  writeFileSync(join(sb.cwd, 'a.txt'), 'changed\n')
  assertNoEffect(run('toolu_run3'))
})

test('CH5 a claude seat granted reminders gets the role\'s table at session start, and a rule\'s reminder once after the matching tool', () => {
  const sb = sandbox()
  const table = JSON.parse(readFileSync(join(ROOT, 'crew', 'pi', 'extensions', 'reminders.json'), 'utf8'))
  const launch = seat(sb, { extensions: ['reminders'] })
  const start = contexts(fire(sb, launch, sb.frame('SessionStart')))
  const forBuilder = table.rules.filter((rule) => rule.roles.includes('builder') && !rule.requires_fff)
  assert.ok(forBuilder.length > 0)
  for (const rule of forBuilder) assert.ok(start.includes(rule.reminder), rule.id)
  for (const rule of table.rules.filter((candidate) => !candidate.roles.includes('builder'))) assert.ok(!start.includes(rule.reminder), `${rule.id} is not the builder's`)
  // The post-tool rule path stays: a Write matching raw-temp-call is reminded once.
  const write = sb.frame('PostToolUse', 'Bash')
  Object.assign(write, { tool_name: 'Write', tool_input: { file_path: join(sb.cwd, 'x.test.mjs'), content: 'const d = mkdtempSync(tmpdir())\n' }, tool_response: { type: 'create', filePath: join(sb.cwd, 'x.test.mjs'), content: 'const d = mkdtempSync(tmpdir())\n' } })
  assert.match(contexts(fire(sb, launch, write)), /reminder \(raw-temp-call\): Use scratchDir/)
  write.tool_use_id = 'toolu_second_write'
  assert.equal(contexts(fire(sb, launch, write)), '')
  // Another role gets its own rules, a seat without the grant gets none, and a checkout without a rule's source fires none.
  const planner = sandbox()
  const plannerStart = contexts(fire(planner, seat(planner, { extensions: ['reminders'] }, { role: 'planner' }), planner.frame('SessionStart')))
  for (const rule of table.rules.filter((candidate) => candidate.roles.includes('builder') && !candidate.roles.includes('planner'))) assert.ok(!plannerStart.includes(rule.reminder))
  const bare = sandbox()
  assertNoEffect(fire(bare, seat(bare, {}), bare.frame('SessionStart')))
  const foreign = sandbox({ links: false })
  assertNoEffect(fire(foreign, seat(foreign, { extensions: ['reminders'] }), foreign.frame('SessionStart')))
  assertNoEffect(fire(sb, launch, sb.frame('SessionStart'), { raw: '{malformed' }))
})

test('RF1 and RF2 Claude hooks use resolved grants rather than ambient flags', async () => {
  const saved = process.env.CREW_FFF
  try {
    for (const granted of [false, true]) {
      const sb = sandbox()
      const grants = { extensions: [join(ROOT, 'crew/pi/extensions/reminders.ts')], mcp_servers: granted ? [{ name: 'fff', command: { bin: '/opt/homebrew/bin/fff-mcp', args: [] } }] : [] }
      process.env.CREW_FFF = granted ? '0' : '1'
      writeSeatArms({ taskDir: sb.runtimeRoot, role: 'builder', grants, cwd: sb.cwd, env: { CREW_FFF: process.env.CREW_FFF } })
      const plugin = armsPluginDir({ taskDir: sb.runtimeRoot, role: 'builder' })
      assert.equal(JSON.parse(readFileSync(join(plugin, 'config.json'), 'utf8')).fff, granted)
      const frame = { session_id: 'rf', hook_event_name: 'SessionStart', cwd: sb.cwd }
      const start = await runHook(plugin, JSON.stringify(frame))
      assert.equal(start.additionalContext.includes('reminder (fff-search-evasion):'), granted)
      assert.match(start.additionalContext, /reminder \(test-name-pattern\):/)
      const post = { ...frame, hook_event_name: 'PostToolUse', tool_use_id: 'grep', tool_name: 'Bash', tool_input: { command: 'grep -n foo file | head' }, tool_response: { stdout: 'original', stderr: '', exitCode: 0 } }
      const result = await runHook(plugin, JSON.stringify(post))
      assert.equal(Boolean(result?.additionalContext?.includes('reminder (fff-search-evasion):')), granted)
      const other = await runHook(plugin, JSON.stringify({ ...post, tool_use_id: 'other', tool_input: { command: 'node --test --test-name-pattern=foo file' } }))
      assert.match(other.additionalContext, /reminder \(test-name-pattern\):/)
    }
  } finally {
    if (saved === undefined) delete process.env.CREW_FFF
    else process.env.CREW_FFF = saved
    process.chdir(ROOT)
  }
})

test('CH6 a claude seat granted subagent or codemode refuses before a client, however it is mixed with arms it can run', () => {
  for (const arms of [{ extensions: ['subagent'] }, { extensions: ['readgate', 'subagent'] }, { extensions: ['subagent', 'reminders'], advisor: ADVISOR }, { codemode: true }]) refused(sandbox(), arms)
  // The old headless and pane transports refuse every extension grant, as before.
  const grants = { extensions: [join(ROOT, 'crew/pi/extensions/readgate.ts')], skills: [], tools: [], mcp_servers: [] }
  const spec = { role: 'builder', model: 'opus', promptFile: '/p.md', tools: 'Read', deny: '', taskDir: '/tmp/x', bootBrief: 'b', grants }
  assert.throws(() => seatCommand(spec), { reason: 'grant-unsupported' })
  assert.throws(() => headlessCommand({ ...spec, prompt: 'p', sessionId: 'abc', bin: '/bin/claude' }), { reason: 'grant-unsupported' })
})

test('every arm the lane carries, and only those, is accepted at launch; the rest refuse in the adapter, not by name list in the seat', () => {
  const grant = (...names) => ({ extensions: names.map((name) => join(ROOT, 'crew/pi/extensions', `${name}.ts`)), skills: [], tools: [], mcp_servers: [], advisor: false })
  assert.deepEqual(claudeArmsOf({ ...grant('readgate', 'skeletonread', 'reminders', 'builderloop'), advisor: true }), { arms: [...CLAUDE_ARMS], unsupported: [] })
  assert.deepEqual(claudeArmsOf(grant('readgate', 'readgate')).arms, ['readgate'])
  for (const name of ['subagent', 'submit', 'lab', 'fff', 'nosuch']) assert.deepEqual(claudeArmsOf(grant(name)).unsupported, [join(ROOT, 'crew/pi/extensions', `${name}.ts`)])
  assert.deepEqual(claudeArmsOf({ extensions: ['/elsewhere/readgate.ts', 'builtin:codemode'] }).unsupported, ['/elsewhere/readgate.ts', 'builtin:codemode'])
  const dir = scratchDir('claude-arms-launch-')
  const base = { bin: '/bin/acp', claudeBin: '/frozen/claude', cwd: dir, model: 'opus', tools: 'Read', deny: '', effort: 'high', promptFile: '/p.md', writableDirs: [dir], env: { CREW_TASK_DIR: dir }, taskDir: dir, role: 'builder', armHooks: true }
  const refuses = (spec) => assert.throws(() => acpLaunch(spec), { reason: 'grant-unsupported' })
  refuses({ ...base, grants: grant('readgate', 'subagent') })
  refuses({ ...base, grants: grant('nosuch') })
  refuses({ ...base, grants: { ...grant('readgate'), advisor: true }, role: 'reviewer' })
  refuses({ ...base, grants: grant('readgate'), editAssist: 'on' })
  // Granted but never materialised: the launch would boot without its arms.
  refuses({ ...base, grants: grant('readgate') })
  writeSeatArms({ ...base, grants: grant('readgate') })
  assert.deepEqual(acpLaunch({ ...base, grants: grant('readgate') }).sessionParams._meta.claudeCode.options.plugins, [{ type: 'local', path: armsPluginDir({ taskDir: dir, role: 'builder' }) }])
  assert.equal(Object.hasOwn(acpLaunch({ ...base, grants: grant() }).sessionParams._meta.claudeCode.options, 'plugins'), false)
})

test('the arms plugin sits beside the skills plugin and registers only the events the granted arms use', () => {
  const sb = sandbox()
  const skill = join(sb.root, 'skills', 'alpha', 'SKILL.md')
  mkdirSync(dirname(skill), { recursive: true })
  writeFileSync(skill, '---\nname: alpha\ndescription: fixture\n---\nBody\n')
  const launch = seat(sb, { extensions: ['reminders'], skills: [skill] })
  const plugins = pluginsOf(launch)
  assert.equal(plugins.length, 2)
  assert.ok(plugins[0].path.endsWith('claude-skills/builder') && plugins[1].path.endsWith('claude-arms/builder'))
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(plugins[1].path, 'hooks', 'hooks.json'), 'utf8')).hooks).sort(), ['PostToolUse', 'PostToolUseFailure', 'SessionStart'])
  assert.equal(JSON.parse(readFileSync(join(plugins[1].path, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'crew-arms-builder')
  const skeleton = seat(sandbox(), { extensions: ['skeletonread'] })
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(pluginsOf(skeleton)[0].path, 'hooks', 'hooks.json'), 'utf8')).hooks), ['PreToolUse', 'PostToolUse'])
  const config = JSON.parse(readFileSync(join(plugins[1].path, 'config.json'), 'utf8'))
  assert.deepEqual({ role: config.role, arms: config.arms, lane: config.lane_task_dir, layout: config.layout }, { role: 'builder', arms: ['reminders'], lane: sb.taskDir, layout: 'lean' })
  assert.ok(config.state_dir.startsWith(join(sb.taskDir, 'claude-arms') + '/'), 'the state outlives the disposable runtime')
  // The launch keeps the lean lane environment the arms resolve their context from.
  assert.equal(launch.env.CREW_CONTEXT_LAYOUT, 'lean')
  assert.equal(launch.env.CREW_TASK_DIR, sb.taskDir)
})

test('a claude seat with context arms refuses before a client when the lane cannot supply their context', () => {
  const arms = [{ extensions: ['skeletonread'] }, { extensions: ['builderloop'] }, { advisor: ADVISOR }, { extensions: ['builderloop'], edit_assist: true }]
  for (const request of arms) {
    const noPlanner = sandbox(); unlinkSync(join(noPlanner.taskDir, 'planner-1.json')); refused(noPlanner, request)
    const noJournal = sandbox(); unlinkSync(join(noJournal.taskDir, 'journal.jsonl')); refused(noJournal, request)
    const noRunStart = sandbox(); writeFileSync(join(noRunStart.taskDir, 'journal.jsonl'), '{"event":"stage-start"}\n'); refused(noRunStart, request)
  }
  refused(sandbox(), { edit_assist: true }, { role: 'builder' })
  const ready = sandbox()
  assert.ok(seat(ready, { advisor: ADVISOR, extensions: ['builderloop', 'skeletonread'], edit_assist: true }))
  assert.ok(existsSync(join(ready.taskDir, 'advisor-manifest.json')))
})

test('hook state is kept per seat session and run, survives restarts, and a bad store changes nothing', () => {
  const sb = sandbox()
  const launch = seat(sb, { advisor: ADVISOR })
  const fail = (id, session) => {
    const post = sb.frame('PostToolUse', 'Bash', session)
    post.tool_use_id = id; post.tool_input.command = 'node --test gate.test.mjs'
    Object.assign(post.tool_response, { stdout: 'not ok 1 - state failure\n', exitCode: 1 })
    return contexts(fire(sb, launch, post))
  }
  const repeated = /Repeated validation failure/
  assert.doesNotMatch(fail('a1', 'session-a'), repeated)
  assert.doesNotMatch(fail('b1', 'session-b'), repeated, 'another session starts from nothing')
  assert.match(fail('a2', 'session-a'), repeated)
  assert.equal(sb.stateFiles().length, 2)
  // A new run in the lane drops what the old one counted.
  appendFileSync(sb.journal, `${JSON.stringify({ event: 'run-start', at: Date.now() - 1000, run_id: 'second-run' })}\n`)
  assert.doesNotMatch(fail('a3', 'session-a'), repeated)
  // A store that is not ours is discarded with no effect on the turn, and the next call starts clean.
  const [store] = sb.stateFiles().filter((file) => JSON.parse(readFileSync(file, 'utf8')).session === 'session-a')
  writeFileSync(store, '{not json')
  assert.equal(fail('a4', 'session-a'), '')
  assert.equal(existsSync(store), false)
  assert.doesNotMatch(fail('a5', 'session-a'), repeated)
  assert.match(fail('a6', 'session-a'), repeated)
  // A store whose arm state is malformed leaves that arm out of this call and fresh for the next.
  const stored = JSON.parse(readFileSync(store, 'utf8'))
  stored.arms.advisor.calls = 'many'
  writeFileSync(store, JSON.stringify(stored))
  assert.equal(fail('a7', 'session-a'), '')
  assert.doesNotMatch(fail('a8', 'session-a'), repeated)
})

test('a reading arm left out by malformed state does not steer Bash reads', () => {
  const sb = sandbox()
  const launch = seat(sb, { extensions: ['readgate'] })
  const pre = sb.frame('PreToolUse', 'Bash', 'unstarted'); pre.tool_input.command = 'cat f'
  assert.ok(denial(fire(sb, launch, pre)))
  const store = sb.stateFiles()[0]
  const stored = JSON.parse(readFileSync(store, 'utf8'))
  stored.arms.readgate = 'malformed'
  writeFileSync(store, JSON.stringify(stored))
  assertNoEffect(fire(sb, launch, pre))
})

test('a store that cannot be written changes nothing', { skip: process.getuid?.() === 0 }, () => {
  const sb = sandbox()
  const launch = seat(sb, { extensions: ['readgate'] })
  const pre = sb.frame('PreToolUse', 'Read')
  assert.ok(denial(fire(sb, launch, pre)))
  const dir = dirname(sb.stateFiles()[0])
  chmodSync(dir, 0o500)
  try { assertNoEffect(fire(sb, launch, pre)) } finally { chmodSync(dir, 0o700) }
  assert.ok(denial(fire(sb, launch, pre)))
})

test('a hook that cannot run prints nothing and exits 0', () => {
  const sb = sandbox()
  const launch = seat(sb, { extensions: ['readgate'] })
  const pre = sb.frame('PreToolUse', 'Read')
  for (const raw of ['', '{malformed', '[]', 'null', JSON.stringify({ ...pre, session_id: '' }), JSON.stringify({ ...pre, hook_event_name: 'Stop' }), JSON.stringify({ ...pre, hook_event_name: 'UserPromptSubmit' })]) assertNoEffect(fire(sb, launch, pre, { raw }))
  // An unreadable config, an unknown arm in it and an unwritable state dir are the same as no hook.
  const root = pluginsOf(launch)[0].path
  const config = readFileSync(join(root, 'config.json'), 'utf8')
  for (const text of ['{', JSON.stringify({ ...JSON.parse(config), arms: ['readgate', 'subagent'] }), JSON.stringify({ ...JSON.parse(config), version: 9 })]) {
    writeFileSync(join(root, 'config.json'), text)
    assertNoEffect(fire(sb, launch, pre))
  }
  unlinkSync(join(root, 'config.json'))
  assertNoEffect(fire(sb, launch, pre))
})

test('concurrent hooks take turns on the store, so no update is lost', async () => {
  const sb = sandbox()
  const launch = seat(sb, { advisor: ADVISOR })
  const [command] = commandsFor(launch, 'PostToolUse')
  const post = (id) => {
    const event = sb.frame('PostToolUse', 'Bash')
    event.tool_use_id = id; event.tool_input.command = 'node --test gate.test.mjs'
    Object.assign(event.tool_response, { stdout: 'not ok 1 - concurrent failure\n', exitCode: 1 })
    return JSON.stringify(event)
  }
  await Promise.all(Array.from({ length: 6 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd: sb.cwd, env: hookEnv(launch), stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`hook exited ${code}`))))
    child.stdin.end(post(`toolu_c${index}`))
  })))
  const [store] = sb.stateFiles()
  const counts = new Map(JSON.parse(readFileSync(store, 'utf8')).arms.advisor.failure_counts.map(([key, count]) => [key, count]))
  assert.equal(counts.get('concurrent failure'), 6)
})

test('the hook command survives a plugin path with spaces and quotes', () => {
  const taskDir = join(scratchDir('claude arms "it\'s"-'), 'run time')
  mkdirSync(taskDir)
  const root = writeArmsPlugin({ taskDir, role: 'builder', arms: ['reminders'], cwd: taskDir })
  const [{ hooks }] = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8')).hooks.SessionStart
  const result = spawnSync('/bin/sh', ['-c', hooks[0].command], { input: JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart', source: 'startup' }), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.throws(() => writeArmsPlugin({ taskDir, role: 'builder', arms: ['subagent'], cwd: taskDir }), /arms must be a nonempty list/)
  assert.throws(() => writeArmsPlugin({ taskDir, role: 'builder', arms: [], cwd: taskDir }), /arms must be a nonempty list/)
  assert.throws(() => writeArmsPlugin({ taskDir: 'relative', role: 'builder', arms: ['readgate'], cwd: taskDir }), /ABSOLUTE/)
})

// ---- advisor tier 1: a detached consult, delivered by a later hook -------------------------------------------------
// Real hook processes and a real detached worker; the only fake is the `pi` executable the consult spawns.
async function tier1Lane(mode) {
  const { delimiter } = await import('node:path')
  const root = scratchDir('claude-tier1-')
  const cwd = join(root, 'checkout'), lane = join(root, 'lane'), runtime = join(root, 'runtime'), fake = join(root, 'fakebin')
  for (const dir of [join(cwd, 'lib'), lane, runtime, fake]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(cwd, 'lib', 'widget.mjs'), 'alpha\nbeta\n')
  const anchor = Date.now() - 60_000
  writeFileSync(join(lane, 'journal.jsonl'), `${JSON.stringify({ event: 'run-start', at: anchor })}\n`)
  writeFileSync(join(lane, 'advisor-manifest.json'), JSON.stringify({ schema_version: 1, run_started_at: anchor, tripwires: [], cell: { provider: 'local', id: 'advisor-v1', agent: 'pi', effort: 'medium', model: 'local/advisor-v1' } }))
  const planner = join(lane, 'planner-1.json')
  writeFileSync(planner, JSON.stringify({ role: 'planner', id: 'p.planner.1', status: 'done', summary: 's', details: { files_in_scope: ['lib/'], validation_lane: 'node --test x.test.mjs' } }))
  utimesSync(planner, (anchor + 5000) / 1000, (anchor + 5000) / 1000)
  const countFile = join(root, 'pi-count'), pidFile = join(root, 'pi-pid')
  writeFileSync(countFile, '')
  const pi = join(fake, 'pi')
  writeFileSync(pi, `#!/usr/bin/env node
const fs = require('node:fs')
fs.appendFileSync(process.env.PI_COUNT, 'x\\n')
if (process.env.PI_MODE === 'hang') { fs.writeFileSync(process.env.PI_PID, String(process.pid)); setInterval(() => {}, 1000) }
else {
  process.stdin.resume(); process.stdin.on('end', () => {
    const judgment = { class: 'edge-path', severity: process.env.PI_SEVERITY || 'medium', claim: process.env.PI_CLAIM || 'tier one found the grounded edge', evidence: ['lib/widget.mjs:1'] }
    process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: JSON.stringify(judgment), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } }) + '\\n')
  })
}
`)
  chmodSync(pi, 0o755)
  const plugin = writeArmsPlugin({ taskDir: runtime, role: 'builder', arms: ['advisor'], cwd, laneTaskDir: lane, layout: 'lean' })
  const command = JSON.parse(readFileSync(join(plugin, 'hooks', 'hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command
  const env = { ...process.env, PATH: `${fake}${delimiter}${process.env.PATH}`, CREW_PI_BIN: pi, PI_MODE: mode, PI_COUNT: countFile, PI_PID: pidFile }
  const base = { session_id: 's1', cwd, transcript_path: join(root, 't.jsonl') }
  const fire = (event) => {
    const started = Date.now()
    const r = spawnSync('/bin/sh', ['-c', command], { cwd, env, input: JSON.stringify(event), encoding: 'utf8', timeout: 20_000 })
    let out = null
    try { out = JSON.parse(r.stdout).hookSpecificOutput } catch { /* no output */ }
    return { status: r.status, out, elapsed: Date.now() - started }
  }
  const pre = (id, tool, input) => fire({ ...base, hook_event_name: 'PreToolUse', tool_name: tool, tool_use_id: id, tool_input: input })
  const triggerWrite = (name) => {
    const input = { file_path: join(cwd, name), content: 'const x = 1\n' }
    fire({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: `${name}-r`, tool_input: { file_path: join(cwd, 'lib/widget.mjs') }, tool_response: { type: 'text', file: { content: 'alpha\nbeta\n', filePath: join(cwd, 'lib/widget.mjs') } } })
    pre(`${name}-w`, 'Write', input)
    return fire({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: `${name}-w`, tool_input: input, tool_response: {} })
  }
  const rows = () => readFileSync(join(lane, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const stateFile = () => { const dir = join(lane, 'claude-arms', 'runtime'); return join(dir, readdirSync(dir).find((n) => n.endsWith('.json'))) }
  const stop = () => { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL') } catch { /* none */ } }
  const noteDir = join(lane, 'claude-arms', 'runtime', 'advisor-notes')
  return { env, fire, pre, base, plugin, lane, noteDir, triggerWrite, rows, stateFile, countFile, stop }
}
const until = async (check, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; await new Promise((r) => setTimeout(r, 100)) } return check() }

test('CT1 a hook that triggers a tier-1 consult returns while the consult never finishes', async () => {
  const lane = await tier1Lane('hang')
  try {
    const r = lane.triggerWrite('outside.mjs')
    assert.equal(r.status, 0)
    assert.ok(r.elapsed < 10_000, `hook took ${r.elapsed}ms`)
    assert.ok(await until(() => readFileSync(lane.countFile, 'utf8').length > 0, 10_000), 'the consult worker started the pi child')
  } finally { lane.stop() }
})

test('CT2 a finished consult is delivered once on a later hook, journaled like the pi advisor, and the count persists', async () => {
  const lane = await tier1Lane('ok')
  lane.triggerWrite('outside.mjs')
  assert.ok(await until(() => lane.rows().some((row) => row.advisor_note?.tier === 1 && row.advisor_note.outcome === 'injected'), 20_000), 'tier-1 note journaled')
  await new Promise((r) => setTimeout(r, 500))
  const bash = (id) => lane.pre(id, 'Bash', { command: 'echo ok' })
  const first = bash('b1')
  assert.match(first.out?.additionalContext ?? '', /tier one found the grounded edge/)
  assert.doesNotMatch(bash('b2').out?.additionalContext ?? '', /tier one found/)
  const note = lane.rows().find((row) => row.advisor_note?.tier === 1 && row.advisor_note.outcome === 'injected').advisor_note
  const usage = lane.rows().find((row) => row.advisor_usage).advisor_usage
  assert.equal(note.consult_id, usage.consult_id)
  assert.deepEqual(Object.keys(note).sort(), ['agent', 'call_ordinal', 'claim', 'consult_id', 'content_excerpt', 'content_sha256', 'effort', 'evidence', 'judgment_class', 'kind', 'model', 'model_id', 'outcome', 'provider', 'role', 'run_started_at', 'severity', 'target', 'target_kind', 'tier', 'trigger'])
  // the bound holds in a fresh process: a persisted count at the maximum starts no consult
  const state = JSON.parse(readFileSync(lane.stateFile(), 'utf8'))
  assert.equal(state.arms.advisor.consults, 1)
  state.arms.advisor.consults = 20
  writeFileSync(lane.stateFile(), JSON.stringify(state))
  writeFileSync(lane.countFile, '')
  lane.triggerWrite('outside2.mjs')
  await new Promise((r) => setTimeout(r, 2500))
  assert.equal(readFileSync(lane.countFile, 'utf8'), '')
})

const landed = (lane, count = 1) => until(() => lane.rows().filter((row) => row.advisor_note?.tier === 1).length >= count && existsSync(lane.noteDir) && readdirSync(lane.noteDir).filter((n) => n.endsWith('.json')).length >= 1, 20_000)

test('CT3 a finished consult\'s note goes to the session and run that asked, and to no other', async () => {
  const lane = await tier1Lane('ok')
  lane.triggerWrite('outside.mjs')
  assert.ok(await landed(lane), 'note landed')
  await new Promise((r) => setTimeout(r, 300))
  const bash = (id, session) => lane.fire({ ...lane.base, session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'echo ok' } })
  assert.doesNotMatch(bash('o1', 'other-session').out?.additionalContext ?? '', /tier one found/)
  assert.equal(readdirSync(lane.noteDir).filter((n) => n.endsWith('.json')).length, 1, 'another session leaves the note where it is')
  assert.match(bash('o2', 's1').out?.additionalContext ?? '', /tier one found/)
})

test('CT3 a note queued before a new run starts is dropped, not delivered into the new run', async () => {
  const lane = await tier1Lane('ok')
  lane.triggerWrite('outside.mjs')
  assert.ok(await landed(lane), 'note landed')
  await new Promise((r) => setTimeout(r, 300))
  appendFileSync(join(lane.lane, 'journal.jsonl'), `${JSON.stringify({ event: 'run-start', at: Date.now() + 1000 })}\n`)
  assert.doesNotMatch(lane.pre('n1', 'Bash', { command: 'echo ok' }).out?.additionalContext ?? '', /tier one found/)
  assert.deepEqual(readdirSync(lane.noteDir).filter((n) => n.endsWith('.json')), [])
})

test('CT4 a note claimed by a call that then cannot save its state is put back and delivered by the next call', async () => {
  const lane = await tier1Lane('ok')
  lane.triggerWrite('outside.mjs')
  assert.ok(await landed(lane), 'note landed')
  await new Promise((r) => setTimeout(r, 300))
  // the state file's temp name is taken by a directory, so the hook's write fails after it has claimed the note
  const blocker = `${lane.stateFile()}.${process.pid}.tmp`
  mkdirSync(blocker)
  const cwd = process.cwd()
  const keep = { ...process.env }
  try {
    await assert.rejects(runHook(lane.plugin, JSON.stringify({ ...lane.base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'f1', tool_input: { command: 'echo ok' } })))
  } finally { process.chdir(cwd); for (const key of Object.keys(process.env)) if (!(key in keep)) delete process.env[key]; Object.assign(process.env, keep); rmSync(blocker, { recursive: true, force: true }) }
  assert.equal(readdirSync(lane.noteDir).filter((n) => n.endsWith('.json')).length, 1, 'the note is back')
  assert.match(lane.pre('f2', 'Bash', { command: 'echo ok' }).out?.additionalContext ?? '', /tier one found/)
})

test('CT5 a delivered claim is remembered, so a later consult returning it is suppressed and not delivered again', async () => {
  const lane = await tier1Lane('ok')
  lane.triggerWrite('outside.mjs')
  assert.ok(await landed(lane), 'first note landed')
  await new Promise((r) => setTimeout(r, 300))
  assert.match(lane.pre('d1', 'Bash', { command: 'echo ok' }).out?.additionalContext ?? '', /tier one found/)
  const memory = JSON.parse(readFileSync(lane.stateFile(), 'utf8')).arms.advisor
  assert.ok(memory.dedupe.includes('tier one found the grounded edge'))
  assert.ok(memory.injected.includes('tier one found the grounded edge'))
  lane.triggerWrite('outside2.mjs')
  assert.ok(await until(() => lane.rows().some((row) => row.advisor_note?.tier === 1 && row.advisor_note.outcome === 'suppressed' && row.advisor_note.codes?.includes('duplicate')), 20_000), 'the repeat is suppressed')
  await new Promise((r) => setTimeout(r, 300))
  assert.doesNotMatch(lane.pre('d2', 'Bash', { command: 'echo ok' }).out?.additionalContext ?? '', /tier one found/)
})

test('CT6 a triggering call that cannot save its state starts no consult, so the persisted count still bounds them', async () => {
  const lane = await tier1Lane('ok')
  const widget = join(lane.base.cwd, 'lib/widget.mjs')
  lane.fire({ ...lane.base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'r0', tool_input: { file_path: widget }, tool_response: { type: 'text', file: { content: 'alpha\nbeta\n', filePath: widget } } })
  const state = JSON.parse(readFileSync(lane.stateFile(), 'utf8'))
  state.arms.advisor.consults = 19
  writeFileSync(lane.stateFile(), JSON.stringify(state))
  const cwd = process.cwd()
  const keep = { ...process.env }
  Object.assign(process.env, lane.env) // a consult started by this process would find the fake pi
  const blocker = `${lane.stateFile()}.${process.pid}.tmp`
  const file = join(lane.base.cwd, 'outside.mjs'), input = { file_path: file, content: 'const x = 1\n' }
  const frame = (event, extra) => JSON.stringify({ ...lane.base, hook_event_name: event, tool_name: 'Write', tool_use_id: 'w1', tool_input: input, ...extra })
  try {
    await runHook(lane.plugin, frame('PreToolUse'))
    mkdirSync(blocker)
    await assert.rejects(runHook(lane.plugin, frame('PostToolUse', { tool_response: {} })))
  } finally { process.chdir(cwd); for (const key of Object.keys(process.env)) if (!(key in keep)) delete process.env[key]; Object.assign(process.env, keep); rmSync(blocker, { recursive: true, force: true }) }
  await new Promise((r) => setTimeout(r, 2500))
  assert.equal(readFileSync(lane.countFile, 'utf8'), '', 'no consult was started')
  assert.equal(JSON.parse(readFileSync(lane.stateFile(), 'utf8')).arms.advisor.consults, 19, 'the count was not spent')
})

test('CT7 two consults in flight for one update are judged against each other: one claim is delivered, the other suppressed', async () => {
  const lane = await tier1Lane('ok')
  lane.pre('s0', 'Bash', { command: 'echo ok' })
  const state = JSON.parse(readFileSync(lane.stateFile(), 'utf8'))
  state.arms.advisor.calls = 24
  writeFileSync(lane.stateFile(), JSON.stringify(state))
  lane.triggerWrite('outside.mjs')
  const notes = () => lane.rows().filter((row) => row.advisor_note?.tier === 1).map((row) => row.advisor_note)
  assert.ok(await until(() => notes().length >= 2, 30_000), 'both consults ended')
  await new Promise((r) => setTimeout(r, 500))
  assert.deepEqual(notes().map((n) => n.outcome).sort(), ['injected', 'suppressed'])
  assert.equal(readdirSync(lane.noteDir).filter((n) => n.endsWith('.json')).length, 1)
  const context = lane.pre('d1', 'Bash', { command: 'echo ok' }).out?.additionalContext ?? ''
  assert.equal(context.split('tier one found').length - 1, 1)
})

test('AS2 a claude seat Write to the lane return file is never a scope breach; a Write outside scope and task dir still is', () => {
  const sb = sandbox()
  const launch = seat(sb, { advisor: ADVISOR })
  const write = (id, file) => {
    const pre = sb.frame('PreToolUse', 'Bash')
    Object.assign(pre, { tool_name: 'Write', tool_use_id: id, tool_input: { file_path: file, content: '{}\n' } })
    return contexts(fire(sb, launch, pre))
  }
  const breaches = () => readFileSync(sb.journal, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.advisor_note?.kind === 'scope-breach')
  const returned = write('toolu_ret', join(sb.taskDir, 'builder-1.json'))
  assert.doesNotMatch(returned, /outside the declared scope/)
  assert.equal(breaches().length, 0)
  write('toolu_out', join(sb.cwd, 'outside.mjs'))
  assert.equal(breaches().length, 1, 'a write outside scope and task dir still breaches')
})

// ---- advisor diff-growth and pre-return triggers --------------------------------------------------------------------
const committed = async (mode) => {
  const lane = await tier1Lane(mode)
  git(lane.base.cwd, 'init', '-q'); git(lane.base.cwd, 'add', '.'); git(lane.base.cwd, 'commit', '-qm', 'base')
  return lane
}
const readWidget = (lane) => lane.fire({ ...lane.base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'rg', tool_input: { file_path: join(lane.base.cwd, 'lib/widget.mjs') }, tool_response: { type: 'text', file: { content: 'alpha\nbeta\n', filePath: join(lane.base.cwd, 'lib/widget.mjs') } } })

test('DT1 a claude Bash call that grows the working diff past the threshold queues a tier-1 diff-growth consult; a small change does not', async () => {
  const lane = await committed('ok')
  readWidget(lane)
  const bash = (id, after) => {
    lane.pre(id, 'Bash', { command: 'apply' })
    after()
    return lane.fire({ ...lane.base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'apply' }, tool_response: { stdout: 'ok\n', stderr: '', exitCode: 0 } })
  }
  bash('b0', () => appendFileSync(join(lane.base.cwd, 'lib/widget.mjs'), '// small\n'))
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal(readFileSync(lane.countFile, 'utf8'), '', 'a small change consults nothing')
  bash('b1', () => appendFileSync(join(lane.base.cwd, 'lib/widget.mjs'), Array.from({ length: 250 }, (_, i) => `// change ${i}`).join('\n') + '\n'))
  assert.ok(await until(() => lane.rows().some((row) => row.advisor_note?.tier === 1 && row.advisor_note.trigger === 'diff-growth' && row.advisor_note.outcome === 'injected'), 20_000), 'a diff-growth note landed')
  assert.ok(lane.rows().some((row) => row.advisor_consult?.trigger === 'diff-growth'))
  await new Promise((r) => setTimeout(r, 300))
  assert.match(lane.pre('b2', 'Bash', { command: 'echo ok' }).out?.additionalContext ?? '', /tier one found/, 'delivered a call later')
})

test('PR1 and PR3 a claude Write of the return file is refused with the must-fix finding once; the next write goes through unheld', async () => {
  const lane = await committed('ok')
  lane.env.PI_SEVERITY = 'high'; lane.env.PI_CLAIM = 'must-fix: the empty path is unhandled'
  readWidget(lane)
  const input = { file_path: join(lane.lane, 'builder-1.json'), content: '{}\n' }
  const first = lane.pre('r1', 'Write', input)
  assert.equal(first.out?.permissionDecision, 'deny')
  assert.match(first.out?.permissionDecisionReason ?? '', /must-fix: the empty path is unhandled/)
  assert.ok(first.elapsed < 40_000)
  const spawned = readFileSync(lane.countFile, 'utf8')
  assert.equal(spawned, 'x\n', 'one consult')
  assert.ok(lane.rows().some((row) => row.advisor_note?.trigger === 'pre-return' && row.advisor_note.severity === 'high'))
  const second = lane.pre('r2', 'Write', input)
  assert.notEqual(second.out?.permissionDecision, 'deny')
  assert.equal(readFileSync(lane.countFile, 'utf8'), spawned, 'no second consult')
  assert.equal(JSON.parse(readFileSync(lane.stateFile(), 'utf8')).arms.advisor.pre_return_spent, true)
  // a Bash command naming the path is the same call to the advisor
  const other = lane.pre('x1', 'Bash', { command: `echo '{}' > ${join(lane.lane, 'builder-2.json')}` })
  assert.notEqual(other.out?.permissionDecision, 'deny')
})

test('the arms hook outlives a pre-return consult', async () => {
  const lane = await tier1Lane('ok')
  const timeout = JSON.parse(readFileSync(join(lane.plugin, 'hooks', 'hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].timeout
  assert.equal(timeout, 45)
  const { CONSULT_TIMEOUT_MS, CHILD_KILL_GRACE_MS } = await import('../pi/extensions/advisor.ts')
  assert.ok(timeout * 1000 > CONSULT_TIMEOUT_MS + 2 * CHILD_KILL_GRACE_MS)
})
