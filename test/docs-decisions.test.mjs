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
  for (const needle of ['ref: main', '--checkout', '~/.crew', 'bin/crew.mjs']) {
    assert.ok(install.includes(needle), `Install misses ${needle}`)
  }
})

// MUTATION: restore the lane-root DEVTEAM_CREW_ROOT claim.
test('S4-3: Install ties DEVTEAM_CREW_ROOT to the visualizer, not the lane root', () => {
  const flat = docSection(readme, '## Install').replace(/\s+/g, ' ')
  assert.ok(flat.includes('`~/.crew`'))
  assert.doesNotMatch(flat, /`~\/\.crew`, or `DEVTEAM_CREW_ROOT`/)
  const hits = flat.split(/(?<=\.)\s/).filter(s => s.includes('DEVTEAM_CREW_ROOT'))
  assert.ok(hits.length > 0)
  for (const hit of hits) assert.ok(hit.includes('visualizer'))
})

// MUTATION: restore the roster UI sentence.
test('S4-4: README describes no roster UI for the catalog key', () => {
  assert.doesNotMatch(readme, /roster UI/i)
})

// MUTATION: remove the agents map entry.
test('S4-14: README map names every operator agent', () => {
  const names = readdirSync(join(ROOT, 'agents')).filter(n => n.endsWith('.md'))
  assert.ok(names.length)
  const map = docSection(readme, "## What's in this repo")
  for (const name of names) assert.ok(map.includes('`agents/' + name + '`'), name)
})

// MUTATION: remove the tech-lead from the seat description.
test('S4-12: CLAUDE.md names the tech-lead among the seats', () => {
  assert.match(docSection(claude, '## What this is'), /tech-lead/)
})

// MUTATION: remove the session-write exception.
test('D16: CLAUDE.md states the session-write exception', () => {
  const start = claude.indexOf('**Instrumentation is never load-bearing.**')
  assert.notEqual(start, -1)
  const bullet = claude.slice(start).split(/\n- |\n\n/)[0].replace(/\s+/g, ' ')
  for (const phrase of ['session-file write', 'fails the turn', 'skill proof', 'crew/lean.mjs']) assert.ok(bullet.includes(phrase), phrase)
})

// MUTATION: rename a knob in the README table.
test('D17: crew/README lists the env knobs the runtime reads', () => {
  for (const [name, file] of [
    ['CREW_READGATE_MAX_LINES', 'crew/pi/extensions/readgate.ts'],
    ['CREW_READGATE_MAX_BYTES', 'crew/pi/extensions/readgate.ts'],
    ['CREW_ACP_PERMISSION_TIMEOUT_MS', 'crew/pi/extensions/acp-server.ts'],
    ['CREW_ACP_BRIDGE_STARTUP_MS', 'crew/pi/acp-bridge.mjs'],
    ['CREW_MEMORY_DIR', 'crew/lean.mjs'],
  ]) {
    assert.ok(read(file).includes(name), name)
    assert.ok(crewReadme.includes('`' + name + '`'), name)
  }
})

// MUTATION: remove stable from the update refusal.
test('S1-21: crew/README says crew update refuses off stable', () => {
  assert.ok(read('bin/crew.mjs').includes("branch !== 'stable'"))
  assert.match(crewReadme.replace(/\s+/g, ' '), /`crew update` refuses[^.]*`stable`/)
})

// MUTATION: restore the reclaim lease and parks description.
test('S1-12: no live doc describes reclaim parks or leases', () => {
  assert.ok(!existsSync(join(ROOT, 'docs/park-lease-protocol.md')))
  const lines = crewReadme.split('\n')
  const index = lines.findIndex(line => line.startsWith('- `reclaim.mjs`'))
  assert.notEqual(index, -1)
  const block = [lines[index]]
  for (let i = index + 1; i < lines.length && /^\s+\S/.test(lines[i]); i++) block.push(lines[i])
  assert.doesNotMatch(block.join(' '), /park|lease/i)
  assert.doesNotMatch(read('docs/conventions.md').split('## Implementation files')[0], /park|lease/i)
})

// MUTATION: remove the superseded note.
test('S4-9: lean-runtime plan marks its deleted arms superseded', () => {
  const pre = read('docs/plan-lean-runtime.md').split('## Operator decisions')[0]
  assert.match(pre, /superseded/i)
  for (const name of ['codemode', 'lab', 'edit assist', 'claude-arms', 'lab-server']) assert.ok(pre.includes(name), name)
})

// MUTATION: restore roster edits in the example.
test('S4-10: lane-brief examples name no roster', () => {
  assert.doesNotMatch(read('skills/lane-brief/SKILL.md'), /roster/i)
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
