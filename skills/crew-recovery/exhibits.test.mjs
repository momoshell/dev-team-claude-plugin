import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from '../../test/helpers.mjs'
import { SEAT_DIED_STAGE, SEAT_REFUSAL_STAGE } from '../../crew/seat-io.mjs'
import { VARIANT_NAMES } from '../../crew/variants.mjs'
import { PROVIDER_FAILURE_KINDS } from '../../crew/headless.mjs'
import { assertAnchorsPinned, pinnedKey } from '../qa-test-writing/anchor-pin.mjs'

const HERE = fileURLToPath(new URL('./', import.meta.url))
const MANIFEST = join(HERE, 'anchors.json')
const pin = (expected) => pinnedKey({ manifestPath: MANIFEST, expected })
const DRIVE = 'crew/drive.mjs'
const ACP_STAGE_FILES = readdirSync(join(ROOT, 'crew')).filter((name) => /^acp-.+\.mjs$/.test(name) && !name.endsWith('.test.mjs')).sort().map((name) => 'crew/' + name)
const STAGE_FILES = [DRIVE, 'crew/seat-io.mjs', 'crew/headless.mjs', 'crew/headless-rpc.mjs', 'crew/child.mjs', 'crew/reclaim.mjs', 'crew/daemon.mjs', ...ACP_STAGE_FILES]
const QUOTE = "['\"`]"

// The right-hand side of a stage assignment or property, from start until the
// expression ends: a ';' or ',' at bracket depth 0, a closer that would take the
// depth below 0, or a newline at depth 0 that does not continue the expression.
// lean: brackets are counted lexically and string contents are not skipped; move to a real parser if a producer puts a bracket inside a stage-adjacent string
function stageRhs(source, start) {
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) return source.slice(start, i); depth -= 1 }
    else if (depth === 0 && (ch === ';' || ch === ',')) return source.slice(start, i)
    else if (depth === 0 && ch === '\n') {
      const next = source.slice(i + 1).trimStart()
      const prev = source.slice(start, i).trimEnd()
      if (!/^[?:.|&]/.test(next) && !/[?:(|&=]$/.test(prev)) return source.slice(start, i)
    }
  }
  return source.slice(start)
}

// Every kebab literal a .stage assignment or stage: property can produce: the
// whole right-hand side is scanned, so each branch of a ternary contributes.
// An equality (.stage === 'x') is not an assignment and is never collected.
export function scanStages(source) {
  const emitted = new Set()
  for (const match of source.matchAll(/(?:\.stage\s*=(?!=)|\bstage:)/g)) {
    const rhs = stageRhs(source, match.index + match[0].length)
    const literals = [...rhs.matchAll(new RegExp(QUOTE + '([a-z][a-z0-9-]*)' + QUOTE, 'g'))]
    for (const literal of literals) emitted.add(literal[1])
  }
  for (const helper of ['staged', 'fail']) {
    for (const match of source.matchAll(new RegExp('\\b' + helper + '\\(\\s*' + QUOTE + '([a-z][a-z0-9-]*)' + QUOTE, 'g'))) emitted.add(match[1])
  }
  return emitted
}

// escalate('x', ...) literals plus escalate(<IDENT>.<member>, ...) resolved
// through the exported frozen object of that name in the same source. A first
// argument that names no such object (variant, revalidated.kind) is skipped.
export function scanEscalates(source) {
  const emitted = new Set()
  for (const match of source.matchAll(new RegExp('\\bescalate\\(\\s*' + QUOTE + '([a-z][a-z0-9-]*)' + QUOTE, 'g'))) emitted.add(match[1])
  for (const match of source.matchAll(/\bescalationResult\(\s*\{\s*where:\s*['"`]([a-z][a-z0-9-]*)['"`]/g)) emitted.add(match[1])
  for (const match of source.matchAll(/\bescalate\(\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) {
    const object = new RegExp('export const ' + match[1] + ' = Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\)').exec(source)
    const member = object && new RegExp('\\b' + match[2] + ':\\s*' + QUOTE + '([a-z][a-z0-9-]*)' + QUOTE).exec(object[1])
    if (member) emitted.add(member[1])
  }
  return emitted
}

export function scanWhereLiterals(source) {
  const emitted = new Set()
  for (const match of source.matchAll(/\bwhere:/g)) {
    const rhs = stageRhs(source, match.index + match[0].length)
    for (const literal of rhs.matchAll(new RegExp(QUOTE + '([a-z][a-z0-9-]*)' + QUOTE, 'g'))) emitted.add(literal[1])
  }
  return emitted
}

const WHERE_FILES = ['crew/daemon.mjs', 'crew/child.mjs', 'crew/crew.mjs']

function readText(path) {
  const text = readFileSync(path, 'utf8')
  assert.ok(text.length > 0, `${path} is empty`)
  return text
}

// Mutation killed: adding a producer without a row reddens this equality, so the emitted driver set cannot drift undocumented.
test("escalations.md's driver table equals the escalate() producers", () => {
  const source = readFileSync(join(ROOT, DRIVE), 'utf8')
  const emitted = scanEscalates(source)
  for (const name of VARIANT_NAMES) if (name !== 'stepped') emitted.add(name)
  emitted.add('driver')
  // The underscore is load-bearing: VARIANT_NAMES are added to `emitted` verbatim,
  // and `review_only` (with `verify_only` to follow) is the first variant whose name
  // is not a single lowercase word. Without `_` here the doc side can never match its
  // row, so the equality is UNSATISFIABLE for such a variant rather than merely red.
  const prose = readText(join(HERE, 'references/escalations.md'))
  assert.doesNotMatch(prose, /escalate:plan-scope-widened/)
  assert.doesNotMatch(prose, /widening limit|held-scope.*refus|sibling-fence.*refus/i)
  const documented = new Set([...prose.matchAll(/^\|\s*`escalate:([a-z][a-z0-9_-]*)`\s*\|/gm)].map((match) => match[1]))
  assert.deepEqual([...documented].sort(), [...emitted].sort())
})

// Mutation killed: adding a producer without a row reddens this equality, so every transport err.stage reaches the crash table.
test("escalations.md's crash table equals the err.stage producers", () => {
  const emitted = new Set()
  for (const rel of STAGE_FILES) for (const stage of scanStages(readFileSync(join(ROOT, rel), 'utf8'))) emitted.add(stage)
  for (const rel of WHERE_FILES) for (const stage of scanWhereLiterals(readFileSync(join(ROOT, rel), 'utf8'))) if (stage !== 'driver') emitted.add(stage)
  emitted.add(SEAT_REFUSAL_STAGE)
  emitted.add(SEAT_DIED_STAGE)
  const text = readText(join(HERE, 'references/escalations.md'))
  const start = text.indexOf('## Crash stages')
  assert.notEqual(start, -1, 'escalations.md is missing the crash stages section')
  const documented = new Set([...text.slice(start).matchAll(/^\|\s*`([a-z][a-z0-9-]*)`\s*\|/gm)].map((match) => match[1]))
  assert.deepEqual([...documented].sort(), [...emitted].sort())
})

// MUTATION EX1: emptying the acp listing spread removes the ACP stages from the emitted set.
test('EX1 crash table documents the ACP stages the listed acp modules emit', () => {
  const emitted = new Set()
  for (const rel of STAGE_FILES) for (const stage of scanStages(readFileSync(join(ROOT, rel), 'utf8'))) emitted.add(stage)
  const text = readText(join(HERE, 'references/escalations.md'))
  const documented = new Set([...text.slice(text.indexOf('## Crash stages')).matchAll(/^\|\s*`([a-z][a-z0-9-]*)`\s*\|/gm)].map((m) => m[1]))
  for (const stage of ['acp-bin-unresolved', 'acp-launch-unsupported', 'acp-no-envelope', 'acp-parse-error', 'acp-session-busy', 'acp-steer-unsupported']) {
    assert.ok(emitted.has(stage), 'expected the scan to emit ' + stage + ', found it absent from ' + emitted.size + ' emitted stages')
    assert.ok(documented.has(stage), 'expected a crash-table row for ' + stage + ', found none among ' + documented.size + ' rows')
  }
})

// MUTATION EX2: keeping only the first literal of each right-hand side drops the ternary branches.
test('EX2 ternary stage assignment contributes every branch without a hand-written add', () => {
  const seatIo = scanStages(readFileSync(join(ROOT, 'crew/seat-io.mjs'), 'utf8'))
  for (const stage of ['acp-no-envelope', 'rpc-no-envelope', 'headless-no-envelope']) {
    assert.ok(seatIo.has(stage), 'expected the seat-io ternary scan to collect ' + stage + ', found: ' + [...seatIo].sort().join(','))
  }
  const handAdd = 'emitted.add(' + "'headless-no-envelope')"
  assert.equal(readFileSync(join(HERE, 'exhibits.test.mjs'), 'utf8').includes(handAdd), false)
})

// MUTATION EX3: adding the member name instead of its resolved value drops plan-scope-malformed.
test('EX3 driver table resolves the PLAN_SCOPE member escalate call', () => {
  const emitted = scanEscalates(readFileSync(join(ROOT, DRIVE), 'utf8'))
  assert.ok(emitted.has('plan-scope-malformed'), 'expected plan-scope-malformed in the emitted set, found: ' + [...emitted].sort().join(','))
  const prose = readText(join(HERE, 'references/escalations.md'))
  const row = prose.split('\n').find((line) => line.startsWith('| `escalate:plan-scope-malformed` |'))
  assert.ok(row, 'expected a driver-table row for escalate:plan-scope-malformed, found none')
})

// MUTATION EX4: dropping the (?!=) guard makes the equality fixture literal collectable.
test('EX4 scanStages collects plain and ternary producers and ignores an equality', () => {
  const fixture = [
    "error.stage = 'acp-fixture-new'",
    "x.stage = a ? 'acp-fixture-a' : 'acp-fixture-b'",
    "if (e.stage === 'acp-fixture-not') throw e",
  ].join('\n')
  assert.deepEqual([...scanStages(fixture)].sort(), ['acp-fixture-a', 'acp-fixture-b', 'acp-fixture-new'])
})

// Mutation killed: moving an instrument citation or weakening its source substring must redden the recovery pin.
test('every crew-recovery path:line anchor carries what the prose claims', () => {
  assertAnchorsPinned({ root: ROOT, skillDir: HERE, manifestPath: join(HERE, 'anchors.json'), minAnchors: 3 })
})

// Mutation killed: removing a routing row must orphan a recovery reference.
test('every reference file is routed from SKILL.md', () => {
  const skill = readText(join(HERE, 'SKILL.md'))
  for (const name of readdirSync(join(HERE, 'references')).sort()) {
    if (name.endsWith('.md') && statSync(join(HERE, 'references', name)).isFile()) {
      assert.ok(skill.includes(`references/${name}`), `SKILL.md must route references/${name}`)
    }
  }
})

// Mutation killed: a provider_failure kind added to or dropped from PROVIDER_FAILURE_KINDS without instruments.md (or the reverse) reddens this.
test('instruments.md names exactly the PROVIDER_FAILURE_KINDS closed set', () => {
  const lines = readText(join(HERE, 'references/instruments.md')).split('\n')
  const start = lines.findIndex((line) => /^\s*-\s.*`provider_failure`/.test(line))
  assert.ok(start >= 0, 'instruments.md must carry a provider_failure bullet')
  let end = start + 1
  while (end < lines.length && lines[end].trim() !== '' && !/^\s*-\s/.test(lines[end])) end += 1
  const bullet = lines.slice(start, end).join(' ')
  const set = [...bullet.matchAll(/`([^`]*\|[^`]*)`/g)].map((m) => m[1].split('|').map((member) => member.trim())).find((members) => members.includes('rate_limit'))
  assert.ok(set, 'the provider_failure bullet must carry the closed kind set')
  assert.deepEqual([...set].sort(), Object.values(PROVIDER_FAILURE_KINDS).sort())
})

// Mutation killed: dropping one measured case lets a known instrument failure become an operator rule.
test('the instruments checklist keeps each measured case', () => {
  const text = readText(join(HERE, 'references/instruments.md'))
  for (const token of ['the WRAPPER SHELL', 'lazily-opened', 'invented a field', 'sibling lane polluted', 'compound command', 'pid-tracking watcher', 'six alphanumerics', '${PIPESTATUS[0]}', 'alive now', 'load average', pin('function colourNeutralEnv(base = process.env)'), pin('builder: 2400, reviewer: 1800')]) {
    assert.ok(text.includes(token), `instruments.md must name ${token}`)
  }
})

// Mutation killed: dropping one retry exception or measured-ordering phrase must fail the liveness reference test.
test('liveness.md names the retry exception and keeps the measured ordering', () => {
  const text = readText(join(HERE, 'references/liveness.md'))
  for (const token of [
    'transcript mtime',
    'the spinner, which is worthless',
    'n=124,783, recorded as a snapshot',
    'docs/ledger-queries.md` line 183',
    'n=52,833 with 37 gaps over 900s',
    '#590',
    'provider retry loop',
    'transcript mtime cannot see',
    'the pane is authoritative',
    'status=retrying',
    '#659',
    "seat's `seat-retrying` / `seat-retry-cleared` journal rows",
    'headless lane cannot show this state and keeps reading `active`',
    'seat-stale` condition is retired only by measured growth or a completing envelope',
    'a budget that expired measured nothing',
    'no lane in argv',
    'zero pi seats by construction',
    'builder and the reviewer',
    'keyed on the checkout',
    'unknown',
    'never dead',
  ]) {
    assert.ok(text.includes(token), `liveness.md must name ${token}`)
  }
  assert.match(text, /recogniseProviderRetry[^\n]*crew\/seat-io\.mjs:\d+/)
  assert.match(text, /scripts\/factory\/crew-watch\.mjs:\d+/)
})

// Mutation killed: changing either half of the post-publish order must fail the closeout evidence test.
test('closeout keeps teardown last and verifies after it', () => {
  const text = readText(join(HERE, 'references/closeout.md'))
  for (const token of ['preserve → commit → prove → suite → push+PR → teardown', 'immediately after teardown', 'merged blob', 'diff every PR', 'references/lane-branches.md', 'gh pr reopen', '### Precondition: prove the tree QUIET first', 'two read']) {
    assert.ok(text.includes(token), `closeout.md must name ${token}`)
  }
  const quietAt = text.indexOf('### Precondition: prove the tree QUIET first')
  const copyAt = text.indexOf('cp -a')
  assert.ok(quietAt < copyAt, 'closeout precondition must precede preserve-by-copy')
  const reanchorAt = text.indexOf('## Rebase first, then re-anchor')
  assert.notEqual(reanchorAt, -1, 'closeout is missing the re-anchor section')
  const reanchor = text.slice(reanchorAt)
  for (const token of ['ADR-040', '--repair-all', 'main', 'after the wave merges']) {
    assert.ok(reanchor.includes(token), `re-anchor section must name ${token}`)
  }
  assert.equal(reanchor.includes('Re-anchor INTO the commit'), false)
  assert.equal(reanchor.includes('only the exhibits tests notice'), false)
})

// Mutation killed: removing the closeout entry point leaves recovery as a hand recipe.
test('recovery closeout routes through the measured command exactly once', () => {
  const text = readText(join(HERE, 'references/closeout.md'))
  const sectionAt = text.indexOf('## Recovery closeout — teardown first')
  assert.notEqual(sectionAt, -1, 'closeout.md is missing the recovery section')
  const nextAt = text.indexOf('\n## ', sectionAt + 1)
  const section = nextAt === -1 ? text.slice(sectionAt) : text.slice(sectionAt, nextAt)
  const command = 'node scripts/factory/closeout.mjs recover <lane>'
  assert.ok(section.includes(command), 'recovery section must name the closeout command')
  assert.equal([...text.matchAll(/node scripts\/factory\/closeout\.mjs recover <lane>/g)].length, 1)
})

// RV1-1 guard: restoring the false acceptance-gate claim must fail before post-merge repair is skipped.
test('RV1-1 closeout states the anchor-shift blind spot', () => {
  const text = readText(join(HERE, 'references/closeout.md'))
  const reanchorAt = text.indexOf('## Rebase first, then re-anchor')
  assert.notEqual(reanchorAt, -1, 'closeout is missing the re-anchor section')
  const reanchor = text.slice(reanchorAt)
  for (const token of [
    'A cited-file edit can shift anchors while every other signal stays green:',
    "acceptance gate and the edited file's own tests do not read pins",
    '`exhibits.test.mjs` is where a shift surfaces',
  ]) assert.ok(reanchor.includes(token), `closeout.md must state ${token}`)
  assert.equal(reanchor.includes("acceptance gate and the edited file's own tests detect it"), false)
})

// Mutation killed: restoring the archive scratch recipe or removing first preservation must fail the proof test.
test('mutation proof preserves first and mutates in a detached worktree', () => {
  const text = readText(join(HERE, 'references/mutation-proof.md'))
  for (const token of ['tree.patch', 'git worktree add --detach', 'references/vacuity.md', 'set -e', 'returns/d1.planner.json']) {
    assert.ok(text.includes(token), `mutation-proof.md must name ${token}`)
  }
  assert.equal(text.includes('git archive HEAD | tar -x'), false)
})

// Mutation killed: removing the bounded frozen-pin route from the existing suite row leaves the operator without its refusal contract.
test('H1 suite escalation documentation names the bounded frozen-pin repair', () => {
  const text = readText(join(HERE, 'references/escalations.md'))
  const sentence = 'Frozen inventory receives only its bounded data-only repair; identity, logic, unmeasured, and repeat cases remain terminal.'
  assert.equal(text.split(sentence).length - 1, 1)
  assert.match(text, /A named failing test path is recorded as context for the already-budgeted builder repair\./)
})

test('plan-chunks escalation names both producers and the --chunked remedy', () => {
  const text = readText(join(HERE, 'references/escalations.md'))
  const row = text.split('\n').find((line) => line.includes('escalate:plan-chunks'))
  assert.ok(row, 'escalations.md is missing the escalate:plan-chunks row')
  assert.ok(row.includes('validateChunks'), 'plan-chunks row must name the validateChunks producer')
  assert.ok(row.includes('chunk-without-chunked'), 'plan-chunks row must name the chunk-without-chunked producer')
  assert.ok(row.includes('--chunked'), 'plan-chunks row must name the --chunked remedy')
})

test('ES1', () => {
  // MUTATION ES1: replacing the escalationResult where-scan drops reversion and plan-scope-request.
  const source = readFileSync(join(ROOT, DRIVE), 'utf8')
  const emitted = scanEscalates(source)
  assert.ok(emitted.has('reversion'), 'expected reversion in the emitted set, found: ' + [...emitted].sort().join(','))
  assert.ok(emitted.has('plan-scope-request'), 'expected plan-scope-request in the emitted set, found: ' + [...emitted].sort().join(','))
  for (const name of VARIANT_NAMES) if (name !== 'stepped') emitted.add(name)
  emitted.add('driver')
  const prose = readText(join(HERE, 'references/escalations.md'))
  const documented = new Set([...prose.matchAll(/^\|\s*`escalate:([a-z][a-z0-9_-]*)`\s*\|/gm)].map((match) => match[1]))
  assert.deepEqual([...documented].sort(), [...emitted].sort())
})

test('ES2', () => {
  // MUTATION ES2: dropping crew/daemon.mjs from the where-scan file list loses signalled and spawn-error.
  const emitted = new Set()
  for (const rel of WHERE_FILES) for (const stage of scanWhereLiterals(readFileSync(join(ROOT, rel), 'utf8'))) if (stage !== 'driver') emitted.add(stage)
  for (const stage of ['signalled', 'spawn-error', 'child-preflight', 'resume']) {
    assert.ok(emitted.has(stage), 'expected the where-scan to emit ' + stage + ', found: ' + [...emitted].sort().join(','))
  }
  const text = readText(join(HERE, 'references/escalations.md'))
  const start = text.indexOf('## Crash stages')
  assert.notEqual(start, -1, 'escalations.md is missing the crash stages section')
  const documented = new Set([...text.slice(start).matchAll(/^\|\s*`([a-z][a-z0-9-]*)`\s*\|/gm)].map((match) => match[1]))
  for (const stage of ['signalled', 'spawn-error', 'child-preflight', 'resume']) {
    assert.ok(documented.has(stage), 'expected a crash-table row for ' + stage + ', found none among ' + documented.size + ' rows')
  }
  const full = new Set()
  for (const rel of STAGE_FILES) for (const stage of scanStages(readFileSync(join(ROOT, rel), 'utf8'))) full.add(stage)
  for (const stage of emitted) full.add(stage)
  full.add(SEAT_REFUSAL_STAGE)
  full.add(SEAT_DIED_STAGE)
  assert.deepEqual([...documented].sort(), [...full].sort())
})

test('ES3', () => {
  // MUTATION ES3: dropping the leading pipe of a driver-table row breaks contiguity.
  const prose = readText(join(HERE, 'references/escalations.md'))
  const lines = prose.split('\n')
  const header = '| Stage | Meaning | Operator\'s first move |'
  const start = lines.indexOf(header)
  assert.notEqual(start, -1, 'escalations.md is missing the driver table header')
  let last = -1
  lines.forEach((line, index) => { if (line.startsWith('| `escalate:')) last = index })
  assert.notEqual(last, -1, 'escalations.md has no driver-table rows')
  for (let index = start; index <= last; index += 1) {
    assert.ok(lines[index].startsWith('|'), 'driver table line ' + (index + 1) + ' must start with \'|\': ' + lines[index])
  }
})

test('SM6 closeout names the stacked merge-check before merging a wave', () => {
  // MUTATION SM6: removing the stacked merge-check line leaves wave merges without their measured gate.
  const text = readText(join(HERE, 'references/closeout.md'))
  const sectionAt = text.indexOf('## Normal closeout — teardown last')
  assert.notEqual(sectionAt, -1, 'closeout.md is missing the normal section')
  const nextAt = text.indexOf('\n## ', sectionAt + 1)
  const section = nextAt === -1 ? text.slice(sectionAt) : text.slice(sectionAt, nextAt)
  assert.ok(section.includes('node scripts/factory/closeout.mjs merge-check <laneA> <laneB>'), 'normal section must name the stacked merge-check')
})

test('MP1', () => {
  // MUTATION MP1: renaming DIFF_MUTATION_UNMEASURED_REASONS breaks the in-lane proof pin.
  const text = readText(join(HERE, 'references/mutation-proof.md'))
  assert.ok(text.includes('## Diff mutation proof (in-lane)'), 'mutation-proof.md is missing the Diff mutation proof (in-lane) section')
  for (const token of ['timed-out', 'run-timeout', 'baseline-red', 'DIFF_MUTATION_UNMEASURED_REASONS', 'diff_mutant_judgments']) {
    assert.ok(text.includes(token), 'mutation-proof.md must name ' + token)
  }
})
