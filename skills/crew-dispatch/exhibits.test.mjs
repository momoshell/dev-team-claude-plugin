import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from '../../test/helpers.mjs'
import { checkAnchors, collectAnchors, laneFence, partitionShifts, skillDocs } from '../qa-test-writing/anchor-pin.mjs'
import { PROTECTED_PATHS, resolveProtectedPaths } from '../../crew/protected-paths.mjs'

const HERE = fileURLToPath(new URL('./', import.meta.url))
const TIER = join(HERE, 'references/tier.md')
const MIN_ANCHORS = 8

function readText(path) {
  const text = readFileSync(path, 'utf8')
  assert.ok(text.length > 0, `${path} is empty`)
  return text
}

function section(text, heading) {
  if (heading === null) {
    const end = text.indexOf('\n## Lever 1')
    assert.notEqual(end, -1, 'baseline is missing')
    return text.slice(0, end)
  }
  const start = text.indexOf(heading)
  assert.notEqual(start, -1, `${heading} is missing`)
  const body = text.slice(start + heading.length)
  const end = body.search(/\n## /)
  return end === -1 ? body : body.slice(0, end)
}

function markdownFiles(root) {
  const found = []
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(path)
    }
  }
  visit(root)
  return found.sort()
}

// Mutation killed: changing a cited source line or deleting a citation must make the dispatch pin red.
test('every crew-dispatch path:line anchor carries what the prose claims', () => {
  const docs = skillDocs(HERE).filter((doc) => doc !== TIER)
  const manifest = JSON.parse(readText(join(HERE, 'anchors.json')))
  const result = checkAnchors({ root: ROOT, docs, manifest })
  assert.deepEqual(result.failures, [])
  const { inFence } = partitionShifts({ shifted: result.shifted, fence: laneFence({ root: ROOT }).paths })
  assert.deepEqual(inFence, [], 'a shift on a file this lane changed must be repaired, not tolerated')
  assert.ok(result.anchors >= MIN_ANCHORS)
})

// Mutation killed: adding a path:line citation to tier.md must fail instead of widening its narrow exemption.
test("the tier reference's only line anchors are the quoted runtime refusal", () => {
  const anchors = collectAnchors({ docs: [TIER] })
  assert.deepEqual(anchors.map(({ key }) => key), ['crew/crew.mjs:265', 'crew/crew.mjs:265'])
  assert.ok(readText(TIER).includes('`paneCommand`'))
  assert.ok(readText(join(ROOT, 'crew/crew.mjs')).includes('function paneCommand(role, args,'))
  // tier.md is exempt only because its quoted runtime string is a short, duplicated anchor; this test prevents widening that exemption.
})

// Mutation killed: removing one routing row must orphan a reference and make this corpus test fail.
test('every reference file is routed from SKILL.md', () => {
  const skill = readText(join(HERE, 'SKILL.md'))
  for (const name of readdirSync(join(HERE, 'references')).sort()) {
    if (name.endsWith('.md') && statSync(join(HERE, 'references', name)).isFile()) {
      assert.ok(skill.includes(`references/${name}`), `SKILL.md must route references/${name}`)
    }
  }
})

// Mutation killed: moving one lever's evidence into a neighbour must fail its own section assertion.
test("each lever section carries its own measurement", () => {
  const text = readText(join(HERE, 'references/convergence.md'))
  const sections = [
    [null, ['13 stages', '4 of 7', '24m of 41m', '59%', '21m of 82m', '17m of 48m', '17m of 106m', '11m of 33m', '9m of 63m', '9m of 41m', '76-163s', '75-132s', '10-15%', '1 of 4', '3 of 3']],
    ['## Lever 1', ['choose the shape', 'add a mode', 'b184', 'b187', 'three tech-lead rounds', 'round 1']],
    ['## Lever 2', ['crew/drive.mjs:27', 'plan_rounds', '2 + 1 granted and needed 4', '--plan-rounds 3']],
    ['## Lever 3', ['before review', 'b190', '5 control/kill pairs', 'no findings', 'b186', '3 review rounds']],
    ['## Lever 4', ['serial discovery', 'two new ones', 'lever 3']],
    ['## Lever 5', ['b190', 'second-largest brief', 'second-fastest plan', 'b188', '24 minutes']],
    ['## Lever 6', ['5 files', '30 acks', '72KB', '17m', '2 files', '2 acks', '26KB', '9m']],
    ['## Lever 7', ['a recorded baseline is a fact about a commit and is never consumed', 'scripts/factory/make-brief.mjs:1421', '4 lanes x 2 passes', '8 identical measurements']],
    ['## Lever 8', ['#584', 'compile once']],
    ['## Lever 9', ['no valid envelope within 2400s', '1890s', '14 files', 'six kill-mutations', '--wait-builder', 'crew/drive.mjs:52']],
  ]
  for (const [heading, tokens] of sections) {
    const body = section(text, heading)
    for (const token of tokens) assert.ok(body.includes(token), `${heading ?? 'baseline'} must carry ${token}`)
  }
})

// Mutation killed: substituting an authored floor or adding its profile addition in the wrong document breaks the union contract.
test('the protected floor is documented as the resolved union', () => {
  const resolved = resolveProtectedPaths(['package-lock.json'])
  assert.equal(resolved.length, PROTECTED_PATHS.length + 1)
  assert.ok(resolved.includes('package-lock.json'))
  const tier = readText(TIER)
  const fences = readText(join(HERE, 'references/fences.md'))
  assert.ok(tier.includes('resolveProtectedPaths'))
  assert.ok(tier.includes('package-lock.json'))
  assert.ok(fences.includes('resolveProtectedPaths'))
  assert.ok(fences.includes('references/tier.md'))
  assert.equal(fences.includes('package-lock.json'), false)
})

// Mutation killed: deleting one refusal token lets a batch skip a compiler or arrival failure.
test('the batch reference names every refusal the sequence can hit', () => {
  const text = readText(join(HERE, 'references/batch.md'))
  for (const token of ['coupled-source-unfenced', 'stale-read-ack', 'missing-path', 'validateScopeEntries', 'scopeMatcher', 'protectedHitsIn', 'lane_name', 'lane_fence', 'lane-fence', 'fence=NONE', 'plan-adopt-unreadable', 'externalFenceLiveness']) {
    assert.ok(text.includes(token), `batch.md must name ${token}`)
  }
})

// Mutation killed: widening the measured shell claim or dropping a zero-count guard must make this test fail.
test('the shell reference records the measured zero counts and no stronger claim', () => {
  const text = readText(join(HERE, 'references/shell.md'))
  for (const token of ['shell: true', '0 occurrences', 'process.env.SHELL', "GATE_REAP_SHELL = '/bin/bash'", 'crew/drive.mjs:347', 'crew/drive.test.mjs:3107', '${!arr[@]}', 'zsh does not word-split', 'execSync']) {
    assert.ok(text.includes(token), `shell.md must name ${token}`)
  }
  assert.equal(text.includes('every subprocess uses an argv array'), false)
})

// Mutation killed: copying a canonical rule or reviving a superseded recovery phrase must fail the owner census.
test('each migrated rule has exactly one prose owner', () => {
  const files = markdownFiles(join(ROOT, 'skills')).concat(markdownFiles(join(ROOT, 'crew/roles')))
  const owners = {
    'Planning is the largest stage in every lane': 'skills/crew-dispatch/references/convergence.md',
    'Commit the built tree before reverting': 'skills/qa-test-writing/references/gates.md',
    'while its PR is open': 'skills/devops/references/lane-branches.md',
    'package-lock.json': 'skills/crew-dispatch/references/tier.md',
  }
  for (const [phrase, owner] of Object.entries(owners)) {
    const hits = files.filter((path) => readFileSync(path, 'utf8').includes(phrase)).map((path) => relative(ROOT, path))
    assert.deepEqual(hits, [owner], `${phrase} must have exactly one owner`)
  }
  for (const phrase of ['send-key', 'tear the lane down before committing']) {
    assert.deepEqual(files.filter((path) => readFileSync(path, 'utf8').includes(phrase)), [], `${phrase} is superseded`)
  }
})
