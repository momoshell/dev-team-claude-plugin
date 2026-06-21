import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, loadWorkflowSource } from './helpers.mjs'

// The structured-output tool's input_schema rejects conditional JSON-Schema
// keywords. Any of these in a tool-facing schema breaks every agent call that
// uses it (this is the bug that killed workflow-mode coders). Keep schemas flat.
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

for (const f of ['coder-return.schema.json', 'handover-spec.schema.json']) {
  test(`${f}: valid JSON, no conditional keywords`, () => {
    const schema = JSON.parse(readFileSync(join(ROOT, f), 'utf8'))
    const hits = []
    findConditionalKeys(schema, f, hits)
    assert.equal(hits.length, 0, `conditional keyword(s): ${hits.join(', ')}`)
  })
}

test('workflow inline schemas use no conditional JSON-Schema keywords', () => {
  const src = loadWorkflowSource()
  // Match the KEY form (e.g. `allOf:`), not bare prose — comments may legitimately
  // mention these keywords to explain why they're banned.
  const forbidden = [/\ballOf\s*:/, /\banyOf\s*:/, /\boneOf\s*:/, /\bif:\s*\{/, /\bthen:\s*[[{]/]
  const found = forbidden.filter((re) => re.test(src)).map((re) => re.source)
  assert.equal(found.length, 0, `forbidden schema keyword(s) in workflow source: ${found.join(', ')}`)
})
