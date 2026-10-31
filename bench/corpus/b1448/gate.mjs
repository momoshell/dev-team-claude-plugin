import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Every production module and definition comes from the checkout being measured.
const root = realpathSync(process.cwd())
const ids = ['LM1', 'LM2', 'LM3']
let runLean
let setupError
try {
  ;({ runLean } = await import(pathToFileURL(join(root, 'crew/lean.mjs')).href))
} catch (error) { setupError = error }

function plannerDefinition({ base, tiers = {} }) {
  const source = readFileSync(join(root, 'crew/agents/planner.md'), 'utf8')
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)
  assert.ok(front, 'planner has frontmatter')
  const lines = front[1].split(/\r?\n/).filter((line) => !/^(memory|tiers):/.test(line))
  if (base !== undefined) lines.push(`memory: ${JSON.stringify(base)}`)
  lines.push(`tiers: ${JSON.stringify(tiers)}`)
  return `---\n${lines.join('\n')}\n---\n${source.slice(front[0].length)}`
}

function seedStore(dir, token) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), '- [Judgment](judgment.md) — test context\n')
  writeFileSync(join(dir, 'judgment.md'), `---\nname: judgment\ndescription: test context\nmetadata:\n  type: project\n---\n\n${token}\n`)
}

// Capture the planner at the ACP dispatch boundary. The intentional throw stops the
// loop before envelope validation or any build/check/git/PR stage, not before boot.
async function probe({ base, tiers, local = 'present', override = null, injectedJournal = false } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'lean-memory-gate-'))
  const oldEnv = process.env.CREW_MEMORY_DIR
  const spec = {
    id: 'memory-probe', cwd: join(scratch, 'checkout'), taskDir: join(scratch, 'task'),
    tier: 'build', shape: 'standard', brief: 'Measure memory injection for this assignment.',
    acceptance: ['LM1', 'LM2', 'LM3'], source: 'memory probe', branch: 'probe', base: 'main',
    suite: { command: process.execPath, args: ['--test'] },
  }
  const localToken = 'LANE_ENTRY_body_71fc8c'
  const overrideToken = 'OVERRIDE_ENTRY_body_8f1ab2'
  const calls = [], journalRows = []
  try {
    mkdirSync(spec.cwd, { recursive: true })
    const localDir = join(spec.cwd, '.claude', 'dev-team', 'memory')
    if (local === 'present') seedStore(localDir, localToken)
    else if (local === 'no-index') mkdirSync(localDir, { recursive: true })
    delete process.env.CREW_MEMORY_DIR
    if (override !== null) {
      const overrideDir = join(scratch, 'override-memory')
      if (override === 'present') seedStore(overrideDir, overrideToken)
      process.env.CREW_MEMORY_DIR = overrideDir
    }
    const definition = plannerDefinition({ base, tiers })
    const forbidden = async () => { throw new Error('gate must not run downstream stages') }
    await runLean(spec, {
      log: () => {},
      readFileSync: (path, ...args) => resolve(String(path)) === join(root, 'crew/agents/planner.md')
        ? definition : readFileSync(path, ...args),
      runAcpSeat: async (input) => { calls.push(input); throw new Error('probe captured ACP boot') },
      loopDeps: {
        ...(injectedJournal ? { journal: async (row) => { journalRows.push(row) } } : {}),
        checkBaseline: forbidden, runGate: forbidden, proveMutations: forbidden,
        runSuite: forbidden, commitChanges: forbidden, rebaseBranch: forbidden,
        openPullRequest: forbidden, run: forbidden,
      },
    })
    assert.equal(calls.length, 1, 'planner must reach ACP exactly once, not be refused')
    assert.equal(calls[0].definition.role, 'planner')
    const recorded = JSON.parse(readFileSync(calls[0].sessionFile, 'utf8').split('\n')[0])
    assert.equal(recorded.type, 'prompt')
    assert.equal(recorded.text, calls[0].prompt, 'recorded prompt is the dispatched prompt')
    const rows = injectedJournal ? journalRows
      : readFileSync(join(spec.taskDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    return { prompt: calls[0].prompt, rows, localToken, overrideToken }
  } finally {
    if (oldEnv === undefined) delete process.env.CREW_MEMORY_DIR
    else process.env.CREW_MEMORY_DIR = oldEnv
    rmSync(scratch, { recursive: true, force: true })
  }
}

const hasSection = (prompt) => /^## Team memory\s*$/m.test(prompt)
const emptyRows = (rows) => rows.filter((row) => row.event === 'memory-empty')
const checks = {
  LM1: async () => {
    for (const config of [
      { base: true },
      { tiers: { build: { memory: true } } },
      { base: false, tiers: { build: { memory: true } } },
      { base: true, override: 'present' },
    ]) {
      const result = await probe(config)
      assert.ok(hasSection(result.prompt), 'populated store must render the team-memory heading')
      const expected = config.override ? result.overrideToken : result.localToken
      assert.ok(result.prompt.includes(expected), 'linked entry body must be in assignment')
      if (config.override) assert.ok(!result.prompt.includes(result.localToken), 'environment override wins over lane store')
    }
  },
  LM2: async () => {
    for (const config of [
      { base: true, local: 'missing' },
      { base: true, local: 'missing', injectedJournal: true },
      { tiers: { build: { memory: true } }, local: 'no-index' },
      { base: true, local: 'present', override: 'missing' },
    ]) {
      const result = await probe(config)
      assert.ok(!hasSection(result.prompt), 'unavailable memory must not add a section')
      assert.ok(!result.prompt.includes(result.localToken), 'missing override must not fall back to lane store')
      const reason = config.local === 'no-index' ? 'no-index' : 'no-dir'
      assert.ok(emptyRows(result.rows).some((row) => row.reason === reason
        && row.role === 'planner' && row.id === 'memory-probe.planner.1'
        && row.lane === 'memory-probe'), `lane journal must record empty reason ${reason}`)
    }
  },
  LM3: async () => {
    for (const config of [
      {}, { base: false },
      { base: true, tiers: { build: { memory: false } } },
      { tiers: { judge: { memory: true } } },
      { override: 'present' },
    ]) {
      const result = await probe(config)
      assert.ok(!hasSection(result.prompt), 'undeclared/disabled memory must not inject a section')
      assert.ok(!result.prompt.includes(result.localToken) && !result.prompt.includes(result.overrideToken), 'undeclared seat must not receive store content')
      assert.equal(emptyRows(result.rows).length, 0, 'undeclared memory must not produce empty-memory observations')
    }
  },
}

let failed = false
for (const id of ids) {
  try {
    if (setupError) throw setupError
    await checks[id]()
  } catch (error) {
    failed = true
    const message = String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 350)
    console.log(`FAIL ${id}: ${message}`)
  }
}
process.exitCode = failed ? 1 : 0
