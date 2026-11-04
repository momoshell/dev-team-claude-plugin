import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBrief, parseAgent, validateEnvelope, AGENT_ROLES, BRIEF_FIELDS, TIERS, SHAPES, ENVELOPE_FIELDS, ENVELOPE_STATUSES, REVIEW_VERDICTS, LEAD_DECISIONS, FINDING_SEVERITIES, FINDING_DISPOSITIONS } from './protocols.mjs'
import * as protocols from './protocols.mjs'

const BODY = '## Context\n\n- `crew/agents.mjs`\n'
const brief = (overrides = {}, body = BODY) => {
  const fields = { source: 'issue 1961', closes: '1961', shape: 'standard', out_of_scope: 'the visualizer', ...overrides }
  const front = Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join('\n')
  return `---\n${front}\n---\n${body}`
}

test('P1 vocabularies are the ADR-052 fields, tiers and shapes', () => {
  assert.deepEqual(BRIEF_FIELDS, ['source', 'closes', 'mechanical', 'shape', 'out_of_scope', 'suite', 'generated', 'regenerate'])
  assert.deepEqual(TIERS, ['mechanical', 'build', 'judge'])
  assert.deepEqual(SHAPES, ['standard', 'finish'])
  assert.ok(Object.isFrozen(SHAPES))
})

test('a brief with no acceptance field and no ## Acceptance section parses with no defects (PD1)', () => {
  const { fields, body, defects } = parseBrief(brief())
  assert.deepEqual(defects, [])
  assert.deepEqual(fields, { source: 'issue 1961', closes: 1961, shape: 'standard', out_of_scope: 'the visualizer' })
  assert.match(body, /^## Context/)
  assert.equal(parseBrief(brief({ closes: 'null' })).fields.closes, null)
})

// MUTATION: drop the CRLF normalisation in parseBrief and every frontmatter and Context line is refused.
test('a brief saved with CRLF line endings parses as its LF form', () => {
  const lf = brief({ source: 'operator request', closes: 'null' }, '## The ask\n\n> Do it.\n\n' + BODY + '- PR 34\n')
  const parsed = parseBrief(lf)
  const crlf = parseBrief(lf.replace(/\n/g, '\r\n'))
  assert.deepEqual(crlf.defects, [])
  assert.deepEqual(crlf.fields, parsed.fields)
  assert.deepEqual(crlf.body, parsed.body)

  const invalid = brief({}, BODY + '- see `x`\n')
  assert.deepEqual(parseBrief(invalid.replace(/\n/g, '\r\n')).defects, parseBrief(invalid).defects)
})

// MUTATION: add stepped back to SHAPES.
test('AR1 refuses the retired stepped shape', () => {
  assert.deepEqual(parseBrief(brief({ shape: 'stepped' })).defects, ['shape is one of standard, finish'])
})

// MUTATION: require suite like the other fields and every brief without it is refused; skip its check and a list passes.
test('suite is an optional command line: absent is defect-free, a string parses, an empty or list value is refused (SB5, SB6)', () => {
  assert.equal(Object.hasOwn(parseBrief(brief()).fields, 'suite'), false)
  const cargo = parseBrief(brief({ suite: 'cargo test -p power-api' }))
  assert.deepEqual(cargo.defects, [])
  assert.equal(cargo.fields.suite, 'cargo test -p power-api')
  for (const suite of ['', '[cargo, test]']) {
    assert.deepEqual(parseBrief(brief({ suite })).defects, ['suite is a command line (for example: suite: cargo test -p power-api)'])
  }
})

// MUTATION: require out_of_scope like the other fields and an absent field is refused.
test('out_of_scope is optional: absent parses with no defects and no field, an empty value is refused', () => {
  const absent = parseBrief(brief({ out_of_scope: undefined }))
  assert.deepEqual(absent.defects, [])
  assert.equal(Object.hasOwn(absent.fields, 'out_of_scope'), false)
  assert.deepEqual(parseBrief(brief({ out_of_scope: '' })).defects, ['out_of_scope says what the lane must not change'])
})

test('a suite or regenerate line with a quote or backslash is refused', () => {
  for (const key of ['suite', 'regenerate']) for (const char of ['"', "'", '\\']) {
    const fields = key === 'suite' ? { suite: `npm ${char}test` } : { generated: '[a]', regenerate: `npm ${char}test` }
    assert.ok(parseBrief(brief(fields)).defects.some((d) => d.includes(`${key} is split on whitespace`) && d.includes('without a shell')))
  }
  assert.deepEqual(parseBrief(brief({ suite: '"npm test"' })).defects, [])
})

test('generated and regenerate are an optional pair: both parse, either alone, an empty list or a non-literal path is refused', () => {
  const valid = parseBrief(brief({ generated: '[gen.txt, dist/]', regenerate: 'npm run generate' }))
  assert.deepEqual(valid.defects, [])
  assert.deepEqual(valid.fields.generated, ['gen.txt', 'dist/'])
  assert.equal(valid.fields.regenerate, 'npm run generate')
  for (const fields of [
    { generated: '[a]' }, { regenerate: 'make' }, { generated: '[]', regenerate: 'make' },
    ...['/abs', '../x', 'a/.git/x', 'a\\b', 'a\0b', 'a/*.js'].map((path) => ({ generated: `[${path}]`, regenerate: 'make' })),
    { generated: '[a]', regenerate: '' },
  ]) assert.ok(parseBrief(brief(fields)).defects.some((defect) => /generated|regenerate/.test(defect)), JSON.stringify(fields))
  assert.ok(parseBrief(brief({ regenerat: 'make' })).defects.some((defect) => defect.includes('regenerat')))
})

// MUTATION: drop the frontmatter-open check and a plain markdown brief reaches field parsing.
test('a brief without frontmatter is refused', () => {
  assert.deepEqual(parseBrief('# Ask\n').defects, ['the brief does not open with a --- frontmatter block'])
  assert.deepEqual(parseBrief('---\nsource: x\n').defects, ['the frontmatter block is never closed with ---'])
})

// MUTATION: skip the unknown-field check and a misspelt field is silently ignored.
test('unknown and missing fields are refused by name', () => {
  const { defects } = parseBrief(brief({ shape: undefined, lane: 'b1' }))
  assert.ok(defects.includes('unknown field lane; the fields are source, closes, mechanical, shape, out_of_scope, suite, generated, regenerate'))
  assert.ok(defects.includes('missing field shape'))
})

// MUTATION: accept any tier, shape or closes value and a typo boots on the wrong seats or binds no issue.
test('shape and closes take only their closed values', () => {
  assert.ok(parseBrief(brief({ shape: 'chunked' })).defects.includes('shape is one of standard, finish'))
  assert.ok(parseBrief(brief({ closes: '0' })).defects.includes('closes is null or one issue number'))
  // MUTATION: accept any integer and 9007199254740993 rounds to a different issue.
  assert.ok(parseBrief(brief({ closes: '9007199254740993' })).defects.includes('closes is null or one issue number'))
})

test('retired brief fields are refused', () => {
  for (const [fields, body, defect] of [
    ...[BODY, `${BODY}\n## Acceptance\n- (RV1) a\n`].map((body) => [{ acceptance: '[RV1]' }, body, 'acceptance is not a brief field: the planner writes the criteria (ADR-055 §1)']),
    [{ tier: 'build' }, BODY, 'tier is not a brief field: use mechanical: true for a mechanical lane (ADR-055 §1)'],
  ]) {
    const result = parseBrief(brief(fields, body))
    assert.ok(result.defects.includes(defect))
    if (fields.tier) { assert.equal(result.fields.mechanical, undefined); assert.deepEqual(result.defects, [defect]) }
  }
})

// MUTATION: merge repeated sections and the validator approves ids the driver never reads.
test('a repeated section is refused, because the driver reads only the first', () => {
  const twice = `${BODY}\n## Context\n\n- \`other.mjs\`\n`
  assert.ok(parseBrief(brief({}, twice)).defects.includes('the body repeats ## Context; the driver reads only the first'))
})

// MUTATION: allow #N in the body and something other than closes can bind an issue.
test('the body names no issue or PR number; closes is the only binding', () => {
  const body = BODY.replace('`crew/agents.mjs`', '`crew/agents.mjs` after PR #1968, closes #1961')
  assert.ok(parseBrief(brief({}, body)).defects.includes('the body names #1968, #1961; write "issue N" or "PR N", because closes is the only issue binding'))
})

// MUTATION: restore the body-wide #N guard and the quoted source is refused.
// MUTATION: exempt by line text or exempt the whole ask and the Context or unquoted case passes.
test('an operator ask quotes #N verbatim and passes, and #N anywhere else in the body is still refused', () => {
  const ask = '## The ask\n\n> Fix #42 after PR #7.\n\n'
  for (const closes of ['null', '42']) {
    assert.deepEqual(parseBrief(brief({ source: 'operator request', closes }, ask + BODY)).defects, [])
  }
  for (const [body, tokens] of [
    [ask + BODY + '- `notes` mentions #9\n', '#9'],
    [ask + 'plain #8\n' + BODY, '#8'],
    [ask + BODY + '> Fix #42 after PR #7.\n', '#42, #7'],
  ]) {
    assert.ok(parseBrief(brief({ source: 'operator request' }, body)).defects.includes(`the body names ${tokens}; write "issue N" or "PR N", because closes is the only issue binding`))
  }
})

test('a brief chooses its loop only with mechanical: true, and any other mechanical value is refused (ADR-055 §1)', () => {
  for (const [fields, expected, defect] of [
    [{}, undefined, null], [{ mechanical: 'true' }, true, null],
    [{ mechanical: 'false' }, 'false', 'mechanical is true, or the field is absent'],
    [{ mechanical: 'yes' }, 'yes', 'mechanical is true, or the field is absent'],
  ]) {
    const result = parseBrief(brief(fields))
    assert.equal(result.fields.mechanical, expected)
    assert.deepEqual(result.defects, defect ? [defect] : [])
  }
})

test('a brief body is the quoted source ask and ## Context pointers, and anything else is refused (ADR-055 §1)', () => {
  const operator = '## The ask\n\n> Do this.\n>\n> And that.\n\n' + BODY
  for (const [fields, body] of [
    [{}, BODY],
    [{ source: 'operator request' }, operator + '* issue 12\n- PR 34\n'],
  ]) assert.deepEqual(parseBrief(brief(fields, body)).defects, [])
  for (const [fields, body, defect] of [
    [{}, BODY + '\n## Rules\n', 'the body holds only ## The ask and ## Context: ## Rules'],
    [{}, BODY + '\n  ## Rules  \n', 'the body holds only ## The ask and ## Context:   ## Rules  '],
    [{}, 'preamble\n' + BODY, 'the body holds only ## The ask and ## Context: preamble'],
    [{ source: 'issue 0' }, operator, "source is issue N, or the operator's request"],
    [{}, operator, 'an issue brief has no ## The ask: crew start takes the issue body as the ask'],
    [{ source: 'operator request' }, BODY, "the body has no ## The ask; quote the operator's words there"],
    [{ source: 'operator request' }, '## The ask\n\n' + BODY, "the body has no ## The ask; quote the operator's words there"],
    [{ source: 'operator request' }, '## The ask\n> \n>\n' + BODY, "the body has no ## The ask; quote the operator's words there"],
    [{ source: 'operator request' }, '## The ask\n> >\n> > -\n' + BODY, "the body has no ## The ask; quote the operator's words there"],
    [{ source: 'operator request' }, '## The ask\nplain\n' + BODY, '## The ask quotes the source: every line starts with >: plain'],
    [{ source: 'operator request' }, '## The ask\n```\n> text\n```\n' + BODY, '## The ask quotes the source: every line starts with >: ```'],
    [{}, '', 'the body has no ## Context with at least one pointer'],
    [{}, '## Context\nplain\n', '## Context holds only bare pointers: each item is one or more code spans, issue N or PR N, with no other text: plain'],
    [{}, BODY + '- Never break the boot.\n', '## Context holds only bare pointers: each item is one or more code spans, issue N or PR N, with no other text: - Never break the boot.'],
    [{}, BODY + '```\ntext\n```\n', '## Context holds only bare pointers: each item is one or more code spans, issue N or PR N, with no other text: ```'],
  ]) assert.ok(parseBrief(brief(fields, body)).defects.includes(defect), defect)
})

// MUTATION: drop the end anchor and prose after a pointer passes.
test('## Context items are bare pointers: prose after a pointer or a continuation line is refused (ADR-055 §1)', () => {
  for (const line of ['- `crew/protocols.mjs` `parseBrief` ', '* issue 12', '- PR 34', '- `a`\tPR 34']) {
    assert.deepEqual(parseBrief(brief({}, `## Context\n${line}\n`)).defects, [], line)
  }
  for (const line of ['- `crew/agents.mjs`: what it checks.', '- PR 34 and more', '  continuation', '- see `x`', 'plain', '```']) {
    assert.deepEqual(parseBrief(brief({}, BODY + line + '\n')).defects, [
      `## Context holds only bare pointers: each item is one or more code spans, issue N or PR N, with no other text: ${line}`,
    ], line)
  }
})

test('a ## Context pointer outside the checkout or a link is refused, and code-span paths are returned (ADR-056 Amendment 1)', () => {
  for (const span of ['~/.crew/notes/x.md', '/abs/x.md', '../x.md', 'crew/../../x', 'https://x']) {
    const result = parseBrief(brief({}, `## Context\n- \`${span}\`\n`))
    assert.ok(result.defects.includes(`## Context points only inside the checkout (ADR-056 Amendment 1): ${span}`), span)
  }
  for (const link of ['[docs](https://example.com)', '[n](crew/a.mjs)']) {
    const line = `- ${link}`
    assert.ok(parseBrief(brief({}, `## Context\n${line}\n`)).defects.includes(`## Context holds only bare pointers: each item is one or more code spans, issue N or PR N, with no other text: ${line}`))
  }
  const result = parseBrief(brief({}, '## Context\n- `crew/protocols.mjs` `parseBrief` `agents/x.md`\n- `crew/protocols.mjs`\n- issue 12\n'))
  assert.deepEqual(result.defects, [])
  assert.deepEqual(result.paths, ['crew/protocols.mjs', 'agents/x.md'])
  assert.deepEqual(parseBrief('').paths, [])
  assert.deepEqual(parseBrief('---\n').paths, [])
})

// P5, the agent definition.
const BASE = { name: 'planner', description: 'Plan one lane.', role: 'planner', agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high' }
const agent = (fields = {}, body = 'Read [the notes](../notes/planner.md).\n') => {
  const front = Object.entries({ ...BASE, ...fields }).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')
  return `---\n${front}\n---\n${body}`
}
const defectsOf = (fields, needle) => parseAgent(agent(fields)).defects.filter((d) => d.includes(needle))

test('an agent definition may name muse as its agent', () => {
  assert.deepEqual(parseAgent(agent({ agent: 'muse', model: 'meta/muse-spark-1.3' })).defects, [])
})

// MUTATION: add a retired field to AGENT_FIELDS or a retired extension to EXTENSIONS.
test('AR2-AR4 refuses retired agent fields and extensions, accepts retained extensions', () => {
  const rows = [
    ...['codemode', 'edit_assist'].flatMap((field) => [true, false].map((value) => [{ [field]: value }, `unknown field ${field}`, new RegExp(`^unknown field ${field};`)])),
    ...['lab', 'builderloop', 'reminders'].map((name) => [{ extensions: [name] }, 'extensions', ['extensions is a list drawn from readgate, skeletonread, subagent, fff']]),
  ]
  for (const [fields, needle, expected] of rows) {
    const defects = defectsOf(fields, needle)
    if (expected instanceof RegExp) assert.match(defects[0], expected)
    else assert.deepEqual(defects, expected)
  }
  assert.deepEqual(parseAgent(agent({ extensions: ['readgate', 'skeletonread', 'subagent', 'fff'] })).defects, [])
})

// MUTATION: add fallback back to AGENT_FIELDS.
test('P5 refuses fallback as an unknown field, at the base and in a tier', () => {
  assert.ok(defectsOf({ fallback: [{ agent: 'pi', model: 'openai/x' }] }, 'unknown field fallback').length)
  assert.ok(defectsOf({ tiers: { judge: { fallback: [] } } }, 'tiers.judge.fallback cannot be overridden').length)
})

test('P5 the current agent example in ADR-052 parses with no defects', () => {
  const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../docs/adr/adr-052-agents-do-the-work.md'), 'utf8')
  const block = [...doc.matchAll(/```yaml\n([\s\S]*?)\n```/g)].at(-1)?.[1]
  assert.deepEqual(parseAgent(block).defects, [])
})

// MUTATION: add a path segment named for a retired extension.
test('AR5 crew has no paths named for retired extensions', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => [join(dir, entry.name), ...(entry.isDirectory() ? walk(join(dir, entry.name)) : [])])
  for (const path of walk(dirname(fileURLToPath(import.meta.url)))) assert.doesNotMatch(path.split('/').at(-1), /(?:^|[-_.])(lab|builderloop|reminders)(?:$|[-_.])/)
})

test('P5 roles are the five seats in canonical order', () => {
  assert.deepEqual(AGENT_ROLES, ['lead', 'planner', 'builder', 'reviewer', 'tech-lead'])
})

// MUTATION: drop a field type from the decode and its value arrives as a string or vanishes.
test('every P5 field decodes to its own type', () => {
  const full = {
    writes: 'task-dir', envelope: 'plan',
    skills: ['plan', 'qa-test-writing'], requires: ['qa-test-writing'], tools: ['read', 'bash'], extensions: ['readgate', 'fff'],
    advisor: { agent: 'pi', model: 'openai/gpt-6-astra', effort: 'high' },
    memory: false, rounds: 2, wait_s: 1800,
    tiers: { mechanical: { effort: 'medium' }, build: null, judge: { effort: 'xhigh', model: 'openai/changed' } },
  }
  const { fields, body, defects } = parseAgent(agent(full))
  assert.deepEqual(defects, [])
  assert.deepEqual(fields, { ...BASE, ...full })
  assert.equal(body, 'Read [the notes](../notes/planner.md).\n')
  assert.deepEqual(parseAgent(agent({ advisor: null, skills: [] })).fields.advisor, null)
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
  const cases = { name: '9bad', role: 'scout', agent: 'codex', effort: 'extreme', model: 'no-slash', writes: 'anywhere', memory: 2, rounds: 0, wait_s: -1, skills: { name: 'x' }, requires: [{}], tools: [7], extensions: 7, envelope: '' }
  for (const [key, value] of Object.entries(cases)) assert.equal(defectsOf({ [key]: value }, key).length >= 1, true, key)
  for (const model of ['a/b/c', '/id', 'provider/', 'Upper/id', 'p/i d']) assert.equal(defectsOf({ model }, 'model').length, 1, model)
  assert.equal(defectsOf({ extensions: ['readgate', 'nope'] }, 'extensions').length, 1)
  assert.equal(defectsOf({ rounds: '9007199254740993' }, 'rounds').length, 1)
})

// MUTATION: skip the JSON check and a malformed object is salvaged by the list splitter.
test('P5 malformed JSON is refused naming the field and JSON', () => {
  for (const [field, raw] of [['extensions', '["readgate",]'], ['tiers', '{"judge":'], ['advisor', '{bad}']]) {
    const found = defectsOf({ [field]: raw }, field)
    assert.equal(found.length, 1, field)
    assert.match(found[0], /JSON/)
  }
})

// MUTATION: drop the nested key checks and a misspelt advisor key is ignored.
test('P5 advisor objects are closed and complete', () => {
  assert.ok(defectsOf({ advisor: { agent: 'pi', model: 'openai/x', effort: 'high', surprise: true } }, 'advisor.surprise').length)
  assert.ok(defectsOf({ advisor: { agent: 'pi', model: 'openai/x' } }, 'advisor.effort is required').length)
  assert.ok(defectsOf({ advisor: { agent: 'pi', model: 'bad', effort: 'high' } }, 'advisor.model').length)
  assert.ok(defectsOf({ advisor: 'terra' }, 'advisor').length)
})

// MUTATION: validate only the base fields and a tier override can seat an unknown effort or agent.
test('P5 tier overrides are validated by path', () => {
  assert.ok(defectsOf({ tiers: { ultra: { effort: 'high' } } }, 'tiers.ultra is not a tier').length)
  assert.ok(defectsOf({ tiers: { judge: { effort: 'nope' } } }, 'tiers.judge.effort').length)
  assert.ok(defectsOf({ tiers: { judge: { surprise: 'x' } } }, 'tiers.judge.surprise').length)
  for (const key of ['name', 'description', 'role', 'tiers']) assert.ok(defectsOf({ tiers: { judge: { [key]: 'x' } } }, `tiers.judge.${key} cannot be overridden`).length, key)
  assert.ok(defectsOf({ tiers: { judge: 'high' } }, 'tiers.judge').length)
  assert.ok(defectsOf({ tiers: [] }, 'tiers').length)
  assert.ok(defectsOf({ tiers: { judge: { advisor: { agent: 'pi', model: 'bad', effort: 'high' } } } }, 'tiers.judge.advisor.model').length)
})

// P2, the seat envelope.
const DETAILS = {
  planner: { subject: 'fix(crew): name the lane change', plan_path: '/task/plan.md', tests: [] },
  builder: { summary: 'Implemented the change.' },
  reviewer: { verdict: 'pass', findings: [], requirements: [{ requirement: 'build it', status: 'met', evidence: 'read it' }], failure_modes: [], coverage: { read: ['lib.mjs'], complete: true } },
  'tech-lead': { verdict: 'pass', findings: [], requirements: [{ requirement: 'build it', status: 'met', evidence: 'read it' }], failure_modes: [], coverage: { read: ['lib.mjs'], complete: true } },
  lead: { decision: 'accept' },
}
const envelope = (role, overrides = {}) => ({ role, id: 'd1', status: 'done', summary: 'Completed.', details: structuredClone(DETAILS[role]), ...overrides })
const finding = (overrides = {}) => ({ id: 'RV1-1', severity: 'should-fix', location: 'crew/protocols.mjs:1', summary: 'Malformed input is accepted.', ...overrides })
const review = (findings, verdict = 'changes-needed', role = 'reviewer') => envelope(role, { details: { ...structuredClone(DETAILS[role]), verdict, findings } })
const refusedFor = (role, value, needle) => validateEnvelope(role, value).defects.filter((d) => d.includes(needle))

test('P2 vocabularies are closed and frozen', () => {
  assert.deepEqual(ENVELOPE_FIELDS, ['role', 'id', 'status', 'summary', 'details'])
  assert.deepEqual(ENVELOPE_STATUSES, ['done', 'insufficient', 'escalate'])
  assert.deepEqual(REVIEW_VERDICTS, ['pass', 'changes-needed'])
  assert.deepEqual(protocols.REQUIREMENT_STATUSES, ['met', 'unmet', 'human-verify'])
  assert.ok(Object.isFrozen(protocols.REQUIREMENT_STATUSES))
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
  for (const decision of LEAD_DECISIONS) assert.deepEqual(validateEnvelope('lead', envelope('lead', { details: { decision, ...(decision === 'bounce' ? { target: 'builder' } : {}) } })).defects, [])
  for (const verdict of REVIEW_VERDICTS) for (const role of ['reviewer', 'tech-lead']) assert.deepEqual(validateEnvelope(role, review(verdict === 'changes-needed' ? [finding()] : [], verdict, role)).defects, [])
})

test('P2 planner details require tests, a list of {file, title}, except on an archived return', () => {
  const value = envelope('planner')
  delete value.details.tests
  assert.ok(validateEnvelope('planner', value).defects.some((d) => d.includes('details.tests')))
  assert.deepEqual(validateEnvelope('planner', value, { archived: true }).defects, [])
  for (const tests of [null, {}, [{ file: '', title: 'x' }], [{ file: 'x', title: '' }], [{ file: 'x', title: 'y', extra: 1 }]]) {
    value.details.tests = tests
    for (const archived of [false, true]) assert.ok(validateEnvelope('planner', value, { archived }).defects.some((d) => d.includes('details.tests')))
  }
  value.details.tests = []
  assert.deepEqual(validateEnvelope('planner', value).defects, [])
  delete value.details.subject
  assert.ok(validateEnvelope('planner', value, { archived: true }).defects.some((d) => d.includes('details.subject')))
})

test('P2 a lead bounce names its target, builder or planner, and any escalate may carry a question', () => {
  for (const target of [undefined, '', 'reviewer', null]) {
    const value = envelope('lead', { details: { decision: 'bounce', ...(target === undefined ? {} : { target }) } })
    assert.ok(validateEnvelope('lead', value).defects.some((d) => d.includes('details.target')))
  }
  for (const target of ['builder', 'planner']) assert.deepEqual(validateEnvelope('lead', envelope('lead', { details: { decision: 'bounce', target } })).defects, [])
  for (const role of AGENT_ROLES) {
    const value = envelope(role, { status: 'escalate' })
    value.details.question = 'Which decision?'
    assert.deepEqual(validateEnvelope(role, value).defects, [])
    for (const question of ['', null, 1]) { value.details.question = question; assert.ok(validateEnvelope(role, value).defects.some((d) => d.includes('details.question'))) }
  }
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

test('P2 planner details need no acceptance and may carry a one-line judge reason (PD3)', () => {
  for (const extra of [{}, { judge: 'touches crew/loop.mjs' }]) {
    const value = envelope('planner'); Object.assign(value.details, extra)
    assert.deepEqual(validateEnvelope('planner', value).defects, [])
  }
  for (const judge of ['', 'a\nb', 5]) {
    const value = envelope('planner'); value.details.judge = judge
    assert.ok(refusedFor('planner', value, 'details.judge').length)
  }
})

// MUTATION: bypass DETAIL_RULES for subject and a malformed, overlong or control-bearing subject is accepted.
test('P2 planner details may carry the context its builder arms read, and refuse it malformed', () => {
  const full = envelope('planner'); Object.assign(full.details, { files_in_scope: ['crew/a.mjs'], validation_lane: 'node --test crew/a.test.mjs' })
  assert.deepEqual(validateEnvelope('planner', full).defects, [])
  assert.deepEqual(validateEnvelope('planner', envelope('planner')).defects, [], 'the fields are optional')
  for (const [key, bad] of [['files_in_scope', []], ['files_in_scope', 'a.mjs'], ['files_in_scope', ['a.mjs', '']], ['files_in_scope', [3]], ['validation_lane', ''], ['validation_lane', 5]]) {
    const value = envelope('planner'); value.details[key] = bad
    assert.equal(refusedFor('planner', value, `details.${key}`).length, 1, `${key} ${JSON.stringify(bad)}`)
  }
  for (const role of AGENT_ROLES.filter((role) => role !== 'planner')) {
    const value = envelope(role); value.details.files_in_scope = ['a.mjs']
    assert.ok(refusedFor(role, value, 'details.files_in_scope is not a field').length, role)
  }
})

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

// MUTATION: revert the subject defect to the type-less text.
test('P2 a refused subject names every accepted type', () => {
  const types = ['chore', 'ci', 'crew', 'docs', 'feat', 'fix', 'merge', 'perf', 'refactor', 'revert', 'spike', 'test', 'wip', 'workflow']
  for (const role of ['planner', 'builder']) {
    const value = envelope(role); value.details.subject = 'build(deps): bump undici'
    const defect = refusedFor(role, value, 'details.subject ')[0]
    assert.ok(defect, role)
    assert.deepEqual(defect.split('type one of ')[1]?.split(', '), types)
  }
})

// MUTATION: reject archived planner keys or accept builder mutations.
test('legacy planner fields are accepted only from an archived return', () => {
  const planner = envelope('planner')
  Object.assign(planner.details, { acceptance: null, gate_path: null, gate_cmd: 4, mutations: 'legacy' })
  for (const key of ['acceptance', 'gate_path', 'gate_cmd', 'mutations']) assert.ok(validateEnvelope('planner', planner).defects.includes(`details.${key} is not a field of planner details`))
  assert.deepEqual(validateEnvelope('planner', planner, { archived: true }).defects, [])
  const builder = envelope('builder'); builder.details.mutations = []
  assert.ok(refusedFor('builder', builder, 'details.mutations is not a field').length)
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
    for (const key of Object.keys(DETAILS[role]).filter((key) => role !== 'planner' || !['gate_path', 'mutations'].includes(key))) {
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
    for (const severity of FINDING_SEVERITIES) assert.deepEqual(validateEnvelope(role, review([finding({ severity, trigger: 'input' })], severity === 'consider' ? 'pass' : 'changes-needed', role)).defects, [])
    assert.deepEqual(validateEnvelope(role, review([finding({ severity: 'must-fix', trigger: 'input' })], 'changes-needed', role)).defects, [])
  }
})

// MUTATION: count any finding as actionable and a consider-only changes-needed validates clean.
test('P2 a reviewer or tech-lead changes-needed must list a must-fix or should-fix finding', () => {
  const defect = 'details.verdict is changes-needed but no finding is must-fix or should-fix'
  for (const role of ['reviewer', 'tech-lead']) {
    const consider = finding({ severity: 'consider' })
    for (const [findings, status, options, expected] of [
      [[], 'done', {}, [defect]],
      [[consider], 'done', {}, [defect]],
      [[consider, finding({ id: 'RV1-2' })], 'done', {}, []],
      [[finding({ severity: 'must-fix', trigger: 'input' })], 'done', {}, []],
      [[], 'done', { archived: true }, []],
      [[], 'escalate', {}, []],
      [[], 'insufficient', {}, []],
    ]) {
      const value = review(findings, 'changes-needed', role)
      value.status = status
      if (status === 'escalate') value.details.question = 'What should happen?'
      assert.deepEqual(validateEnvelope(role, value, options).defects, expected, `${role} ${status} ${JSON.stringify(findings)}`)
    }
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

test('P2 tech-lead details take the reviewer shape and its rules', () => {
  const role = 'tech-lead'
  assert.deepEqual(validateEnvelope(role, envelope(role)).defects, [])
  for (const key of ['requirements', 'failure_modes', 'coverage']) {
    const value = envelope(role); delete value.details[key]
    assert.ok(validateEnvelope(role, value).defects.includes(`details.${key} is required`))
    assert.deepEqual(validateEnvelope(role, value, { archived: true }).defects, [])
  }
  const cases = [
    [review([finding({ severity: 'must-fix' })], 'changes-needed', role), 'trigger'],
    [review(Array.from({ length: 6 }, (_, i) => finding({ id: `R${i}` })), 'changes-needed', role), 'five'],
    [envelope(role, { details: { ...structuredClone(DETAILS[role]), requirements: [{ requirement: 'x', status: 'unmet', evidence: 'x' }] } }), 'unmet'],
    [envelope(role, { details: { ...structuredClone(DETAILS[role]), coverage: { read: ['x'], complete: false } } }), 'incomplete'],
  ]
  for (const [value, needle] of cases) assert.ok(validateEnvelope(role, value).defects.some((d) => d.includes(needle)), needle)
  assert.ok(validateEnvelope(role, envelope(role), { prior: ['T1'] }).defects.some((d) => d.includes('prior finding T1')))
})

test('P2 reviewer details require requirements, failure modes and coverage, except on an archived return', () => {
  assert.deepEqual(validateEnvelope('reviewer', envelope('reviewer')).defects, [])
  for (const key of ['requirements', 'failure_modes', 'coverage']) {
    const value = envelope('reviewer'); delete value.details[key]
    assert.ok(validateEnvelope('reviewer', value).defects.includes(`details.${key} is required`))
  }
  const mode = { breaks: 'x', where: 'x', trigger: 'x', tested: true, covered: false }
  for (const [key, bad] of [['requirements', []], ['requirements', [{ requirement: 'x', status: 'wrong', evidence: 'x' }]], ['requirements', [{ requirement: 'x', status: 'met', evidence: 'x', extra: 1 }]], ['failure_modes', [mode, mode, mode, mode]], ['failure_modes', [{ ...mode, extra: 1 }]], ['failure_modes', [{ ...mode, tested: 'yes' }]], ['failure_modes', [{ ...mode, trigger: '' }]], ['coverage', { read: [], complete: true }], ['coverage', { read: ['x'], complete: 'yes' }], ['coverage', { read: ['x'], complete: true, extra: 1 }]]) {
    const value = envelope('reviewer'); value.details[key] = bad
    assert.ok(validateEnvelope('reviewer', value).defects.some((d) => d.startsWith(`details.${key}`)), key)
  }
  const old = review(Array.from({ length: 6 }, (_, i) => finding({ id: `R${i}`, severity: 'must-fix' })))
  delete old.details.requirements; delete old.details.failure_modes; delete old.details.coverage
  assert.ok(validateEnvelope('reviewer', old).defects.length)
  assert.deepEqual(validateEnvelope('reviewer', old, { archived: true }).defects, [])
  assert.deepEqual(validateEnvelope('tech-lead', review([], 'pass', 'tech-lead')).defects, [])
})

test('P2 a reviewer pass carries no unmet requirement and follows a complete review', () => {
  for (const [key, value] of [['requirements', [{ requirement: 'x', status: 'unmet', evidence: 'x' }]], ['coverage', { read: ['x'], complete: false }]]) {
    const result = envelope('reviewer'); result.details[key] = value
    assert.ok(validateEnvelope('reviewer', result).defects.some((d) => d.startsWith('details.verdict is pass')))
    result.details.verdict = 'changes-needed'
    result.details.findings = [finding()]
    assert.deepEqual(validateEnvelope('reviewer', result).defects, [])
  }
})

test('P2 a reviewer must-fix names its trigger, and at most five findings are listed with the rest counted', () => {
  for (const severity of FINDING_SEVERITIES) {
    const defects = validateEnvelope('reviewer', review([finding({ severity })])).defects
    assert.equal(defects.some((d) => d.startsWith('details.findings[0].trigger')), severity === 'must-fix')
  }
  for (const role of ['reviewer', 'tech-lead']) {
    const valid = finding({ trigger: 'x', uncertain: 'x', start_line: 1, end_line: 2 })
    assert.deepEqual(validateEnvelope(role, review([valid], 'changes-needed', role)).defects, [])
    for (const [key, bad] of [['trigger', ''], ['uncertain', null], ['start_line', 0], ['end_line', Number.MAX_SAFE_INTEGER + 1]]) {
      assert.ok(validateEnvelope(role, review([{ ...valid, [key]: bad }], 'changes-needed', role)).defects.some((d) => d.startsWith(`details.findings[0].${key}`)))
    }
  }
  const value = review(Array.from({ length: 6 }, (_, i) => finding({ id: `R${i}` })))
  assert.ok(validateEnvelope('reviewer', value).defects.some((d) => d.includes('five') && d.includes('details.findings_omitted')))
  value.details.findings.pop()
  for (const n of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) { value.details.findings_omitted = n; assert.ok(refusedFor('reviewer', value, 'details.findings_omitted').length) }
  value.details.findings_omitted = 1
  assert.deepEqual(validateEnvelope('reviewer', value).defects, [])
})

test('a builder envelope carries the tests it names and its notes, refused when malformed', () => {
  const sound = envelope('builder')
  sound.details.tests = [{ file: 'crew/a.test.mjs', title: 'a refuses b' }]
  sound.details.notes = 'relied on the suite for the unchanged parser'
  assert.deepEqual(validateEnvelope('builder', sound).defects, [])
  const none = envelope('builder'); none.details.tests = []
  assert.deepEqual(validateEnvelope('builder', none).defects, [])
  for (const [key, bad] of [['tests', 'x'], ['tests', [{ file: 'a.test.mjs' }]], ['tests', [{ file: 'a.test.mjs', title: '' }]], ['tests', [{ file: 'a', title: 't', extra: 1 }]], ['notes', ''], ['notes', 7]]) {
    const malformed = envelope('builder'); malformed.details[key] = bad
    assert.ok(refusedFor('builder', malformed, `details.${key}`).length, `${key} ${JSON.stringify(bad)}`)
  }
})
