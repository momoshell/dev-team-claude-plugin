// be-78-01 — the no-behaviour-change proof for the execution-mode
// extraction. test/cmux-dispatch.test.mjs stays untouched and is the
// behavioural proof; this file is strictly additive and proves: (1) the new
// module's export surface and dependency-freedom, (2) that dispatch.mjs
// re-exports the same objects (identity, not just presence) and no longer
// DEFINES any of them, and (3) readDevTeamConfigText / resolveExecutionMode
// behaviour against real files.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const EXECUTION_MODE_PATH = join(ROOT, 'scripts', 'execution-mode.mjs')
const DISPATCH_PATH = join(ROOT, 'scripts', 'cmux', 'dispatch.mjs')
const FIXTURE = join(HERE, 'fixtures', 'fake-cmux.mjs')

function makeTmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeConfig(rootDir, contents) {
  const dir = join(rootDir, '.claude', 'dev-team')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.md'), contents)
}

// CMUX_BIN must be set to the fake fixture BEFORE cmuxctl.mjs is first
// imported (it captures CMUX_BIN as a module constant at import time) —
// dispatch.mjs imports cmuxctl.mjs. Mirrors test/cmux-dispatch.test.mjs:1-13,70.
process.env.CMUX_BIN = FIXTURE

const emMod = await import(EXECUTION_MODE_PATH)
const dispatchMod = await import(DISPATCH_PATH)

const EXECUTION_MODE_SOURCE = readFileSync(EXECUTION_MODE_PATH, 'utf8')
const DISPATCH_SOURCE = readFileSync(DISPATCH_PATH, 'utf8')

// ---------------------------------------------------------------------------
// AC2 — the new module's export surface: exactly these eight names.
// ---------------------------------------------------------------------------

test('execution-mode.mjs exports exactly the eight-name public surface', () => {
  assert.deepEqual(Object.keys(emMod).sort(), [
    'DEFAULT_EXECUTION_MODE',
    'EXECUTION_MODES',
    'EXECUTION_MODE_ALIASES',
    'MODE_SOURCES',
    'executionModeIsSet',
    'readDevTeamConfigText',
    'readExecutionMode',
    'resolveExecutionMode',
  ].sort())
})

test('parseExecutionMode and EXECUTION_MODE_LINE_RE stay module-private', () => {
  assert.equal('parseExecutionMode' in emMod, false)
  assert.equal('EXECUTION_MODE_LINE_RE' in emMod, false)
})

// ---------------------------------------------------------------------------
// AC3 — dependency-free: the only import specifiers are node:fs and node:path.
// ---------------------------------------------------------------------------

test('execution-mode.mjs imports nothing but node:fs and node:path', () => {
  const fromRe = new RegExp(['fr', 'om'].join('') + "\\s+'([^']+)'", 'g')
  const specifiers = [...EXECUTION_MODE_SOURCE.matchAll(fromRe)].map((m) => m[1])
  assert.ok(specifiers.length > 0, 'expected at least one import in execution-mode.mjs')
  assert.deepEqual(new Set(specifiers), new Set(['node:fs', 'node:path']))
  for (const specifier of specifiers) {
    assert.ok(!specifier.startsWith('.'), `unexpected relative import specifier: ${specifier}`)
    assert.ok(!specifier.startsWith('/'), `unexpected absolute import specifier: ${specifier}`)
  }
})

// ---------------------------------------------------------------------------
// AC4 — re-export identity: dispatch.mjs's bindings are the SAME objects
// exported by execution-mode.mjs, not re-declarations.
// ---------------------------------------------------------------------------

test('dispatch.mjs re-exports EXECUTION_MODES with identity, frozen, and value pinned', () => {
  assert.equal(dispatchMod.EXECUTION_MODES, emMod.EXECUTION_MODES)
  assert.ok(Object.isFrozen(dispatchMod.EXECUTION_MODES))
  assert.ok(Object.isFrozen(emMod.EXECUTION_MODES))
  assert.deepEqual(dispatchMod.EXECUTION_MODES, ['agent-tool', 'cmux'])
})

test('dispatch.mjs re-exports EXECUTION_MODE_ALIASES with identity, frozen, and value pinned', () => {
  assert.equal(dispatchMod.EXECUTION_MODE_ALIASES, emMod.EXECUTION_MODE_ALIASES)
  assert.ok(Object.isFrozen(dispatchMod.EXECUTION_MODE_ALIASES))
  assert.ok(Object.isFrozen(emMod.EXECUTION_MODE_ALIASES))
  assert.deepEqual(dispatchMod.EXECUTION_MODE_ALIASES, { subagent: 'agent-tool' })
})

test('dispatch.mjs re-exports MODE_SOURCES with identity, frozen, and value pinned', () => {
  assert.equal(dispatchMod.MODE_SOURCES, emMod.MODE_SOURCES)
  assert.ok(Object.isFrozen(dispatchMod.MODE_SOURCES))
  assert.ok(Object.isFrozen(emMod.MODE_SOURCES))
  assert.deepEqual(dispatchMod.MODE_SOURCES, ['project', 'home', 'default'])
})

test('dispatch.mjs re-exports DEFAULT_EXECUTION_MODE unchanged', () => {
  assert.equal(dispatchMod.DEFAULT_EXECUTION_MODE, emMod.DEFAULT_EXECUTION_MODE)
  assert.equal(dispatchMod.DEFAULT_EXECUTION_MODE, 'agent-tool')
})

test('dispatch.mjs re-exports the same function objects', () => {
  assert.equal(dispatchMod.readExecutionMode, emMod.readExecutionMode)
  assert.equal(dispatchMod.executionModeIsSet, emMod.executionModeIsSet)
  assert.equal(dispatchMod.resolveExecutionMode, emMod.resolveExecutionMode)
  assert.equal(dispatchMod.readDevTeamConfigText, emMod.readDevTeamConfigText)
})

// ---------------------------------------------------------------------------
// AC5 — dispatch.mjs no longer DEFINES any of the moved surface.
// ---------------------------------------------------------------------------

test('dispatch.mjs imports from ../execution-mode.mjs and defines none of the moved surface', () => {
  const fromExecutionModeNeedle = [['fr', 'om'].join(''), " '../execution-mode.mjs'"].join('')
  assert.ok(DISPATCH_SOURCE.includes(fromExecutionModeNeedle))

  const fnNeedle = (name) => new RegExp(`${['fun', 'ction'].join('')}\\s+${name}`)
  assert.ok(!fnNeedle('parseExecutionMode').test(DISPATCH_SOURCE))
  assert.ok(!fnNeedle('readExecutionMode').test(DISPATCH_SOURCE))
  assert.ok(!fnNeedle('executionModeIsSet').test(DISPATCH_SOURCE))
  assert.ok(!fnNeedle('resolveExecutionMode').test(DISPATCH_SOURCE))
  assert.ok(!fnNeedle('readConfigText').test(DISPATCH_SOURCE))

  const constNeedle = (name) => new RegExp(`(?:${['exp', 'ort'].join('')}\\s+)?${['con', 'st'].join('')}\\s+${name}\\s*=`)
  assert.ok(!constNeedle('EXECUTION_MODE_LINE_RE').test(DISPATCH_SOURCE))
  assert.ok(!constNeedle('EXECUTION_MODES').test(DISPATCH_SOURCE))
  assert.ok(!constNeedle('EXECUTION_MODE_ALIASES').test(DISPATCH_SOURCE))
  assert.ok(!constNeedle('MODE_SOURCES').test(DISPATCH_SOURCE))
})

// ---------------------------------------------------------------------------
// AC6 — one config-path definition, repo-wide. Pin the join() COMPOSITION
// (a variable followed by the three literals), never the bare path text —
// dispatch.mjs legitimately keeps the literal .claude/dev-team/config.md
// text inside assertExecutionModeCmux's refusal message and in comments.
// ---------------------------------------------------------------------------

test('readDevTeamConfigText is the only place that composes the config path', () => {
  const configFragment = ['con', 'fig.md'].join('')
  const dotClaudeFragment = ['.cla', 'ude'].join('')
  const devTeamFragment = ['dev-', 'team'].join('')
  const joinNeedleSource = `join\\([A-Za-z_$][\\w$]*,\\s*'${dotClaudeFragment}',\\s*'${devTeamFragment}',\\s*'${configFragment}'\\)`
  const emMatches = EXECUTION_MODE_SOURCE.match(new RegExp(joinNeedleSource, 'g')) || []
  assert.equal(emMatches.length, 1, 'expected exactly one config-path join() composition in execution-mode.mjs')
  assert.ok(!new RegExp(joinNeedleSource).test(DISPATCH_SOURCE), 'dispatch.mjs must not compose the config path itself')
})

// ---------------------------------------------------------------------------
// AC7 — MODE_SOURCE_UNRESOLVED stays private to dispatch.mjs.
// ---------------------------------------------------------------------------

test('MODE_SOURCE_UNRESOLVED stays a private dispatch.mjs const, absent from execution-mode.mjs', () => {
  const modeSourceUnresolved = ['MODE_SOURCE_', 'UNRESOLVED'].join('')
  const constNeedle = new RegExp(`${['con', 'st'].join('')}\\s+${modeSourceUnresolved}\\s*=\\s*'unresolved'`)
  assert.ok(constNeedle.test(DISPATCH_SOURCE))
  assert.ok(!new RegExp(modeSourceUnresolved).test(EXECUTION_MODE_SOURCE))
  assert.equal(modeSourceUnresolved in dispatchMod, false)
})

// ---------------------------------------------------------------------------
// AC8 — readDevTeamConfigText behavioural parity, real temp dirs.
// ---------------------------------------------------------------------------

test('readDevTeamConfigText returns empty string when config.md is absent', () => {
  const rootDir = makeTmpDir('execution-mode-absent-')
  assert.equal(emMod.readDevTeamConfigText(rootDir), '')
})

test('readDevTeamConfigText returns exact file bytes including trailing newline', () => {
  const rootDir = makeTmpDir('execution-mode-present-')
  const body = 'execution_mode: cmux\n'
  writeConfig(rootDir, body)
  assert.equal(emMod.readDevTeamConfigText(rootDir), body)
})

test('readDevTeamConfigText returns empty string when rootDir does not exist', () => {
  const rootDir = join(makeTmpDir('execution-mode-parent-'), 'does-not-exist')
  assert.equal(emMod.readDevTeamConfigText(rootDir), '')
})

// ---------------------------------------------------------------------------
// AC9 — resolveExecutionMode layering, driven through readDevTeamConfigText
// against real temp files.
// ---------------------------------------------------------------------------

function resolveFromDirs(projectDir, homeDir) {
  return emMod.resolveExecutionMode({
    projectConfigText: emMod.readDevTeamConfigText(projectDir),
    homeConfigText: emMod.readDevTeamConfigText(homeDir),
  })
}

test('resolveExecutionMode: project line wins over home', () => {
  const projectDir = makeTmpDir('execution-mode-project-')
  const homeDir = makeTmpDir('execution-mode-home-')
  writeConfig(projectDir, 'execution_mode: cmux\n')
  writeConfig(homeDir, 'execution_mode: agent-tool\n')
  assert.deepEqual(resolveFromDirs(projectDir, homeDir), { mode: 'cmux', source: 'project' })
})

test('resolveExecutionMode: home answers when project is silent', () => {
  const projectDir = makeTmpDir('execution-mode-project-')
  const homeDir = makeTmpDir('execution-mode-home-')
  writeConfig(homeDir, 'execution_mode: cmux\n')
  assert.deepEqual(resolveFromDirs(projectDir, homeDir), { mode: 'cmux', source: 'home' })
})

test('resolveExecutionMode: neither layer answers -> default', () => {
  const projectDir = makeTmpDir('execution-mode-project-')
  const homeDir = makeTmpDir('execution-mode-home-')
  assert.deepEqual(resolveFromDirs(projectDir, homeDir), { mode: 'agent-tool', source: 'default' })
})

test('resolveExecutionMode: an ambiguous home file is not parsed when the project layer is present', () => {
  const projectDir = makeTmpDir('execution-mode-project-')
  const homeDir = makeTmpDir('execution-mode-home-')
  writeConfig(projectDir, 'execution_mode: cmux\n')
  writeConfig(homeDir, 'execution_mode: cmux\nexecution_mode: agent-tool\n')
  assert.deepEqual(resolveFromDirs(projectDir, homeDir), { mode: 'cmux', source: 'project' })
})

test('resolveExecutionMode: two lines in the layer actually consulted throws', () => {
  const projectDir = makeTmpDir('execution-mode-project-')
  const homeDir = makeTmpDir('execution-mode-home-')
  writeConfig(homeDir, 'execution_mode: cmux\nexecution_mode: agent-tool\n')
  assert.throws(() => resolveFromDirs(projectDir, homeDir), /ambiguous/)
})

test('resolveExecutionMode: an unknown value throws with the raw spelling, capped and truncated', () => {
  const projectDir = makeTmpDir('execution-mode-project-')
  const homeDir = makeTmpDir('execution-mode-home-')
  const raw = 'x'.repeat(120)
  writeConfig(projectDir, `execution_mode: ${raw}\n`)
  assert.throws(
    () => resolveFromDirs(projectDir, homeDir),
    (err) => {
      assert.match(err.message, /readExecutionMode: unknown execution_mode value:/)
      assert.match(err.message, new RegExp(JSON.stringify(`${raw.slice(0, 80)}...<truncated, ${raw.length} chars total>`).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      return true
    },
  )
})

test("resolveExecutionMode: 'subagent' normalizes to 'agent-tool'", () => {
  const projectDir = makeTmpDir('execution-mode-project-')
  const homeDir = makeTmpDir('execution-mode-home-')
  writeConfig(projectDir, 'execution_mode: subagent\n')
  assert.deepEqual(resolveFromDirs(projectDir, homeDir), { mode: 'agent-tool', source: 'project' })
})
