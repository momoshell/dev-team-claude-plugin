import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from '../test/helpers.mjs'

test('lane-core helpers are defined once, in crew/lane-core.mjs', () => {
  const modules = {
    'finish.mjs': ['LANE', 'isObject'],
    'record-pr.mjs': ['LANE', 'isObject', 'within'],
    'closeout.mjs': ['LANE', 'isObject', 'within'],
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

test('lane-core.mjs is zero-dependency and exports the shared helpers', async () => {
  const file = new URL('lane-core.mjs', import.meta.url)
  assert.ok(existsSync(file), 'lane-core.mjs exists')
  const source = readFileSync(file, 'utf8')
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((match) => match[1])
  assert.ok(imports.length > 0)
  assert.ok(imports.every((specifier) => specifier.startsWith('node:')), imports.join(', '))
  const { LANE, isObject, within, HEX_OID, describeError, GIT_STATUS_ARGS } = await import('./lane-core.mjs')
  for (const [slug, valid] of [['demo', true], ['b1544-lane-helpers', true], ['-x', false], ['Demo', false], ['a'.repeat(64), false]]) assert.equal(LANE.test(slug), valid, slug)
  for (const [value, valid] of [[null, false], [[], false], [{}, true]]) assert.equal(isObject(value), valid)
  const root = scratchDir('lane-core-')
  const dir = join(root, 'lane'), sibling = join(root, 'sibling'), fileInLane = join(dir, 'file')
  mkdirSync(dir)
  writeFileSync(fileInLane, '')
  writeFileSync(sibling, '')
  for (const [path, valid] of [[fileInLane, true], [dir, true], [sibling, false], [join(dir, 'missing'), false]]) assert.equal(within(dir, path), valid, path)
  for (const [oid, valid] of [['a'.repeat(40), true], ['f'.repeat(64), true], ['a'.repeat(39), false]]) assert.equal(HEX_OID.test(oid), valid)
  assert.deepEqual(describeError('x'), { code: null, message: 'x' })
  assert.deepEqual(GIT_STATUS_ARGS, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  assert.ok(Object.isFrozen(GIT_STATUS_ARGS))
})
