import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { ROOT } from './helpers.mjs'

const hooksJson = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'))
const sessionStart = hooksJson.hooks.SessionStart
const orchestrationCommand = sessionStart[0].hooks[0].command
const clearCommand = sessionStart[1].hooks[0].command

test('hooks.json has the two expected SessionStart entries in order', () => {
  assert.equal(sessionStart.length, 2)
  assert.equal(sessionStart[0].matcher, undefined)
  assert.equal(sessionStart[1].matcher, 'clear')
})

test('the orchestration command starts with the DEVTEAM_WORKER guard', () => {
  assert.ok(
    orchestrationCommand.startsWith('if [ -n "${DEVTEAM_WORKER:-}" ]; then'),
    'command must lead with the DEVTEAM_WORKER guard'
  )
})

test('the guard emits the exact suppression systemMessage literal', () => {
  assert.ok(
    orchestrationCommand.includes(
      "printf '%s\\n' '{\"systemMessage\":\"dev-team orchestration suppressed: DEVTEAM_WORKER=1\"}'"
    ),
    'command must contain the exact systemMessage printf literal'
  )
})

test('the guard exits 0 before falling through to the jq check', () => {
  assert.ok(
    orchestrationCommand.includes('exit 0; fi; command -v jq'),
    'guard must exit 0 and then fall through to the existing jq-availability check'
  )
})

test('the jq-missing degradation message and exit code are preserved', () => {
  assert.ok(
    orchestrationCommand.includes(
      "dev-team: jq is required for the SessionStart hook (brew install jq / apt install jq) — orchestration.md was not loaded this session."
    ),
    'jq-missing message must be preserved verbatim'
  )
  assert.ok(
    orchestrationCommand.includes(">&2; exit 0; }"),
    'jq-missing path must still exit 0'
  )
})

test('the orchestration.md content is still loaded via --rawfile', () => {
  assert.ok(
    orchestrationCommand.includes('--rawfile content "${CLAUDE_PLUGIN_ROOT}/orchestration.md"'),
    'command must still load orchestration.md with --rawfile'
  )
})

test('the clear-matcher command is untouched and still writes the task-cost marker', () => {
  assert.ok(
    clearCommand.includes('$HOME/.claude/dev-team/task-cost'),
    'clear-matcher command must still write the task-cost marker'
  )
})

// Behavioral: actually run the command via sh, so a mutation that keeps the
// guarded substrings but reorders/breaks the control flow fails the tests.
function runOrchestrationCommand(envOverrides) {
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, ...envOverrides }
  return spawnSync('sh', ['-c', orchestrationCommand], { env, encoding: 'utf8' })
}

test('behavioral: DEVTEAM_WORKER=1 suppresses orchestration and prints only systemMessage', () => {
  const result = runOrchestrationCommand({ DEVTEAM_WORKER: '1' })
  assert.equal(result.status, 0)
  const parsed = JSON.parse(result.stdout)
  assert.deepEqual(parsed, { systemMessage: 'dev-team orchestration suppressed: DEVTEAM_WORKER=1' })
  assert.ok(!('hookSpecificOutput' in parsed), 'suppressed output must not carry hookSpecificOutput')
})

test('behavioral: DEVTEAM_WORKER unset injects the full orchestration context', () => {
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT }
  delete env.DEVTEAM_WORKER
  const result = spawnSync('sh', ['-c', orchestrationCommand], { env, encoding: 'utf8' })
  assert.equal(result.status, 0)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes('Dev-Team Orchestration'))
})

test('behavioral: DEVTEAM_WORKER="" (empty) is not a worker marker and injects context', () => {
  const result = runOrchestrationCommand({ DEVTEAM_WORKER: '' })
  assert.equal(result.status, 0)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes('Dev-Team Orchestration'))
})

// ---------------------------------------------------------------------------
// be-78-02 — PreToolUse dispatch-guard registration (AC1/AC2/AC3).
// ---------------------------------------------------------------------------

const preToolUse = hooksJson.hooks.PreToolUse
const EXPECTED_PRETOOLUSE_COMMAND = 'if [ -n "${DEVTEAM_WORKER:-}" ]; then exit 0; fi; command -v node >/dev/null 2>&1 || { d="$HOME/.dev-team/guard"; mkdir -p "$d" 2>/dev/null; printf \'{"ts":"%s","decision":"allow","reason_code":"node_unresolved"}\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$d/dispatch-guard.jsonl" 2>/dev/null; printf \'%s\\n\' \'{"systemMessage":"dev-team: node was not found on PATH — the dispatch guard did not run, so substrate discipline is unenforced for this call."}\'; exit 0; }; exec node "${CLAUDE_PLUGIN_ROOT}/hooks/dispatch-guard.mjs"'
const NODE_UNRESOLVED_SYSTEM_MESSAGE = 'dev-team: node was not found on PATH — the dispatch guard did not run, so substrate discipline is unenforced for this call.'

test('hooks.json registers exactly one PreToolUse entry gated on matcher "Agent"', () => {
  assert.ok(Array.isArray(preToolUse), 'hooks.json must carry a PreToolUse key')
  assert.equal(preToolUse.length, 1)
  assert.equal(preToolUse[0].matcher, 'Agent')
  assert.equal(typeof preToolUse[0].matcher, 'string')
  assert.ok(preToolUse[0].matcher === 'Agent' && typeof preToolUse[0].matcher === 'string')
  assert.equal(preToolUse[0].hooks.length, 1)
  assert.equal(preToolUse[0].hooks[0].type, 'command')
  assert.equal(preToolUse[0].hooks[0].timeout, 10)
  assert.equal(preToolUse[0].hooks[0].command, EXPECTED_PRETOOLUSE_COMMAND)
})

test('the existing SessionStart entries are unchanged by the PreToolUse addition', () => {
  assert.equal(sessionStart.length, 2)
  assert.equal(sessionStart[0].matcher, undefined)
  assert.equal(sessionStart[1].matcher, 'clear')
})

const dispatchGuardCommand = preToolUse[0].hooks[0].command

// TEST HERMETICITY (mandatory, mirrors test/cmux-dispatch.test.mjs:44-69):
// both the roster home layer and the decision-log path derive from HOME, so
// every fixture below pins it to a fresh temp dir and proves the pin took —
// a silently deleted pin must fail the suite, not write into the real ~/.dev-team.
const REAL_HOME = homedir()

function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-guard-hooks-home-'))
  assert.notEqual(dir, REAL_HOME, 'TEST HERMETICITY CANARY: HOME pin must differ from the real developer home')
  return dir
}

function writeCmuxConfig(homeDir) {
  const dir = join(homeDir, '.claude', 'dev-team')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.md'), 'execution_mode: cmux\n')
}

function denyQualifyingFixture(cwd) {
  return JSON.stringify({
    tool_name: 'Agent',
    tool_input: { subagent_type: 'dev-team:coder', description: 'd', prompt: 'p' },
    cwd,
    session_id: 'sess-1',
  })
}

// A PATH with no node but WITH the standard POSIX utilities (mkdir, date,
// printf's shell builtin doesn't need PATH, but mkdir/date do) — the point
// of this fixture is "node specifically missing", not "PATH is empty".
const NO_NODE_PATH = '/usr/bin:/bin'

test('behavioral (AC2): node unresolved on PATH degrades by name, logs node_unresolved, no hookSpecificOutput', () => {
  const home = makeHome()
  const cwd = mkdtempSync(join(tmpdir(), 'dispatch-guard-cwd-'))
  const result = spawnSync('/bin/sh', ['-c', dispatchGuardCommand], {
    input: denyQualifyingFixture(cwd),
    encoding: 'utf8',
    env: { PATH: NO_NODE_PATH, HOME: home, CLAUDE_PLUGIN_ROOT: ROOT },
  })
  assert.equal(result.status, 0)
  const parsed = JSON.parse(result.stdout)
  assert.deepEqual(parsed, { systemMessage: NODE_UNRESOLVED_SYSTEM_MESSAGE })
  assert.ok(!('hookSpecificOutput' in parsed), 'degraded output must not carry hookSpecificOutput')

  const logPath = join(home, '.dev-team', 'guard', 'dispatch-guard.jsonl')
  const lines = readFileSync(logPath, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  const logLine = JSON.parse(lines[0])
  assert.equal(logLine.reason_code, 'node_unresolved')
})

test('behavioral (AC2): DEVTEAM_WORKER=1 with no node on PATH exits 0, empty stdout, no log line', () => {
  const home = makeHome()
  const cwd = mkdtempSync(join(tmpdir(), 'dispatch-guard-cwd-'))
  const result = spawnSync('/bin/sh', ['-c', dispatchGuardCommand], {
    input: denyQualifyingFixture(cwd),
    encoding: 'utf8',
    env: { PATH: NO_NODE_PATH, HOME: home, CLAUDE_PLUGIN_ROOT: ROOT, DEVTEAM_WORKER: '1' },
  })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  const logPath = join(home, '.dev-team', 'guard', 'dispatch-guard.jsonl')
  assert.equal(existsSync(logPath), false, 'no log line must be written on the DEVTEAM_WORKER early exit')
})

test('behavioral (AC3): the registered command, run end to end with a real node, actually denies the baseline', () => {
  const home = makeHome()
  writeCmuxConfig(home)
  const cwd = mkdtempSync(join(tmpdir(), 'dispatch-guard-cwd-'))
  const env = { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: ROOT }
  delete env.DEVTEAM_WORKER
  const result = spawnSync('/bin/sh', ['-c', dispatchGuardCommand], {
    input: denyQualifyingFixture(cwd),
    encoding: 'utf8',
    env,
  })
  assert.equal(result.status, 0)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny')
})
