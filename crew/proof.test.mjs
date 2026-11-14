import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, scratchDir } from '../test/helpers.mjs'
import { proveTests, testState } from './proof.mjs'

test('a configured runner proves a TypeScript test from its JUnit report', async () => {
  const cwd = scratchDir('proof-junit-')
  git(cwd, 'init', '-q'); mkdirSync(join(cwd, '.crew')); mkdirSync(join(cwd, 'lib'))
  writeFileSync(join(cwd, '.crew/project.json'), JSON.stringify({ proof: [{ match: '**/*.test.ts', run: 'node --test --test-reporter=junit --test-reporter-destination={report} {file}' }] }))
  writeFileSync(join(cwd, 'lib/add.ts'), 'export const add = () => 0\n')
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  writeFileSync(join(cwd, 'lib/add.ts'), 'export const add = () => 1\n')
  writeFileSync(join(cwd, 'lib/add.test.ts'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from './add.ts'\ntest('add is a function', () => assert.equal(typeof add, 'function'))\ntest('add returns one', () => assert.equal(add(), 1))\n")
  writeFileSync(join(cwd, '.crew/project.json'), '{"proof":[]}')
  const result = await proveTests({ cwd, tests: ['add returns one', 'add is a function'].map((title) => ({ file: 'lib/add.test.ts', title })) })
  assert.equal(result.status, 'red'); assert.equal(result.rows[0].proven, true)
  assert.equal(result.rows[1].reason, 'proof-not-red-on-base')
})

test('a timed-out runner row is unmeasured on its own and the remaining rows are still proven', { timeout: 20_000 }, async () => {
  for (const side of ['base', 'build']) {
    const cwd = scratchDir('proof-runner-timeout-')
    git(cwd, 'init', '-q'); mkdirSync(join(cwd, '.crew'))
    writeFileSync(join(cwd, '.crew/project.json'), JSON.stringify({ proof: [{ match: '*.xml', run: 'node runner.mjs {title} {report}' }] }))
    writeFileSync(join(cwd, 'runner.mjs'), `import { readFileSync, writeFileSync } from 'node:fs'\nconst v = readFileSync('v', 'utf8')\nif (process.argv[2] === 'hang' && v === '${side}') setInterval(() => {}, 1000)\nelse writeFileSync(process.argv[3], '<testsuite><testcase name="' + process.argv[2] + '">' + (v === 'base' ? '<failure/>' : '') + '</testcase></testsuite>')\n`)
    writeFileSync(join(cwd, 'v'), 'base')
    git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
    writeFileSync(join(cwd, 'v'), 'build'); writeFileSync(join(cwd, 'test.xml'), '<testsuite/>')
    const result = await proveTests({ cwd, tests: ['hang', 'works'].map((title) => ({ file: 'test.xml', title })), timeoutMs: 3000 })
    assert.equal(result.status, 'red'); assert.equal(result.reason, 'proof-unproven')
    assert.deepEqual(result.rows[0][side], { state: null, reason: 'timeout' })
    assert.equal(result.rows[0].reason, 'timeout'); assert.equal(result.rows[0].proven, false)
    assert.deepEqual(result.rows[0][side === 'base' ? 'build' : 'base'], side === 'base' ? { state: null, reason: 'not-run' } : { state: 'red', reason: null })
    assert.equal(result.rows[1].proven, true); assert.equal(result.rows[1].reason, null)
    assert.equal(git(cwd, 'worktree', 'list').trim().split('\n').length, 1)
  }
})

test('JUnit failure, pass, error, skip, absence and duplicates map to the node proof states', async () => {
  const cwd = scratchDir('proof-xml-')
  git(cwd, 'init', '-q'); mkdirSync(join(cwd, '.crew')); mkdirSync(join(cwd, 'tests'))
  writeFileSync(join(cwd, '.crew/project.json'), JSON.stringify({ proof: [{ match: '**/*.xml', run: 'cp {file} {report}' }] }))
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  writeFileSync(join(cwd, 'tests/report.xml'), `<testsuites><testsuite name="pytest"><testcase classname="tests.test_add" name="test_fails"><failure message="bad">a &lt; b</failure></testcase><testcase classname="tests.test_add" name="test_passes"/><testcase classname="tests.test_add" name="test_errors"><error/></testcase><testcase classname="tests.test_add" name="test_skipped"><skipped type="pytest.skip"/></testcase><testcase name="test_twice"/><testcase name="test_twice"/><testcase name="a &lt; b"/><testcase classname="suite&#46;one" name="a &amp; &quot;b&quot; &apos;&#x63;&#100;&apos;"/><!-- <testcase name="hidden"/> --><![CDATA[<testcase name="hidden"/>]]></testsuite></testsuites>`)
  const cases = [['tests.test_add.test_fails', 'red', null], ['test_passes', 'green', null], ['test_errors', null, 'not-body-failure'], ['test_skipped', null, 'skipped'], ['test_absent', null, 'title-unmatched', ['test_passes']], ['test_twice', null, 'ambiguous'], ['a < b', 'green', null], ['suite.one::a & "b" \'cd\'', 'green', null], ['hidden', null, 'title-unmatched', ['a < b']]]
  const result = await proveTests({ cwd, tests: cases.map(([title]) => ({ file: 'tests/report.xml', title })) })
  assert.deepEqual(result.rows.map((row) => row.base), cases.map(([, state, reason, nearest]) => nearest ? { state, reason, nearest } : { state, reason }))
})

test('a report with no matching title is title-unmatched with its nearest name on both sides', async () => {
  const cwd = scratchDir('proof-unmatched-')
  git(cwd, 'init', '-q'); mkdirSync(join(cwd, '.crew')); mkdirSync(join(cwd, 'tests'))
  writeFileSync(join(cwd, '.crew/project.json'), JSON.stringify({ proof: [{ match: '**/*.xml', run: 'cp {file} {report}' }] }))
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  const cases = [
    ['<testcase name="unrelated"/><testcase name="registry::wiring_tests::works"/>', 'wiring_tests::works', 'registry::wiring_tests::works'],
    ['<testcase name="xabc"/><testcase name="yabc"/><testcase name="abcde"/>', 'zabc', 'xabc'],
    ['<testcase name="longabc"/><testcase name="xabc"/>', 'zabc', 'xabc'],
    ['<testcase classname="registry::wiring_tests" name="works"/>', 'wiring_tests::works', 'registry::wiring_tests::works'],
    ['<error message="load failed"/><testcase name="other"/>', 'works', 'other'],
  ]
  for (const [testcases, title, nearest] of cases) {
    writeFileSync(join(cwd, 'tests/report.xml'), `<testsuite>${testcases}</testsuite>`)
    const result = await proveTests({ cwd, tests: [{ file: 'tests/report.xml', title }] })
    for (const side of ['base', 'build']) assert.deepEqual(result.rows[0][side], { state: null, reason: 'title-unmatched', nearest: [nearest] })
  }
})

test('a file-level failure with no matching row is title-unmatched on both sides', async () => {
  const cwd = scratchDir('proof-load-failure-')
  git(cwd, 'init', '-q'); mkdirSync(join(cwd, '.crew')); mkdirSync(join(cwd, 'tests'))
  writeFileSync(join(cwd, '.crew/project.json'), JSON.stringify({ proof: [{ match: '**/*.xml', run: 'cp {file} {report}' }] }))
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  for (const xml of ['<testsuite name="load"><error message="load failed"/></testsuite>', '<testsuite><failure>load failed</failure></testsuite>']) {
    writeFileSync(join(cwd, 'tests/report.xml'), xml)
    const result = await proveTests({ cwd, tests: [{ file: 'tests/report.xml', title: 'works' }] })
    for (const side of ['base', 'build']) assert.deepEqual(result.rows[0][side], { state: null, reason: 'title-unmatched', nearest: [] })
  }
})

test('quoted testcase attributes cannot create a false proof', async () => {
  const cases = [
    [(outcome) => `<testcase name="works" classname="Comparison>Test"/><testcase name="other">${outcome}</testcase>`, { state: 'green', reason: null }],
    [(outcome) => `<testcase classname="x name='works'" name="other">${outcome}</testcase>`, { state: null, reason: 'title-unmatched', nearest: ['other'] }],
  ]
  for (const [testcases, expected] of cases) {
    const cwd = scratchDir('proof-quoted-')
    git(cwd, 'init', '-q'); mkdirSync(join(cwd, '.crew'))
    writeFileSync(join(cwd, '.crew/project.json'), JSON.stringify({ proof: [{ match: '*.xml', run: 'node report.mjs {report}' }] }))
    const runner = (outcome) => `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], ${JSON.stringify(`<testsuite>${testcases(outcome)}</testsuite>`)})\n`
    writeFileSync(join(cwd, 'report.mjs'), runner('<failure/>'))
    git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
    writeFileSync(join(cwd, 'report.mjs'), runner(''))
    writeFileSync(join(cwd, 'test.xml'), '<testsuite/>')
    const result = await proveTests({ cwd, tests: [{ file: 'test.xml', title: 'works' }] })
    assert.deepEqual(result.rows[0].base, expected)
    assert.deepEqual(result.rows[0].build, expected); assert.equal(result.rows[0].proven, false)
  }
})

test('a runner that selects no test and writes no report is title-unmatched on both sides', async () => {
  for (const [list, script, nearest] of [[undefined, '', []], ['node list.mjs', "console.log('app::works')\n", ['app::works']], ['node list.mjs', 'process.exit(1)\n', []]]) {
    const cwd = scratchDir('proof-zero-selected-')
    git(cwd, 'init', '-q'); mkdirSync(join(cwd, '.crew'))
    writeFileSync(join(cwd, '.crew/project.json'), JSON.stringify({ proof: [{ match: '*.xml', run: 'node run.mjs', list }] }))
    writeFileSync(join(cwd, 'run.mjs'), 'process.exit(0)\n'); writeFileSync(join(cwd, 'list.mjs'), script)
    git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
    writeFileSync(join(cwd, 'test.xml'), '')
    const result = await proveTests({ cwd, tests: [{ file: 'test.xml', title: 'works' }] })
    for (const side of ['base', 'build']) assert.deepEqual(result.rows[0][side], { state: null, reason: 'title-unmatched', nearest })
  }
})

test('a report with zero test cases is title-unmatched on both sides with nearest from the list', async () => {
  const nextest = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="nextest-run" tests="0" skipped="0" failures="0" errors="0" uuid="828c3f15-7663-4cfa-b642-140f3f2b7eec" timestamp="2026-11-08T17:39:17.839+01:00" time="0.004">
</testsuites>`
  const cases = [
    [nextest, 4, undefined, '', []],
    [nextest, 4, 'node list.mjs', "console.log('app::works')\n", ['app::works']],
    [nextest, 4, 'node list.mjs', 'process.exit(1)\n', []],
    ['<testsuite/>', 0, undefined, '', []],
    ['<testsuite><!-- <error/> --><![CDATA[<failure/>]]><?info <error/>?></testsuite>', 4, undefined, '', []],
    [null, 1, undefined, '', null],
  ]
  for (const [xml, exit, list, script, nearest] of cases) {
    const cwd = scratchDir('proof-zero-cases-')
    git(cwd, 'init', '-q'); mkdirSync(join(cwd, '.crew'))
    writeFileSync(join(cwd, '.crew/project.json'), JSON.stringify({ proof: [{ match: '*.xml', run: 'node run.mjs {report}', list }] }))
    writeFileSync(join(cwd, 'run.mjs'), `import { writeFileSync } from 'node:fs'\n${xml === null ? '' : `writeFileSync(process.argv[2], ${JSON.stringify(xml)})`}\nprocess.exit(${exit})\n`)
    writeFileSync(join(cwd, 'list.mjs'), script)
    git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
    writeFileSync(join(cwd, 'test.xml'), '')
    const result = await proveTests({ cwd, tests: [{ file: 'test.xml', title: 'works' }] })
    for (const side of ['base', 'build']) {
      const expected = nearest === null ? { state: null, reason: side === 'base' ? 'base-does-not-build' : 'no-report' } : { state: null, reason: 'title-unmatched', nearest }
      assert.deepEqual(result.rows[0][side], expected)
    }
  }
})

test('a no-report run whose list succeeds is title-unmatched with the nearest listed name, and a failing list keeps the old reasons', async () => {
  const cwd = scratchDir('proof-list-')
  git(cwd, 'init', '-q'); mkdirSync(join(cwd, '.crew'))
  writeFileSync(join(cwd, '.crew/project.json'), JSON.stringify({ proof: [{ match: '*.xml', run: 'node run.mjs', list: 'node list.mjs {file} {title} {report} {stem}' }] }))
  writeFileSync(join(cwd, 'run.mjs'), 'process.exit(1)\n')
  writeFileSync(join(cwd, 'list.mjs'), `import { readFileSync } from 'node:fs'
const [file, title, report, stem] = process.argv.slice(2)
if (file !== 'test.xml' || title !== 'wiring::works' || !report.endsWith('.xml') || stem !== 'test') process.exit(1)
console.log(' unrelated \\n  app::' + readFileSync('side', 'utf8').trim() + '::wiring::works  \\n')
`)
  writeFileSync(join(cwd, 'side'), 'base')
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  writeFileSync(join(cwd, 'side'), 'build'); writeFileSync(join(cwd, 'test.xml'), '')
  const tests = [{ file: 'test.xml', title: 'wiring::works' }]
  const listed = await proveTests({ cwd, tests })
  for (const side of ['base', 'build']) assert.deepEqual(listed.rows[0][side], { state: null, reason: 'title-unmatched', nearest: [`app::${side}::wiring::works`] })
  writeFileSync(join(cwd, 'list.mjs'), 'process.exit(1)\n')
  git(cwd, 'add', 'list.mjs'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'failing list')
  const failed = await proveTests({ cwd, tests })
  for (const [side, reason] of [['base', 'base-does-not-build'], ['build', 'no-report']]) assert.deepEqual(failed.rows[0][side], { state: null, reason })
})

test('a blank list in a proof entry is unmeasured invalid-project-config', async () => {
  for (const list of ['', '  ', null, 1]) {
    const cwd = scratchDir('proof-invalid-list-')
    git(cwd, 'init', '-q'); mkdirSync(join(cwd, '.crew'))
    writeFileSync(join(cwd, '.crew/project.json'), JSON.stringify({ proof: [{ match: '*.xml', run: 'node run.mjs', list }] }))
    git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
    const result = await proveTests({ cwd, tests: [{ file: 'test.xml', title: 'works' }] })
    assert.equal(result.status, 'unmeasured'); assert.equal(result.reason, 'invalid-project-config')
  }
})

test('a runner that writes no report on the old source is base-does-not-build, not red', async () => {
  const cwd = scratchDir('proof-no-report-')
  git(cwd, 'init', '-q'); mkdirSync(join(cwd, '.crew')); mkdirSync(join(cwd, 'tests'))
  writeFileSync(join(cwd, '.crew/project.json'), JSON.stringify({ proof: [{ match: '**/*.xml', run: 'node build.mjs {file} {report}' }] }))
  writeFileSync(join(cwd, 'build.mjs'), 'process.exit(1)\n')
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  writeFileSync(join(cwd, 'build.mjs'), "import { copyFileSync } from 'node:fs'; copyFileSync(process.argv[2], process.argv[3])\n")
  writeFileSync(join(cwd, 'tests/report.xml'), '<testsuite><testcase name="works"/></testsuite>')
  const result = await proveTests({ cwd, tests: [{ file: 'tests/report.xml', title: 'works' }] })
  assert.deepEqual(result.rows[0].base, { state: null, reason: 'base-does-not-build' })
  assert.equal(result.rows[0].build.state, 'green'); assert.equal(result.rows[0].reason, 'proof-not-red-on-base')
  for (const xml of ['<testsuite><testcase name="works"/>', 'not XML']) {
    writeFileSync(join(cwd, 'tests/report.xml'), xml)
    const invalid = await proveTests({ cwd, tests: [{ file: 'tests/report.xml', title: 'works' }] })
    assert.deepEqual(invalid.rows[0].build, { state: null, reason: 'no-report' })
  }
  writeFileSync(join(cwd, 'build.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[3], '<testsuite><testcase name="works"><failure/></testcase></testsuite>')\n`)
  git(cwd, 'add', 'build.mjs'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'red report')
  writeFileSync(join(cwd, 'build.mjs'), "import { copyFileSync } from 'node:fs'; copyFileSync(process.argv[2], process.argv[3])\n")
  writeFileSync(join(cwd, 'tests/report.xml'), '<testsuite><testcase name="works"/>')
  const truncated = await proveTests({ cwd, tests: [{ file: 'tests/report.xml', title: 'works' }] })
  assert.equal(truncated.rows[0].base.state, 'red'); assert.deepEqual(truncated.rows[0].build, { state: null, reason: 'no-report' }); assert.equal(truncated.rows[0].proven, false)
})

function newTestFileProof({ optIn = true, present = false } = {}) {
  const cwd = scratchDir('proof-test-file-')
  git(cwd, 'init', '-q'); mkdirSync(join(cwd, '.crew')); mkdirSync(join(cwd, 'crates/a/tests'), { recursive: true })
  writeFileSync(join(cwd, '.crew/project.json'), JSON.stringify({ proof: [{ match: '**/*.xml', run: 'node build.mjs {file} {report}', manifest: 'pkg.json', ...(optIn ? { newTestFile: true } : {}) }] }))
  writeFileSync(join(cwd, 'crates/a/pkg.json'), '{}')
  writeFileSync(join(cwd, 'build.mjs'), 'process.exit(1)\n')
  if (present) writeFileSync(join(cwd, 'crates/a/tests/m.xml'), '<testsuite/>')
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  writeFileSync(join(cwd, 'crates/a/tests/m.xml'), '<testsuite><testcase name="works"/></testsuite>')
  writeFileSync(join(cwd, 'build.mjs'), "import { copyFileSync } from 'node:fs'; copyFileSync(process.argv[2], process.argv[3])\n")
  return cwd
}

test('a new test file in an existing package is proven as base-test-absent when its entry opts in with newTestFile', async () => {
  const result = await proveTests({ cwd: newTestFileProof(), tests: [{ file: 'crates/a/tests/m.xml', title: 'works' }] })
  assert.deepEqual(result.rows[0].base, { state: null, reason: 'base-test-absent' })
  assert.deepEqual(result.rows[0].build, { state: 'green', reason: null })
  assert.equal(result.rows[0].proven, true); assert.equal(result.rows[0].reason, null); assert.equal(result.status, 'green')
})

test('a base-test-absent row whose build side is red or has no report stays unproven', async () => {
  const cwd = newTestFileProof()
  for (const [xml, script, state, reason] of [
    ['<testsuite><testcase name="works"><failure/></testcase></testsuite>', null, 'red', null],
    [null, 'process.exit(1)\n', null, 'no-report'],
    ['<testsuite><testcase name="other"/></testsuite>', "import { copyFileSync } from 'node:fs'; copyFileSync(process.argv[2], process.argv[3])\n", null, 'title-unmatched'],
  ]) {
    if (xml !== null) writeFileSync(join(cwd, 'crates/a/tests/m.xml'), xml)
    if (script !== null) writeFileSync(join(cwd, 'build.mjs'), script)
    const result = await proveTests({ cwd, tests: [{ file: 'crates/a/tests/m.xml', title: 'works' }] })
    assert.equal(result.rows[0].base.reason, 'base-test-absent')
    assert.equal(result.rows[0].build.state, state); assert.equal(result.rows[0].build.reason, reason)
    assert.equal(result.rows[0].proven, false); assert.equal(result.rows[0].reason, 'proof-not-green')
  }
})

test('a proof entry whose newTestFile is not a boolean is invalid-project-config', async () => {
  for (const newTestFile of ['yes', 1, null, {}]) {
    const cwd = scratchDir('proof-invalid-test-file-')
    git(cwd, 'init', '-q'); mkdirSync(join(cwd, '.crew'))
    writeFileSync(join(cwd, '.crew/project.json'), JSON.stringify({ proof: [{ match: '*.xml', run: 'node build.mjs', newTestFile }] }))
    git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
    const result = await proveTests({ cwd, tests: [{ file: 'test.xml', title: 'works' }] })
    assert.equal(result.status, 'unmeasured'); assert.equal(result.reason, 'invalid-project-config')
  }
})

test('an existing test file that writes no report on the old source stays base-does-not-build with newTestFile', async () => {
  const result = await proveTests({ cwd: newTestFileProof({ present: true }), tests: [{ file: 'crates/a/tests/m.xml', title: 'works' }] })
  assert.equal(result.rows[0].base.reason, 'base-does-not-build'); assert.equal(result.rows[0].proven, false)
})

test('a differently cased test file does not prove an existing file absent', async () => {
  const cwd = newTestFileProof({ present: true })
  const file = 'crates/a/tests/M.xml'
  const result = await proveTests({ cwd, tests: [{ file, title: 'works' }] })
  if (existsSync(join(cwd, file))) {
    assert.equal(result.rows[0].base.reason, 'base-does-not-build')
    assert.equal(result.rows[0].build.state, 'green')
  } else assert.equal(result.rows[0].reason, 'unsafe-path')
  assert.notEqual(result.rows[0].base.reason, 'base-test-absent'); assert.equal(result.rows[0].proven, false)
})

test('an entry without newTestFile reads a new test file as base-does-not-build', async () => {
  const result = await proveTests({ cwd: newTestFileProof({ optIn: false }), tests: [{ file: 'crates/a/tests/m.xml', title: 'works' }] })
  assert.equal(result.rows[0].base.reason, 'base-does-not-build'); assert.equal(result.rows[0].proven, false)
})

function newPackageProof({ manifest = true, present = false } = {}) {
  const cwd = scratchDir('proof-package-')
  git(cwd, 'init', '-q'); mkdirSync(join(cwd, '.crew'))
  writeFileSync(join(cwd, '.crew/project.json'), JSON.stringify({ proof: [{ match: '**/*.xml', run: 'node build.mjs {file} {report}', ...(manifest ? { manifest: 'pkg.json' } : {}) }] }))
  writeFileSync(join(cwd, 'build.mjs'), 'process.exit(1)\n')
  if (present) { mkdirSync(join(cwd, 'crates/new'), { recursive: true }); writeFileSync(join(cwd, 'crates/new/pkg.json'), '{}') }
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  mkdirSync(join(cwd, 'crates/new/tests'), { recursive: true })
  writeFileSync(join(cwd, 'crates/new/pkg.json'), '{}')
  writeFileSync(join(cwd, 'crates/new/tests/x.xml'), '<testsuite><testcase name="works"/></testsuite>')
  writeFileSync(join(cwd, 'build.mjs'), "import { copyFileSync } from 'node:fs'; copyFileSync(process.argv[2], process.argv[3])\n")
  return cwd
}

test('a test in a package the build adds is proven as base-package-absent when the old-source commit lacks its manifest', async () => {
  const cwd = newPackageProof()
  const result = await proveTests({ cwd, tests: [{ file: 'crates/new/tests/x.xml', title: 'works' }] })
  assert.deepEqual(result.rows[0].base, { state: null, reason: 'base-package-absent' })
  assert.equal(result.rows[0].proven, true); assert.equal(result.status, 'green')
  rmSync(join(cwd, 'crates/new/pkg.json'))
  writeFileSync(join(cwd, 'pkg.json'), '{}')
  symlinkSync('../../pkg.json', join(cwd, 'crates/new/pkg.json'))
  const unsafe = await proveTests({ cwd, tests: [{ file: 'crates/new/tests/x.xml', title: 'works' }] })
  assert.deepEqual(unsafe.rows[0].base, { state: null, reason: 'base-does-not-build' })
  assert.equal(unsafe.rows[0].proven, false)
})

test('a new package manifest listed in support still reads base-package-absent', async () => {
  const cwd = newPackageProof()
  const result = await proveTests({ cwd, tests: [{ file: 'crates/new/tests/x.xml', title: 'works', support: ['crates/new/pkg.json'] }] })
  assert.deepEqual(result.rows[0].base, { state: null, reason: 'base-package-absent' })
  assert.equal(result.rows[0].proven, true); assert.equal(result.status, 'green')
})

test('a proof entry whose manifest is not a bare file name is invalid-project-config', async () => {
  for (const manifest of ['../pkg.json', '', '  ', '.', '..', 'x/y', 'x\\\\y', 'x\0y', null, 1, {}]) {
    const cwd = scratchDir('proof-invalid-manifest-')
    git(cwd, 'init', '-q'); mkdirSync(join(cwd, '.crew'))
    writeFileSync(join(cwd, '.crew/project.json'), JSON.stringify({ proof: [{ match: '*.xml', run: 'node build.mjs', manifest }] }))
    git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
    const result = await proveTests({ cwd, tests: [{ file: 'test.xml', title: 'works' }] })
    assert.equal(result.status, 'unmeasured'); assert.equal(result.reason, 'invalid-project-config')
  }
})

test('a differently cased manifest does not prove a broken package absent', async () => {
  const absent = await proveTests({ cwd: newPackageProof(), tests: [{ file: 'crates/new/tests/x.xml', title: 'works' }] })
  assert.equal(absent.rows[0].base.reason, 'base-package-absent')
  const cwd = newPackageProof({ present: true })
  writeFileSync(join(cwd, '.crew/project.json'), JSON.stringify({ proof: [{ match: '**/*.xml', run: 'node build.mjs {file} {report}', manifest: 'PKG.json' }] }))
  git(cwd, 'add', '.crew/project.json'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'case mismatch')
  const result = await proveTests({ cwd, tests: [{ file: 'crates/new/tests/x.xml', title: 'works' }] })
  assert.deepEqual(result.rows[0].base, { state: null, reason: 'base-does-not-build' })
  assert.equal(result.rows[0].reason, 'proof-not-red-on-base'); assert.equal(result.rows[0].proven, false)
})

test('a missing build manifest does not prove a package absent', async () => {
  const cwd = newPackageProof()
  const tests = [{ file: 'crates/new/tests/x.xml', title: 'works' }]
  const absent = await proveTests({ cwd, tests })
  assert.equal(absent.rows[0].base.reason, 'base-package-absent')
  rmSync(join(cwd, 'crates/new/pkg.json'))
  const result = await proveTests({ cwd, tests })
  assert.deepEqual(result.rows[0].base, { state: null, reason: 'base-does-not-build' })
  assert.equal(result.rows[0].reason, 'proof-not-red-on-base'); assert.equal(result.rows[0].proven, false)
})

test('a package present on the old source that writes no report stays base-does-not-build', async () => {
  const cwd = newPackageProof({ present: true })
  const result = await proveTests({ cwd, tests: [{ file: 'crates/new/tests/x.xml', title: 'works' }] })
  assert.deepEqual(result.rows[0].base, { state: null, reason: 'base-does-not-build' })
  assert.equal(result.rows[0].reason, 'proof-not-red-on-base'); assert.equal(result.rows[0].proven, false)
})

test('an entry with no manifest key reads an absent package as base-does-not-build', async () => {
  const cwd = newPackageProof({ manifest: false })
  const result = await proveTests({ cwd, tests: [{ file: 'crates/new/tests/x.xml', title: 'works' }] })
  assert.deepEqual(result.rows[0].base, { state: null, reason: 'base-does-not-build' })
  assert.equal(result.rows[0].reason, 'proof-not-red-on-base'); assert.equal(result.rows[0].proven, false)
})

test('an absent package whose build side is red or has no report stays unproven', async () => {
  const cwd = newPackageProof()
  for (const [xml, script] of [['<testsuite><testcase name="works"><failure/></testcase></testsuite>', null], [null, 'process.exit(1)\n'], ['<testsuite><testcase name="other"/></testsuite>', "import { copyFileSync } from 'node:fs'; copyFileSync(process.argv[2], process.argv[3])\n"]]) {
    if (xml !== null) writeFileSync(join(cwd, 'crates/new/tests/x.xml'), xml)
    if (script !== null) writeFileSync(join(cwd, 'build.mjs'), script)
    const result = await proveTests({ cwd, tests: [{ file: 'crates/new/tests/x.xml', title: 'works' }] })
    assert.equal(result.rows[0].base.reason, 'base-package-absent')
    assert.equal(result.rows[0].proven, false); assert.equal(result.rows[0].reason, 'proof-not-green')
  }
})

test('setup runs in the old-source worktree before the runner and a failing setup is unmeasured', async () => {
  const cwd = scratchDir('proof-setup-')
  git(cwd, 'init', '-q'); mkdirSync(join(cwd, '.crew')); mkdirSync(join(cwd, 'tests'))
  writeFileSync(join(cwd, '.crew/project.json'), JSON.stringify({ proof: [{ match: '**/*.xml', setup: 'node setup.mjs', run: 'node run.mjs {file} {report}' }] }))
  writeFileSync(join(cwd, 'setup.mjs'), "import { appendFileSync } from 'node:fs'; appendFileSync('ready', 'yes')\n")
  writeFileSync(join(cwd, 'run.mjs'), "import { readFileSync, copyFileSync } from 'node:fs'; if (!['yes', 'build'].includes(readFileSync('ready', 'utf8'))) process.exit(1); copyFileSync(process.argv[2], process.argv[3])\n")
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  writeFileSync(join(cwd, 'ready'), 'build')
  writeFileSync(join(cwd, 'tests/report.xml'), '<testsuite><testcase name="works"/><testcase name="also works"/></testsuite>')
  const tests = ['works', 'also works'].map((title) => ({ file: 'tests/report.xml', title }))
  const result = await proveTests({ cwd, tests })
  assert.deepEqual(result.rows.map((row) => row.base.state), ['green', 'green']); assert.equal(readFileSync(join(cwd, 'ready'), 'utf8'), 'build')
  const failing = scratchDir('proof-setup-fail-')
  git(failing, 'init', '-q'); mkdirSync(join(failing, '.crew'))
  writeFileSync(join(failing, '.crew/project.json'), JSON.stringify({ proof: [{ match: '**/*.xml', setup: 'node missing.mjs', run: 'cp {file} {report}' }] }))
  git(failing, 'add', '.'); git(failing, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  mkdirSync(join(failing, 'tests')); writeFileSync(join(failing, 'tests/report.xml'), '<testsuite/>')
  const failed = await proveTests({ cwd: failing, tests })
  assert.equal(failed.status, 'unmeasured'); assert.equal(failed.reason, 'setup-failed')
  assert.equal(git(failing, 'worktree', 'list').trim().split('\n').length, 1)
})

test('an invalid project config is unmeasured invalid-project-config', async () => {
  for (const config of ['{"proof":[{"match":"**/*.xml"}]}', '{', '{"proof":null}', '{"proof":[{"match":" ","run":"echo"}]}', '{"proof":[{"match":"*","run":"echo","setup":" "}]}', 'symlink']) {
    const cwd = scratchDir('proof-config-')
    git(cwd, 'init', '-q'); mkdirSync(join(cwd, '.crew'))
    if (config === 'symlink') { writeFileSync(join(cwd, 'target.json'), '{}'); symlinkSync('../target.json', join(cwd, '.crew/project.json')) }
    else writeFileSync(join(cwd, '.crew/project.json'), config)
    git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
    const result = await proveTests({ cwd, tests: [{ file: 'x.xml', title: 'x' }] })
    assert.equal(result.status, 'unmeasured'); assert.equal(result.reason, 'invalid-project-config')
  }
})

// MUTATION: classify testCodeFailure as not a body failure.
test('a body failure on the old source and a pass on the build proves the test', async () => {
  const cwd = scratchDir('proof-')
  git(cwd, 'init', '-q')
  mkdirSync(join(cwd, 'lib'))
  writeFileSync(join(cwd, 'lib/add.mjs'), 'export const add = () => 0\n')
  writeFileSync(join(cwd, 'lib/add.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from './add.mjs'\ntest('add is a function', () => assert.equal(typeof add, 'function'))\n")
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  writeFileSync(join(cwd, 'lib/add.mjs'), 'export const add = () => 1\n')
  writeFileSync(join(cwd, 'lib/add.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from './add.mjs'\ntest('add is a function', () => assert.equal(typeof add, 'function'))\ntest('add returns one', () => assert.equal(add(), 1))\n")
  const result = await proveTests({ cwd, tests: ['add returns one', 'add is a function'].map((title) => ({ file: 'lib/add.test.mjs', title })) })
  assert.equal(result.status, 'red')
  assert.equal(result.rows[0].proven, true)
  assert.equal(result.rows[1].reason, 'proof-not-red-on-base')
})

test("a named test's support files are copied to the old source, so a missing fixture never supplies the red", async () => {
  for (const runner of ['node', 'junit']) {
    const cwd = scratchDir('proof-support-')
    git(cwd, 'init', '-q')
    if (runner === 'junit') {
      mkdirSync(join(cwd, '.crew'))
      writeFileSync(join(cwd, '.crew/project.json'), JSON.stringify({ proof: [{ match: '*.test.mjs', setup: 'node setup.mjs', run: 'node --test --test-reporter=junit --test-reporter-destination={report} {file}' }] }))
      writeFileSync(join(cwd, 'setup.mjs'), "import { readFileSync } from 'node:fs'; readFileSync('fixtures/golden.json')\n")
    }
    writeFileSync(join(cwd, 'add.mjs'), 'export const add = (a, b) => a + b\nexport const mul = () => 0\n')
    git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
    writeFileSync(join(cwd, 'add.mjs'), 'export const add = (a, b) => a + b\nexport const mul = (a, b) => a * b\n')
    mkdirSync(join(cwd, 'fixtures'))
    writeFileSync(join(cwd, 'fixtures/golden.json'), '{"sum":5,"product":6}')
    writeFileSync(join(cwd, 'add.test.mjs'), `import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { add, mul } from './add.mjs'
test('add matches the golden', () => assert.equal(add(2, 3), JSON.parse(readFileSync(new URL('./fixtures/golden.json', import.meta.url))).sum))
test('mul matches the golden', () => assert.equal(mul(2, 3), JSON.parse(readFileSync(new URL('./fixtures/golden.json', import.meta.url))).product))
`)
    const tests = ['add matches the golden', 'mul matches the golden'].map((title) => ({ file: 'add.test.mjs', title, support: ['fixtures/golden.json'] }))
    const result = await proveTests({ cwd, tests })
    assert.equal(result.rows[0].base.state, 'green')
    assert.equal(result.rows[0].reason, 'proof-not-red-on-base')
    assert.equal(result.rows[1].proven, true)
    assert.ok(result.rows.every((row) => !Object.hasOwn(row, 'support')))
  }
})

test('unsafe or missing support paths are refused per row and a malformed support list is invalid input', async () => {
  const cwd = scratchDir('proof-support-path-'), outside = scratchDir('proof-support-outside-')
  git(cwd, 'init', '-q'); mkdirSync(join(cwd, '.crew'))
  writeFileSync(join(cwd, '.crew/project.json'), JSON.stringify({ proof: [{ match: '*.xml', setup: 'node setup.mjs', run: 'cp {file} {report}' }] }))
  writeFileSync(join(cwd, 'setup.mjs'), "import { existsSync } from 'node:fs'; if (existsSync('test.mjs') || existsSync('actual.json')) process.exit(1)\n")
  writeFileSync(join(cwd, 'old'), 'base'); symlinkSync(outside, join(cwd, 'base-link'))
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  rmSync(join(cwd, 'base-link')); mkdirSync(join(cwd, 'base-link'))
  writeFileSync(join(cwd, 'base-link/file.json'), '{}')
  writeFileSync(join(cwd, 'actual.json'), '{}'); symlinkSync('actual.json', join(cwd, 'link.json'))
  writeFileSync(join(cwd, 'test.mjs'), "import test from 'node:test'; test('x', () => {})\n")
  writeFileSync(join(cwd, 'check.xml'), '<testsuite><testcase name="check"/></testsuite>')
  writeFileSync(join(outside, 'sentinel'), 'keep')
  for (const support of [['../outside.json'], ['missing.json'], ['link.json'], ['base-link/file.json'], ['base-link'], ['actual.json', 'missing.json']]) {
    const result = await proveTests({ cwd, tests: [{ file: 'test.mjs', title: 'x', support }, { file: 'check.xml', title: 'check' }] })
    assert.equal(result.rows[0].reason, 'unsafe-path', String(support))
    assert.equal(result.rows[1].reason, 'proof-not-red-on-base')
    assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'keep')
    assert.deepEqual(readdirSync(outside), ['sentinel'])
  }
  for (const support of [[], 'x', ['']]) {
    const result = await proveTests({ cwd, tests: [{ file: 'test.mjs', title: 'x', support }] })
    assert.equal(result.status, 'unmeasured'); assert.equal(result.reason, 'invalid-input')
  }
})

// MUTATION: run the old source from a git archive copy instead of a worktree.
test('a test that only needs a git checkout is not proven by the old source lacking one', async () => {
  const cwd = scratchDir('proof-env-')
  git(cwd, 'init', '-q'); writeFileSync(join(cwd, 'old'), 'base')
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  writeFileSync(join(cwd, 'env.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { existsSync } from 'node:fs'\ntest('runs in a checkout', () => assert.ok(existsSync('.git')))\n")
  const result = await proveTests({ cwd, tests: [{ file: 'env.test.mjs', title: 'runs in a checkout' }] })
  assert.equal(result.rows[0].base.state, 'green')
  assert.equal(result.rows[0].reason, 'proof-not-red-on-base')
  assert.equal(git(cwd, 'worktree', 'list').trim().split('\n').length, 1)
})

// MUTATION: remove the old-source worktree with a single --force.
test('an old-source test that locks its worktree is still removed', async () => {
  const cwd = scratchDir('proof-lock-')
  git(cwd, 'init', '-q'); writeFileSync(join(cwd, 'old'), 'base')
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  writeFileSync(join(cwd, 'lock.test.mjs'), "import test from 'node:test'\nimport { execFileSync } from 'node:child_process'\ntest('locks', () => { execFileSync('git', ['worktree', 'lock', process.cwd()]) })\n")
  const result = await proveTests({ cwd, tests: [{ file: 'lock.test.mjs', title: 'locks' }] })
  assert.notEqual(result.reason, 'cleanup-unproven')
  assert.equal(git(cwd, 'worktree', 'list').trim().split('\n').length, 1)
})

// MUTATION: drop the reporter's import-failure classification.
test('static and dynamic import failures on the old source are unproven', async () => {
  const cwd = scratchDir('proof-import-')
  git(cwd, 'init', '-q'); writeFileSync(join(cwd, 'old'), 'base')
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  writeFileSync(join(cwd, 'new.mjs'), 'export const value = 1\n')
  writeFileSync(join(cwd, 'static.test.mjs'), "import test from 'node:test'\nimport './new.mjs'\ntest('static', () => {})\n")
  writeFileSync(join(cwd, 'dynamic.test.mjs'), "import test from 'node:test'\ntest('dynamic', async () => { await import('./new.mjs') })\n")
  const result = await proveTests({ cwd, tests: ['static', 'dynamic'].map((title) => ({ file: `${title}.test.mjs`, title })) })
  assert.equal(result.status, 'red')
  for (const row of result.rows) { assert.equal(row.proven, false); assert.equal(row.reason, 'proof-not-red-on-base'); assert.equal(row.build.state, 'green') }
})

// MUTATION: restore the matches parameter to testState.
test('testState takes only the events and classifies them without a matcher', () => {
  assert.equal(testState.length, 1)
  for (const [event, state] of [[{ type: 'test:pass' }, 'green'], [{ type: 'test:fail', failureType: 'testCodeFailure' }, 'red']]) {
    assert.deepEqual(testState([event]), { state, reason: null })
  }
})

test('testState refuses missing, ambiguous, skipped, todo, hook and cancelled results', () => {
  for (const [events, reason] of [[[], 'missing'], [[{}, {}], 'ambiguous'], [[{ skip: true }], 'skipped'], [[{ todo: true }], 'todo'], [[{ failureType: 'hookFailed' }], 'hook-failed'], [[{ failureType: 'cancelledByParent' }], 'cancelled']]) assert.equal(testState(events).reason, reason)
})

test('unsupported runners and symlinked paths are refused without outside writes', async () => {
  const cwd = scratchDir('proof-path-'), outside = scratchDir('proof-outside-')
  git(cwd, 'init', '-q'); symlinkSync(outside, join(cwd, 'parent'))
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  rmSync(join(cwd, 'parent')); mkdirSync(join(cwd, 'parent'))
  writeFileSync(join(cwd, 'parent/a.test.mjs'), 'test')
  writeFileSync(join(cwd, 'actual.mjs'), 'test'); symlinkSync('actual.mjs', join(cwd, 'link.mjs'))
  writeFileSync(join(outside, 'sentinel'), 'keep')
  const result = await proveTests({ cwd, tests: [{ file: 'x.ts', title: 'x' }, { file: 'link.mjs', title: 'x' }, { file: 'parent/a.test.mjs', title: 'x' }] })
  assert.deepEqual(result.rows.map((r) => r.reason), ['unsupported-runner', 'unsafe-path', 'unsafe-path'])
  assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'keep')
})

// MUTATION: delete the tmp dir even when the worktree is kept.
test('a worktree that cannot be removed is kept and reported as cleanup-unproven', async () => {
  const cwd = scratchDir('proof-kept-'), tmp = scratchDir('proof-tmp-'), prior = process.env.TMPDIR
  git(cwd, 'init', '-q'); writeFileSync(join(cwd, 'old'), 'base')
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  writeFileSync(join(cwd, 'kept.test.mjs'), "import test from 'node:test'\nimport { statSync, rmSync } from 'node:fs'\ntest('kept', () => { if (statSync('.git').isFile()) rmSync('.git') })\n")
  try {
    process.env.TMPDIR = tmp
    const result = await proveTests({ cwd, tests: [{ file: 'kept.test.mjs', title: 'kept' }] })
    assert.equal(result.status, 'unmeasured'); assert.equal(result.reason, 'cleanup-unproven')
    assert.ok(existsSync(result.kept)); assert.ok(result.kept.endsWith('/base'))
  } finally { if (prior === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prior }
})

// MUTATION: return unmeasured('runner-threw') without rows.
test('a throw inside proveTests is unmeasured runner-threw with the rows it had', async () => {
  const cwd = scratchDir('proof-throw-'), tmp = scratchDir('proof-tmp-'), prior = process.env.TMPDIR
  const tests = [{ file: 'x.test.mjs', title: 'x' }]
  try {
    process.env.TMPDIR = join(tmp, 'absent')
    assert.deepEqual(await proveTests({ cwd, tests }), { status: 'unmeasured', reason: 'runner-threw', rows: [{ ...tests[0], base: { state: null, reason: 'not-run' }, build: { state: null, reason: 'not-run' }, proven: false, reason: null }] })
  } finally { if (prior === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prior }
})

// MUTATION: drop the line/column identity from proven.
test('the same title at a different line on the old source does not prove', async () => {
  const cwd = scratchDir('proof-line-')
  git(cwd, 'init', '-q'); writeFileSync(join(cwd, 'v.mjs'), 'export const v = 1\n')
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  writeFileSync(join(cwd, 'v.mjs'), 'export const v = 2\n')
  writeFileSync(join(cwd, 'v.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { v } from './v.mjs'\ntest(v === 1 ? 'x' : 'y', () => assert.equal(v, 2))\ntest(v === 2 ? 'x' : 'z', () => {})\n")
  const result = await proveTests({ cwd, tests: [{ file: 'v.test.mjs', title: 'x' }] })
  assert.equal(result.status, 'red'); assert.equal(result.reason, 'proof-unproven')
  assert.equal(result.rows[0].base.state, 'red'); assert.equal(result.rows[0].build.state, 'green'); assert.equal(result.rows[0].proven, false)
})

// MUTATION: drop timeoutMs from the old-source testEvents call.
test('a timed-out test file is unmeasured on its own rows and rows in other files are still proven', { timeout: 20_000 }, async () => {
  for (const side of ['base', 'build']) {
    const cwd = scratchDir('proof-timeout-')
    git(cwd, 'init', '-q'); writeFileSync(join(cwd, 'v.mjs'), "export const v = 'base'\n")
    git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
    writeFileSync(join(cwd, 'v.mjs'), "export const v = 'build'\n")
    writeFileSync(join(cwd, 'v.test.mjs'), `import test from 'node:test'\nimport { v } from './v.mjs'\ntest('hang', async () => { if (v === '${side}') { setInterval(() => {}, 1000); await new Promise(() => {}) } })\ntest('also', () => {})\n`)
    writeFileSync(join(cwd, 'other.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { v } from './v.mjs'\ntest('works', () => assert.equal(v, 'build'))\n")
    const tests = [{ file: 'v.test.mjs', title: 'hang' }, { file: 'v.test.mjs', title: 'also' }, { file: 'other.test.mjs', title: 'works' }]
    const result = await proveTests({ cwd, tests, timeoutMs: 3000 })
    assert.equal(result.status, 'red'); assert.equal(result.reason, 'proof-unproven')
    for (const row of result.rows.slice(0, 2)) {
      assert.deepEqual(row[side], { state: null, reason: 'timeout' })
      assert.equal(row.reason, 'timeout'); assert.equal(row.proven, false)
      if (side === 'base') assert.deepEqual(row.build, { state: null, reason: 'not-run' })
      else assert.deepEqual(row.base, { state: 'green', reason: null })
    }
    assert.equal(result.rows[2].proven, true); assert.equal(result.rows[2].reason, null)
    assert.equal(git(cwd, 'worktree', 'list').trim().split('\n').length, 1)
  }
})

// MUTATION: only remove tmp when the worktree was added.
test('a failed git worktree add is unmeasured, runs no test and leaves no temp dir', async () => {
  const cwd = scratchDir('proof-add-'), tmp = scratchDir('proof-tmp-'), prior = process.env.TMPDIR
  git(cwd, 'init', '-q'); writeFileSync(join(cwd, 'old'), 'base')
  git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'base')
  try {
    process.env.TMPDIR = tmp
    const result = await proveTests({ cwd, base: 'no-such-ref', tests: [{ file: 'x.test.mjs', title: 'x' }] })
    assert.equal(result.status, 'unmeasured'); assert.equal(result.reason, 'exit-nonzero')
    for (const row of result.rows) assert.equal(row.base.reason, 'not-run')
    assert.deepEqual(readdirSync(tmp), [])
  } finally { if (prior === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prior }
})

test('proof imports only builtins and its pinned check runner and lane-core leaf', () => {
  const imports = (file) => [...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1])
  const proof = imports('./proof.mjs')
  assert.ok(proof.length > 0)
  assert.deepEqual(proof.filter((name) => !name.startsWith('node:')), ['./checks.mjs'])
  const checks = imports('./checks.mjs')
  assert.ok(checks.length > 0)
  assert.deepEqual(checks.filter((name) => !name.startsWith('node:')), ['./lane-core.mjs'])
  const laneCore = imports('./lane-core.mjs')
  assert.ok(laneCore.length > 0 && laneCore.every((name) => name.startsWith('node:')))
  assert.deepEqual(imports('./proof-reporter.mjs'), [])
})
