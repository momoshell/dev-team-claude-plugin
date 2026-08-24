import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync as nodeSpawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mod from './lab.ts'
import * as capabilities from '../../capabilities.mjs'
import { scratchDir } from '../../../test/helpers.mjs'

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))

function temp(prefix = 'lab-test-') {
  return realpathSync(scratchDir(prefix))
}

function fakeChild(pid = 4321) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = new EventEmitter()
  child.stdin.writes = []
  child.stdin.write = (value) => { child.stdin.writes.push(String(value)); return true }
  child.stdin.end = () => { child.stdin.ended = true }
  child.stdin.destroy = () => { child.stdin.destroyed = true }
  child.stdout.destroy = () => { child.stdout.destroyed = true }
  child.stderr.destroy = () => { child.stderr.destroyed = true }
  child.kills = []
  child.pid = pid
  child.kill = (signal) => { child.kills.push(signal); return true }
  child.unref = () => { child.unreffed = true }
  return child
}

function timers() {
  const list = []
  const setTimeout = (fn, ms) => {
    const timer = { fn, ms, cleared: false, fired: false }
    list.push(timer)
    return timer
  }
  const clearTimeout = (timer) => { if (timer) timer.cleared = true }
  const fire = (timer) => { if (timer && !timer.cleared && !timer.fired) { timer.fired = true; timer.fn() } }
  return { list, setTimeout, clearTimeout, fire }
}

function fakeDoneSpawn(calls, result = 'ok') {
  return (command, args, options) => {
    const child = fakeChild()
    calls.push({ command, args, options, child })
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(`${JSON.stringify({ done: true, result })}\n`))
      child.emit('close', 0, null)
    })
    return child
  }
}

function scriptedProgram(requests, result = 'done', { concurrent = false, close = true } = {}) {
  const child = fakeChild(1111)
  const responses = []
  let cursor = 0
  const emit = (frame) => child.stdout.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`))
  const finish = () => {
    const value = typeof result === 'function' ? result(responses) : result
    emit({ done: true, result: value })
    if (close) child.emit('close', 0, null)
  }
  child.stdin.write = (value) => {
    const response = JSON.parse(String(value).trim())
    responses.push(response)
    queueMicrotask(() => {
      if (cursor < requests.length) emit(requests[cursor++])
      else finish()
    })
    return true
  }
  queueMicrotask(() => {
    if (concurrent) {
      for (const request of requests) emit(request)
      cursor = requests.length
    } else if (cursor < requests.length) emit(requests[cursor++])
    else finish()
  })
  return { child, responses }
}

function scriptedHarness({ requests, result = 'done', concurrent = false, suite = {}, deps = {} } = {}) {
  const holder = temp('lab-harness-')
  const taskDir = join(holder, 'task')
  mkdirSync(taskDir, { recursive: true })
  const env = { ...process.env, CREW_ROLE: 'planner', CREW_TASK_DIR: taskDir }
  delete env.NODE_OPTIONS
  const program = scriptedProgram(requests, result, { concurrent, close: suite.closeProgram !== false })
  const calls = []
  const syncCalls = []
  const removeCalls = []
  const suiteChildren = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    if (calls.length === 1) return program.child
    const child = fakeChild(suite.pid || 2222)
    suiteChildren.push(child)
    queueMicrotask(() => {
      if (suite.stdout !== undefined) child.stdout.emit('data', Buffer.isBuffer(suite.stdout) ? suite.stdout : Buffer.from(String(suite.stdout), 'utf8'))
      if (suite.stderr) child.stderr.emit('data', Buffer.from(String(suite.stderr), 'utf8'))
      if (suite.close !== false) {
        const close = Array.isArray(suite.close) ? suite.close : [0, null]
        child.emit('close', close[0], close[1])
      }
    })
    return child
  }
  const realSync = deps.spawnSync || ((...args) => nodeSpawnSync(...args))
  const spawnSync = (...args) => {
    const value = realSync(...args)
    syncCalls.push({ args, value })
    return value
  }
  const removeDir = deps.removeDir || ((path) => {
    removeCalls.push(path)
    rmSync(path, { recursive: true, force: true })
  })
  const tool = mod.createLabTool({
    env,
    ...deps,
    spawn,
    spawnSync,
    removeDir,
    mkTempDir: deps.mkTempDir || (() => temp('lab-harness-dir-')),
  })
  return { holder, taskDir, tool, program, calls, syncCalls, removeCalls, suiteChildren }
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

async function realTool(program, root = ROOT, deps = {}) {
  const holder = temp()
  const taskDir = join(holder, 'task')
  mkdirSync(taskDir, { recursive: true })
  const env = { ...process.env, CREW_ROLE: 'planner', CREW_TASK_DIR: taskDir }
  delete env.NODE_OPTIONS
  return mod.createLabTool({ env, ...deps }).execute('test-call', { program }, null, null, { cwd: root })
}

test('the module is zero-dep and erasable', () => {
  const source = readFileSync(new URL('./lab.ts', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((one) => one[1])
  assert.ok(imports.length > 0)
  assert.ok(imports.every((one) => one.startsWith('node:')), imports.join(', '))
  assert.doesNotMatch(source, /^\s*enum\s/m)
  assert.doesNotMatch(source, /^\s*namespace\s/m)
  assert.equal(typeof mod.default, 'function')
})

test('the extension registers one lab tool and one result handler', () => {
  const tools = []
  const handlers = []
  mod.default({ registerTool: (tool) => tools.push(tool), on: (event, handler) => handlers.push([event, handler]) })
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'lab')
  assert.equal(tools[0].executionMode, 'sequential')
  assert.equal(typeof tools[0].execute, 'function')
  assert.deepEqual(handlers.map(([event]) => event), ['tool_result'])
})

test('the permissive parameter schema leaves checks to execute', () => {
  assert.equal(mod.LAB_PARAMS.additionalProperties, true)
  assert.equal(Object.hasOwn(mod.LAB_PARAMS, 'required'), false)
  assert.equal(Object.hasOwn(mod.LAB_PARAMS.properties.program, 'type'), false)
  assert.match(mod.createLabTool({ env: {} }).description, /host authority/)
})

test('allowReadPaths keeps both a symlink and its realpath', () => {
  const root = temp()
  const real = join(root, 'real')
  mkdirSync(real)
  writeFileSync(join(real, 'file.txt'), 'x')
  const link = join(root, 'link')
  symlinkSync(real, link)
  const raw = join(link, 'file.txt')
  const paths = mod.allowReadPaths(raw)
  assert.ok(paths.includes(raw))
  assert.ok(paths.includes(join(realpathSync(real), 'file.txt')))
  rmSync(root, { recursive: true, force: true })
})

test('labChildArgs repeats read flags and does not widen authority', () => {
  const args = mod.labChildArgs({ runnerPath: '/tmp/runner.mjs', allowRead: ['/tmp/raw', '/private/tmp/real'] })
  assert.equal(args[0], '--permission')
  assert.equal(args.at(-1), '/tmp/runner.mjs')
  assert.deepEqual(args.filter((one) => one.startsWith('--allow-fs-read=')), ['--allow-fs-read=/tmp/raw', '--allow-fs-read=/private/tmp/real'])
  assert.equal(args.some((one) => one.startsWith('--allow-') && !one.startsWith('--allow-fs-read=')), false)
})

test('containsScratch enforces a path boundary', () => {
  const scratch = '/tmp/scratch'
  assert.equal(mod.containsScratch(scratch, scratch), true)
  assert.equal(mod.containsScratch(scratch, '/tmp/scratch/file'), true)
  assert.equal(mod.containsScratch(scratch, '/tmp/scratch/../outside'), false)
  assert.equal(mod.containsScratch(scratch, '/tmp/scratchextra'), false)
  assert.equal(mod.containsScratch(scratch, '/etc/passwd'), false)
})

test('validateScratchPath returns argument and option refusals first', () => {
  const root = '/tmp/scratch'
  assert.equal(mod.validateScratchPath(root, '').refused, 'op-args-invalid')
  assert.equal(mod.validateScratchPath(root, '--allow-net').refused, 'path-option-shaped')
  assert.equal(mod.validateScratchPath(root, '/etc/passwd').refused, 'path-not-relative')
  assert.equal(mod.validateScratchPath(root, 'a\\b').refused, 'path-not-relative')
  assert.equal(mod.validateScratchPath(root, 'a\0b').refused, 'path-not-relative')
  assert.equal(mod.validateScratchPath(root, 'a*b').refused, 'path-not-relative')
})

test('validateScratchPath distinguishes traversal and escaping realpaths', () => {
  const root = '/tmp/scratch'
  assert.equal(mod.validateScratchPath(root, '../x').refused, 'path-traversal')
  assert.equal(mod.validateScratchPath(root, 'a/../../x').refused, 'path-traversal')
  assert.equal(mod.validateScratchPath(root, 'escape', { realpath: () => '/tmp/outside' }).refused, 'path-escapes-scratch')
  assert.equal(mod.validateScratchPath(root, 'file', { realpath: () => `${root}/file` }).path, `${root}/file`)
})

test('dot-prefixed names are valid while dot segments are not', () => {
  const deps = { realpath: (path) => path }
  assert.equal(mod.validateScratchPath('/tmp/s', '.gitignore', deps).path, '/tmp/s/.gitignore')
  assert.equal(mod.validateScratchPath('/tmp/s', '.github/workflows/test.yml', deps).path, '/tmp/s/.github/workflows/test.yml')
  assert.equal(mod.validateScratchPath('/tmp/s', '.', deps).refused, 'path-traversal')
  assert.equal(mod.validateScratchPath('/tmp/s', '..', deps).refused, 'path-traversal')
})

test('only resolution absence is file-missing', () => {
  for (const code of ['ENOENT', 'ENOTDIR', 'ELOOP']) {
    const result = mod.validateScratchPath('/tmp/s', 'x', { realpath: () => { throw Object.assign(new Error(code), { code }) } })
    assert.equal(result.refused, 'file-missing')
  }
  const marker = Object.assign(new Error('MARKER'), { code: 'EACCES' })
  assert.throws(() => mod.validateScratchPath('/tmp/s', 'x', { realpath: () => { throw marker } }), (error) => error === marker)
})

test('classifyDenial covers permission, native and fetch shapes', () => {
  assert.deepEqual(mod.classifyDenial({ code: 'ERR_ACCESS_DENIED', permission: 'Net', resource: 'x' }), { code: 'ERR_ACCESS_DENIED', permission: 'Net', resource: 'x' })
  assert.deepEqual(mod.classifyDenial({ code: 'ERR_DLOPEN_DISABLED' }), { code: 'ERR_DLOPEN_DISABLED', permission: 'NativeAddon', resource: null })
  assert.deepEqual(mod.classifyDenial(new TypeError('fetch failed')), { code: 'ERR_ACCESS_DENIED', permission: 'Net', resource: null })
  assert.equal(mod.classifyDenial(new Error('ordinary')), null)
})

test('livenessProbe only treats ESRCH as gone', () => {
  for (const [code, want] of [['ESRCH', 'gone'], ['EPERM', 'alive'], ['EWHAT', 'unknown']]) {
    assert.equal(mod.livenessProbe(3, { kill: () => { throw Object.assign(new Error(code), { code }) } }), want)
  }
})

test('parseTapSummary reads the last exact summary pair', () => {
  assert.deepEqual(mod.parseTapSummary('# pass 1\n# fail 0\n# pass 7\n# fail 2'), { pass: 7, fail: 2 })
  assert.deepEqual(mod.parseTapSummary('ℹ pass 7\nℹ fail 0'), { pass: null, fail: null })
})

test('journal rows preserve the lab presence key and disclosure fields', () => {
  const row = mod.labRow({ at: 'now', role: 'planner', spawnId: 's1', program: 'p', outcome: 'ok', output: 'o', hostAuthority: true, scratchRetained: '/tmp/wt' })
  assert.deepEqual(row.lab_run, { spawn_id: 's1', outcome: 'ok', program: 'p', output: 'o', host_authority: true, scratch_retained: '/tmp/wt' })
  assert.equal(row.role, 'planner')
})

test('boundLabText truncates bytes without splitting UTF-8', () => {
  assert.equal(mod.boundLabText('🛰️', 4), '🛰')
  assert.equal(mod.boundLabText('short', 20), 'short')
})

test('the collector bounds stdout and stderr against one byte cap', () => {
  const lines = []
  const overflows = []
  const c = mod.createStreamCollector({ capBytes: 5, residualCapBytes: 20, frameQueueMax: 20, onLine: (line, kind) => lines.push([line, kind]), onOverflow: (kind) => overflows.push(kind) })
  c.push('abc\n', 'stdout')
  c.push('de', 'stderr')
  assert.equal(c.isOverflowed(), true)
  assert.equal(overflows.length, 1)
  assert.equal(c.queuedFrames(), 0)
  c.push('later\n', 'stdout')
  assert.equal(lines.length, 1)
})

test('the collector measures residual bytes and keeps channel decoders separate', () => {
  const lines = []
  const c = mod.createStreamCollector({ capBytes: 100, residualCapBytes: 100, frameQueueMax: 20, onLine: (line, kind) => lines.push([line, kind]), onOverflow: () => assert.fail('unexpected overflow') })
  const bytes = Buffer.from('🛰\n')
  c.push(bytes.subarray(0, 2), 'stdout')
  c.push(Buffer.from('stderr\n'), 'stderr')
  c.push(bytes.subarray(2), 'stdout')
  assert.deepEqual(lines, [['stderr', 'stderr'], ['🛰', 'stdout']])
  c.end('stderr')
  c.push(Buffer.from('→'), 'stdout')
  c.end('stdout')
  assert.equal(lines.at(-1)[0], '→')
})

test('the collector queue cap drops many tiny unserved frames', () => {
  let overflow = 0
  const c = mod.createStreamCollector({ capBytes: 10000, residualCapBytes: 1000, frameQueueMax: 2, onLine: () => {}, onOverflow: () => { overflow += 1 } })
  c.push('a\nb\nc\n', 'stdout')
  assert.equal(overflow, 1)
  assert.equal(c.queuedFrames(), 0)
  assert.equal(c.isOverflowed(), true)
})

test('the collector served method bounds backlog rather than lifetime', () => {
  let overflow = 0
  const c = mod.createStreamCollector({ capBytes: 100, residualCapBytes: 100, frameQueueMax: 1, onLine: () => c.served(), onOverflow: () => { overflow += 1 } })
  c.push('a\nb\nc\n', 'stdout')
  assert.equal(overflow, 0)
})

test('tool_result marks only refused lab results as errors', () => {
  assert.deepEqual(mod.toolResultPatch({ toolName: 'lab', details: { refused: 'x' } }), { isError: true })
  assert.equal(mod.toolResultPatch({ toolName: 'other', details: { refused: 'x' } }), undefined)
  assert.equal(mod.toolResultPatch({ toolName: 'lab', details: {} }), undefined)
})

test('the clean program child receives a scrubbed environment', async () => {
  const calls = []
  const env = { CREW_ROLE: 'planner', CREW_TASK_DIR: '' }
  const tool = mod.createLabTool({
    env: { ...env, NODE_OPTIONS: '--permission', FORCE_COLOR: '1', CLICOLOR_FORCE: '1' },
    isDirectory: () => true,
    spawn: fakeDoneSpawn(calls),
    mkTempDir: () => temp(),
  })
  const result = await tool.execute('x', { program: 'export default 1' }, null, null, { cwd: '/tmp/repo' })
  assert.equal(result.details.outcome, 'ok')
  assert.equal(Object.hasOwn(calls[0].options.env, 'NODE_OPTIONS'), false)
  assert.equal(Object.hasOwn(calls[0].options.env, 'FORCE_COLOR'), false)
  assert.equal(Object.hasOwn(calls[0].options.env, 'CLICOLOR_FORCE'), false)
  assert.equal(calls[0].options.env.NO_COLOR, '1')
})

test('the child deadline sends SIGTERM then SIGKILL', async () => {
  const clock = timers()
  const child = fakeChild()
  const calls = []
  const tool = mod.createLabTool({
    env: {}, isDirectory: () => true, mkTempDir: () => temp(),
    spawn: (command, args, options) => { calls.push({ command, args, options }); return child },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, childTimeoutMs: 10, killGraceMs: 20,
  })
  const pending = tool.execute('x', { program: 'await new Promise(() => {})' }, null, null, { cwd: '/tmp/repo' })
  await new Promise((resolve) => setImmediate(resolve))
  clock.fire(clock.list.find((one) => one.ms === 10))
  assert.deepEqual(child.kills, ['SIGTERM'])
  clock.fire(clock.list.find((one) => one.ms === 20))
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL'])
  child.emit('close', null, 'SIGKILL')
  await pending
})

test('a normal close cancels the escalation timer', async () => {
  const clock = timers()
  const child = fakeChild()
  const tool = mod.createLabTool({ env: {}, isDirectory: () => true, mkTempDir: () => temp(), spawn: () => child, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, childTimeoutMs: 10, killGraceMs: 20 })
  const pending = tool.execute('x', { program: 'export default 1' }, null, null, { cwd: '/tmp/repo' })
  await new Promise((resolve) => setImmediate(resolve))
  child.stdout.emit('data', Buffer.from('{"done":true,"result":1}\n'))
  child.emit('close', 0, null)
  await pending
  const deadline = clock.list.find((one) => one.ms === 10)
  assert.equal(deadline.cleared, true)
})

test('the register grants lab to planner pi only', () => {
  const register = capabilities.loadCapabilities()
  const planner = capabilities.grantsFor(register, 'planner', { agent: 'pi' })
  assert.ok(planner.extensions.some((path) => path.endsWith('/crew/pi/extensions/lab.ts')))
  for (const role of ['lead', 'builder', 'reviewer', 'tech-lead']) {
    const grants = capabilities.grantsFor(register, role, { agent: 'pi' })
    assert.equal(grants.extensions.some((path) => path.endsWith('/crew/pi/extensions/lab.ts')), false)
  }
})

test('the exported API has exactly five operation names', () => {
  assert.deepEqual([...mod.LAB_API], ['scratchCheckout', 'read', 'grep', 'mutate', 'runSuite'])
  assert.equal(mod.LAB_TOOL_NAME, 'lab')
})

test('refusal codes remain a closed set', () => {
  for (const code of ['path-option-shaped', 'path-traversal', 'output-oversize', 'suite-failed', 'net-unenforceable']) assert.ok(mod.LAB_REFUSALS.includes(code))
  assert.equal(mod.LAB_REFUSALS.includes('arbitrary-user-text'), false)
})

test('read and mutate argument validation is host-side', async () => {
  const calls = []
  const tool = mod.createLabTool({ env: {}, isDirectory: () => true, mkTempDir: () => temp(), spawn: fakeDoneSpawn(calls) })
  const result = await tool.execute('x', { program: 'export default 1' }, null, null, { cwd: '/tmp/repo' })
  assert.equal(result.details.outcome, 'ok')
  assert.equal(calls.length, 1)
})

// Where the network boundary is unenforceable the lab refuses every program
// before it runs, so no escape is attempted at all. Both branches assert a
// real refusal and neither admits an outcome of 'ok'.
// The Net permission scope exists exactly where the --allow-net flag does:
// measured false on node 20/22/24 and true on 26.5.1 (crew/pi/extensions/lab.ts:51-54
// is the same discriminator, read here independently in the host process).
// At or above the repo's Node floor the boundary IS enforceable, so
// 'net-unenforceable' is no longer an acceptable escape outcome — a suite that
// refused everything would be green while proving nothing. Below the floor the
// refusal branch stays reachable and is still the correct answer.
const NET_ENFORCEABLE = process.allowedNodeEnvironmentFlags.has(mod.LAB_AUDIT_NET_FLAG)

function assertEscapeRefused(result, assertDenial) {
  assert.equal(result.details.outcome, 'refused')
  if (!NET_ENFORCEABLE) {
    assert.equal(result.details.refused, 'net-unenforceable')
    assert.equal(result.details.audit.net_enforceable, false)
    return
  }
  assert.notEqual(result.details.refused, 'net-unenforceable', 'this runtime enforces the network boundary, so an escape must be a real denial')
  assertDenial(result.details)
}

test('escape: a program that writes outside the scratch dir is denied', async () => {
  const root = temp()
  const target = join(root, 'outside-write.txt')
  const result = await realTool(`import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(target)}, 'escape')\n`)
  assertEscapeRefused(result, (details) => {
    assert.equal(details.denial.permission, 'FileSystemWrite')
  })
  assert.equal(existsSync(target), false)
  rmSync(root, { recursive: true, force: true })
})

test('escape: a program that spawns a child process is denied', async () => {
  const result = await realTool("import { spawnSync } from 'node:child_process'\nspawnSync('/bin/echo', ['escape'])\n")
  assertEscapeRefused(result, (details) => {
    assert.equal(details.denial.permission, 'ChildProcess')
  })
})

test('escape: a program that reaches the network is denied', async () => {
  const result = await realTool("import { createServer } from 'node:net'\nawait new Promise((resolve, reject) => { const server = createServer(); server.on('error', reject); server.listen(0, () => { server.close(); resolve() }) })\n")
  assertEscapeRefused(result, (details) => {
    assert.equal(details.denial.code, 'ERR_ACCESS_DENIED')
    assert.equal(details.denial.permission, 'Net')
    assert.match(JSON.stringify(details), /--allow-net/)
  })
})

test('auditGrants detects unreadable paths and every widening layer', () => {
  const base = { runnerRaw: '/r', runnerReal: '/rr', programRaw: '/p', programReal: '/pp', execArgv: [], nodeOptions: '', flags: new Set([mod.LAB_AUDIT_NET_FLAG]), has: (key) => key === 'fs.read' }
  assert.equal(mod.auditGrants(base).ok, true)
  assert.equal(mod.auditGrants({ ...base, flags: new Set() }).net_enforceable, false)
  assert.equal(mod.auditGrants({ ...base, flags: new Set() }).ok, false)
  assert.equal(mod.auditGrants({ ...base, has: (key, path) => path !== '/r' }).runner, false)
  assert.equal(mod.auditGrants({ ...base, has: (key, path) => path !== '/p' }).program, false)
  assert.ok(mod.auditGrants({ ...base, has: (key, path) => key === 'fs.write' && path === '/' }).granted.includes('fs.write:/'))
  assert.ok(mod.auditGrants({ ...base, execArgv: ['--allow-fs-write=/narrow'] }).execargv.length)
  assert.equal(mod.auditGrants({ ...base, nodeOptions: '--require=bad' }).ok, false)
})

test('the pure constants carry the required bounds', () => {
  assert.equal(mod.LAB_PROGRAM_CAP_BYTES, 64 * 1024)
  assert.equal(mod.LAB_OUTPUT_CAP_BYTES, 50 * 1024)
  assert.equal(mod.LAB_FRAME_QUEUE_MAX, 1024)
  assert.equal(mod.LAB_SUITE_PATHS_MAX, 64)
})

// Keep the final test independent of a live repo clone; it pins the public
// runner contract without requiring a second permission child.
test('runnerSource emits a startup audit and five RPC stubs', () => {
  const source = mod.runnerSource('file:///tmp/program.mjs')
  assert.match(source, /child-denied/)
  assert.match(source, /scratchCheckout/)
  assert.match(source, /unhandledRejection/)
  assert.match(source, /process\.permission\.has/)
  assert.match(source, /net-unenforceable/)
  assert.match(source, /allowedNodeEnvironmentFlags/)
})

test('the host surfaces the child\'s typed refusal', async () => {
  const tool = mod.createLabTool({
    env: {},
    isDirectory: () => true,
    mkTempDir: () => temp(),
    spawn: () => {
      const child = fakeChild()
      queueMicrotask(() => {
        const audit = { runner: true, program: true, granted: [], execargv: [], node_options: null, net_enforceable: false, ok: false }
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ done: true, refused: 'net-unenforceable', audit })}\n`))
        child.emit('close', 0, null)
      })
      return child
    },
  })
  const result = await tool.execute('x', { program: 'export default 1' }, null, null, { cwd: '/tmp/repo' })
  const details = result.details
  assert.equal(details.outcome, 'refused')
  assert.equal(details.refused, 'net-unenforceable')
  assert.equal(details.audit.net_enforceable, false)
  assert.equal(mod.toolResultPatch({ toolName: 'lab', details }).isError, true)
})

test('the verdict tracks the real boundary', async () => {
  const dir = temp('lab-net-oracle-')
  const file = join(dir, 'bind.mjs')
  const source = [
    "import { createServer } from 'node:net'",
    'const server = createServer()',
    "server.on('error', (err) => { console.log('DENIED:' + err.code); process.exit(0) })",
    "process.on('uncaughtException', (err) => { console.log('DENIED:' + err.code); process.exit(0) })",
    "server.listen(0, '127.0.0.1', () => { console.log('BOUND'); server.close(); process.exit(0) })",
    '',
  ].join('\n')
  writeFileSync(file, source)
  try {
    const env = { ...process.env, NO_COLOR: '1' }
    delete env.NODE_OPTIONS
    delete env.FORCE_COLOR
    delete env.CLICOLOR_FORCE
    const oracle = nodeSpawnSync(process.execPath, ['--permission', `--allow-fs-read=${dir}`, '--no-warnings', file], { encoding: 'utf8', timeout: 60000, env })
    const text = `${oracle.stdout || ''}${oracle.stderr || ''}`
    const bound = text.includes('BOUND')
    const denied = text.includes('DENIED:')
    assert.equal(bound !== denied, true, text)
    const result = await realTool('export default 1')
    if (bound) assert.equal(result.details.refused, 'net-unenforceable')
    else assert.equal(result.details.outcome, 'ok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runSuite argv inserts -- and rejects an over-long path array', async () => {
  const path = 'crew/pi/extensions/subagent.test.mjs'
  const run = scriptedHarness({
    requests: [
      { id: 1, op: 'scratchCheckout', args: [] },
      { id: 2, op: 'runSuite', args: [[path]] },
    ],
    suite: { stdout: '# pass 1\n# fail 0\n' },
    deps: { kill: (pid, signal) => { if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' }) } },
  })
  const result = await run.tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
  assert.equal(result.details.outcome, 'ok')
  const suiteArgs = run.calls[1].args
  assert.equal(suiteArgs[suiteArgs.indexOf('--') + 1], path)

  const tooMany = Array.from({ length: mod.LAB_SUITE_PATHS_MAX + 1 }, () => path)
  const bad = scriptedHarness({
    requests: [
      { id: 1, op: 'scratchCheckout', args: [] },
      { id: 2, op: 'runSuite', args: [tooMany] },
    ],
  })
  await bad.tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
  assert.equal(bad.program.responses[1].refused, 'op-args-invalid')
  assert.equal(bad.calls.length, 1)
})

test('grep closes its option allowlist and forwards only mapped flags', async () => {
  const run = scriptedHarness({
    requests: [
      { id: 1, op: 'scratchCheckout', args: [] },
      { id: 2, op: 'grep', args: ['AGENT_TOOL_NAME', { ignoreCase: true, fixedString: true, pathspec: ['crew/pi/extensions/subagent.ts'] }] },
    ],
  })
  await run.tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
  assert.equal(run.program.responses[1].ok, true)
  const grep = run.syncCalls.find((one) => one.args[1]?.[0] === 'grep')?.args[1] || []
  assert.ok(grep.includes('-i'))
  assert.ok(grep.includes('-F'))
  assert.equal(grep[grep.indexOf('--') + 1], 'crew/pi/extensions/subagent.ts')

  const bad = scriptedHarness({
    requests: [
      { id: 1, op: 'scratchCheckout', args: [] },
      { id: 2, op: 'grep', args: ['x', { passthrough: true }] },
    ],
  })
  await bad.tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
  assert.equal(bad.program.responses[1].refused, 'op-args-invalid')
})

test('mutate permits an empty replacement and rejects an empty find', async () => {
  const run = scriptedHarness({
    requests: [
      { id: 1, op: 'scratchCheckout', args: [] },
      { id: 2, op: 'mutate', args: ['crew/pi/extensions/subagent.ts', 'AGENT_TOOL_NAME', ''] },
    ],
  })
  await run.tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
  assert.equal(run.program.responses[1].ok, true)
  assert.ok(run.program.responses[1].value.count > 0)

  const bad = scriptedHarness({
    requests: [
      { id: 1, op: 'scratchCheckout', args: [] },
      { id: 2, op: 'mutate', args: ['crew/pi/extensions/subagent.ts', '', 'x'] },
    ],
  })
  await bad.tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
  assert.equal(bad.program.responses[1].refused, 'op-args-invalid')
})

test('ESRCH without close settles child-failed and disarms the child', async () => {
  const clock = timers()
  const child = fakeChild(4441)
  const tool = mod.createLabTool({
    env: {}, isDirectory: () => true, mkTempDir: () => temp(), spawn: () => child,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    childTimeoutMs: 10, killGraceMs: 20, kill: (pid, signal) => {
      if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    },
  })
  const pending = tool.execute('x', { program: 'await new Promise(() => {})' }, null, null, { cwd: ROOT })
  await flush()
  clock.fire(clock.list.find((one) => one.ms === 10))
  clock.fire(clock.list.find((one) => one.ms === 20))
  clock.fire(clock.list.find((one) => one.ms === mod.LAB_STDIO_GRACE_MS))
  const result = await pending
  assert.equal(result.details.refused, 'child-failed')
  assert.equal(child.stdout.destroyed, true)
  assert.equal(child.stderr.destroyed, true)
  assert.equal(child.stdin.destroyed, true)
  assert.equal(child.unreffed, true)
})

test('an alive child at the reap budget settles child-unreaped', async () => {
  const clock = timers()
  const child = fakeChild(4442)
  const tool = mod.createLabTool({
    env: {}, isDirectory: () => true, mkTempDir: () => temp(), spawn: () => child,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    childTimeoutMs: 10, killGraceMs: 20, reapPollMs: 1, reapPollsMax: 3,
    kill: () => {},
  })
  const pending = tool.execute('x', { program: 'await new Promise(() => {})' }, null, null, { cwd: ROOT })
  await flush()
  clock.fire(clock.list.find((one) => one.ms === 10))
  clock.fire(clock.list.find((one) => one.ms === 20))
  for (let count = 0; count < 3; count += 1) {
    const poll = clock.list.filter((one) => one.ms === 1 && !one.cleared && !one.fired).at(-1)
    if (poll) clock.fire(poll)
    await flush()
  }
  const result = await pending
  assert.equal(result.details.refused, 'child-unreaped')
  assert.equal(child.unreffed, true)
})

test('a live suite without close retains its scratch and journals the path', async () => {
  const clock = timers()
  const run = scriptedHarness({
    requests: [
      { id: 1, op: 'scratchCheckout', args: [] },
      { id: 2, op: 'runSuite', args: [['crew/pi/extensions/subagent.test.mjs']] },
    ],
    suite: { close: false },
    deps: {
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      suiteTimeoutMs: 10, killGraceMs: 20, reapPollMs: 1, reapPollsMax: 2, stdioGraceMs: 1,
      childTimeoutMs: 100000, kill: () => {},
    },
  })
  const pending = run.tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
  await flush()
  clock.fire(clock.list.find((one) => one.ms === 10))
  await flush()
  clock.fire(clock.list.find((one) => one.ms === 20))
  await flush()
  for (let count = 0; count < 2; count += 1) {
    const poll = clock.list.filter((one) => one.ms === 1 && !one.cleared && !one.fired).at(-1)
    if (poll) clock.fire(poll)
    await flush()
  }
  const result = await pending
  const retained = result.details.scratch_retained
  assert.ok(retained)
  assert.equal(run.removeCalls.includes(retained), false)
  const journal = readFileSync(join(dirname(run.taskDir), 'journal.jsonl'), 'utf8')
  const row = JSON.parse(journal.trim())
  assert.equal(row.lab_run.scratch_retained, retained)
  rmSync(dirname(retained), { recursive: true, force: true })
  rmSync(run.holder, { recursive: true, force: true })
})

test('program termination kills and awaits an active suite group before retaining scratch', async () => {
  const clock = timers()
  const kills = []
  const run = scriptedHarness({
    requests: [
      { id: 1, op: 'scratchCheckout', args: [] },
      { id: 2, op: 'runSuite', args: [['crew/pi/extensions/subagent.test.mjs']] },
    ],
    suite: { close: false },
    deps: {
      childTimeoutMs: 10, killGraceMs: 20, suiteTimeoutMs: 100000,
      reapPollMs: 1, reapPollsMax: 2, stdioGraceMs: 1,
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      kill: (pid, signal) => { kills.push([pid, signal]) },
    },
  })
  const pending = run.tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
  await flush()
  clock.fire(clock.list.find((one) => one.ms === 10))
  await flush()
  for (let count = 0; count < 2; count += 1) {
    const killTimer = clock.list.filter((one) => one.ms === 20 && !one.cleared && !one.fired).at(-1)
    if (killTimer) clock.fire(killTimer)
    await flush()
  }
  for (let count = 0; count < 6; count += 1) {
    const poll = clock.list.filter((one) => one.ms === 1 && !one.cleared && !one.fired).at(-1)
    if (poll) clock.fire(poll)
    await flush()
  }
  await flush()
  for (let count = 0; count < 2; count += 1) {
    const poll = clock.list.filter((one) => one.ms === 1 && !one.cleared && !one.fired).at(-1)
    if (poll) clock.fire(poll)
    await flush()
  }
  const result = await pending
  assert.equal(result.details.refused, 'child-timeout')
  assert.ok(result.details.scratch_retained)
  assert.equal(run.removeCalls.includes(result.details.scratch_retained), false)
  assert.ok(kills.some(([pid, signal]) => pid === -2222 && signal === 'SIGTERM'))
  assert.ok(kills.some(([pid, signal]) => pid === -2222 && signal === 'SIGKILL'))
  rmSync(dirname(result.details.scratch_retained), { recursive: true, force: true })
  rmSync(run.holder, { recursive: true, force: true })
})

test('concurrent scratchCheckout calls perform one local clone', async () => {
  const run = scriptedHarness({
    requests: [
      { id: 1, op: 'scratchCheckout', args: [] },
      { id: 2, op: 'scratchCheckout', args: [] },
    ],
    concurrent: true,
  })
  const result = await run.tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
  assert.equal(result.details.outcome, 'ok')
  assert.equal(run.syncCalls.filter((one) => one.args[1]?.[0] === 'clone').length, 1)
})

test('sync operation timeout and buffer errors are typed refusals', async () => {
  for (const code of ['ETIMEDOUT', 'ENOBUFS']) {
    const run = scriptedHarness({
      requests: [{ id: 1, op: 'scratchCheckout', args: [] }],
      deps: { spawnSync: () => ({ error: { code } }) },
    })
    await run.tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
    assert.equal(run.program.responses[0].refused, code === 'ETIMEDOUT' ? 'op-timeout' : 'op-oversize')
  }
})

test('a red suite is data while a suite without TAP summary is suite-failed', async () => {
  const red = scriptedHarness({
    requests: [
      { id: 1, op: 'scratchCheckout', args: [] },
      { id: 2, op: 'runSuite', args: [['crew/pi/extensions/subagent.test.mjs']] },
    ],
    suite: { stdout: '# pass 1\n# fail 1\n', close: [1, null] },
    deps: { kill: (pid, signal) => { if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' }) } },
  })
  await red.tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
  assert.equal(red.program.responses[1].ok, true)
  assert.equal(red.program.responses[1].value.fail, 1)
  assert.equal(red.program.responses[1].value.exit_code, 1)

  const empty = scriptedHarness({
    requests: [
      { id: 1, op: 'scratchCheckout', args: [] },
      { id: 2, op: 'runSuite', args: [['crew/pi/extensions/subagent.test.mjs']] },
    ],
    suite: { stdout: 'no TAP summary\n', close: [0, null] },
    deps: { kill: (pid, signal) => { if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' }) } },
  })
  await empty.tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
  assert.equal(empty.program.responses[1].refused, 'suite-failed')
})

test('scratch clone mirrors origin values, absence, and detaches in three steps', async () => {
  const sourceUrl = 'git@example.invalid:repo.git'
  const sourceHead = 'refs/remotes/origin/main'
  const dirs = [temp('lab-program-'), temp('lab-scratch-')]
  const calls = []
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options })
    const cwd = options.cwd
    if (args[0] === 'rev-parse' && cwd === ROOT) return { status: 0, stdout: 'abcdef0\n' }
    if (args[0] === 'clone') return { status: 0, stdout: '' }
    if (args[0] === 'config' && args[1] === '--get' && cwd === ROOT) return { status: 0, stdout: `${sourceUrl}\n` }
    if (args[0] === 'config' && args[1] === '--get') return { status: 0, stdout: `${sourceUrl}\n` }
    if (args[0] === 'symbolic-ref' && args[1] === mod.LAB_ORIGIN_HEAD_REF && cwd === ROOT) return { status: 0, stdout: `${sourceHead}\n` }
    if (args[0] === 'symbolic-ref' && args[1] === mod.LAB_ORIGIN_HEAD_REF) return { status: 0, stdout: `${sourceHead}\n` }
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'abcdef0\n' }
    if (args[0] === 'symbolic-ref' && args[1] === '-q') return { status: 1, stdout: '' }
    return { status: 0, stdout: '' }
  }
  const run = scriptedHarness({
    requests: [{ id: 1, op: 'scratchCheckout', args: [] }],
    deps: { spawnSync, mkTempDir: () => dirs.shift(), realpath: (path) => path },
  })
  await run.tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
  const args = calls.map((one) => one.args)
  const clone = args.findIndex((one) => one[0] === 'clone')
  const originSet = args.findIndex((one) => one[0] === 'config' && one[1] === 'remote.origin.url')
  const headSet = args.findIndex((one) => one[0] === 'symbolic-ref' && one[1] === mod.LAB_ORIGIN_HEAD_REF && one.length === 3)
  const detach = args.findIndex((one) => one[0] === 'checkout' && one[1] === '--detach')
  assert.ok(clone >= 0 && originSet > clone && headSet > originSet && detach > headSet)
  assert.equal(run.program.responses[0].value.origin_url, sourceUrl)
  assert.equal(run.program.responses[0].value.origin_head, sourceHead)
  assert.equal(run.program.responses[0].value.detached, true)

  const absentDirs = [temp('lab-program-'), temp('lab-scratch-')]
  const absentCalls = []
  const absentSpawnSync = (command, args, options) => {
    absentCalls.push(args)
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'abcdef0\n' }
    if (args[0] === 'clone') return { status: 0, stdout: '' }
    if (args[0] === 'symbolic-ref' && args[1] === '-q') return { status: 1, stdout: '' }
    if (args[0] === 'config' && args[1] === '--get') return { status: 1, stdout: '' }
    if (args[0] === 'symbolic-ref' && args[1] === mod.LAB_ORIGIN_HEAD_REF) return { status: 1, stdout: '' }
    if (args[0] === 'checkout') return { status: 0, stdout: '' }
    return { status: 1, stdout: '' }
  }
  const absent = scriptedHarness({
    requests: [{ id: 1, op: 'scratchCheckout', args: [] }],
    deps: { spawnSync: absentSpawnSync, mkTempDir: () => absentDirs.shift(), realpath: (path) => path },
  })
  await absent.tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
  assert.ok(absentCalls.some((one) => one[0] === 'config' && one[1] === '--unset-all'))
  assert.ok(absentCalls.some((one) => one[0] === 'symbolic-ref' && one[1] === '--delete'))
  assert.equal(absent.program.responses[0].value.origin_url, null)
  assert.equal(absent.program.responses[0].value.origin_head, null)
})

test('scratch cleanup removes the clone parent and never invokes git worktree', async () => {
  const run = scriptedHarness({ requests: [{ id: 1, op: 'scratchCheckout', args: [] }] })
  const result = await run.tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
  const scratch = run.program.responses[0].value.path
  assert.ok(run.removeCalls.includes(scratch))
  assert.ok(run.removeCalls.includes(dirname(scratch)))
  assert.equal(run.syncCalls.some((one) => one.args[1]?.[0] === 'worktree'), false)
})

test('the widened runner startup audit refuses a fs-write grant', () => {
  const dir = temp('lab-audit-')
  const program = join(dir, 'program.mjs')
  const runner = join(dir, 'runner.mjs')
  writeFileSync(program, 'export default 1\n')
  writeFileSync(runner, mod.runnerSource(`file://${program}`))
  const args = mod.labChildArgs({ runnerPath: runner, allowRead: mod.allowReadPaths(dir) })
  args.splice(args.indexOf(runner), 0, '--allow-fs-write=/')
  const env = { ...process.env, NO_COLOR: '1' }
  delete env.NODE_OPTIONS
  const child = nodeSpawnSync(process.execPath, args, { cwd: dir, env, encoding: 'utf8' })
  const frame = String(child.stdout || '').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).find((one) => one?.done)
  assert.equal(frame.refused, frame.audit.net_enforceable ? 'child-denied' : 'net-unenforceable')
  assert.ok(frame.audit.granted.some((one) => one.startsWith('fs.write:')))
  rmSync(dir, { recursive: true, force: true })
})

test('a suite overflow kills its detached group and returns op-oversize', async () => {
  const clock = timers()
  const kills = []
  const run = scriptedHarness({
    requests: [
      { id: 1, op: 'scratchCheckout', args: [] },
      { id: 2, op: 'runSuite', args: [['crew/pi/extensions/subagent.test.mjs']] },
    ],
    suite: { stdout: Buffer.alloc(400, 120), close: false },
    deps: {
      streamCapBytes: 256, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      killGraceMs: 20, stdioGraceMs: 1, childTimeoutMs: 100000,
      kill: (pid, signal) => { kills.push([pid, signal]); if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' }) },
    },
  })
  const pending = run.tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
  await flush()
  await flush()
  clock.fire(clock.list.find((one) => one.ms === 20))
  await flush()
  clock.fire(clock.list.find((one) => one.ms === 1))
  const result = await pending
  assert.equal(run.program.responses[1].refused, 'op-oversize')
  assert.equal(result.details.outcome, 'ok')
  assert.ok(kills.some(([pid, signal]) => pid === -2222 && signal === 'SIGTERM'))
  assert.ok(kills.some(([pid, signal]) => pid === -2222 && signal === 'SIGKILL'))
})

test('an unreaped child is disarmed and cannot start a host op after settlement', async () => {
  const clock = timers()
  const child = fakeChild(5551)
  let syncCalls = 0
  let reads = 0
  const tool = mod.createLabTool({
    env: {}, isDirectory: () => true, mkTempDir: () => temp(), spawn: () => child,
    spawnSync: () => { syncCalls += 1; return { status: 0, stdout: '' } },
    readFile: () => { reads += 1; return '' },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    childTimeoutMs: 10, killGraceMs: 20, reapPollMs: 1, reapPollsMax: 1, kill: () => {},
  })
  const pending = tool.execute('x', { program: 'await new Promise(() => {})' }, null, null, { cwd: ROOT })
  await flush()
  clock.fire(clock.list.find((one) => one.ms === 10))
  clock.fire(clock.list.find((one) => one.ms === 20))
  clock.fire(clock.list.find((one) => one.ms === 1))
  const result = await pending
  assert.equal(result.details.refused, 'child-unreaped')
  const before = [syncCalls, reads]
  child.stdout.emit('data', Buffer.from('{"id":1,"op":"scratchCheckout","args":[]}\n'))
  await flush()
  assert.deepEqual([syncCalls, reads], before)
  assert.equal(child.stdout.listenerCount('data'), 0)
  assert.equal(child.stderr.listenerCount('data'), 0)
  assert.equal(child.stdin.destroyed, true)
  assert.equal(child.stdout.destroyed, true)
  assert.equal(child.stderr.destroyed, true)
  assert.equal(child.unreffed, true)
})

test('a queued operation cannot start after the deadline begins', async () => {
  const clock = timers()
  const child = fakeChild(5552)
  const requests = [
    { id: 1, op: 'scratchCheckout', args: [] },
    { id: 2, op: 'read', args: ['package.json'] },
  ]
  let fired = false
  let reads = 0
  const realSync = nodeSpawnSync
  const spawnSync = (...args) => {
    if (!fired) {
      fired = true
      clock.fire(clock.list.find((one) => one.ms === 10))
    }
    return realSync(...args)
  }
  child.kill = (signal) => {
    child.kills.push(signal)
    if (signal === 'SIGTERM') queueMicrotask(() => child.emit('close', null, 'SIGTERM'))
    return true
  }
  const tool = mod.createLabTool({
    env: {}, isDirectory: () => true, mkTempDir: () => temp(), spawn: () => {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(requests[0])}\n${JSON.stringify(requests[1])}\n`)))
      return child
    }, spawnSync, readFile: () => { reads += 1; return '' },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, childTimeoutMs: 10, killGraceMs: 20,
  })
  const result = await tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
  assert.equal(result.details.refused, 'child-timeout')
  assert.equal(reads, 0)
})

test('suite termination targets its detached process group at both rungs', async () => {
  const clock = timers()
  const kills = []
  const run = scriptedHarness({
    requests: [
      { id: 1, op: 'scratchCheckout', args: [] },
      { id: 2, op: 'runSuite', args: [['crew/pi/extensions/subagent.test.mjs']] },
    ],
    suite: { close: false },
    deps: {
      suiteTimeoutMs: 10, killGraceMs: 20, stdioGraceMs: 1, childTimeoutMs: 100000,
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      kill: (pid, signal) => { kills.push([pid, signal]); if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' }) },
    },
  })
  const pending = run.tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
  await flush()
  clock.fire(clock.list.find((one) => one.ms === 10))
  await flush()
  clock.fire(clock.list.find((one) => one.ms === 20))
  await flush()
  clock.fire(clock.list.find((one) => one.ms === 1))
  const result = await pending
  assert.equal(run.calls[1].options.detached, true)
  assert.ok(kills.some(([pid, signal]) => pid === -2222 && signal === 'SIGTERM'))
  assert.ok(kills.some(([pid, signal]) => pid === -2222 && signal === 'SIGKILL'))
  assert.equal(result.details.outcome, 'ok')
})

test('a live suite peer after clean parent close retains scratch, while gone permits removal', async () => {
  const make = (live) => {
    const clock = timers()
    const run = scriptedHarness({
      requests: [
        { id: 1, op: 'scratchCheckout', args: [] },
        { id: 2, op: 'runSuite', args: [['crew/pi/extensions/subagent.test.mjs']] },
      ],
      suite: { stdout: '# pass 1\n# fail 0\n', close: [0, null] },
      deps: {
        reapPollMs: 1, reapPollsMax: 2, childTimeoutMs: 100000,
        setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        kill: (pid, signal) => { if (signal === 0 && live) return; if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' }) },
      },
    })
    return { clock, run }
  }
  const live = make(true)
  const livePending = live.run.tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
  await flush()
  for (let count = 0; count < 2; count += 1) {
    const poll = live.clock.list.filter((one) => one.ms === 1 && !one.cleared && !one.fired).at(-1)
    if (poll) live.clock.fire(poll)
    await flush()
  }
  const liveResult = await livePending
  assert.ok(liveResult.details.scratch_retained)
  assert.equal(live.run.removeCalls.includes(liveResult.details.scratch_retained), false)
  const liveJournal = JSON.parse(readFileSync(join(dirname(live.run.taskDir), 'journal.jsonl'), 'utf8').trim())
  assert.equal(liveJournal.lab_run.scratch_retained, liveResult.details.scratch_retained)
  rmSync(dirname(liveResult.details.scratch_retained), { recursive: true, force: true })
  rmSync(live.run.holder, { recursive: true, force: true })

  const gone = make(false)
  const gonePending = gone.run.tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
  await flush()
  const goneResult = await gonePending
  assert.equal(goneResult.details.outcome, 'ok')
  const goneScratch = gone.run.program.responses[1].value.paths
  assert.ok(Array.isArray(goneScratch))
})

test('detached is read back from symbolic-ref -q HEAD, including attached absence', async () => {
  const runClone = (detached) => {
    const dirs = [temp('lab-program-'), temp('lab-scratch-')]
    const spawnSync = (command, args, options) => {
      if (args[0] === 'clone') return { status: 0, stdout: '' }
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'abcdef0\n' }
      if (args[0] === 'config' && args[1] === '--get') return { status: 0, stdout: 'origin\n' }
      if (args[0] === 'symbolic-ref' && args[1] === mod.LAB_ORIGIN_HEAD_REF) return { status: 0, stdout: 'refs/remotes/origin/main\n' }
      if (args[0] === 'symbolic-ref' && args[1] === '-q') return detached ? { status: 1, stdout: '' } : { status: 0, stdout: 'refs/heads/main\n' }
      return { status: 0, stdout: '' }
    }
    return scriptedHarness({ requests: [{ id: 1, op: 'scratchCheckout', args: [] }], deps: { spawnSync, mkTempDir: () => dirs.shift(), realpath: (path) => path } })
  }
  const detached = runClone(true)
  await detached.tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
  assert.equal(detached.program.responses[0].value.detached, true)
  const attached = runClone(false)
  await attached.tool.execute('x', { program: 'export default 1' }, null, null, { cwd: ROOT })
  assert.equal(attached.program.responses[0].value.detached, false)
})
