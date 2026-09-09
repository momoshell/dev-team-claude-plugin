import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { ROOT, scratchDir } from './helpers.mjs'
import {
  RECORDED_SUITE_COST_REPORT,
  main,
  measureSuite,
  parseTap,
  summarizeSuiteCosts,
  trackedSuites,
} from '../scripts/factory/suite-cost.mjs'

function tap(tests, { pass = tests.length, fail = 0, skipped = 0, todo = 0, cancelled = 0 } = {}) {
  return [
    'TAP version 13',
    ...tests.map(({ title, duration }) => [
      `# Subtest: ${title}`,
      'ok 1 - test',
      '  ---',
      `  duration_ms: ${duration}`,
      "  type: 'test'",
      '  ...',
    ].join('\n')),
    `1..${tests.length}`,
    `# tests ${tests.length}`,
    '# suites 0',
    `# pass ${pass}`,
    `# fail ${fail}`,
    `# cancelled ${cancelled}`,
    `# skipped ${skipped}`,
    `# todo ${todo}`,
  ].join('\n') + '\n'
}

function captureOutput() {
  const output = { stdout: [], stderr: [] }
  return {
    output,
    deps: {
      stdout: (line) => output.stdout.push(String(line)),
      stderr: (line) => output.stderr.push(String(line)),
    },
  }
}

test('trackedSuites sorts regular test files from cached and untracked git output', () => {
  const checkout = scratchDir('suite-cost-discovery-')
  const calls = []
  const suites = trackedSuites({
    checkout,
    deps: {
      git: (root, args, options) => {
        calls.push({ root, args, options })
        return 'z.test.mjs\0README.md\0test/new.test.mjs\0test/new.test.mjs\0directory.test.mjs\0'
      },
      statSync: (path) => ({ isFile: () => !path.endsWith('directory.test.mjs') }),
    },
  })
  assert.deepEqual(suites, ['test/new.test.mjs', 'z.test.mjs'])
  assert.deepEqual(calls[0].args, ['ls-files', '-co', '--exclude-standard', '-z'])
  assert.equal(calls[0].root, checkout)
})

test('measureSuite takes three wall samples, derives runner count, and sorts TAP durations', () => {
  const checkout = scratchDir('suite-cost-measure-')
  const outputs = [
    tap([{ title: 'slow', duration: 30 }, { title: 'fast', duration: 10 }]),
    tap([{ title: 'slow', duration: 20 }, { title: 'fast', duration: 8 }]),
    tap([{ title: 'slow', duration: 40 }, { title: 'fast', duration: 12 }]),
  ]
  const times = [0, 1000, 1000, 4000, 4000, 6000]
  const calls = []
  const measured = measureSuite({
    suite: 'test/new.test.mjs',
    checkout,
    deps: {
      env: { FORCE_COLOR: '1', CLICOLOR_FORCE: '1', KEEP_ME: 'yes' },
      now: () => times.shift(),
      spawn: (file, args, options) => {
        calls.push({ file, args, options })
        return { status: 0, stdout: outputs.shift(), stderr: '' }
      },
    },
  })
  assert.equal(measured.duration_seconds, 2)
  assert.equal(measured.test_count, 2)
  assert.equal(measured.seconds_per_test, 1)
  assert.deepEqual(measured.slowest_tests, ['slow', 'fast'])
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0].args, ['--test', '--test-reporter=tap', 'test/new.test.mjs'])
  assert.equal(calls[0].options.cwd, checkout)
  assert.equal(calls[0].options.env.KEEP_ME, 'yes')
  assert.equal('FORCE_COLOR' in calls[0].options.env, false)
  assert.equal('CLICOLOR_FORCE' in calls[0].options.env, false)
})

test('parseTap takes the last complete runner totals and per-test durations', () => {
  const parsed = parseTap(`${tap([{ title: 'old', duration: 1 }])}${tap([{ title: 'new', duration: 7 }, { title: 'other', duration: 2 }])}`)
  assert.equal(parsed.test_count, 2)
  assert.deepEqual(parsed.tests, [{ title: 'new', duration_ms: 7 }, { title: 'other', duration_ms: 2 }])
  assert.equal(parseTap(''), null)
  assert.equal(parseTap('TAP version 13\n# tests nope\n'), null)
})

test('summarizeSuiteCosts records complete denominators and recomputes rates', () => {
  const summary = summarizeSuiteCosts({
    tracked: ['b.test.mjs', 'a.test.mjs', 'unavailable.test.mjs'],
    measurements: [
      { suite: 'b.test.mjs', duration_seconds: 4, test_count: 2, slowest_tests: ['b slow'] },
      { suite: 'a.test.mjs', duration_seconds: 2, test_count: 1, slowest_tests: ['a slow'] },
      { suite: 'unavailable.test.mjs', duration_seconds: null, reason: 'spawn-denied', tests: null },
    ],
  })
  assert.deepEqual(summary.denominator, { suites: 3, measured_suites: 2, tests: 3 })
  assert.equal(summary.suites[0].suite, 'a.test.mjs')
  assert.equal(summary.suites[0].seconds_per_test, 2)
  assert.deepEqual(summary.suites[2], {
    suite: 'unavailable.test.mjs', duration_seconds: null, test_count: null,
    seconds_per_test: null, reason: 'spawn-denied', slowest_tests: [],
  })
  assert.deepEqual(summary.slowest_suites, ['b.test.mjs', 'a.test.mjs'])
  assert.equal(summary.distribution.median, 3)
})

test('unmeasurable suite outcomes stay null with one closed reason', () => {
  const cases = [
    ['spawn denied', () => { const error = new Error('blocked'); error.code = 'EPERM'; throw error }, 'spawn-denied'],
    ['timeout', () => ({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stdout: '' }), 'timeout'],
    ['interrupted', () => ({ status: null, signal: 'SIGINT', stdout: '' }), 'interrupted'],
    ['empty output', () => ({ status: 0, stdout: '' }), 'empty-output'],
    ['malformed TAP', () => ({ status: 0, stdout: 'TAP version 13\n# tests 1\n' }), 'malformed-tap'],
    ['nonzero suite', () => ({ status: 1, stdout: tap([{ title: 'failed', duration: 1 }], { pass: 0, fail: 1 }) }), 'nonzero-exit'],
  ]
  for (const [label, spawn, reason] of cases) {
    const measured = measureSuite({
      suite: `${label.replaceAll(' ', '-')}.test.mjs`,
      runs: 1,
      deps: { now: () => 0, spawn },
    })
    assert.equal(measured.duration_seconds, null, label)
    assert.equal(measured.reason, reason, label)
    assert.notEqual(measured.duration_seconds, 0, label)
  }
})

// The ceiling derivation was WITHDRAWN at closeout: a Tukey upper fence over the
// suite population yields 3 seconds on a fully-measured green tree, because the
// population is dominated by sub-second suites, while a real acceptance gate
// names two or three suites and exceeds 3s at once. Wrong statistic for the
// question, so no number is published. MUTATION: re-export a ceiling derivation
// or republish gate_cost and this test goes red.
// RV1-6 (review 'consider', closed by hand at closeout). rowFromMeasurement passed
// any non-empty string through as a reason, so open vocabulary could enter the
// committed record — the shape "one closed reason" exists to prevent. MUTATION:
// restore the passthrough and this test goes red.
test('RV1-6 an unmeasured suite carries a CLOSED reason, never open vocabulary', () => {
  const open = summarizeSuiteCosts({ tracked: ['t/x.test.mjs'], measurements: [{ suite: 't/x.test.mjs', duration_seconds: null, reason: 'because-i-said-so', tests: null }] })
  assert.equal(open.suites[0].reason, 'not-measured')
  assert.equal(open.suites[0].duration_seconds, null)
  const closed = summarizeSuiteCosts({ tracked: ['t/y.test.mjs'], measurements: [{ suite: 't/y.test.mjs', duration_seconds: null, reason: 'timeout', tests: null }] })
  assert.equal(closed.suites[0].reason, 'timeout')
})

// RV1-4 (review 'consider', closed by hand). One of the six fixture substitutions
// is 0.02s SLOWER and its behaviour proof survived; it was filed under a key named
// cheaper_tests with the savings explanation the five faster rows share, claiming a
// benefit its own numbers refuse. MUTATION: relabel the slower row faster:true, or
// give it the shared savings explanation, and this test goes red.
test('RV1-4 every fixture substitution states truthfully whether it paid off', () => {
  const rows = RECORDED_SUITE_COST_REPORT.fixture_substitutions
  assert.equal(Object.hasOwn(RECORDED_SUITE_COST_REPORT, 'cheaper_tests'), false)
  for (const row of rows) {
    const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
    const actuallyFaster = median(row.after_samples_seconds) < median(row.before_samples_seconds)
    assert.equal(row.faster, actuallyFaster, `${row.title} claims faster=${row.faster}`)
    if (!row.faster) assert.match(row.explanation, /No saving/)
  }
  assert.equal(rows.filter((row) => row.faster).length, 5)
  assert.equal(rows.filter((row) => !row.faster).length, 1)
})

test('no gate-cost ceiling is published, and the withdrawn derivation is gone', async () => {
  const mod = await import('../scripts/factory/suite-cost.mjs')
  assert.equal(Object.hasOwn(mod, 'deriveGateCostCeiling'), false)
  assert.equal(Object.hasOwn(RECORDED_SUITE_COST_REPORT, 'gate_cost'), false)
})

test('CLI help and unknown options are bounded refusals without running a suite', () => {
  const help = captureOutput()
  assert.equal(main(['--help'], help.deps), 0)
  assert.match(help.output.stdout.join(''), /usage: node scripts\/factory\/suite-cost\.mjs/)
  const refused = captureOutput()
  assert.equal(main(['--unknown'], refused.deps), 2)
  assert.match(refused.output.stderr.join(''), /unknown option: --unknown/)
  assert.match(refused.output.stderr.join(''), /reason: usage/)
})

test('RV1-2 records delivered measurements for construction-time suites', () => {
  const discovered = trackedSuites({ checkout: ROOT })
  assert.deepEqual(RECORDED_SUITE_COST_REPORT.suites.map(({ suite }) => suite), discovered)
  assert.equal(RECORDED_SUITE_COST_REPORT.denominator.suites, discovered.length)
  assert.ok(RECORDED_SUITE_COST_REPORT.denominator.measured_suites > 0)
  assert.ok(RECORDED_SUITE_COST_REPORT.denominator.tests > 0)
  const deliveredRows = new Map(RECORDED_SUITE_COST_REPORT.suites.map((row) => [row.suite, row]))
  for (const [suite, testCount] of [
    ['test/factory-dispatch-batch.test.mjs', 290],
    ['test/factory-suite-cost.test.mjs', 9],
  ]) {
    const row = deliveredRows.get(suite)
    assert.equal(row?.reason, null, suite)
    assert.ok(Number.isFinite(row?.duration_seconds), suite)
    assert.equal(row?.test_count, testCount, suite)
    assert.ok(Number.isFinite(row?.seconds_per_test), suite)
    assert.ok(row?.slowest_tests.length > 0, suite)
  }
  assert.deepEqual(
    RECORDED_SUITE_COST_REPORT.slowest_suites,
    [...RECORDED_SUITE_COST_REPORT.slowest_suites].sort((left, right) => {
      const a = RECORDED_SUITE_COST_REPORT.suites.find((row) => row.suite === left).duration_seconds
      const b = RECORDED_SUITE_COST_REPORT.suites.find((row) => row.suite === right).duration_seconds
      return b - a || left.localeCompare(right)
    }),
  )
  const names = [
    'pack mode moves boilerplate to sidecars and preserves the inline verdict',
    'every packed absence uses one closed reason and never invents a value',
    'creates keeps missing-path strict in both where/creates directions and accepts an empty list',
    'scope validation refuses unslashed directories without changing the rendered surface',
    'out refusal and force overwrite follow the CLI contract',
    'stale and malformed coupling acknowledgements refuse by input reason',
  ]
  assert.deepEqual(RECORDED_SUITE_COST_REPORT.fixture_substitutions.map(({ title }) => title), names)
  const observedMutations = ['killed', 'killed', 'killed', 'killed', 'killed', 'survived']
  for (const [index, proof] of RECORDED_SUITE_COST_REPORT.fixture_substitutions.entries()) {
    assert.equal(proof.coverage, 'unchanged')
    assert.equal(proof.mutation, observedMutations[index])
    assert.equal(proof.behavior_proof?.outcome, observedMutations[index])
    // RV1-4: this used to demand the SAME savings explanation on every row, which
    // is how the one substitution that got slower kept claiming a benefit. A row
    // states the shared reason only when it actually paid off.
    assert.match(proof.explanation, proof.faster ? /incidental baseline command/i : /No saving/)
  }
})

test('the report attributes the dominant cost and claims no unsupported saving', () => {
  const report = RECORDED_SUITE_COST_REPORT
  const a = report.attribution
  // #1080 ask 1: the attribution is the deliverable — which tests dominate and what they do.
  assert.equal(a.suite, 'test/factory-make-brief.test.mjs')
  assert.ok(a.dominant_tests.some(({ title }) => title === 'indexing a 70k-symbol file stays within a countable byte budget'))
  assert.ok(a.dominant_tests.some(({ title }) => title === 'tracked key discovery retains a tripwire beyond argv limits'))
  const classifications = new Set(a.dominant_tests.flatMap(({ classifications: values }) => values))
  for (const classification of ['compilation', 'discovery scan', 'real git', 'filesystem fixtures']) assert.ok(classifications.has(classification), classification)
  // ask 2's finding: the dominant cost is inherent, and each retained test says why.
  assert.ok(a.retained_tests.every(({ why }) => typeof why === 'string' && why.length > 0))
  assert.ok(a.retained_tests.some(({ title }) => title.includes('70k-symbol')))
  // and no saving is claimed, with a closed reason rather than silence.
  assert.equal(a.saving_claimed, null)
  assert.equal(a.saving_absent_reason, 'within-sample-noise')
  assert.deepEqual(a.removed_tests, [])
  assert.ok(a.samples_seconds.length > 1)
  assert.equal(Object.hasOwn(report, 'make_brief'), false)
})
