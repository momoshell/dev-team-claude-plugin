import { createHash } from 'node:crypto'
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

function normaliseVacuityIdentity(line) { return line.trim().replace(/\s+/g, ' ') }

// Returns one entry per presence-only site. Takes the whole source because the
// import-binding shape cannot be judged a line at a time: `assert.ok(mod.helper)`
// is export presence when `mod` is an import and a data assertion when it is not.
function vacuitySites(source) {
  const bindings = importBindings(source)
  const okPattern = new RegExp(String.raw`assert\.ok\(\s*(${IDENT})(?:\.${IDENT})?\s*(?:,|\))`, 'g')
  const sites = []
  source.split('\n').forEach((line, index) => {
    for (const [shape, pattern] of SHAPES) {
      if (pattern.test(line)) sites.push({ shape, line: index + 1, identity: normaliseVacuityIdentity(line) })
    }
    for (const match of line.matchAll(okPattern)) {
      if (bindings.has(match[1])) sites.push({ shape: 'PRESENCE_IMPORT', line: index + 1, identity: normaliseVacuityIdentity(line) })
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
// shape — and never something to silence by widening a pattern or changing the
// detector without reading the site.
//
// The WARRANTY is a subset test and still accepts a removal, so an exemption
// never blocks the cleanup it is waiting for. B1's identity reconcile, B1's
// sharedTotal, and F1's digest are AUDIT DATA: a removal makes them red on
// purpose. Re-audit and shrink the audited array in the same commit; this is a
// one-line data edit, not a widening. This deliberately differs from HEAD,
// where the same removal left the file silently green; that silent green is the
// defect #1088 exists to remove.
//
// `verdict` is the visible difference between a site flagged for a human and one
// silently permitted: `by-design` is a presence assertion that is correct on
// purpose (an import firewall, a key-versus-null distinction), `flagged` is a
// live candidate this lane detected and did NOT convert — converting one is a
// different lane with a different fence.
const VACUITY_VERDICTS = Object.freeze(['by-design', 'flagged'])

const AUDITED_VACUITY_LINES = Object.freeze({
  'crew/io-contract.test.mjs': Object.freeze(["assert.equal(typeof io.fingerprintTree, 'function')", "assert.equal(typeof io.runClean, 'function')", "assert.equal(typeof received.deps.emit, 'function')", "assert.equal(typeof io.reseat, 'function')", "assert.equal(typeof io.teardown, 'function')"]),
  'crew/memory.test.mjs': Object.freeze(["assert.equal(typeof memory.openMemory, 'function')", "assert.equal(typeof memory.renderSection, 'function')", "assert.equal(typeof memory.BACKENDS.markdown, 'function')", "assert.equal(typeof handle.context, 'function')", "assert.equal(typeof handle.propose, 'function')", "assert.equal(typeof handle.reconcile, 'function')", "assert.equal(typeof handle.gc, 'function')"]),
  'crew/pi/extensions/advisor.test.mjs': Object.freeze(["assert.doesNotMatch(source, /registerTool/)", "assert.equal(typeof advisor.default, 'function')"]),
  'crew/pi/extensions/lab.test.mjs': Object.freeze(["assert.equal(typeof mod.default, 'function')"]),
  'crew/pi/extensions/subagent.test.mjs': Object.freeze(["assert.equal(typeof mod.default, 'function')"]),
  'crew/reclaim-descendants.test.mjs': Object.freeze(["assert.equal(typeof received.deps.sleep, 'function')"]),
  'crew/roster-refresh.test.mjs': Object.freeze([]),
  'test/factory-emit.test.mjs': Object.freeze(["assert.doesNotMatch(gate.stderr, /no_run/)"]),
  'test/factory-make-brief.test.mjs': Object.freeze(["assert.doesNotMatch(coupled, /BROAD_PIN/)"]),
  'test/fixtures.test.mjs': Object.freeze(["assert.doesNotMatch(source, /toLowerCase/)"]),
  'test/visualizer-server.test.mjs': Object.freeze(["assert.equal(typeof source.recordIntakeBrake, 'function')"]),
  'test/visualizer-shape.test.mjs': Object.freeze(["assert.doesNotMatch(feed, /DatabaseSync/)"]),
})

function frozenVacuitySites(auditedIdentities, verdict, rationale, { tombstone = false } = {}) {
  const normalizedIdentities = Object.freeze(auditedIdentities.map(normaliseVacuityIdentity))
  const audited = new Set(normalizedIdentities)
  const why = `${rationale}; audited identities: ${normalizedIdentities.length === 0 ? '(none)' : normalizedIdentities.join(' | ')}`
  return {
    sites: auditedIdentities.length,
    auditedIdentities: normalizedIdentities,
    verdict,
    rationale,
    tombstone,
    why,
    warranty: (source) => {
      const current = vacuitySites(source)
      return current.every(({ identity }) => audited.has(identity))
    },
  }
}

const VACUITY_EXEMPT = new Map([
  ['crew/io-contract.test.mjs', frozenVacuitySites(AUDITED_VACUITY_LINES['crew/io-contract.test.mjs'], 'flagged', 'audited 2026-09-09: method-presence sites are preconditions for the behavioral calls at crew/io-contract.test.mjs:465, crew/io-contract.test.mjs:633, crew/io-contract.test.mjs:696, and crew/io-contract.test.mjs:705. Outside this lane\'s fence, so flagged rather than converted')],
  ['crew/memory.test.mjs', frozenVacuitySites(AUDITED_VACUITY_LINES['crew/memory.test.mjs'], 'flagged', 'audited 2026-09-09: namespace and handle method-presence sites are preconditions for the memory behavior at crew/memory.test.mjs:264, crew/memory.test.mjs:265, crew/memory.test.mjs:266, crew/memory.test.mjs:270, crew/memory.test.mjs:271, crew/memory.test.mjs:272, and crew/memory.test.mjs:273. Outside this lane\'s fence, so flagged rather than converted')],
  ['crew/pi/extensions/advisor.test.mjs', frozenVacuitySites(AUDITED_VACUITY_LINES['crew/pi/extensions/advisor.test.mjs'], 'flagged', 'audited 2026-09-09: the source absence pin is an import firewall at crew/pi/extensions/advisor.test.mjs:76, while the entrypoint presence site at crew/pi/extensions/advisor.test.mjs:78 remains a flagged export-presence candidate. Outside this lane\'s fence, so flagged rather than converted')],
  ['crew/pi/extensions/lab.test.mjs', frozenVacuitySites(AUDITED_VACUITY_LINES['crew/pi/extensions/lab.test.mjs'], 'flagged', 'audited 2026-09-09: the extension entrypoint presence site is at crew/pi/extensions/lab.test.mjs:206; registration behavior is pinned by the test below it. Outside this lane\'s fence, so flagged rather than converted')],
  ['crew/pi/extensions/subagent.test.mjs', frozenVacuitySites(AUDITED_VACUITY_LINES['crew/pi/extensions/subagent.test.mjs'], 'flagged', 'audited 2026-09-09: the extension entrypoint presence site is at crew/pi/extensions/subagent.test.mjs:191; registration behavior is pinned by the test below it. Outside this lane\'s fence, so flagged rather than converted')],
  ['crew/reclaim-descendants.test.mjs', frozenVacuitySites(AUDITED_VACUITY_LINES['crew/reclaim-descendants.test.mjs'], 'by-design', 'audited 2026-09-09: the injected sleep precondition is at crew/reclaim-descendants.test.mjs:820 and is called on the next line, which makes the record assertion below it meaningful.')],
  ['crew/roster-refresh.test.mjs', frozenVacuitySites(AUDITED_VACUITY_LINES['crew/roster-refresh.test.mjs'], 'by-design', "audited 2026-09-09: the 2026-08-25 positive 'lead' in roster.tiers.mechanical site is absent at HEAD; the only nearby membership assertion is the detector-excluded negative assert.equal('anthropic/embed-1' in normalized, false) at crew/roster-refresh.test.mjs:212", { tombstone: true })],
  // NOT frozenVacuitySites: its warranty is a COUNT, so a file-level exemption would
  // also cover two genuinely vacuous sites that replaced these. This warranty is bound
  // to the exact paired assertions that make the two sites honest — swap either pair
  // for an unpaired absence and the exemption fails rather than absorbing it.
  ['crew/pi/extensions/skeletonread.test.mjs', {
    sites: 2,
    verdict: 'by-design',
    why: "audited 2026-09-09: RS1 retrieves symbol `first`, then symbol `second`, from ONE two-symbol fixture. Each doesNotMatch is paired with a positive match for THE SAME token in the sibling retrieval, so both tokens demonstrably reach the payload and the claim is which symbol body a retrieval carries. The warranty below pins that pairing, not merely the site count",
    warranty: (source) => vacuitySites(source).length <= 2
      && /assert\.match\(value, \/FIRST_BODY\/\)/.test(source)
      && /assert\.doesNotMatch\(value, \/SECOND_BODY\/\)/.test(source)
      && /assert\.match\(other, \/SECOND_BODY\/\)/.test(source)
      && /assert\.doesNotMatch\(other, \/FIRST_BODY\/\)/.test(source),
  }],
  ['test/factory-emit.test.mjs', frozenVacuitySites(AUDITED_VACUITY_LINES['test/factory-emit.test.mjs'], 'by-design', 'audited 2026-09-09: /no_run/ is serialized in the stderr distinction at test/factory-emit.test.mjs:1721, so the assertion discriminates an unknown_flag refusal from a no_run one.')],
  ['test/factory-make-brief.test.mjs', frozenVacuitySites(AUDITED_VACUITY_LINES['test/factory-make-brief.test.mjs'], 'by-design', 'audited 2026-09-10: the /BROAD_PIN/ section distinction is asserted at test/factory-make-brief.test.mjs:2943 and paired with a positive match for the same token in the Tripwires section.')],
  ['test/fixtures.test.mjs', frozenVacuitySites(AUDITED_VACUITY_LINES['test/fixtures.test.mjs'], 'by-design', 'audited 2026-09-09: the /toLowerCase/ source-text guard is at test/fixtures.test.mjs:20 and is paired with a positive production-rule import match.')],
  ['test/visualizer-server.test.mjs', frozenVacuitySites(AUDITED_VACUITY_LINES['test/visualizer-server.test.mjs'], 'flagged', 'audited 2026-09-09: method presence at test/visualizer-server.test.mjs:1649 sits beside a WRITERS.includes() pin and real row assertions that already cover it. Outside this lane\'s fence, so flagged rather than converted')],
  ['test/visualizer-shape.test.mjs', frozenVacuitySites(AUDITED_VACUITY_LINES['test/visualizer-shape.test.mjs'], 'by-design', 'audited 2026-09-09: the /DatabaseSync/ import-firewall pin is at test/visualizer-shape.test.mjs:901 and is paired with a positive openLedger import match.')],
])

const VACUITY_SOURCE_SHA256 = Object.freeze({
  'crew/io-contract.test.mjs': 'b007ea222c33dbefc00c1a0dbca17cda7910839ba469df045c0dd8dfa780ccd2',
  'crew/memory.test.mjs': '8a2c6044f7412a8a8f2b958f97d7a570f9a8ac05af5382d78c0209918889586a',
  'crew/pi/extensions/advisor.test.mjs': '71a2af74e36eda055b7ce4f58ab17ef02e54d37103fa1e32cf14181e51eca7d4',
  'crew/pi/extensions/lab.test.mjs': 'aa1c9a34bd88efeb3679b738a75d933e44a4f42df16d34e7366505cb1abee553',
  'crew/pi/extensions/subagent.test.mjs': 'fa91597e544b54eac9dc22530a1c07784ff3c85aaa23b8122916c103fa84f313',
  'crew/reclaim-descendants.test.mjs': 'd07df878d2754e93d2a968c9ab66af6d40c5f61865dce96be08d6194b0528388',
  'crew/roster-refresh.test.mjs': '90f49f42cabff9cded5f02b712653524bf900f56c4cbda4d2a9821d984b428c9',
  'test/factory-emit.test.mjs': 'fd16aaed4efb97ff4fba3d1125695d6c80a8d8ac3b087ee82575873176d4aabb',
  'test/factory-make-brief.test.mjs': 'e8c03d5dc61ef54bc36d4e182e622de13ac1bd1e438ae0069d07e3831c2f44cf',
  'test/fixtures.test.mjs': '20a7b9c408ca687f8378c3c70ced32c7943179fb520f6326384426f3bb698c55',
  'test/visualizer-server.test.mjs': '1bbec051f10102ce23969e4b5137a78b535423216f3286987921e481c2d81909',
  'test/visualizer-shape.test.mjs': 'a9cbd513b5c6db53995b3935dd5c2c63660e27049337e182fe674f2eccd70479',
})

const SKELETONREAD_FILE = 'crew/pi/extensions/skeletonread.test.mjs'
const VACUITY_REPLACEMENTS = Object.freeze({
  PRESENCE_TYPEOF: "assert.equal(typeof auditReplacement.missing, 'function')",
  UNSERIALISED_KEY: 'assert.doesNotMatch(String(auditReplacement), /NEVER_SERIALISED_KEY/)',
})

function assertVacuityMapGuard(file, exemption) {
  assert.equal(exemption.sites, exemption.auditedIdentities.length, `site metadata drifted for ${file}`)
  if (exemption.sites === 0) {
    assert.equal(exemption.tombstone, true, `${file} zero-site entry requires a tombstone`)
    assert.deepEqual(exemption.auditedIdentities, [], `${file} tombstones cannot audit identities`)
    assert.match(exemption.why, /^audited 2026-09-09:/, `${file} tombstone needs a fresh audit date`)
  } else {
    assert.equal(exemption.tombstone, false, `${file} tombstones cannot carry sites`)
  }
}

function rewriteVacuityIdentity(source, identity, replacement) {
  let matches = 0
  const rewritten = source.split('\n').map((line) => {
    if (normaliseVacuityIdentity(line) !== identity) return line
    matches += 1
    if (replacement === '') return ''
    return `${line.match(/^\s*/)?.[0] ?? ''}${replacement}`
  }).join('\n')
  assert.equal(matches, 1, `expected one source line for ${identity}, found ${matches}`)
  return rewritten
}

function assertIdentityWarranty(file) {
  const exemption = VACUITY_EXEMPT.get(file)
  const source = readFileSync(join(ROOT, file), 'utf8')
  const audited = exemption.auditedIdentities
  if (audited.length === 0) {
    const inserted = `${source}\nassert.ok('invented' in auditReplacement)\n`
    assert.equal(exemption.warranty(inserted), false, `${file} accepted an unaudited insertion`)
    return
  }
  const current = vacuitySites(source)
  assert.deepEqual(current.map(({ identity }) => identity), audited, `${file} live identities do not reconcile`)
  for (const identity of audited) {
    const site = current.find((candidate) => candidate.identity === identity)
    assert.ok(site, `${file} is missing audited identity ${identity}`)
    const replacement = VACUITY_REPLACEMENTS[site.shape]
    assert.ok(replacement, `no deterministic replacement for ${site.shape}`)
    const changed = rewriteVacuityIdentity(source, identity, replacement)
    assert.equal(exemption.warranty(changed), false, `${file} accepted a same-shape replacement for ${identity}`)
    const removed = rewriteVacuityIdentity(source, identity, '')
    assert.equal(exemption.warranty(removed), true, `${file} rejected removal of ${identity}`)
  }
}

test('A1.io-contract', () => assertIdentityWarranty('crew/io-contract.test.mjs'))
test('A1.memory', () => assertIdentityWarranty('crew/memory.test.mjs'))
test('A1.advisor', () => assertIdentityWarranty('crew/pi/extensions/advisor.test.mjs'))
test('A1.lab', () => assertIdentityWarranty('crew/pi/extensions/lab.test.mjs'))
test('A1.subagent', () => assertIdentityWarranty('crew/pi/extensions/subagent.test.mjs'))
test('A1.reclaim-descendants', () => assertIdentityWarranty('crew/reclaim-descendants.test.mjs'))
test('A1.roster-refresh', () => assertIdentityWarranty('crew/roster-refresh.test.mjs'))
test('A1.factory-emit', () => assertIdentityWarranty('test/factory-emit.test.mjs'))
test('A1.factory-make-brief', () => assertIdentityWarranty('test/factory-make-brief.test.mjs'))
test('A1.fixtures', () => assertIdentityWarranty('test/fixtures.test.mjs'))
test('A1.visualizer-server', () => assertIdentityWarranty('test/visualizer-server.test.mjs'))
test('A1.visualizer-shape', () => assertIdentityWarranty('test/visualizer-shape.test.mjs'))

test('B1', () => {
  let total = 0
  let sharedTotal = 0
  for (const [file, exemption] of VACUITY_EXEMPT) {
    let source
    try { source = readFileSync(join(ROOT, file), 'utf8') }
    catch (err) { assert.fail(`exemption ${file} is missing or unreadable: ${err.message}`) }
    assert.ok(exemption.why.length > 20, `exemption ${file} carries no audited reason`)
    assert.ok(VACUITY_VERDICTS.includes(exemption.verdict), `exemption ${file} carries no verdict`)
    assert.equal(exemption.warranty(source), true, `exemption ${file} warranty no longer holds`)
    if (file === SKELETONREAD_FILE) {
      assert.equal(exemption.sites, 2, 'skeletonread site accounting changed')
    } else {
      assertVacuityMapGuard(file, exemption)
      assert.deepEqual(vacuitySites(source).map(({ identity }) => identity), exemption.auditedIdentities, `${file} live identities do not reconcile. Re-audit and shrink the audited array in the same commit; this is a one-line data edit, not a widening.`)
      sharedTotal += exemption.auditedIdentities.length
    }
    total += file === SKELETONREAD_FILE ? exemption.sites : exemption.auditedIdentities.length
  }
  assert.equal(sharedTotal, 22)
  assert.equal(total, 24)
})

test('C1', () => {
  for (const [file, exemption] of VACUITY_EXEMPT) {
    if (file === SKELETONREAD_FILE) continue
    const source = readFileSync(join(ROOT, file), 'utf8')
    assertVacuityMapGuard(file, exemption)
    assert.equal(Object.isFrozen(exemption.auditedIdentities), true, `${file} identities are not frozen`)
    assert.deepEqual(exemption.auditedIdentities, exemption.auditedIdentities.map(normaliseVacuityIdentity), `${file} identities are not normalized`)
    const suffix = exemption.auditedIdentities.length === 0 ? '(none)' : exemption.auditedIdentities.join(' | ')
    assert.equal(exemption.why, `${exemption.rationale}; audited identities: ${suffix}`, `${file} why is not generated from its audit`)
    assert.equal(exemption.warranty(source), true, `${file} unchanged source does not satisfy its warranty`)
    assert.match(exemption.warranty.toString(), /return current\.every\(\(\{ identity \}\) => audited\.has\(identity\)\)/, `${file} warranty is not identity-based`)
    assert.doesNotMatch(exemption.warranty.toString(), /vacuitySites\(source\)\.length\s*<=/, `${file} retains a bare count warranty`)
    assertIdentityWarranty(file)
  }
  const untombstoned = frozenVacuitySites([], 'flagged', 'audited 2026-09-09: synthetic zero')
  assert.throws(() => assertVacuityMapGuard('synthetic', untombstoned), /tombstone/)
  const siteTombstone = frozenVacuitySites(['synthetic'], 'flagged', 'audited 2026-09-09: synthetic site', { tombstone: true })
  assert.throws(() => assertVacuityMapGuard('synthetic', siteTombstone), /tombstone/)
})

test('D1', () => {
  const source = readFileSync(join(ROOT, VACUITY_SELF), 'utf8')
  const start = source.indexOf('  // NOT frozenVacuitySites')
  const end = source.indexOf("  ['test/factory-emit.test.mjs'", start)
  assert.ok(start >= 0 && end > start, 'skeletonread block boundaries are missing')
  const block = source.slice(start, end)
  assert.equal(createHash('sha256').update(block).digest('hex'), '02e634395bfdeb878446a41100ef1e4a44e8ac92a433a82096d1cc26a8447b2d')
})

test('E1', () => {
  const roster = VACUITY_EXEMPT.get('crew/roster-refresh.test.mjs')
  assert.match(roster.rationale, /^audited 2026-09-09:/)
  assert.match(roster.rationale, /2026-08-25 positive 'lead' in roster\.tiers\.mechanical site is absent at HEAD/)
  assert.match(roster.rationale, /only nearby membership assertion is the detector-excluded negative assert\.equal\('anthropic\/embed-1' in normalized, false\) at crew\/roster-refresh\.test\.mjs:212/)
  assert.doesNotMatch(roster.rationale, /:146/)
  for (const [file, exemption] of VACUITY_EXEMPT) {
    if (!exemption.rationale) continue
    const citations = [...exemption.rationale.matchAll(/([A-Za-z0-9_./-]+\.test\.mjs):(\d+)/g)]
    assert.ok(citations.length > 0, `${file} rationale has no current line citation`)
    for (const [, citedFile, lineNumber] of citations) {
      assert.equal(citedFile, file, `${file} rationale cites ${citedFile}`)
      const line = readFileSync(join(ROOT, citedFile), 'utf8').split('\n')[Number(lineNumber) - 1]
      assert.ok(line !== undefined, `${citedFile}:${lineNumber} is outside the source`)
      const identity = normaliseVacuityIdentity(line)
      if (file === 'crew/roster-refresh.test.mjs') {
        assert.equal(identity, "assert.equal('anthropic/embed-1' in normalized, false)", `${citedFile}:${lineNumber} is not the retained negative assertion`)
      } else {
        assert.ok(exemption.auditedIdentities.includes(identity), `${citedFile}:${lineNumber} is not an audited identity`)
      }
    }
  }
})

// This intentionally over-triggers on a no-vacuity edit such as a comment typo;
// that is the accepted price of pinning the audit to bytes rather than to a count.
test('F1', () => {
  for (const [file, expected] of Object.entries(VACUITY_SOURCE_SHA256)) {
    const digest = createHash('sha256').update(readFileSync(join(ROOT, file))).digest('hex')
    assert.equal(digest, expected, `${file}: this lane's exemption audit is pinned to this file's bytes; re-read the audited identities for ${file}; B1 says which identity moved. If a detected site was added, moved, or removed, update its audited array and this digest in the same commit.`)
  }
})

test('presence-only tripwire — no unexempted test file asserts a name into existence', () => {
  const scanned = vacuityScannedFiles()
  assert.ok(scanned.length >= VACUITY_SCAN_FLOOR, `expected at least ${VACUITY_SCAN_FLOOR} scanned files, found ${scanned.length}`)
  const offenders = scanned.filter((file) => {
    if (VACUITY_EXEMPT.has(file)) return false
    return vacuitySites(readFileSync(join(ROOT, file), 'utf8')).length > 0
  })
  assert.deepEqual(offenders, [])
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
  assert.equal(report.sites, 24)
})
