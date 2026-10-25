import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBrief, parseAgent, validateEnvelope, AGENT_ROLES, BRIEF_FIELDS, TIERS, SHAPES, ENVELOPE_FIELDS, ENVELOPE_STATUSES, REVIEW_VERDICTS, LEAD_DECISIONS, FINDING_SEVERITIES, FINDING_DISPOSITIONS } from './protocols.mjs'

const BODY = '## The ask\n\nRefuse roster edits that cannot boot.\n\n## Acceptance\n\n- (RV1) an edit that cannot boot is refused\n- (RV2) a bootable edit is accepted\n'
const brief = (overrides = {}, body = BODY) => {
  const fields = { source: 'issue 1961', closes: '1961', tier: 'build', shape: 'standard', acceptance: '[RV1, RV2]', out_of_scope: 'the visualizer', ...overrides }
  const front = Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join('\n')
  return `---\n${front}\n---\n${body}`
}

test('P1 vocabularies are the ADR-052 fields, tiers and shapes', () => {
  assert.deepEqual(BRIEF_FIELDS, ['source', 'closes', 'tier', 'shape', 'acceptance', 'out_of_scope'])
  assert.deepEqual(TIERS, ['mechanical', 'build', 'judge'])
  assert.deepEqual(SHAPES, ['standard', 'stepped', 'finish'])
})

test('a well-formed brief parses with no defects', () => {
  const { fields, body, defects } = parseBrief(brief())
  assert.deepEqual(defects, [])
  assert.deepEqual(fields, { source: 'issue 1961', closes: 1961, tier: 'build', shape: 'standard', acceptance: ['RV1', 'RV2'], out_of_scope: 'the visualizer' })
  assert.match(body, /^## The ask/)
  assert.equal(parseBrief(brief({ closes: 'null' })).fields.closes, null)
})

// MUTATION: drop the frontmatter-open check and a plain markdown brief reaches field parsing.
test('a brief without frontmatter is refused', () => {
  assert.deepEqual(parseBrief('# Ask\n').defects, ['the brief does not open with a --- frontmatter block'])
  assert.deepEqual(parseBrief('---\nsource: x\n').defects, ['the frontmatter block is never closed with ---'])
})

// MUTATION: skip the unknown-field check and a misspelt field is silently ignored.
test('unknown and missing fields are refused by name', () => {
  const { defects } = parseBrief(brief({ tier: undefined, lane: 'b1' }))
  assert.ok(defects.includes('unknown field lane; the fields are source, closes, tier, shape, acceptance, out_of_scope'))
  assert.ok(defects.includes('missing field tier'))
})

// MUTATION: accept any tier, shape or closes value and a typo boots on the wrong seats or binds no issue.
test('tier, shape and closes take only their closed values', () => {
  assert.ok(parseBrief(brief({ tier: 'rigorous' })).defects.includes('tier is one of mechanical, build, judge'))
  assert.ok(parseBrief(brief({ shape: 'chunked' })).defects.includes('shape is one of standard, stepped, finish'))
  assert.ok(parseBrief(brief({ closes: '0' })).defects.includes('closes is null or one issue number'))
  // MUTATION: accept any integer and 9007199254740993 rounds to a different issue.
  assert.ok(parseBrief(brief({ closes: '9007199254740993' })).defects.includes('closes is null or one issue number'))
})

// MUTATION: compare the acceptance ids as sets, or not at all, and a gate id with no item passes.
test('acceptance ids must open the ## Acceptance items in order', () => {
  assert.ok(parseBrief(brief({ acceptance: '[RV1, RV3]' })).defects.includes('the ## Acceptance items open with (RV1) (RV2), not the frontmatter ids (RV1) (RV3)'))
  assert.ok(parseBrief(brief({ acceptance: '[RV1, RV1]' })).defects.includes('acceptance repeats an id'))
  assert.ok(parseBrief(brief({ acceptance: '[]' })).defects.some((line) => line.startsWith('acceptance lists the gate ids')))
})

// MUTATION: read items inside a fence, or close a fence on a line with trailing text, and a brief with no enforceable ids validates.
test('acceptance items inside a fence are examples, and only a bare marker closes a fence', () => {
  const fenced = '## Acceptance\n\n```\n- (RV1) a\n- (RV2) b\n```\n'
  assert.ok(parseBrief(brief({}, fenced)).defects.includes('the ## Acceptance items open with (none), not the frontmatter ids (RV1) (RV2)'))
  const trailing = '## Acceptance\n\n```\nexample\n``` trailing\n- (RV1) a\n- (RV2) b\n```\n'
  assert.ok(parseBrief(brief({}, trailing)).defects.includes('the ## Acceptance items open with (none), not the frontmatter ids (RV1) (RV2)'))
})

// MUTATION: merge repeated sections and the validator approves ids the driver never reads.
test('a repeated section is refused, because the driver reads only the first', () => {
  const twice = '## Acceptance\n\n- (RV1) a\n\n## Acceptance\n\n- (RV2) b\n'
  assert.ok(parseBrief(brief({}, twice)).defects.includes('the body repeats ## Acceptance; the driver reads only the first'))
})

// MUTATION: allow #N in the body and something other than closes can bind an issue.
test('the body names no issue or PR number; closes is the only binding', () => {
  const body = BODY.replace('cannot boot.', 'cannot boot, after PR #1968.\n\nCloses #1961')
  assert.ok(parseBrief(brief({}, body)).defects.includes('the body names #1968, #1961; write "issue N" or "PR N", because closes is the only issue binding'))
})

// P5, the agent definition.
const BASE = { name: 'planner', description: 'Plan one lane.', role: 'planner', agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high' }
const agent = (fields = {}, body = 'Read [the charter](../roles/planner.md).\n') => {
  const front = Object.entries({ ...BASE, ...fields }).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')
  return `---\n${front}\n---\n${body}`
}
const defectsOf = (fields, needle) => parseAgent(agent(fields)).defects.filter((d) => d.includes(needle))

test('P5 roles are the five seats in canonical order', () => {
  assert.deepEqual(AGENT_ROLES, ['lead', 'planner', 'builder', 'reviewer', 'tech-lead'])
})

// MUTATION: drop a field type from the decode and its value arrives as a string or vanishes.
test('every P5 field decodes to its own type', () => {
  const full = {
    writes: 'task-dir', envelope: 'plan',
    fallback: [{ agent: 'pi', model: 'openai/gpt-6-astra', effort: 'medium' }, { agent: 'pi', model: 'openai/other' }],
    skills: ['plan', 'qa-test-writing'], requires: ['qa-test-writing'], tools: ['read', 'bash'], extensions: ['lab', 'fff'],
    advisor: { agent: 'pi', model: 'openai/gpt-6-astra', effort: 'high' },
    edit_assist: false, codemode: true, memory: false, rounds: 2, wait_s: 1800,
    tiers: { mechanical: { effort: 'medium' }, build: null, judge: { effort: 'xhigh', model: 'openai/changed', fallback: [] } },
  }
  const { fields, body, defects } = parseAgent(agent(full))
  assert.deepEqual(defects, [])
  assert.deepEqual(fields, { ...BASE, ...full })
  assert.equal(body, 'Read [the charter](../roles/planner.md).\n')
  assert.deepEqual(parseAgent(agent({ advisor: null, skills: [], fallback: [] })).fields.advisor, null)
})

test('P5 lists are JSON or the ADR bare list, and nothing in between', () => {
  assert.deepEqual(parseAgent(agent({ skills: '[plan, qa-test-writing]' })).fields.skills, ['plan', 'qa-test-writing'])
  assert.deepEqual(parseAgent(agent({ skills: '["plan", "qa-test-writing"]' })).fields.skills, ['plan', 'qa-test-writing'])
  assert.deepEqual(parseAgent(agent({ skills: '[]' })).fields.skills, [])
  assert.deepEqual(defectsOf({ skills: '[plan, [nested]]' }, 'skills').length, 1)
  assert.match(defectsOf({ skills: '[plan, "unclosed]' }, 'skills')[0], /JSON/)
})

test('P5 reads CRLF, quotes, and keeps the body as written', () => {
  const crlf = agent({ description: '"Plan one lane."' }, 'a\r\nb\r\n').replaceAll('---\n', '---\r\n').replace(/(?<!\r)\n(?=\w+:)/g, '\r\n')
  assert.ok(crlf.includes('name: planner\r\n') && crlf.includes('---\r\na'))
  const { fields, body, defects } = parseAgent(crlf)
  assert.deepEqual(defects, [])
  assert.deepEqual(fields, { ...BASE })
  assert.equal(body, 'a\r\nb\r\n')
})

// MUTATION: skip the frontmatter checks and an empty or interrupted file parses as a definition.
test('empty and interrupted P5 files are refused, not read as no definition', () => {
  assert.deepEqual(parseAgent('').defects, ['the agent definition does not open with a --- frontmatter block'])
  assert.equal(parseAgent('').fields, null)
  assert.deepEqual(parseAgent('---\nname: planner\n').defects, ['the frontmatter block is never closed with ---'])
  assert.deepEqual(parseAgent(undefined).defects.length, 1)
  assert.ok(parseAgent('---\n---\n').defects.includes('missing field name'))
})

// MUTATION: skip the unknown, duplicate or missing checks and a misspelt field is silently ignored.
test('P5 unknown, duplicate, missing and malformed lines are refused by name', () => {
  assert.ok(defectsOf({ surprise: 'x' }, 'unknown field surprise').length)
  for (const key of ['name', 'description', 'role', 'agent', 'model', 'effort']) {
    const fields = { ...BASE }
    delete fields[key]
    assert.ok(parseAgent(`---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n`).defects.includes(`missing field ${key}`), key)
  }
  assert.deepEqual(parseAgent(agent().replace('name: planner', 'name: planner\nname: other')).defects, ['duplicate field name'])
  assert.ok(parseAgent(agent().replace('effort: high', 'effort high')).defects.some((d) => d.startsWith('frontmatter line is not key: value')))
})

// MUTATION: accept any value for a closed field and a typo seats the wrong agent or model.
test('P5 closed fields take only their values', () => {
  const cases = { name: '9bad', role: 'scout', agent: 'codex', effort: 'extreme', model: 'no-slash', writes: 'anywhere', edit_assist: 'maybe', codemode: 'falsehood', memory: 2, rounds: 0, wait_s: -1, skills: { name: 'x' }, requires: [{}], tools: [7], extensions: 7, envelope: '' }
  for (const [key, value] of Object.entries(cases)) assert.equal(defectsOf({ [key]: value }, key).length >= 1, true, key)
  for (const model of ['a/b/c', '/id', 'provider/', 'Upper/id', 'p/i d']) assert.equal(defectsOf({ model }, 'model').length, 1, model)
  assert.equal(defectsOf({ extensions: ['lab', 'nope'] }, 'extensions').length, 1)
  assert.equal(defectsOf({ rounds: '9007199254740993' }, 'rounds').length, 1)
})

// MUTATION: skip the JSON check and a malformed object is salvaged by the list splitter.
test('P5 malformed JSON is refused naming the field and JSON', () => {
  for (const [field, raw] of [['fallback', '[{"agent":"pi",}]'], ['tiers', '{"judge":'], ['advisor', '{bad}']]) {
    const found = defectsOf({ [field]: raw }, field)
    assert.equal(found.length, 1, field)
    assert.match(found[0], /JSON/)
  }
})

// MUTATION: drop the nested key checks and a misspelt advisor or fallback key is ignored.
test('P5 fallback and advisor objects are closed and complete', () => {
  assert.ok(defectsOf({ fallback: [{ agent: 'pi', model: 'openai/x', surprise: 1 }] }, 'fallback[0].surprise').length)
  assert.ok(defectsOf({ fallback: [{ agent: 'pi' }] }, 'fallback[0].model is required').length)
  assert.ok(defectsOf({ fallback: [{ agent: 'pi', model: 'bad' }] }, 'fallback[0].model').length)
  assert.ok(defectsOf({ fallback: [{ agent: 'pi', model: 'openai/x', effort: 'huge' }] }, 'fallback[0].effort').length)
  assert.ok(defectsOf({ fallback: 'openai/x' }, 'fallback').length)
  assert.ok(defectsOf({ advisor: { agent: 'pi', model: 'openai/x', effort: 'high', surprise: true } }, 'advisor.surprise').length)
  assert.ok(defectsOf({ advisor: { agent: 'pi', model: 'openai/x' } }, 'advisor.effort is required').length)
  assert.ok(defectsOf({ advisor: { agent: 'pi', model: 'bad', effort: 'high' } }, 'advisor.model').length)
  assert.ok(defectsOf({ advisor: 'terra' }, 'advisor').length)
})

// MUTATION: skip the self and agent-change checks and a seat falls back to itself or onto another transport.
test('P5 fallback never names the seat itself or another agent', () => {
  assert.ok(defectsOf({ fallback: [{ agent: 'pi', model: BASE.model }] }, 'fallback[0].model is the seat').length)
  assert.ok(defectsOf({ fallback: [{ agent: 'claude', model: 'anthropic/claude-opus-5-5' }] }, 'fallback[0].agent claude changes').length)
})

// MUTATION: validate only the base fields and a tier override can seat an unknown effort, agent or fallback.
test('P5 tier overrides are validated by path and by effective seat', () => {
  assert.ok(defectsOf({ tiers: { ultra: { effort: 'high' } } }, 'tiers.ultra is not a tier').length)
  assert.ok(defectsOf({ tiers: { judge: { effort: 'nope' } } }, 'tiers.judge.effort').length)
  assert.ok(defectsOf({ tiers: { judge: { surprise: 'x' } } }, 'tiers.judge.surprise').length)
  for (const key of ['name', 'description', 'role', 'tiers']) assert.ok(defectsOf({ tiers: { judge: { [key]: 'x' } } }, `tiers.judge.${key} cannot be overridden`).length, key)
  assert.ok(defectsOf({ tiers: { judge: 'high' } }, 'tiers.judge').length)
  assert.ok(defectsOf({ tiers: [] }, 'tiers').length)
  assert.ok(defectsOf({ tiers: { judge: { advisor: { agent: 'pi', model: 'bad', effort: 'high' } } } }, 'tiers.judge.advisor.model').length)
  // The base fallback is sound on pi; a tier moving the seat to claude strands it.
  const stranded = { fallback: [{ agent: 'pi', model: 'openai/spare' }], tiers: { judge: { agent: 'claude', model: 'anthropic/claude-opus-5-5' } } }
  assert.ok(defectsOf(stranded, 'tiers.judge.fallback[0].agent pi changes').length)
  assert.deepEqual(parseAgent(agent({ tiers: { judge: { agent: 'claude', model: 'anthropic/claude-opus-5-5', fallback: [] } }, fallback: [{ agent: 'pi', model: 'openai/spare' }] })).defects, [])
  // A tier giving the seat the base fallback's model makes it its own fallback.
  assert.ok(defectsOf({ fallback: [{ agent: 'pi', model: 'openai/spare' }], tiers: { build: { model: 'openai/spare' } } }, 'tiers.build.fallback[0].model is the seat').length)
})

// P2, the seat envelope.
const DETAILS = {
  planner: {
    subject: 'fix(crew): name the lane change', plan_path: '/task/plan.md', gate_path: '/task/gate.mjs', acceptance: ['EV1', 'EV2'],
    mutations: [{ check: 'EV1', file: 'a.mjs', find: 'x', replace: 'y' }, { check: 'EV2', file: 'b.mjs', find: 'p', replace: 'q' }],
  },
  builder: { summary: 'Implemented the change.' },
  reviewer: { verdict: 'pass', findings: [] },
  'tech-lead': { verdict: 'pass', findings: [] },
  lead: { decision: 'accept' },
}
const envelope = (role, overrides = {}) => ({ role, id: 'd1', status: 'done', summary: 'Completed.', details: structuredClone(DETAILS[role]), ...overrides })
const finding = (overrides = {}) => ({ id: 'RV1-1', severity: 'should-fix', location: 'crew/protocols.mjs:1', summary: 'Malformed input is accepted.', ...overrides })
const review = (findings, verdict = 'changes-needed', role = 'reviewer') => envelope(role, { details: { verdict, findings } })
const refusedFor = (role, value, needle) => validateEnvelope(role, value).defects.filter((d) => d.includes(needle))

test('P2 vocabularies are closed and frozen', () => {
  assert.deepEqual(ENVELOPE_FIELDS, ['role', 'id', 'status', 'summary', 'details'])
  assert.deepEqual(ENVELOPE_STATUSES, ['done', 'insufficient', 'escalate'])
  assert.deepEqual(REVIEW_VERDICTS, ['pass', 'changes-needed'])
  assert.deepEqual(LEAD_DECISIONS, ['bounce', 'accept', 'escalate'])
  assert.deepEqual(FINDING_SEVERITIES, ['must-fix', 'should-fix', 'consider'])
  assert.deepEqual(FINDING_DISPOSITIONS, ['auto-fix', 'ask-user', 'no-op'])
  for (const list of [ENVELOPE_FIELDS, ENVELOPE_STATUSES, REVIEW_VERDICTS, LEAD_DECISIONS, FINDING_SEVERITIES, FINDING_DISPOSITIONS]) assert.ok(Object.isFrozen(list))
})

// MUTATION: return a copy or null on success and the loop acts on a value it never validated.
test('P2 accepts every role and status, returning the input untouched', () => {
  for (const role of AGENT_ROLES) for (const status of ENVELOPE_STATUSES) {
    const value = envelope(role, { status })
    const snapshot = structuredClone(value)
    const result = validateEnvelope(role, value)
    assert.deepEqual(result.defects, [], `${role}/${status}`)
    assert.equal(result.envelope, value)
    assert.deepEqual(value, snapshot)
  }
  for (const decision of LEAD_DECISIONS) assert.deepEqual(validateEnvelope('lead', envelope('lead', { details: { decision } })).defects, [])
  for (const verdict of REVIEW_VERDICTS) for (const role of ['reviewer', 'tech-lead']) assert.deepEqual(validateEnvelope(role, review([], verdict, role)).defects, [])
})

// MUTATION: add blocked to ENVELOPE_STATUSES and a stale status is accepted.
test('P2 refuses a status outside done, insufficient, escalate', () => {
  for (const status of ['blocked', 'ok', '', null, 4]) assert.ok(refusedFor('builder', envelope('builder', { status }), 'status').length, String(status))
})

// MUTATION: drop the role comparison and a seat can return another seat's envelope.
test('P2 refuses a role that is not the expected one', () => {
  assert.ok(refusedFor('builder', envelope('planner'), 'role must match').length)
  assert.ok(refusedFor('scout', envelope('builder'), 'role').length)
  const unsupported = validateEnvelope('scout', envelope('scout'))
  assert.ok(unsupported.defects.some((d) => d.startsWith('role is one of')))
  assert.equal(validateEnvelope('__proto__', envelope('builder')).envelope.id, 'd1')
})

// MUTATION: drop gate_path from the planner keys and a plan without a gate is accepted.
test('P2 planner details name the plan, the gate and the acceptance ids', () => {
  for (const key of Object.keys(DETAILS.planner)) {
    const value = envelope('planner'); delete value.details[key]
    assert.deepEqual(refusedFor('planner', value, `details.${key} is required`).length, 1, key)
  }
  for (const key of ['plan_path', 'gate_path']) for (const bad of ['', null, 5]) {
    const value = envelope('planner'); value.details[key] = bad
    assert.ok(refusedFor('planner', value, `details.${key}`).length, key)
  }
  for (const acceptance of [[], ['EV1', 'EV1'], ['9bad'], 'EV1', [null], undefined]) {
    const value = envelope('planner'); value.details.acceptance = acceptance
    assert.ok(refusedFor('planner', value, 'details.acceptance').length, JSON.stringify(acceptance))
  }
})

// MUTATION: bypass DETAIL_RULES for subject and a malformed, overlong or control-bearing subject is accepted.
test('P2 planner subject is a conventional-commit subject of at most 72 characters', () => {
  const types = ['chore', 'ci', 'crew', 'docs', 'feat', 'fix', 'merge', 'perf', 'refactor', 'revert', 'spike', 'test', 'wip', 'workflow']
  const accepted = ['fix: x', 'feat!: breaking change', 'fix(crew)!: scoped breaking', 'fix(a.b_c/d-e): scoped', `fix: ${'x'.repeat(67)}`, 'fix: two  spaces inside', ...types.map((t) => `${t}(crew): measured change`)]
  for (const subject of accepted) {
    const value = envelope('planner'); value.details.subject = subject
    assert.deepEqual(validateEnvelope('planner', value).defects, [], subject)
  }
  const refused = ['', 'plain summary', 'unknown: summary', 'Fix: capital type', 'fix:', 'fix: ', 'fix:summary', 'fix : summary', 'fix(): summary', 'fix(-a): summary', 'fix(a b): summary',
    'fix(a)(b): summary', 'fix: summary ', 'fix:  leading space', ' fix: summary', 'fix: summary\nnext', 'fix: summary\0', 'fix: x\ty', 'fix: x\x7f', `fix: ${'x'.repeat(68)}`, null, 7, ['fix: x'], { subject: 'fix: x' }]
  for (const subject of refused) {
    const value = envelope('planner'); value.details.subject = subject
    assert.ok(refusedFor('planner', value, 'details.subject ').length, JSON.stringify(subject))
  }
})

// MUTATION: drop the acceptance coverage comparison and a declaration set that skips or invents a check is accepted.
test('P2 planner mutations declare exactly one {check, file, find, replace} per acceptance id', () => {
  const [one, two] = DETAILS.planner.mutations
  const refusedWith = (mutations, needle) => {
    const value = envelope('planner'); value.details.mutations = mutations
    return refusedFor('planner', value, needle).length > 0
  }
  assert.ok(refusedWith([one], 'no declaration for acceptance EV2'))
  assert.ok(refusedWith([], 'no declaration for acceptance EV1'))
  assert.ok(refusedWith([one, two, { ...two, check: 'EV3' }], 'is not a declared acceptance id'))
  assert.ok(refusedWith([one, two, one], 'repeats EV1'))
  assert.ok(refusedWith([one, { ...two, extra: 1 }], 'is not a mutation field'))
  for (const key of ['check', 'file', 'find', 'replace']) {
    const { [key]: gone, ...rest } = two
    assert.ok(refusedWith([one, rest], `.${key} is required`), key)
    assert.ok(refusedWith([one, { ...two, [key]: 5 }], `.${key} is a string`), key)
  }
  assert.ok(refusedWith([one, { ...two, find: '' }], 'find is a nonempty string'))
  assert.ok(refusedWith([one, { ...two, replace: two.find }], 'replace differs from find'))
  for (const bad of [null, 'x', {}, [null], [[]], [one, 7]]) assert.ok(refusedWith(bad, 'details.mutations'), JSON.stringify(bad))
  assert.deepEqual(validateEnvelope('planner', envelope('planner')).defects, [])
  // Only the planner carries them.
  const stray = envelope('builder'); stray.details.mutations = []
  assert.ok(refusedFor('builder', stray, 'details.mutations is not a field').length)
})

// MUTATION: add approved to REVIEW_VERDICTS or retry to LEAD_DECISIONS and the closed enum opens.
test('P2 refuses a verdict or decision outside the closed lists', () => {
  for (const role of ['reviewer', 'tech-lead']) assert.ok(refusedFor(role, review([], 'approved', role), 'details.verdict').length)
  assert.ok(refusedFor('lead', envelope('lead', { details: { decision: 'retry' } }), 'details.decision').length)
  assert.ok(refusedFor('builder', envelope('builder', { details: { summary: '' } }), 'details.summary').length)
})

// MUTATION: drop the top-level unknown-key check and the old assignment_id shape passes.
test('P2 refuses unknown top-level fields, including a parsed __proto__', () => {
  for (const key of ['surprise', 'assignment_id', '__proto__']) {
    const value = JSON.parse(JSON.stringify(envelope('builder')).replace(/}$/, `,${JSON.stringify(key)}:true}`))
    assert.ok(refusedFor('builder', value, `unknown field ${key}`).length, key)
  }
})

// MUTATION: throw or return null for a bad root and one malformed envelope halts the loop.
test('P2 malformed roots and common fields are refused without throwing', () => {
  for (const input of [null, [], 'json', 7, undefined]) assert.deepEqual(validateEnvelope('builder', input), { envelope: null, defects: ['envelope is a JSON object'] })
  for (const key of ENVELOPE_FIELDS) {
    const value = envelope('builder'); delete value[key]
    assert.ok(refusedFor('builder', value, `missing field ${key}`).length, key)
  }
  for (const key of ['id', 'summary']) for (const bad of ['', null, 5, []]) assert.ok(refusedFor('builder', envelope('builder', { [key]: bad }), key).length, key)
  for (const details of [null, [], 'details', 5]) for (const role of AGENT_ROLES) assert.ok(refusedFor(role, envelope(role, { details }), 'details is an object').length, role)
  const several = validateEnvelope('builder', envelope('builder', { id: '', summary: '', status: 'blocked' }))
  assert.ok(several.defects.length >= 3)
})

// MUTATION: skip the unknown-key loop over details and extra payload rides along.
test('P2 role details are exactly the listed keys', () => {
  for (const role of AGENT_ROLES) {
    for (const key of Object.keys(DETAILS[role])) {
      const value = envelope(role); delete value.details[key]
      assert.ok(refusedFor(role, value, `details.${key} is required`).length, `${role}.${key}`)
    }
    const extra = envelope(role); extra.details.surprise = true
    assert.ok(refusedFor(role, extra, 'details.surprise is not a field').length, role)
  }
})

// MUTATION: skip the findings item checks and a malformed finding is dropped silently.
test('P2 typed findings are accepted in every documented form', () => {
  for (const role of ['reviewer', 'tech-lead']) {
    for (const disposition of [undefined, 'no-op', 'ask-user', 'auto-fix']) {
      const entry = finding(disposition ? { disposition } : {})
      if (disposition === 'auto-fix') entry.patch = '--- a/x\n+++ b/x\n'
      assert.deepEqual(validateEnvelope(role, review([entry], 'changes-needed', role)).defects, [], String(disposition))
    }
    for (const severity of FINDING_SEVERITIES) assert.deepEqual(validateEnvelope(role, review([finding({ severity })], 'changes-needed', role)).defects, [])
    assert.deepEqual(validateEnvelope(role, review([finding({ severity: 'must-fix' })], 'changes-needed', role)).defects, [])
  }
})

test('P2 typed findings are refused by nested path', () => {
  for (const role of ['reviewer', 'tech-lead']) {
    const bad = (findings, needle, verdict = 'changes-needed') => assert.ok(refusedFor(role, review(findings, verdict, role), needle).length, `${role} ${needle}`)
    bad(null, 'details.findings')
    bad({}, 'details.findings')
    bad(['x', null, []], 'details.findings[0] is an object')
    bad([finding({ severity: 'critical' })], 'details.findings[0].severity')
    bad([finding({ disposition: 'apply' })], 'details.findings[0].disposition')
    bad([finding({ id: '../escape' })], 'details.findings[0].id')
    bad([finding({ id: 'a'.repeat(65) })], 'details.findings[0].id')
    bad([finding(), finding()], 'details.findings[1].id repeats')
    bad([finding({ location: '' })], 'details.findings[0].location')
    bad([finding({ summary: '' })], 'details.findings[0].summary')
    bad([finding({ disposition: 'auto-fix' })], 'details.findings[0].patch is required')
    bad([finding({ disposition: 'auto-fix', patch: '' })], 'details.findings[0].patch')
    bad([finding({ disposition: 'no-op', patch: 'diff' })], 'details.findings[0].patch is only allowed')
    bad([finding({ patch: 'diff' })], 'details.findings[0].patch is only allowed')
    bad([finding({ surprise: true })], 'details.findings[0].surprise')
    bad([finding(), finding({ id: 'ok', severity: 'bad' })], 'details.findings[1].severity')
    for (const key of ['id', 'severity', 'location', 'summary']) {
      const entry = finding(); delete entry[key]
      bad([entry], `details.findings[0].${key} is required`)
    }
    bad([finding({ severity: 'must-fix' })], 'details.verdict is pass', 'pass')
  }
})
