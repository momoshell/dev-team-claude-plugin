// hooks/dispatch-guard.mjs (be-78-02) — the orchestrator-side PreToolUse
// substrate guard. Every test drives the guard as a SUBPROCESS
// (spawnSync(process.execPath, [GUARD_PATH], { input, env })). The module is
// never imported directly in this file: it runs main() unconditionally at
// load time and would read this test runner's own stdin. The two tests that
// need a pure exported function (buildDenyReason, REASON_CODES) instead
// spawn a tiny --input-type=module eval script with DEVTEAM_WORKER=1 set —
// that env var short-circuits main() before it ever touches stdin, so the
// dynamic import() inside that CHILD process cannot block on anything.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { ROOT } from './helpers.mjs'

const GUARD_PATH = join(ROOT, 'hooks', 'dispatch-guard.mjs')
const GUARD_SOURCE = readFileSync(GUARD_PATH, 'utf8')
const GUARD_URL = pathToFileURL(GUARD_PATH).href

// TEST HERMETICITY CANARY (mandatory, mirrors test/cmux-dispatch.test.mjs:44-69):
// both the roster home layer and the decision-log path derive from HOME, so
// every fixture below pins it to a fresh temp dir. REAL_HOME is captured
// once, up front, and every fresh home dir is asserted to differ from it —
// a silently deleted pin fails the suite instead of writing into the real
// developer ~/.dev-team.
const REAL_HOME = homedir()

const producedCodes = new Set()
const allResults = []

function makeHome({ config } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-guard-home-'))
  assert.notEqual(dir, REAL_HOME, 'TEST HERMETICITY CANARY: HOME pin must differ from the real developer home')
  if (config !== undefined) writeConfig(dir, config)
  return dir
}

function makeCwd({ config, roster } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-guard-cwd-'))
  if (config !== undefined) writeConfig(dir, config)
  if (roster !== undefined) writeRosterRaw(dir, roster)
  return dir
}

function writeConfig(dir, content) {
  const d = join(dir, '.claude', 'dev-team')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'config.md'), content)
}

function writeRosterRaw(dir, content) {
  const d = join(dir, '.claude', 'dev-team')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'roster.json'), typeof content === 'string' ? content : JSON.stringify(content))
}

function baselineInput(overrides = {}) {
  return {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'dev-team:coder', description: 'd', prompt: 'p' },
    session_id: 'sess-baseline',
    ...overrides,
  }
}

function runGuard(input, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides }
  delete env.USERPROFILE
  // This suite may itself be executing inside a DEVTEAM_WORKER=1 environment
  // (a cmux worker pane) — that ambient value must never leak into a
  // fixture that isn't deliberately exercising the DEVTEAM_WORKER branch,
  // or every "denies"/"allows with <reason_code>" assertion below would
  // silently see the DEVTEAM_WORKER early exit instead.
  if (!('DEVTEAM_WORKER' in envOverrides)) delete env.DEVTEAM_WORKER
  const stdinPayload = typeof input === 'string' ? input : JSON.stringify(input)
  const result = spawnSync(process.execPath, [GUARD_PATH], { input: stdinPayload, encoding: 'utf8', env })
  allResults.push(result)
  return result
}

function readLogLines(home) {
  const p = join(home, '.dev-team', 'guard', 'dispatch-guard.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

// setupBaseline(): AC4's canonical deny-qualifying fixture. cwd carries no
// config.md and no roster.json; HOME carries a single execution_mode: cmux
// line and no roster.json.
function setupBaseline() {
  const home = makeHome({ config: 'execution_mode: cmux\n' })
  const cwd = makeCwd()
  return { home, cwd }
}

// runFixture(): baseline plus overrides, returns { result, home, cwd, logLines }.
// Tracks every observed reason_code into producedCodes (AC7).
function runFixture({ home: homeOverride, cwd: cwdOverride, inputOverrides = {}, envOverrides = {}, rawInput } = {}) {
  const home = homeOverride !== undefined ? homeOverride : makeHome({ config: 'execution_mode: cmux\n' })
  const cwd = cwdOverride !== undefined ? cwdOverride : makeCwd()
  const input = rawInput !== undefined ? rawInput : baselineInput({ cwd, ...inputOverrides })
  const result = runGuard(input, { HOME: home, ...envOverrides })
  const logLines = readLogLines(home)
  if (logLines.length > 0) producedCodes.add(logLines[logLines.length - 1].reason_code)
  return { result, home, cwd, logLines }
}

function evalInGuardModule(expr) {
  const script = `import * as guard from ${JSON.stringify(GUARD_URL)}; process.stdout.write(JSON.stringify(${expr}))`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, DEVTEAM_WORKER: '1' },
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

// ---------------------------------------------------------------------------
// AC4 — the canonical deny-qualifying baseline.
// ---------------------------------------------------------------------------

test('AC4: the canonical baseline (main-thread dev-team:coder, cmux via HOME) denies', () => {
  const { result, logLines } = runFixture()
  assert.equal(result.status, 0)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(logLines.length, 1)
  assert.equal(logLines[0].decision, 'deny')
  assert.equal(logLines[0].reason_code, 'denied')
})

// ---------------------------------------------------------------------------
// AC5 — decision-flip deltas: baseline + ONE change, expect allow.
// ---------------------------------------------------------------------------

test('AC5a: DEVTEAM_WORKER=1 allows and writes no log line at all', () => {
  const home = makeHome({ config: 'execution_mode: cmux\n' })
  const cwd = makeCwd()
  const result = runGuard(baselineInput({ cwd }), { HOME: home, DEVTEAM_WORKER: '1' })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(readLogLines(home).length, 0)
})

test('AC5b: stdin padded past 256 KiB (still valid JSON, still deny-qualifying) allows with oversize_stdin', () => {
  const cwd = makeCwd()
  const oversizeInput = { ...baselineInput({ cwd }), padding: 'x'.repeat(300 * 1024) }
  const { result, logLines } = runFixture({ cwd, rawInput: oversizeInput })
  assert.equal(result.status, 0)
  assert.equal(logLines.length, 1)
  assert.equal(logLines[0].decision, 'allow')
  assert.equal(logLines[0].reason_code, 'oversize_stdin')
})

test('AC5c: tool_name "Task" (the pre-Phase-0 wrong literal) allows with wrong_tool', () => {
  const { logLines } = runFixture({ inputOverrides: { tool_name: 'Task' } })
  assert.equal(logLines.length, 1)
  assert.equal(logLines[0].decision, 'allow')
  assert.equal(logLines[0].reason_code, 'wrong_tool')
})

test('AC5d: agent_id present allows with nested_call', () => {
  const { logLines } = runFixture({ inputOverrides: { agent_id: 'abc-123' } })
  assert.equal(logLines[0].reason_code, 'nested_call')
})

test('AC5e: agent_type "workflow-subagent" (Phase 0 P3) allows with nested_call', () => {
  const { logLines } = runFixture({ inputOverrides: { agent_type: 'workflow-subagent' } })
  assert.equal(logLines[0].reason_code, 'nested_call')
})

test('AC5f: subagent_type "coder" with no dev-team: prefix allows with not_dev_team', () => {
  const { logLines } = runFixture({
    inputOverrides: { tool_input: { subagent_type: 'coder', description: 'd', prompt: 'p' } },
  })
  assert.equal(logLines[0].reason_code, 'not_dev_team')
})

test('AC5g: project roster layer flips coder pane false, allows with pane_false', () => {
  const cwd = makeCwd({ roster: { roles: { coder: { pane: false } } } })
  const { logLines } = runFixture({ cwd })
  assert.equal(logLines[0].decision, 'allow')
  assert.equal(logLines[0].reason_code, 'pane_false')
})

test('AC5h: project roster layer flips code-reviewer pane true, allows with not_pane_rollout', () => {
  const cwd = makeCwd({ roster: { roles: { 'code-reviewer': { pane: true } } } })
  const { logLines } = runFixture({
    cwd,
    inputOverrides: { tool_input: { subagent_type: 'dev-team:code-reviewer', description: 'd', prompt: 'p' } },
  })
  assert.equal(logLines[0].decision, 'allow')
  assert.equal(logLines[0].reason_code, 'not_pane_rollout')
})

test('AC5i: project config carrying execution_mode: agent-tool allows with mode_not_cmux (source project)', () => {
  const cwd = makeCwd({ config: 'execution_mode: agent-tool\n' })
  const { logLines } = runFixture({ cwd })
  assert.equal(logLines[0].reason_code, 'mode_not_cmux')
  assert.equal(logLines[0].mode, 'agent-tool')
  assert.equal(logLines[0].mode_source, 'project')
})

test('AC5j: HOME config removed, both layers silent, default mode allows with mode_not_cmux (source default)', () => {
  const home = makeHome()
  const cwd = makeCwd()
  const { logLines } = runFixture({ home, cwd })
  assert.equal(logLines[0].reason_code, 'mode_not_cmux')
  assert.equal(logLines[0].mode, 'agent-tool')
  assert.equal(logLines[0].mode_source, 'default')
})

// ---------------------------------------------------------------------------
// AC6 — exception-path deltas: the mutation criterion is the REASON CODE.
// ---------------------------------------------------------------------------

test('AC6a: malformed JSON on stdin allows with bad_stdin', () => {
  const { logLines } = runFixture({ rawInput: '{not valid json' })
  assert.equal(logLines[0].reason_code, 'bad_stdin')
})

test('AC6a-null: valid-JSON top-level null allows with bad_stdin (not a crash to internal_error)', () => {
  const { result, logLines } = runFixture({ rawInput: 'null' })
  assert.equal(result.status, 0)
  assert.equal(logLines[0].reason_code, 'bad_stdin')
})

test('AC6a-array: valid-JSON top-level array allows with bad_stdin', () => {
  const { result, logLines } = runFixture({ rawInput: '[1,2,3]' })
  assert.equal(result.status, 0)
  assert.equal(logLines[0].reason_code, 'bad_stdin')
})

test('AC6f-proto: subagent_type "dev-team:__proto__" (prototype key, not an own roster role) allows with unknown_role', () => {
  const { result, logLines } = runFixture({ inputOverrides: { tool_input: { subagent_type: 'dev-team:__proto__' } } })
  assert.equal(result.status, 0)
  assert.equal(logLines[0].reason_code, 'unknown_role')
})

test('AC6b: tool_input.subagent_type absent allows with bad_subagent_type', () => {
  const { logLines } = runFixture({ inputOverrides: { tool_input: { description: 'd', prompt: 'p' } } })
  assert.equal(logLines[0].reason_code, 'bad_subagent_type')
})

test('AC6c: subagent_type "dev-team:coder!!" (charset fail) allows with bad_subagent_type', () => {
  const { logLines } = runFixture({
    inputOverrides: { tool_input: { subagent_type: 'dev-team:coder!!', description: 'd', prompt: 'p' } },
  })
  assert.equal(logLines[0].reason_code, 'bad_subagent_type')
})

test('AC6d: subagent_type "dev-team:" + 200 chars (length fail) allows with bad_subagent_type', () => {
  const { logLines } = runFixture({
    inputOverrides: { tool_input: { subagent_type: `dev-team:${'a'.repeat(200)}`, description: 'd', prompt: 'p' } },
  })
  assert.equal(logLines[0].reason_code, 'bad_subagent_type')
})

test('AC6e: cwd absent or non-absolute allows with bad_cwd', () => {
  const { logLines } = runFixture({ inputOverrides: { cwd: 'relative/path' } })
  assert.equal(logLines[0].reason_code, 'bad_cwd')
  assert.equal(logLines[0].cwd, null)
})

test('AC6f: subagent_type "dev-team:architect" (SUBAGENT_ONLY, not a roster role) allows with unknown_role', () => {
  const { logLines } = runFixture({
    inputOverrides: { tool_input: { subagent_type: 'dev-team:architect', description: 'd', prompt: 'p' } },
  })
  assert.equal(logLines[0].reason_code, 'unknown_role')
})

test('AC6g: project config with two execution_mode lines allows with mode_error', () => {
  const cwd = makeCwd({ config: 'execution_mode: cmux\nexecution_mode: cmux\n' })
  const { logLines } = runFixture({ cwd })
  assert.equal(logLines[0].reason_code, 'mode_error')
  assert.equal(logLines[0].mode, null)
})

test('AC6h: HOME config with two execution_mode lines, project silent, allows with mode_error', () => {
  const home = makeHome({ config: 'execution_mode: cmux\nexecution_mode: agent-tool\n' })
  const cwd = makeCwd()
  const { logLines } = runFixture({ home, cwd })
  assert.equal(logLines[0].reason_code, 'mode_error')
})

test('AC6i: execution_mode: banana allows with mode_error', () => {
  const cwd = makeCwd({ config: 'execution_mode: banana\n' })
  const { logLines } = runFixture({ cwd })
  assert.equal(logLines[0].reason_code, 'mode_error')
})

test('AC6j: project roster.json violates roster.schema.json allows with roster_error', () => {
  const cwd = makeCwd({ roster: { roles: { coder: { pane: 'nope' } } } })
  const { logLines } = runFixture({ cwd })
  assert.equal(logLines[0].reason_code, 'roster_error')
})

test('AC6k: project roster.json is malformed JSON allows with roster_error', () => {
  const cwd = makeCwd({ roster: '{not valid json' })
  const { logLines } = runFixture({ cwd })
  assert.equal(logLines[0].reason_code, 'roster_error')
})

test('AC6l: project roster.json with file mode 000 (unreadable) allows with roster_error', { skip: process.getuid && process.getuid() === 0 ? 'running as root: permission bits are not enforced' : false }, () => {
  const cwd = makeCwd({ roster: { roles: { coder: { pane: true } } } })
  chmodSync(join(cwd, '.claude', 'dev-team', 'roster.json'), 0o000)
  const { logLines } = runFixture({ cwd })
  assert.equal(logLines[0].reason_code, 'roster_error')
})

// ---------------------------------------------------------------------------
// AC7 — the reason_code vocabulary is frozen and every member is exercised.
// ---------------------------------------------------------------------------

const EXPECTED_REASON_CODES = [
  'bad_stdin', 'oversize_stdin', 'wrong_tool', 'nested_call', 'bad_subagent_type',
  'not_dev_team', 'bad_cwd', 'unknown_role', 'pane_false', 'not_pane_rollout',
  'mode_not_cmux', 'mode_error', 'roster_error', 'internal_error',
  'node_unresolved', 'log_ceiling_reached', 'denied',
]

test('AC7: REASON_CODES is a frozen array with the exact 17-member vocabulary in evaluation order', () => {
  const out = evalInGuardModule('{ codes: guard.REASON_CODES, frozen: Object.isFrozen(guard.REASON_CODES) }')
  assert.deepEqual(out.codes, EXPECTED_REASON_CODES)
  assert.ok(out.frozen, 'REASON_CODES must be frozen')

  const needle = ['REASON_CODES', ' = ', 'Object', '.', 'freeze', '('].join('')
  assert.ok(GUARD_SOURCE.includes(needle), 'REASON_CODES must be declared via Object.freeze(...)')
})

// ---------------------------------------------------------------------------
// AC10 — the decision log (part 1: ceiling + unwritable-path; the byte-level
// pins live alongside the fixtures above via producedCodes/logLines checks).
// ---------------------------------------------------------------------------

test('AC10: decision-log line key set deep-equals the frozen nine-key field list, in order', () => {
  const { logLines } = runFixture()
  assert.deepEqual(
    Object.keys(logLines[0]),
    ['ts', 'decision', 'reason_code', 'tool_name', 'role', 'mode', 'mode_source', 'cwd', 'session_id'],
  )
})

test('AC10: a cwd carrying a NUL byte and an ANSI colour escape, 4000 chars long, is stripped and capped at 512 in the log', () => {
  const pad = 'a'.repeat(4000 - 7)
  const rawCwd = `/\x00\x1B[31m${pad}`
  const { logLines } = runFixture({ inputOverrides: { cwd: rawCwd } })
  const logged = logLines[0].cwd
  assert.equal(typeof logged, 'string')
  assert.equal(logged.length, 512)
  assert.equal(logged.includes('\x00'), false)
  assert.equal(logged.includes('\x1B'), false)
  const expectedStripped = `/[31m${pad}`.slice(0, 512)
  assert.equal(logged, expectedStripped)
})

test('AC10: an unwritable log destination never changes stdout or exit code', () => {
  const cwd = makeCwd()
  const homeA = makeHome({ config: 'execution_mode: cmux\n' })
  const controlResult = runGuard(baselineInput({ cwd }), { HOME: homeA })

  const homeB = makeHome({ config: 'execution_mode: cmux\n' })
  mkdirSync(join(homeB, '.dev-team'), { recursive: true })
  writeFileSync(join(homeB, '.dev-team', 'guard'), 'not a directory')
  const blockedResult = runGuard(baselineInput({ cwd }), { HOME: homeB })

  assert.equal(blockedResult.status, controlResult.status)
  assert.equal(blockedResult.stdout, controlResult.stdout)
})

test('AC10: the log ceiling marker is written once per over-ceiling state, not per call', () => {
  const cwd = makeCwd()
  const home = makeHome({ config: 'execution_mode: cmux\n' })
  const logDir = join(home, '.dev-team', 'guard')
  mkdirSync(logDir, { recursive: true })
  const logPath = join(logDir, 'dispatch-guard.jsonl')
  const prefill = Buffer.concat([Buffer.alloc(32 * 1024 * 1024 + 1024, 'x'), Buffer.from('\n')])
  writeFileSync(logPath, prefill)

  const first = runGuard(baselineInput({ cwd }), { HOME: home })
  assert.equal(first.status, 0)
  const linesAfterFirst = readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
  const lastLine = JSON.parse(linesAfterFirst[linesAfterFirst.length - 1])
  assert.equal(lastLine.reason_code, 'log_ceiling_reached')
  assert.equal(lastLine.decision, 'none')
  producedCodes.add('log_ceiling_reached')
  const countAfterFirst = linesAfterFirst.length

  const second = runGuard(baselineInput({ cwd }), { HOME: home })
  assert.equal(second.status, 0)
  const linesAfterSecond = readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
  assert.equal(linesAfterSecond.length, countAfterFirst, 'a second over-ceiling evaluation must append nothing further')
})

// ---------------------------------------------------------------------------
// AC7 (completeness, run last so producedCodes has been populated by every
// fixture above) + AC8 — internal_error is a distinct catch-all.
// ---------------------------------------------------------------------------

test('AC7: every reason code except internal_error/node_unresolved/log_ceiling_reached is exercised by a fixture in this file', () => {
  const exemptHere = new Set(['internal_error', 'node_unresolved'])
  for (const code of EXPECTED_REASON_CODES) {
    if (exemptHere.has(code)) continue
    assert.ok(producedCodes.has(code), `reason_code never produced by any fixture: ${code}`)
  }
})

test('AC8: no AC6 (or AC5) fixture in this file ever produced internal_error', () => {
  assert.equal(producedCodes.has('internal_error'), false, 'a fixture fell through to the catch-all — its named branch is missing')
})

// ---------------------------------------------------------------------------
// AC9 — the deny is proven by roster MUTATION, and PANE_ROLES is pinned.
// ---------------------------------------------------------------------------

test('AC9: PANE_ROLES appears exactly twice in dispatch-guard.mjs (the import, and one usage combined with the pane read)', () => {
  const occurrences = GUARD_SOURCE.split('PANE_ROLES').length - 1
  assert.equal(occurrences, 2)
  const usageLine = GUARD_SOURCE.split('\n').find((l) => l.includes('PANE_ROLES.includes'))
  assert.ok(usageLine, 'expected a PANE_ROLES.includes(...) usage line')
  const combinedNeedle = ['paneEnabled', ' || ', '!', 'rolloutListed'].join('')
  assert.ok(GUARD_SOURCE.includes(combinedNeedle), 'PANE_ROLES.includes result must be combined with the pane read in one boolean expression')
})

// ---------------------------------------------------------------------------
// AC11 — the deny reason's required content.
// ---------------------------------------------------------------------------

test('AC11: the baseline deny reason names the role, the mode source, and the ordered corrective chain', () => {
  const { result } = runFixture()
  const parsed = JSON.parse(result.stdout)
  const reason = parsed.hookSpecificOutput.permissionDecisionReason
  assert.ok(reason.includes('dev-team:coder'))
  assert.ok(reason.includes('source: home'))
  const workspaceIdx = reason.indexOf('workspace')
  const dispatchSliceIdx = reason.indexOf('dispatch --slice')
  assert.ok(workspaceIdx >= 0 && dispatchSliceIdx > workspaceIdx, 'the word workspace must precede "dispatch --slice"')
  assert.ok(reason.includes('await --all'))
  assert.ok(reason.includes('this call will be denied identically on every retry, do not retry it'))
  assert.ok(reason.includes('/dev-team:team mode agent-tool'))
  assert.ok(reason.includes('code-reviewer'))
  assert.ok(reason.includes('build-validator'))
  assert.ok(reason.includes('test-engineer'))
  assert.ok(reason.includes('doc-writer'))
})

test('AC11: construction — buildDenyReason(64-char role, "home") stays <= 1200 chars and keeps all four clauses', () => {
  const role = 'a'.repeat(64)
  const out = evalInGuardModule(
    `(() => { const r = guard.buildDenyReason(${JSON.stringify(role)}, 'home'); return { length: r.length, reason: r } })()`,
  )
  assert.ok(out.length <= 1200, `reason too long: ${out.length}`)
  assert.ok(out.reason.includes(role))
  assert.ok(out.reason.includes('home'))
  assert.ok(out.reason.includes('this call will be denied identically on every retry, do not retry it'))
  assert.ok(out.reason.includes('/dev-team:team mode agent-tool'))
  const workspaceIdx = out.reason.indexOf('workspace')
  const dispatchSliceIdx = out.reason.indexOf('dispatch --slice')
  assert.ok(workspaceIdx >= 0 && dispatchSliceIdx > workspaceIdx)
  assert.ok(out.reason.includes('unaffected'))
})

// ---------------------------------------------------------------------------
// AC12 — the 3-layer roster call is pinned.
// ---------------------------------------------------------------------------

test('AC12: loadRoster is invoked with session: null, with a comment naming why', () => {
  const needle = ['session', ':', ' null'].join('')
  assert.ok(GUARD_SOURCE.includes(needle), 'loadRoster must be called with session: null')
  assert.ok(GUARD_SOURCE.includes('unreachable from a hook'), 'the session: null argument must carry an explanatory comment')
})

// ---------------------------------------------------------------------------
// AC13 — never exit 2, never emit allow.
// ---------------------------------------------------------------------------

test('AC13: source pins — no exit(2), no process.exitCode = 2, no permissionDecision allow literal', () => {
  const exitTwoNeedle = ['exit', '(', '2', ')'].join('')
  assert.equal(GUARD_SOURCE.includes(exitTwoNeedle), false)
  const exitCodeTwoNeedle = ['exitCode', ' = ', '2'].join('')
  assert.equal(GUARD_SOURCE.includes(exitCodeTwoNeedle), false)
  const allowLiteralRe = /permissionDecision['":\s]*:\s*['"]allow['"]/
  assert.equal(allowLiteralRe.test(GUARD_SOURCE), false)
})

test('AC13: across every fixture run in this file, exit status is 0 and no output ever carries permissionDecision allow', () => {
  assert.ok(allResults.length > 0, 'this suite must have run at least one fixture by this point')
  for (const r of allResults) {
    assert.equal(r.status, 0)
    if (r.stdout) {
      const parsed = JSON.parse(r.stdout)
      if (parsed && parsed.hookSpecificOutput) {
        assert.notEqual(parsed.hookSpecificOutput.permissionDecision, 'allow')
      }
    }
  }
})

// ---------------------------------------------------------------------------
// AC14 — layering is exercised through the real reader with real temp files.
// Covered structurally: every mode-resolution fixture above (AC5i/j,
// AC6g/h/i) writes actual .claude/dev-team/config.md files under a temp cwd
// and/or a temp HOME via makeCwd/makeHome — no hand-written config strings
// are ever passed to the guard directly.
// ---------------------------------------------------------------------------
