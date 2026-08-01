import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, loadWorkflowSource } from './helpers.mjs'

// The structured-output tool's input_schema rejects conditional JSON-Schema
// keywords. Any of these in a tool-facing schema breaks every agent call that
// uses it (this is the bug that killed workflow-mode coders). Keep schemas flat.
//
// The cmux schemas are validated by a hand-rolled validator in
// scripts/cmux/contract.mjs; every keyword outside the BUDGET allow-list below
// is code nobody has written, so the budget walk is a positive allow-list
// that cannot go stale — a blacklist already had, missing
// contains/patternProperties/dependentRequired/$defs.
const COND_KEYS = ['allOf', 'anyOf', 'oneOf', 'if', 'then', 'else', '$ref']

function findConditionalKeys(node, path, hits) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => findConditionalKeys(v, `${path}[${i}]`, hits))
  } else if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      if (COND_KEYS.includes(k)) hits.push(`${path}.${k}`)
      findConditionalKeys(node[k], `${path}.${k}`, hits)
    }
  }
}

for (const f of ['coder-return.schema.json', 'handover-spec.schema.json', 'scripts/cmux/roster.schema.json', 'scripts/cmux/dispatch-record.schema.json', 'scripts/cmux/signal-record.schema.json', 'scripts/cmux/return-envelope.schema.json']) {
  test(`${f}: valid JSON, no conditional keywords`, () => {
    const schema = JSON.parse(readFileSync(join(ROOT, f), 'utf8'))
    const hits = []
    findConditionalKeys(schema, f, hits)
    assert.equal(hits.length, 0, `conditional keyword(s): ${hits.join(', ')}`)
  })
}

// Positive keyword-budget walk for the cmux contract schemas: every key that
// appears on a schema node must be in this allow-list. be-1a-B extracts this
// literal from this file's source text with a regex, so name, quoting and
// single-line layout are part of the contract — do not reformat.
const BUDGET = ['$schema', 'title', 'description', 'type', 'required', 'properties', 'additionalProperties', 'items', 'enum', 'const', 'pattern', 'minimum', 'maximum', 'minItems', 'uniqueItems']

function findOutOfBudgetKeys(node, path, hits) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return
  for (const k of Object.keys(node)) {
    if (!BUDGET.includes(k)) hits.push(`${path}.${k}`)
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const name of Object.keys(node.properties)) {
      findOutOfBudgetKeys(node.properties[name], `${path}.properties.${name}`, hits)
    }
  }
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    findOutOfBudgetKeys(node.additionalProperties, `${path}.additionalProperties`, hits)
  }
  if (node.items) {
    findOutOfBudgetKeys(node.items, `${path}.items`, hits)
  }
}

const CMUX_SCHEMAS = ['scripts/cmux/roster.schema.json', 'scripts/cmux/dispatch-record.schema.json', 'scripts/cmux/signal-record.schema.json', 'scripts/cmux/return-envelope.schema.json']

for (const f of CMUX_SCHEMAS) {
  test(`${f}: keyword budget — every schema-node key is in BUDGET`, () => {
    const schema = JSON.parse(readFileSync(join(ROOT, f), 'utf8'))
    const hits = []
    findOutOfBudgetKeys(schema, f, hits)
    assert.equal(hits.length, 0, `out-of-budget keyword(s): ${hits.join(', ')}`)
  })

  test(`${f}: carries the required top-level shape`, () => {
    const schema = JSON.parse(readFileSync(join(ROOT, f), 'utf8'))
    for (const key of ['$schema', 'title', 'description', 'type', 'required', 'additionalProperties']) {
      assert.ok(key in schema, `missing top-level key: ${key}`)
    }
  })
}

test('scripts/cmux/roster.default.json: valid JSON', () => {
  JSON.parse(readFileSync(join(ROOT, 'scripts/cmux/roster.default.json'), 'utf8'))
})

test('workflow inline schemas use no conditional JSON-Schema keywords', () => {
  const src = loadWorkflowSource()
  // Match the KEY form (e.g. `allOf:`), not bare prose — comments may legitimately
  // mention these keywords to explain why they're banned.
  const forbidden = [/\ballOf\s*:/, /\banyOf\s*:/, /\boneOf\s*:/, /\bif:\s*\{/, /\bthen:\s*[[{]/]
  const found = forbidden.filter((re) => re.test(src)).map((re) => re.source)
  assert.equal(found.length, 0, `forbidden schema keyword(s) in workflow source: ${found.join(', ')}`)
})
