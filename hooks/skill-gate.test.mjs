import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { scratchDir } from '../test/helpers.mjs'
import { matchGlob, loadMap, validateMap } from './skill-gate.mjs'

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
function invoke(dir, verb, input = {}, env = {}, spawnCwd = dir) {
  const childEnv = { ...process.env, DEV_TEAM_SKILL_GATE_STATE: join(dir, 'state'), ...env }
  delete childEnv.DEVTEAM_WORKER
  delete childEnv.DEV_TEAM_SKILL_GATE
  Object.assign(childEnv, env)
  return spawnSync(process.execPath, [join(dir, SCRIPT), verb], {
    cwd: spawnCwd, encoding: 'utf8', input: JSON.stringify({ session_id: 's1', cwd: dir, tool_input: { file_path: 'crew/drive.mjs' }, ...input }),
    env: childEnv,
  })
}
function deny(result) { assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny') }
function post(dir, skills, agent_id = 'a') { for (const skill of skills) invoke(dir, 'post-skill', { agent_id, tool_input: { skill } }) }
function transcript(dir, rows, path = 'transcript.jsonl') { const file = join(dir, path); writeFileSync(file, rows.map((x) => JSON.stringify(x)).join('\n')); return file }
const call = (skill) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] } })

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
test('RP2 slice satisfies the edit gate via its parent skill', () => {
  // MUTATION: restore result.add(skill) so the slice never maps to its parent and the seat stays denied.
  const dir = fixture()
  mkdirSync(join(dir, 'skills', 'alpha', 'references'), { recursive: true })
  writeFileSync(join(dir, 'skills', 'alpha', 'references', 'ref.md'), '# ref\n')
  writeMap(dir, { version: 1, exempt: ['**/anchors.json', 'docs/audits/**'], rules: [{ when: { paths: ['crew/**/*.mjs'] }, skills: ['dev-team:alpha#ref'] }] })
  const denied = invoke(dir, 'pre-edit')
  deny(denied)
  assert.match(denied.stdout, /dev-team:alpha/)
  assert.doesNotMatch(denied.stdout, /#ref/)
  post(dir, ['dev-team:alpha'])
  const allowed = invoke(dir, 'pre-edit', { agent_id: 'a' })
  assert.equal(allowed.status, 0)
  assert.equal(allowed.stdout, '')
})
test('RP3 M1 shipped role packs pin exactly and session start is byte-identical', () => {
  // MUTATION: flip rule 5 of skills/skill-map.json from grant to inline and the shipped-map pin fails.
  const dir = fixture()
  const result = invoke(dir, 'session-start', {}, {}, ROOT)
  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(readFileSync(join(ROOT, MAP_PATH), 'utf8')), { version: 1, exempt: ['**/anchors.json', 'docs/audits/**'], rules: [
    { when: { roles: ['planner'] }, delivery: 'inline', skills: ['dev-team:qa-test-writing#gates'] },
    { when: { roles: ['builder'] }, delivery: 'inline', skills: ['dev-team:code-less', 'dev-team:qa-test-writing#vacuity'] },
    { when: { roles: ['reviewer'] }, delivery: 'inline', skills: ['dev-team:pr-review'] },
    { when: { roles: ['tech-lead'] }, delivery: 'inline', skills: ['dev-team:pr-review#falsification'] },
    { when: { roles: ['reviewer'] }, delivery: 'grant', skills: ['dev-team:code-less', 'dev-team:qa-test-writing#vacuity'] },
    { when: { roles: ['tech-lead'] }, delivery: 'grant', skills: ['dev-team:qa-test-writing#gates'] },
    { when: { paths: ['crew/**/*.mjs', 'crew/**/*.ts', 'scripts/**/*.mjs', 'hooks/**/*.mjs', 'test/**/*.mjs', 'skills/**/*.mjs', 'visualizer/**/*.mjs', 'visualizer/**/*.js', 'visualizer/**/*.svelte'], roles: ['builder', 'reviewer'] }, skills: ['dev-team:code-less'] },
    { when: { paths: ['crew/**/*.mjs', 'crew/**/*.ts', 'scripts/**/*.mjs', 'hooks/**/*.mjs'], roles: ['builder', 'reviewer'] }, skills: ['dev-team:backend-node'] },
    { when: { paths: ['**/*.test.mjs'], roles: ['builder', 'reviewer'] }, skills: ['dev-team:qa-test-writing'] },
    { when: { paths: ['visualizer/**/*.svelte', 'visualizer/**/*.js', 'visualizer/**/*.mjs', 'visualizer/**/*.css'], roles: ['planner', 'builder', 'reviewer'] }, skills: ['dev-team:frontend-svelte'] },
    { when: { paths: ['visualizer/**/*.svelte', 'visualizer/**/*.css'], roles: ['planner', 'builder', 'reviewer'] }, skills: ['dev-team:ui-design', 'dev-team:ux'] },
  ] })
  assert.equal(loadMap(ROOT).ok, true)
  assert.equal(
    JSON.parse(result.stdout).hookSpecificOutput.additionalContext,
    'crew/**/*.mjs, crew/**/*.ts, scripts/**/*.mjs, hooks/**/*.mjs, test/**/*.mjs, skills/**/*.mjs, visualizer/**/*.mjs, visualizer/**/*.js, visualizer/**/*.svelte \u2192 dev-team:code-less\ncrew/**/*.mjs, crew/**/*.ts, scripts/**/*.mjs, hooks/**/*.mjs \u2192 dev-team:backend-node\n**/*.test.mjs \u2192 dev-team:qa-test-writing\nvisualizer/**/*.svelte, visualizer/**/*.js, visualizer/**/*.mjs, visualizer/**/*.css \u2192 dev-team:frontend-svelte\nvisualizer/**/*.svelte, visualizer/**/*.css \u2192 dev-team:ui-design, dev-team:ux\nLoading a skill is not applying it: walk each change against the loaded skill.\nDisable with DEV_TEAM_SKILL_GATE=off.'
  )
})
test('M2', () => {
  const dir = fixture(); writeMap(dir, { ...JSON.parse(readFileSync(join(dir, MAP_PATH))), surprise: true })
  const result = invoke(dir, 'pre-edit')
  assert.equal(result.status, 1); assert.equal(result.stderr.trim(), 'skill-gate: map-schema'); assert.equal(result.stdout, '')
})
test('G1', () => {
  assert.equal(matchGlob('crew/**/*.mjs', 'crew/drive.mjs'), true)
  assert.equal(matchGlob('crew/**/*.mjs', 'crew/pi/extensions/x.mjs'), true)
  assert.equal(matchGlob('crew/**/*.mjs', 'crewx/a.mjs'), false)
  assert.equal(matchGlob('crew/**/*.mjs', 'crew/a.md'), false)
})
test('D1', () => { const dir = fixture(); const r = invoke(dir, 'pre-edit'); deny(r); assert.match(r.stdout, /dev-team:backend-node/); assert.match(r.stdout, /dev-team:code-less/) })
test('D2', () => { const dir = fixture(); post(dir, ['dev-team:code-less', 'dev-team:backend-node']); const r = invoke(dir, 'pre-edit', { agent_id: 'a' }); assert.equal(r.status, 0); assert.equal(r.stdout, '') })
test('RV2-1 post-skill records from unmapped cwd', () => {
  const dir = fixture()
  const outside = scratchDir('unmapped-session-')
  for (const skill of ['dev-team:code-less', 'dev-team:backend-node']) {
    invoke(dir, 'post-skill', { cwd: outside, agent_id: 'b', tool_input: { skill } }, {}, outside)
  }
  const mappedEdit = invoke(dir, 'pre-edit', { agent_id: 'b' })
  assert.equal(mappedEdit.status, 0); assert.equal(mappedEdit.stdout, '')
})
test('D3', () => { const dir = fixture(); post(dir, ['dev-team:code-less', 'dev-team:backend-node']); const r = invoke(dir, 'pre-edit', { agent_id: 'a', tool_input: { file_path: 'crew/x.test.mjs' } }); deny(r); assert.match(r.stdout, /dev-team:qa-test-writing/); assert.doesNotMatch(r.stdout, /dev-team:backend-node/) })
test('A1', () => { const dir = fixture(); post(dir, ['dev-team:code-less', 'dev-team:backend-node'], 'X'); deny(invoke(dir, 'pre-edit', { agent_id: 'Y' })); deny(invoke(dir, 'pre-edit', { agent_id: undefined })) })
test('T1', () => {
  const dir = fixture()
  const file = transcript(dir, [call('dev-team:code-less'), call('dev-team:backend-node')])
  assert.equal(invoke(dir, 'pre-edit', { transcript_path: file }).stdout, '')
  const sidecar = join(dir, 's1', 'subagents', 'agent-a1.jsonl')
  mkdirSync(join(dir, 's1', 'subagents'), { recursive: true })
  writeFileSync(sidecar, [call('dev-team:code-less'), call('dev-team:backend-node')].map((row) => JSON.stringify({ ...row, agentId: 'a1' })).join('\n'))
  const subagentTranscript = transcript(dir, [])
  const r = invoke(dir, 'pre-edit', { agent_id: 'a1', transcript_path: subagentTranscript })
  assert.equal(r.stdout, '')
})
test('T2', () => { const dir = fixture(); const file = transcript(dir, [{ type: 'tool_schema', name: 'Skill', text: 'dev-team:code-less dev-team:backend-node' }]); deny(invoke(dir, 'pre-edit', { transcript_path: file })) })
test('X1', () => { const dir = fixture(); writeMap(dir, { version: 1, exempt: ['**/anchors.json'], rules: [{ when: { paths: ['**'] }, skills: ['dev-team:code-less'] }] }); const r = invoke(dir, 'pre-edit', { tool_input: { file_path: 'crew/roles/anchors.json' } }); assert.equal(r.stdout, '') })
test('I1', () => { const dir = fixture(); const r = invoke(dir, 'pre-edit', {}, { DEVTEAM_WORKER: '1' }); assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '') })
test('I2', () => {
  const dir = scratchDir('foreign-')
  mkdirSync(join(dir, 'hooks'), { recursive: true })
  writeFileSync(join(dir, SCRIPT), readFileSync(join(ROOT, SCRIPT)))
  for (const id of ids) { mkdirSync(join(dir, 'skills', id), { recursive: true }); writeFileSync(join(dir, 'skills', id, 'SKILL.md'), '# fixture') }
  const r = invoke(dir, 'pre-edit')
  assert.equal(r.status, 0); assert.equal(r.stdout, '')
})
test('I3', () => { const dir = fixture(); const r = invoke(dir, 'pre-edit', {}, { DEV_TEAM_SKILL_GATE: 'off' }); assert.equal(r.status, 0); assert.equal(r.stdout, '') })
test('U1', () => { const dir = fixture(); writeFileSync(join(dir, MAP_PATH), '{'); const r = invoke(dir, 'pre-edit'); assert.equal(r.status, 1); assert.equal(r.stderr.trim(), 'skill-gate: map-unparseable'); assert.equal(r.stdout, '') })
test('N1', () => { const dir = fixture(); const results = [invoke(dir, 'pre-edit'), invoke(dir, 'session-start')]; for (const r of results) assert.doesNotMatch(r.stdout, /allow/) })
test('S1', () => { const dir = fixture(); const r = invoke(dir, 'session-start'); const out = JSON.parse(r.stdout).hookSpecificOutput; assert.equal(out.hookEventName, 'SessionStart'); assert.ok(out.additionalContext.length <= 10000); for (const id of ids) assert.ok(out.additionalContext.includes(`dev-team:${id}`)) })
test('H1', () => { const hooks = JSON.parse(readFileSync(join(ROOT, MANIFEST))); const h = hooks.hooks; assert.equal(h.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit'); assert.equal(h.PostToolUse[0].matcher, 'Skill'); for (const [event, verb] of [['SessionStart','session-start'],['PreToolUse','pre-edit'],['PostToolUse','post-skill']]) assert.equal(h[event][0].hooks[0].command, `node "\u0024{CLAUDE_PLUGIN_ROOT}/hooks/skill-gate.mjs" ${verb}`) })
test('Z1', () => { const source = readFileSync(join(ROOT, SCRIPT), 'utf8'); for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) assert.ok(match[1].startsWith('node:')) })
