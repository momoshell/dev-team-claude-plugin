// Split from crew/drive.test.mjs (#918 follow-up): one subject per file so a
// lane fencing one driver concern no longer locks every driver test.
// Shared fixtures live in ./drive-fixtures.mjs; this file carries its OWN ledger
// sandbox because it imports a ledger door directly (see below).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FINDING_DISPOSITIONS, FINDING_SEVERITIES, GATE_CUSTODIAN, MAX_QUESTIONS, PROTECTED_PATHS, REPO_ROOT, RESIDUAL_TYPES, applyPrescriptionLines, checkAnchors, existsSync, join, laneFence, mkdirSync, partitionShifts, protectedHits, readFileSync, readdirSync, rmSync, scratchDir, spawnSync,
  carriedSilenceDefect, findingIdDefect, parseQuestions, patchTargets,
} from './drive-fixtures.mjs'
import { bootCmd, composeRolePrompt, FLAG_VALUE_CONTRACT, KNOWN_FLAGS, BOOLEAN_FLAGS, BOOT_ONLY_FLAGS, compiledCharterBytes, charterBudgetRefusals, CHARTER_CEILINGS } from './crew.mjs'
import { after } from 'node:test'
import { tmpdir } from 'node:os'
import {
  documentDiffImages, documentDeclarations, documentChangedDeclarations, documentTrigger,
  documentStagePlan, documentEntry, runDocumentationDecision, DOCUMENT_APPEND_TARGET, DOCUMENT_BATCH_TARGET, DOCUMENT_FLAGS_TARGET, DOCUMENT_LIFECYCLE_ENTRY, driveTask, REVIEWED_CORE_STAGES, SHAPE_MAJOR_PHASES,
  VARIANTS,
} from './drive.mjs'
import { convergeIo, convergeRun, runPublished, CONVERGE_CTX, CTX, planEnv, publicationIo } from './drive-fixtures.mjs'

// Ledger sandbox (#432 / #824). This file imports crew/crew.mjs#bootCmd, a
// registered home-default door (test/factory-env.test.mjs:113), so it is a
// ledger writer in its own right and the sandbox detector reads THIS file's
// text — ./drive-fixtures.mjs already assigns one, but an import is not a
// credit it can see. tmpdir() is intentional and mkdtempSync() is not: the
// raw-temp detector (test/factory-env.test.mjs:691) counts only mkdtemp calls,
// while the sandbox detector's TEMP_MARKERS (:358) accepts tmpdir( too. Same
// reasoning, verbatim, as crew/drive-fixtures.mjs:73-81.
const DOCS_LEDGER_SANDBOX = join(tmpdir(), `b689-drive-docs-ledger-${process.pid}`)
const DOCS_LEDGER_SANDBOX_PREVIOUS = process.env.DEVTEAM_LEDGER_DIR
process.env.DEVTEAM_LEDGER_DIR = DOCS_LEDGER_SANDBOX
after(() => {
  if (DOCS_LEDGER_SANDBOX_PREVIOUS === undefined) delete process.env.DEVTEAM_LEDGER_DIR
  else process.env.DEVTEAM_LEDGER_DIR = DOCS_LEDGER_SANDBOX_PREVIOUS
  rmSync(DOCS_LEDGER_SANDBOX, { recursive: true, force: true })
})

const CHARTER_TEST_ROLES = Object.freeze(['lead', 'builder'])
const CHARTER_TAIL = '\n\nBe terse: state the result in the fewest words that carry it, and do not restate context the reader already has.\n'

function charterCapabilityRegister() {
  const grant = (extra = {}) => ({ tools: [], extensions: [], agents: [], skills: [], advisor: false, requires: [], mcp_servers: [], ...extra })
  return {
    schema_version: 1,
    updated_at: '2026-08-17',
    roles: {
      lead: grant(), planner: grant({ requires: ['subagents'] }), builder: grant(),
      reviewer: grant(), 'tech-lead': grant(),
    },
    local_providers: {},
    coding_agents: {
      pi: { providers: ['openai', 'anthropic', 'llama-swap'], transports: ['pane', 'headless-rpc'], adapter: 'crew/adapters/adapter-pi.mjs', refuses: ['mcp_servers'], display_name: 'Pi', binary: 'pi', install_hint: 'Install Pi and ensure the pi binary is on PATH.', availability: 'executable', availability_reason: 'executable' },
      claude: { providers: ['anthropic'], transports: ['pane', 'headless-json'], adapter: 'crew/adapters/adapter-claude.mjs', refuses: ['extensions', 'skills', 'local_provider'], display_name: 'Claude Code', binary: 'claude', install_hint: 'Install Claude Code and ensure the claude binary is on PATH.', availability: 'executable', availability_reason: 'executable' },
    },
  }
}

async function withTestHome(home, fn) {
  const previous = process.env.HOME
  process.env.HOME = home
  try { return await fn() }
  finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous }
}

function charterBootFixture(label) {
  const home = scratchDir(`drive-docs-charter-${label}-home-`)
  const checkoutRoot = scratchDir(`drive-docs-charter-${label}-checkout-`)
  const checkout = join(checkoutRoot, 'checkout')
  const task = `drive-docs-charter-${label}`
  const crewDir = join(home, '.crew', 'checkout', task)
  const register = charterCapabilityRegister()
  mkdirSync(checkout)
  return {
    crewDir,
    taskDir: join(crewDir, 'task'),
    boot: (flags = {}) => withTestHome(home, () => bootCmd(
      { task, checkout, roles: CHARTER_TEST_ROLES.join(','), 'headless-all': true, 'claude-bin': process.execPath, ...flags },
      { register, awaitSeatsReady: async () => {} },
    )),
    cleanup: () => {
      rmSync(home, { recursive: true, force: true })
      rmSync(checkoutRoot, { recursive: true, force: true })
    },
  }
}

function charterSource(role) {
  return {
    shared: readFileSync(join(REPO_ROOT, 'crew', 'roles', '_shared.md'), 'utf8'),
    card: readFileSync(join(REPO_ROOT, 'crew', 'roles', `${role}.md`), 'utf8'),
  }
}

test('bootCmd writes terse charter tails for every seated role', async () => {
  const fixture = charterBootFixture('terse')
  try {
    await fixture.boot({ 'charter-arm': 'terse-tail' })
    for (const role of CHARTER_TEST_ROLES) {
      const { shared, card } = charterSource(role)
      const prompt = readFileSync(join(fixture.taskDir, `role-${role}.md`), 'utf8')
      assert.equal(prompt, composeRolePrompt(shared, card, '', 'terse-tail'))
      assert.equal(prompt.slice(-CHARTER_TAIL.length), CHARTER_TAIL)
    }
  } finally { fixture.cleanup() }
})

test('bootCmd without charter-arm writes control prompts byte-for-byte', async () => {
  const fixture = charterBootFixture('control')
  try {
    await fixture.boot()
    const section = ''
    for (const role of CHARTER_TEST_ROLES) {
      const { shared, card } = charterSource(role)
      assert.equal(
        readFileSync(join(fixture.taskDir, `role-${role}.md`), 'utf8'),
        composeRolePrompt(shared, card, section, 'control'),
      )
    }
  } finally { fixture.cleanup() }
})

test('bootCmd rejects an unknown charter-arm before crew state', async () => {
  const fixture = charterBootFixture('invalid')
  try {
    const arm = 'unknown-arm'
    await assert.rejects(
      () => fixture.boot({ 'charter-arm': arm }),
      (error) => error?.message === `invalid --charter-arm ${JSON.stringify(arm)}; expected one of control|terse-tail|lean`,
    )
    assert.equal(existsSync(join(fixture.crewDir, 'crew.json')), false)
  } finally { fixture.cleanup() }
})

test('E1/E2 compose every role prompt with byte-identical control and a final terse tail treatment', () => {
  const roles = ['lead', 'planner', 'builder', 'reviewer', 'tech-lead']
  const rolesDir = join(REPO_ROOT, 'crew', 'roles')
  const shared = readFileSync(join(rolesDir, '_shared.md'), 'utf8')
  const section = 'memory: retained context'
  const tail = '\n\nBe terse: state the result in the fewest words that carry it, and do not restate context the reader already has.\n'
  for (const role of roles) {
    const card = readFileSync(join(rolesDir, `${role}.md`), 'utf8')
    const control = `${shared}\n\n${card}${section ? `\n\n${section}` : ''}`
    assert.equal(composeRolePrompt(shared, card, section, 'control'), control)
    const treatment = composeRolePrompt(shared, card, section, 'terse-tail')
    assert.equal(treatment, control + tail)
    assert.ok(treatment.endsWith(tail))
    assert.ok(treatment.indexOf(tail) > treatment.indexOf(section))
  }
})

test('B1 lean charter tail is self-contained and identical for every seat', () => {
  const roles = ['lead', 'planner', 'builder', 'reviewer', 'tech-lead']
  const rolesDir = join(REPO_ROOT, 'crew', 'roles')
  const shared = readFileSync(join(rolesDir, '_shared.md'), 'utf8')
  const section = 'memory: retained context'
  const tail = '\n\nBefore adding code, apply these checks in order: delete, stdlib, native, yagni, shrink; name a concrete replacement for each tag; implement the smallest satisfying change; never simplify away the hard rules your charter already lists.\n'
  const tags = ['delete', 'stdlib', 'native', 'yagni', 'shrink']
  assert.doesNotMatch(tail, /ladder/i)
  assert.ok(tail.includes('apply these checks in order'))
  assert.ok(tail.includes('name a concrete replacement for each tag'))
  for (const tag of tags) assert.ok(tail.includes(tag))
  for (const role of roles) {
    const card = readFileSync(join(rolesDir, `${role}.md`), 'utf8')
    const control = `${shared}\n\n${card}\n\n${section}`
    assert.equal(composeRolePrompt(shared, card, section, 'control'), control)
    assert.equal(composeRolePrompt(shared, card, section, 'lean'), control + tail)
  }
})

test('RV1-2 split crew suite imports helpers rather than redefining them', () => {
  const source = readFileSync(join(REPO_ROOT, 'crew', 'crew.test.mjs'), 'utf8')
  const helperImport = "import { shippedRoster, roster, nodeMeetsLedgerFloor, withHome, testCrewDir, callCounter } from './crew-test-helpers.mjs'"
  assert.ok(source.includes(helperImport))
  for (const definition of [
    'const shippedRoster =', 'const roster =', 'const nodeMeetsLedgerFloor =',
    'async function withHome', 'function testCrewDir', 'function callCounter', 'function capabilityRegister',
  ]) assert.equal(source.includes(definition), false, `unexpected inline ${definition}`)
})

test('charter-arm is a value-bearing boot-only input and not a boolean', () => {
  assert.ok(KNOWN_FLAGS.boot.includes('charter-arm'))
  assert.equal(FLAG_VALUE_CONTRACT['charter-arm'], 'value')
  assert.equal(BOOLEAN_FLAGS.includes('charter-arm'), false)
  assert.equal(BOOT_ONLY_FLAGS.includes('charter-arm'), false)
})

test('the turn-economy rule is stated once and still reaches every seat', () => {
  const roles = ['builder', 'lead', 'planner', 'reviewer', 'tech-lead']
  const rules = {
    builder: "Run the acceptance gate and the test files you are changing — never the full suite, which the driver's own suite stage owns and re-runs after you.",
    planner: 'Run your own acceptance gate at baseline, exactly once. Run nothing else — the driver owns the validation lane and the suite.',
    lead: 'Run no tests. The gate proof and the suite result are already journalled; read them from the task dir and the journal rather than re-buying them.',
    reviewer: 'Run no tests. The gate proof and the suite result are already journalled; read them from the task dir and the journal rather than re-buying them.',
    'tech-lead': 'Run no tests. The gate proof and the suite result are already journalled; read them from the task dir and the journal rather than re-buying them.',
  }
  const rolesDir = join(REPO_ROOT, 'crew', 'roles')
  const docs = readdirSync(rolesDir).filter((name) => name.endsWith('.md')).map((name) => readFileSync(join(rolesDir, name), 'utf8'))
  const shared = readFileSync(join(rolesDir, '_shared.md'), 'utf8')
  const U1 = 'Issue every independent read in ONE turn — a batch of greps, reads and file listings that do not depend on each other is one tool block, not one turn each.'
  const U2 = 'Read a file once and cite it from context — re-slicing a file you have already read buys nothing and every turn re-sends the whole context.'
  const occurrences = (text, needle) => text.split(needle).length - 1
  for (const universal of [U1, U2]) {
    assert.equal(docs.reduce((count, text) => count + occurrences(text, universal), 0), 1)
    assert.equal(occurrences(shared, universal), 1)
  }
  for (const role of roles) {
    const card = readFileSync(join(rolesDir, `${role}.md`), 'utf8')
    assert.equal(occurrences(card, U1), 0)
    assert.equal(occurrences(card, U2), 0)
    assert.doesNotMatch(card, /^## Turn economy\s*$/m)
    const compiled = `${shared}\n\n${card}`
    assert.equal(occurrences(compiled, U1), 1)
    assert.equal(occurrences(compiled, U2), 1)
    assert.equal(occurrences(compiled, rules[role]), 1)
  }
})

test('BC1', () => {
  const charter = readFileSync(join(REPO_ROOT, 'crew', 'roles', 'builder.md'), 'utf8')
  const sentence = 'Run the gate at most once before returning; never rerun a command without an intervening edit.'
  assert.equal(charter.split(sentence).length - 1, 1)
})

test('BC2', () => {
  const charter = readFileSync(join(REPO_ROOT, 'crew', 'roles', 'builder.md'), 'utf8')
  const sentence = 'Batch independent reads and edits into one turn.'
  assert.equal(charter.split(sentence).length - 1, 1)
})

test('builder lean rules and lean-build skill stay exact', () => {
  const charterLines = readFileSync(join(REPO_ROOT, 'crew', 'roles', 'builder.md'), 'utf8').split('\n')
  const rules = [
    '- Before writing code, reuse what is already here.',
    '- If not, use the standard library.',
    '- If not, use a platform feature.',
    '- If not, use an installed dependency.',
    '- For a bug fix, grep every caller, fix the root cause, and put one guard in the shared function.',
    '- Leave one runnable check for the behavior you changed.',
    '- Output the code, then at most three lines of `skipped X, add when Y`.',
  ]
  for (const rule of rules) assert.equal(charterLines.filter((line) => line === rule).length, 1, rule)

  const skill = readFileSync(join(REPO_ROOT, 'skills/lean-build/SKILL.md'), 'utf8')
  const skillLines = skill.split('\n')
  assert.equal(skillLines[0], '---')
  assert.equal(skillLines[1], 'name: lean-build')
  assert.match(skillLines[2] || '', /^description: .+$/)
  assert.equal(skillLines[3], 'compatibility: Delivered only to pi builder and planner seats; claude seats receive nothing because adapter-claude refuses skill grants.')
  assert.equal(skillLines[4], '---')
  const flow = "Trace the change's flow until you understand it; only then climb the ladder."
  const ladder = 'Apply the ladder before writing new code.'
  const review = 'Every review tag requires a concrete replacement.'
  const tags = 'Review tags: `delete`, `stdlib`, `native`, `yagni`, and `shrink`.'
  const tieBreak = 'When two standard-library options are the same size, choose the edge-case-correct one.'
  for (const line of [flow, ladder, review, tags, tieBreak]) {
    assert.equal(skillLines.filter((candidate) => candidate === line).length, 1, line)
  }
  assert.ok(skillLines.indexOf(flow) < skillLines.indexOf(ladder))
  for (const tag of ['delete', 'stdlib', 'native', 'yagni', 'shrink']) {
    assert.equal(skillLines.filter((line) => line === tags && line.includes(`\`${tag}\``)).length, 1, tag)
  }

  const expectedExamples = [
    { line: '- Standard library: replace a shell-built `git add` command with `execFileSync(\'git\', [\'add\', \'--\', ...toAdd])` (crew/seat-io.mjs:3608).', file: 'crew/seat-io.mjs', first: 3608, last: 3608, firstFragment: "execFileSync('git', ['add', '--', ...toAdd]", lastFragment: "execFileSync('git', ['add', '--', ...toAdd]" },
    { line: "- Closed enum: replace an open stage string with `Object.freeze(['plan', 'check', 'build', ...])` (crew/variants.mjs:12-13).", file: 'crew/variants.mjs', first: 12, last: 13, firstFragment: "stages: Object.freeze(['plan', 'check', 'build'", lastFragment: "'gate-baseline'" },
    { line: '- Existing helper: replace a reimplemented temporary-directory cleanup fixture with `scratchDir(...)` (test/helpers.mjs:39-42).', file: 'test/helpers.mjs', first: 39, last: 42, firstFragment: 'export function scratchDir(', lastFragment: 'return dir' },
    { line: '- Honest absence: replace an invented candidate count of zero with `candidates: null` and a closed reason (crew/headless-rpc.mjs:129).', file: 'crew/headless-rpc.mjs', first: 129, last: 129, firstFragment: 'candidates: null, reason: closedReason(error)', lastFragment: 'candidates: null, reason: closedReason(error)' },
  ]
  const derived = skillLines.filter((line) => line.startsWith('- '))
  assert.deepEqual(derived, expectedExamples.map(({ line }) => line))
  for (const line of derived) {
    const citation = line.match(/\(([^():]+):(\d+)(?:-(\d+))?\)\.$/)
    assert.ok(citation, `expected a resolving citation in ${line}`)
    const [, file, firstText, lastText] = citation
    const first = Number(firstText)
    const last = Number(lastText ?? firstText)
    const expected = expectedExamples.find((example) => example.line === line)
    assert.ok(expected, `unexpected example ${line}`)
    assert.equal(file, expected.file)
    assert.equal(first, expected.first)
    assert.equal(last, expected.last)
    const sourcePath = join(REPO_ROOT, file)
    assert.equal(existsSync(sourcePath), true, sourcePath)
    const sourceLines = readFileSync(sourcePath, 'utf8').split('\n')
    assert.ok(first >= 1 && first <= sourceLines.length, `${file}:${first} is out of bounds`)
    assert.ok(last >= first && last <= sourceLines.length, `${file}:${last} is out of bounds`)
    assert.ok(sourceLines[first - 1].includes(expected.firstFragment), `${file}:${first} did not contain ${expected.firstFragment}`)
    assert.ok(sourceLines[last - 1].includes(expected.lastFragment), `${file}:${last} did not contain ${expected.lastFragment}`)
  }

  const neverSimplify = 'Never simplify away: trust-boundary validation; data-loss error handling; security checks; anything the task explicitly requested; closed enums; honest absence with a reason; a denominator beside every rate.'
  assert.equal(skillLines.filter((line) => line === neverSimplify).length, 1)
  for (const limit of [
    'trust-boundary validation',
    'data-loss error handling',
    'security checks',
    'anything the task explicitly requested',
    'closed enums',
    'honest absence with a reason',
    'a denominator beside every rate',
  ]) assert.equal(skillLines.filter((line) => line === neverSimplify && line.includes(limit)).length, 1, limit)
  for (const retired of ['lru_cache', 'safeParse', 'type="date"']) assert.equal(skill.includes(retired), false, retired)
})

test('the shared charter and validator agree on the findings contract', () => {
  const charter = readFileSync(new URL('./roles/reviewer.md', import.meta.url), 'utf8')
  const start = charter.indexOf('## Envelope details fields')
  const end = charter.indexOf('## Perspective assignments', start)
  assert.ok(start >= 0 && end > start)
  const block = charter.slice(start, end)
  for (const token of ['"findings"', '"id"', '"severity"']) assert.ok(block.includes(token))
  // #457: this slice used to stop AT '## Gate triage', so the gate-repair
  // custody sentence under that heading was pinned by nothing and survived
  // custody moving to the lead (#334/PR #348). The slice now covers it.
  assert.ok(block.includes('## Gate triage'), 'the charter slice must cover the gate-triage section')
  assert.ok(block.includes(`grants the **${GATE_CUSTODIAN}**`), 'the gate verdict must grant the repair to the gate custodian')
  assert.doesNotMatch(block, /grants the (\*\*)?planner\b/)
  const severityField = block.match(/"severity":\s*([^\n]+)/)?.[1]
  assert.ok(severityField)
  const documented = [...severityField.matchAll(/"([^\"]+)"/g)].map((match) => match[1])
  assert.deepEqual(documented, [...FINDING_SEVERITIES])
  const dispositionField = block.match(/"disposition":\s*([^\n]+)/)?.[1]
  assert.ok(dispositionField)
  const dispositions = [...dispositionField.matchAll(/"([^\"]+)"/g)].map((match) => match[1])
  assert.deepEqual(dispositions, [...FINDING_DISPOSITIONS])
  assert.ok(block.includes('`disposition` is OPTIONAL in this release and REQUIRED from the next'))
})

test("the reviewer guidelines carry a defended 'Do not flag' list", () => {
  const guidelines = readFileSync(new URL('./guidelines/review-do-not-flag.md', import.meta.url), 'utf8')
  const charter = readFileSync(new URL('./roles/reviewer.md', import.meta.url), 'utf8')
  const start = guidelines.search(/^## Do not flag$/m)
  assert.ok(start >= 0, 'the reviewer charter must carry a "Do not flag" section')
  const rest = guidelines.slice(start + '## Do not flag'.length)
  const end = rest.indexOf('\n## ')
  const section = end < 0 ? rest : rest.slice(0, end)
  const entries = section.split('\n').reduce((acc, line) => {
    if (/^[-*]\s+\*\*/.test(line)) acc.push([line])
    else if (acc.length) acc[acc.length - 1].push(line)
    return acc
  }, []).map((block) => block.join('\n'))
  assert.ok(entries.length >= 4, `expected at least 4 entries, found ${entries.length}`)
  // Every entry names the defense that makes its class safe not to flag, and
  // that defense points at something that exists — an ignore rule without one
  // is how a real finding gets suppressed.
  for (const entry of entries) {
    assert.match(entry, /Defense:/)
    assert.match(entry.slice(entry.indexOf('Defense:')), /crew\/[\w.-]+|files_in_scope|\.crew\/|#\d{2,}/)
  }
  assert.doesNotMatch(charter, /^## Do not flag$/m)
  assert.ok(charter.includes('crew/guidelines/review-do-not-flag.md'))
})

test('the lead charter documents the typed exhaustion accept contract', () => {
  const charter = readFileSync(new URL('./roles/lead.md', import.meta.url), 'utf8')
  for (const token of ['residuals', 'refuted', ...RESIDUAL_TYPES]) assert.ok(charter.includes(token), token)
  assert.match(charter, /code-refused/)
  const collapsed = charter.replace(/\s+/g, ' ')
  assert.match(collapsed, /the plan is a contract/)
  assert.match(collapsed, /not amendable after acceptance/)
  assert.match(collapsed, /correctness-unverified[^.]*code-refused/)
  assert.match(collapsed, /not a statement about which stage/)
  assert.match(collapsed, /summary is REQUIRED there and is omitted from a keyed review-exhaustion claim/)
})

test('the lead FIELD bullet carries its correctness-unverified antecedent', () => {
  const charter = readFileSync(new URL('./roles/lead.md', import.meta.url), 'utf8')
  const start = charter.indexOf('## Two things that cost a lane to rediscover')
  assert.ok(start >= 0)
  const field = charter.slice(start).split('\n- ').find((bullet) => bullet.includes('about the FIELD'))
  assert.ok(field)
  assert.ok(field.includes('correctness-unverified'))
})

test('the planner charter documents how to discover files_in_scope', () => {
  const charter = readFileSync(new URL('./roles/planner.md', import.meta.url), 'utf8')
  for (const token of [
    'every test that pins it',
    'crew/daemon.test.mjs',
    'crew/factoryctl.test.mjs',
    'crew/adapter-*.test.mjs',
    '#193',
    '#199',
    'plan context, not a ceiling',
  ]) assert.ok(charter.includes(token), token)
  assert.match(charter, /grep/i)
})

test('charter scope writes are recorded, not bounced', () => {
  const planner = readFileSync(new URL('./roles/planner.md', import.meta.url), 'utf8')
  const builder = readFileSync(new URL('./roles/builder.md', import.meta.url), 'utf8')
  const guidelines = readFileSync(new URL('./guidelines/review-do-not-flag.md', import.meta.url), 'utf8')
  // Each charter is pinned by its OWN complete sentence. A shared token regex is
  // vacuous here: one passage supplies the words while another regresses.
  const sentences = [
    [planner, 'the driver records the write and proceeds.'],
    [planner, 'wider context is recorded and proceeds.'],
    [builder, 'The driver records an ORDINARY out-of-context write and proceeds.'],
    [guidelines, 'an out-of-context write is recorded and the lane proceeds'],
  ]
  for (const [text, sentence] of sentences) assert.ok(text.includes(sentence), sentence)
  for (const text of [planner, builder, guidelines]) {
    assert.doesNotMatch(text, /bounces anything outside/)
    assert.doesNotMatch(text, /is a CEILING/)
    assert.doesNotMatch(text, /is the scope GATE/)
  }
  assert.match(planner, /plan context, not a ceiling/)
  // The retired claim: the scope stage is not a gate, so nothing "cannot be skipped".
  assert.doesNotMatch(planner, /the gate cannot be skipped/)
  // The refusals that SURVIVE are named, not summarised as "a malformed path".
  assert.ok(builder.includes('a `returns/*.json` envelope left in the checkout'), 'builder names the debris refusal')
  assert.ok(builder.includes('an unresolved mutation anchor'), 'builder names the anchor refusal')
  // False in both: the reviewer reads the COMPLETE diff (roles/reviewer.md).
  for (const text of [planner, builder, guidelines]) {
    assert.ok(!text.includes('a file nobody reviewed for this change'), 'no "nobody reviewed" claim')
  }
})

test('planner fan-out bar carries no stale reason', () => {
  const planner = readFileSync(new URL('./roles/planner.md', import.meta.url), 'utf8')
  assert.ok(planner.includes('this seat spawns no scouts even where its adapter grants fan-out, so this sentence is the only brake.'),
    'planner pins the complete adapter-neutral fan-out sentence')
  assert.doesNotMatch(planner, /#808/)
  // The claim was adapter-specific and false for the claude planner, whose
  // grants carry no extension and no scout agent.
  assert.doesNotMatch(planner, /the register grants the subagent extension/)
})

test('builder charter forbids commits', () => {
  const builder = readFileSync(new URL('./roles/builder.md', import.meta.url), 'utf8')
  const commitRule = [...builder.matchAll(/^.*Commit nothing.*$/gm)].map((m) => m[0].trim())
  assert.equal(commitRule.length, 1, `exactly one commit rule: ${JSON.stringify(commitRule)}`)
  assert.equal(commitRule[0], '- Commit nothing: the driver commits only after scope gate, lane, and full suite are green; the orchestrator owns git.')
})

test('the planner charter tells the planner to grep the changed file’s own path', () => {
  const charter = readFileSync(new URL('./roles/planner.md', import.meta.url), 'utf8')
  const discovery = charter.slice(charter.indexOf('Discover that list'), charter.indexOf('`gate_path` is required'))
  assert.ok(discovery.length > 0)
  assert.match(discovery, /own repo-relative path/)
  assert.match(discovery, /\.github\/workflows\/test\.yml/)
  assert.match(discovery, /test\/factory-ledger-floor\.test\.mjs/)
  assert.doesNotMatch(discovery, /production/)
})

test('the planner Changes section carries the five-rung minimality ladder', () => {
  const planner = readFileSync(new URL('./roles/planner.md', import.meta.url), 'utf8')
  const start = planner.indexOf('- **Changes**')
  const end = planner.indexOf('- **Sequencing**', start)
  assert.ok(start >= 0 && end > start)
  const changes = planner.slice(start, end)
  const rungs = changes.split('\n').filter((line) => /^  \d+\./.test(line))
  assert.deepEqual(rungs, [
    '  1. Does it need to exist?',
    '  2. Is it already here?',
    '  3. Does the standard library cover it?',
    '  4. Does a platform feature cover it?',
    '  5. Does an installed dependency cover it?',
  ])
  assert.doesNotMatch(planner, /first yes/i)
})

test('A1', () => {
  const charter = readFileSync(new URL('./roles/planner.md', import.meta.url), 'utf8')
  const rule = '- Quote every cited range inline with its line numbers; those are the lines the builder needs.'
  assert.equal(charter.split(rule).length - 1, 1)
})

test('B1', () => {
  const charter = readFileSync(new URL('./roles/builder.md', import.meta.url), 'utf8')
  const rule = "- The plan's cited ranges are your working set; read outside them only when an edit fails to bind or a test names another line."
  assert.equal(charter.split(rule).length - 1, 1)
})

test('RV1-1 planner range guidance follows required plan sections', () => {
  const charter = readFileSync(new URL('./roles/planner.md', import.meta.url), 'utf8')
  const tail = `- **Risks/consults** — anything you are <90% sure of. If a tech-lead pane
  exists, questions you want it to answer; else flag for the orchestrator.
- Quote every cited range inline with its line numbers; those are the lines the builder needs.`
  assert.equal(charter.split(tail).length - 1, 1)
})

test('F1', () => {
  const charter = readFileSync(new URL('./roles/planner.md', import.meta.url), 'utf8')
  const sentence = '`details.validation_lane` is ONE command: it must contain no `&&`, `;`, `|`, redirection, or glob, and `node --test` accepts several files as `node --test <file> <file> <file>`.'
  assert.ok(charter.includes(sentence))
  for (const token of ['ONE command', '&&', ';', '|', 'redirection', 'glob', 'accepts several files', 'node --test <file> <file> <file>']) {
    assert.ok(charter.includes(token), token)
  }
})

// The file nobody pinned is the file that rotted: tech-lead.md carried the whole
// plan-check doctrine and no test read a byte of it (#698).
test('the tech-lead charter documents envelope custody and the residual it cannot type', () => {
  const charter = readFileSync(new URL('./roles/tech-lead.md', import.meta.url), 'utf8')
  for (const token of [
    'details.mutations', 'files_in_scope', 'details.residuals',
    'correctness-unverified', 'verdictOf', 'applyPrescriptionLines',
  ]) assert.ok(charter.includes(token), token)
  const collapsed = charter.replace(/\s+/g, ' ')
  assert.match(collapsed, /frozen at acceptance/)
  assert.match(collapsed, /not amendable after acceptance/)
  assert.match(collapsed, /VERDICT: revise[^.]*PRESCRIBES/)
  assert.match(collapsed, /correctness-unverified[^.]*code-refused/)
  assert.match(collapsed, /cannot type a residual/)
})

// Prose file:line citations are invisible to skills/*/anchors.json, so crew/roles/anchors.json
// pins the CONTENT each cited line of crew/drive.mjs must carry. A shape-only check could not
// tell a right line from a wrong one, and twice a build kept it green by deleting a blank line
// elsewhere to compensate for one it inserted (#743, #748, #747). The manifest and the prose are
// held to a bijection in both directions, so a citation added to one side alone fails here.
test('every crew/drive.mjs anchor the tech-lead charter cites resolves to the code it names', () => {
  const charterPath = join(REPO_ROOT, 'crew', 'roles', 'tech-lead.md')
  const charter = readFileSync(charterPath, 'utf8')
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'crew', 'roles', 'anchors.json'), 'utf8'))
  // Every charter in crew/roles, not only the tech-lead's: the manifest is directory-wide
  // and anchor-pin.mjs --repair crew/roles scans the same set, so a pin cited only by
  // planner.md or reviewer.md is a citation here, never an orphan.
  const rolesDir = join(REPO_ROOT, 'crew', 'roles')
  const docs = readdirSync(rolesDir).filter((name) => name.endsWith('.md')).sort().map((name) => join(rolesDir, name))
  const result = checkAnchors({ root: REPO_ROOT, docs, manifest })
  assert.ok(result.anchors >= 12, `expected at least 12 anchors, found ${result.anchors}`)
  assert.deepEqual(result.failures, [])
  const { inFence, outOfFence } = partitionShifts({ shifted: result.shifted, fence: laneFence({ root: REPO_ROOT }).paths, manifest: 'crew/roles/anchors.json' })
  for (const shift of outOfFence) console.warn(`shifted ${shift.key} -> line ${shift.to}; repair after this lane merges, on main with: node skills/qa-test-writing/anchor-pin.mjs --repair-all crew/roles`)
  assert.deepEqual(inFence, [], 'a shift this lane can repair here must be repaired, not tolerated')
  // Both citation forms of the four anchors #698 found stale: the qualified
  // `crew/drive.mjs:2299` and the bare `:2226` continuation the file also used.
  for (const retired of [':2299', ':2226', ':2319', ':2217']) {
    assert.equal(charter.includes(retired), false, `retired anchor ${retired}`)
  }
})

test('the codemod stages before it applies and fails loudly without ast-grep', () => {
  const script = join(REPO_ROOT, '.agents/skills/ast-grep-codemod/scripts/codemod.mjs')
  const fake = join(REPO_ROOT, '.agents/skills/ast-grep-codemod/test-fixtures/fake-ast-grep.mjs')
  const log = join(scratchDir('b19-drive-'), 'invocations.log')
  const stage = join(scratchDir('b19-stage-'), 'proposal.json')
  const run = (args, env) => spawnSync(process.execPath, [script, ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, ...env },
  })
  const invocations = () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0
  const refused = run(['apply'], { AST_GREP_BIN: fake, FAKE_AST_GREP_LOG: log, CODEMOD_STAGE: stage })
  assert.notEqual(refused.status, 0)
  assert.match(`${refused.stdout || ''}${refused.stderr || ''}`, /--resolve/)
  assert.equal(invocations(), 0)
  const proposed = run([
    'propose', '--pattern', 'driveProbe($A)', '--rewrite', 'driveProbed($A)', '--lang', 'js', 'crew/roles/planner.md',
  ], {
    AST_GREP_BIN: fake, FAKE_AST_GREP_LOG: log, CODEMOD_STAGE: stage,
    FAKE_AST_GREP_DIFF: '@@ -1 +1 @@\n-old\n+new\n',
  })
  assert.equal(proposed.status, 0)
  assert.ok(invocations() >= 1)
  const failedProbeStage = join(scratchDir('b19-probe-failure-'), 'proposal.json')
  const failedProbe = run([
    'propose', '--pattern', 'probeFailure($A)', '--rewrite', 'probeFailed($A)', '--lang', 'js', 'crew/roles/planner.md',
  ], {
    AST_GREP_BIN: fake, FAKE_AST_GREP_LOG: log, CODEMOD_STAGE: failedProbeStage,
    FAKE_AST_GREP_VERSION_EXIT: '7',
  })
  assert.equal(failedProbe.status, 3)
  assert.equal(existsSync(failedProbeStage), false)
  const failedProposeStage = join(scratchDir('b19-propose-failure-'), 'proposal.json')
  const failedPropose = run([
    'propose', '--pattern', 'runFailure($A)', '--rewrite', 'runFailed($A)', '--lang', 'js', 'crew/roles/planner.md',
  ], {
    AST_GREP_BIN: fake, FAKE_AST_GREP_LOG: log, CODEMOD_STAGE: failedProposeStage,
    FAKE_AST_GREP_DIFF: '@@ -1 +1 @@\n-old\n+new\n', FAKE_AST_GREP_RUN_EXIT: '7',
  })
  assert.equal(failedPropose.status, 3)
  assert.equal(existsSync(failedProposeStage), false)
  const applyLog = `${stage}.log`
  const failedCheck = run(['apply', '--resolve', 'the check must still match'], {
    AST_GREP_BIN: fake, FAKE_AST_GREP_LOG: log, CODEMOD_STAGE: stage,
    FAKE_AST_GREP_DIFF: '@@ -1 +1 @@\n-old\n+new\n', FAKE_AST_GREP_RUN_EXIT: '7',
  })
  assert.equal(failedCheck.status, 3)
  assert.equal(existsSync(applyLog), false)
  const failedUpdate = run(['apply', '--resolve', 'the update is approved'], {
    AST_GREP_BIN: fake, FAKE_AST_GREP_LOG: log, CODEMOD_STAGE: stage,
    FAKE_AST_GREP_DIFF: '@@ -1 +1 @@\n-old\n+new\n', FAKE_AST_GREP_UPDATE_EXIT: '7',
  })
  assert.equal(failedUpdate.status, 3)
  assert.equal(existsSync(applyLog), false)
  const missing = run([
    'propose', '--pattern', 'a($A)', '--rewrite', 'b($A)', '--lang', 'js', 'crew/roles/planner.md',
  ], { AST_GREP_BIN: '/nonexistent', CODEMOD_STAGE: join(scratchDir('b19-missing-'), 'proposal.json') })
  assert.equal(missing.status, 3)
  const missingOutput = `${missing.stdout || ''}${missing.stderr || ''}`
  assert.match(missingOutput, /ast-grep/)
  assert.match(missingOutput, /install/i)
})

test('implementation-file sections name existing files in both docs', () => {
  const docs = [
    ['docs/park-lease-protocol.md', ['crew/reclaim.mjs']],
    ['docs/conventions.md', ['crew/crew.mjs', 'crew/drive.mjs', 'crew/daemon.mjs']],
  ]
  for (const [rel, required] of docs) {
    const text = readFileSync(join(REPO_ROOT, rel), 'utf8')
    const start = text.indexOf('## Implementation files')
    assert.ok(start >= 0, `${rel} must have an Implementation files section`)
    const rest = text.slice(start + '## Implementation files'.length)
    const end = rest.indexOf('\n## ')
    const section = end < 0 ? rest : rest.slice(0, end)
    const paths = [...section.matchAll(/`([\w./-]+\.(?:mjs|js|json|md|yml))`/g)].map((match) => match[1])
    assert.ok(paths.length)
    for (const path of paths) assert.ok(existsSync(join(REPO_ROOT, path)), `${path} must exist`)
    for (const path of required) assert.ok(paths.includes(path), `${rel} must name ${path}`)
  }
})

test('conventions disambiguates agent and seat as runtime under crew, not the model', () => {
  const text = readFileSync(join(REPO_ROOT, 'docs/conventions.md'), 'utf8')
  const line = text.split('\n').find((entry) => /\bagent\b/.test(entry) && /\bseat\b/.test(entry) && /crew\//.test(entry) && /not the model/i.test(entry))
  assert.ok(line)
})

test('protectedHits matches the ratified protected paths in both directions', () => {
  assert.deepEqual([...PROTECTED_PATHS].sort(), [
    '.github/workflows/', 'crew/capabilities.json', 'crew/capabilities.schema.json', 'crew/drive.mjs', 'crew/escalation-policy.mjs', 'crew/model-ladder.json',
    'crew/protected-paths.mjs', 'crew/reclaim.mjs', 'crew/variants.mjs',
    'crew/roster.json', 'crew/roster.schema.json', 'docs/adr/',
  ].sort())
  assert.equal(PROTECTED_PATHS.includes('crew/roles/'), false)
  assert.deepEqual(protectedHits([
    'docs/adr/031.md', '.github/workflows/test.yml', 'crew/drive.mjs', 'docs/adr/',
    'crew/roles/planner.md', 'crew/crew.mjs', 'a.mjs', 'docs/adr/031.md',
    'crew/drive.mjs.bak', 'crew/roster.json.tmp',
    'crew/capabilities.json', 'crew/capabilities.schema.json', 'crew/model-ladder.json',
    'crew/model-ladder.json.bak',
  ]), ['docs/adr/031.md', '.github/workflows/test.yml', 'crew/drive.mjs', 'docs/adr/',
    'crew/capabilities.json', 'crew/capabilities.schema.json', 'crew/model-ladder.json'])
})

test('charters pin the batched question and keyed answer conventions', () => {
  const shared = readFileSync(new URL('./roles/_shared.md', import.meta.url), 'utf8')
  const lead = readFileSync(new URL('./roles/lead.md', import.meta.url), 'utf8')
  const planner = readFileSync(new URL('./roles/planner.md', import.meta.url), 'utf8')
  const builder = readFileSync(new URL('./roles/builder.md', import.meta.url), 'utf8')
  for (const token of ['"questions"', '"id"', '"question"']) assert.ok(shared.includes(token))
  assert.ok(shared.includes('If brief or plan gaps prevent completion, return ALL gaps together in SAME envelope:'))
  assert.match(shared, /unique within the envelope/i)
  assert.match(shared, /one round instead of one round per gap/i)
  const example = `    "details": {"questions": [{"id": "q1","question": "<one specific gap>"},
      {"id": "q2","question": "..."}] }`
  assert.equal(shared.split(example).length - 1, 1)
  const cap = shared.match(/at most ([0-9]+) questions/)
  assert.equal(Number(cap?.[1]), MAX_QUESTIONS)
  for (const token of ['"answers"', '"answer"', 'UNANSWERED']) assert.ok(lead.includes(token))
  assert.ok(planner.includes('status: insufficient') && planner.includes('details.questions'))
  assert.ok(builder.includes('insufficient') && builder.includes('details.questions'))
})

test('shared Hard rules retain ordered never-simplify safeguards and role charters forbid one-line guidance', () => {
  const rolesDir = join(REPO_ROOT, 'crew', 'roles')
  const shared = readFileSync(join(rolesDir, '_shared.md'), 'utf8')
  const lines = shared.split('\n')
  const hardRules = lines.indexOf('## Hard rules')
  const marker = '- Never simplify away:'
  const indexes = lines.flatMap((line, index) => line === marker ? [index] : [])
  assert.equal(indexes.length, 1)
  assert.ok(indexes[0] > hardRules)
  const safeguards = lines.slice(indexes[0] + 1, indexes[0] + 8)
  assert.deepEqual(safeguards, [
    '  - trust-boundary validation',
    '  - data-loss error handling',
    '  - security checks',
    '  - anything the task explicitly requested',
    '  - closed enums',
    '  - honest absence with a reason',
    '  - a denominator beside every rate',
  ])
  assert.equal(lines[indexes[0] + 8]?.startsWith('  - '), false)
  const offenders = readdirSync(rolesDir)
    .filter((name) => name.endsWith('.md'))
    .filter((name) => /\b(?:make|made) it one line\b|\bone-liner\b/i.test(readFileSync(join(rolesDir, name), 'utf8')))
  assert.deepEqual(offenders, [])
})

test('runtime composed charter sizes stay at their ceilings', () => {
  const rolesDir = join(REPO_ROOT, 'crew', 'roles')
  const measured = compiledCharterBytes(rolesDir)
  const sizes = Object.fromEntries(Object.entries(measured).map(([role, entry]) => [role, entry.bytes]))
  const expected = { builder: 8030, lead: 12851, planner: 20680, reviewer: 10780, 'tech-lead': 9962 }
  const summary = Object.entries(measured).map(([role, entry]) => `${role}=${entry.bytes}`).join(', ')
  assert.deepEqual(sizes, expected, `composed charter sizes: ${summary}`)
  for (const [role, ceiling] of Object.entries(CHARTER_CEILINGS)) {
    assert.equal(measured[role]?.bytes, ceiling, `composed charter ${role} must EQUAL its ceiling ${ceiling}: ${summary}`)
  }
  assert.deepEqual(charterBudgetRefusals(measured), [], `unexpected charter refusals: ${summary}`)
})

test('both charters state where the planner stops and the lead takes over', () => {
  const lead = readFileSync(new URL('./roles/lead.md', import.meta.url), 'utf8')
  const planner = readFileSync(new URL('./roles/planner.md', import.meta.url), 'utf8')
  assert.match(lead, /## Gate custody \(post-acceptance\)/)
  assert.match(lead, /gate_cmd/)
  assert.match(lead, /spends no budget/)
  assert.match(planner, /domain ends when your plan is accepted/)
  assert.match(planner.slice(planner.indexOf('domain ends when your plan is accepted')), /lead/)
  assert.doesNotMatch(planner, /## Perspective assignments/)
})

test('both judgement charters carry exactly one Perspective assignments section', () => {
  for (const role of ['lead', 'tech-lead']) {
    const charter = readFileSync(new URL(`./roles/${role}.md`, import.meta.url), 'utf8')
    assert.equal(charter.split('## Perspective assignments').length - 1, 1, role)
  }
  for (const role of ['_shared', 'planner']) {
    const charter = readFileSync(new URL(`./roles/${role}.md`, import.meta.url), 'utf8')
    assert.equal(charter.split('## Perspective assignments').length - 1, 0, role)
  }
})

test('#800 §7b 34 — the shared charter pin includes disposition and its compatibility window', () => {
  const charter = readFileSync(new URL('./roles/reviewer.md', import.meta.url), 'utf8')
  const block = charter.slice(charter.indexOf('## Envelope details fields'), charter.indexOf('## Perspective assignments'))
  const line = block.match(/"disposition":\s*([^\n]+)/)?.[1]
  assert.ok(line)
  assert.deepEqual([...line.matchAll(/"([^\"]+)"/g)].map((match) => match[1]), [...FINDING_DISPOSITIONS])
  assert.ok(block.includes('`disposition` is OPTIONAL in this release and REQUIRED from the next'))
})

const DOCUMENT_DIFF = [
  "diff --git a/src/lifecycle.mjs b/src/lifecycle.mjs\n--- a/src/lifecycle.mjs\n+++ b/src/lifecycle.mjs\n@@ -1,4 +1,5 @@\n export const STAGES = Object.freeze([\n   'commit',\n+  'document',\n   'publish',\n ])",
  "diff --git a/src/cli.mjs b/src/cli.mjs\n--- a/src/cli.mjs\n+++ b/src/cli.mjs\n@@ -1,3 +1,3 @@\n const KNOWN_FLAGS = Object.freeze({\n-  run: ['old-flag'],\n+  run: ['old-flag', 'new-flag'],\n })",
  "diff --git a/src/refusals.mjs b/src/refusals.mjs\n--- a/src/refusals.mjs\n+++ b/src/refusals.mjs\n@@ -1,3 +1,4 @@\n const REFUSAL_REASONS = Object.freeze([\n   OLD_REFUSAL,\n+  NEW_REFUSAL,\n ])",
  "diff --git a/src/policy.mjs b/src/policy.mjs\n--- a/src/policy.mjs\n+++ b/src/policy.mjs\n@@ -1 +1 @@\n-const RATIFIED_POSTURE = 'old-posture'\n+const RATIFIED_POSTURE = 'new-posture'",
].join('\n')

const DOCUMENT_ENTRIES = [
  { surface: 'lifecycle-stages', source: 'src/lifecycle.mjs', target: 'skills/crew-dispatch/references/batch.md', entry: 'Run the `document` stage after `commit` and before `publish`.' },
  { surface: 'cli-flags', source: 'src/cli.mjs', target: 'skills/crew-dispatch/references/flags.md', entry: '"run": ["new-flag"]' },
  { surface: 'closed-refusals', source: 'src/refusals.mjs', target: 'docs/conventions.md', entry: '- **2026-09-14** — Added closed refusal `NEW_REFUSAL` from `src/refusals.mjs`. *Why:* The lane changed the closed-refusals documented surface.' },
  { surface: 'ratified-posture', source: 'src/policy.mjs', target: 'docs/conventions.md', entry: '- **2026-09-14** — Ratified posture `new-posture` from `src/policy.mjs`. *Why:* The lane changed the ratified-posture documented surface.' },
]

test('A1 inventories and stage classification place document after commit', () => {
  assert.deepEqual([...REVIEWED_CORE_STAGES], ['build', 'scope-gate', 'lane', 'review', 'commit', 'document', 'rebase', 'suite', 'publish'])
  assert.deepEqual([...SHAPE_MAJOR_PHASES], ['plan', 'build', 'review', 'commit', 'document', 'rebase', 'suite', 'publish'])
  assert.deepEqual(VARIANTS.repair.stages.slice(-5), ['commit', 'document', 'rebase', 'suite', 'publish'])
})

test('B1-B6/C1 recognize closed declarations and reject generic options', () => {
  assert.deepEqual(documentStagePlan({ diff: DOCUMENT_DIFF }, { date: '2026-09-14' }), { triggered: true, readable: true, entries: DOCUMENT_ENTRIES })
  const dispatch = "diff --git a/scripts/factory/dispatch-batch.mjs b/scripts/factory/dispatch-batch.mjs\n--- a/scripts/factory/dispatch-batch.mjs\n+++ b/scripts/factory/dispatch-batch.mjs\n@@ -1,3 +1,4 @@\n const valueFlags = new Set([\n   'batch',\n+  'new-batch-flag',\n ])"
  assert.deepEqual(documentStagePlan(dispatch, { date: '2026-09-14' }).entries, [
    { surface: 'cli-flags', source: 'scripts/factory/dispatch-batch.mjs', target: 'skills/crew-dispatch/references/flags.md', entry: '- Value flags: `--new-batch-flag`.' }
  ])
  const options = "diff --git a/src/runtime.mjs b/src/runtime.mjs\n--- a/src/runtime.mjs\n+++ b/src/runtime.mjs\n@@ -1,3 +1,3 @@\n const options = {\n-  checkout: 'old',\n+  checkout: 'new',\n }"
  assert.deepEqual(documentStagePlan(options), { triggered: false, readable: true, entries: [] })
  const twoRefusals = "diff --git a/src/refusals.mjs b/src/refusals.mjs\n--- a/src/refusals.mjs\n+++ b/src/refusals.mjs\n@@ -1,7 +1,9 @@\n const REFUSAL_REASONS = Object.freeze([\n   OLD_REFUSAL,\n+  FIRST_NEW_REFUSAL,\n ])\n const PUBLISH_REFUSALS = Object.freeze([\n   OLD_PUBLISH_REFUSAL,\n+  SECOND_NEW_REFUSAL,\n ])"
  assert.deepEqual(documentStagePlan(twoRefusals, { date: '2026-09-14' }).entries.map((entry) => entry.entry), [
    '- **2026-09-14** — Added closed refusal `FIRST_NEW_REFUSAL` from `src/refusals.mjs`. *Why:* The lane changed the closed-refusals documented surface.',
    '- **2026-09-14** — Added closed refusal `SECOND_NEW_REFUSAL` from `src/refusals.mjs`. *Why:* The lane changed the closed-refusals documented surface.',
  ])
  const images = documentDiffImages(DOCUMENT_DIFF)
  const declarations = documentDeclarations(images)
  assert.equal(documentChangedDeclarations(images, declarations).length, 4)
  assert.equal(documentTrigger('const old = 1').readable, false)
})

test('RV1-1 preserves existing refusals after apostrophe comments', () => {
  const refusalCommentDiff = [
    'diff --git a/src/refusals.mjs b/src/refusals.mjs',
    '--- a/src/refusals.mjs',
    '+++ b/src/refusals.mjs',
    '@@ -1,4 +1,4 @@',
    ' const REFUSAL_REASONS = Object.freeze([',
    "   'alpha',   // don't reuse",
    "-  'beta',",
    "+  'beta', 'gamma',",
    ' ])',
  ].join('\n')
  assert.deepEqual(documentStagePlan(refusalCommentDiff, { date: '2026-09-14' }).entries, [
    { surface: 'closed-refusals', source: 'src/refusals.mjs', target: 'docs/conventions.md', entry: '- **2026-09-14** — Added closed refusal `gamma` from `src/refusals.mjs`. *Why:* The lane changed the closed-refusals documented surface.' },
  ])
})

const DOCUMENT_CHECKOUT = '/tmp/document-author-checkout'
const DOCUMENT_TARGET_PATH = `${DOCUMENT_CHECKOUT}/${DOCUMENT_APPEND_TARGET}`
const DOCUMENT_BATCH_PATH = `${DOCUMENT_CHECKOUT}/skills/crew-dispatch/references/batch.md`
const DOCUMENT_FLAGS_PATH = `${DOCUMENT_CHECKOUT}/skills/crew-dispatch/references/flags.md`
const DOCUMENT_MANIFEST_PATH = `${DOCUMENT_CHECKOUT}/skills/crew-dispatch/anchors.json`
const DOCUMENT_BASE = '# Conventions fixture\n\n## Format\n\nformat-marker\n\n## Entries\n\n- **2026-01-01** — Existing entry. *Why:* fixture.\n'
const DOCUMENT_BATCH_BASE = [
  '# Batch fixture', '',
  '1. First step.',
  '2. Second step.',
  '4. Final step.',
  '  indented continuation survives.',
  '',
  'Parallel prose remains after the procedure.', '',
].join('\n')
const DOCUMENT_FLAGS_BASE = [
  '# Flags fixture', '',
  '```json',
  '{',
  '  "boot": ["boot-old"],',
  '  "run":  ["run-old"]',
  '}',
  '```', '',
  '## Batch dispatch: the dispatch-batch flag family', '',
  '- Value flags: `--old-value`.',
  '- Boolean flags: `--old-boolean`.',
  '- Repeatable: `--old-repeatable`.',
  '- Prefix-matched per-seat forms: `--agent-<role>`.', '',
].join('\n')
const DOCUMENT_REFUSAL_DIFF = [
  'diff --git a/src/refusals.mjs b/src/refusals.mjs',
  '--- a/src/refusals.mjs',
  '+++ b/src/refusals.mjs',
  '@@ -1,3 +1,4 @@',
  ' const REFUSAL_REASONS = Object.freeze([',
  '  OLD_REFUSAL,',
  '+ NEW_REFUSAL,',
  ' ])',
].join('\n')
const DOCUMENT_STRUCTURAL_DIFF = [
  "diff --git a/src/lifecycle.mjs b/src/lifecycle.mjs\n--- a/src/lifecycle.mjs\n+++ b/src/lifecycle.mjs\n@@ -1,4 +1,5 @@\n export const STAGES = Object.freeze([\n   'commit',\n+  'document',\n   'publish',\n ])",
  "diff --git a/src/cli.mjs b/src/cli.mjs\n--- a/src/cli.mjs\n+++ b/src/cli.mjs\n@@ -1,3 +1,3 @@\n const KNOWN_FLAGS = Object.freeze({\n-  run: ['old-flag'],\n+  run: ['old-flag', 'new-flag'],\n })",
  "diff --git a/scripts/factory/dispatch-batch.mjs b/scripts/factory/dispatch-batch.mjs\n--- a/scripts/factory/dispatch-batch.mjs\n+++ b/scripts/factory/dispatch-batch.mjs\n@@ -1,3 +1,4 @@\n const valueFlags = new Set([\n   'old-value',\n+  'new-value',\n ])",
].join('\n')
const DOCUMENT_LIFECYCLE_DIFF = DOCUMENT_STRUCTURAL_DIFF.split('\ndiff --git ')[0]
const DOCUMENT_KNOWN_FLAGS_DIFF = [
  "diff --git a/src/cli.mjs b/src/cli.mjs\n--- a/src/cli.mjs\n+++ b/src/cli.mjs\n@@ -1,3 +1,3 @@\n const KNOWN_FLAGS = Object.freeze({\n-  run: ['old-flag'],\n+  run: ['old-flag', 'new-flag'],\n })",
].join('\n')
const DOCUMENT_DISPATCH_DIFF = [
  "diff --git a/scripts/factory/dispatch-batch.mjs b/scripts/factory/dispatch-batch.mjs\n--- a/scripts/factory/dispatch-batch.mjs\n+++ b/scripts/factory/dispatch-batch.mjs\n@@ -1,3 +1,4 @@\n const valueFlags = new Set([\n   'old-value',\n+  'new-value',\n ])",
].join('\n')
const DOCUMENT_BOOLEAN_DIFF = "diff --git a/scripts/factory/dispatch-batch.mjs b/scripts/factory/dispatch-batch.mjs\n--- a/scripts/factory/dispatch-batch.mjs\n+++ b/scripts/factory/dispatch-batch.mjs\n@@ -1,3 +1,4 @@\n const booleanFlags = new Set([\n   'old-boolean',\n+  'new-boolean',\n ])"
const DOCUMENT_ABSENT_GROUP_DIFF = "diff --git a/src/cli.mjs b/src/cli.mjs\n--- a/src/cli.mjs\n+++ b/src/cli.mjs\n@@ -1,4 +1,5 @@\n const KNOWN_FLAGS = Object.freeze({\n   'boot': ['boot-old'],\n+  admin: ['admin-new'],\n   'run': ['run-old'],\n })"

function documentationIo({ diff = DOCUMENT_DIFF, targetText = DOCUMENT_BASE, targetTexts = {}, fence = () => true, changed = [], repair = { ok: true, output: '' }, commitIds = ['author-1'] } = {}) {
  const files = new Map([
    [DOCUMENT_TARGET_PATH, targetText],
    [DOCUMENT_BATCH_PATH, DOCUMENT_BATCH_BASE],
    [DOCUMENT_FLAGS_PATH, DOCUMENT_FLAGS_BASE],
  ])
  const targetPath = (path) => path.startsWith('/') ? path : `${DOCUMENT_CHECKOUT}/${path}`
  for (const [path, text] of Object.entries(targetTexts)) files.set(targetPath(path), text)
  const changedSet = new Set(changed)
  const writes = [], commits = [], reads = [], runs = [], events = [], anchorCommands = []
  let changedReads = 0
  const io = {
    files, changedSet, writes, commits, reads, runs, events, anchorCommands,
    get changedReads() { return changedReads },
    run(command) {
      runs.push(command); events.push({ type: 'run', command })
      if (command.startsWith('git diff --binary --no-ext-diff ')) return { ok: true, output: diff }
      if (command.startsWith('node skills/qa-test-writing/anchor-pin.mjs --repair ')) {
        anchorCommands.push(command)
        return typeof repair === 'function' ? repair(command, io) : repair
      }
      return { ok: true, output: '' }
    },
    readFile(path) {
      reads.push(path)
      return files.has(path) ? files.get(path) : null
    },
    writeFile(path, content) {
      writes.push({ path, content }); events.push({ type: 'write', path, content })
      files.set(path, content)
      changedSet.add(path.startsWith(`${DOCUMENT_CHECKOUT}/`) ? path.slice(`${DOCUMENT_CHECKOUT}/`.length) : path)
    },
    changedFiles() {
      changedReads += 1
      return [...changedSet]
    },
    commit(filesForCommit, message) {
      const record = { files: [...filesForCommit], message }
      commits.push(record); events.push({ type: 'commit', ...record })
      return commitIds.shift() ?? null
    },
    inScope: fence,
  }
  return io
}

const documentationDecision = (io, over = {}) => runDocumentationDecision({
  ctx: { checkout: DOCUMENT_CHECKOUT, head: 'base1111', documentDate: '2026-09-14', ...over.ctx },
  commit: over.commit || 'head2222', inScope: io.inScope, io,
})

function decorateDriverDocumentationIo(io, { targetText = DOCUMENT_BASE, targetPath = null, targetTexts = {}, changed = [], commitIds = ['code-1', 'author-1'], repair = null } = {}) {
  const root = io.state?.checkout || '/tmp/repo'
  const paths = {
    [DOCUMENT_APPEND_TARGET]: targetPath || `${root}/${DOCUMENT_APPEND_TARGET}`,
    [DOCUMENT_BATCH_TARGET]: `${root}/${DOCUMENT_BATCH_TARGET}`,
    [DOCUMENT_FLAGS_TARGET]: `${root}/${DOCUMENT_FLAGS_TARGET}`,
  }
  const files = new Map([[paths[DOCUMENT_APPEND_TARGET], targetText]])
  for (const [target, text] of Object.entries(targetTexts)) files.set(paths[target] || target, text)
  const originalRead = io.readFile.bind(io)
  const originalWrite = io.writeFile.bind(io)
  const originalRun = io.run.bind(io)
  const originalChanged = io.changedFiles.bind(io)
  const originalCommit = io.commit.bind(io)
  const events = []
  const changedDocs = new Set()
  const relativeDocPath = (path) => path.startsWith(`${io.state?.checkout || '/tmp/repo'}/`) ? path.slice(`${io.state?.checkout || '/tmp/repo'}/`.length) : path
  io.readFile = (path) => files.has(path) ? files.get(path) : originalRead(path)
  io.writeFile = (path, content) => {
    if (files.has(path)) { files.set(path, content); changedDocs.add(relativeDocPath(path)); events.push({ type: 'write', path, content }) }
    return originalWrite(path, content)
  }
  io.run = (command) => {
    if (command.startsWith('node skills/qa-test-writing/anchor-pin.mjs --repair ')) {
      events.push({ type: 'repair', command })
      if (typeof repair === 'function') return repair(command, { files, changedDocs, events })
      return { ok: true, output: '' }
    }
    return originalRun(command)
  }
  io.changedFiles = () => [...new Set([...(changed.length > 0 ? changed : originalChanged()), ...changedDocs])]
  io.commit = (filesForCommit, message) => {
    const result = originalCommit(filesForCommit, message)
    const commit = commitIds.shift() ?? null
    const record = io.calls?.commits?.at(-1)
    if (record) record.sha = commit
    if (io.state) io.state.head = commit
    events.push({ type: 'commit', files: [...filesForCommit], message, commit })
    return commit
  }
  io.__documentation = { files, events }
  return io
}

const DOCUMENT_SCOPE = ['a.mjs', 'a.test.mjs', DOCUMENT_APPEND_TARGET]
const documentationPlan = () => planEnv({ details: { ...planEnv().details, files_in_scope: DOCUMENT_SCOPE } })

test('A1 document author appends and commits a fenced conventions entry', () => {
  const io = documentationIo({ diff: DOCUMENT_REFUSAL_DIFF, changed: [] })
  const result = documentationDecision(io)
  const entry = DOCUMENT_ENTRIES[2].entry
  assert.equal(result.documentation, null)
  assert.equal(result.commit, 'author-1')
  assert.equal(io.writes.length, 1)
  assert.equal(io.writes[0].path, DOCUMENT_TARGET_PATH)
  assert.equal(io.writes[0].content, `${DOCUMENT_BASE}${entry}\n`)
  assert.equal(io.commits.length, 1)
  assert.deepEqual(io.commits[0].files, [DOCUMENT_APPEND_TARGET])
  assert.equal(io.commits[0].message, 'docs: author planned conventions entries')
})

test('ADR-045 document author commits a recognized target outside recorded context', () => {
  const io = documentationIo({ diff: DOCUMENT_REFUSAL_DIFF, fence: () => false })
  const result = documentationDecision(io)
  assert.equal(result.commit, 'author-1')
  assert.equal(result.documentation, null)
  assert.deepEqual(io.commits[0].files, [DOCUMENT_APPEND_TARGET])
  assert.equal(io.writes[0].path, DOCUMENT_TARGET_PATH)
})

test('B1 document author appends after the last existing Entries line', () => {
  const targetText = '# B1 fixture\n\n## Format\n\nformat-marker\n\n## Entries\n\n- **2026-01-01** — final old line. *Why:* fixture.'
  const io = documentationIo({ diff: DOCUMENT_REFUSAL_DIFF, targetText })
  const result = documentationDecision(io)
  const entry = DOCUMENT_ENTRIES[2].entry
  const authored = io.files.get(DOCUMENT_TARGET_PATH)
  assert.equal(result.documentation, null)
  assert.equal(authored, `${targetText}\n${entry}\n`)
  assert.ok(authored.indexOf(entry) > authored.indexOf('- **2026-01-01** — final old line.'))
  assert.ok(authored.indexOf(entry) > authored.indexOf('## Entries'))
})

test('C1 document author is idempotent across two runs for one commit', () => {
  const duplicateDiff = [
    'diff --git a/src/refusals.mjs b/src/refusals.mjs',
    '--- a/src/refusals.mjs',
    '+++ b/src/refusals.mjs',
    '@@ -1,7 +1,9 @@',
    ' const REFUSAL_REASONS = Object.freeze([',
    '  OLD_REFUSAL,',
    '+ DUPLICATE_REFUSAL,',
    ' ])',
    ' const PUBLISH_REFUSALS = Object.freeze([',
    '  OLD_PUBLISH_REFUSAL,',
    '+ DUPLICATE_REFUSAL,',
    ' ])',
  ].join('\n')
  const io = documentationIo({ diff: duplicateDiff, commitIds: ['author-1', 'author-2'] })
  const first = documentationDecision(io)
  const second = documentationDecision(io, { commit: first.commit })
  const entry = '- **2026-09-14** — Added closed refusal `DUPLICATE_REFUSAL` from `src/refusals.mjs`. *Why:* The lane changed the closed-refusals documented surface.'
  assert.equal(first.documentation, null)
  assert.equal(second.documentation, null)
  assert.equal(io.files.get(DOCUMENT_TARGET_PATH).split(entry).length - 1, 1)
  assert.equal(io.writes.length, 1)
  assert.equal(io.commits.length, 1)
  assert.equal(first.commit, 'author-1')
  assert.equal(second.commit, 'author-1')
})

test('D1 document author writes a recognized conventions target outside context', () => {
  const io = documentationIo({ diff: DOCUMENT_REFUSAL_DIFF, fence: () => false })
  const result = documentationDecision(io)
  const entry = DOCUMENT_ENTRIES[2].entry
  assert.equal(result.documentation, null)
  assert.equal(result.commit, 'author-1')
  assert.equal(io.files.get(DOCUMENT_TARGET_PATH), `${DOCUMENT_BASE}${entry}\n`)
  assert.deepEqual(io.writes.map(({ path }) => path), [DOCUMENT_TARGET_PATH])
  assert.deepEqual(io.commits[0].files, [DOCUMENT_APPEND_TARGET])
  assert.equal(io.reads.includes(DOCUMENT_TARGET_PATH), true)
})

test('E1 document author makes an untriggered decision a write-free commit-free no-op', () => {
  const io = documentationIo({ diff: '' })
  const result = documentationDecision(io, { commit: 'unchanged-1' })
  assert.equal(result.documentation, null)
  assert.equal(result.commit, 'unchanged-1')
  assert.equal(io.writes.length, 0)
  assert.equal(io.commits.length, 0)
  assert.equal(io.changedReads, 0)
})

test('F1 document author preserves unreadable residual bytes and writes nothing', () => {
  const io = documentationIo({ diff: 'not a unified diff' })
  const result = documentationDecision(io, { commit: 'unchanged-1' })
  assert.deepEqual(result.documentation, {
    id: 'documentation-plan', type: 'cosmetic', outcome: 'unreadable',
    summary: 'Documentation diff could not be read: diff contained malformed, binary, or non-text sections', plan: [],
  })
  assert.equal(result.commit, 'unchanged-1')
  assert.equal(io.writes.length, 0)
  assert.equal(io.commits.length, 0)
  assert.equal(io.reads.includes(DOCUMENT_TARGET_PATH), false)
})

test('E1 structural documentation targets are authored outside context', () => {
  const io = documentationIo({ fence: (target) => target === DOCUMENT_APPEND_TARGET })
  const result = documentationDecision(io)
  assert.equal(result.documentation, null)
  assert.equal(result.commit, 'author-1')
  assert.notEqual(io.files.get(DOCUMENT_BATCH_PATH), DOCUMENT_BATCH_BASE)
  assert.notEqual(io.files.get(DOCUMENT_FLAGS_PATH), DOCUMENT_FLAGS_BASE)
  assert.notEqual(io.files.get(DOCUMENT_TARGET_PATH), DOCUMENT_BASE)
  assert.deepEqual(io.writes.map(({ path }) => path), [DOCUMENT_BATCH_PATH, DOCUMENT_FLAGS_PATH, DOCUMENT_TARGET_PATH])
  assert.deepEqual(io.commits[0].files, [DOCUMENT_BATCH_TARGET, DOCUMENT_FLAGS_TARGET, DOCUMENT_APPEND_TARGET])
  assert.equal(io.reads.includes(DOCUMENT_BATCH_PATH), true)
  assert.equal(io.reads.includes(DOCUMENT_FLAGS_PATH), true)
})

test('H1 both driver paths author recognized targets outside context', () => {
  const ordinaryIo = decorateDriverDocumentationIo(publicationIo({
    documentDiff: DOCUMENT_DIFF, changed: ['a.mjs', 'a.test.mjs'], envelopes: { 'planner:1': documentationPlan() },
  }), {
    targetPath: `${CTX.checkout}/${DOCUMENT_APPEND_TARGET}`,
    targetTexts: { [DOCUMENT_BATCH_TARGET]: DOCUMENT_BATCH_BASE, [DOCUMENT_FLAGS_TARGET]: DOCUMENT_FLAGS_BASE },
    changed: ['a.mjs', 'a.test.mjs'], commitIds: ['ordinary-code', 'ordinary-docs'],
  })
  const ordinary = driveTask({ ...CTX, head: 'base1111', documentDate: '2026-09-14' }, ordinaryIo)
  assert.equal(ordinary.status, 'done')
  assert.equal(ordinary.details.commit, 'ordinary-docs')
  assert.equal(ordinary.details.documentation ?? null, null)
  assert.ok(ordinaryIo.calls.commits.find((commit) => commit.sha === 'ordinary-docs').files.includes(DOCUMENT_APPEND_TARGET))
  assert.ok(ordinaryIo.calls.commits.find((commit) => commit.sha === 'ordinary-docs').files.includes(DOCUMENT_BATCH_TARGET))
  assert.ok(ordinaryIo.calls.commits.find((commit) => commit.sha === 'ordinary-docs').files.includes(DOCUMENT_FLAGS_TARGET))

  const convergenceIo = decorateDriverDocumentationIo(convergeIo({ documentDiff: DOCUMENT_DIFF, changed: ['a.mjs'] }), {
    targetPath: `${CTX.checkout}/${DOCUMENT_APPEND_TARGET}`,
    targetTexts: { [DOCUMENT_BATCH_TARGET]: DOCUMENT_BATCH_BASE, [DOCUMENT_FLAGS_TARGET]: DOCUMENT_FLAGS_BASE },
    changed: ['a.mjs'], commitIds: ['converge-code', 'converge-docs'],
  })
  const originalWait = convergenceIo.wait.bind(convergenceIo)
  convergenceIo.wait = (path) => {
    const env = originalWait(path)
    return path === 'planner:1' ? { ...env, details: { ...env.details, files_in_scope: DOCUMENT_SCOPE } } : env
  }
  const convergence = driveTask({ ...CONVERGE_CTX, head: 'base1111', documentDate: '2026-09-14' }, convergenceIo)
  assert.equal(convergence.status, 'converge')
  assert.equal(convergence.details.commit, 'converge-docs')
  assert.equal(convergence.details.documentation ?? null, null)
  assert.ok(convergenceIo.calls.commits.find((commit) => commit.sha === 'converge-docs').files.includes(DOCUMENT_APPEND_TARGET))
  assert.ok(convergenceIo.calls.commits.find((commit) => commit.sha === 'converge-docs').files.includes(DOCUMENT_BATCH_TARGET))
  assert.ok(convergenceIo.calls.commits.find((commit) => commit.sha === 'converge-docs').files.includes(DOCUMENT_FLAGS_TARGET))
})

test('I1 document author runs anchor repair over the touched conventions target', () => {
  const io = documentationIo({ diff: DOCUMENT_REFUSAL_DIFF })
  const result = documentationDecision(io)
  assert.equal(result.commit, 'author-1')
  assert.equal(io.anchorCommands.length, 1)
  assert.match(io.anchorCommands[0], /--repair skills\/backend-node/)
  assert.match(io.anchorCommands[0], /--root '\/tmp\/document-author-checkout'/)
  assert.match(io.anchorCommands[0], /--base 'base1111'/)
  const repairIndex = io.events.findIndex(({ type, command }) => type === 'run' && command === io.anchorCommands[0])
  const writeIndex = io.events.findIndex(({ type }) => type === 'write')
  const commitIndex = io.events.findIndex(({ type }) => type === 'commit')
  assert.ok(writeIndex < repairIndex && repairIndex < commitIndex)
})

test('J1 document journaling is marker-only', () => {
  const run = runPublished({ documentDiff: '' })
  const markers = run.io.calls.logs.filter((row) => row.stage === 'document' || row.stage_done === 'document')
  assert.deepEqual(markers.map((row) => Object.keys(row).filter((key) => key !== 'at')), [['stage', 'channel'], ['stage_done', 'channel']])
})

test('A1 structural batch insertion derives the next number', () => {
  const io = documentationIo({ diff: DOCUMENT_LIFECYCLE_DIFF, targetTexts: { [DOCUMENT_BATCH_TARGET]: DOCUMENT_BATCH_BASE } })
  const result = documentationDecision(io)
  const authored = io.files.get(DOCUMENT_BATCH_PATH)
  assert.equal(result.commit, 'author-1')
  assert.match(authored, /4\. Final step\.\n  indented continuation survives\.\n5\. Run the `document` stage after `commit` and before `publish`\.\n\nParallel prose remains/)
  assert.equal(io.reads.filter((path) => path === DOCUMENT_BATCH_PATH).length, 1)
  assert.equal(io.writes.length, 1)
  assert.equal(io.anchorCommands.length, 1)
  assert.match(io.anchorCommands[0], /--repair skills\/crew-dispatch/)
})

test('B1 structural flag insertion extends the existing labelled line', () => {
  const io = documentationIo({ diff: DOCUMENT_DISPATCH_DIFF, targetTexts: { [DOCUMENT_FLAGS_TARGET]: DOCUMENT_FLAGS_BASE } })
  documentationDecision(io)
  const authored = io.files.get(DOCUMENT_FLAGS_PATH)
  assert.match(authored, /- Value flags: `--old-value --new-value`\./)
  assert.equal(authored.split('- Value flags:').length - 1, 1)
  assert.equal(io.writes.length, 1)
})

test('B2 structural KNOWN_FLAGS insertion extends the existing JSON array', () => {
  const io = documentationIo({ diff: DOCUMENT_KNOWN_FLAGS_DIFF, targetTexts: { [DOCUMENT_FLAGS_TARGET]: DOCUMENT_FLAGS_BASE } })
  documentationDecision(io)
  const authored = io.files.get(DOCUMENT_FLAGS_PATH)
  assert.match(authored, /  "run":  \["run-old", "new-flag"\]/)
  assert.equal(authored.split('"new-flag"').length - 1, 1)
  assert.equal(authored.includes('"run": ["new-flag"]'), false)
})

test('C1 structural flag insertion creates a genuinely absent labelled line', () => {
  const targetText = DOCUMENT_FLAGS_BASE.replace('- Boolean flags: `--old-boolean`.\n', '')
  const io = documentationIo({ diff: DOCUMENT_BOOLEAN_DIFF, targetTexts: { [DOCUMENT_FLAGS_TARGET]: targetText } })
  documentationDecision(io)
  const authored = io.files.get(DOCUMENT_FLAGS_PATH)
  assert.ok(authored.indexOf('- Value flags:') < authored.indexOf('- Boolean flags: `--new-boolean`.'))
  assert.ok(authored.indexOf('- Boolean flags: `--new-boolean`.') < authored.indexOf('- Repeatable:'))
  assert.equal(authored.split('- Boolean flags:').length - 1, 1)
})

test('C2 structural KNOWN_FLAGS insertion creates an absent JSON property', () => {
  const io = documentationIo({ diff: DOCUMENT_ABSENT_GROUP_DIFF, targetTexts: { [DOCUMENT_FLAGS_TARGET]: DOCUMENT_FLAGS_BASE } })
  documentationDecision(io)
  const authored = io.files.get(DOCUMENT_FLAGS_PATH)
  assert.match(authored, /  "run":  \["run-old"\],\n  "admin": \["admin-new"\]\n\}/)
  assert.equal(authored.split('"admin":').length - 1, 1)
  assert.equal(authored.includes('- "admin":'), false)
  const json = authored.match(/```json\n([\s\S]*?)\n```/)[1]
  assert.deepEqual(JSON.parse(json).admin, ['admin-new'])
})

test('D1 structural documentation insertion is idempotent per target', () => {
  const io = documentationIo({ diff: DOCUMENT_STRUCTURAL_DIFF })
  const first = documentationDecision(io)
  const second = documentationDecision(io, { commit: first.commit })
  const batch = io.files.get(DOCUMENT_BATCH_PATH)
  const flags = io.files.get(DOCUMENT_FLAGS_PATH)
  assert.equal(first.commit, 'author-1')
  assert.equal(second.commit, 'author-1')
  assert.equal(io.writes.length, 2)
  assert.equal(io.commits.length, 1)
  assert.equal(io.anchorCommands.length, 1)
  assert.equal(batch.split('Run the `document` stage').length - 1, 1)
  assert.equal(batch.split(/\n\d+\. Run the `document` stage/).length - 1, 1)
  assert.equal(flags.split('"new-flag"').length - 1, 1)
  assert.equal(flags.split('--new-value').length - 1, 1)
  assert.equal(flags.split('- Value flags:').length - 1, 1)
})

test('F1 conventions append behavior remains unchanged', () => {
  const io = documentationIo({ diff: DOCUMENT_REFUSAL_DIFF })
  const result = documentationDecision(io)
  const entry = DOCUMENT_ENTRIES[2].entry
  const command = "node skills/qa-test-writing/anchor-pin.mjs --repair skills/backend-node --root '/tmp/document-author-checkout' --base 'base1111'"
  assert.equal(result.commit, 'author-1')
  assert.equal(io.files.get(DOCUMENT_TARGET_PATH), `${DOCUMENT_BASE}${entry}\n`)
  assert.deepEqual(io.writes.map(({ path }) => path), [DOCUMENT_TARGET_PATH])
  assert.deepEqual(io.anchorCommands, [command])
  assert.deepEqual(io.commits[0], { files: [DOCUMENT_APPEND_TARGET], message: 'docs: author planned conventions entries' })
})

test('G1 untriggered documentation remains write free and commit free', () => {
  const io = documentationIo({ diff: '' })
  const result = documentationDecision(io, { commit: 'unchanged-1' })
  assert.equal(result.commit, 'unchanged-1')
  assert.equal(result.documentation, null)
  assert.equal(io.reads.length, 0)
  assert.equal(io.writes.length, 0)
  assert.equal(io.changedReads, 0)
  assert.equal(io.anchorCommands.length, 0)
  assert.equal(io.commits.length, 0)
})

test('H1 recognized documentation targets reach both driver envelopes outside context', () => {
  const targetTexts = { [DOCUMENT_BATCH_TARGET]: DOCUMENT_BATCH_BASE, [DOCUMENT_FLAGS_TARGET]: DOCUMENT_FLAGS_BASE }
  const ordinaryIo = decorateDriverDocumentationIo(publicationIo({
    documentDiff: DOCUMENT_DIFF, changed: ['a.mjs', 'a.test.mjs'], envelopes: { 'planner:1': documentationPlan() },
  }), { targetTexts, changed: ['a.mjs', 'a.test.mjs'], commitIds: ['ordinary-code', 'ordinary-docs'] })
  const ordinary = driveTask({ ...CTX, head: 'base1111', documentDate: '2026-09-14' }, ordinaryIo)
  assert.equal(ordinary.details.documentation ?? null, null)
  const ordinaryDocs = ordinaryIo.calls.commits.find((commit) => commit.sha === 'ordinary-docs')
  assert.ok(ordinaryDocs.files.includes(DOCUMENT_APPEND_TARGET))
  assert.ok(ordinaryDocs.files.includes(DOCUMENT_BATCH_TARGET))
  assert.ok(ordinaryDocs.files.includes(DOCUMENT_FLAGS_TARGET))

  const convergenceIo = decorateDriverDocumentationIo(convergeIo({ documentDiff: DOCUMENT_DIFF, changed: ['a.mjs'] }), {
    targetTexts, changed: ['a.mjs'], commitIds: ['converge-code', 'converge-docs'],
  })
  const originalWait = convergenceIo.wait.bind(convergenceIo)
  convergenceIo.wait = (path) => {
    const env = originalWait(path)
    return path === 'planner:1' ? { ...env, details: { ...env.details, files_in_scope: DOCUMENT_SCOPE } } : env
  }
  const convergence = driveTask({ ...CONVERGE_CTX, head: 'base1111', documentDate: '2026-09-14' }, convergenceIo)
  assert.equal(convergence.details.documentation ?? null, null)
  const convergenceDocs = convergenceIo.calls.commits.find((commit) => commit.sha === 'converge-docs')
  assert.ok(convergenceDocs.files.includes(DOCUMENT_APPEND_TARGET))
  assert.ok(convergenceDocs.files.includes(DOCUMENT_BATCH_TARGET))
  assert.ok(convergenceDocs.files.includes(DOCUMENT_FLAGS_TARGET))
})

test('I1 KNOWN_FLAGS document entry avoids whole-object JSON', () => {
  const entry = documentEntry({ surface: 'cli-flags', declaration: 'KNOWN_FLAGS', group: 'run', value: 'new-flag' }).entry
  assert.equal(entry, '"run": ["new-flag"]')
  assert.doesNotMatch(entry, /^\s*\{/) 
  assert.doesNotMatch(entry, /--new-flag/)
})

test('I2 lifecycle document entry omits hardcoded numbering', () => {
  const entry = documentEntry({ surface: 'lifecycle-stages', path: 'src/lifecycle.mjs' }).entry
  assert.equal(entry, DOCUMENT_LIFECYCLE_ENTRY)
  assert.doesNotMatch(entry, /^\d+\./)
})

test('I3 dispatch document entries omit add instructions', () => {
  for (const [declaration, label] of [['valueFlags', 'Value'], ['booleanFlags', 'Boolean'], ['repeatableFlags', 'Repeatable']]) {
    const entry = documentEntry({ surface: 'cli-flags', declaration, value: `new-${declaration}` }).entry
    assert.equal(entry, `- ${label} flags: \`--new-${declaration}\`.`)
    assert.doesNotMatch(entry, /add /)
  }
})

test('J1 structural documentation runs one fenced crew-dispatch anchor repair', () => {
  const command = "node skills/qa-test-writing/anchor-pin.mjs --repair skills/crew-dispatch --root '/tmp/document-author-checkout' --base 'base1111'"
  const io = documentationIo({
    diff: DOCUMENT_STRUCTURAL_DIFF,
    repair: (seen, fixture) => {
      if (seen === command) {
        fixture.files.set(DOCUMENT_MANIFEST_PATH, '{\"repaired\":true}\n')
        fixture.changedSet.add('skills/crew-dispatch/anchors.json')
      }
      return { ok: true, output: '' }
    },
  })
  const result = documentationDecision(io)
  const writeIndexes = io.events.map(({ type, path }) => type === 'write' && [DOCUMENT_BATCH_PATH, DOCUMENT_FLAGS_PATH].includes(path) ? io.events.findIndex((event) => event.type === 'write' && event.path === path) : -1).filter((index) => index >= 0)
  const repairIndex = io.events.findIndex(({ type, command: seen }) => type === 'run' && seen === command)
  const commitIndex = io.events.findIndex(({ type }) => type === 'commit')
  assert.equal(result.commit, 'author-1')
  assert.deepEqual(io.anchorCommands, [command])
  assert.equal(io.runs.filter((seen) => seen.includes('--repair')).length, 1)
  assert.ok(writeIndexes.every((index) => index < repairIndex))
  assert.ok(repairIndex < commitIndex)
  assert.equal(io.runs.some((seen) => seen.includes('skills/backend-node') || seen.includes('--repair-all')), false)
  assert.deepEqual(io.commits[0].files, [DOCUMENT_BATCH_TARGET, DOCUMENT_FLAGS_TARGET, 'skills/crew-dispatch/anchors.json'])
  assert.equal(io.commits[0].files.length, 3)
})

// CHARTER-PRESERVATION-MIRROR-START
// before-source: fixture
// before-lead-sha256: 2448872e30f1765649a62c5b520b01a5ff16f543732041b65f63a82225a63d55
// before-tech-lead-sha256: f14559227cee0ed481997255d15cbd804b455b3be25c2c6233944e5b8add2748
// f1-anchor-builder-sha256: a77542834deb53d0211af4f4fcffd6fb836f34d97eaaf555b87a2a036416f14e
// | sentence | subject | class | source | quote |
// | --- | --- | --- | --- | --- |
// | **`correctness-unverified` is code-refused into escalation.** | into escalation | enforced | crew/drive.mjs:2109 planAcceptContractLines; enforcement crew/drive.mjs:6542 settleAccept and crew/drive.mjs:2127 ACCEPT_REFUSALS | A residual typed correctness-unverified is legitimate but asks a human, so code refuses it into escalation — the same rule as at review exhaustion. That is a fact about the FIELD, not about which stage you are standing in. |
// CHARTER-PRESERVATION-MIRROR-END

// RV1-1b (b847): the citation guard below proves a row QUOTES its cited line.
// It cannot prove the cited code still DOES anything — three of the four
// citations point at comments, and disabling each underlying branch left it
// green. These four guards hold the executable behaviour the cut sentences
// described, so a regression cannot preserve the comment and delete the rule.
test('a review silent on a carried finding is a defect, and closing or restating it is not', () => {
  const finding = (id) => ({ id, severity: 'must-fix', location: 'a.mjs', summary: 's', evidence: 'e', disposition: 'ask-user' })
  const carried = [{ id: 'PC1' }]
  const silent = carriedSilenceDefect({ outcome: 'findings', findings: [finding('OTHER')] }, carried)
  assert.equal(silent?.reason, 'carried-silent')
  assert.match(silent.why, /PC1/)
  // Restated against the diff: not silent.
  assert.equal(carriedSilenceDefect({ outcome: 'findings', findings: [finding('PC1')] }, carried), null)
  // Explicitly cleared: not silent.
  assert.equal(carriedSilenceDefect({ outcome: 'findings', findings: [finding('OTHER')], carried_cleared: ['PC1'] }, carried), null)
})

test('a finding id outside the closed shape is refused by name, never rewritten or truncated', () => {
  const defect = findingIdDefect({ findings: [{ id: 'bad id/../escape' }] })
  assert.equal(defect?.reason, 'finding-id')
  // The offending id is reported VERBATIM: refusing is not repairing.
  assert.ok(defect.why.includes('bad id/../escape'), defect.why)
  assert.equal(findingIdDefect({ findings: [{ id: 'F1' }] }), null)
  assert.equal(findingIdDefect({ findings: [{ id: 'a'.repeat(64) }] }), null)
  assert.equal(findingIdDefect({ findings: [{ id: 'a'.repeat(65) }] })?.reason, 'finding-id')
})

test('one undecodable patch section refuses the WHOLE patch, unread', () => {
  const good = 'diff --git a/x.mjs b/x.mjs\n--- a/x.mjs\n+++ b/x.mjs\n@@ -1 +1 @@\n-a\n+b\n'
  assert.deepEqual(patchTargets(good), { targets: ['x.mjs'], refusal: null })
  for (const [name, section] of [
    ['rename', 'diff --git a/x b/y\nrename from x\nrename to y\n'],
    ['copy', 'diff --git a/x b/y\ncopy from x\ncopy to y\n'],
    ['binary', 'diff --git a/x b/x\nGIT binary patch\n'],
    ['mode-only', 'diff --git a/x b/x\nold mode 100644\nnew mode 100755\n'],
  ]) {
    // The BAD section is second: a good first section must not rescue the patch.
    const mixed = patchTargets(good + section)
    assert.deepEqual(mixed.targets, [], `${name} left targets readable`)
    assert.ok(typeof mixed.refusal === 'string' && mixed.refusal.length > 0, `${name} refused without a reason`)
  }
  assert.equal(patchTargets('').refusal, 'the patch is empty')
})

test('malformed question entries are dropped and reported, and the outcome never changes', () => {
  const parsed = parseQuestions({ questions: [
    { id: 'q1', question: 'a real question?' },
    { id: '', question: 'no id' },
    'not an object',
    { id: 'q1', question: 'duplicate id' },
  ] })
  // Dropped, not refused: the good entry survives.
  assert.deepEqual(parsed.questions, [{ id: 'q1', question: 'a real question?' }])
  // Reported: every drop carries its index and a reason.
  assert.equal(parsed.rejected.length, 3)
  for (const row of parsed.rejected) {
    assert.equal(Number.isInteger(row.index), true)
    assert.ok(typeof row.why === 'string' && row.why.length > 0)
  }
  // A non-array questions field is the ABSENCE of the field, not a refusal.
  assert.equal(parseQuestions({ questions: 'nope' }), null)
  assert.equal(parseQuestions({}), null)
})

// RV1-1 (b847): every enforced row of the charter-preservation table must quote
// the cited line itself, not merely the cited file. The gate's A1 checks
// containment over the whole source file, so a wrong line number still passes;
// this guard fails the moment a row's line drifts from its evidence.
test('charter preservation rows quote the cited line', () => {
  const table = readFileSync(join(REPO_ROOT, 'docs/audits/2026-09-18/charter-preservation-reviewermdandsharedmd.md'), 'utf8')
  const rows = []
  for (const line of table.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    if (/^\|[\s:|-]+\|$/.test(trimmed)) continue
    const cells = trimmed.split('|').slice(1, -1).map((cell) => cell.trim())
    if (cells.length !== 5) continue
    if (cells[0] === 'sentence') continue
    rows.push({ sentence: cells[0], subject: cells[1], cls: cells[2], source: cells[3], quote: cells[4] })
  }
  const enforced = rows.filter((row) => row.cls === 'enforced')
  assert.ok(enforced.length > 0, 'preservation table carries no enforced rows')
  for (const row of enforced) {
    const at = row.source.match(/^([A-Za-z0-9_@./-]+\.(?:mjs|js|md|json)):(\d+)$/)
    assert.ok(at, `enforced row names no path:line source: ${row.source}`)
    const lines = readFileSync(join(REPO_ROOT, at[1]), 'utf8').split('\n')
    const cited = lines[Number(at[2]) - 1]
    assert.ok(typeof cited === 'string', `cited line is past end of file: ${row.source}`)
    assert.ok(cited.includes(row.quote), `quote not on its cited line ${row.source}: ${row.quote.slice(0, 80)}`)
  }
})
