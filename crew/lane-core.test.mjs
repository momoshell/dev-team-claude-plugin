import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('lane-core helpers are defined once, in crew/lane-core.mjs', () => {
  const modules = {
    'finish.mjs': ['LANE', 'isObject', 'parseJournalRows'],
    'record-pr.mjs': ['LANE', 'parseJournalRows', 'within'],
    'closeout.mjs': ['LANE', 'isObject', 'parseJournalRows', 'within'],
    'show.mjs': ['LANE', 'isObject'],
    'start.mjs': ['LANE'],
    'loop.mjs': ['HEX_OID', 'describeError', 'GIT_STATUS_ARGS'],
    'checks.mjs': ['HEX_OID', 'describeError', 'GIT_STATUS_ARGS'],
  }
  for (const [file, names] of Object.entries(modules)) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    const imported = /import\s*\{([^}]+)\}\s*from\s*['"]\.\/lane-core\.mjs['"]/.exec(source)
    assert.ok(imported, `${file} imports lane-core`)
    for (const name of names) assert.match(imported[1], new RegExp(`\\b${name}\\b`), `${file} imports ${name}`)
    if (names.includes('LANE')) assert.doesNotMatch(source, /^\s*const LANE\s*=\s*\//m, file)
    if (names.includes('isObject')) assert.doesNotMatch(source, /^\s*const isObject\s*=/m, file)
    if (names.includes('within')) assert.doesNotMatch(source, /^function within\(/m, file)
    if (names.includes('HEX_OID')) {
      assert.doesNotMatch(source, /^const HEX_OID\s*=/m, file)
      assert.doesNotMatch(source, /^const (describe|describeError)\s*=/m, file)
    }
  }
  const loop = readFileSync(new URL('loop.mjs', import.meta.url), 'utf8')
  assert.ok((loop.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n').match(/'--porcelain=v1'/g) ?? []).length <= 1)
  assert.equal((loop.match(/\.\.\.GIT_STATUS_ARGS/g) ?? []).length, 1)
  for (const name of ['base-paths', 'review-paths', 'paths', 'post-rebase-clean']) assert.ok(loop.includes(`readStatus('${name}')`), name)
  const checks = readFileSync(new URL('checks.mjs', import.meta.url), 'utf8')
  assert.equal((checks.match(/\.\.\.GIT_STATUS_ARGS/g) ?? []).length, 2)
  assert.doesNotMatch(checks, /'--porcelain=v1'/)
  const body = /export function composeLanePrBody\([^]*?\n}/.exec(checks)?.[0]
  assert.ok(body)
  assert.doesNotMatch(body, /\/#\(\\d\+\)\/g/)
  assert.match(body, /withoutIssueTokens\(body\)/)
})
