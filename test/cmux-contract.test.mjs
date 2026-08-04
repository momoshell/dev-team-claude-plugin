import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'
import * as contract from '../scripts/cmux/contract.mjs'
import {
  validate, shouldArchive, slugify,
  OUTCOMES, NONCE_PREFIX, PROTECTED_PATH_COMPONENTS, SIGNAL_LIMITS, CMD_RE, CMUX_ALLOWS,
  TOOLS, DISALLOWED_TOOLS, GRANT_TOKENS, SECTION_HEADING_RE, SLICE_ID_RE,
  PANE_ROLES, SUBAGENT_ONLY,
} from '../scripts/cmux/contract.mjs'

const rosterSchema = JSON.parse(readFileSync(join(ROOT, 'scripts/cmux/roster.schema.json'), 'utf8'))
const roster = JSON.parse(readFileSync(join(ROOT, 'scripts/cmux/roster.default.json'), 'utf8'))
const dispatchRecordSchema = JSON.parse(readFileSync(join(ROOT, 'scripts/cmux/dispatch-record.schema.json'), 'utf8'))
const signalSchema = JSON.parse(readFileSync(join(ROOT, 'scripts/cmux/signal-record.schema.json'), 'utf8'))
const envelopeSchema = JSON.parse(readFileSync(join(ROOT, 'scripts/cmux/return-envelope.schema.json'), 'utf8'))

// ---------------------------------------------------------------------------
// Fixtures. One factory produces a fully valid terminate-state dispatch
// record (38 top-level fields, minItems 4 profile.allow, well-formed UUIDs,
// an ATTN token, ISO timestamps, a 64-hex sha256, absolute paths with no
// protected component, the eight-key env). create/bind states are derived
// from it. Every negative case is structuredClone(base) plus ONE mutation.
// ---------------------------------------------------------------------------

const DISPATCH_ID = '11111111-1111-1111-1111-111111111111'
const WORKSPACE_ID = '22222222-2222-2222-2222-222222222222'
const PANE_ID = '33333333-3333-3333-3333-333333333333'
const SURFACE_ID = '44444444-4444-4444-4444-444444444444'
const ATTN = `devteam-${DISPATCH_ID}-attn`
const SHA256 = '0123456789abcdef'.repeat(4)

function buildTerminateRecord() {
  return {
    schema_version: 2,
    dispatch_id: DISPATCH_ID,
    slice_id: 'be-1a',
    attempt: 1,
    task_id: 'be-1a task',
    task_slug: 'sample-repo-task',
    repo_slug: 'sample-repo',
    role: 'coder',
    agent: 'claude',
    model: 'sonnet',
    effort: 'medium',
    tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
    disallowed_tools: ['mcp__*', 'Task', 'Agent'],
    flags: { strict_mcp_config: true, disable_slash_commands: true },
    profile: {
      name: 'executor',
      permission_mode: 'dontAsk',
      grants: ['returns_write', 'signals_append', 'worktree_write', 'validation_commands'],
      allow: [
        'Bash(cmux notify *)',
        'Bash(cmux wait-for -S *)',
        'Bash(node --test)',
        'Edit(//abs/path/to/repo/**)',
      ],
      postcondition: 'changes_expected',
      postcondition_ignore: [],
    },
    role_prompt_path: '/abs/path/to/role-prompt.md',
    role_prompt_sha256: SHA256,
    return: { kind: 'json', schema_path: '/abs/path/to/coder-return.schema.json', required_sections: [], verdict_block: false },
    task_dir: '/abs/path/to/tasks/sample-repo/sample-repo-task',
    spec_path: '/abs/path/to/tasks/sample-repo/sample-repo-task/spec/be-1a.json',
    return_path: '/abs/path/to/tasks/sample-repo/sample-repo-task/returns/be-1a.1.json',
    signals_path: '/abs/path/to/tasks/sample-repo/sample-repo-task/signals/be-1a.1.jsonl',
    primary_checkout: '/abs/path/to/repo',
    isolation: 'worktree',
    worktree: {
      path: '/abs/path/to/worktrees/sample-repo/sample-repo-task/be-1a',
      branch: 'dt/sample-repo-task/be-1a',
      created_by_dispatcher: true,
      source_slice_id: null,
    },
    cwd: '/abs/path/to/worktrees/sample-repo/sample-repo-task/be-1a',
    env: {
      DEVTEAM_WORKER: '1',
      DEVTEAM_ROLE: 'coder',
      DEVTEAM_TASK_ID: 'be-1a task',
      DEVTEAM_DISPATCH_ID: DISPATCH_ID,
      DEVTEAM_TASK_DIR: '/abs/path/to/tasks/sample-repo/sample-repo-task',
      DEVTEAM_DISPATCH_RECORD: '/abs/path/to/tasks/sample-repo/sample-repo-task/dispatch/be-1a.1.json',
      DEVTEAM_SIGNAL_LOG: '/abs/path/to/tasks/sample-repo/sample-repo-task/signals/be-1a.1.jsonl',
      DEVTEAM_GATE_COUNTER: '/abs/path/to/tasks/sample-repo/sample-repo-task/be-1a.1.gate',
    },
    attn_parent: ATTN,
    attn_upstream: ATTN,
    kickoff: 'Implement the change described in the spec.',
    gate: { max_blocks: 2 },
    timeout_s: 1800,
    max_turns: null,
    surface: { workspace_id: WORKSPACE_ID, pane_id: PANE_ID, surface_id: SURFACE_ID },
    created_at: '2026-08-01T00:00:00.000Z',
    bound_at: '2026-08-01T00:00:01.000Z',
    ended_at: '2026-08-01T00:01:00.000Z',
    outcome: 'ok',
  }
}

function buildCreateRecord() {
  const rec = buildTerminateRecord()
  rec.surface = null
  rec.bound_at = null
  rec.ended_at = null
  rec.outcome = null
  return rec
}

function buildBindRecord() {
  const rec = buildTerminateRecord()
  rec.ended_at = null
  rec.outcome = null
  return rec
}

function buildSignal() {
  return { ts: '2026-08-01T00:00:00.000Z', level: 'progress', message: 'starting the task', escalate_to: 'lead' }
}

function buildEnvelopeJson() {
  return {
    schema_version: 1,
    dispatch_id: DISPATCH_ID,
    slice_id: 'be-1a',
    attempt: 1,
    role: 'coder',
    produced_at: '2026-08-01T00:01:00.000Z',
    body: { status: 'done', reason: 'ok' },
  }
}

function buildEnvelopeMarkdown() {
  return {
    schema_version: 1,
    dispatch_id: DISPATCH_ID,
    slice_id: 'be-1a',
    attempt: 1,
    role: 'code-reviewer',
    produced_at: '2026-08-01T00:01:00.000Z',
    body: '# Verdict\npass',
  }
}

// Asserts EXACTLY one violation (not just a matching first one) — a
// single-mutation negative that trips a second, unrelated constraint would
// otherwise pass this check vacuously.
function assertFirstViolation(violations, path, keyword) {
  assert.deepEqual(violations.map((v) => ({ path: v.path, keyword: v.keyword })), [{ path, keyword }])
}

// ---------------------------------------------------------------------------
// A2 — positives. Load-bearing: without these, every negative case below
// passes vacuously against a validator that rejects everything.
// ---------------------------------------------------------------------------

test('dispatch record create state validates clean', () => {
  assert.deepEqual(validate(dispatchRecordSchema, buildCreateRecord()), [])
})

test('dispatch record bind state validates clean', () => {
  assert.deepEqual(validate(dispatchRecordSchema, buildBindRecord()), [])
})

test('dispatch record terminate state validates clean', () => {
  assert.deepEqual(validate(dispatchRecordSchema, buildTerminateRecord()), [])
})

test('signal line validates clean', () => {
  assert.deepEqual(validate(signalSchema, buildSignal()), [])
})

test('return envelope with kind json (object body) validates clean', () => {
  assert.deepEqual(validate(envelopeSchema, buildEnvelopeJson()), [])
})

test('return envelope with kind markdown (string body) validates clean', () => {
  assert.deepEqual(validate(envelopeSchema, buildEnvelopeMarkdown()), [])
})

// ---------------------------------------------------------------------------
// A3 — negatives. Each mutates exactly one field off the valid base and
// asserts both the violation's path (names the mutated field) and keyword
// (names the constraint that failed).
// ---------------------------------------------------------------------------

test('negative: composed profile carrying a deny key', () => {
  const rec = buildTerminateRecord()
  rec.profile.deny = ['Bash(rm *)']
  assertFirstViolation(validate(dispatchRecordSchema, rec), '$.profile.deny', 'additionalProperties')
})

test('negative: composed profile carrying a tools key', () => {
  const rec = buildTerminateRecord()
  rec.profile.tools = ['Read']
  assertFirstViolation(validate(dispatchRecordSchema, rec), '$.profile.tools', 'additionalProperties')
})

test('negative: profile permission_mode "plan"', () => {
  const rec = buildTerminateRecord()
  rec.profile.permission_mode = 'plan'
  assertFirstViolation(validate(dispatchRecordSchema, rec), '$.profile.permission_mode', 'enum')
})

test('negative: an allow token outside the four-value enum (roster profile grants)', () => {
  const mutated = structuredClone(roster)
  mutated.profiles.executor.allow.push('bogus_token')
  const idx = mutated.profiles.executor.allow.length - 1
  assertFirstViolation(validate(rosterSchema, mutated), `$.profiles.executor.allow[${idx}]`, 'enum')
})

test('negative: a filesystem path field with a // double-slash prefix', () => {
  const rec = buildTerminateRecord()
  rec.task_dir = '//abs/path'
  assertFirstViolation(validate(dispatchRecordSchema, rec), '$.task_dir', 'pattern')
})

test('negative: a relative (non-absolute) path field', () => {
  const rec = buildTerminateRecord()
  rec.spec_path = 'relative/path/to/spec.json'
  assertFirstViolation(validate(dispatchRecordSchema, rec), '$.spec_path', 'pattern')
})

test('negative: postcondition_ignore entry starting with /', () => {
  const rec = buildTerminateRecord()
  rec.profile.postcondition_ignore = ['/x']
  assertFirstViolation(validate(dispatchRecordSchema, rec), '$.profile.postcondition_ignore[0]', 'pattern')
})

test('negative: postcondition_ignore entry containing ..', () => {
  const rec = buildTerminateRecord()
  rec.profile.postcondition_ignore = ['a/../b']
  assertFirstViolation(validate(dispatchRecordSchema, rec), '$.profile.postcondition_ignore[0]', 'pattern')
})

test('negative: env object with a ninth key', () => {
  const rec = buildTerminateRecord()
  rec.env.DEVTEAM_EXTRA = 'x'
  assertFirstViolation(validate(dispatchRecordSchema, rec), '$.env.DEVTEAM_EXTRA', 'additionalProperties')
})

test('negative: env missing DEVTEAM_GATE_COUNTER', () => {
  const rec = buildTerminateRecord()
  delete rec.env.DEVTEAM_GATE_COUNTER
  assertFirstViolation(validate(dispatchRecordSchema, rec), '$.env.DEVTEAM_GATE_COUNTER', 'required')
})

test('negative: flags.strict_mcp_config false', () => {
  const rec = buildTerminateRecord()
  rec.flags.strict_mcp_config = false
  assertFirstViolation(validate(dispatchRecordSchema, rec), '$.flags.strict_mcp_config', 'const')
})

test('negative: a positional surface_id such as surface:9', () => {
  const rec = buildTerminateRecord()
  rec.surface.surface_id = 'surface:9'
  assertFirstViolation(validate(dispatchRecordSchema, rec), '$.surface.surface_id', 'pattern')
})

for (const badSliceId of ['be)1a', 'be 1a', 'be*1a', 'be..1a']) {
  test(`negative: slice_id containing a forbidden character (${JSON.stringify(badSliceId)})`, () => {
    const rec = buildTerminateRecord()
    rec.slice_id = badSliceId
    assertFirstViolation(validate(dispatchRecordSchema, rec), '$.slice_id', 'pattern')
  })
}

test('negative: composed profile.allow entry Write(//x/**) — rule-kind whitelist', () => {
  const rec = buildTerminateRecord()
  rec.profile.allow.push('Write(//x/**)')
  const idx = rec.profile.allow.length - 1
  assertFirstViolation(validate(dispatchRecordSchema, rec), `$.profile.allow[${idx}]`, 'pattern')
})

test('negative: composed profile.allow entry Edit(/x) — single-slash, must be //-anchored', () => {
  const rec = buildTerminateRecord()
  rec.profile.allow.push('Edit(/x)')
  const idx = rec.profile.allow.length - 1
  assertFirstViolation(validate(dispatchRecordSchema, rec), `$.profile.allow[${idx}]`, 'pattern')
})

test('negative: a malformed attn_parent', () => {
  const rec = buildTerminateRecord()
  rec.attn_parent = 'not-an-attn-token'
  assertFirstViolation(validate(dispatchRecordSchema, rec), '$.attn_parent', 'pattern')
})

const SCHEMA_VERSION_CASES = [
  ['roster.schema.json', () => rosterSchema, () => structuredClone(roster), 2],
  ['dispatch-record.schema.json', () => dispatchRecordSchema, () => buildTerminateRecord(), 3],
  ['signal-record.schema.json', () => signalSchema, () => ({ ...buildSignal(), schema_version: 1 }), 2],
  ['return-envelope.schema.json', () => envelopeSchema, () => buildEnvelopeJson(), 2],
]

for (const [name, getSchema, getInstance, tooNewVersion] of SCHEMA_VERSION_CASES) {
  test(`negative: schema_version ${tooNewVersion} on ${name} yields exactly one schema_version_too_new violation`, () => {
    const instance = getInstance()
    instance.schema_version = tooNewVersion
    const violations = validate(getSchema(), instance)
    assert.equal(violations.length, 1)
    assert.equal(violations[0].path, '$.schema_version')
    assert.equal(violations[0].keyword, 'schema_version_too_new')
  })
}

// ---------------------------------------------------------------------------
// A3 — non-validate() cases. These are NOT validate() failures; they are
// constant-driven checks the caller layers on top of validate().
// ---------------------------------------------------------------------------

test('non-validate: NONCE_PREFIX is absent from a valid record (substring scan over serialized bytes)', () => {
  // The nonce ban is a substring scan over JSON bytes, not a schema keyword —
  // no field in the record schema can express "must not contain this token".
  assert.equal(JSON.stringify(buildTerminateRecord()).includes(NONCE_PREFIX), false)
})

test('non-validate: a record whose kickoff embeds NONCE_PREFIX is caught by the substring scan', () => {
  const rec = buildTerminateRecord()
  rec.kickoff = `finish and touch ${NONCE_PREFIX}abc123`
  assert.equal(JSON.stringify(rec).includes(NONCE_PREFIX), true)
})

test('non-validate: CMD_RE accepts real validation commands', () => {
  for (const cmd of ['node --test', 'npm test -- items', 'npm run typecheck', 'pytest tests/foo -k thing']) {
    assert.ok(CMD_RE.test(cmd), `expected CMD_RE to accept: ${cmd}`)
  }
})

for (const cmd of ['a; rm -rf /', 'a | b', 'a $(b)', 'a"b', "a'b", 'a(b)', 'a\nb']) {
  test(`non-validate: CMD_RE rejects a command with a shell metacharacter (${JSON.stringify(cmd)})`, () => {
    assert.equal(CMD_RE.test(cmd), false)
  })
}

test('non-validate: a command containing .. is rejected by the separate no-dot-dot check even though CMD_RE alone admits it', () => {
  const cmd = 'node ../evil.js'
  // CMD_RE's charset includes `.`, so it alone ADMITS this string.
  assert.ok(CMD_RE.test(cmd), 'CMD_RE charset includes the dot, so it matches here')
  // The frozen rule is "matches CMD_RE AND contains no .." — the dot-dot
  // check is a separate, additional gate.
  const isAllowedCommand = CMD_RE.test(cmd) && !cmd.includes('..')
  assert.equal(isAllowedCommand, false)
})

// ---------------------------------------------------------------------------
// A4 — shouldArchive
// ---------------------------------------------------------------------------

for (const outcome of [...OUTCOMES, null]) {
  test(`shouldArchive: task outcome ${JSON.stringify(outcome)} yields ${outcome === 'ok' ? 'false' : 'true'}`, () => {
    assert.equal(shouldArchive({ outcome }, []), outcome !== 'ok')
  })
}

test('shouldArchive: a non-ok task outcome with all-ok dispatches yields true', () => {
  assert.equal(shouldArchive({ outcome: 'exit_nonzero' }, [{ outcome: 'ok' }, { outcome: 'ok' }]), true)
})

test('shouldArchive: an empty dispatch list with an ok task yields false', () => {
  assert.equal(shouldArchive({ outcome: 'ok' }, []), false)
})

test('shouldArchive: a dispatch object with no outcome property at all yields true (fail closed)', () => {
  assert.equal(shouldArchive({ outcome: 'ok' }, [{}]), true)
})

// ---------------------------------------------------------------------------
// A5 — SIGNAL_LIMITS vs the signal schema's write-time bound
// ---------------------------------------------------------------------------

test('signal-record.schema.json message pattern is exactly ^.{1,2000}$ (write-time bound)', () => {
  assert.equal(signalSchema.properties.message.pattern, '^.{1,2000}$')
})

test('SIGNAL_LIMITS.message_max_chars is 200 (relay-time truncation) and is never reconciled with the write-time bound', () => {
  assert.equal(SIGNAL_LIMITS.message_max_chars, 200)
})

test('SIGNAL_LIMITS deep-equals the frozen shape', () => {
  assert.deepEqual(SIGNAL_LIMITS, { max_relayed_per_dispatch: 5, min_interval_s: 30, message_max_chars: 200 })
})

test('signal-record.schema.json top-level description contains the numerals 5, 30, 200 and 2000', () => {
  for (const n of ['5', '30', '200', '2000']) {
    assert.ok(signalSchema.description.includes(n), `description missing numeral ${n}`)
  }
})

// ---------------------------------------------------------------------------
// A8 — slugify
// ---------------------------------------------------------------------------

test('slugify: path-traversal-shaped inputs produce a clean slug with no dot or slash', () => {
  for (const input of ['../etc/passwd', '/abs/path', 'a/../b']) {
    const slug = slugify(input)
    assert.ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug), `slug for ${input} is "${slug}"`)
    assert.equal(slug.includes('.'), false)
    assert.equal(slug.includes('/'), false)
  }
})

test('slugify: unicode diacritics fold to ASCII', () => {
  assert.equal(slugify('Café Déjà Vu'), 'cafe-deja-vu')
})

test('slugify: truncates to at most 60 characters with no trailing hyphen', () => {
  const slug = slugify('a'.repeat(70))
  assert.ok(slug.length <= 60)
  assert.equal(slug.endsWith('-'), false)
})

for (const bad of ['', '   ', '!!!']) {
  test(`slugify: throws rather than returning an empty slug for ${JSON.stringify(bad)}`, () => {
    assert.throws(() => slugify(bad))
  })
}

// ---------------------------------------------------------------------------
// Drift guards
// ---------------------------------------------------------------------------

test('BUDGET deep-equals the array extracted from test/schema.test.mjs source text', () => {
  const src = readFileSync(join(ROOT, 'test', 'schema.test.mjs'), 'utf8')
  const m = src.match(/const BUDGET = \[([^\]]*)\]/)
  assert.ok(m, 'expected a BUDGET array literal in test/schema.test.mjs')
  const extracted = m[1].split(',').map((s) => s.trim().replace(/^'(.*)'$/, '$1'))
  assert.deepEqual(extracted, contract.BUDGET)
})

test('PROTECTED_PATH_COMPONENTS is set-equal (bidirectional) to the ABSNP pattern alternation in dispatch-record.schema.json', () => {
  const pattern = dispatchRecordSchema.properties.primary_checkout.pattern
  const m = pattern.match(/\\\.\(([^)]+)\)/)
  assert.ok(m, 'expected an escaped-dot alternation group in the ABSNP pattern')
  const fromPattern = new Set(m[1].split('|'))
  const fromConstant = new Set(PROTECTED_PATH_COMPONENTS.map((c) => c.replace(/^\./, '')))
  assert.deepEqual(fromPattern, fromConstant)
})

test('negative: primary_checkout containing a protected path component', () => {
  const rec = buildTerminateRecord()
  rec.primary_checkout = '/abs/.claude/x'
  assertFirstViolation(validate(dispatchRecordSchema, rec), '$.primary_checkout', 'pattern')
})

test('negative: worktree.path containing a protected path component', () => {
  const rec = buildTerminateRecord()
  rec.worktree.path = '/abs/.git/x'
  assertFirstViolation(validate(dispatchRecordSchema, rec), '$.worktree.path', 'pattern')
})

test('CMUX_ALLOWS is a two-element array whose literals appear byte-identically in the composed profile fixture allow', () => {
  assert.equal(CMUX_ALLOWS.length, 2)
  const rec = buildTerminateRecord()
  for (const literal of CMUX_ALLOWS) {
    assert.ok(rec.profile.allow.includes(literal), `composed profile.allow missing literal: ${literal}`)
  }
})

test('TOOLS deep-equals dispatch-record.schema.json properties.tools.items.enum', () => {
  assert.deepEqual(dispatchRecordSchema.properties.tools.items.enum, TOOLS)
})

test('DISALLOWED_TOOLS deep-equals dispatch-record.schema.json properties.disallowed_tools.items.enum', () => {
  assert.deepEqual(dispatchRecordSchema.properties.disallowed_tools.items.enum, DISALLOWED_TOOLS)
})

test('GRANT_TOKENS deep-equals dispatch-record.schema.json properties.profile.properties.grants.items.enum', () => {
  assert.deepEqual(dispatchRecordSchema.properties.profile.properties.grants.items.enum, GRANT_TOKENS)
})

test('PANE_ROLES deep-equals the seven-role be-06-01 literal, and PANE_ROLES ∩ SUBAGENT_ONLY is empty', () => {
  assert.deepEqual(PANE_ROLES, ['coder', 'plan-reviewer', 'architecture-lead', 'backend-lead', 'frontend-lead', 'devops-lead', 'qa-lead'])
  const intersection = PANE_ROLES.filter((r) => SUBAGENT_ONLY.includes(r))
  assert.deepEqual(intersection, [])
})

test('[...OUTCOMES, null] deep-equals dispatch-record.schema.json properties.outcome.enum', () => {
  assert.deepEqual(dispatchRecordSchema.properties.outcome.enum, [...OUTCOMES, null])
})

test('SLICE_ID_RE.source matches dispatch-record.schema.json properties.slice_id pattern', () => {
  assert.equal(dispatchRecordSchema.properties.slice_id.pattern, SLICE_ID_RE.source)
})

test('SLICE_ID_RE.source matches dispatch-record.schema.json properties.worktree.properties.source_slice_id pattern', () => {
  assert.equal(dispatchRecordSchema.properties.worktree.properties.source_slice_id.pattern, SLICE_ID_RE.source)
})

test('SLICE_ID_RE.source matches return-envelope.schema.json properties.slice_id pattern', () => {
  assert.equal(envelopeSchema.properties.slice_id.pattern, SLICE_ID_RE.source)
})

// ---------------------------------------------------------------------------
// Throw-vs-return coverage (M1) — a schema problem always THROWS (a
// programmer error); an instance problem always RETURNS a Violation[].
// ---------------------------------------------------------------------------

test('validate throws for a schema key outside BUDGET (maxLength)', () => {
  const schema = { type: 'object', properties: { x: { type: 'string', maxLength: 5 } } }
  assert.throws(() => validate(schema, { x: 'ok' }))
})

test('validate throws for a schema type value that names no real JSON-Schema type', () => {
  assert.throws(() => validate({ type: 'strung' }, 'x'))
})

test('validate throws when required is not an array of strings', () => {
  assert.throws(() => validate({ type: 'object', required: 'name' }, {}))
})

test('validate throws when additionalProperties is a string instead of false/object', () => {
  assert.throws(() => validate({ type: 'object', additionalProperties: 'no' }, {}))
})

test('validate throws when items is true instead of a schema object', () => {
  assert.throws(() => validate({ type: 'array', items: true }, []))
})

test('validate throws when enum is a string instead of a non-empty array', () => {
  assert.throws(() => validate({ type: 'string', enum: 'abc' }, 'a'))
})

test('validate RETURNS a non-empty Violation[] (never throws) for a wildly malformed instance', () => {
  const rec = buildTerminateRecord()
  rec.schema_version = 'one'
  rec.tools = 'Read'
  rec.flags = null
  rec.env = []
  rec.timeout_s = 'a lot'
  rec.surface = 'nope'
  const violations = validate(dispatchRecordSchema, rec)
  assert.ok(Array.isArray(violations))
  assert.ok(violations.length > 0)
})

// ---------------------------------------------------------------------------
// SECTION_HEADING_RE
// ---------------------------------------------------------------------------

test('SECTION_HEADING_RE extracts heading text via matchAll, ignoring non-headings and trailing whitespace', () => {
  const md = [
    '# Verdict',
    '',
    'Some prose line, not a heading.',
    '## Must-fix   ',
    '###### Deeply nested',
    '#xnoSpace not a heading',
    '### Notes',
  ].join('\n')
  const headings = [...md.matchAll(SECTION_HEADING_RE)].map((m) => m[1])
  assert.deepEqual(headings, ['Verdict', 'Must-fix', 'Deeply nested', 'Notes'])
})

// ---------------------------------------------------------------------------
// kickoff literal-naming description (guards against reintroducing the
// completion nonce / parent-side state paths via a worker-authored kickoff)
// ---------------------------------------------------------------------------

test('dispatch-record.schema.json kickoff node description names all seven kickoff literals', () => {
  const description = dispatchRecordSchema.properties.kickoff.description || ''
  const literals = ['dispatch_id', 'task_dir', 'spec_path', 'return_path', 'signals_path', 'attn_parent', 'attn_upstream']
  for (const lit of literals) {
    assert.ok(description.includes(lit), `kickoff description missing literal: ${lit}`)
  }
})

// ---------------------------------------------------------------------------
// Export-surface meta-test
// ---------------------------------------------------------------------------

test('contract.mjs exports exactly the 3 functions + 16 constants of the frozen surface', () => {
  const expected = new Set([
    'validate', 'shouldArchive', 'slugify',
    'BUDGET', 'TOOLS', 'DISALLOWED_TOOLS', 'CMUX_ALLOWS', 'GRANT_TOKENS', 'OUTCOMES',
    'NONCE_PREFIX', 'PROTECTED_PATH_COMPONENTS', 'SIGNAL_LIMITS', 'SECTION_HEADING_RE',
    'MODEL_ALIASES', 'SUBAGENT_ONLY', 'PANE_ROLES', 'SLICE_ID_RE', 'CMD_RE',
    'WORKER_BLOCKED_STATUSES',
  ])
  assert.deepEqual(new Set(Object.keys(contract)), expected)
  assert.equal('resolveRole' in contract, false)
  assert.equal('expandGrants' in contract, false)
})

// ---------------------------------------------------------------------------
// Substrate-agnostic surfaces. Was A9 ("slice-1a ships inert everywhere except
// README.md") — superseded by slice 1d, which wired cmux mode into
// orchestration.md and commands/team.md on purpose, and narrowed again by
// issue #7, which wired commands/ship.md (teardown) and commands/onboard.md
// (cmux prerequisite check + roster seeding) on purpose. Those four are
// exempt here and carry their own POSITIVE assertions instead:
// test/orchestration.test.mjs pins all four orchestration.md deltas + the
// exactly-one-cmux-reference invariant, test/commands.test.mjs pins team.md's
// `mode cmux|agent-tool` and `roster <role>=<agent>:<model>` verbs plus
// ship.md's teardown step and onboard.md's cmux check / config keys / roster
// seeding.
// What survives is the part of A9 that still means something after #7:
//   - team-build.workflow.mjs never learns about cmux — workflow mode stays on
//     the Workflow tool's agent() primitive (1d carve-out).
//   - hooks/hooks.json never learns about cmux — the worker guard keys on a
//     neutral env var (DEVTEAM_WORKER), never on cmux/roster knowledge.
//   - every command other than team.md/ship.md/onboard.md stays
//     substrate-agnostic. A NEW command is substrate-agnostic by default: it
//     must be added to GUARDED_COMMANDS deliberately, which is what the
//     closed-manifest assertion below forces.
// ---------------------------------------------------------------------------

const CMUX_WIRED_SURFACES = new Set([
  'orchestration.md',
  join('commands', 'team.md'),
  join('commands', 'ship.md'),
  join('commands', 'onboard.md'),
])
const GUARDED_COMMANDS = ['next.md', 'pr-review.md']

test('cmux/roster stay absent from the substrate-agnostic surfaces', () => {
  // The exemptions must still exist under those exact names — a rename must
  // fail here, never silently widen the exemption.
  for (const rel of CMUX_WIRED_SURFACES) {
    assert.ok(existsSync(join(ROOT, rel)), `exempt surface is missing: ${rel}`)
  }

  const guardedCommands = readdirSync(join(ROOT, 'commands'))
    .filter((f) => f.endsWith('.md') && !CMUX_WIRED_SURFACES.has(join('commands', f)))
    .sort()
  // Completeness against a closed manifest, not a rejection-only walk: an
  // empty or mis-globbed list would satisfy every assertion below.
  assert.deepEqual(guardedCommands, GUARDED_COMMANDS)

  const files = [
    join(ROOT, 'team-build.workflow.mjs'),
    join(ROOT, 'hooks', 'hooks.json'),
    ...guardedCommands.map((f) => join(ROOT, 'commands', f)),
  ]
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    assert.equal(/cmux/i.test(src), false, `${f} contains "cmux"`)
    assert.equal(/roster/i.test(src), false, `${f} contains "roster"`)
  }
})
