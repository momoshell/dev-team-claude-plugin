import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export const CENSUS_FULL_SUITE_SECONDS = 52
export const CENSUS_QUALIFYING_FILES = Object.freeze([
  'skills/crew-dispatch/exhibits.test.mjs',
])

export const CENSUS_EXHIBIT_REGISTER = Object.freeze([
  Object.freeze({ file: 'skills/crew-dispatch/exhibits.test.mjs', kind: 'qualifier', reason: null }),
  Object.freeze({ file: 'test/factory-seams.test.mjs', kind: 'near-miss', reason: 'self-source assertion' }),
  Object.freeze({ file: 'test/factory-suite-cost.test.mjs', kind: 'near-miss', reason: 'dependency-injected discovery' }),
  Object.freeze({ file: 'crew/seat-io-runclean.test.mjs', kind: 'near-miss', reason: 'controlled scratch checkout' }),
  Object.freeze({ file: 'crew/drive-review.test.mjs', kind: 'near-miss', reason: 'dependency-injected fixture inventory' }),
  Object.freeze({ file: 'test/factory-dispatch-batch.test.mjs', kind: 'near-miss', reason: 'controlled fixture inventory' }),
  Object.freeze({ file: 'test/factory-dispatch-batch-fences.test.mjs', kind: 'near-miss', reason: 'controlled fixture inventory' }),
])

export const CENSUS_MEASUREMENT_REASONS = Object.freeze([
  'inventory-denied', 'inventory-interrupted', 'inventory-unknown', 'inventory-empty', 'inventory-malformed',
  'candidate-denied', 'candidate-interrupted', 'candidate-unknown', 'candidate-empty',
  'runner-denied', 'runner-interrupted', 'runner-unknown', 'runner-empty', 'runner-malformed',
  'unlisted-survivor', 'selection-clock-unavailable', 'clock-unavailable', 'empty-selection',
  'empty-output', 'empty-denominator', 'incomplete-tap', 'malformed-output',
])

// A census that could not be COMPLETELY measured makes no claim either way, and reading it as
// green turns the absence of a census into a clear. These are the reasons that mean unmeasured.
// The two clock reasons are deliberately NOT here: a clock that failed leaves the pass/fail
// verdict intact and makes only the DURATION unknown. `empty-denominator` and `empty-selection`
// are likewise measured facts, not absences.
export const CENSUS_UNMEASURED_REASONS = Object.freeze(new Set([
  'inventory-denied', 'inventory-interrupted', 'inventory-unknown', 'inventory-empty', 'inventory-malformed',
  'candidate-denied', 'candidate-interrupted', 'candidate-unknown', 'candidate-empty',
  'runner-denied', 'runner-interrupted', 'runner-unknown', 'runner-empty', 'runner-malformed',
  'unlisted-survivor', 'empty-output', 'incomplete-tap', 'malformed-output',
]))

export const CENSUS_VERDICTS = Object.freeze(['green', 'red', 'unmeasured'])

const TEST_SUFFIX = '.test.mjs'
const REGISTERED_FILES = new Set(CENSUS_EXHIBIT_REGISTER.map(({ file }) => file))
const QUALIFYING_FILES = new Set(CENSUS_QUALIFYING_FILES)

function unavailable(reason) {
  return { value: null, reasons: [reason] }
}

function normalPath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '')
}

function repoPath(checkout, value) {
  const file = normalPath(value)
  const root = normalPath(checkout).replace(/\/$/, '')
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file
}

function shellArg(value) {
  return `'${String(value ?? '').replaceAll("'", "'\"'\"'")}'`
}

export { shellArg }

function resultParts(value) {
  if (typeof value === 'string') return { valid: true, ok: true, output: value, code: null, signal: null }
  if (!value || typeof value !== 'object') return { valid: false, ok: false, output: '', code: null, signal: null }
  const output = value.output ?? (typeof value.stdout === 'string' || typeof value.stderr === 'string'
    ? `${value.stdout || ''}${value.stderr || ''}` : null)
  if (typeof output !== 'string') return { valid: false, ok: false, output: '', code: value.code, signal: value.signal }
  return {
    valid: true,
    ok: value.ok === true || value.status === 0 || value.code === 0,
    output,
    code: value.code ?? null,
    signal: value.signal ?? null,
  }
}

function reasonForError(error, prefix) {
  const value = String(error?.code || error?.signal || '').toUpperCase()
  if (value === 'EPERM' || value === 'EACCES' || value === 'ENOENT') return `${prefix}-denied`
  if (value === 'EINTR' || value === 'SIGINT' || value === 'SIGTERM' || value === 'ABORT_ERR' || error?.name === 'AbortError') return `${prefix}-interrupted`
  return `${prefix}-unknown`
}

function reasonForResult(result, prefix) {
  const parsed = resultParts(result)
  if (!parsed.valid) return `${prefix}-malformed`
  if (parsed.ok) return null
  const value = String(parsed.code || parsed.signal || '').toUpperCase()
  if (value === 'EPERM' || value === 'EACCES' || value === 'ENOENT') return `${prefix}-denied`
  if (value === 'EINTR' || value === 'SIGINT' || value === 'SIGTERM' || value === 'ABORT_ERR') return `${prefix}-interrupted`
  return `${prefix}-unknown`
}

function defaultRun(command, checkout) {
  try {
    return {
      ok: true,
      output: execFileSync('/bin/sh', ['-c', command], {
        cwd: checkout,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    }
  } catch (error) {
    return {
      ok: false,
      output: error?.stdout?.toString?.() || error?.message || '',
      code: error?.code,
      signal: error?.signal,
    }
  }
}

function defaultTestRun(file, checkout) {
  const env = { ...process.env, NO_COLOR: '1' }
  delete env.FORCE_COLOR
  delete env.CLICOLOR_FORCE
  try {
    return {
      ok: true,
      output: execFileSync(process.execPath, ['--test', '--test-reporter=tap', file], {
        cwd: checkout,
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    }
  } catch (error) {
    return {
      ok: false,
      output: `${error?.stdout?.toString?.() || ''}${error?.stderr?.toString?.() || ''}` || error?.message || '',
      code: error?.code,
      signal: error?.signal,
    }
  }
}

function parseInventory(result, checkout) {
  const parsed = resultParts(result)
  if (!parsed.valid) return unavailable('inventory-malformed')
  if (!parsed.ok) return unavailable(reasonForResult(result, 'inventory'))
  if (parsed.output.length === 0) return unavailable('inventory-empty')
  if (!parsed.output.endsWith('\0')) return unavailable('inventory-malformed')
  const files = parsed.output.split('\0').filter(Boolean).map((file) => repoPath(checkout, file))
  if (files.some((file) => file === '' || file.startsWith('../') || file.startsWith('/'))) return unavailable('inventory-malformed')
  const unique = [...new Set(files)]
  if (unique.length === 0) return unavailable('inventory-empty')
  return { value: unique, reasons: [] }
}

function attachSelection(selection, metadata) {
  Object.defineProperties(selection, {
    reason: { value: metadata.reason ?? null, enumerable: false },
    reasons: { value: metadata.reasons ?? [], enumerable: false },
    inventory: { value: metadata.inventory ?? [], enumerable: false },
    candidates: { value: metadata.candidates ?? [], enumerable: false },
    survivors: { value: metadata.survivors ?? [], enumerable: false },
    defects: { value: metadata.defects ?? [], enumerable: false },
    register: { value: CENSUS_EXHIBIT_REGISTER, enumerable: false },
  })
  return selection
}

function sourceReader(checkout, deps) {
  if (typeof deps.readFile === 'function') return deps.readFile
  if (typeof deps.readFileSync === 'function') return deps.readFileSync
  return (file) => readFileSync(`${checkout}/${repoPath(checkout, file)}`, 'utf8')
}

export function selectCensusExhibits({ checkout, deps = {} } = {}) {
  const root = typeof checkout === 'string' && checkout.length > 0 ? checkout : process.cwd()
  const run = typeof deps.run === 'function' ? deps.run : (command) => defaultRun(command, root)
  let inventoryResult
  try {
    inventoryResult = run(`git -C ${shellArg(root)} ls-files -z`)
  } catch (error) {
    const reason = reasonForError(error, 'inventory')
    return attachSelection([], { reason, reasons: [reason] })
  }
  const inventory = parseInventory(inventoryResult, root)
  if (inventory.value === null) return attachSelection([], { reason: inventory.reasons[0], reasons: inventory.reasons })
  const candidates = inventory.value.filter((file) => file.endsWith(TEST_SUFFIX)).sort()
  if (candidates.length === 0) return attachSelection([], {
    inventory: inventory.value,
    candidates,
    reason: 'candidate-empty',
    reasons: ['candidate-empty'],
  })

  const read = sourceReader(root, deps)
  const survivors = []
  for (const file of candidates) {
    let source
    try {
      source = read(file.startsWith(`${root}/`) ? file : `${root}/${file}`)
    } catch (error) {
      const reason = reasonForError(error, 'candidate')
      return attachSelection([], {
        inventory: inventory.value,
        candidates,
        survivors,
        reason,
        reasons: [reason],
      })
    }
    if (typeof source !== 'string' || source.length === 0) {
      return attachSelection([], {
        inventory: inventory.value,
        candidates,
        survivors,
        reason: 'candidate-empty',
        reasons: ['candidate-empty'],
      })
    }
    if (source.includes('ls-files') || source.includes('ls-tree')) survivors.push(file)
  }

  const unlistedCandidates = survivors.filter((file) => !REGISTERED_FILES.has(file))
  if (unlistedCandidates.length > 0) {
    const defects = unlistedCandidates.map((file) => ({
      file,
      reason: 'unlisted-survivor',
      detail: `${file}: pre-filter survivor is absent from the census register`,
    }))
    return attachSelection([], {
      inventory: inventory.value,
      candidates,
      survivors,
      defects,
      reason: 'unlisted-survivor',
      reasons: defects.map(({ reason }) => reason),
    })
  }

  const selected = CENSUS_QUALIFYING_FILES
    .filter((file) => survivors.includes(file))
    .map((file) => ({ file, test_count: null }))
  return attachSelection(selected, {
    inventory: inventory.value,
    candidates,
    survivors,
    reason: null,
    reasons: [],
  })
}

export const CENSUS_EXHIBIT_PREDICATES = Object.freeze({
  trackedTest: (file) => typeof file === 'string' && file.endsWith(TEST_SUFFIX),
  prefilter: (source) => typeof source === 'string' && (source.includes('ls-files') || source.includes('ls-tree')),
  registered: (file) => REGISTERED_FILES.has(file),
  qualifying: (file) => QUALIFYING_FILES.has(file),
})

function clockValue(now) {
  try {
    const value = now()
    const number = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(number) ? number : null
  } catch {
    return null
  }
}

function elapsedMilliseconds(start, end) {
  if (start === null || end === null) return null
  const value = end - start
  return Number.isFinite(value) && value >= 0 ? value : null
}

function parseLastNumber(text, expression) {
  const matches = [...String(text).matchAll(expression)]
  const last = matches.at(-1)
  return last ? Number(last[1]) : null
}

export function parseCensusTap(tap) {
  const text = String(tap ?? '').replace(/\x1b\[[0-9;]*m/g, '')
  const plan = parseLastNumber(text, /^1\.\.(\d+)\s*$/gm)
  const testsFooter = parseLastNumber(text, /^#\s+tests\s+(\d+)\s*$/gm)
  const pass = parseLastNumber(text, /^#\s+pass\s+(\d+)\s*$/gm)
  const failMatches = [...text.matchAll(/^#\s+fail\s+(\d+)\s*$/gm)]
  const finalFail = failMatches.at(-1)
  const footerFail = finalFail ? Number(finalFail[1]) : null
  const fail = footerFail
  const hasRootNotOk = /^not ok\b/m.test(tap)
  const complete = plan !== null && testsFooter !== null && pass !== null && fail !== null
  const tests = complete ? pass + fail : null
  const failed = footerFail !== null ? footerFail > 0 : hasRootNotOk
  return {
    complete,
    plan,
    tests: complete ? pass + fail : null,
    pass,
    fail: footerFail,
    failed,
    has_root_not_ok: hasRootNotOk,
    incomplete: !complete,
    raw: text,
  }
}

function timedTap(tap, durationMs) {
  const parsed = parseCensusTap(tap)
  const tests = parsed.tests
  return { ...parsed, tests, duration_ms: durationMs }
}

function censusResultBase(selected, selectionMs) {
  return {
    action: 'none',
    verdict: 'green',
    selected: selected.map(({ file }) => file),
    failures: [],
    detail: null,
    selection_ms: selectionMs,
    duration_ms: null,
    selection_seconds: selectionMs === null ? null : selectionMs / 1000,
    run_seconds: null,
    total_seconds: null,
    elapsed_seconds: null,
    denominator: { suites: selected.length, tests: null },
    measurement: null,
    cost: null,
    reason: null,
  }
}

function runnerCommand(files) {
  return [process.execPath, '--test', '--test-reporter=tap', ...files].map(shellArg).join(' ')
}

function boundedDetail(failures) {
  const detail = failures.map(({ file, detail }) => detail || `${file}: RED`).join('\n')
  return detail.length > 2000 ? `${detail.slice(0, 1997)}...` : detail
}

function failureFor(file, parsed) {
  return {
    file,
    relation: null,
    detail: `${file}: census suite red`,
    tests: parsed.tests,
    duration_ms: parsed.duration_ms,
  }
}

export function runCensusExhibits({ checkout, filesInScope = [], deps = {} } = {}) {
  const root = typeof checkout === 'string' && checkout.length > 0 ? checkout : process.cwd()
  const now = typeof deps.now === 'function' ? deps.now : Date.now
  const selectionStart = clockValue(now)
  const selected = selectCensusExhibits({ checkout: root, deps })
  const selectionEnd = clockValue(now)
  const selectionMs = elapsedMilliseconds(selectionStart, selectionEnd)
  const result = censusResultBase(selected, selectionMs)
  result.reason = selected.reason || (selectionMs === null ? 'selection-clock-unavailable' : null)
  if (selected.reason) {
    result.denominator = { suites: null, tests: null }
    result.reasons = selected.reasons
    result.defects = selected.defects
    // Same rule on the early return: discovery that failed measured nothing, so the base
    // `green`/`none` would report a clear that was never taken.
    if (CENSUS_UNMEASURED_REASONS.has(selected.reason)) {
      result.verdict = 'unmeasured'
      result.action = 'escalate'
    }
    return result
  }
  if (selected.length === 0) {
    result.verdict = 'green'
    result.reason = 'empty-selection'
    result.denominator = { suites: 0, tests: null }
    return result
  }

  const run = typeof deps.run === 'function' ? deps.run : (command) => defaultRun(command, root)
  const runStarted = clockValue(now)
  let testCount = 0
  let countComplete = true
  let reason = null
  const failures = []
  const runs = []
  let runnerResult
  try {
    runnerResult = typeof deps.run === 'function'
      ? run(runnerCommand(selected.map(({ file }) => file)))
      : defaultTestRun(selected.map(({ file }) => file).join(' '), root)
  } catch (error) {
    reason = reasonForError(error, 'runner')
    countComplete = false
  }
  const runEnded = clockValue(now)
  const runMs = elapsedMilliseconds(runStarted, runEnded)
  const totalMs = elapsedMilliseconds(selectionStart, runEnded)
  if (runnerResult !== undefined) {
    const parsedResult = resultParts(runnerResult)
    const durationMs = runMs
    if (!parsedResult.valid) {
      reason ||= 'runner-malformed'
      countComplete = false
    } else {
      const tap = timedTap(parsedResult.output, durationMs)
      for (const exhibit of selected) runs.push({ file: exhibit.file, ...tap })
      if (tap.tests === null) countComplete = false
      else testCount += tap.tests
      if (!parsedResult.output) {
        reason ||= 'runner-empty'
        countComplete = false
      } else if (tap.incomplete) {
        reason ||= 'incomplete-tap'
      }
      if (tap.failed) {
        for (const exhibit of selected) failures.push(failureFor(exhibit.file, tap))
      }
    }
  }
  const selectionSeconds = selectionMs === null ? null : selectionMs / 1000
  const runSeconds = runMs === null ? null : runMs / 1000
  const totalSeconds = totalMs === null ? null : totalMs / 1000
  if (selectionMs === null && !reason) reason = 'selection-clock-unavailable'
  if (runMs === null && !reason) reason = 'clock-unavailable'
  if (testCount === 0 && countComplete && !reason) reason = 'empty-denominator'
  const denominatorTests = countComplete ? testCount : null
  const completeClock = selectionSeconds !== null && runSeconds !== null && totalSeconds !== null
  const measurement = completeClock && !reason
    ? {
        selection_seconds: selectionSeconds,
        run_seconds: runSeconds,
        total_seconds: totalSeconds,
        numerator_seconds: totalSeconds,
        denominator_seconds: CENSUS_FULL_SUITE_SECONDS,
        denominator_measured: false,
        denominator_source: 'asserted-constant',
        percentage: Number(((totalSeconds / CENSUS_FULL_SUITE_SECONDS) * 100).toFixed(2)),
      }
    : null
  const cost = completeClock
    ? {
        selection_seconds: selectionSeconds,
        run_seconds: runSeconds,
        total_seconds: totalSeconds,
        subset_seconds: totalSeconds,
        full_suite_seconds: CENSUS_FULL_SUITE_SECONDS,
        full_suite_seconds_measured: false,
        full_suite_seconds_source: 'asserted-constant',
        percentage: Number(((totalSeconds / CENSUS_FULL_SUITE_SECONDS) * 100).toFixed(2)),
      }
    : {
        selection_seconds: selectionSeconds,
        run_seconds: runSeconds,
        total_seconds: totalSeconds,
        subset_seconds: totalSeconds,
        full_suite_seconds: CENSUS_FULL_SUITE_SECONDS,
        full_suite_seconds_measured: false,
        full_suite_seconds_source: 'asserted-constant',
        percentage: null,
      }
  const scope = Array.isArray(filesInScope) ? filesInScope : []
  const relation = (file) => scope.some((entry) => {
    const value = normalPath(String(entry).split('#', 1)[0])
    return value === file || (value.endsWith('/') && file.startsWith(value))
  }) ? 'INSIDE' : 'OUTSIDE'
  for (const failure of failures) {
    failure.relation = relation(failure.file)
    failure.detail = `${failure.file}: ${failure.relation} the lane fence`
  }
  const outside = failures.filter(({ relation: value }) => value === 'OUTSIDE')
  // A failure is the loudest outcome, but an UNMEASURED census is not a green one: a runner
  // killed before it emitted `not ok`, or a survivor the register never listed, means the
  // census made no claim at all. Escalating is the only honest route — a bounce would ask a
  // builder to repair a file nothing accused, and `none` would report a clear nobody measured.
  const unmeasured = failures.length === 0 && reason !== null && CENSUS_UNMEASURED_REASONS.has(reason)
  const action = failures.length > 0
    ? (outside.length > 0 ? 'escalate' : 'bounce')
    : unmeasured ? 'escalate' : 'none'
  const verdict = failures.length > 0 ? 'red' : unmeasured ? 'unmeasured' : 'green'
  result.action = action
  result.verdict = verdict
  result.failures = failures
  result.detail = boundedDetail(failures)
  result.selection_ms = selectionMs
  result.duration_ms = runMs
  result.selection_seconds = selectionSeconds
  result.run_seconds = runSeconds
  result.total_seconds = totalSeconds
  result.elapsed_seconds = totalSeconds
  result.denominator = { suites: selected.length, tests: denominatorTests }
  result.measurement = measurement
  result.cost = cost
  result.reason = reason
  result.runs = runs
  return result
}

function isMain() {
  if (!process.argv[1]) return false
  return normalPath(process.argv[1]) === normalPath(new URL(import.meta.url).pathname)
}

if (isMain()) {
  const result = runCensusExhibits({ checkout: process.cwd() })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
