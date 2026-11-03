import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { scratchDir } from '../test/helpers.mjs'
import { matchGlob, loadMap, validateMap, resolveSeatSkills } from './skill-gate.mjs'
import * as gate from './skill-gate.mjs'

const SCRIPT = 'hooks/skill-gate.mjs'
const MANIFEST = 'hooks/hooks.json'
const MAP_PATH = 'skills/skill-map.json'
const ROOT = new URL('..', import.meta.url).pathname
const ids = ['code-less', 'backend-node', 'qa-test-writing', 'frontend-svelte', 'ui-design', 'ux']
const pathRules = [
  { when: { paths: ['crew/**/*.mjs', 'crew/**/*.ts', 'scripts/**/*.mjs', 'hooks/**/*.mjs', 'test/**/*.mjs', 'skills/**/*.mjs', 'visualizer/**/*.mjs', 'visualizer/**/*.js', 'visualizer/**/*.svelte'] }, skills: ['dev-team:code-less'] },
  { when: { paths: ['crew/**/*.mjs', 'crew/**/*.ts', 'scripts/**/*.mjs', 'hooks/**/*.mjs'], roles: ['builder', 'reviewer'] }, skills: ['dev-team:backend-node'] },
  { when: { paths: ['**/*.test.mjs'], roles: ['planner', 'builder', 'reviewer', 'tech-lead'] }, skills: ['dev-team:qa-test-writing'] },
  { when: { paths: ['visualizer/**/*.svelte', 'visualizer/**/*.js', 'visualizer/**/*.mjs', 'visualizer/**/*.css'], roles: ['planner', 'builder', 'reviewer'] }, skills: ['dev-team:frontend-svelte'] },
  { when: { paths: ['visualizer/**/*.svelte', 'visualizer/**/*.css'], roles: ['planner', 'builder', 'reviewer'] }, skills: ['dev-team:ui-design', 'dev-team:ux'] },
]
function fixture() {
  const dir = scratchDir('skill-gate-')
  mkdirSync(join(dir, 'hooks'), { recursive: true })
  mkdirSync(join(dir, 'skills'), { recursive: true })
  writeFileSync(join(dir, SCRIPT), readFileSync(join(ROOT, SCRIPT)))
  writeFileSync(join(dir, MANIFEST), readFileSync(join(ROOT, MANIFEST)))
  for (const id of ids) { mkdirSync(join(dir, 'skills', id), { recursive: true }); writeFileSync(join(dir, 'skills', id, 'SKILL.md'), '# fixture') }
  writeMap(dir)
  return dir
}
function writeMap(dir, map = { version: 1, exempt: ['**/anchors.json', 'docs/audits/**'], rules: pathRules }) {
  writeFileSync(join(dir, MAP_PATH), JSON.stringify(map))
}
// MUTATION: restore the direct-run line.
test('skill-gate is a selector module with no hook entry point', () => {
  for (const name of ['main', 'scanTranscript', 'requiredSkills', 'reachableSeatSkills']) assert.equal(name in gate, false)
  const env = { ...process.env }
  delete env.DEVTEAM_WORKER
  delete env.DEV_TEAM_SKILL_GATE
  const result = spawnSync(process.execPath, ['hooks/skill-gate.mjs', 'pre-edit'], { cwd: ROOT, input: 'x', env, encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('RP1 strict delivery and slice references validate', () => {
  // MUTATION: break SKILL_ENTRY_RE so dev-team:alpha#ref is refused even with its reference file present.
  const dir = scratchDir('skill-gate-rp1-')
  mkdirSync(join(dir, 'skills', 'alpha', 'references'), { recursive: true })
  writeFileSync(join(dir, 'skills', 'alpha', 'references', 'ref.md'), '# ref\n')
  const good = { version: 1, exempt: ['docs/**'], rules: [{ when: { roles: ['builder'] }, delivery: 'inline', skills: ['dev-team:alpha#ref'] }] }
  assert.equal(validateMap(good, dir, { requireSkillFiles: true }), true)
  assert.equal(validateMap({ version: 1, exempt: ['docs/**'], rules: [{ when: { roles: ['builder'] }, delivery: 'eager', skills: ['dev-team:alpha#ref'] }] }, dir, { requireSkillFiles: true }), false)
  assert.equal(validateMap({ version: 1, exempt: ['docs/**'], rules: [{ when: { roles: ['builder'] }, delivery: 'inline', skills: ['dev-team:alpha#ref'], surprise: true }] }, dir, { requireSkillFiles: true }), false)
  assert.equal(validateMap({ version: 1, exempt: ['docs/**'], rules: [{ when: { roles: ['builder'] }, delivery: 'inline', skills: ['dev-team:alpha#missing'] }] }, dir, { requireSkillFiles: true }), false)
  assert.equal(validateMap({ version: 1, exempt: ['docs/**'], rules: [{ when: { roles: ['builder'] }, delivery: 'inline', skills: ['dev-team:alpha#missing'] }] }, dir, { requireSkillFiles: false }), true)
})
test('RP3 M1 shipped role packs pin exactly', () => {
  // MUTATION: flip the prose-plain rule's delivery from grant to inline.
  assert.deepEqual(JSON.parse(readFileSync(join(ROOT, MAP_PATH), 'utf8')), { version: 1, exempt: ['docs/audits/**'], rules: [
    { when: { roles: ['reviewer', 'tech-lead'] }, delivery: 'inline', skills: ['dev-team:pr-review'] },
    { when: { paths: ['**/*.mjs', '**/*.js', '**/*.ts', '**/*.tsx', '**/*.rs', '**/*.py', '**/*.svelte'], roles: ['builder', 'reviewer', 'tech-lead'] }, skills: ['dev-team:code-less'] },
    { when: { paths: ['crew/**/*.mjs', 'crew/**/*.ts', 'scripts/**/*.mjs', 'hooks/**/*.mjs'], roles: ['builder', 'reviewer', 'tech-lead'] }, skills: ['dev-team:backend-node'] },
    { when: { paths: ['visualizer/**/*.js', 'visualizer/**/*.mjs', 'visualizer/**/*.css'], roles: ['builder', 'reviewer', 'tech-lead'] }, skills: ['dev-team:frontend-svelte'] },
    { when: { paths: ['visualizer/**/*.css'], roles: ['builder', 'reviewer', 'tech-lead'] }, skills: ['dev-team:ui-design', 'dev-team:ux'] },
    { when: { paths: ['docs/**/*.md', 'skills/**/*.md', 'crew/agents/*.md'], roles: ['builder', 'reviewer', 'tech-lead'] }, delivery: 'grant', skills: ['dev-team:prose-plain'] },
    { when: { paths: ['**/*.test.*', '**/*.spec.*', '**/tests/**/*.rs', '**/*_test.*'], roles: ['builder'] }, skills: ['dev-team:test-economy'] },
    { when: { paths: ['**/*.test.*', '**/*.spec.*', '**/tests/**/*.rs', '**/*_test.*'], roles: ['reviewer', 'tech-lead'] }, skills: ['dev-team:test-strength'] },
    { when: { paths: ['**/*.svelte'], roles: ['builder', 'reviewer', 'tech-lead'] }, skills: ['dev-team:frontend-svelte', 'dev-team:ui-design', 'dev-team:ux'] },
  ] })
  assert.equal(loadMap(ROOT).ok, true)
})
// MUTATION: restore a second Svelte-specific frontend grant.
test('SM1: one skill-map rule grants the Svelte skills', () => {
  const { map } = loadMap(ROOT)
  const rules = map.rules.filter(rule => rule.when.paths?.some(path => path.endsWith('.svelte')) && rule.skills.includes('dev-team:frontend-svelte'))
  assert.equal(rules.length, 1)
  for (const file of ['visualizer/web/src/App.svelte', 'web/App.svelte']) {
    for (const [role, expected] of [
      ['builder', ['code-less', 'frontend-svelte', 'prose-plain', 'test-economy', 'ui-design', 'ux']],
      ['reviewer', ['code-less', 'frontend-svelte', 'pr-review', 'prose-plain', 'test-strength', 'ui-design', 'ux']],
    ]) {
      const skills = resolveSeatSkills({ map, role, files: [file, 'docs/x.md', 'test/x.test.mjs'] }).skills
      assert.deepEqual(skills.map(path => path.split('/')[1]).sort(), expected)
    }
  }
})

// MUTATION: add dev-team:code-less to the reviewer's pr-review role rule.
test('SF1: builder and reviewer get no role-only skill but pr-review', () => {
  const { map } = loadMap(ROOT)
  const skills = (role, files) => resolveSeatSkills({ map, role, files }).skills
  assert.deepEqual(skills('builder', []), [])
  assert.deepEqual(skills('reviewer', []), ['skills/pr-review/SKILL.md'])
  assert.deepEqual(skills('builder', ['docs/x.md']), ['skills/prose-plain/SKILL.md'])
  assert.deepEqual(skills('reviewer', ['docs/x.md']).sort(), ['skills/pr-review/SKILL.md', 'skills/prose-plain/SKILL.md'])
})

// MUTATION: narrow "**/*.py" to "pkg/*.py".
test('SF2: code-less follows source files in any layout', () => {
  const { map } = loadMap(ROOT)
  for (const role of ['builder', 'reviewer']) {
    for (const file of ['src/a.mjs', 'lib/a.js', 'app/a.ts', 'ui/a.tsx', 'src/main.rs', 'a.py', 'pkg/a.py', 'web/App.svelte']) {
      const entries = resolveSeatSkills({ map, role, files: [file] }).entries
      assert.ok(entries.some((entry) => entry.path === 'skills/code-less/SKILL.md' && entry.selected_by === 'map-path'), `${role} ${file}`)
    }
    for (const file of ['docs/x.md', 'docs/audits/a.ts']) {
      assert.ok(!resolveSeatSkills({ map, role, files: [file] }).skills.includes('skills/code-less/SKILL.md'), `${role} ${file}`)
    }
  }
})

// MUTATION: remove the generic testing paths from the shipped map.
test('LG3: generic file types select whole skills in any layout', () => {
  const { map } = loadMap(ROOT)
  for (const [role, skill] of [['builder', 'test-economy'], ['reviewer', 'test-strength']]) {
    for (const file of ['a.test.ts', 'pkg/a.test.js', 'nested/a.test.mjs', 'a.spec.js', 'pkg/a.spec.mjs', 'a.spec.ts', 'tests/a.rs', 'crates/x/tests/deep/a.rs', 'a_test.go', 'pkg/a_test.go', 'a_test.rs', 'pkg/a_test.rs']) {
      const entries = resolveSeatSkills({ map, role, files: [file] }).entries
      assert.ok(entries.some((entry) => entry.path === `skills/${skill}/SKILL.md` && entry.selected_by === 'map-path'), file)
      assert.ok(!entries.some((entry) => entry.path === 'skills/qa-test-writing/SKILL.md'), file)
    }
    for (const file of ['App.svelte', 'ui/components/App.svelte']) {
      const skills = resolveSeatSkills({ map, role, files: [file] }).skills
      for (const skill of ['frontend-svelte', 'ui-design', 'ux']) assert.ok(skills.includes(`skills/${skill}/SKILL.md`), file)
    }
    for (const file of ['other/a.ts', 'docs/audits/a.test.ts']) {
      assert.ok(!resolveSeatSkills({ map, role, files: [file] }).skills.includes(`skills/${skill}/SKILL.md`), file)
    }
  }
  assert.ok(resolveSeatSkills({ map, role: 'builder', files: ['crew/a.mjs'] }).skills.includes('skills/backend-node/SKILL.md'))
})
// MUTATION: add planner or dev-team:qa-test-writing to a shipped rule.
test('SK3 and SK4: no qa-test-writing or planner grants', () => {
  const { map } = loadMap(ROOT)
  for (const rule of map.rules) {
    assert.ok(!rule.when.roles?.includes('planner'))
    assert.ok(!rule.skills.some((skill) => skill.replace(/^dev-team:/, '').split('#')[0] === 'qa-test-writing'))
  }
})
test('M2 loadMap refuses a map with an unknown key', () => {
  const dir = fixture(); writeMap(dir, { ...JSON.parse(readFileSync(join(dir, MAP_PATH))), surprise: true })
  assert.deepEqual(loadMap(dir), { ok: false, reason: 'map-schema' })
})
test('G1', () => {
  assert.equal(matchGlob('crew/**/*.mjs', 'crew/lean.mjs'), true)
  assert.equal(matchGlob('crew/**/*.mjs', 'crew/acp/seat.mjs'), true)
  assert.equal(matchGlob('crew/**/*.mjs', 'crewx/a.mjs'), false)
  assert.equal(matchGlob('crew/**/*.mjs', 'crew/README.md'), false)
})
test('U1 loadMap refuses an unparseable map', () => { const dir = fixture(); writeFileSync(join(dir, MAP_PATH), '{'); assert.deepEqual(loadMap(dir), { ok: false, reason: 'map-unparseable' }) })
// MUTATION GH1: restore the PreToolUse entry in hooks/hooks.json and the zero-keys assertion reddens.
test('GH1', () => { const hooks = JSON.parse(readFileSync(join(ROOT, MANIFEST), 'utf8')); assert.equal(typeof hooks.hooks, 'object'); assert.notEqual(hooks.hooks, null); assert.equal(Array.isArray(hooks.hooks), false); assert.deepEqual(Object.keys(hooks.hooks), []) })
// MUTATION GH2: delete the README sentence 'The plugin registers no hooks.' and the docs assertions redden.
test('GH2', () => { const adr = readFileSync(join(ROOT, 'docs/adr/adr-050-seat-skills-are-granted-not-pasted.md'), 'utf8'); const readme = readFileSync(join(ROOT, 'README.md'), 'utf8'); const index = readFileSync(join(ROOT, 'docs/adr/README.md'), 'utf8'); const flat = (s) => s.replace(/\s+/g, ' '); assert.ok(adr.split('\n').includes('## Operator decisions (2026-10-17)')); assert.ok(adr.indexOf('## Operator decisions (2026-10-17)') > adr.indexOf('## Operator decisions (2026-10-16)')); for (const phrase of ['The plugin registers no Claude Code hook.', 'The operator session is never gated.', 'Seats receive skills through role packs (inline) and native grants.', 'Any claude-seat enforcement under section 5 needs a new seat-scoped mechanism.']) assert.ok(flat(adr).includes(phrase), phrase); assert.ok(flat(readme).includes('The plugin registers no hooks.')); assert.ok(flat(index).includes('amended 2026-10-17 (the plugin registers no Claude Code hook)')) })
test('Z1', () => { const source = readFileSync(join(ROOT, SCRIPT), 'utf8'); for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) assert.ok(match[1].startsWith('node:')) })
