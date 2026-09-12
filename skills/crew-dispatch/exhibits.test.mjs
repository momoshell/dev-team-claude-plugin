import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from '../../test/helpers.mjs'
import { checkAnchors, collectAnchors, laneFence, partitionShifts, pinnedKey, skillDocs } from '../qa-test-writing/anchor-pin.mjs'
import { PROTECTED_PATHS, resolveProtectedPaths } from '../../crew/protected-paths.mjs'
import { DRY_RUN_BLIND_SPOT, TEST_REACH_BLIND_SPOT, collectTestReach } from '../../scripts/factory/dispatch-batch.mjs'

const HERE = fileURLToPath(new URL('./', import.meta.url))
const TIER = join(HERE, 'references/tier.md')
const MIN_ANCHORS = 8
const MANIFEST = join(HERE, 'anchors.json')
// #918: read the pin, never restate it. A key is a line number and a merge moves it;
// the manifest's content value is what --repair-all preserves.
const pin = (expected) => pinnedKey({ manifestPath: MANIFEST, expected })

function readText(path) {
  const text = readFileSync(path, 'utf8')
  assert.ok(text.length > 0, `${path} is empty`)
  return text
}

function gitPaths(args) {
  return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).split('\0').filter(Boolean)
}

function commentApostropheCensus(files, textOf) {
  const countInComments = (text) => [...text.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g)]
    .reduce((total, comment) => total + [...comment[0]].filter((char) => char === String.fromCharCode(39)).length, 0)
  const counts = files.map((file) => countInComments(textOf(file)))
  return {
    withApostrophe: counts.filter(Boolean).length,
    odd: counts.filter((count) => count % 2).length,
  }
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

test('PS9', () => {
  const text = readText(TIER)
  for (const token of [
    'PROMPT_SURFACE', 'crew/roles/', 'crew/guidelines/',
    'ACCEPTANCE_GATE_BLOCK', 'HOSTILE_ENV_BLOCK', 'CONVENTIONS_BLOCK', 'MUTATION_CONTRACT_BLOCK',
    'prompt-surface-conflict', 'tier-floor-conflict', 'prompt=change', 'prompt=code-only',
    'BLIND SPOT: path matching cannot see a prompt embedded as a template string in a compiler; the named templateBlocks require human recognition.',
    'ADR-038', '64–66', '13',
  ]) assert.ok(text.includes(token), `tier.md must carry ${token}`)
  assert.ok(text.includes('not a measurement of whether the prompt worked'))
})

// Mutation killed: changing a cited source line or deleting a citation must make the dispatch pin red.
test('every crew-dispatch path:line anchor carries what the prose claims', () => {
  const docs = skillDocs(HERE).filter((doc) => doc !== TIER)
  const manifest = JSON.parse(readText(join(HERE, 'anchors.json')))
  const result = checkAnchors({ root: ROOT, docs, manifest })
  assert.deepEqual(result.failures, [])
  const { inFence, outOfFence } = partitionShifts({ shifted: result.shifted, fence: laneFence({ root: ROOT }).paths, manifest: 'skills/crew-dispatch/anchors.json' })
  for (const shift of outOfFence) console.warn(`shifted ${shift.key} -> line ${shift.to}; repair after this lane merges, on main with: node skills/qa-test-writing/anchor-pin.mjs --repair-all skills/crew-dispatch`)
  assert.deepEqual(inFence, [], 'a shift this lane can repair here must be repaired, not tolerated')
  assert.ok(result.anchors >= MIN_ANCHORS)
})

// Mutation killed: adding a path:line citation to tier.md must fail instead of widening its narrow exemption.
test('the tier reference carries NO path:line citation', () => {
  // It used to carry two, both 'crew/crew.mjs:265', quoted from a runtime refusal in
  // crew/seat-io.mjs. paneCommand moved to crew/crew.mjs:1706 and nothing detected it:
  // an unpinned path:line is in no manifest key, so --repair-all refuses it by name
  // ("manifest has no entry") and the citation rotted in an operator-facing message.
  // The refusal now names the SYMBOL, which cannot drift with line numbers. Zero
  // anchors is a stricter guard than the two-anchor exemption it replaces.
  const anchors = collectAnchors({ docs: [TIER] })
  assert.deepEqual(anchors.map(({ key }) => key), [])
  assert.ok(readText(TIER).includes('`paneCommand`'))
  assert.ok(readText(join(ROOT, 'crew/crew.mjs')).includes('function paneCommand(role, args,'))
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
    ['## Lever 2', [pin('plan_rounds: 2, // planner attempts'), 'plan_rounds', '2 + 1 granted and needed 4', '--plan-rounds 3']],
    ['## Lever 3', ['before review', 'b190', '5 control/kill pairs', 'no findings', 'b186', '3 review rounds']],
    ['## Lever 4', ['serial discovery', 'two new ones', 'lever 3']],
    ['## Lever 5', ['b190', 'second-largest brief', 'second-fastest plan', 'b188', '24 minutes']],
    ['## Lever 6', ['5 files', '30 acks', '72KB', '17m', '2 files', '2 acks', '26KB', '9m']],
    ['## Lever 7', ['a recorded baseline is a fact about a commit and is never consumed', pin('a recorded baseline is a fact about a commit and is never consumed'), '4 lanes x 2 passes', '8 identical measurements']],
    ['## Lever 8', ['#584', 'compile once']],
    ['## Lever 9', [
      'no valid envelope within 2400s', '1890s', '14 files', 'six kill-mutations', '--wait-builder',
      pin('builder: 2400, reviewer: 1800'), 'latency_ms_per_turn = out_of_tool_ms / turns',
      'affordable_turns = floor(wait_seconds × 1000 / latency_ms_per_turn)', '11.9-14.6 seconds/turn',
      'n=2', 'b549', '5,293,017 ms out of tool / 362 turns', '5,404,151 ms span', 'b552',
      'range, not a default constant', 'edit=0, read=10,058, test=80,892, other=20,184 ms; total=111,134 ms',
      'pane-only one-extension grant callbacks do not extend this RPC wait',
    ]],
  ]
  for (const [heading, tokens] of sections) {
    const body = section(text, heading)
    for (const token of tokens) assert.ok(body.includes(token), `${heading ?? 'baseline'} must carry ${token}`)
  }
})

test('TB5', () => {
  const body = section(readText(join(HERE, 'references/convergence.md')), '## Lever 9')
  for (const token of [
    'latency_ms_per_turn = out_of_tool_ms / turns',
    'affordable_turns = floor(wait_seconds × 1000 / latency_ms_per_turn)',
    '5,293,017 ms out of tool / 362 turns',
    '5,404,151 ms span',
    'n=2',
    '11.9-14.6 seconds/turn',
    'b549',
    'b552',
    'edit=0, read=10,058, test=80,892, other=20,184 ms; total=111,134 ms',
    'At a 5,400-second seat wait, one bounded 600-second re-ask makes the real RPC wall bound 6,000 seconds (100 minutes), not the 5,400-second wait alone.',
    'immutable per-call deadline',
    'pane-only one-extension grant callbacks do not extend this RPC wait',
  ]) assert.ok(body.includes(token), `Lever 9 must carry ${token}`)
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
  for (const token of ['coupled-source-unfenced', 'stale-read-ack', 'missing-path', 'validateScopeEntries', 'scopeMatcher', 'protectedHitsIn', 'lane_name', 'lane_fence', 'lane-fence', 'fence=NONE', 'plan-adopt-unreadable', 'externalFenceLiveness', 'ADR-040', '--repair-all', 'citation-carrier-unfenced', 'fence-admission-unsourced', 'test-reach', 'anchor-pin', 'census-carrier', 'admission cannot change the tier the operator asked for', 'only an **unpinned** path:line citation']) {
    assert.ok(text.includes(token), `batch.md must name ${token}`)
  }
  assert.equal(text.includes('prose file:line citations in'), false)
})

test('C1 E1 span reach doctrine records the measured choice', () => {
  const text = readText(join(HERE, 'references/batch.md'))
  const blindSpots = [
    'BLIND SPOT: an unpinned file:line citation is in no manifest key, so neither this check nor the citation-carrier check can find it; a citation the anchor corpus does not pin is still discoverable only by hand',
    'BLIND SPOT: this finds docs carrying a PINNED path:line citation and nothing else. A citation no manifest pins is in no key, and a doc whose exhibit set-compares a documented table against source (skills/crew-recovery/references/escalations.md and the escalate() producers) reddens with every citation in it still correct. Neither is discoverable here; read the exhibits suites of the manifests named above before choosing this fence',
    'BLIND SPOT: this is a proxy in BOTH directions and names candidates, never proof. A test can assert the changed behaviour through a higher-level entry point without importing the changed file at all, and a computed path or dynamic import is invisible to a static scan — crew/crew.mjs loads every adapter that way. A test can equally import a fenced file without asserting anything about the part being changed. The literal symbol scan sees only whole-word occurrences of an exported name, is blind to a renamed re-export, and drops any symbol naming more than 8 test files as too broad to be evidence. Read the named files before choosing this fence; an unnamed one is not cleared. An apostrophe or quote inside a // or /* */ comment opens a phantom literal and hides every real path literal after it in that file.',
    'BLIND SPOT: a lane booted without --fences declares no surface at all and can be editing anything; a lane whose batch siblings have been reaped records no claim; and a repository whose git dir cannot be measured is not compared. None of those are cleared — they are reported unknown.',
  ]
  for (const blindSpot of blindSpots) assert.equal(text.split(blindSpot).length - 1, 1, `batch.md must carry one exact blind-spot statement: ${blindSpot.slice(0, 40)}`)
  assert.ok(text.includes('dispatch.warnings.json'))
  assert.ok(text.includes('dispatch-batch: WARNING-SUMMARY'))
  assert.ok(text.includes('report=') && text.includes('doctrine=skills/crew-dispatch/references/batch.md'))
  const measuredFact = 'Measured fact: test reach is scored against the whole carrier path, so a span fence does not buy parallelism when another lane holds a test that reaches that file.'
  assert.equal(text.split(measuredFact).length - 1, 1)
  for (const row of [
    '| 1 | `null` | `static-path-has-no-line-information` |',
    '| 2 | `null` | `not-measured-option-not-selected` |',
    '| 3 | `test-reach-unfenced` | `selected-whole-file-reach` |',
  ]) assert.equal(text.split(row).length - 1, 1)
  assert.equal(text.includes('span-scoped carrier'), false)
})

test('RV1-1 census-carrier span false negative and anchor obligation distinctions remain documented', () => {
  const text = readText(join(HERE, 'references/batch.md'))
  const secondFalseNegative = 'The second is a fence entry carrying a span: `skills/crew-dispatch/exhibits.test.mjs:START-END` is scored as held because `parseFenceScope` supplies the bare path to `matchOwn`, so that carrier is never reported missing and never admitted, while the owed `const measurement` and `const pristinePairs` repairs sit outside the authored span and the scope gate will refuse them.'
  assert.equal(text.split('There are two false negatives this warning does not measure.').length - 1, 1)
  assert.equal(text.split(secondFalseNegative).length - 1, 1)
  assert.equal(text.includes('span-scoped carrier'), false)
  const sentence = 'A manifest pinning only files the lane does not write is not an obligation on that lane; when the lane writes a pinned file, dispatch admits the unheld pinning manifest automatically.'
  assert.equal(text.split(sentence).length - 1, 1)
  const oldClaim = `a shifted pin whose manifest is outside the lane${String.fromCharCode(39)}s fence is a WARNING and the lane owes nothing.`
  assert.equal(text.replaceAll(/\s+/g, ' ').includes(oldClaim), false)
})


test('test reach constant names the computed path blind spot', () => {
  assert.ok(TEST_REACH_BLIND_SPOT.includes('a computed path or dynamic import is invisible to a static scan'))
})

test('batch doctrine mirrors the computed path blind spot', () => {
  const text = readText(join(HERE, 'references/batch.md'))
  assert.equal(text.split(TEST_REACH_BLIND_SPOT).length - 1, 1)
})

test('B1 fixture retains an absolute same-basename collision', () => {
  const source = readText(join(ROOT, 'test/factory-dispatch-batch.test.mjs'))
  assert.ok(source.includes("readFileSync('/tmp/crew-task/planner.md', 'utf8')"))
  assert.equal(source.includes("readFileSync('/tmp/crew-task/role-planner.md', 'utf8')"), false)
})

// This string is a function of every tracked *.test.mjs file in the repo, not of this skill. If it reddens in your lane, you have added or removed a static quoted path literal naming a tracked file; the fix is to RE-MEASURE and update skills/crew-dispatch/references/batch.md, not to hunt a regression.
// Re-measure with the shipped collectTestReach over the git ls-files partition (owners = tracked non-*.test.mjs files; tests = tracked *.test.mjs files): node --input-type=module -e "import{execFileSync}from'node:child_process';const{collectTestReach}=await import(process.cwd()+'/scripts/factory/dispatch-batch.mjs'),files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split(String.fromCharCode(0)).filter(Boolean),tests=new Set(files.filter(file=>file.endsWith('.test.mjs'))),nonTests=new Set(files.filter(file=>!tests.has(file))),reach=collectTestReach({checkout:process.cwd()}),rows=[...reach.pathByFile].filter(([file])=>nonTests.has(file)).flatMap(([file,reached])=>[...reached].filter(test=>tests.has(test)).map(test=>[file,test])),contributingTests=new Set(rows.map(([,test])=>test));console.log({tracked:files.length,nonTests:nonTests.size,tests:tests.size,owners:new Set(rows.map(([file])=>file)).size,pairs:rows.length,contributingTests:contributingTests.size})"
test('RV1-1 pins the reach doctrine date and pristine pair baseline', () => {
  const text = readText(join(HERE, 'references/batch.md'))
  const measurement = '**162 of 547 tracked non-test files**, comprising **464 distinct (file, test) pairs contributed by 87 of 89 tracked `*.test.mjs` files**'
  const measurementDate = 'On the shipped 2026-09-12 tree'
  const pristinePairs = 464
  assert.equal(text.split(measurement).length - 1, 1)
  assert.ok(text.includes(measurementDate))
  assert.ok(text.includes(`The pristine \`HEAD\` baseline gives 162 owners and ${pristinePairs} pairs.`))
})

test('RV1-1 keeps split fence-carrier prose tied to its current module', () => {
  const text = readText(join(HERE, 'references', 'batch.md'))
  const treeFingerprint = ['crew', 'tree-fingerprint.mjs'].join('/')
  const worktrees = ['skills', 'devops', 'references', 'worktrees.md'].join('/')
  const fencesSuite = ['test', 'factory-dispatch-batch-fences.test.mjs'].join('/')
  const retainedSuite = ['test', 'factory-dispatch-batch.test.mjs'].join('/')
  const fenceSource = readText(join(ROOT, fencesSuite))
  const retainedSource = readText(join(ROOT, retainedSuite))
  for (const carrier of [treeFingerprint, worktrees]) {
    assert.ok(fenceSource.includes(carrier), `${fencesSuite} must carry ${carrier}`)
    assert.equal(retainedSource.includes(carrier), false, `${retainedSuite} must not carry ${carrier}`)
  }
  const guidance = `fencing either \`${treeFingerprint}\` or \`${worktrees}\` now names \`${fencesSuite}\`, whose b220 fixture list carries both surface literals; do not fence \`${retainedSuite}\` for either carrier.`
  assert.equal(text.split(guidance).length - 1, 1)
  assert.equal(text.includes('measured at line 2130'), false)
  const dispatchBatch = ['scripts', 'factory', 'dispatch-batch.mjs'].join('/')
  const reach = collectTestReach({ checkout: ROOT })
  assert.equal(reach.pathByFile.get(dispatchBatch)?.size, 9)
  assert.ok(text.includes(`\`${dispatchBatch}\` 3 -> 9;`))
})

test('RV1-2 derives shipped reach and comment censuses from git discovery', () => {
  const files = gitPaths(['ls-files', '-z'])
  const tests = new Set(files.filter((file) => file.endsWith('.test.mjs')))
  const nonTests = new Set(files.filter((file) => !tests.has(file)))
  const reach = collectTestReach({ checkout: ROOT })
  const rows = [...reach.pathByFile]
    .filter(([file]) => nonTests.has(file))
    .flatMap(([file, reached]) => [...reached].filter((testFile) => tests.has(testFile)).map((testFile) => [file, testFile]))
  const contributingTests = new Set(rows.map(([, testFile]) => testFile))
  const measurement = `**${new Set(rows.map(([file]) => file)).size} of ${nonTests.size} tracked non-test files**, comprising **${rows.length} distinct (file, test) pairs contributed by ${contributingTests.size} of ${tests.size} tracked \`*.test.mjs\` files**`
  const text = readText(join(HERE, 'references', 'batch.md'))
  assert.equal(text.split(measurement).length - 1, 1)
  const ownSource = readText(fileURLToPath(import.meta.url))
  assert.ok(ownSource.includes(`const measurement = '${measurement}'`))
  const current = commentApostropheCensus([...tests], (file) => readText(join(ROOT, file)))
  const headTests = gitPaths(['ls-tree', '-r', '--name-only', '-z', 'HEAD']).filter((file) => file.endsWith('.test.mjs'))
  const pristine = commentApostropheCensus(headTests, (file) => execFileSync('git', ['-C', ROOT, 'show', `HEAD:${file}`], { encoding: 'utf8' }))
  const commentMeasurement = `**${current.withApostrophe} of ${tests.size} tracked \`*.test.mjs\` files** carry at least one apostrophe inside a comment, and **${current.odd} of ${tests.size}** carry an odd number on the shipped tree (**${pristine.odd} of ${headTests.length} at pristine \`HEAD\`**).`
  assert.equal(text.split(commentMeasurement).length - 1, 1)
})

// #881: the doctrine promised a `depends_on` exemption in THREE places while the code had
// removed it, and mutating each claim left 258 tests green — operator guidance that
// recommends building a register the dispatcher now refuses. A corrected sentence with no
// tripwire is the same defect waiting to recur, so the claim itself is pinned here.
test('the batch reference never promises a depends_on exemption from sibling-leak', () => {
  const text = readText(join(HERE, 'references', 'batch.md'))
  const revoked = [
    /only a `depends_on` edge exempts/i,
    /the\s+one exemption that exists/i,
    /inherited across an edge/i,
    /is the one exemption/i,
  ]
  for (const pattern of revoked) {
    assert.equal(pattern.test(text), false, `batch.md still promises the exemption #881 removed: ${pattern}`)
  }
  // and it must state the rule that replaced them
  assert.match(text, /no two entries in one register\s+may claim the same file, related or not/i)
})

test('RV2-1 keeps the pristine reach baseline aligned with the shipped census', () => {
  const files = gitPaths(['ls-files', '-z'])
  const tests = new Set(files.filter((file) => file.endsWith('.test.mjs')))
  const nonTests = new Set(files.filter((file) => !tests.has(file)))
  const reach = collectTestReach({ checkout: ROOT })
  const rows = [...reach.pathByFile]
    .filter(([file]) => nonTests.has(file))
    .flatMap(([file, reached]) => [...reached].filter((testFile) => tests.has(testFile)).map((testFile) => [file, testFile]))
  const owners = new Set(rows.map(([file]) => file)).size
  const pairs = rows.length
  const text = readText(join(HERE, 'references', 'batch.md'))
  assert.equal(text.split(`The pristine \`HEAD\` baseline gives ${owners} owners and ${pairs} pairs.`).length - 1, 1)
  const ownSource = readText(fileURLToPath(import.meta.url))
  assert.equal(ownSource.split(`const pristinePairs = ${pairs}`).length - 1, 1)
})

// Mutation killed: widening the measured shell claim or dropping a zero-count guard must make this test fail.
test('the shell reference records the measured zero counts and no stronger claim', () => {
  const text = readText(join(HERE, 'references/shell.md'))
  for (const token of ['shell: true', '0 occurrences', 'process.env.SHELL', "GATE_REAP_SHELL = '/bin/bash'", pin("export const GATE_REAP_SHELL = '/bin/bash'"), pin("'/path/that/does/not/exist'"), '${!arr[@]}', 'zsh does not word-split', 'execSync']) {
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

// Mutation killed: adding a dry-run step to the numbered recipe must make its absence assertion fail.
test('the batch recipe prescribes no dry run', () => {
  const text = readText(join(HERE, 'references/batch.md'))
  const start = text.indexOf('1. Create one worktree per lane.')
  const end = text.indexOf('\nParallelise on file-set disjointness', start)
  assert.notEqual(start, -1, 'the numbered recipe is missing')
  assert.notEqual(end, -1, 'the recipe terminator is missing')
  assert.doesNotMatch(text.slice(start, end), /dry[ -]?run/i)
  assert.ok(text.includes('The sequence above prescribes no dry run'))
})

// Mutation killed: deleting the dry-run use cases or changing the blind-spot quote must make the doctrine assertion fail.
test('the flag reference records what a dry run is and is not for', () => {
  const text = readText(join(HERE, 'references/flags.md'))
  const sentence = 'A green dry run is not a validated dispatch.'
  for (const token of [
    'a register whose paths you do not trust',
    'a foreign checkout, where creating branches is unwelcome',
    'the first run after `onboard`',
    '2026-09-06',
    'six times',
    'Six invocations on one day is the whole sample',
    '`--dry-run --force --no-keep --headless-all --panes`',
    'an absent flag defaults planner to `64`, builder to `200`, reviewer to `48` and',
    'source: default', 'source: flag', 'source: absent',
    'Pane boots have no implicit ceiling',
    'Batch forwarding of `--assurance` and every `--max-turns-<role>` value',
    'deferred waves re-emit the authored values',
    sentence,
  ]) assert.ok(text.includes(token), `flags.md must carry ${token}`)
  assert.ok(DRY_RUN_BLIND_SPOT.includes(sentence))
})

// Mutation killed: removing the dry-run routing row or critical rule must make the skill route assertion fail.
test('the dispatch skill routes the dry-run doctrine', () => {
  const text = readText(join(HERE, 'SKILL.md'))
  for (const token of ['Deciding whether to dry-run', 'A dry run is not a step', '#961']) {
    assert.ok(text.includes(token), `SKILL.md must carry ${token}`)
  }
})

test('DC1', () => {
  const text = readText(join(HERE, 'references/flags.md'))
  assert.ok(text.includes('The canonical `--execution` name selects a run'))
  assert.ok(text.includes('--execution --variant'))
  assert.ok(text.includes('--assurance --tier'))
  assert.ok(text.includes('--execution directed'))
  assert.ok(text.includes('--assurance standard'))
})

test('DD1', () => {
  const text = readText(join(HERE, 'references/flags.md'))
  const sentence = 'Both aliases remain accepted only\nthrough the next tagged release, and each used alias axis emits one warning\nper batch.'
  assert.equal(text.split(sentence).length - 1, 1)
  assert.ok(text.includes('`--variant` remains accepted as its alias'))
  assert.ok(text.includes('`--tier` remains accepted as its alias'))
  // ADR-035 section 4 refuses the PAIR, matching values included. The doc must say
  // so verbatim, because a reader who infers a precedence rule will pass both.
  assert.ok(text.includes('refuses as\n`transport-conflict` and names both flags, **even when the values agree**'))
})
