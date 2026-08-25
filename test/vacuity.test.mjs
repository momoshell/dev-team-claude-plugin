import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'

// Presence-only assertion tripwire (#623, epic #546). The rule this enforces:
// a check may assert only against an authoritative stream or mutable data, never
// against the presence of a service, method, key or symbol. Four instances of the
// violation were each found by a human reading a diff (#578, #603, #581, and the
// typeof-presence family #536 indexes); this file is the detector that finds the
// fifth. It is a SECOND tripwire, deliberately in its own file: the helper
// duplication tripwire in test/helpers.test.mjs is the shape it copies, not a
// file it extends.
//
// Blind spot, stated rather than discovered: the detector is line-oriented, so an
// assertion split across lines by a formatter is invisible, as is any presence
// check written through a helper of the test's own (`expectMethod(mod, 'x')`).
// A test file under a NEW top-level directory is not scanned either — the scan
// floor below is the cheap guard against a detector that reads nothing.
const VACUITY_SELF = 'test/vacuity.test.mjs'
const VACUITY_SCAN_DIRS = ['commands', 'crew', 'scripts', 'skills', 'test', 'visualizer']
// A detector that scans nothing passes. This floor is the single line that makes
// the rest of the file mean anything; 60 files are in the scan set today.
const VACUITY_SCAN_FLOOR = 50

const IDENT = String.raw`[A-Za-z_$][\w$]*`
// Dotted receivers only. `typeof io.reseat === 'function'` asserts METHOD
// presence on a service; `typeof onExit === 'function'` is a fixture precondition
// on a captured callback, and in this repo it is always followed by calling it,
// which is the behaviour. Requiring the dot is the line between the two.
const MEMBER = String.raw`${IDENT}(?:\.${IDENT})+`
const SHAPES = Object.freeze([
  ['PRESENCE_TYPEOF', new RegExp([
    String.raw`assert\.(?:ok|equal|strictEqual)\(\s*(?:!\s*)?typeof\s+${MEMBER}\s*(?:===|!==)\s*['"](?:function|undefined)['"]`,
    String.raw`assert\.(?:equal|strictEqual|notEqual)\(\s*typeof\s+${MEMBER}\s*,\s*['"](?:function|undefined)['"]`,
  ].join('|'))],
  // Only the POSITIVE form. `assert.equal('k' in o, false)` observes that a key is
  // absent from real data, which is a measurement; asserting a key IS there
  // guards nothing the value assertion beside it does not already guard.
  ['PRESENCE_IN', new RegExp([
    String.raw`assert\.ok\(\s*['"][\w.-]+['"]\s+in\s+${IDENT}`,
    String.raw`assert\.(?:equal|strictEqual)\(\s*['"][\w.-]+['"]\s+in\s+[^,]+,\s*true\s*\)`,
  ].join('|'))],
  // #578/#580 RV1-2: a doesNotMatch whose whole pattern is one compound
  // identifier is a claim about a KEY NAME, and a key name that is never
  // serialised cannot make it fail. A single lowercase word is prose that really
  // does appear in output, so it is not flagged.
  ['UNSERIALISED_KEY', new RegExp(String.raw`assert\.(?:doesNotMatch|notMatch)\(\s*[^,]+,\s*/\^?(?:[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+|[a-z]+[A-Z][\w]*|[A-Z][a-z]+[A-Z][\w]*)\$?/[gimsuy]*\s*[,)]`)],
  // #603: a declaration detector anchored at column 0 on `function` alone never
  // sees `const git = (...) => ...`, the commonest way this repo writes a small
  // helper. A pattern that also admits const/let/var is the fixed form.
  ['NARROW_DECL_REGEX', /\^(?:\\\^)?(?:export\\s\+)?function[\\(\s]/],
  // #581: execFileSync/execSync throw on a non-zero exit and `git grep` exits 1
  // when it finds nothing, so such a guard can only report the outcome it was
  // written to forbid by finding it. scripts/factory/absence.mjs is the fix.
  ['GREP_EXIT_GUARD', /(?:execFileSync|execSync)\(\s*'git(?: grep)?'\s*,?\s*\[?\s*'?grep/],
])

function importBindings(source) {
  const names = new Set()
  const pattern = /import\s+(?:\*\s+as\s+(\w+)|(\w+)\s*,?\s*(?:\{([^}]*)\})?|\{([^}]*)\})\s+from/g
  for (const match of source.matchAll(pattern)) {
    if (match[1]) names.add(match[1])
    if (match[2]) names.add(match[2])
    for (const group of [match[3], match[4]]) {
      if (!group) continue
      for (const part of group.split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim()
        if (name) names.add(name)
      }
    }
  }
  return names
}

// Returns one entry per presence-only site. Takes the whole source because the
// import-binding shape cannot be judged a line at a time: `assert.ok(mod.helper)`
// is export presence when `mod` is an import and a data assertion when it is not.
function vacuitySites(source) {
  const bindings = importBindings(source)
  const okPattern = new RegExp(String.raw`assert\.ok\(\s*(${IDENT})(?:\.${IDENT})?\s*(?:,|\))`, 'g')
  const sites = []
  source.split('\n').forEach((line, index) => {
    for (const [shape, pattern] of SHAPES) {
      if (pattern.test(line)) sites.push({ shape, line: index + 1 })
    }
    for (const match of line.matchAll(okPattern)) {
      if (bindings.has(match[1])) sites.push({ shape: 'PRESENCE_IMPORT', line: index + 1 })
    }
  })
  return sites
}

// Derived, never hand-listed. A literal list stops covering the next test file
// someone adds, and the sibling lanes in this batch are adding some.
function vacuityTestFiles(dir, out = []) {
  for (const name of readdirSync(join(ROOT, dir)).sort()) {
    const rel = `${dir}/${name}`
    if (statSync(join(ROOT, rel)).isDirectory()) { if (name !== 'node_modules') vacuityTestFiles(rel, out) }
    else if (name.endsWith('.test.mjs')) out.push(rel)
  }
  return out
}

function vacuitySharedModules(dir = 'test') {
  return readdirSync(join(ROOT, dir)).sort()
    .map((name) => `${dir}/${name}`)
    .filter((rel) => rel.endsWith('.mjs') && !rel.endsWith('.test.mjs') && statSync(join(ROOT, rel)).isFile())
}

function vacuityScannedFiles() {
  return [...VACUITY_SCAN_DIRS.flatMap((dir) => vacuityTestFiles(dir)), ...vacuitySharedModules()]
    .filter((rel) => rel !== VACUITY_SELF)
}

// Frozen, not forgiven, and AUDITED DATA rather than logic: re-auditing after a
// rebase is an edit to the map below and nothing else. A red here after a rebase
// is a real finding to examine — a sibling lane's new test file carrying the
// shape — and never something to silence by widening a pattern or bumping a
// ceiling without reading the site.
//
// The warranty is the audited site COUNT as a CEILING: add a site to an exempt
// file and its warranty fails. It is deliberately not equality — equality also
// fails when a site is REMOVED, which would turn this test red for doing the
// very thing an exemption is waiting for.
//
// `verdict` is the visible difference between a site flagged for a human and one
// silently permitted: `by-design` is a presence assertion that is correct on
// purpose (an import firewall, a key-versus-null distinction), `flagged` is a
// live candidate this lane detected and did NOT convert — converting one is a
// different lane with a different fence.
const VACUITY_VERDICTS = Object.freeze(['by-design', 'flagged'])

function frozenVacuitySites(sites, verdict, why) {
  return { sites, verdict, why, warranty: (source) => vacuitySites(source).length <= sites }
}

const VACUITY_EXEMPT = new Map([
  ['crew/io-contract.test.mjs', frozenVacuitySites(4, 'flagged', 'audited 2026-08-25: L474 and L537 assert method presence one line before calling the method, so the behaviour is pinned anyway; L546-547 are presence and nothing else. Outside this lane\'s fence, so flagged rather than converted')],
  ['crew/memory.test.mjs', frozenVacuitySites(7, 'flagged', 'audited 2026-08-25: seven typeof-presence assertions over the memory namespace and handle; the load-bearing half of that test is the Object.hasOwn(...) === false pair beside them. Outside this lane\'s fence, so flagged rather than converted')],
  ['crew/pi/extensions/advisor.test.mjs', frozenVacuitySites(2, 'flagged', 'audited 2026-08-25: the /registerTool/ absence pin over advisor.ts SOURCE is by design (an import firewall reads text, and the identifier is exactly what would appear), but L78 typeof advisor.default is export presence only. Outside this lane\'s fence, so flagged rather than converted')],
  ['crew/pi/extensions/lab.test.mjs', frozenVacuitySites(1, 'flagged', 'audited 2026-08-25: one typeof mod.default presence check on the extension entrypoint; the registration behaviour is pinned by the test below it. Outside this lane\'s fence, so flagged rather than converted')],
  ['crew/pi/extensions/subagent.test.mjs', frozenVacuitySites(1, 'flagged', 'audited 2026-08-25: one typeof mod.default presence check on the extension entrypoint; the registration behaviour is pinned by the test below it. Outside this lane\'s fence, so flagged rather than converted')],
  ['crew/reclaim-descendants.test.mjs', frozenVacuitySites(1, 'by-design', 'audited 2026-08-25: L820 asserts the injected sleep is callable and calls it on the next line, which is what makes the record assertion below it mean anything; the presence check is the precondition of a real behavioural step')],
  ['crew/roster-refresh.test.mjs', frozenVacuitySites(1, 'by-design', "audited 2026-08-25: `'lead' in roster.tiers.mechanical` is paired with `equal(..., null)`; `in` is the only way to distinguish an ABSENT key from one whose value is null, which is exactly the claim being made")],
  ['test/factory-emit.test.mjs', frozenVacuitySites(1, 'by-design', 'audited 2026-08-25: /no_run/ IS serialised — emit.mjs writes `[reason: ${err.reason}]` to stderr — so the assertion discriminates an unknown_flag refusal from a no_run one. Not the #578 shape: the key really does reach the payload')],
  ['test/factory-make-brief.test.mjs', frozenVacuitySites(1, 'by-design', 'audited 2026-08-25: the doesNotMatch on /BROAD_PIN/ is paired with a positive match for the same token in the Tripwires section of the same brief, so the token demonstrably reaches the payload and the claim is which SECTION carries it')],
  ['test/fixtures.test.mjs', frozenVacuitySites(1, 'by-design', 'audited 2026-08-25: /toLowerCase/ is an absence pin over fixtures.mjs SOURCE text paired with a positive import match — the fixture guard must import the production rule rather than copy it, and the identifier is exactly what a copy would contain')],
  ['test/visualizer-server.test.mjs', frozenVacuitySites(1, 'flagged', 'audited 2026-08-25: L1360 typeof source.recordIntakeBrake is method presence beside a WRITERS.includes() pin and real row assertions that already cover it. Outside this lane\'s fence, so flagged rather than converted')],
  ['test/visualizer-shape.test.mjs', frozenVacuitySites(1, 'by-design', 'audited 2026-08-25: /DatabaseSync/ is an import-firewall pin over ledger-feed.mjs source, paired with a positive match on the openLedger import; the identifier is exactly what a direct node:sqlite dependency would introduce')],
])

test('presence-only tripwire — no unexempted test file asserts a name into existence', () => {
  const scanned = vacuityScannedFiles()
  assert.ok(scanned.length >= VACUITY_SCAN_FLOOR, `expected at least ${VACUITY_SCAN_FLOOR} scanned files, found ${scanned.length}`)
  const offenders = scanned.filter((file) => {
    if (VACUITY_EXEMPT.has(file)) return false
    return vacuitySites(readFileSync(join(ROOT, file), 'utf8')).length > 0
  })
  assert.deepEqual(offenders, [])
})

test('presence-only tripwire — every exemption has a live, load-bearing warranty', () => {
  let total = 0
  for (const [file, exemption] of VACUITY_EXEMPT) {
    let source
    try { source = readFileSync(join(ROOT, file), 'utf8') }
    catch (err) { assert.fail(`exemption ${file} is missing or unreadable: ${err.message}`) }
    assert.ok(exemption.why.length > 20, `exemption ${file} carries no audited reason`)
    assert.ok(VACUITY_VERDICTS.includes(exemption.verdict), `exemption ${file} carries no verdict`)
    assert.equal(exemption.warranty(source), true, `exemption ${file} warranty no longer holds`)
    assert.ok(exemption.sites > 0, `exemption ${file} is redundant`)
    total += exemption.sites
  }
  assert.equal(total, 22)
})

// The four instances this repo found by hand. Three are FIXED in the tree, so the
// demonstration is against recorded fixture strings, not live files — a detector
// that cannot detect its own repo's known vacuous assertions is itself vacuous.
const FIXTURE_578 = 'assert.doesNotMatch(response.body, /transport_unrecorded/)' // #578/#580 RV1-2
const FIXTURE_603 = String.raw`const LOCAL_DECL = /^function (git|sqliteAvailable)\(/gm` // #603
const FIXTURE_581 = "const hits = execFileSync('git', ['grep', '-n', pattern], { encoding: 'utf8' })" // #581
const FIXTURE_TYPEOF = "assert.equal(typeof mod.helper, 'function')" // #623, the family #536 indexes

test('presence-only tripwire — the detector flags all four recorded instances', () => {
  assert.deepEqual(vacuitySites(FIXTURE_578).map((site) => site.shape), ['UNSERIALISED_KEY'], '#578')
  assert.deepEqual(vacuitySites(FIXTURE_603).map((site) => site.shape), ['NARROW_DECL_REGEX'], '#603')
  assert.deepEqual(vacuitySites(FIXTURE_581).map((site) => site.shape), ['GREP_EXIT_GUARD'], '#581')
  assert.deepEqual(vacuitySites(FIXTURE_TYPEOF).map((site) => site.shape), ['PRESENCE_TYPEOF'], '#623')
  assert.deepEqual(vacuitySites("assert.ok('transport' in payload)").map((site) => site.shape), ['PRESENCE_IN'])
  assert.deepEqual(
    vacuitySites("import * as mod from './x.mjs'\nassert.ok(mod.helper)").map((site) => site.shape),
    ['PRESENCE_IMPORT'],
  )
})

// The other direction. A detector that flags everything is as useless as one that
// flags nothing, and these are the near misses most likely to produce a false
// positive: every one is a real assertion over data or a real absence pin.
test('presence-only tripwire — the detector clears the near-miss shapes', () => {
  for (const clear of [
    "import { git, sqliteAvailable } from './helpers.mjs'",
    'assert.ok(result.pending)',
    'assert.equal(response.json.error, "refused")',
    "assert.equal('evidence' in record, false)",
    'assert.doesNotMatch(body, /unknown/)',
    String.raw`const WIDE = /^\s*(?:export\s+)?(?:function|const|let|var)\s+(git)\b/gm`,
    "const out = spawnSync('git', ['grep', '-n', pattern])",
    "assert.equal(typeof onExit, 'function')",
    'assert.ok(imports.every((one) => one.startsWith("node:")))',
  ]) {
    assert.deepEqual(vacuitySites(clear), [], clear)
  }
})

// What it found on the live tree, printed so the difference between a site
// flagged for a human and one silently permitted is visible in the output and
// not only in a comment above the map.
test('presence-only tripwire — the live report distinguishes flagged from by-design', () => {
  const scanned = vacuityScannedFiles()
  const counts = { 'by-design': 0, flagged: 0 }
  for (const [file, exemption] of VACUITY_EXEMPT) {
    counts[exemption.verdict] += exemption.sites
    console.log(`VACUITY ${exemption.verdict} ${file} ${exemption.sites} — ${exemption.why}`)
  }
  const report = {
    scanned: scanned.length,
    sites: counts['by-design'] + counts.flagged,
    flagged: counts.flagged,
    by_design: counts['by-design'],
    files: VACUITY_EXEMPT.size,
  }
  console.log(`VACUITY-REPORT ${JSON.stringify(report)}`)
  assert.ok(report.flagged > 0, 'a report with nothing flagged is a suspicious result, not a clean bill of health')
  assert.ok(report.by_design > 0, 'a report with nothing permitted by design means the pattern set is too wide')
  assert.equal(report.sites, 22)
})
