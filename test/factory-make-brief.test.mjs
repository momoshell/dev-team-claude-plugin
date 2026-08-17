// test/factory-make-brief.test.mjs — the unskippable, filesystem-only lane for
// the brief compiler. Every fixture is a staged git checkout in one temporary
// module root; no live crew tree is read or written.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from './helpers.mjs'
import {
  ACCEPTANCE_GATE_BLOCK, BROAD_KEY_HIT_LIMIT, CONVENTIONS_BLOCK,
  REFUSAL_REASONS, SLOT_MARKER, discoverTripwires, extractKeys,
  gatherProtectedPaths, main, proposeTier, validateAsk, verifyWhere,
} from '../scripts/factory/make-brief.mjs'
import { defaultProfilePath, probeRepo } from '../scripts/factory/probe-repo.mjs'

const SCRIPT = join(ROOT, 'scripts', 'factory', 'make-brief.mjs')
const fixtureRoot = mkdtempSync(join(tmpdir(), 'factory-make-brief-'))
const EMPTY_FACTORY = join(fixtureRoot, 'empty-factory')
mkdirSync(EMPTY_FACTORY)
after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

let fixtureNumber = 0
function nextRoot(label) {
  fixtureNumber += 1
  const root = join(fixtureRoot, `${String(fixtureNumber).padStart(2, '0')}-${label}`)
  mkdirSync(root, { recursive: true })
  return root
}

function put(root, relative, body) {
  const target = join(root, relative)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, body)
  return target
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`)
  return result
}

function fixture(label, { scripts = 'node --test', broad = false } = {}) {
  const root = nextRoot(label)
  const packageData = { name: `brief-${label}`, private: true, type: 'module' }
  if (scripts !== null) packageData.scripts = { test: scripts }
  put(root, 'package.json', `${JSON.stringify(packageData, null, 2)}\n`)
  put(root, 'lib/widget.mjs', [
    "export const WIDGET_CACHE_FILE = 'out/widget.json'",
    "export function computeWidget(n) { return n + 1 }",
    "export { computeWidget as computeWidgetAlias }",
    "const error = 'cache:miss'",
    'void error',
    '',
  ].join('\n'))
  put(root, 'config/thing.yml', 'ttl_seconds: 30\n')
  put(root, 'test/widget.test.mjs', [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { computeWidget } from '../lib/widget.mjs'",
    "test('computeWidget adds one', () => { assert.equal(computeWidget(1), 2) })",
    '',
  ].join('\n'))
  put(root, 'test/reads-config.test.mjs', [
    "import { test } from 'node:test'",
    "import { readFileSync } from 'node:fs'",
    "test('config path is pinned', () => { readFileSync('config/thing.yml', 'utf8') })",
    '',
  ].join('\n'))
  if (broad) {
    put(root, 'lib/broad.mjs', "export const BROAD_PIN = 'out/broad.json'\n")
    for (let index = 0; index < BROAD_KEY_HIT_LIMIT + 2; index += 1) {
      put(root, `test/broad-${String(index).padStart(2, '0')}.test.mjs`, [
        "import { test } from 'node:test'",
        "import { BROAD_PIN } from '../lib/broad.mjs'",
        `test('broad pin ${index}', () => { void BROAD_PIN })`,
        '',
      ].join('\n'))
    }
  }
  git(root, ['init', '-q'])
  git(root, ['add', '-A'])
  return root
}

const ASK = 'Make the widget cache honour a 30s TTL — never round it, never "fix" the units.'
const DONE = 'A widget older than 30s is refetched, and the refetch reason is recorded verbatim.\nThe reason keeps punctuation.'
const OUT = 'The retry backoff (owned by another lane) and the schema of config/thing.yml.'

function request(root, overrides = {}, name = 'request.json') {
  const body = { ask: ASK, where: ['lib/widget.mjs', 'config/thing.yml'], done_means: DONE, out_of_scope: OUT, ...overrides }
  return put(root, name, `${JSON.stringify(body, null, 2)}\n`)
}

function run(root, args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DEVTEAM_FACTORY_DIR: EMPTY_FACTORY, ...env },
  })
}

function compile(root, overrides = {}, extra = [], outName = 'brief.md', env = {}) {
  const requestPath = request(root, overrides)
  const outPath = join(root, outName)
  const result = run(root, ['--request', requestPath, '--checkout', root, '--out', outPath, ...extra], env)
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  return { result, outPath, brief: readFileSync(outPath, 'utf8') }
}

function section(brief, heading) {
  const lines = brief.split('\n')
  const start = lines.findIndex((line) => line.trim() === heading)
  assert.notEqual(start, -1, `missing ${heading}`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^## /.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

function ratified(value) {
  return {
    status: 'ratified',
    value,
    source: 'test fixture',
    ratified_by: 'factory test',
    ratified_at: '2026-08-17T00:00:00.000Z',
  }
}

function proposed(value) {
  return { status: 'proposed', value, source: 'test fixture' }
}

function unknown(reason = 'no_test_command') {
  return { status: 'unknown', value: null, reason }
}

function profile(label, fields) {
  const path = join(fixtureRoot, 'profiles', `${label}.json`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({
    schema: 1,
    profile_version: 1,
    repo_key: `fixture__${label}`,
    repo_slug: label,
    fields,
    meta: { probed_at: '2026-08-17T00:00:00.000Z', probed_from: fixtureRoot },
  }, null, 2)}\n`)
  return path
}

test('the four authored lines are carried verbatim and compilation is idempotent', () => {
  const root = fixture('verbatim')
  const first = compile(root, {}, [], 'first.md').brief
  const second = compile(root, {}, [], 'second.md').brief
  for (const line of [ASK, DONE, OUT]) assert.ok(first.includes(line))
  assert.ok(first.includes('lib/widget.mjs'))
  assert.match(first, /## Proposed tier/)
  assert.equal(first, second)
})

test('a missing where path refuses by name and a blank ask refuses', () => {
  const root = fixture('refusals')
  const missing = run(root, ['--request', request(root, { where: ['lib/nope.mjs'] }), '--checkout', root])
  assert.equal(missing.status, 2)
  assert.match(`${missing.stderr}${missing.stdout}`, /lib\/nope\.mjs/)
  const blank = run(root, ['--request', request(root, { ask: '   ' }), '--checkout', root])
  assert.equal(blank.status, 2)
  assert.match(blank.stderr, /blank-ask/)
})

test('validateAsk rejects short and heading-restating asks, while genuine asks pass', () => {
  assert.throws(() => validateAsk('one two', 'widget-cache-ttl'), (error) => error.reason === 'missing-line')
  assert.throws(() => validateAsk('widget cache ttl', 'widget-cache-ttl'), (error) => error.reason === 'restating-ask')
  assert.doesNotThrow(() => validateAsk('Make the cache observable', 'widget-cache-ttl'))
})

test('an unknown top-level request key is a tagged refusal', () => {
  const root = fixture('unknown-key')
  const result = run(root, ['--request', request(root, { surprise: true }), '--checkout', root])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /unknown-key/)
})

test('the path key finds a test pinning a non-code file', () => {
  const root = fixture('non-code')
  const { brief } = compile(root)
  assert.match(brief, /test\/reads-config\.test\.mjs/)
  assert.match(brief, /config\/thing\.yml/)
})

test('extractKeys independently finds exports, codes, written paths, and basenames', () => {
  const keys = extractKeys([
    'export const PublicValue = 1',
    'export async function runThing() {}',
    'export { hidden as PublicAlias, plain }',
    "const code = 'cache:miss'",
    "const output = 'var/cache/result.json'",
    'void [code, output]',
  ].join('\n'), 'lib/example.mjs')
  for (const key of [
    'PublicValue', 'runThing', 'PublicAlias', 'plain', 'cache:miss',
    'var/cache/result.json', 'result.json', 'lib/example.mjs',
  ]) assert.ok(keys.includes(key), `${key} missing from ${keys}`)
  assert.ok(!keys.includes('foo'))
  assert.deepEqual(keys, [...keys].sort())
})

test('exported symbols, error codes, and written filenames each find their test', () => {
  const root = fixture('key-kinds')
  put(root, 'test/keys.test.mjs', [
    "import { test } from 'node:test'",
    "import { computeWidget, computeWidgetAlias } from '../lib/widget.mjs'",
    "test('computeWidgetAlias cache:miss out/widget.json', () => { void computeWidget })",
    '',
  ].join('\n'))
  put(root, 'test/symbol-pin.test.mjs', [
    "import { test } from 'node:test'",
    "test('symbol pin computeWidget', () => {})",
    '',
  ].join('\n'))
  put(root, 'test/error-pin.test.mjs', [
    "import { test } from 'node:test'",
    "test('error pin cache:miss', () => {})",
    '',
  ].join('\n'))
  put(root, 'test/written-pin.test.mjs', [
    "import { test } from 'node:test'",
    "test('written filename pin out/widget.json', () => {})",
    '',
  ].join('\n'))
  git(root, ['add', '-A'])
  const { brief } = compile(root)
  const tripwireBody = section(brief, '## Tripwires')
  assert.match(tripwireBody, /- test\/symbol-pin\.test\.mjs · .*computeWidget/)
  assert.match(tripwireBody, /- test\/error-pin\.test\.mjs · .*cache:miss/)
  assert.match(tripwireBody, /- test\/written-pin\.test\.mjs · .*out\/widget\.json/)
  assert.match(brief, /grep -rn/)
})

test('broad keys are reported with counts and are not tripwires', () => {
  const root = fixture('broad', { broad: true })
  const { brief } = compile(root, { where: ['lib/broad.mjs'] })
  assert.match(brief, /broad keys \(not used as tripwires\)/)
  const broadLine = brief.split('\n').find((line) => line.includes('BROAD_PIN') && line.includes('hits'))
  assert.ok(broadLine)
  const hitCount = Number(broadLine.match(/(\d+) hits/)[1])
  assert.ok(hitCount > BROAD_KEY_HIT_LIMIT)
  const tripwireSection = section(brief, '## Tripwires')
  assert.doesNotMatch(tripwireSection, /test\/broad-.*BROAD_PIN/)
})

test('baseline is measured, colour-neutral, and absent test scripts are unknown', () => {
  const root = fixture('baseline')
  const { brief } = compile(root, {}, [], 'brief.md', { FORCE_COLOR: '3' })
  const body = section(brief, '## Baseline')
  assert.match(body, /pass 2/)
  assert.match(body, /fail 0/)
  assert.doesNotMatch(body, /unknown/)

  const dead = fixture('no-suite', { scripts: null })
  const deadBrief = compile(dead).brief
  const deadBody = section(deadBrief, '## Baseline')
  assert.match(deadBody, /unknown/)
  assert.doesNotMatch(deadBody, /\b0\b/)
})

test('a ratified profile test_command becomes the measured lane and states its basis', () => {
  const root = fixture('profile-ratified-lane')
  const lane = 'node --test test/widget.test.mjs'
  const profilePath = profile('ratified-lane', { test_command: ratified(lane) })
  const { brief } = compile(root, {}, ['--profile', profilePath])
  const body = section(brief, '## Baseline')
  assert.match(body, /lane: node --test test\/widget\.test\.mjs · pass 1/)
  assert.match(body, /lane basis: ratified profile field test_command/)
})

test('a proposed profile test_command is not consumed and names the package fallback', () => {
  const root = fixture('profile-proposed-lane')
  const proposedLane = 'node --test test/widget.test.mjs --proposed-lane'
  const profilePath = profile('proposed-lane', { test_command: proposed(proposedLane) })
  const { brief } = compile(root, {}, ['--profile', profilePath])
  const body = section(brief, '## Baseline')
  assert.match(body, /lane: node --test · pass 2/)
  assert.doesNotMatch(body, /--proposed-lane/)
  assert.match(body, /lane basis: package\.json scripts\.test — profile field test_command is proposed, not ratified/)
})

test('an unknown profile test_command is not consumed because only ratified cells count', () => {
  const root = fixture('profile-unknown-lane')
  const profilePath = profile('unknown-lane', { test_command: unknown() })
  const { brief } = compile(root, {}, ['--profile', profilePath])
  const body = section(brief, '## Baseline')
  assert.match(body, /lane: node --test · pass 2/)
  assert.match(body, /profile field test_command is unknown, not ratified/)
})

test('an absent profile compiles with its path and unreadable reason stated', () => {
  const root = fixture('profile-absent')
  const profilePath = join(fixtureRoot, 'profiles', 'missing-profile.json')
  const { brief } = compile(root, {}, ['--profile', profilePath])
  const body = section(brief, '## Baseline')
  assert.match(body, /no profile at .*missing-profile\.json \(profile-unreadable\)/)
  assert.match(body, /lane basis: package\.json scripts\.test — no profile at/)
})

test('--require-profile refuses unreadable and unratified profiles by distinct reasons', () => {
  const root = fixture('profile-required')
  const missingPath = join(fixtureRoot, 'profiles', 'required-missing.json')
  const missing = run(root, [
    '--request', request(root), '--checkout', root,
    '--require-profile', '--profile', missingPath,
  ])
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /profile-unreadable/)

  const proposedPath = profile('required-proposed', { test_command: proposed('node --test --proposed') })
  const proposedResult = run(root, [
    '--request', request(root), '--checkout', root,
    '--require-profile', '--profile', proposedPath,
  ])
  assert.equal(proposedResult.status, 2)
  assert.match(proposedResult.stderr, /profile-unratified/)
})

test('a recorded baseline count is named unused while the compile measures fresh counts', () => {
  const root = fixture('profile-stale-baseline')
  const lane = 'node --test test/widget.test.mjs'
  const profilePath = profile('stale-baseline', {
    test_command: ratified(lane),
    baseline: ratified({ tests: 4242, passed: 4242, failed: 0 }),
  })
  const { brief } = compile(root, {}, ['--profile', profilePath])
  const baseline = section(brief, '## Baseline')
  const validation = section(brief, '## Validation lane')
  assert.match(baseline, /pass 1/)
  assert.match(baseline, /profile records passed 4242, not used/)
  assert.doesNotMatch(`${baseline}\n${validation}`, /pass 4242/)
})

test('the default profile path is used when no --profile flag is supplied', () => {
  const root = fixture('profile-default-path')
  const factoryRoot = join(fixtureRoot, 'default-profile-factory')
  mkdirSync(join(factoryRoot, 'profiles'), { recursive: true })
  const repoKey = probeRepo({ checkout: root }).repo_key
  const target = defaultProfilePath({ repoKey, factoryRoot })
  writeFileSync(target, `${JSON.stringify({
    schema: 1,
    profile_version: 1,
    repo_key: repoKey,
    repo_slug: 'default-path',
    fields: { test_command: ratified('node --test test/widget.test.mjs') },
    meta: { probed_at: '2026-08-17T00:00:00.000Z' },
  }, null, 2)}\n`)
  const { brief } = compile(root, {}, [], 'default-path.md', { DEVTEAM_FACTORY_DIR: factoryRoot })
  const body = section(brief, '## Baseline')
  assert.match(body, /lane basis: ratified profile field test_command/)
  assert.match(body, new RegExp(target.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')))
})

test('--profile overrides the default profile path and names the override', () => {
  const root = fixture('profile-override')
  const factoryRoot = join(fixtureRoot, 'override-profile-factory')
  mkdirSync(join(factoryRoot, 'profiles'), { recursive: true })
  const repoKey = probeRepo({ checkout: root }).repo_key
  const defaultPath = defaultProfilePath({ repoKey, factoryRoot })
  writeFileSync(defaultPath, `${JSON.stringify({
    schema: 1,
    profile_version: 1,
    repo_key: repoKey,
    repo_slug: 'override-default',
    fields: { test_command: ratified('node --test') },
    meta: { probed_at: '2026-08-17T00:00:00.000Z' },
  }, null, 2)}\n`)
  const explicitPath = profile('override-explicit', {
    test_command: ratified('node --test test/widget.test.mjs'),
  })
  const { brief } = compile(root, {}, ['--profile', explicitPath], 'override.md', {
    DEVTEAM_FACTORY_DIR: factoryRoot,
  })
  const body = section(brief, '## Baseline')
  assert.match(body, /lane: node --test test\/widget\.test\.mjs · pass 1/)
  assert.doesNotMatch(body, /lane: node --test · pass 2/)
  assert.match(body, new RegExp(explicitPath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')))
})

test('ratified convention files render with their basis and malformed files are unavailable', () => {
  const root = fixture('profile-conventions')
  const conventionPath = profile('conventions', {
    test_command: ratified('node --test'),
    conventions: ratified({ files: ['.claude/', 'README.md', 'docs/adr/', 'docs/conventions.md'] }),
  })
  const { brief } = compile(root, {}, ['--profile', conventionPath], 'conventions.md')
  const conventions = section(brief, '## Conventions')
  assert.match(conventions, /conventions of record \(basis: ratified profile field conventions/)
  assert.match(conventions, /\.claude\/, README\.md, docs\/adr\/, docs\/conventions\.md/)

  const malformedPath = profile('conventions-malformed', {
    test_command: ratified('node --test'),
    conventions: ratified({ files: 'README.md' }),
  })
  const malformed = compile(root, {}, ['--profile', malformedPath], 'conventions-malformed.md').brief
  const malformedConventions = section(malformed, '## Conventions')
  assert.match(malformedConventions, /conventions of record: \(not available\)/)
  assert.match(malformedConventions, /value\.files must be an array of strings/)
})

test('fences are sorted and no fence register is explicit when omitted', () => {
  const root = fixture('fences')
  const fencesPath = put(root, 'fences.json', JSON.stringify({
    lanes: [
      { lane: '99-retry-backoff', files: ['lib/retry.mjs', 'test/retry.test.mjs'] },
      { lane: '12-other', files: ['docs/other.md'] },
    ],
  }, null, 2) + '\n')
  const withFences = compile(root, {}, ['--fences', fencesPath]).brief
  assert.match(withFences, /12-other owns docs\/other\.md/)
  assert.match(withFences, /99-retry-backoff owns lib\/retry\.mjs/)
  const fenceBody = section(withFences, '## Fences')
  assert.ok(fenceBody.indexOf('12-other') < fenceBody.indexOf('99-retry-backoff'))
  const without = compile(fixture('no-fences')).brief
  assert.match(section(without, '## Fences'), /no fence register supplied \(`--fences` not given\)/)
})

test('a named lane declares its fence as the write surface and keeps discovery distinct', () => {
  const root = fixture('named-lane')
  const fencesPath = put(root, 'fences.json', JSON.stringify({
    lanes: [
      { lane: 'own', files: ['lib/widget.mjs', 'test/widget-new.test.mjs'] },
      { lane: 'other', files: ['test/reads-config.test.mjs'] },
    ],
  }, null, 2) + '\n')
  const { brief } = compile(root, {}, ['--fences', fencesPath, '--lane', 'own'])
  const conventions = section(brief, '## Conventions')
  const writeLine = conventions.split('\n').find((line) => line.startsWith('files_in_scope'))
  const readLine = conventions.split('\n').find((line) => line.startsWith('read-and-keep-green'))
  assert.equal(writeLine, 'files_in_scope (expected write surface; basis: fence register, lane "own"): lib/widget.mjs, test/widget-new.test.mjs')
  assert.ok(readLine)
  assert.match(readLine, /test\/widget\.test\.mjs/)
  assert.doesNotMatch(writeLine, /test\/(?:reads-config\.test|widget\.test)\.mjs/)
  const writeFiles = writeLine.slice(writeLine.indexOf('): ') + 3).split(', ')
  const readFiles = readLine.slice(readLine.indexOf(': ') + 2).split(', ')
  assert.ok(writeFiles.every((file) => !readFiles.includes(file)))
})

test('an unknown lane and a lane without fences both refuse with unknown-lane', () => {
  const root = fixture('unknown-lane')
  const fencesPath = put(root, 'fences.json', JSON.stringify({
    lanes: [{ lane: 'own', files: ['lib/widget.mjs'] }],
  }) + '\n')
  const unknown = run(root, [
    '--request', request(root), '--checkout', root,
    '--fences', fencesPath, '--lane', 'nope',
  ])
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /unknown-lane/)
  const withoutFences = run(root, [
    '--request', request(root), '--checkout', root, '--lane', 'own',
  ])
  assert.equal(withoutFences.status, 2)
  assert.match(withoutFences.stderr, /unknown-lane/)
  assert.ok(REFUSAL_REASONS.includes('unknown-lane'))
})

test('without fences the write surface is the authored where paths and names its basis', () => {
  const root = fixture('authored-where')
  const { brief } = compile(root)
  const conventions = section(brief, '## Conventions')
  const writeLine = conventions.split('\n').find((line) => line.startsWith('files_in_scope'))
  const readLine = conventions.split('\n').find((line) => line.startsWith('read-and-keep-green'))
  assert.equal(writeLine, 'files_in_scope (expected write surface; basis: authored where paths, no lane fence applied): config/thing.yml, lib/widget.mjs')
  assert.doesNotMatch(writeLine, /test\/widget\.test\.mjs/)
  assert.match(readLine, /test\/widget\.test\.mjs/)
})

test('the lane is never inferred from the output filename', () => {
  const root = fixture('lane-output-name')
  const fencesPath = put(root, 'fences.json', JSON.stringify({
    lanes: [
      { lane: 'own', files: ['lib/widget.mjs', 'test/widget-new.test.mjs'] },
      { lane: 'other', files: ['test/reads-config.test.mjs'] },
    ],
  }, null, 2) + '\n')
  const { brief } = compile(root, {}, ['--fences', fencesPath, '--lane', 'own'], 'other.md')
  const writeLine = section(brief, '## Conventions')
    .split('\n').find((line) => line.startsWith('files_in_scope'))
  assert.equal(writeLine, 'files_in_scope (expected write surface; basis: fence register, lane "own"): lib/widget.mjs, test/widget-new.test.mjs')
})

test('standing blocks and unfilled slots render verbatim', () => {
  const root = fixture('standing')
  const { brief } = compile(root)
  assert.ok(brief.includes(ACCEPTANCE_GATE_BLOCK))
  assert.ok(brief.includes(CONVENTIONS_BLOCK))
  assert.ok(brief.includes('GATE-SUMMARY {"total":n,"failed":n,"errored":n}'))
  assert.ok(brief.includes('#153'))
  assert.ok(brief.includes('#168'))
  assert.ok(brief.includes('#240'))
  assert.ok(brief.includes('#137'))
  assert.ok(brief.includes('Co-Authored-By'))
  assert.ok(brief.includes('Never push'))
  assert.ok(brief.includes('ReturnEnvelope'))
  assert.ok(brief.split(SLOT_MARKER).length - 1 >= 2)
})

test('out refusal and force overwrite follow the CLI contract', () => {
  const root = fixture('out-contract')
  const requestPath = request(root)
  const out = join(root, 'result.md')
  let result = run(root, ['--request', requestPath, '--checkout', root, '--out', out])
  assert.equal(result.status, 0)
  result = run(root, ['--request', requestPath, '--checkout', root, '--out', out])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /out-exists/)
  result = run(root, ['--request', requestPath, '--checkout', root, '--out', out, '--force'])
  assert.equal(result.status, 0)
  const outputDirectory = join(root, 'output-directory')
  mkdirSync(outputDirectory)
  result = run(root, ['--request', requestPath, '--checkout', root, '--out', outputDirectory, '--force'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /out-exists/)
  result = run(root, ['--request', requestPath, '--checkout', root, '--out', join(root, 'missing', 'brief.md')])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /out-dir-missing/)
})

test('a nested git checkout resolves to the repository root', () => {
  const root = fixture('nested-checkout')
  const nested = join(root, 'scripts', 'factory')
  mkdirSync(nested, { recursive: true })
  const requestPath = request(root, { where: ['lib/widget.mjs'] })
  const outPath = join(root, 'nested-brief.md')
  const result = spawnSync(process.execPath, [
    SCRIPT, '--request', requestPath, '--out', outPath,
  ], {
    cwd: nested,
    encoding: 'utf8',
    env: { ...process.env, DEVTEAM_FACTORY_DIR: EMPTY_FACTORY },
  })
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  const brief = readFileSync(outPath, 'utf8')
  assert.match(section(brief, '## Baseline'), /pass 2/)
  assert.match(brief, /test\/widget\.test\.mjs/)
})

test('directory where entries expand for discovery while the authored directory is rendered', () => {
  const root = fixture('directory')
  const { brief } = compile(root, { where: ['lib'] })
  assert.match(section(brief, '## Where'), /verified · directory · lib/)
  assert.match(brief, /computeWidget/)
})

test('one-file scopes render a marked mechanical proposal with reasons', () => {
  const root = fixture('one-file-proposal')
  const { brief } = compile(root, { where: ['lib/widget.mjs'] })
  const body = section(brief, '## Proposed tier')
  assert.match(body, /PROPOSAL ONLY/)
  assert.match(body, /proposed tier: mechanical/)
  assert.match(body, /^- .+/m)
  assert.ok(brief.indexOf('## The ask') < brief.indexOf('## Proposed tier'))
  assert.ok(brief.indexOf('## Proposed tier') < brief.indexOf('## Where'))
})

test('directory breadth proposes a higher tier and explains its source count', () => {
  const root = fixture('directory-proposal', { broad: true })
  const { brief } = compile(root, { where: ['lib'] })
  const body = section(brief, '## Proposed tier')
  assert.match(body, /proposed tier: (build|judge)/)
  assert.match(body, /scope breadth: 2 source files/)
})

test('proposeTier pins breadth bands, directory raises, and tripwire-floor raises', () => {
  const proposal = (sourceCount, extra = {}) => proposeTier({
    where: Array.from({ length: sourceCount }, (_, index) => ({
      path: `lib/source-${index}.mjs`, kind: 'file',
    })),
    discovery: {
      candidates: Array.from({ length: sourceCount }, (_, index) => `lib/source-${index}.mjs`),
      tripwires: [],
      broadKeys: [],
    },
    ...extra,
  })
  assert.equal(proposal(1).tier, 'mechanical')
  assert.equal(proposal(2).tier, 'build')
  assert.equal(proposal(4).tier, 'build')
  assert.equal(proposal(5).tier, 'judge')

  const directory = proposeTier({
    where: [{ path: 'lib', kind: 'directory' }],
    discovery: { candidates: ['lib/source.mjs'], tripwires: [], broadKeys: [] },
  })
  assert.equal(directory.tier, 'build')
  assert.match(directory.reasons.join('\n'), /directory.*lib.*mechanical.*build/i)

  const floor = proposal(1, {
    discovery: {
      candidates: ['lib/source-0.mjs', ...Array.from({ length: 6 }, (_, index) => `test/pin-${index}.test.mjs`)],
      tripwires: Array.from({ length: 6 }, (_, index) => ({ file: `test/pin-${index}.test.mjs`, keys: [] })),
      broadKeys: [],
    },
  })
  assert.equal(floor.tier, 'build')
  assert.match(floor.reasons.join('\n'), /6 tripwire tests.*mechanical.*build/i)
})

test('protected paths default empty, raise one step, match directory prefixes, and reject malformed input', () => {
  const where = [{ path: 'lib/widget.mjs', kind: 'file' }]
  const discovery = {
    candidates: ['lib/widget.mjs', 'test/widget.test.mjs'],
    tripwires: [{ file: 'test/widget.test.mjs', keys: ['computeWidget'] }],
    broadKeys: [],
  }
  const omitted = proposeTier({ where, discovery })
  const empty = proposeTier({ where, discovery, protectedPaths: [] })
  assert.equal(omitted.tier, empty.tier)
  const raised = proposeTier({ where, discovery, protectedPaths: ['lib/widget.mjs'] })
  assert.equal(raised.tier, 'build')
  assert.deepEqual(raised.signals.protectedHits, ['lib/widget.mjs'])
  assert.match(raised.reasons.join('\n'), /protected path hit: lib\/widget\.mjs.*raised mechanical.*build/)

  const prefix = proposeTier({
    where,
    discovery,
    protectedPaths: ['test/'],
  })
  assert.equal(prefix.tier, 'build')
  assert.deepEqual(prefix.signals.protectedHits, ['test/widget.test.mjs'])

  const judge = proposeTier({
    where: Array.from({ length: 5 }, (_, index) => ({ path: `lib/${index}.mjs`, kind: 'file' })),
    discovery: {
      candidates: Array.from({ length: 5 }, (_, index) => `lib/${index}.mjs`),
      tripwires: [],
      broadKeys: [],
    },
    protectedPaths: ['lib/0.mjs'],
  })
  assert.equal(judge.tier, 'judge')
  assert.match(judge.reasons.join('\n'), /protected path hit: lib\/0\.mjs.*unchanged/i)
  assert.throws(() => proposeTier({ where, discovery, protectedPaths: 'lib/widget.mjs' }), (error) => error.reason === 'bad-protected')
  assert.throws(() => proposeTier({ where, discovery, protectedPaths: ['   '] }), (error) => error.reason === 'bad-protected')
})

test('protected file input is normalized, deduped, and wired through the CLI', () => {
  const root = fixture('protected-file')
  const protectedPath = put(root, 'protected.json', JSON.stringify({ paths: ['./lib/widget.mjs', 'lib\\widget.mjs', './lib/widget.mjs'] }) + '\n')
  assert.deepEqual(gatherProtectedPaths({ protectedPathsFile: protectedPath }), ['lib/widget.mjs'])
  const { brief } = compile(root, { where: ['lib/widget.mjs'] }, ['--protected', protectedPath])
  assert.match(section(brief, '## Proposed tier'), /proposed tier: build/)
  assert.match(section(brief, '## Proposed tier'), /lib\/widget\.mjs/)

  const malformed = put(root, 'bad-protected.json', '{"paths":"lib/widget.mjs"}\n')
  const result = run(root, [
    '--request', request(root, { where: ['lib/widget.mjs'] }), '--checkout', root,
    '--protected', malformed,
  ])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /bad-protected/)
})

test('absence cases return no proposal with reasons and render no proposal', () => {
  const emptyWhere = proposeTier({ where: [], discovery: { candidates: ['lib/a.mjs'], tripwires: [], broadKeys: [] } })
  assert.equal(emptyWhere.tier, null)
  assert.ok(emptyWhere.reasons.length)
  const emptyCandidates = proposeTier({ where: [{ path: 'lib/a.mjs', kind: 'file' }], discovery: { candidates: [], tripwires: [], broadKeys: [] } })
  assert.equal(emptyCandidates.tier, null)
  assert.ok(emptyCandidates.reasons.length)
  assert.deepEqual(emptyCandidates.signals.directoryWhere, [])
  const suppressed = proposeTier({
    where: [{ path: 'lib/a.mjs', kind: 'file' }],
    discovery: { candidates: ['lib/a.mjs'], tripwires: [], broadKeys: [{ key: 'a', count: 99 }, { key: 'b', count: 99 }] },
  })
  assert.equal(suppressed.tier, null)
  assert.match(suppressed.reasons[0], /2 key\(s\).*absent, not zero/)

  const root = fixture('no-proposal-render', { broad: true })
  const { brief } = compile(root, { where: ['lib/broad.mjs'] })
  const body = section(brief, '## Proposed tier')
  assert.match(body, /proposed tier: no proposal/)
  assert.match(body, /^- .+/m)
})

test('shape proposal stays deferred while tier proposal wiring is present', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  assert.match(source, /export function proposeTier/)
  assert.doesNotMatch(source, /--blueprint|proposeBlueprint/i)
  assert.doesNotMatch(source, /^##+\s*(Shape|Blueprint)\b/im)
})

test('the parser returns a refusal code for an unknown CLI option', () => {
  assert.equal(main(['--bogus']), 2)
  assert.equal(new Set(REFUSAL_REASONS).size, REFUSAL_REASONS.length)
  assert.equal(REFUSAL_REASONS.length, 14)
  assert.ok(REFUSAL_REASONS.includes('profile-unreadable'))
  assert.ok(REFUSAL_REASONS.includes('profile-unratified'))
  assert.ok(REFUSAL_REASONS.includes('bad-protected'))
})

test('the compiler parses cleanly with node --check', () => {
  const result = spawnSync(process.execPath, ['--check', SCRIPT], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('direct gatherers refuse a non-git checkout and preserve verified entries', () => {
  const nonRepo = join(fixtureRoot, 'not-a-repo')
  mkdirSync(nonRepo, { recursive: true })
  put(nonRepo, 'file.txt', 'x\n')
  assert.throws(() => verifyWhere({ checkout: nonRepo, where: ['file.txt'] }), (error) => error.reason === 'not-a-git-repo')
  const root = fixture('direct-gatherers')
  const verified = verifyWhere({ checkout: root, where: ['lib/widget.mjs'] })
  assert.deepEqual(verified, [{ path: 'lib/widget.mjs', kind: 'file' }])
  const found = discoverTripwires({ checkout: root, files: verified })
  assert.ok(Array.isArray(found.candidates))
  assert.ok(Array.isArray(found.tripwires))
})
