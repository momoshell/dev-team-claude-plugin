import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proveRequiredSkills } from './skills-proof.mjs'

const row = (update) => JSON.stringify({ sessionId: 's', update })
const call = (id, title, kind, rawInput = {}, claude = false) => row({ sessionUpdate: 'tool_call', toolCallId: id, title, kind, status: 'in_progress', rawInput, ...(claude ? { _meta: { claudeCode: { toolName: title } } } : {}) })
const update = (id, status) => row({ sessionUpdate: 'tool_call_update', toolCallId: id, status })
// A load is a call plus its completion row; the proof counts a read only once it has completed.
const done = (id) => update(id, 'completed')
const piLoad = (skill = 'alpha', id = `r-${skill}`) => `${call(id, 'read', 'read', { path: `/c/skills/${skill}/SKILL.md` })}\n${done(id)}`
const skill = (name, id = `s-${name}`) => `${call(id, 'Skill', 'other', { skill: name }, true)}\n${done(id)}`
const write = (id = 'w') => call(id, 'write', 'edit', { path: '/c/a.mjs' })
const shell = () => call('sh', 'bash', 'execute', { command: 'pwd' })
const prove = (rows, definition = { requires: ['alpha'], writes: 'task-dir' }) =>
  proveRequiredSkills({ definition, sessionFile: 'x.jsonl', skillsRoot: '/c/skills', readFile: async () => ['{"type":"prompt"}', ...rows].join('\n') })

// MUTATION: count a load that follows the first write and SK2 passes.
test('a load before the first write proves; a load after it, or none, does not', async () => {
  assert.equal(await prove([piLoad(), write()]), null)
  assert.equal(await prove([piLoad()]), null)
  assert.equal(await prove([write(), piLoad()]), 'required-skills-unproven')
  assert.equal(await prove([write()]), 'required-skills-unproven')
  assert.equal(await prove([call('e', 'edit', 'edit'), piLoad()]), 'required-skills-unproven')
})

test('every required skill must be loaded; references, failed loads and look-alikes do not count', async () => {
  const two = { requires: ['alpha', 'beta'], writes: 'task-dir' }
  assert.equal(await prove([piLoad(), piLoad('beta'), write()], two), null)
  assert.equal(await prove([piLoad(), write()], two), 'required-skills-unproven')
  assert.equal(await prove([call('ref', 'read', 'read', { path: '/c/skills/alpha/references/g.md' }), write()]), 'required-skills-unproven')
  assert.equal(await prove([piLoad(), update('r-alpha', 'failed'), write()]), 'required-skills-unproven')
  assert.equal(await prove([piLoad('alpha', 'bad'), update('bad', 'failed'), piLoad('alpha', 'retry'), write()]), null)
  assert.equal(await prove([piLoad('alpha-extra'), write()]), 'required-skills-unproven')
})

// MUTATION: treat every shell call as a write, or none.
test('a shell call is a write only for a repo writer', async () => {
  assert.equal(await prove([shell(), piLoad(), write()]), null)
  assert.equal(await prove([shell(), piLoad(), write()], { requires: ['alpha'], writes: 'repo' }), 'required-skills-unproven')
  assert.equal(await prove([piLoad(), shell()], { requires: ['alpha'], writes: 'repo' }), null)
})

// MUTATION: exempt a shell call that reads a SKILL.md from the write boundary and the beta-then-alpha order passes.
test('for a repo writer a shell call that reads a skill is still the first write', async () => {
  const repo = { requires: ['alpha'], writes: 'repo' }
  const catBeta = call('cat', 'bash', 'execute', { command: 'cat skills/beta/SKILL.md' })
  assert.equal(await prove([catBeta, piLoad(), write()], repo), 'required-skills-unproven')
})

// MUTATION: order a load by the row its call first appeared on and the late-named load passes.
test('a skill named only in a later update is ordered by that update, not by the empty first row', async () => {
  const planner = { role: 'planner', requires: ['alpha'], writes: 'task-dir' }
  const pending = call('s', 'Skill', 'other', {}, true)
  const named = row({ sessionUpdate: 'tool_call_update', toolCallId: 's', rawInput: { skill: 'crew-skills-planner:alpha' } })
  assert.equal(await prove([pending, call('cw', 'Write', 'edit', {}, true), named, done('s')], planner), 'required-skills-unproven')
  assert.equal(await prove([pending, named, done('s'), call('cw', 'Write', 'edit', {}, true)], planner), null)
})

// MUTATION: count a load on its named row rather than its completion and the started-then-written order passes.
test('a load counts only once completed, and only if it completed before the first write', async () => {
  const planner = { role: 'planner', requires: ['alpha'], writes: 'task-dir' }
  const started = call('s', 'Skill', 'other', { skill: 'crew-skills-planner:alpha' }, true)
  assert.equal(await prove([started, call('cw', 'Write', 'edit', {}, true), done('s')], planner), 'required-skills-unproven')
  assert.equal(await prove([started, call('cw', 'Write', 'edit', {}, true)], planner), 'required-skills-unproven')
  assert.equal(await prove([started, done('s'), call('cw', 'Write', 'edit', {}, true)], planner), null)
})

// MUTATION: time a load by the first row that named anything and the README-then-skill order passes.
test('a load is timed by the last row that changed what it names', async () => {
  const readme = call('r', 'read', 'read', { path: '/c/README.md' })
  const renamed = row({ sessionUpdate: 'tool_call_update', toolCallId: 'r', rawInput: { path: '/c/skills/alpha/SKILL.md' } })
  assert.equal(await prove([readme, write(), renamed, done('r')]), 'required-skills-unproven')
  assert.equal(await prove([readme, done('r'), write(), renamed]), 'required-skills-unproven')
})

// MUTATION: rank the free-form title above the execute kind and a Run command cat load is refused.
test('an execute call titled Run command that reads a SKILL.md is a load for a non-repo writer', async () => {
  const cat = call('x', 'Run command', 'execute', { command: 'cat /c/skills/alpha/SKILL.md' })
  assert.equal(await prove([cat, done('x'), write()]), null)
})

// MUTATION: compare the namespaced name verbatim and SK4 fails; strip any namespace and the foreign-plugin case passes.
test('a claude Skill load matches the bare required name only under the seat\'s own plugin', async () => {
  const planner = { role: 'planner', requires: ['alpha'], writes: 'task-dir' }
  assert.equal(await prove([skill('crew-skills-planner:alpha'), call('cw', 'Write', 'edit', {}, true)], planner), null)
  for (const plugin of ['crew-skills-builder', 'dev-team', 'other']) {
    assert.equal(await prove([skill(`${plugin}:alpha`), call('cw', 'Write', 'edit', {}, true)], planner), 'required-skills-unproven', plugin)
  }
  assert.equal(await prove([skill('crew-skills-planner:beta'), write()], planner), 'required-skills-unproven')
  assert.equal(await prove([call('cw', 'Write', 'edit', {}, true), skill('crew-skills-planner:alpha')], planner), 'required-skills-unproven')
})

// MUTATION: a failing read counts as proof.
test('an unreadable, empty or malformed recording does not prove, and a definition requiring nothing never reads it', async () => {
  const definition = { requires: ['alpha'], writes: 'task-dir' }
  assert.equal(await proveRequiredSkills({ definition, sessionFile: 'x', readFile: async () => { throw Object.assign(new Error('no'), { code: 'EACCES' }) } }), 'required-skills-unproven')
  assert.equal(await proveRequiredSkills({ definition, sessionFile: 'x', readFile: async () => '' }), 'required-skills-unproven')
  assert.equal(await prove(['{broken', piLoad()]), 'required-skills-unproven')
  for (const none of [{ requires: [] }, {}]) {
    assert.equal(await proveRequiredSkills({ definition: none, sessionFile: 'x', readFile: async () => { throw new Error('must not read') } }), null)
  }
})

// MUTATION: drop the offset/limit check and a one-line read of SKILL.md proves the skill.
test('a partial read of a SKILL.md is not a load', async () => {
  const head = call('h', 'read', 'read', { path: '/c/skills/alpha/SKILL.md', offset: 1, limit: 1 })
  assert.equal(await prove([head, update('h', 'completed'), write()]), 'required-skills-unproven')
  const shellHead = call('sh1', 'bash', 'execute', { command: 'head -1 /c/skills/alpha/SKILL.md' })
  assert.equal(await prove([shellHead, update('sh1', 'completed'), write()]), 'required-skills-unproven')
})

// MUTATION: match any path ending in skills/<name>/SKILL.md and a foreign copy proves the skill.
test('only the granted SKILL.md path is a load', async () => {
  for (const path of ['/tmp/skills/alpha/SKILL.md', 'skills/alpha/SKILL.md', '/c/skills/alpha/../alpha-x/SKILL.md']) { // no cwd: a relative path proves nothing
    const id = `p-${path}`
    assert.equal(await prove([call(id, 'read', 'read', { path }), update(id, 'completed'), write()]), 'required-skills-unproven', path)
  }
  assert.equal(await prove([call('ok', 'read', 'read', { path: '/c/skills/alpha/SKILL.md' }), update('ok', 'completed'), write()]), null)
})

// MUTATION: compare a relative path verbatim, or resolve it against anything but the seat cwd, and these flip.
test('a relative read resolves against the seat cwd before it is compared with the granted path', async () => {
  const definition = { requires: ['alpha'], writes: 'task-dir' }
  const at = (cwd, rows) => proveRequiredSkills({ definition, sessionFile: 'x', cwd, skillsRoot: '/c/skills', readFile: async () => rows.join('\n') })
  const rel = call('rel', 'read', 'read', { path: 'skills/alpha/SKILL.md' })
  const cat = call('cat', 'bash', 'execute', { command: 'cat skills/alpha/SKILL.md' })
  assert.equal(await at('/c', [rel, update('rel', 'completed'), write()]), null)
  assert.equal(await at('/c', [cat, update('cat', 'completed'), write()]), null)
  assert.equal(await at('/worktree', [rel, update('rel', 'completed'), write()]), 'required-skills-unproven')
})
