import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from '../../test/helpers.mjs'
import { PLAN_SCOPE } from '../../crew/drive.mjs'
import { SEAT_DIED_STAGE, SEAT_REFUSAL_STAGE } from '../../crew/seat-io.mjs'
import { VARIANT_NAMES } from '../../crew/variants.mjs'
import { assertAnchorsPinned } from '../qa-test-writing/anchor-pin.mjs'

const HERE = fileURLToPath(new URL('./', import.meta.url))
const DRIVE = 'crew/drive.mjs'
const STAGE_FILES = [DRIVE, 'crew/seat-io.mjs', 'crew/headless.mjs', 'crew/headless-rpc.mjs', 'crew/child.mjs', 'crew/reclaim.mjs', 'crew/daemon.mjs']
const QUOTE = "['\"`]"

function readText(path) {
  const text = readFileSync(path, 'utf8')
  assert.ok(text.length > 0, `${path} is empty`)
  return text
}

// Mutation killed: adding a producer without a row reddens this equality, so the emitted driver set cannot drift undocumented.
test("escalations.md's driver table equals the escalate() producers", () => {
  const source = readFileSync(join(ROOT, DRIVE), 'utf8')
  const emitted = new Set()
  for (const match of source.matchAll(new RegExp(`\\bescalate\\(\\s*${QUOTE}([a-z][a-z0-9-]*)${QUOTE}`, 'g'))) emitted.add(match[1])
  for (const name of VARIANT_NAMES) emitted.add(name)
  emitted.add(PLAN_SCOPE.widened)
  emitted.add('driver')
  const documented = new Set([...readText(join(HERE, 'references/escalations.md')).matchAll(/^\|\s*`escalate:([a-z][a-z0-9-]*)`\s*\|/gm)].map((match) => match[1]))
  assert.deepEqual([...documented].sort(), [...emitted].sort())
})

// Mutation killed: adding a producer without a row reddens this equality, so every transport err.stage reaches the crash table.
test("escalations.md's crash table equals the err.stage producers", () => {
  const emitted = new Set()
  for (const rel of STAGE_FILES) {
    const source = readFileSync(join(ROOT, rel), 'utf8')
    for (const pattern of [
      `\\.stage\\s*=\\s*${QUOTE}([a-z][a-z0-9-]*)${QUOTE}`,
      `\\bstage:\\s*${QUOTE}([a-z][a-z0-9-]*)${QUOTE}`,
      `\\bstaged\\(\\s*${QUOTE}([a-z][a-z0-9-]*)${QUOTE}`,
      `\\bfail\\(\\s*${QUOTE}([a-z][a-z0-9-]*)${QUOTE}`,
    ]) for (const match of source.matchAll(new RegExp(pattern, 'g'))) emitted.add(match[1])
  }
  emitted.add(SEAT_REFUSAL_STAGE)
  emitted.add(SEAT_DIED_STAGE)
  emitted.add('headless-no-envelope')
  const text = readText(join(HERE, 'references/escalations.md'))
  const start = text.indexOf('## Crash stages')
  assert.notEqual(start, -1, 'escalations.md is missing the crash stages section')
  const documented = new Set([...text.slice(start).matchAll(/^\|\s*`([a-z][a-z0-9-]*)`\s*\|/gm)].map((match) => match[1]))
  assert.deepEqual([...documented].sort(), [...emitted].sort())
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

// Mutation killed: dropping one measured case lets a known instrument failure become an operator rule.
test('the instruments checklist keeps each measured case', () => {
  const text = readText(join(HERE, 'references/instruments.md'))
  for (const token of ['the WRAPPER SHELL', 'lazily-opened', 'invented a field', 'sibling lane polluted', 'compound command', 'pid-tracking watcher', 'six alphanumerics', '${PIPESTATUS[0]}', 'alive now', 'load average', 'scripts/factory/make-brief.mjs:783', 'crew/drive.mjs:52']) {
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
