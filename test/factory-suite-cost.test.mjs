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

const CONSTRUCTION_TIME_SUITES = [
  'test/factory-dispatch-batch-adoption.test.mjs',
  'test/factory-dispatch-batch-cli.test.mjs',
  'test/factory-dispatch-batch-fences.test.mjs',
  'test/factory-dispatch-batch-refusals.test.mjs',
  'test/factory-dispatch-batch.test.mjs',
  'test/factory-suite-cost.test.mjs',
  'test/visualizer-panels.test.mjs',
  'test/visualizer-server.test.mjs',
  'test/visualizer-shape.test.mjs',
]

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

// The recorded report is a timestamped measurement, so a suite added after it was measured has no
// row. That suite is UNMEASURED, returned with a closed reason, never a failure: requiring a row
// forced every lane that adds a test file to re-measure and edit the report (b771). What is still
// refused is a recorded row that names no tracked suite, and a row set that is unsorted or repeated.
export const UNRECORDED_SUITE_REASON = 'recorded-before-suite-existed'

function assertDeliveredConstructionSuites(report, discovered) {
  const recorded = report.suites.map((row) => row?.suite)
  const tracked = new Set(discovered)
  for (const suite of recorded) assert.ok(tracked.has(suite), `recorded suite ${suite} is not a tracked suite`)
  assert.deepEqual(recorded, [...new Set(recorded)].sort(), 'recorded suites are unique and sorted')
  assert.equal(report.denominator.suites, recorded.length)
  assert.ok(report.denominator.measured_suites > 0)
  assert.ok(report.denominator.tests > 0)
  const deliveredRows = new Map(report.suites.map((row) => [row?.suite, row]))
  for (const suite of CONSTRUCTION_TIME_SUITES) {
    const row = deliveredRows.get(suite)
    assert.equal(row?.reason, null, suite)
    assert.ok(Number.isFinite(row?.duration_seconds), suite)
    assert.ok(row && row.test_count > 0, suite)
    assert.ok(Number.isFinite(row?.seconds_per_test), suite)
    assert.ok(row?.slowest_tests.length > 0, suite)
  }
  const recordedSet = new Set(recorded)
  return { unmeasured: discovered.filter((suite) => !recordedSet.has(suite)), reason: UNRECORDED_SUITE_REASON }
}

function cloneReportWithSuiteRows(change) {
  return {
    ...RECORDED_SUITE_COST_REPORT,
    denominator: { ...RECORDED_SUITE_COST_REPORT.denominator },
    suites: RECORDED_SUITE_COST_REPORT.suites.map((row, index) => ({
      ...row,
      ...change(row, index),
    })),
  }
}

test('A1 delivered construction suites reject null and zero counts', () => {
  const discovered = trackedSuites({ checkout: ROOT })
  const nullCountReport = cloneReportWithSuiteRows((row) => row.suite === 'test/factory-suite-cost.test.mjs'
    ? { test_count: null }
    : {})
  const zeroCountReport = cloneReportWithSuiteRows((row) => row.suite === 'test/factory-suite-cost.test.mjs'
    ? { test_count: 0 }
    : {})
  assert.throws(() => assertDeliveredConstructionSuites(nullCountReport, discovered))
  assert.throws(() => assertDeliveredConstructionSuites(zeroCountReport, discovered))
})

test('B1 delivered construction suites reject an unknown tracked row', () => {
  const discovered = trackedSuites({ checkout: ROOT })
  const substitutedReport = cloneReportWithSuiteRows((row) => row.suite === 'test/factory-absence.test.mjs'
    ? { suite: 'test/unknown-suite.test.mjs' }
    : {})
  assert.throws(() => assertDeliveredConstructionSuites(substitutedReport, discovered))
})

// Mutation killed: restoring exact list equality makes a newly added test file fail this suite again.
test('D1 a tracked suite added after the recorded measurement is unmeasured, not a failure', () => {
  const discovered = [...trackedSuites({ checkout: ROOT }), 'test/zz-added-after-measurement.test.mjs'].sort()
  const result = assertDeliveredConstructionSuites(RECORDED_SUITE_COST_REPORT, discovered)
  assert.deepEqual(result.unmeasured, [
    'crew/acp-permission.test.mjs',
    'crew/batch-report.test.mjs',
    'crew/batch.test.mjs',
    'crew/pi/extensions/acp-server.test.mjs',
    'crew/pi/extensions/submit.test.mjs',
    'crew/seat-io-acp.test.mjs',
    'skills/frontend-svelte/exhibits.test.mjs',
    'skills/lean-build/exhibits.test.mjs',
    'skills/ui-design/exhibits.test.mjs',
    'skills/ux/exhibits.test.mjs',
    'test/factory-kill-redundancy.test.mjs',
    'test/factory-lean-debt.test.mjs',
    'test/factory-ledger-advisor.test.mjs',
    'test/factory-ledger-cells.test.mjs',
    'test/factory-ledger-cli.test.mjs',
    'test/factory-ledger-core.test.mjs',
    'test/factory-ledger-escalations.test.mjs',
    'test/factory-ledger-modifiers.test.mjs',
    'test/factory-ledger-sandbox.test.mjs',
    'test/factory-ledger-sessions.test.mjs',
    'test/factory-ledger-store.test.mjs',
    'test/factory-ledger-turns.test.mjs',
    'test/factory-model-reeval.test.mjs',
    'test/factory-mutant-census.test.mjs',
    'test/factory-seat-priors.test.mjs',
    'test/zz-added-after-measurement.test.mjs',
  ])
  assert.equal(result.reason, UNRECORDED_SUITE_REASON)
})

// Mutation killed: dropping the tracked-suite check lets a report describe a suite that does not exist.
test('E1 a recorded row naming no tracked suite is refused', () => {
  const discovered = trackedSuites({ checkout: ROOT }).filter((suite) => suite !== 'test/factory-absence.test.mjs')
  assert.throws(() => assertDeliveredConstructionSuites(RECORDED_SUITE_COST_REPORT, discovered), /is not a tracked suite/)
})

test('C1 delivered construction suites accept changed positive counts', () => {
  const discovered = trackedSuites({ checkout: ROOT })
  const variedReport = cloneReportWithSuiteRows((row, index) => CONSTRUCTION_TIME_SUITES.includes(row.suite)
    ? { test_count: 1000 + index }
    : {})
  assert.doesNotThrow(() => assertDeliveredConstructionSuites(variedReport, discovered))
})

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
  assertDeliveredConstructionSuites(RECORDED_SUITE_COST_REPORT, discovered)
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
