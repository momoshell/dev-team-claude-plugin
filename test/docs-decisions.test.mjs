// Documentation drift and release policy checks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'

const README = 'README.md'
const CREW_README = 'crew/README.md'
const CLAUDE = 'CLAUDE.md'

const read = (relativePath) => readFileSync(join(ROOT, relativePath), 'utf8')
const readme = read(README)
const crewReadme = read(CREW_README)
const claude = read(CLAUDE)
const onboardSkill = read('skills/crew-onboard/SKILL.md')
const marketplace = JSON.parse(read('.claude-plugin/marketplace.json'))

function docSection(markdown, heading) {
  const start = markdown.indexOf(heading)
  assert.notEqual(start, -1, `missing ${heading}`)
  const after = markdown.slice(start + heading.length)
  const next = after.indexOf('\n## ')
  return next === -1 ? markdown.slice(start) : markdown.slice(start, start + heading.length + next)
}

const VISUALIZER_COMMAND = 'npm run viz:build     # release-time check: operator runs it on main before tagging'
const VISUALIZER_POLICY = "`npm test` is the lane gate. `npm run viz:build` is a RELEASE-TIME check the\noperator runs on main before tagging; it is never a lane's done-means."
const OLD_VISUALIZER_COMMAND = 'npm run viz:build     # the visualizer must build; it is part of the release gate'
const OLD_VISUALIZER_POLICY = '`npm test` and `npm run viz:build` are the two release gates. Both must pass\nbefore anything lands.'

function visualizerGateErrors(markdown) {
  const errors = []
  if (!markdown.includes(VISUALIZER_COMMAND)) errors.push('missing corrected visualizer command')
  if (!markdown.includes(VISUALIZER_POLICY)) errors.push('missing corrected visualizer policy')
  if ((markdown.match(/viz:build/g) ?? []).length !== 2) errors.push('expected exactly two viz:build occurrences')
  if (markdown.includes('part of the release gate')) errors.push('contains the old release-gate command claim')
  if (markdown.includes('are the two release gates')) errors.push('contains the old release-gate paragraph claim')
  return errors
}

test('runtime feature map has concrete paths and pins ACP', () => {
  const heading = '## Runtime feature map'
  const start = crewReadme.indexOf(heading)
  assert.notEqual(start, -1, 'missing runtime feature map heading')
  const section = crewReadme.slice(start + heading.length).split('\n\n**The seats**', 1)[0]
  const lines = section.split('\n')
  assert.equal(lines[1], '| Feature | Where it lives | ADR | Doc |')
  assert.equal(lines[2], '|---|---|---|---|')
  const rows = lines.slice(3).filter((line) => line.startsWith('|') && line.endsWith('|'))
  assert.ok(rows.length >= 7, `expected at least 7 feature rows, got ${rows.length}`)

  for (const row of rows) {
    const paths = [...row.matchAll(/`([^`]+)`/g)].map(([, value]) => value).filter((value) => value.includes('/'))
    assert.ok(paths.length > 0, `feature row has no backticked repo path: ${row}`)
    for (const path of paths) {
      assert.ok(!/[!*?{}]/.test(path), `feature path must not be a glob: ${path}`)
      assert.ok(existsSync(join(ROOT, path)), `feature path does not exist: ${path}`)
    }
  }
  assert.ok(rows.some((row) => row.startsWith('| ACP |') && row.includes('`crew/acp-client.mjs`')))
})

test("A1/B1: visualizer build is a release-time check, not a lane gate", () => {
  assert.deepEqual(visualizerGateErrors(claude), [])

  const oldClaude = claude
    .replace(VISUALIZER_COMMAND, OLD_VISUALIZER_COMMAND)
    .replace(VISUALIZER_POLICY, OLD_VISUALIZER_POLICY)
  const oldErrors = visualizerGateErrors(oldClaude)
  assert.notDeepEqual(oldErrors, [])
})

test('OD3', () => {
  // MUTATION OD3: alter the marketplace-add command in README.md and the derived install line no longer matches.
  const installLine = `/plugin install ${marketplace.plugins[0].name}@${marketplace.name}`
  const installIdx = readme.indexOf('## Install')
  const whatsIdx = readme.indexOf("## What's in this repo")
  assert.notEqual(installIdx, -1, 'missing ## Install')
  assert.ok(whatsIdx !== -1 && installIdx < whatsIdx, 'Install must precede What is in this repo')
  const install = docSection(readme, '## Install')
  assert.ok(install.includes('/plugin marketplace add momoshell/dev-team-claude-plugin'))
  assert.ok(install.includes(installLine), `Install misses ${installLine}`)
})

test('OD4', () => {
  // MUTATION OD4: rename --checkout in README.md and the Install section no longer names the checkout flag.
  assert.equal(marketplace.plugins[0].source.ref, 'main')
  const install = docSection(readme, '## Install')
  for (const needle of ['ref: main', '--checkout', 'DEVTEAM_CREW_ROOT', 'bin/crew.mjs']) {
    assert.ok(install.includes(needle), `Install misses ${needle}`)
  }
})

test('RV1-1 ledger advisor-ab row escapes the placeholder pipe', () => {
  // MUTATION RV1-1: unescape <iso\|ms> to <iso|ms> in docs/archive/ledger-queries.md and the advisor-ab row splits into an extra table cell, hiding --adjudications and the dispatch ids.
  const docs = read('docs/archive/ledger-queries.md')
  const row = docs.split('\n').find((line) => line.startsWith('|') && line.includes('ledger.mjs advisor-ab'))
  assert.ok(row, 'missing advisor-ab row in docs/archive/ledger-queries.md')
  assert.ok(row.includes('--run-started-at <iso\\|ms>'), 'advisor-ab row must escape the placeholder pipe as <iso\\|ms>')
  const cells = row.split(/(?<!\\)\|/).slice(1, -1)
  assert.equal(cells.length, 2, 'advisor-ab row must render as two table cells')
  assert.ok(cells[1].includes('--adjudications'), 'advisor-ab command cell must keep --adjudications')
  assert.ok(cells[1].includes('<dispatch-id>...'), 'advisor-ab command cell must keep the dispatch ids')
})

test('OD5', () => {
  // MUTATION OD5: retarget README.md#install to README.md#setup in SKILL.md and the Installing link no longer reaches Install.
  const installing = docSection(onboardSkill, '## Installing')
  assert.ok(installing.includes('/plugin marketplace add momoshell/dev-team-claude-plugin'))
  assert.ok(installing.includes('/plugin install dev-team@dev-team'))
  assert.ok(installing.includes('README.md#install'))
})

test('RD3', () => {
  // MUTATION RD3: replacing keeps with drops hides the reseat drift.
  const line = crewReadme.split('\n').find((line) => line.includes('keeps a raw override'))
  assert.ok(line, 'missing reseat sentence')
  assert.ok(line.includes('exhausted'), 'reseat sentence must name exhausted')
})

test('RM1', () => {
  // MUTATION RM1: renaming a factory importer in the crew bullet hides the drift.
  const names = readdirSync(join(ROOT, 'crew')).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs') && !name.endsWith('-fixtures.mjs') && !name.endsWith('-test-helpers.mjs'))
  const derived = names.filter((name) => {
    const text = read(join('crew', name))
    return /from\s+['"]\.\.\/scripts\/factory\//.test(text) || /import\(['"]\.\.\/scripts\/factory\//.test(text)
  }).map((name) => name.replace(/\.mjs$/, '')).sort()
  assert.deepEqual(derived, [])
  for (const name of derived) {
    assert.ok(readme.includes('`crew/' + name + '.mjs`'), 'crew/ bullet must name crew/' + name + '.mjs')
  }
  assert.ok(readme.includes('hooks/skill-gate.mjs'), 'crew/ bullet must name hooks/skill-gate.mjs')
  assert.equal(readme.includes('three production modules'), false)
})

test('RM2', () => {
  // MUTATION RM2: renaming visualizer/ in What is in this repo hides the drift.
  const section = docSection(readme, "## What's in this repo")
  for (const token of ['`bin/crew.mjs`', '`hooks/`', '`visualizer/`']) {
    assert.ok(section.includes(token), "What's in this repo must name " + token)
  }
})

test('RM3', () => {
  // MUTATION RM3: renaming crew update in Install hides the operator-setup drift.
  const install = docSection(readme, '## Install')
  for (const token of ['crew update', 'dev-team-stable', 'link-mode']) {
    assert.ok(install.includes(token), 'Install must name ' + token)
  }
})
