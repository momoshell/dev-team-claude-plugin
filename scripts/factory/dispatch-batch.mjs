#!/usr/bin/env node
// scripts/factory/dispatch-batch.mjs — executable batch dispatch (#584).
// It owns the ordered checks between a batch request directory and background
// crew runs; every failed check is a named refusal and stops the batch.

import { appendFileSync, closeSync, existsSync as fsExistsSync, openSync, readFileSync as fsReadFileSync, readdirSync as fsReaddirSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { spawn as childSpawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseDirectedBrief, scopeMatcher, validateScopeEntries as driveValidateScopeEntries, VARIANT_NAMES, VARIANTS, TURN_CEILING_FLAGS, WAITS_S } from '../../crew/drive.mjs'
import { assertHostQuiet, hostLoad, loadPolicy, withSuiteSlot } from '../../crew/host-load.mjs'
import { protectedHitsIn, resolveProtectedPaths } from '../../crew/protected-paths.mjs'
import { fenceScopesIntersect, parseFenceScope } from '../../crew/fence-scope.mjs'
import { slug } from '../../crew/slug.mjs'
import { LADDER_BANDS, PROPOSAL_BLOCK, TIER_NAMES, extractSymbols, gatherFences, isTripwireFile, validateRequest } from './make-brief.mjs'
import { archivedLanes, crewRoot, discoverLanes, DRIVER_GONE_PERIODS, HEARTBEAT_PERIOD_MS, laneActive, readJournal } from './lane-watch.mjs'

const BATCH_EMPTY = 'batch-empty'
const BATCH_UNREADABLE = 'batch-unreadable'
const TRANSPORT_CONFLICT = 'transport-conflict'
const LANE_UNFENCED = 'lane-unfenced'
const SCOPE_ENTRY_INVALID = 'scope-entry-invalid'
const WHERE_OUTSIDE_FENCE = 'where-outside-fence'
const SIBLING_LEAK = 'sibling-leak'
const WORKTREE_EXISTS = 'worktree-exists'
const BRANCH_TAKEN = 'branch-taken'
const WORKTREE_FAILED = 'worktree-failed'
const COMPILE_REFUSED = 'compile-refused'
const READS_UNRESOLVED = 'reads-unresolved'
const TIER_FLOOR_CONFLICT = 'tier-floor-conflict'
const PROMPT_SURFACE_CONFLICT = 'prompt-surface-conflict'
const BOOT_FAILED = 'boot-failed'
const FENCE_NOT_ARRIVED = 'fence-not-arrived'
const FENCE_COUNT_MISMATCH = 'fence-count-mismatch'
const RUN_FAILED = 'run-failed'
const DEPENDENCY_CYCLE = 'dependency-cycle'
const DEPENDENCY_UNKNOWN = 'dependency-unknown'
const DEPENDENT_BASE_STALE = 'dependent-base-stale'
const PLAN_SCOPE_OUTSIDE_FENCE = 'plan-scope-outside-fence'
const GRAPH_UNMEASURED = 'graph-unmeasured'
const LANE_SHAPE_INVALID = 'lane-shape-invalid'
const FENCE_REGISTER_MISMATCH = 'fence-register-mismatch'
const DIRECTED_BRIEF_INVALID = 'directed-brief-invalid'
const SEAT_FLOOR_CONFLICT = 'seat-floor-conflict'
const CROSS_BATCH_COLLISION = 'cross-batch-collision'
const PLAN_ADOPT_UNREADABLE = 'plan-adopt-unreadable'
const EXTERNAL_FENCE_STALE = 'external-fence-stale'
const EXTERNAL_FENCE_ABANDONED = 'external-fence-abandoned'
const TEST_REACH_UNFENCED = 'test-reach-unfenced'
const FENCE_ADMISSION_UNSOURCED = 'fence-admission-unsourced'
const PLAN_ADOPT_GATE_ABSOLUTE_PATH = 'plan-adopt-gate-absolute-path'

export const FENCE_ADMISSION_EVENT = 'fence-admitted'
export const FENCE_ADMISSION_SOURCES = Object.freeze(['test-reach', 'anchor-pin', 'census-carrier'])

export const REFUSAL_REASONS = Object.freeze([
  BATCH_EMPTY,
  BATCH_UNREADABLE,
  TRANSPORT_CONFLICT,
  LANE_UNFENCED,
  SCOPE_ENTRY_INVALID,
  WHERE_OUTSIDE_FENCE,
  SIBLING_LEAK,
  WORKTREE_EXISTS,
  BRANCH_TAKEN,
  WORKTREE_FAILED,
  COMPILE_REFUSED,
  READS_UNRESOLVED,
  TIER_FLOOR_CONFLICT,
  PROMPT_SURFACE_CONFLICT,
  BOOT_FAILED,
  FENCE_NOT_ARRIVED,
  FENCE_COUNT_MISMATCH,
  RUN_FAILED,
  DEPENDENCY_CYCLE,
  DEPENDENCY_UNKNOWN,
  DEPENDENT_BASE_STALE,
  PLAN_SCOPE_OUTSIDE_FENCE,
  GRAPH_UNMEASURED,
  LANE_SHAPE_INVALID,
  FENCE_REGISTER_MISMATCH,
  DIRECTED_BRIEF_INVALID,
  SEAT_FLOOR_CONFLICT,
  CROSS_BATCH_COLLISION,
  PLAN_ADOPT_UNREADABLE,
  EXTERNAL_FENCE_STALE,
  EXTERNAL_FENCE_ABANDONED,
  TEST_REACH_UNFENCED,
  FENCE_ADMISSION_UNSOURCED,
  PLAN_ADOPT_GATE_ABSOLUTE_PATH,
])
export const WARNING_ROWS_UNPERSISTED_PREFIX = 'dispatch-batch: WARNING rows-unpersisted:'
export const CROSS_BATCH_UNKNOWN_PREFIX = 'dispatch-batch: WARNING cross-batch-unknown:'
export const CROSS_BATCH_BLIND_SPOT = 'BLIND SPOT: a lane booted without --fences declares no surface at all and can be editing anything; a lane whose batch siblings have been reaped records no claim; and a repository whose git dir cannot be measured is not compared. None of those are cleared — they are reported unknown.'

// A fence carried in from another batch is not a sibling: the operator must see WHICH
// live lane it came from and that it was never counted in the arrival total checkArrival derives (#845).
export const EXTERNAL_FENCE_PREFIX = 'dispatch-batch: external-fence'
export const EXTERNAL_REGISTER_NAME = 'dispatch.external.fences.json'

export const ROLES_ANCHOR_MANIFEST = 'crew/roles/anchors.json'
export const ROLES_ANCHOR_COMPANIONS = Object.freeze(['crew/roles/planner.md', 'crew/roles/tech-lead.md'])
export const PROMPT_SURFACE = Object.freeze({ paths: Object.freeze(['crew/roles/', 'crew/guidelines/']), templateBlocks: Object.freeze(['ACCEPTANCE_GATE_BLOCK', 'HOSTILE_ENV_BLOCK', 'CONVENTIONS_BLOCK', 'MUTATION_CONTRACT_BLOCK']) })
export const PROMPT_SURFACE_BLIND_SPOT = 'BLIND SPOT: path matching cannot see a prompt embedded as a template string in a compiler; the named templateBlocks require human recognition.'

// The scan reads anchors.json manifests, which are machine-readable. The DOCS that carry
// those citations are found by citationCarriers below, and its own warning names them, so
// this check no longer has to send the operator looking by hand. What neither check sees is
// a file:line citation that no manifest pins: it is in no key, so no search finds it.
export const ANCHOR_BLIND_SPOT = 'BLIND SPOT: an unpinned file:line citation is in no manifest key, so neither this check nor the citation-carrier check can find it; a citation the anchor corpus does not pin is still discoverable only by hand'

// The blind spot b388-mutanchor paid a whole lane for. Its fence held all four anchors.json
// manifests and NONE of the nine prose and role files whose path:line citations name the lines
// it moved, so the plan was approved, the build finished, and the lane died at the scope gate
// with the work done and no seat able to widen files_in_scope. The manifests are the AUTHORITY
// on which citations exist, so locating the doc that carries one is a literal search for the
// manifest key — exact, not a heuristic over prose — and the result is a list of files to fence
// rather than an instruction to go looking.
export const CITATION_CARRIER_WARNING_PREFIX = 'dispatch-batch: WARNING citation-carrier-unfenced:'
export const CITATION_CARRIER_ROW_LIMIT = 12
// Measured against b388's own loss on 2026-09-03: of the eight citation-bearing files that lane
// had to edit, this check names seven. The eighth,
// skills/crew-recovery/references/escalations.md, carries no shifted citation at all — its
// exhibits.test.mjs:24 set-compares a documented TABLE against the escalate() producers, so a
// lane that adds a producer reddens it while every path:line in it still resolves. A set
// comparison is not a citation and no key search can find it.
export const CITATION_CARRIER_BLIND_SPOT = 'BLIND SPOT: this finds docs carrying a PINNED path:line citation and nothing else. A citation no manifest pins is in no key, and a doc whose exhibit set-compares a documented table against source (skills/crew-recovery/references/escalations.md and the escalate() producers) reddens with every citation in it still correct. Neither is discoverable here; read the exhibits suites of the manifests named above before choosing this fence'

// The scan survives; the refusal does not. #635 made a shifted anchor repairable, so a
// pin outside a lane's fence is a fact an operator should SEE, not a batch outcome.
export const ANCHOR_PIN_WARNING_PREFIX = 'dispatch-batch: WARNING anchor-pin-unfenced:'
// #882 / ADR-040: external pin repair is an operator-owned post-merge action.
export const ANCHOR_PIN_POST_MERGE = 'ADR-040: a manifest pinning only files this lane does not write is not an obligation on this lane and is repaired after the wave merges by an operator running on main — node skills/qa-test-writing/anchor-pin.mjs --repair-all <dir>; a lane that writes the pinned file WILL owe the repair and cannot reach it until the pinning manifest is added to its fence'
// #758: the closing command for a batch. The verb name is a CONSTANT so the line
// dispatch-batch prints and the verb closeout.mjs implements cannot drift apart.
export const MERGE_CHECK_COMMAND = 'node scripts/factory/closeout.mjs merge-check'
export function mergeCheckLine(lanes) {
  return `dispatch-batch: merge-check command=${MERGE_CHECK_COMMAND} ${lanes.join(' ')}`
}
export const CITATION_CARRIER_POST_MERGE = 'ADR-040: a PINNED citation moves with its manifest key, so the same post-merge --repair-all pass on main rewrites the doc and the manifest together after the wave merges; fencing these docs is optional and only buys correct line numbers at merge time'

// These two names belong to the compiler. The batch dispatcher parses its
// refusal text but deliberately does not add compiler names to its own list.
export const COUPLED_SOURCE_UNFENCED = 'coupled-source-unfenced'
export const STALE_READ_ACK = 'stale-read-ack'

export const PREDECESSOR_ESCALATED = 'predecessor-escalated'
export const PREDECESSOR_UNSETTLED = 'predecessor-unsettled'
export const DISPATCH_BASE_REF = 'main'

export const REQUEST_SUFFIX = '.request.json'
export const TURN_CENSUS_FLAG = 'turn-census'
export const TOOL_CLASSES = ['edit', 'read', 'test', 'other']

// Keys a lane's request carries for the DISPATCHER, not for the compiler. The
// compiler's request schema is closed (REQUEST_KEYS, make-brief.mjs:51), so a
// dispatch-only key is split off here and never reaches the compiled request.
// The one escape hatch for the refusal below, and it is never silent: a lane that has
// read the named test and decided it must NOT be fenced says so by name, per lane, and
// the dispatcher logs and persists the decision. A dispatch-only key, so the compiler's
// closed schema never sees it.
export const TEST_REACH_OVERRIDE_KEY = 'allow_test_reach'
export const DISPATCH_ONLY_REQUEST_KEYS = Object.freeze(['assurance', 'tier', 'execution', 'variant', 'depends_on', 'seats', 'adopt', TEST_REACH_OVERRIDE_KEY])
// The transports a dispatched batch can boot. Headless is the software-factory
// mode and stays the DEFAULT, so an unflagged batch behaves exactly as it did
// before this flag existed. #617 made the transport STATED; it is choosable
// here because the observability meant to replace panes does not exist yet, so
// until the visualizer can monitor a live lane a pane workspace is the only
// surface a running lane has. Both constants ARE their flag names: one string
// for the flag boot passes, the flag the caller types, and the transport the
// closing line names, so the three cannot drift apart.
export const BOOT_TRANSPORT = 'headless-all'
export const PANE_TRANSPORT = 'panes'
import { ASSURANCE_ALIASES, ASSURANCE_ALIAS_OF } from '../../crew/assurances.mjs'
export const COMPILE_REQUEST_SUFFIX = '.compile-request.json'

export const PLANNER_SYMBOLS_ARM_EVENT = 'experiment-arm'
export const PLANNER_SYMBOLS_EXPERIMENT = 'planner-symbols'
export const PLANNER_SYMBOLS_ARMS = Object.freeze(['control', 'symbols-omitted'])

// #767: five boots were lost to pane-send mechanics on 2026-08-29 (b321 x1, b322 x2,
// b325 x2), each with correct work on both sides of the send and each costing a whole
// dispatch. A lost boot now costs ONE retry: tear the half-booted lane down, re-boot,
// and journal boot-retried carrying the FIRST failure's reason. The bound is two
// attempts in all, so a lane that cannot boot still refuses boot-failed exactly once.
export const BOOT_RETRY_EVENT = 'boot-retried'
export const BOOT_ATTEMPTS = 2
// A teardown between attempts PROVES nothing on its own. crew.mjs teardown prints
// seats: null whenever no seat carried a pane surface to probe (TEARDOWN_ABSENT_CAUSES,
// crew/crew.mjs), which is every headless lane and the usual shape after a failed boot,
// so an exit status alone cannot separate "every seat proven dead" from "nothing was
// measured". The dispatcher reads the PAYLOAD and calls that absence unproven. #601.
export const TEARDOWN_PROVEN = 'proven'
export const TEARDOWN_UNPROVEN = 'unproven'
export const TEARDOWN_SEATS_NULL_WHY = 'teardown returned seats: null - no pane surface to probe, so no seat was proven dead; unproven, never a proven-clean teardown (#601)'

// Plan adoption (#763). A re-dispatched lane whose predecessor already wrote a plan
// reads it out of its own task dir instead of planning again, and the block that says
// so is the SAME sentence every time — never a per-lane paragraph typed by hand.
export const ADOPT_REQUIRED = Object.freeze(['plan.md', 'gate.mjs'])
export const ADOPT_OPTIONAL = Object.freeze(['plan-check.md'])
export const ADOPT_REVISE_MARKER = 'VERDICT: revise'
export const ADOPT_EVENT = 'plan-adopted'
export const LINEAGE_BASELINE_REASONS = Object.freeze(['lineage-journal-absent', 'lineage-journal-unreadable', 'lineage-round1-absent'])
export const LINEAGE_SOURCES = Object.freeze(['carried', 'predecessor-round1'])
export const ADOPT_BLOCK = [
  '',
  '## Adopted plan',
  '',
  'Your task dir ALREADY holds plan.md and gate.mjs, copied from a previous attempt at',
  'this same task. Read both before you plan anything. If they hold, ADOPT them: leave',
  'the files as they are, say so in your summary, and return the envelope that points at',
  'them. If they do not hold, AMEND the smallest part that is wrong and say what you',
  'changed and why. Do not re-plan from nothing — re-deriving a plan that already holds',
  'is the cost this block exists to remove.',
  '',
  'Your files_in_scope may never exceed the dispatched write surface this lane was given,',
  'named under files_in_scope in the Conventions section of this brief. The adopted plan was',
  'scoped to a PREVIOUS attempt and this fence may be NARROWER: narrow the adopted scope to',
  'that surface and say so. The scope guard measures the fence you were dispatched with,',
  'never the one the archive remembers.',
  '',
].join('\n')
export const ADOPT_FINDINGS_CLAUSE = [
  'The previous attempt was BOUNCED: your task dir also holds plan-check.md carrying',
  `${ADOPT_REVISE_MARKER}. Close every finding it names FIRST, and say per finding whether`,
  'you closed it or why it does not apply.',
  'Mark each one you closed with a line of its own reading `CLOSED: <the finding id>`.',
  '',
].join('\n')

// The four per-role boot flags crew.mjs already accepts (ROLE_FLAG_PREFIXES,
// crew/crew.mjs:2488) and the request-key spelling of each. Mirrored rather
// than imported: importing crew/crew.mjs would pull the whole boot graph into
// a dispatcher that only needs four names. test/factory-dispatch-batch.test.mjs
// pins the two surfaces together, exactly as MISCLASSIFIED_PREFIX is pinned.
export const SEAT_FIELDS = Object.freeze({
  agent: 'agent-', model: 'model-', effort: 'effort-', allow_shortfall: 'allow-shortfall-',
})
// crew.mjs boot reads all three (KNOWN_FLAGS.boot, crew/crew.mjs:2448) and each carries a value
// (FLAG_VALUE_CONTRACT, crew/crew.mjs:2471). The dispatcher forwards what it was given, verbatim,
// and never invents a default.
export const BOOT_MEMORY_FLAGS = Object.freeze(['memory-dir', 'memory-backend', 'memory-budget-bytes'])

function memoryFlagArgs(runFlags = {}) {
  const args = []
  for (const flag of BOOT_MEMORY_FLAGS) {
    const value = runFlags[flag]
    if (value === undefined || value === null || value === '') continue
    args.push(`--${flag}`, String(value))
  }
  return args
}

export function turnCeilingFlagArgs(runFlags = {}) {
  const args = []
  for (const flag of TURN_CEILING_FLAGS) {
    const value = runFlags[flag]
    if (value === undefined || value === null || value === '') continue
    args.push(`--${flag}`, String(value))
  }
  return args
}
// The ratified staffing artifact. A lane may not staff a role its settled tier
// does not seat, and crew/roster.json is where that is ratified.
export const ROSTER_PATH = fileURLToPath(new URL('../../crew/roster.json', import.meta.url))
// Boot's own closed band-floor reason enum (crew/crew.mjs:770). A boot refusal
// carrying one of these is a ratified FLOOR refusal, not a generic boot failure,
// and the dispatcher names it rather than swallowing it as boot-failed.
export const BAND_FLOOR_REASONS = Object.freeze([
  'ladder-unreadable', 'floor-unratified', 'band-unknown', 'band-below-floor',
  'model-not-in-catalog',
])

// #291 step 3: the compiler computes SHAPE (risk) and STRENGTH (complexity) on two
// axes and the dispatcher recorded only the collapsed tier word, so no operator and
// no later ledger query could join a matrix cell to its cost or its outcome. The
// pair is READ out of the compiler's own ```proposal block — never re-derived here,
// because a second derivation is a second answer to a question already answered.
export const DISPATCH_RECORD_SUFFIX = '.dispatch.json'
const SPELLING_UNMEASURED_REASON = 'dispatch_record_predates_operator_spelling'
const OPERATOR_SPELLINGS = Object.freeze({
  execution: Object.freeze(['--execution', '--variant', 'dispatcher_default']),
  assurance: Object.freeze(['--assurance', '--tier', 'dispatcher_default']),
})
const OPERATOR_SPELLING_AXES = Object.freeze(['execution', 'assurance'])
// Absence is not zero: a brief carrying no proposal block records null, never a
// stand-in shape. The word the log prints for that null.
export const STAFFING_ABSENT = 'absent'
// A copy of make-brief.mjs:1178, which is not exported and whose file this lane may
// not touch. test/factory-dispatch-batch.test.mjs pins the two surfaces together.
export const MISCLASSIFIED_PREFIX = 'misclassified · shape mechanical has no reinforced column'
const ABSENT_STAFFING = Object.freeze({ shape: null, strength: null, misclassification: null })

// A dry run reports success in the same tone a fully validated dispatch would, and an
// operator read that as validation, split a batch and dispatched it twice (#658). Nothing has
// booted here, so every check reading booted state is STRUCTURALLY unreachable; the closing
// line names them rather than leaving an absence to read as a pass.
export const DRY_RUN_BLIND_SPOT = 'dispatch-batch: dry-run BLIND SPOT — nothing booted, so every check that reads booted state is unreachable from here: fence arrival and the sibling count in a lane crew.json, boot and workspace failures, compiler refusals, and every journal or run outcome. A green dry run is not a validated dispatch.'

export const TEST_REACH_DEPTH = 2
export const TEST_REACH_ROW_LIMIT = 12
export const FENCE_REPORT_FILE = 'dispatch.warnings.json'
export const SYMBOL_FANOUT_LIMIT = 8
export const TEST_REACH_WARNING_PREFIX = 'dispatch-batch: WARNING test-reach-unfenced:'
export const TEST_REACH_BLIND_SPOT = 'BLIND SPOT: this is a proxy in BOTH directions and names candidates, never proof. A test can assert the changed behaviour through a higher-level entry point without importing the changed file at all, and a computed path or dynamic import is invisible to a static scan — crew/crew.mjs loads every adapter that way. A test can equally import a fenced file without asserting anything about the part being changed. The literal symbol scan sees only whole-word occurrences of an exported name, is blind to a renamed re-export, and drops any symbol naming more than 8 test files as too broad to be evidence. Read the named files before choosing this fence; an unnamed one is not cleared. An apostrophe or quote inside a // or /* */ comment opens a phantom literal and hides every real path literal after it in that file.'
export const CENSUS_CARRIER_FILES = Object.freeze(['skills/crew-dispatch/references/batch.md', 'skills/crew-dispatch/exhibits.test.mjs'])
export const CENSUS_CARRIER_WARNING_PREFIX = 'dispatch-batch: WARNING census-carrier-unfenced:'
export const CENSUS_CARRIER_REPAIR = "The lane will OWE this repair and cannot reach it from outside its fence: update batch.md's measurement sentence, exhibits.test.mjs's const measurement, and its const pristinePairs."
export const CENSUS_CARRIER_BLIND_SPOT = 'BLIND SPOT: this warning fires on the POSSIBILITY that a fenced *.test.mjs edit moves either repository-wide census, not on the fact; dispatch cannot inspect bytes the builder has not written and cannot predict whether either census will move.'
export const WARNING_DOCTRINE = 'skills/crew-dispatch/references/batch.md'
export const FENCE_BLIND_SPOTS = Object.freeze({
  'anchor-pin': ANCHOR_BLIND_SPOT,
  'citation-carrier': CITATION_CARRIER_BLIND_SPOT,
  'test-reach': TEST_REACH_BLIND_SPOT,
  'census-carrier': CENSUS_CARRIER_BLIND_SPOT,
  'cross-batch-unknown': CROSS_BATCH_BLIND_SPOT,
})
export const TEST_REACH_OVERRIDE_PREFIX = 'dispatch-batch: test-reach-override:'
export const TEST_REACH_REFUSAL_REMEDY = 'the remedy is mechanical — fence the named test; the corrected files_in_scope is'
export const TEST_REACH_REFUSAL_BLIND_SPOT = 'BLIND SPOT: this refusal is NOT a guarantee and catches ONE class of fence error. It inherits every blind spot of the symbol scan it reads: blind to a renamed re-export, blind to a computed dynamic import, blind to a bare side-effect import that names nothing, and it drops any symbol naming more than 8 test files as too broad. It also cannot see a write target a lane only discovers while planning — of the three fence errors measured on 2026-09-06 it would have caught exactly one (b451-fffgrant); b465-optionalgrant and b472-fleetcontra needed files no pre-plan analysis can name. An unnamed test is not cleared.'
const CODE_SUFFIX = /\.(?:mjs|js)$/
const IMPORT_SPECIFIER = /(?:^|[\n;])\s*(?:import|export)[^\n;]*?from\s*['\"]([^'\"]+)['\"]|\bimport\(\s*['\"]([^'\"]+)['\"]\s*\)/g
const JOIN_LITERAL_CALL = /(?<![\w.$])join\s*\(\s*(?:ROOT|repoRoot)\s*,([\s\S]*?)\)/g

function emptyTestReach() {
  return {
    byFile: new Map(),
    pathByFile: new Map(),
    tests: new Map(),
    files: [],
    depth: TEST_REACH_DEPTH,
    symbolsFor: () => [],
  }
}

function sourceText(value) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  return String(value)
}

function repoPathFor(root, file) {
  return join(root, ...normaliseRepoPath(file).split('/'))
}

function importedPath(file, specifier, codeFiles) {
  if (typeof specifier !== 'string' || !specifier.startsWith('.')) return null
  const target = normaliseRepoPath(join(dirname(file), specifier))
  const candidates = [target, `${target}.mjs`, `${target}.js`, `${target}/index.mjs`, `${target}/index.js`]
  return candidates.find((candidate) => codeFiles.has(candidate)) || null
}

function importsFrom(source, file, codeFiles) {
  const imported = []
  if (typeof source !== 'string' || source.length === 0) return imported
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const target = importedPath(file, match[1] || match[2], codeFiles)
    if (target && !imported.includes(target)) imported.push(target)
  }
  return imported
}

function decodeStaticLiteral(quote, body) {
  let decoded = ''
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char !== '\\') {
      decoded += char
      continue
    }
    const next = body[index + 1]
    if (next === undefined) return null
    index += 1
    if (next === 'x') {
      const hex = body.slice(index + 1, index + 3)
      if (/^[0-9a-f]{2}$/i.test(hex)) {
        decoded += String.fromCharCode(Number.parseInt(hex, 16))
        index += 2
      } else decoded += next
      continue
    }
    if (next === 'u') {
      const braced = body[index + 1] === '{'
      const end = braced ? body.indexOf('}', index + 2) : index + 5
      const hex = braced ? body.slice(index + 2, end) : body.slice(index + 1, end + 1)
      const valid = braced ? end !== -1 && /^[0-9a-f]+$/i.test(hex) : /^[0-9a-f]{4}$/i.test(hex)
      const codePoint = valid ? Number.parseInt(hex, 16) : null
      if (codePoint !== null && codePoint <= 0x10ffff) {
        decoded += String.fromCodePoint(codePoint)
        index = braced ? end : end
      } else decoded += next
      continue
    }
    if (next === 'n') decoded += '\n'
    else if (next === 'r') decoded += '\r'
    else if (next === 't') decoded += '\t'
    else if (next === 'b') decoded += '\b'
    else if (next === 'f') decoded += '\f'
    else if (next === 'v') decoded += '\v'
    else if (next === '0') decoded += '\0'
    else if (next === '\n') { /* a continued literal contributes no character */ }
    else decoded += next
  }
  return decoded
}

function quotedLiteralAt(source, start) {
  const quote = source[start]
  if (quote !== "'" && quote !== '\"') return null
  let body = ''
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') {
      if (index + 1 >= source.length) return null
      body += char + source[index + 1]
      index += 1
      continue
    }
    if (char === quote) return { end: index + 1, value: decodeStaticLiteral(quote, body) }
    body += char
  }
  return null
}

function staticRepoPathLiteral(value, file) {
  if (typeof value !== 'string' || !/[\\/]/.test(value)) return null
  const normal = value.replaceAll('\\', '/')
  if (isAbsolute(normal) || /^[A-Za-z]:[\\/]/.test(normal)) return normal
  if (normal.startsWith('./') || normal.startsWith('../')) return normaliseRepoPath(join(dirname(file), normal))
  return normaliseRepoPath(normal)
}

function pathLiteralsFrom(source, file) {
  const paths = []
  if (typeof source !== 'string' || source.length === 0) return paths
  for (let index = 0; index < source.length; index += 1) {
    const literal = quotedLiteralAt(source, index)
    if (!literal) continue
    const candidate = staticRepoPathLiteral(literal.value, file)
    if (candidate && !paths.includes(candidate)) paths.push(candidate)
    index = literal.end - 1
  }
  return paths
}

function joinedLiteralSegments(value) {
  const segments = []
  let cursor = 0
  while (cursor < value.length) {
    while (/\s/.test(value[cursor] || '')) cursor += 1
    const literal = quotedLiteralAt(value, cursor)
    if (!literal || literal.value === null) return null
    segments.push(literal.value)
    cursor = literal.end
    while (/\s/.test(value[cursor] || '')) cursor += 1
    if (cursor >= value.length) break
    if (value[cursor] !== ',') return null
    cursor += 1
  }
  return segments.length > 0 ? segments : null
}

function joinedRepoPathLiterals(source) {
  const paths = []
  if (typeof source !== 'string' || source.length === 0) return paths
  for (const match of source.matchAll(JOIN_LITERAL_CALL)) {
    const segments = joinedLiteralSegments(match[1])
    if (!segments) continue
    const candidate = normaliseRepoPath(join(...segments.map((segment) => segment.replaceAll('\\', '/'))))
    if (candidate && !paths.includes(candidate)) paths.push(candidate)
  }
  return paths
}

export function collectTestReach({ checkout, deps } = {}) {
  const d = normalDeps(deps)
  const root = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  let result
  try {
    result = d.spawn({
      file: 'git',
      args: ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      cwd: root,
    })
  } catch {
    return emptyTestReach()
  }
  if (!result || (result.status !== 0 && result.status !== null)) return emptyTestReach()
  const files = [...new Set(sourceText(result.stdout)
    .split('\0')
    .map(normaliseRepoPath)
    .filter(Boolean))].sort()
  const trackedFiles = new Set(files)
  const codeFiles = new Set(files.filter((file) => CODE_SUFFIX.test(file)))
  const sourceByFile = new Map()
  const readSource = (file) => {
    const normal = normaliseRepoPath(file)
    if (sourceByFile.has(normal)) return sourceByFile.get(normal)
    let source = ''
    try { source = sourceText(d.readFileSync(repoPathFor(root, normal), 'utf8')) } catch { /* unreadable files cannot contribute edges or symbols */ }
    sourceByFile.set(normal, source)
    return source
  }
  const tests = new Map()
  for (const file of files) {
    if (codeFiles.has(file) && isTripwireFile(file)) tests.set(file, readSource(file))
  }
  const byFile = new Map()
  const pathByFile = new Map()
  const importsByFile = new Map()
  const importsFor = (file) => {
    const normal = normaliseRepoPath(file)
    if (!importsByFile.has(normal)) importsByFile.set(normal, importsFrom(readSource(normal), normal, codeFiles))
    return importsByFile.get(normal)
  }
  for (const [test, source] of tests) {
    for (const candidate of pathLiteralsFrom(source, test)) {
      const owner = trackedFiles.has(candidate) ? candidate : null
      if (!owner) continue
      if (!pathByFile.has(owner)) pathByFile.set(owner, new Set())
      pathByFile.get(owner).add(test)
    }
    for (const candidate of joinedRepoPathLiterals(source)) {
      const owner = trackedFiles.has(candidate) ? candidate : null
      if (!owner) continue
      if (!pathByFile.has(owner)) pathByFile.set(owner, new Set())
      pathByFile.get(owner).add(test)
    }
    const seen = new Map([[test, 0]])
    const pending = [{ file: test, hops: 0, source }]
    while (pending.length > 0) {
      const current = pending.shift()
      // ONE bound, not two. A second guard at the depth limit
      // made the bound below unreachable-when-false, so widening the bound changed
      // nothing and the R3 mutation PR #708 declared SURVIVED its own check. The walk
      // still terminates: nothing is pushed above the bound. #699.
      for (const file of importsFor(current.file)) {
        const hops = current.hops + 1
        if (hops <= TEST_REACH_DEPTH) {
          const prior = seen.get(file)
          if (prior !== undefined && prior <= hops) continue
          seen.set(file, hops)
          pending.push({ file, hops })
          if (!byFile.has(file)) byFile.set(file, new Map())
          const perTest = byFile.get(file)
          if (!perTest.has(test) || hops < perTest.get(test)) perTest.set(test, hops)
        }
      }
    }
  }
  const symbolCache = new Map()
  const symbolsFor = (file) => {
    const normal = normaliseRepoPath(file)
    if (!codeFiles.has(normal)) return []
    if (!symbolCache.has(normal)) symbolCache.set(normal, extractSymbols(readSource(normal), normal))
    return symbolCache.get(normal)
  }
  return { byFile, pathByFile, tests, files, depth: TEST_REACH_DEPTH, symbolsFor }
}

function wholeWord(source, symbol) {
  if (typeof source !== 'string' || typeof symbol !== 'string' || symbol.length === 0) return false
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b`).test(source)
}

function reachRowKey(row) {
  return [row.test, row.file, row.how].join('\0')
}

export function testsOutsideFence({ surface, fenceFiles, reach, droppedRows = [] } = {}) {
  const ownSurface = (Array.isArray(surface) ? surface : []).filter((file) => typeof file === 'string').map(normaliseRepoPath)
  const ownFence = (Array.isArray(fenceFiles) ? fenceFiles : []).filter((file) => typeof file === 'string').map(normaliseRepoPath)
  const matchesSurface = scopeMatcher(ownSurface)
  const inFence = scopeMatcher(ownFence)
  const byKey = new Map()
  const retainReachRow = (row, key = reachRowKey(row)) => {
    const candidate = {
      test: row.test,
      file: row.file,
      hops: row.hops,
      how: row.how,
      symbols: Array.isArray(row.symbols) ? [...row.symbols].sort() : [],
    }
    const current = byKey.get(key)
    if (!current) {
      byKey.set(key, candidate)
      return
    }
    const currentRank = current.hops === null ? TEST_REACH_DEPTH + 1 : current.hops
    const candidateRank = candidate.hops === null ? TEST_REACH_DEPTH + 1 : candidate.hops
    const candidateWins = candidateRank < currentRank
    const retained = candidateWins ? candidate : current
    const losing = candidateWins ? current : candidate
    byKey.set(key, {
      ...retained,
      symbols: [...new Set([...current.symbols, ...candidate.symbols])].sort(),
    })
    if (Array.isArray(droppedRows)) droppedRows.push({
      test: losing.test,
      file: losing.file,
      hops: losing.hops,
      how: losing.how,
      symbols: [...losing.symbols],
    })
  }
  const byFile = reach?.byFile instanceof Map ? reach.byFile : new Map()
  for (const [fileValue, perTest] of byFile) {
    const file = normaliseRepoPath(fileValue)
    if (!matchesSurface(file) || !(perTest instanceof Map)) continue
    for (const [testValue, hopsValue] of perTest) {
      const test = normaliseRepoPath(testValue)
      if (inFence(test)) continue
      const hops = Number.isFinite(hopsValue) ? hopsValue : null
      retainReachRow({ test, file, hops, how: 'import', symbols: [] })
    }
  }
  const tests = reach?.tests instanceof Map ? reach.tests : new Map()
  const files = (Array.isArray(reach?.files) ? reach.files : [])
    .filter((file) => typeof file === 'string' && CODE_SUFFIX.test(file) && matchesSurface(file))
  for (const owner of files) {
    let symbols
    try { symbols = reach?.symbolsFor?.(owner) } catch { symbols = [] }
    if (!Array.isArray(symbols)) continue
    for (const symbol of symbols) {
      const hits = []
      for (const [testValue, source] of tests) {
        const test = normaliseRepoPath(testValue)
        if (inFence(test) || test === owner) continue
        if (wholeWord(source, symbol)) hits.push(test)
      }
      if (hits.length === 0 || hits.length > SYMBOL_FANOUT_LIMIT) continue
      for (const test of hits) {
        const symbolRow = { test, file: owner, hops: null, how: 'symbol', symbols: [symbol] }
        const importKey = reachRowKey({ test, file: owner, how: 'import' })
        retainReachRow(symbolRow, byKey.has(importKey) ? importKey : reachRowKey(symbolRow))
      }
    }
  }
  const pathByFile = reach?.pathByFile instanceof Map ? reach.pathByFile : new Map()
  for (const [ownerValue, reachedTests] of pathByFile) {
    const owner = normaliseRepoPath(ownerValue)
    if (!matchesSurface(owner) || !(reachedTests instanceof Set)) continue
    for (const testValue of reachedTests) {
      const test = normaliseRepoPath(testValue)
      if (inFence(test)) continue
      const pathRow = { test, file: owner, hops: null, how: 'path', symbols: [] }
      retainReachRow(pathRow)
    }
  }
  return [...byKey.values()].sort((a, b) => {
    // Least obvious first: a symbol-only row (hops null) is the coupling an operator will
    // not guess, and nearest-first put it last — b394 lost 29 minutes of a build round to
    // exactly that row being cut from the listing (#869).
    const left = a.hops === null ? TEST_REACH_DEPTH + 1 : a.hops
    const right = b.hops === null ? TEST_REACH_DEPTH + 1 : b.hops
    return right - left
      || (a.test < b.test ? -1 : a.test > b.test ? 1 : 0)
      || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
      || (a.how < b.how ? -1 : a.how > b.how ? 1 : 0)
  })
}

// The exported names of the surface this lane declares it will WRITE. The surface is
// EXPANDED through reach.files with its own scopeMatcher, exactly as testsOutsideFence
// does at :405-406: a write surface may be a trailing-slash directory prefix
// (crew/drive.mjs validateScopeEntries), and matching CODE_SUFFIX against the declared
// entry would drop every directory surface and silently disarm the refusal below.
export function surfaceExportsOf({ surface, reach } = {}) {
  const declared = (Array.isArray(surface) ? surface : []).filter((file) => typeof file === 'string').map(normaliseRepoPath)
  const matchesSurface = scopeMatcher(declared)
  const names = new Set()
  const owners = (Array.isArray(reach?.files) ? reach.files : []).filter((file) => typeof file === 'string' && CODE_SUFFIX.test(file) && matchesSurface(file))
  for (const owner of owners) {
    let symbols
    try { symbols = reach?.symbolsFor?.(owner) } catch { symbols = [] }
    for (const symbol of Array.isArray(symbols) ? symbols : []) names.add(symbol)
  }
  return [...names].sort()
}

// #960 names TWO candidate classes, and NOTHING wider. Every `how === 'path'` row is a
// `test-reach` admission candidate. `pathLiteralsFrom` scans every quoted literal in a
// test, so a test's own relative import specifier for a fenced file emits that path fact
// too; an unheld candidate widens the effective fence, while a held candidate refuses.
// For `how === 'import'` or `how === 'symbol'` rows, the narrow direct-import +
// surface-export-overlap conjunction is the only other candidate route: the test imports
// the fenced file DIRECTLY (one hop, not two of re-export), through a REAL import (not
// the literal symbol scan whose blind spots the warning already documents), and it names
// at least one symbol the lane's own write surface exports. Every other import/symbol row
// stays a warning.
export function reachRefusalRows({ rows, surfaceExports } = {}) {
  const exported = new Set((Array.isArray(surfaceExports) ? surfaceExports : []).filter((symbol) => typeof symbol === 'string'))
  const refused = []
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (row?.how === 'path') {
      refused.push({ test: row.test, file: row.file, symbols: [] })
      continue
    }
    const directImport = row?.hops === 1 && row?.how === 'import'
    if (!directImport) continue
    const overlap = (Array.isArray(row.symbols) ? row.symbols : []).filter((symbol) => exported.has(symbol))
    if (overlap.length === 0) continue
    refused.push({ test: row.test, file: row.file, symbols: overlap })
  }
  return refused
}

function reachRowText(row) {
  const hops = row.how === 'path' ? 'path-only' : row.hops === null ? 'symbol-only' : `hops=${row.hops}`
  const symbols = row.symbols.length > 0 ? ` symbols=${row.symbols.join(',')}` : ''
  return `${row.test} -> ${row.file} (${hops}, how=${row.how}${symbols})`
}

function reportTail(omitted, citation) {
  if (omitted <= 0) return ''
  return `; ${omitted} further row(s) not listed here and carried in full on the report ${citation}`
}

function writeFenceReport({ path, lanes, crossBatchUnknown = [], deps } = {}) {
  const d = normalDeps(deps)
  try {
    d.mkdirSync(dirname(path), { recursive: true })
    d.writeFileSync(path, JSON.stringify({
      schema_version: 1,
      blind_spots: FENCE_BLIND_SPOTS,
      cross_batch_unknown: crossBatchUnknown,
      lanes,
    }, null, 2) + '\n')
    return null
  } catch (error) {
    return error
  }
}

function warningSummary({ lane, counts, refusals, citation, warnings }) {
  const warningEvidence = `report=${citation} doctrine=${WARNING_DOCTRINE}`
  const refusalNames = Array.isArray(refusals) && refusals.length > 0 ? refusals.join(',') : 'none'
  return `dispatch-batch: WARNING-SUMMARY lane=${lane} refusals=${refusalNames} anchor-pin=${counts.anchorPin} · citation-carrier=${counts.citationCarrier} · test-reach=${counts.testReach} · actionable=${counts.actionable} · collapsed=${counts.testReachDropped} · cross-batch-unknown=${counts.crossBatchUnknown} · census-carrier=${counts.censusCarrier} ${warningEvidence}`
}

export class BatchRefusal extends Error {
  constructor(message, reason) {
    super(`dispatch-batch: ${message}`)
    this.name = 'BatchRefusal'
    this.reason = reason
  }
}

function refuse(message, reason) { throw new BatchRefusal(message, reason) }

function spawnAsyncDefault({ file, args, cwd, env }) {
  return new Promise((resolve) => {
    const child = childSpawn(file, args, { cwd, env })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => resolve({ status: null, error, stdout, stderr }))
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

function spawnBackground({ file, args, cwd, env, logPath }) {
  let fd
  try {
    fd = openSync(logPath, 'a')
    const child = childSpawn(file, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', fd, fd],
    })
    if (!child) return { status: null, error: new Error('background spawn returned no child') }
    child.on('error', (err) => {
      try { writeFileSync(logPath, `[spawn error: ${err?.message || String(err)}]\n`, { flag: 'a' }) } catch { /* the child failure is already represented by its log path */ }
    })
    child.unref()
    return child
  } catch (err) {
    return { status: null, error: err }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* the child owns its inherited descriptors */ }
    }
  }
}

export function normalDeps(deps = {}) {
  return {
    existsSync: deps.existsSync || fsExistsSync,
    readFileSync: deps.readFileSync || fsReadFileSync,
    writeFileSync: deps.writeFileSync || writeFileSync,
    appendFileSync: deps.appendFileSync || appendFileSync,
    readdirSync: deps.readdirSync || fsReaddirSync,
    mkdirSync: deps.mkdirSync || mkdirSync,
    home: deps.home || homedir(),
    spawn: deps.spawn || ((options) => options?.background
      ? spawnBackground(options)
      : spawnSync(options.file, options.args, { cwd: options.cwd, env: options.env, encoding: 'utf8' })),
    env: deps.env || process.env,
    spawnAsync: deps.spawnAsync || deps.spawn || spawnAsyncDefault,
    assertQuiet: deps.assertQuiet || ((env) => assertHostQuiet(hostLoad({ policy: loadPolicy(env) }))),
    log: deps.log || ((line) => process.stdout.write(`${line}\n`)),
    // Suite-slot seams (#825): pass-through only. withSuiteSlot owns their
    // defaults, so an absent seam must stay `undefined` rather than become null.
    now: deps.now,
    random: deps.random || Math.random,
    sleep: deps.sleep,
    slots: deps.slots,
  }
}

export function parsePlannerSymbolsHoldoutFraction(value) {
  if (value === undefined || value === null) return null
  const text = typeof value === 'number' ? String(value) : value
  if (typeof text !== 'string' || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(text)) {
    refuse(`invalid --planner-symbols-holdout-fraction ${JSON.stringify(value)}; expected a canonical finite number in [0,1]`, BATCH_UNREADABLE)
  }
  const fraction = Number(text)
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    refuse(`invalid --planner-symbols-holdout-fraction ${JSON.stringify(value)}; expected a canonical finite number in [0,1]`, BATCH_UNREADABLE)
  }
  return fraction
}

export function selectPlannerSymbolsArm(fraction, random = Math.random) {
  if (fraction === null) return null
  const draw = random()
  return draw < fraction ? 'control' : 'symbols-omitted'
}

function normaliseRepoPath(value) {
  const normal = String(value).replaceAll('\\', '/')
  if (normal === './') return '.'
  return normal.startsWith('./') ? normal.slice(2) : normal
}

export function fenceAdmission({ lane, file, source, holder } = {}) {
  if (!FENCE_ADMISSION_SOURCES.includes(source)) {
    refuse(`fence admission for lane ${lane ?? '(unknown)'} and file ${file ?? '(unknown)'} has no allowed source: ${JSON.stringify(source)}`, FENCE_ADMISSION_UNSOURCED)
  }
  const row = { lane: laneNameOf(lane), file: normaliseRepoPath(file), source }
  if (holder) row.holder = holder
  return row
}

// A lane whose name cannot be resolved used to become '' and then vanish from every
// map keyed by name — the graph simply lost it. Refuse by name instead (#634).
function laneNameOf(lane) {
  const resolved = typeof lane === 'string' ? lane
    : typeof lane?.lane === 'string' ? lane.lane
      : typeof lane?.name === 'string' ? lane.name
        : null
  if (resolved === null || resolved.trim() === '') refuse(`cannot resolve a lane name from ${JSON.stringify(lane)}; a lane is a non-empty string, or an object carrying a non-empty lane or name string`, LANE_SHAPE_INVALID)
  return resolved
}

function laneWhereOf(lane) {
  if (lane && Array.isArray(lane.where)) return lane.where.map(normaliseRepoPath)
  if (lane && Array.isArray(lane.request?.where)) return lane.request.where.map(normaliseRepoPath)
  return []
}

function laneCreatesOf(lane) {
  if (lane && Array.isArray(lane.creates)) return lane.creates.map(normaliseRepoPath)
  if (lane && Array.isArray(lane.request?.creates)) return lane.request.creates.map(normaliseRepoPath)
  return []
}

export function isTestReachOverride(value) {
  return Boolean(value && typeof value.file === 'string' && value.file.trim() && typeof value.why === 'string' && value.why.trim())
}

function normaliseTestReachOverride(value) {
  return { file: normaliseRepoPath(value.file.trim()), why: value.why.trim() }
}

function laneAllowTestReachOf(lane) {
  const declared = Array.isArray(lane?.[TEST_REACH_OVERRIDE_KEY])
    ? lane[TEST_REACH_OVERRIDE_KEY]
    : Array.isArray(lane?.request?.[TEST_REACH_OVERRIDE_KEY]) ? lane.request[TEST_REACH_OVERRIDE_KEY] : []
  return declared.filter(isTestReachOverride).map(normaliseTestReachOverride)
}

function fenceEntriesOf(fences) {
  if (Array.isArray(fences)) return fences
  if (fences && Array.isArray(fences.lanes)) return fences.lanes
  return []
}

function normaliseFence(entry) {
  return {
    ...entry,
    lane: typeof entry?.lane === 'string' ? entry.lane : String(entry?.lane ?? ''),
    files: Array.isArray(entry?.files)
      ? entry.files.map((file) => typeof file === 'string' ? normaliseRepoPath(file) : file)
      : entry?.files,
    reads: Array.isArray(entry?.reads)
      ? entry.reads.map((read) => ({ ...read, file: typeof read?.file === 'string' ? normaliseRepoPath(read.file) : read?.file }))
      : entry?.reads,
  }
}

function fenceEntryIntersects(entry, candidates) {
  const parsed = parseFenceScope(entry)
  if (parsed.kind === 'invalid') return false
  const possible = Array.isArray(candidates) ? candidates : []
  return possible.some((candidate) => {
    const other = parseFenceScope(candidate)
    if (other.kind === 'invalid') return false
    if (other.path.endsWith('/') && scopeMatcher([other.path])(parsed.path)) return true
    if (parsed.kind === 'span' || other.kind === 'span') return fenceScopesIntersect(parsed, other)
    return scopeMatcher(possible)(entry)
  })
}

function fenceGranularity(files) {
  return (Array.isArray(files) ? files : []).map((entry) => (
    parseFenceScope(entry).kind === 'span' ? `span(${entry})` : `whole-file(${entry})`
  )).join(',')
}

function textOf(value) {
  if (value == null) return ''
  return typeof value === 'string' ? value : String(value)
}

function childFailure(result) {
  const stderr = textOf(result?.stderr)
  const stdout = textOf(result?.stdout)
  const error = result?.error ? textOf(result.error.message || result.error) : ''
  const signal = result?.signal ? `signal ${result.signal}` : ''
  return stderr || error || signal || stdout || `exit ${String(result?.status)}`
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function unmeasuredOperatorSpelling() {
  return { spelling: null, unmeasured_reason: SPELLING_UNMEASURED_REASON }
}

export function readDispatchOperatorSpelling(record) {
  const operatorSpelling = plainObject(record) && Object.hasOwn(record, 'operator_spelling') && plainObject(record.operator_spelling)
    ? record.operator_spelling
    : null
  return Object.fromEntries(OPERATOR_SPELLING_AXES.map((axis) => {
    const cell = operatorSpelling && Object.hasOwn(operatorSpelling, axis) ? operatorSpelling[axis] : null
    if (!plainObject(cell) || !Object.hasOwn(cell, 'spelling') || !Object.hasOwn(cell, 'unmeasured_reason')) {
      return [axis, unmeasuredOperatorSpelling()]
    }
    const measured = OPERATOR_SPELLINGS[axis].includes(cell.spelling) && cell.unmeasured_reason === null
    const preField = cell.spelling === null && cell.unmeasured_reason === SPELLING_UNMEASURED_REASON
    return [axis, measured || preField
      ? { spelling: cell.spelling, unmeasured_reason: cell.unmeasured_reason }
      : unmeasuredOperatorSpelling()]
  }))
}

export function aliasUsageFromDispatchRecords(records) {
  const aliases = { execution: '--variant', assurance: '--tier' }
  const dispatchRecords = Array.isArray(records) ? records : []
  const usage = {}
  for (const axis of OPERATOR_SPELLING_AXES) {
    let aliasSpelled = 0
    let unmeasuredDispatches = 0
    for (const record of dispatchRecords) {
      const cell = readDispatchOperatorSpelling(record)[axis]
      if (cell.spelling === null) unmeasuredDispatches += 1
      else if (cell.spelling === aliases[axis]) aliasSpelled += 1
    }
    usage[axis] = {
      alias_spelled: unmeasuredDispatches === 0 ? aliasSpelled : null,
      total_dispatches: dispatchRecords.length,
      unmeasured_dispatches: unmeasuredDispatches,
    }
  }
  return usage
}

function usableTurnCensus(value) {
  if (!plainObject(value) || value.role !== 'builder') return false
  if (!Number.isFinite(value.turns) || value.turns <= 0) return false
  if (!Number.isFinite(value.out_of_tool_ms) || value.out_of_tool_ms < 0) return false
  if (!Number.isFinite(value.span_ms) || value.span_ms < 0) return false
  if (!plainObject(value.in_tool_ms)) return false
  return TOOL_CLASSES.every((name) => Number.isFinite(value.in_tool_ms[name]) && value.in_tool_ms[name] >= 0)
}

export function readTurnCensus(paths, deps) {
  const d = normalDeps(deps)
  const candidates = Array.isArray(paths) ? paths : typeof paths === 'string' ? [paths] : []
  if (candidates.length === 0) return { rows: [], reason: 'no --turn-census measurement supplied' }
  const rows = []
  let unreadable = false
  for (const path of candidates) {
    if (typeof path !== 'string' || path.trim() === '') {
      unreadable = true
      continue
    }
    let text
    try { text = textOf(d.readFileSync(path, 'utf8')) } catch {
      unreadable = true
      continue
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let source
      try { source = JSON.parse(trimmed) } catch { continue }
      const payload = source && typeof source === 'object' && !Array.isArray(source) ? source.seat_turn_census : null
      if (usableTurnCensus(payload)) rows.push(payload)
    }
  }
  if (rows.length > 0) return { rows, reason: null }
  return { rows, reason: unreadable ? 'turn-census-file-unreadable' : 'turn-census-no-usable-builder-census' }
}

export function turnBudgetReport({ waitSeconds, censusRows, reason } = {}) {
  censusRows = Array.isArray(censusRows) ? censusRows.filter(usableTurnCensus) : []
  if (censusRows.length === 0) return { measured: false, affordable_turns: null, reason: reason || 'no --turn-census measurement supplied' }
  const outOfToolMs = censusRows.reduce((total, row) => total + row.out_of_tool_ms, 0)
  const turns = censusRows.reduce((total, row) => total + row.turns, 0)
  const spanMs = censusRows.reduce((total, row) => total + row.span_ms, 0)
  const inToolMs = Object.fromEntries(TOOL_CLASSES.map((name) => [name, censusRows.reduce((total, row) => total + row.in_tool_ms[name], 0)]))
  const inToolTotalMs = TOOL_CLASSES.reduce((total, name) => total + inToolMs[name], 0)
  const latencyMsPerTurn = outOfToolMs / turns
  if (!(turns > 0) || !(outOfToolMs > 0) || !(Number.isFinite(latencyMsPerTurn) && latencyMsPerTurn > 0)) {
    return { measured: false, affordable_turns: null, reason: 'census latency denominator is unmeasurable' }
  }
  const affordableTurns = Math.floor(waitSeconds * 1000 / latencyMsPerTurn)
  const perSampleLatencies = censusRows.map((row) => row.out_of_tool_ms / row.turns)
  return {
    measured: true,
    wait_s: waitSeconds,
    affordable_turns: affordableTurns,
    latency_ms_per_turn: latencyMsPerTurn,
    min_latency_ms_per_turn: Math.min(...perSampleLatencies),
    max_latency_ms_per_turn: Math.max(...perSampleLatencies),
    n: censusRows.length,
    denominator: { out_of_tool_ms: outOfToolMs, turns, span_ms: spanMs },
    in_tool_ms: inToolMs,
    in_tool_total_ms: inToolTotalMs,
  }
}

export function formatTurnBudgetReport(report = {}) {
  if (!report.measured) {
    return `dispatch-batch: turn-budget role=builder affordable_turns=unmeasured latency_ms_per_turn=unmeasured reason=${report.reason || 'no --turn-census measurement supplied'}`
  }
  const denominator = report.denominator || {}
  const inToolMs = report.in_tool_ms || {}
  return `dispatch-batch: turn-budget role=builder wait_s=${report.wait_s} affordable_turns=${report.affordable_turns} latency_ms_per_turn=${report.latency_ms_per_turn} range_ms_per_turn=${report.min_latency_ms_per_turn}..${report.max_latency_ms_per_turn} n=${report.n} denominator=out_of_tool_ms:${denominator.out_of_tool_ms},turns:${denominator.turns},span_ms:${denominator.span_ms} in_tool_ms=edit:${inToolMs.edit},read:${inToolMs.read},test:${inToolMs.test},other:${inToolMs.other},total:${report.in_tool_total_ms}`
}

export function seatsDefect(value) {
  if (!plainObject(value)) return 'expected a plain object of role seat overrides'
  for (const [role, fields] of Object.entries(value)) {
    if (!plainObject(fields)) return `role ${JSON.stringify(role)} must carry a plain object of seat fields`
    for (const [field, setting] of Object.entries(fields)) {
      if (!Object.hasOwn(SEAT_FIELDS, field)) return `role ${JSON.stringify(role)} names an unknown seat field ${JSON.stringify(field)}; expected ${Object.keys(SEAT_FIELDS).join(', ')}`
      if (typeof setting !== 'string' || setting.length === 0) return `role ${JSON.stringify(role)} field ${field} must be a non-empty string`
    }
  }
  return null
}

// A dispatch-only key travels with the lane it describes. The tier value is
// checked here rather than at boot so a typo names its own file.
function splitDispatchKeys(parsed, requestPath) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { dispatch: {}, request: parsed }
  const dispatch = {}
  const request = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (DISPATCH_ONLY_REQUEST_KEYS.includes(key)) dispatch[key] = value
    else request[key] = value
  }
  const executionSupplied = dispatch.execution !== undefined && dispatch.execution !== null
  const variantSupplied = dispatch.variant !== undefined && dispatch.variant !== null
  const tierSupplied = dispatch.tier !== undefined && dispatch.tier !== null
  const assuranceSupplied = dispatch.assurance !== undefined && dispatch.assurance !== null
  const executionSpelling = variantSupplied ? '--variant' : executionSupplied ? '--execution' : 'dispatcher_default'
  const assuranceSpelling = tierSupplied ? '--tier' : assuranceSupplied ? '--assurance' : 'dispatcher_default'
  const resolveForRequest = (resolver, values) => {
    try {
      return resolver(values)
    } catch (err) {
      if (err instanceof BatchRefusal) {
        const detail = err.message.startsWith('dispatch-batch: ') ? err.message.slice('dispatch-batch: '.length) : err.message
        refuse(`request ${requestPath}: ${detail}`, err.reason)
      }
      throw err
    }
  }
  const execution = resolveForRequest(resolveRequestedExecution, { execution: dispatch.execution, variant: dispatch.variant })
  const assurance = resolveForRequest(resolveRequestedTier, { tier: dispatch.tier, assurance: dispatch.assurance })
  if (Object.prototype.hasOwnProperty.call(dispatch, 'depends_on')
      && (!Array.isArray(dispatch.depends_on)
        || !dispatch.depends_on.every((dep) => typeof dep === 'string' && dep.trim() !== ''))) {
    refuse(`request ${requestPath} has an invalid depends_on; expected an array of non-empty strings`, BATCH_UNREADABLE)
  }
  if (Object.prototype.hasOwnProperty.call(dispatch, 'adopt')
      && (typeof dispatch.adopt !== 'string' || dispatch.adopt.trim() === '')) {
    refuse(`request ${requestPath} has an invalid adopt; expected a non-empty string naming an archived crew or task directory`, BATCH_UNREADABLE)
  }
  if (Object.prototype.hasOwnProperty.call(dispatch, TEST_REACH_OVERRIDE_KEY)
      && (!Array.isArray(dispatch[TEST_REACH_OVERRIDE_KEY])
        || !dispatch[TEST_REACH_OVERRIDE_KEY].every(isTestReachOverride))) {
    refuse(`request ${requestPath} has an invalid ${TEST_REACH_OVERRIDE_KEY}; expected an array of records with non-empty file and why strings`, BATCH_UNREADABLE)
  }
  if (Object.prototype.hasOwnProperty.call(dispatch, 'seats')) {
    const defect = seatsDefect(dispatch.seats)
    if (defect) refuse(`request ${requestPath} has an invalid seats: ${defect}`, BATCH_UNREADABLE)
  }
  return {
    dispatch,
    request,
    execution,
    assurance,
    executionSpelling,
    assuranceSpelling,
    executionFromVariant: variantSupplied,
    assuranceFromTier: tierSupplied,
    variantSupplied,
    tierSupplied,
  }
}

export function readBatch({ batchDir, deps } = {}) {
  const d = normalDeps(deps)
  if (typeof batchDir !== 'string' || batchDir.trim() === '') {
    refuse('batch directory is required', BATCH_UNREADABLE)
  }
  const directory = resolve(batchDir)
  let names
  try {
    names = d.readdirSync(directory)
  } catch (err) {
    refuse(`cannot read batch directory ${directory}: ${err?.message || String(err)}`, BATCH_UNREADABLE)
  }
  if (!Array.isArray(names)) refuse(`cannot enumerate batch directory ${directory}`, BATCH_UNREADABLE)
  const requestNames = names
    .map((name) => typeof name === 'string' ? name : name?.name)
    .filter((name) => typeof name === 'string' && name.endsWith(REQUEST_SUFFIX))
    .sort()
  if (requestNames.length === 0) refuse(`batch directory contains no ${REQUEST_SUFFIX} files: ${directory}`, BATCH_EMPTY)

  const lanes = []
  for (const name of requestNames) {
    const lane = name.slice(0, -REQUEST_SUFFIX.length)
    if (!lane) refuse(`request filename has no lane name: ${name}`, BATCH_UNREADABLE)
    const requestPath = join(directory, name)
    let parsed
    try {
      parsed = JSON.parse(d.readFileSync(requestPath, 'utf8'))
    } catch (err) {
      refuse(`cannot read or validate request ${requestPath}: ${err?.message || String(err)}`, BATCH_UNREADABLE)
    }
    const { dispatch, request, execution, assurance, executionSpelling, assuranceSpelling, executionFromVariant, assuranceFromTier, variantSupplied, tierSupplied } = splitDispatchKeys(parsed, requestPath)
    try {
      validateRequest(request, { taskName: lane })
    } catch (err) {
      refuse(`cannot read or validate request ${requestPath}: ${err?.message || String(err)}`, BATCH_UNREADABLE)
    }
    lanes.push({
      lane,
      name,
      request,
      execution: execution ?? null,
      assurance: assurance ?? null,
      executionSpelling,
      assuranceSpelling,
      executionFromVariant,
      assuranceFromTier,
      variantSupplied,
      tierSupplied,
      tier: tierSupplied && typeof dispatch.tier === 'string' ? dispatch.tier : null,
      variant: variantSupplied && typeof dispatch.variant === 'string' ? dispatch.variant : null,
      seats: dispatch.seats && typeof dispatch.seats === 'object' ? dispatch.seats : null,
      adopt: typeof dispatch.adopt === 'string' ? dispatch.adopt : null,
      [TEST_REACH_OVERRIDE_KEY]: Array.isArray(dispatch[TEST_REACH_OVERRIDE_KEY]) ? dispatch[TEST_REACH_OVERRIDE_KEY].map(normaliseTestReachOverride) : [],
      depends_on: Array.isArray(dispatch.depends_on) ? [...new Set(dispatch.depends_on)] : [],
      where: request.where.map(normaliseRepoPath),
      creates: Array.isArray(request.creates) ? request.creates.map(normaliseRepoPath) : [],
    })
  }
  return lanes.sort((a, b) => a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0)
}

export function planWaves({ lanes } = {}) {
  // An empty wave list from a non-empty batch is never a legitimate answer, and the call
  // that produced one was planWaves(lanes): an ARRAY where the options object belongs
  // destructures to undefined and silently plans nothing (#634).
  if (!Array.isArray(lanes)) refuse(`planWaves requires { lanes: [...] } and received ${JSON.stringify(lanes)}; passing the lane array itself plans no waves at all`, LANE_SHAPE_INVALID)
  const batchLanes = lanes
  const laneNames = batchLanes.map(laneNameOf)
  const byName = new Map(batchLanes.map((lane) => [laneNameOf(lane), lane]))
  const deps = new Map()
  let hasEdges = false
  for (const lane of batchLanes) {
    const name = laneNameOf(lane)
    const declared = Array.isArray(lane?.depends_on) ? lane.depends_on : []
    const unique = []
    for (const dep of declared) {
      if (!byName.has(dep)) refuse(`lane ${name} depends_on names a lane that is not in this batch: ${dep}`, DEPENDENCY_UNKNOWN)
      if (!unique.includes(dep)) unique.push(dep)
    }
    deps.set(name, unique)
    if (unique.length > 0) hasEdges = true
  }

  const depsOf = (name) => deps.get(name) || []
  const ancestors = new Map(laneNames.map((name) => [name, new Set()]))
  const pending = [...laneNames]
  const placed = new Set()
  const waves = []
  while (pending.length > 0) {
    const ready = pending.filter((lane) => depsOf(lane).every((dep) => placed.has(dep)))
    if (ready.length === 0) {
      const cycle = [...pending].sort()
      refuse(`dependency cycle among lanes: ${cycle.join(', ')}`, DEPENDENCY_CYCLE)
    }
    waves.push(ready)
    for (const name of ready) {
      const ownAncestors = ancestors.get(name)
      for (const dep of depsOf(name)) {
        ownAncestors.add(dep)
        for (const ancestor of ancestors.get(dep) || []) ownAncestors.add(ancestor)
      }
      placed.add(name)
    }
    const readySet = new Set(ready)
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (readySet.has(pending[index])) pending.splice(index, 1)
    }
  }
  return { waves, graph: { deps, ancestors, hasEdges } }
}

export function relatedLanes(graph, a, b) {
  if (!graph || !(graph.ancestors instanceof Map)) return false
  return Boolean(graph.ancestors.get(a)?.has(b) || graph.ancestors.get(b)?.has(a))
}

// Every anchors.json manifest in ONE pass, keyed by the file each pin targets. A
// lane loop must never re-read a manifest: the scan is O(manifests), not O(lanes x files).
export function collectAnchorPins({ checkout, deps } = {}) {
  const d = normalDeps(deps)
  const root = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  const byFile = new Map()
  const manifests = []
  const manifestPaths = [ROLES_ANCHOR_MANIFEST]
  let names
  try { names = d.readdirSync(join(root, 'skills')) } catch { names = [] }
  if (Array.isArray(names)) {
    for (const raw of names) {
      const name = typeof raw === 'string' ? raw : raw?.name
      if (typeof name !== 'string') continue
      manifestPaths.push(`skills/${name}/anchors.json`)
    }
  }
  for (const manifest of manifestPaths) {
    const path = join(root, manifest)
    let parsed
    try {
      if (!d.existsSync(path)) continue
      parsed = JSON.parse(d.readFileSync(path, 'utf8'))
    } catch { continue }
    manifests.push(manifest)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    for (const key of Object.keys(parsed)) {
      const at = key.lastIndexOf(':')
      if (at < 1 || !/^\d+$/.test(key.slice(at + 1))) continue
      const file = normaliseRepoPath(key.slice(0, at))
      if (!byFile.has(file)) byFile.set(file, new Map())
      const perManifest = byFile.get(file)
      if (!perManifest.has(manifest)) perManifest.set(manifest, [])
      perManifest.get(manifest).push(key)
    }
  }
  return { byFile, manifests }
}

// A manifest's citation docs: the layout skills/qa-test-writing/anchor-pin.mjs's skillDocs
// reads, restated here rather than imported because no production module in scripts/factory
// imports from skills/ and one repair command's path is not worth opening that boundary.
// test/factory-dispatch-batch.test.mjs pins the two layouts together.
function manifestDocs(manifest, root, d) {
  const dir = dirname(manifest)
  const docs = []
  const skill = join(root, dir, 'SKILL.md')
  if (d.existsSync(skill)) docs.push(`${dir}/SKILL.md`)
  const refs = join(root, dir, 'references')
  let names = null
  try { names = d.existsSync(refs) ? d.readdirSync(refs) : null } catch { names = null }
  if (Array.isArray(names)) {
    for (const raw of [...names].sort()) {
      const name = typeof raw === 'string' ? raw : raw?.name
      if (typeof name === 'string' && name.endsWith('.md')) docs.push(`${dir}/references/${name}`)
    }
  }
  if (docs.length > 0) return docs
  let own = null
  try { own = d.readdirSync(join(root, dir)) } catch { own = null }
  if (!Array.isArray(own)) return docs
  for (const raw of [...own].sort()) {
    const name = typeof raw === 'string' ? raw : raw?.name
    if (typeof name === 'string' && name.endsWith('.md')) docs.push(`${dir}/${name}`)
  }
  return docs
}

// `crew/drive.mjs:34` is a prefix of `crew/drive.mjs:345`, so a bare includes() would
// attribute the shorter citation to a doc that only carries the longer one. The lookahead is
// the same guard anchor-pin.mjs's rewriteCitations uses for the same reason.
function carriesCitation(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}(?!\\d)`).test(text)
}

// Keyed by the file each citation TARGETS, so the caller can intersect with a lane's write
// surface exactly as it does with anchorPinsOutsideFence. One read per doc, never one per key.
export function citationCarriers({ checkout, pins, deps } = {}) {
  const d = normalDeps(deps)
  const root = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  const byFile = pins && pins.byFile instanceof Map ? pins.byFile : new Map()
  const keysByManifest = new Map()
  for (const [file, perManifest] of byFile) {
    for (const [manifest, keys] of perManifest) {
      if (!keysByManifest.has(manifest)) keysByManifest.set(manifest, [])
      for (const key of keys) keysByManifest.get(manifest).push({ key, file })
    }
  }
  const carriers = new Map()
  const docsScanned = []
  for (const [manifest, entries] of keysByManifest) {
    for (const doc of manifestDocs(manifest, root, d)) {
      let text
      try { text = d.readFileSync(join(root, doc), 'utf8') } catch { continue }
      if (typeof text !== 'string') continue
      docsScanned.push(doc)
      const perDoc = new Map()
      for (const { key, file } of entries) {
        if (!carriesCitation(text, key)) continue
        if (!perDoc.has(file)) perDoc.set(file, [])
        perDoc.get(file).push(key)
      }
      for (const [file, keys] of perDoc) {
        if (!carriers.has(file)) carriers.set(file, [])
        carriers.get(file).push({ doc, keys: [...keys].sort() })
      }
    }
  }
  return { byFile: carriers, docsScanned }
}

// A doc that cites a line this lane moves, and that the lane may not edit. Unlike a shifted
// manifest pin this is NOT repairable in-lane: --repair rewrites the citation inside the doc,
// so a doc outside the fence leaves the corpus red with no move available to any seat.
export function citationCarriersOutsideFence({ surface, fenceFiles, carriers } = {}) {
  const inFence = scopeMatcher(Array.isArray(fenceFiles) ? fenceFiles : [])
  const matchesSurface = scopeMatcher(Array.isArray(surface) ? surface : [])
  const byFile = carriers && carriers.byFile instanceof Map ? carriers.byFile : new Map()
  const found = []
  for (const [file, docs] of byFile) {
    if (!matchesSurface(file)) continue
    for (const { doc, keys } of docs) {
      if (inFence(doc)) continue
      found.push({ file, doc, keys })
    }
  }
  return found.sort((a, b) => (a.doc < b.doc ? -1 : a.doc > b.doc ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

export function anchorPinsOutsideFence({ surface, fenceFiles, pins } = {}) {
  const inFence = scopeMatcher(Array.isArray(fenceFiles) ? fenceFiles : [])
  const matchesSurface = scopeMatcher(Array.isArray(surface) ? surface : [])
  const byFile = pins && pins.byFile instanceof Map ? pins.byFile : new Map()
  const found = []
  for (const [file, perManifest] of byFile) {
    if (!matchesSurface(file)) continue
    for (const [manifest, keys] of perManifest) {
      if (inFence(manifest)) continue
      found.push({ file, manifest, keys: [...keys].sort() })
    }
  }
  return found
}

function repoCommonDir(checkout, d) {
  if (typeof checkout !== 'string' || checkout.trim() === '') return null
  const target = resolve(checkout)
  let result
  try {
    result = d.spawn({
      file: 'git',
      args: ['-C', target, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      cwd: target,
    })
  } catch {
    return null
  }
  if (!result || result.error || result.signal || result.status !== 0) return null
  const output = textOf(result.stdout).trim()
  if (!output) return null
  try { return resolve(output) } catch { return null }
}

function readCrewClaim(lane, d) {
  try {
    const parsed = JSON.parse(d.readFileSync(join(lane.dir, 'crew.json'), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { parsed: null, unreadable: true }
    return { parsed, unreadable: false }
  } catch {
    return { parsed: null, unreadable: true }
  }
}

function claimFor(parsed) {
  return {
    lane: typeof parsed?.lane_name === 'string' ? parsed.lane_name : null,
    checkout: typeof parsed?.checkout === 'string' ? parsed.checkout : null,
  }
}

export function liveLaneClaims({ checkout, batchNames, deps } = {}) {
  const d = normalDeps(deps)
  const root = crewRoot({ home: d.home })
  let rootExists
  try { rootExists = d.existsSync(root) } catch {
    return { state: 'unreadable', root, live: [], own: [], foreign: [], unknown: [{ lane: null, reason: 'crew-root-unreadable' }], cleared: false }
  }
  if (!rootExists) return { state: 'absent', root, live: [], own: [], foreign: [], unknown: [], cleared: true }
  try {
    d.readdirSync(root)
  } catch {
    return { state: 'unreadable', root, live: [], own: [], foreign: [], unknown: [{ lane: null, reason: 'crew-root-unreadable' }], cleared: false }
  }
  const walkErrors = new Set()
  const walkDeps = {
    existsSync: (path) => {
      try { return d.existsSync(path) } catch (err) {
        walkErrors.add(String(path))
        throw err
      }
    },
    readFileSync: d.readFileSync,
    readdirSync: (path, options) => {
      try { return d.readdirSync(path, options) } catch (err) {
        walkErrors.add(String(path))
        throw err
      }
    },
  }
  let liveLanes = []
  try { liveLanes = discoverLanes(root, walkDeps) } catch { /* the wrapper records a partial walk */ }
  const activeLanes = liveLanes.filter((lane) => laneActive(lane, readJournal(lane.journal, walkDeps)))
  const unknown = []
  const records = activeLanes.map((lane) => {
    const crew = readCrewClaim(lane, d)
    return { lane, crew, claim: crew.unreadable ? null : claimFor(crew.parsed), repo: null }
  })
  const measured = records.filter(({ crew }) => !crew.unreadable)
  const dispatchRepo = activeLanes.length > 0 ? repoCommonDir(checkout, d) : null
  for (const record of measured) record.repo = repoCommonDir(record.claim.checkout, d)

  const noteUnknown = (lane, reason) => unknown.push({ lane, reason })
  const own = []
  const foreign = []
  const live = []
  batchNames = batchNames instanceof Set ? batchNames : new Set(Array.isArray(batchNames) ? batchNames : [])
  const sameRepo = (record) => record.repo && dispatchRepo && record.repo === dispatchRepo
  const nonOwn = records.filter((record) => !record.crew.unreadable
    && sameRepo(record)
    && !batchNames.has(record.claim.lane))

  const claims = new Map()
  if (nonOwn.length > 0) {
    const allLanes = [...liveLanes, ...archivedLanes(root, walkDeps)]
    const byDir = new Map(records.map((record) => [record.lane.dir, record.crew]))
    const sourceRepos = new Map(records.map((record) => [record.lane.dir, record.repo]))
    const candidateNames = new Set(nonOwn.map((record) => record.claim.lane).filter((name) => typeof name === 'string' && name.trim() !== ''))
    const candidateSiblings = new Map()
    for (const record of nonOwn) {
      if (!candidateSiblings.has(record.claim.lane)) candidateSiblings.set(record.claim.lane, new Set())
      const siblings = candidateSiblings.get(record.claim.lane)
      const fences = Array.isArray(record.crew.parsed?.lane_fence) ? record.crew.parsed.lane_fence : []
      for (const entry of fences) {
        if (typeof entry?.lane === 'string' && entry.lane.trim() !== '') siblings.add(entry.lane)
      }
    }
    for (const lane of allLanes) {
      const source = byDir.get(lane.dir) || readCrewClaim(lane, d)
      if (source.unreadable) continue
      const sourceClaim = claimFor(source.parsed)
      const fences = Array.isArray(source.parsed?.lane_fence) ? source.parsed.lane_fence : []
      const relevant = fences.filter((entry) => typeof entry?.lane === 'string'
        && entry.lane.trim() !== '' && candidateNames.has(entry.lane)
        && candidateSiblings.get(entry.lane)?.has(sourceClaim.lane) && Array.isArray(entry.files))
      if (relevant.length === 0) continue
      let sourceRepo
      if (sourceRepos.has(lane.dir)) {
        sourceRepo = sourceRepos.get(lane.dir)
      } else {
        sourceRepo = repoCommonDir(sourceClaim.checkout, d)
        sourceRepos.set(lane.dir, sourceRepo)
      }
      if (!sourceRepo || !dispatchRepo || sourceRepo !== dispatchRepo) continue
      for (const entry of relevant) {
        if (!claims.has(entry.lane)) claims.set(entry.lane, new Set())
        const files = claims.get(entry.lane)
        for (const file of entry.files) {
          if (typeof file === 'string') files.add(normaliseRepoPath(file))
        }
      }
    }
  }

  for (const path of walkErrors) noteUnknown(null, 'crew-walk-incomplete')

  for (const record of records) {
    const lane = record.lane
    const claim = record.claim || { lane: null, checkout: null }
    if (record.crew.unreadable) {
      noteUnknown(lane.task, 'crew-json-unreadable')
      continue
    }
    if (!record.repo || !dispatchRepo) {
      noteUnknown(lane.task, 'repo-unmeasured')
      continue
    }
    if (record.repo !== dispatchRepo) {
      foreign.push(lane.task)
      continue
    }
    if (batchNames.has(claim.lane)) {
      own.push(claim.lane)
      continue
    }
    const files = claims.get(claim.lane)
    if (!files) {
      noteUnknown(lane.task, 'claim-unrecorded')
      continue
    }
    live.push({ lane: claim.lane, dir: lane.dir, files: [...files].sort() })
  }
  const state = 'read'
  const cleared = state === 'read' && unknown.length === 0
  return { state, root, live, own, foreign, unknown, cleared }
}

export function externalCrewDir({ lane, parentDir, deps } = {}) {
  const d = normalDeps(deps)
  const parent = typeof parentDir === 'string' && parentDir.trim() ? parentDir : process.cwd()
  return join(crewRoot({ home: d.home }), slug(basename(join(parent, `dt-${lane}`))), slug(lane))
}

export function externalLaneReason({ settled, stage }) {
  if (settled) return 'run-settled'
  if (typeof stage === 'string' && stage.startsWith('escalate:')) return 'run-escalated'
  return 'run-complete'
}

export function externalFenceLiveness({ externals, parentDir, deps } = {}) {
  const d = normalDeps(deps)
  return (Array.isArray(externals) ? externals : []).map((lane) => {
    const dir = externalCrewDir({ lane, parentDir, deps: d })
    const crewPath = join(dir, 'crew.json')
    let crewExists
    try { crewExists = d.existsSync(crewPath) } catch {
      return {
        lane, dir, live: false, reason: 'crew-json-unreadable', stage: null,
        heartbeat_age_ms: null, stale_after_ms: null, sibling_files: null,
      }
    }
    if (!crewExists) {
      return {
        lane, dir, live: false, reason: 'crew-dir-absent', stage: null,
        heartbeat_age_ms: null, stale_after_ms: null, sibling_files: null,
      }
    }
    let crew
    try { crew = JSON.parse(d.readFileSync(crewPath, 'utf8')) } catch {
      return {
        lane, dir, live: false, reason: 'crew-json-unreadable', stage: null,
        heartbeat_age_ms: null, stale_after_ms: null, sibling_files: null,
      }
    }
    if (crew?.lane_name !== lane) {
      return {
        lane, dir, live: false, reason: 'crew-lane-mismatch', stage: null,
        heartbeat_age_ms: null, stale_after_ms: null, sibling_files: null,
      }
    }
    let settled
    try { settled = d.existsSync(join(dir, 'returns', 'task.json')) } catch {
      return {
        lane, dir, live: false, reason: 'crew-json-unreadable', stage: null,
        heartbeat_age_ms: null, stale_after_ms: null, sibling_files: null,
      }
    }
    const journal = readJournal(join(dir, 'journal.jsonl'), d)
    const stage = journal.lastStage ?? null
    const live = laneActive({ settled }, journal)
    let nowMs
    try { nowMs = typeof d.now === 'function' ? d.now() : Date.now() } catch { nowMs = null }
    const staleAfterMs = DRIVER_GONE_PERIODS * HEARTBEAT_PERIOD_MS
    const age = journal.lastActivityAt === null || !Number.isFinite(nowMs) ? null : nowMs - journal.lastActivityAt
    const abandoned = live && age !== null && age > staleAfterMs
    const siblingFiles = [...new Set((Array.isArray(crew.lane_fence) ? crew.lane_fence : [])
      .flatMap((entry) => Array.isArray(entry?.files) ? entry.files : [])
      .filter((file) => typeof file === 'string')
      .map(normaliseRepoPath))].sort()
    return {
      lane,
      dir,
      live: live && !abandoned,
      reason: live ? (abandoned ? EXTERNAL_FENCE_ABANDONED : null) : externalLaneReason({ settled, stage }),
      stage,
      heartbeat_age_ms: age,
      stale_after_ms: staleAfterMs,
      sibling_files: siblingFiles,
    }
  })
}

export function crossBatchCollisions({ entries, live, externals } = {}) {
  const collisions = []
  const ownEntries = Array.isArray(entries) ? entries : []
  const liveLanes = Array.isArray(live) ? live : []
  const externalNames = new Set(Array.isArray(externals) ? externals : [])
  for (const entry of ownEntries) {
    const ownFiles = (Array.isArray(entry?.files) ? entry.files : [])
      .filter((file) => typeof file === 'string').map(normaliseRepoPath)
    for (const current of liveLanes) {
      // An external entry DECLARES that this live lane holds these files, so the pair it
      // names is the intent, never a collision. Every other pair still refuses.
      if (externalNames.has(entry.lane) && entry.lane === current.lane) continue
      const liveFiles = (Array.isArray(current?.files) ? current.files : [])
        .filter((file) => typeof file === 'string').map(normaliseRepoPath)
      const collided = ownFiles.some((file) => fenceEntryIntersects(file, liveFiles))
        || liveFiles.some((file) => fenceEntryIntersects(file, ownFiles))
      if (!collided) continue
      const files = [...new Set([
        ...ownFiles.filter((file) => fenceEntryIntersects(file, liveFiles)),
        ...liveFiles.filter((file) => fenceEntryIntersects(file, ownFiles)),
      ])].sort()
      collisions.push({ lane: entry.lane, live: current.lane, dir: current.dir, files })
    }
  }
  return collisions
}

export function checkFences({ fences, lanes, graph, checkout, externals, parentDir, outDir, deps } = {}) {
  const d = normalDeps(deps)
  const entries = fenceEntriesOf(fences).map(normaliseFence)
  const batchLanes = Array.isArray(lanes) ? lanes : []
  const byLane = new Map(entries.map((entry) => [entry.lane, entry]))
  const externalNames = new Set((Array.isArray(externals) ? externals : []).filter((name) => typeof name === 'string' && name.trim() !== ''))

  // An absent graph is UNMEASURED edges, not "no edges": relatedLanes reads false for every
  // pair, so an exemption this register does carry is reported as a sibling-leak that does
  // not exist. That false premise cost b224-fencechecks a lane at plan:r1 (#634). With no
  // edge declared anywhere the graph is irrelevant and the answer is unchanged.
  const declaredEdges = batchLanes.some((lane) => Array.isArray(lane?.depends_on) && lane.depends_on.length > 0)
  const hasGraph = Boolean(graph && graph.ancestors instanceof Map)
  if (declaredEdges && !hasGraph) refuse(`checkFences cannot judge sibling-leak for a batch that declares depends_on edges without the graph that carries them; pass the graph planWaves returns`, GRAPH_UNMEASURED)

  // Check the register's membership before inspecting its shapes: a batch lane
  // can never fall through to an implicit, unfenced write surface.
  const batchNames = new Set(batchLanes.map(laneNameOf))
  const claimedBoth = [...batchNames].filter((name) => externalNames.has(name))
  if (claimedBoth.length > 0) refuse(`fence register marks batch lane(s) external: ${claimedBoth.join(', ')}; an external entry names a lane from ANOTHER batch`, FENCE_REGISTER_MISMATCH)
  for (const lane of batchLanes) {
    const name = laneNameOf(lane)
    if (!byLane.has(name)) refuse(`lane is not in the fence register: ${name}`, LANE_UNFENCED)
  }

  // The drive-side validator is intentionally used here. The compiler's helper
  // has a different object-shaped contract and throws instead of returning rows.
  for (const entry of entries) {
    if (!Array.isArray(entry.files)) {
      refuse(`invalid scope entries for lane ${entry.lane}: files must be an array`, SCOPE_ENTRY_INVALID)
    }
    const parsed = entry.files.map((file) => parseFenceScope(file))
    const invalid = parsed.find((scope) => scope.kind === 'invalid')
    if (invalid) {
      refuse(`invalid scope entries for lane ${entry.lane}: ${invalid.entry} (${invalid.reason})`, SCOPE_ENTRY_INVALID)
    }
    const wholeFiles = parsed.filter((scope) => scope.kind === 'file').map((scope) => scope.path)
    let shapeErrors
    try { shapeErrors = driveValidateScopeEntries(wholeFiles) } catch (err) {
      refuse(`invalid scope entries for lane ${entry.lane}: ${err?.message || String(err)}`, SCOPE_ENTRY_INVALID)
    }
    if (shapeErrors.length > 0) {
      refuse(`invalid scope entries for lane ${entry.lane}: ${shapeErrors.map(({ entry: path, why }) => `${path} (${why})`).join('; ')}`, SCOPE_ENTRY_INVALID)
    }
  }

  const siblingLeaks = []
  for (const lane of batchLanes) {
    const name = laneNameOf(lane)
    const own = byLane.get(name)
    const ownFiles = own.files.map(normaliseRepoPath)
    const ownCreates = laneCreatesOf(lane)
    for (const sibling of entries) {
      if (sibling.lane === name) continue
      const siblingFiles = sibling.files.map(normaliseRepoPath)
      const siblingPaths = siblingFiles.map((file) => parseFenceScope(file).path)
      const matchSibling = scopeMatcher(siblingPaths)
      const leakedFiles = ownFiles.filter((file) => fenceEntryIntersects(file, siblingFiles))
      if (leakedFiles.length > 0) {
        siblingLeaks.push({ kind: 'fence', lane: name, sibling: sibling.lane, files: [...new Set(leakedFiles)], siblingFiles })
      }
      const leakedCreates = ownCreates.filter(matchSibling)
      if (leakedCreates.length > 0) {
        siblingLeaks.push({ kind: 'creates', lane: name, sibling: sibling.lane, files: [...new Set(leakedCreates)], siblingFiles })
      }
    }
  }
  if (siblingLeaks.length > 0) {
    const details = siblingLeaks.map((leak) => {
      const files = leak.files.join(', ')
      return leak.kind === 'creates'
        ? `lane ${leak.lane} creates path(s) inside sibling ${leak.sibling}'s fence: ${files} (sibling fence: ${leak.siblingFiles.join(', ')})`
        : `lane ${leak.lane} own fence overlaps sibling ${leak.sibling}: ${files} (sibling fence: ${leak.siblingFiles.join(', ')})`
    }).join('; ')
    refuse(`${details}; sequencing shared-file work requires separate registers, not narrower fences; dispatch each lane as its own single-lane register`, SIBLING_LEAK)
  }

  const pins = collectAnchorPins({ checkout, deps: d })
  const scanRoot = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  const fenceHasSurface = entries.some((entry) => (Array.isArray(entry.files) ? entry.files : []).some((file) => {
    const path = parseFenceScope(file).path
    if (typeof path !== 'string') return false
    try { return d.existsSync(join(scanRoot, ...path.split('/'))) } catch { return false }
  }))
  let reachIndex = null
  const reachFor = () => (reachIndex ??= collectTestReach({ checkout: scanRoot, deps: d }))
  // One scan for the whole batch, shared by every existing file and directory surface.
  let carrierIndex = null
  const carriersFor = () => (carrierIndex ??= citationCarriers({ checkout: scanRoot, pins, deps: d }))
  // Measure live claims before admission classification. The returned live set is still
  // useful when the overall census is unknown: an unknown result is not an empty claim set.
  const crossBatch = liveLaneClaims({ checkout: scanRoot, batchNames, deps: d })
  const externalRows = externalFenceLiveness({ externals: [...externalNames], parentDir, deps: d })
  const abandonedRows = externalRows.filter((row) => row.reason === EXTERNAL_FENCE_ABANDONED)
  const dead = externalRows.filter((row) => row.live !== true && row.reason !== EXTERNAL_FENCE_ABANDONED)
  if (dead.length > 0) refuse(`the fence register names external lane(s) that are not live: ${dead.map((row) => `${row.lane} (${row.reason}, crew dir ${row.dir})`).join('; ')}; an external fence denies a surface its lane must still hold`, EXTERNAL_FENCE_STALE)
  if (abandonedRows.length > 0) refuse(`the fence register names external lane(s) whose driver is gone: ${abandonedRows.map((row) => `${row.lane} (crew dir ${row.dir}, heartbeat age ${row.heartbeat_age_ms}ms, stale after ${row.stale_after_ms}ms)`).join('; ')}; the lane's driver is gone, so the surface is denied by a lane nobody is running`, EXTERNAL_FENCE_ABANDONED)
  const externalByLane = new Map(externalRows.map((row) => [row.lane, row]))
  const holderClaims = () => {
    const claims = []
    for (const entry of entries) {
      if (batchNames.has(entry.lane)) {
        claims.push({ lane: entry.lane, files: entry.files, dir: null })
        continue
      }
      const external = externalByLane.get(entry.lane)
      if (external?.live === true) claims.push({ lane: entry.lane, files: entry.files, dir: external.dir })
    }
    for (const current of Array.isArray(crossBatch.live) ? crossBatch.live : []) {
      if (batchNames.has(current?.lane)) continue
      claims.push({ lane: current?.lane, files: current?.files, dir: current?.dir ?? null })
    }
    const unique = new Map()
    for (const claim of claims) {
      if (typeof claim.lane !== 'string' || claim.lane.trim() === '') continue
      const files = [...new Set((Array.isArray(claim.files) ? claim.files : [])
        .filter((file) => typeof file === 'string')
        .map(normaliseRepoPath))].sort()
      const key = `${claim.lane}\u0000${claim.dir || ''}`
      if (!unique.has(key)) unique.set(key, { lane: claim.lane, files, dir: claim.dir })
    }
    return [...unique.values()].sort((a, b) => a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : (a.dir || '').localeCompare(b.dir || ''))
  }
  const authoredHolders = holderClaims()
  const holderFor = (lane, file) => {
    const candidate = normaliseRepoPath(file)
    const authoredHolder = authoredHolders.find((holder) => {
      if (holder.lane === lane || (batchNames.has(holder.lane) && relatedLanes(graph, lane, holder.lane))) return false
      const intersects = holder.files.some((held) => fenceEntryIntersects(candidate, [held]) || fenceEntryIntersects(held, [candidate]))
      return intersects ? { lane: holder.lane, files: [...holder.files], dir: holder.dir } : false
    })
    if (authoredHolder) return authoredHolder
    return null
  }
  const reportPath = typeof outDir === 'string' && outDir.trim() ? join(outDir, FENCE_REPORT_FILE) : null
  let citation = reportPath || '(report unavailable: no-out-dir)'
  const reportLanes = []
  const deferredWarnings = []
  const summaryLanes = []
  const warnings = []
  const reachRefusals = []
  const admissionByLane = new Map()
  const admissionOwners = new Map()
  const admissionArbitrations = new Map()
  const arbitrationWarning = ({ lane, file, source, holder }) => {
    const text = `dispatch-batch: WARNING fence-admission-arbitrated: lane ${lane} scanned ${file} for automatic ${source} admission, but lane ${holder.lane} won first-lane arbitration for ${holder.file}; this lane continues without widening its fence`
    warnings.push({ kind: 'fence-admission-arbitrated', lane, file, source, holder, text })
    admissionArbitrations.get(lane)?.push({ lane, file, source, holder, text })
    d.log(text)
    return { lane, file, source, holder, text }
  }
  const perLane = {}
  const authoredPerLane = {}
  for (const lane of batchLanes) {
    const name = laneNameOf(lane)
    const own = byLane.get(name)
    const ownFiles = own.files.map(normaliseRepoPath)
    authoredPerLane[name] = { files: [...ownFiles] }
    const effectiveFiles = [...ownFiles]
    const laneAdmissions = []
    const admissionKeys = new Set()
    admissionByLane.set(name, laneAdmissions)
    admissionArbitrations.set(name, [])
    const recordAdmission = (row) => {
      const key = `${row.lane}\u0000${row.file}\u0000${row.source}`
      if (admissionKeys.has(key)) return row
      admissionKeys.add(key)
      laneAdmissions.push(row)
      if (!effectiveFiles.includes(row.file)) effectiveFiles.push(row.file)
      return row
    }
    const automaticAdmission = (source, file) => {
      const row = fenceAdmission({ lane: name, file, source })
      const admissionOwner = admissionOwners.get(row.file)
      if (admissionOwner && admissionOwner.lane !== name && !relatedLanes(graph, name, admissionOwner.lane)) {
        return arbitrationWarning({ lane: name, file: row.file, source, holder: admissionOwner })
      }
      if (!admissionOwner) admissionOwners.set(row.file, { lane: name, file: row.file, source })
      return recordAdmission(row)
    }
    const ownPaths = ownFiles.map((file) => parseFenceScope(file).path)
    const ownWhere = laneWhereOf(lane)
    const ownCreates = laneCreatesOf(lane)
    const matchOwn = scopeMatcher(ownPaths)
    const hasTestSurface = ownPaths.some((path) => path.endsWith('.test.mjs'))
    const missingCensusCarriers = CENSUS_CARRIER_FILES.filter((carrier) => !matchOwn(carrier))
    const censusExposure = hasTestSurface && missingCensusCarriers.length > 0
    let censusWarning = null
    if (censusExposure) {
      censusWarning = {
        kind: 'census-carrier',
        lane: name,
        carriers: CENSUS_CARRIER_FILES,
        missing: missingCensusCarriers,
        repair: CENSUS_CARRIER_REPAIR,
        blind_spot: CENSUS_CARRIER_BLIND_SPOT,
        text: `${CENSUS_CARRIER_WARNING_PREFIX} lane ${name} fences a test surface but omits repository-wide census carriers ${CENSUS_CARRIER_FILES.join(', ')}; missing=${missingCensusCarriers.join(', ')}; WARNING, not a refusal. ${CENSUS_CARRIER_REPAIR} ${CENSUS_CARRIER_BLIND_SPOT}`,
      }
      warnings.push(censusWarning)
    }
    if (censusExposure) {
      for (const carrier of missingCensusCarriers) {
        const holder = holderFor(name, carrier)
        if (!holder) automaticAdmission('census-carrier', carrier)
      }
    }
    const ownSurface = [...ownWhere, ...ownCreates]
    if (!ownSurface.every(matchOwn)) {
      const outside = ownSurface.filter((path) => !matchOwn(path))
      refuse(`lane ${name} where path(s) outside own fence: ${outside.join(', ')}`, WHERE_OUTSIDE_FENCE)
    }

    // #635 made a shift REPAIRABLE: content found once at a new line is relocated and
    // reported, not failed. The premise this check refused on — "the lane cannot edit the
    // manifest that would re-anchor it" — therefore no longer implies a failure, and the
    // refusal falsely blocked three of five lanes in one batch. The SCAN stays: it names
    // every pin in one shot, the sweep that cost b217-treefingerprint a lane when done by
    // hand. Rot and ambiguity are still fatal and are still caught where they become
    // facts — the skill's own exhibits.test.mjs — not by a static pre-dispatch guess.
    const unfencedPins = anchorPinsOutsideFence({ surface: ownSurface, fenceFiles: ownPaths, pins })
    for (const pin of unfencedPins) {
      const holder = holderFor(name, pin.manifest)
      if (!holder) automaticAdmission('anchor-pin', pin.manifest)
    }
    if (unfencedPins.length > 0) {
      const detail = unfencedPins.map(({ file, manifest, keys }) => `${file} pinned by ${manifest} at ${keys.join(', ')}`).join('; ')
      const rolesManifestUnfenced = unfencedPins.some(({ manifest }) => manifest === ROLES_ANCHOR_MANIFEST)
      const rolesClause = rolesManifestUnfenced
        ? ` The roles manifest is held to a strict BIJECTION with the charters ${ROLES_ANCHOR_COMPANIONS.join(' and ')} in crew/drive.test.mjs's "every crew/drive.mjs anchor the tech-lead charter cites resolves to the code it names" test, so a lane that adds or removes a citation in a charter must still fence all three; a line shift is repaired post-merge like any other.`
        : ''
      const text = `${ANCHOR_PIN_WARNING_PREFIX} lane ${name} writes anchor-pinned file(s) whose pinning manifest is outside its fence: ${detail}; ${ANCHOR_PIN_POST_MERGE}; rot and ambiguity still fail in the skill's own exhibits.test.mjs.${rolesClause} ${ANCHOR_BLIND_SPOT}`
      warnings.push({ kind: 'anchor-pin', lane: name, pins: unfencedPins, text })
    }

    // The docs that CITE the lines this lane moves. The post-merge pass rewrites the
    // manifest and its carriers together; this warning names those docs so an operator
    // can fence them when correct line numbers are needed at merge time.
    const unfencedCarriers = citationCarriersOutsideFence({ surface: ownSurface, fenceFiles: ownPaths, carriers: carriersFor() })
    if (unfencedCarriers.length > 0) {
      const docs = [...new Set(unfencedCarriers.map(({ doc }) => doc))]
      const listed = unfencedCarriers.slice(0, CITATION_CARRIER_ROW_LIMIT)
        .map(({ doc, file, keys }) => `${doc} cites ${file} at ${keys.join(', ')}`).join('; ')
      const omitted = unfencedCarriers.length - Math.min(unfencedCarriers.length, CITATION_CARRIER_ROW_LIMIT)
      const warning = { kind: 'citation-carrier', lane: name, carriers: unfencedCarriers, docs, text: null }
      warnings.push(warning)
      deferredWarnings.push(() => {
        const tail = reportTail(omitted, citation)
        const carrierText = `${CITATION_CARRIER_WARNING_PREFIX} lane ${name} moves lines in file(s) cited by ${docs.length} doc(s) outside its fence (listing at most ${CITATION_CARRIER_ROW_LIMIT}): ${listed}${tail}. ${CITATION_CARRIER_POST_MERGE}. Fence these docs if you want them correct at merge time: ${docs.join(', ')}. ${CITATION_CARRIER_BLIND_SPOT}`
        warning.text = carrierText
      })
    }

    const droppedReachRows = []
    const reachRows = fenceHasSurface ? testsOutsideFence({ surface: ownSurface, fenceFiles: ownPaths, reach: reachFor(), droppedRows: droppedReachRows }) : []
    // Classify candidates BEFORE the warning is queued (#960), and keep the full reach
    // listing as evidence even when a held row later refuses. Deferred warnings render at
    // :1313, ahead of any refusal raised after this loop. dispatch.warnings.json carries
    // every row, so the operator's listing stays complete; an OVERRIDDEN row keeps its
    // warning because it genuinely does not refuse.
    const surfaceExports = fenceHasSurface ? surfaceExportsOf({ surface: ownSurface, reach: reachFor() }) : []
    const allowed = new Map(laneAllowTestReachOf(lane).map(({ file, why }) => [file, why]))
    const candidates = reachRefusalRows({ rows: reachRows, surfaceExports })
    const overridden = []
    const refusedRows = []
    for (const row of candidates) {
      const holder = holderFor(name, row.test)
      if (allowed.has(row.test)) overridden.push({ ...row, why: allowed.get(row.test), holder, admission_override: holder === null })
      else if (holder) refusedRows.push({ ...row, holder })
      else automaticAdmission('test-reach', row.test)
    }
    const warnRows = reachRows
    if (warnRows.length > 0) {
      const listed = warnRows.slice(0, TEST_REACH_ROW_LIMIT).map(reachRowText).join('; ')
      const omitted = warnRows.length - Math.min(warnRows.length, TEST_REACH_ROW_LIMIT)
      const warning = { kind: 'test-reach', lane: name, reach: warnRows, text: null }
      warnings.push(warning)
      deferredWarnings.push(() => {
        const tail = reportTail(omitted, citation)
        const reachText = `${TEST_REACH_WARNING_PREFIX} lane ${name} changes file(s) reached by ${warnRows.length} test file(s) outside its fence, least obvious first (listing at most ${TEST_REACH_ROW_LIMIT}): ${listed}${tail}; an unheld named test is admitted to the effective fence, while a test held by another lane remains a refusal. ${TEST_REACH_BLIND_SPOT}`
        warning.text = reachText
      })
    }
    if (overridden.length > 0) {
      const overrideText = `${TEST_REACH_OVERRIDE_PREFIX} lane ${name} declares ${TEST_REACH_OVERRIDE_KEY} for ${overridden.length} reaching test(s) that would otherwise refuse: ${overridden.map((row) => `${row.symbols.length === 0 ? `${row.test} reaches ${row.file} through a static path literal (which includes its own import specifier; path-only, how=path)` : `${row.test} imports ${row.file} and names ${row.symbols.join(', ')}`}; why=${row.why}; holder=${row.holder?.lane ?? 'none'} dir=${row.holder?.dir ?? 'unknown'} files=${row.holder?.files?.join(',') ?? 'none'}; override=${row.admission_override ? 'explicit-exclusion' : 'held-test'}${row.admission_override ? `; operator exclusion overrode automatic admission for ${row.test}` : ''}`).join('; ')}; the named row(s) do not trigger ${TEST_REACH_UNFENCED}, the test(s) stay OUTSIDE the lane fence, and no seat may widen its own scope to reach them; this records the override only — every later check can still refuse this batch, so it is not a statement of the lane dispatch outcome.`
      warnings.push({ kind: 'test-reach-override', lane: name, rows: overridden, text: overrideText })
      d.log(overrideText)
    }
    if (refusedRows.length > 0) reachRefusals.push({ lane: name, rows: refusedRows, files: ownFiles })
    const overrideField = overridden.length > 0 ? { test_reach_overrides: overridden } : {}
    const arbitrationField = admissionArbitrations.get(name)?.length > 0 ? { fence_admission_arbitrated: admissionArbitrations.get(name) } : {}
    reportLanes.push({ lane: name, test_reach: reachRows, test_reach_dropped: droppedReachRows, citation_carriers: unfencedCarriers, anchor_pins: unfencedPins, census_carriers: censusWarning ? [censusWarning] : [], ...(laneAdmissions.length > 0 ? { fence_admissions: laneAdmissions } : {}), ...arbitrationField, ...overrideField })
    summaryLanes.push({
      lane: name,
      counts: {
        anchorPin: unfencedPins.reduce((total, row) => total + (Array.isArray(row.keys) ? row.keys.length : 0), 0),
        citationCarrier: unfencedCarriers.length,
        censusCarrier: censusWarning ? 1 : 0,
        testReach: reachRows.length,
        actionable: refusedRows.length,
        testReachDropped: droppedReachRows.length,
      },
      refusals: refusedRows.length > 0 ? [TEST_REACH_UNFENCED] : [],
    })

    const siblings = []
    for (const sibling of entries) {
      if (sibling.lane === name) continue
      const siblingFiles = sibling.files.map(normaliseRepoPath)
      siblings.push({ lane: sibling.lane, files: siblingFiles })
    }
    perLane[name] = {
      lane: name,
      files: effectiveFiles,
      where: ownWhere,
      creates: ownCreates,
      reads: Array.isArray(own.reads) ? own.reads : [],
      siblings,
      ...(laneAdmissions.length > 0 ? { fence_admissions: laneAdmissions } : {}),
      ...(admissionArbitrations.get(name)?.length > 0 ? { fence_admission_arbitrated: admissionArbitrations.get(name) } : {}),
    }
  }
  const admissions = []
  const compareAdmissions = (a, b) => a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : a.source < b.source ? -1 : a.source > b.source ? 1 : 0
  for (const lane of batchLanes) {
    const name = laneNameOf(lane)
    const laneRows = admissionByLane.get(name) || []
    laneRows.sort(compareAdmissions)
    admissions.push(...laneRows)
    const floor = [...(authoredPerLane[name]?.files || (byLane.get(name)?.files || []).map(normaliseRepoPath))]
    const files = [...floor]
    for (const row of laneRows) if (!files.includes(row.file)) files.push(row.file)
    if (perLane[name]) perLane[name].files = files
  }
  admissions.sort(compareAdmissions)
  for (const row of admissions) d.log(`dispatch-batch: ${FENCE_ADMISSION_EVENT} lane=${row.lane} file=${row.file} source=${row.source}`)
  if (!crossBatch.cleared) {
    const text = `${CROSS_BATCH_UNKNOWN_PREFIX} the live lane set could not be determined in full (crew root ${crossBatch.root}, state ${crossBatch.state}): ${crossBatch.unknown.map((row) => `${row.lane ?? 'crew-root'} (${row.reason})`).join('; ') || 'none named'}; this batch is NOT cleared against those lanes and this absence is not a clear. ${CROSS_BATCH_BLIND_SPOT}`
    warnings.push({ kind: 'cross-batch-unknown', lane: null, unknown: crossBatch.unknown, text })
  }
  // The summary line replaced the full listing on stdout, so the ROWS now live only in
  // the report. If the report could not be written they would exist nowhere at all —
  // an unwritable outDir would silently turn 36 warning rows into a single count. The
  // log gets shorter; a row is never LOST. When there is no report, the full text is
  // printed instead, which is exactly the pre-summary behaviour for that case only.
  let reportFailed = false
  if (reportPath) {
    const reportError = writeFenceReport({ path: reportPath, lanes: reportLanes, crossBatchUnknown: crossBatch.unknown, deps: d })
    if (reportError) { citation = `(report unavailable: ${reportError?.code || 'write-failed'})`; reportFailed = true }
  }
  for (const renderWarning of deferredWarnings) renderWarning()
  // Narrow on purpose: a caller that passed NO outDir did not ask for a report, and the
  // real dispatcher always passes one (main() defaults it to <batch>/out). Only a report
  // that was requested and could not be WRITTEN loses rows that exist nowhere else.
  if (reportFailed) {
    d.log(`${WARNING_ROWS_UNPERSISTED_PREFIX} ${citation} — the rows below are printed in full because they are recorded nowhere else`)
    for (const warning of warnings) if (typeof warning.text === 'string' && warning.text) d.log(warning.text)
  }
  for (const state of summaryLanes) {
    d.log(warningSummary({
      lane: state.lane,
      counts: { ...state.counts, crossBatchUnknown: crossBatch.unknown.length },
      refusals: state.refusals,
      citation,
      warnings,
    }))
  }
  // #960. This REFUSES where the surrounding reach scan only warns, and the difference is
  // the conjunction, not the severity: #635 downgraded a heuristic that refused on ANY
  // reach because it falsely blocked three of five lanes in one batch. This one fires only
  // when the test imports the fenced file DIRECTLY and names a symbol the lane's own write
  // surface exports — the shape b451-fffgrant was dispatched over, printed as row N of 23
  // and skimmed. It runs after the report is written and the warnings rendered, so the
  // refusal can cite a listing the operator already has, and BEFORE the absent check, whose
  // comment claims the last position among register checks and keeps it.
  if (reachRefusals.length > 0) {
    const detail = reachRefusals.flatMap(({ lane: name, rows }) => rows.map((row) => {
      const holder = row.holder ? `; holder lane ${row.holder.lane} (crew dir ${row.holder.dir ?? 'unknown'}) files ${row.holder.files.join(', ')}` : ''
      return row.symbols.length === 0
        ? `lane ${name}: ${row.test} reaches ${row.file} through a static path literal (which includes its own import specifier; path-only, how=path)${holder}`
        : `lane ${name}: ${row.test} imports ${row.file} at one hop and names ${row.symbols.join(', ')}${holder}`
    })).join('; ')
    const remedy = reachRefusals.map(({ lane: name, rows, files }) => `lane ${name}: ${[...new Set([...files, ...rows.map(({ test }) => test)])].sort().join(', ')}`).join(' | ')
    const remedyText = `${TEST_REACH_REFUSAL_REMEDY} ${remedy}`
    const text = `test(s) outside a lane fence assert the behaviour that lane changes: ${detail}; ${remedyText}; declare ${TEST_REACH_OVERRIDE_KEY} on the lane request to dispatch anyway, and the decision is logged and recorded on ${FENCE_REPORT_FILE}. ${TEST_REACH_REFUSAL_BLIND_SPOT}`
    refuse(text, TEST_REACH_UNFENCED)
  }
  // The other half of the invariant the membership loop above measures (#658): a register may
  // not be a SUPERSET of the batch it is dispatched with. A lane's sibling count is DERIVED
  // from batch size, so such a register can only ever be caught at boot, as
  // fence-count-mismatch, after every seat has been paid for. Both halves are decidable from
  // these two inputs with nothing booted. This check runs LAST on purpose: no existing
  // refusal changes the cause it names.
  const absent = entries.map(({ lane }) => lane).filter((name) => !batchNames.has(name) && !externalNames.has(name))
  if (absent.length > 0) refuse(`fence register names lane(s) absent from the batch: ${absent.join(', ')}; the batch carries ${[...batchNames].join(', ') || 'no lanes'}, and a lane's sibling count is derived from batch size, so this register can only refuse at boot as ${FENCE_COUNT_MISMATCH}`, FENCE_REGISTER_MISMATCH)
  for (const row of externalRows) {
    const declared = [...new Set((byLane.get(row.lane)?.files || [])
      .filter((file) => typeof file === 'string')
      .map(normaliseRepoPath))].sort()
    const claimed = row.sibling_files === null
      ? null
      : [...new Set((row.sibling_files || [])
        .filter((file) => typeof file === 'string')
        .map(normaliseRepoPath))].sort()
    const matchClaimed = scopeMatcher(claimed || [])
    const overlap = declared.filter(matchClaimed)
    const fenceCompare = !claimed || claimed.length === 0
      ? 'unmeasured'
      : overlap.length > 0 ? 'mismatch' : 'clear'
    d.log(`${EXTERNAL_FENCE_PREFIX} lane=${row.lane} crew_dir=${row.dir} stage=${row.stage ?? 'none'} files=${declared.join(',')} fence_compare=${fenceCompare}`)
    if (overlap.length > 0) {
      const mismatchText = `${EXTERNAL_FENCE_PREFIX} lane=${row.lane} crew_dir=${row.dir} mismatch declared=${declared.join(',') || 'none'} claimed=${claimed.join(',')} files=${overlap.join(',')}; blind spot: a lane's own fence is not recorded in its own crew.json, so only a file another lane demonstrably owns can be contradicted — an under-declared external is not measured.`
      warnings.push({ kind: 'external-fence-mismatch', lane: row.lane, declared, claimed, files: overlap, text: mismatchText })
      d.log(mismatchText)
    }
  }
  if (externalRows.length > 0) {
    d.log(`${EXTERNAL_FENCE_PREFIX} carried=${externalRows.length} lanes=${externalRows.map((row) => row.lane).join(',')} — carried in from lanes outside this batch; they deny every batch lane's write surface and are NOT counted in the sibling total checkArrival derives`)
  }
  // Every check above reads only the register and the batch in hand; this one reads LIVE
  // state OUTSIDE both. A cause an operator can fix from the register alone is named first
  // and is never masked by one that depends on what else happens to be running.
  //
  // This REFUSES where the test-reach scan only warns, and the difference is not severity:
  // the reach scan is a static proxy (#635 measured a heuristic refusal falsely blocking
  // three of five lanes in one batch), while a collision here is a FACT read from a live
  // lane's own persisted fence. An UNDETERMINED live set is neither — it warns, and it
  // never reads as "no collision" (#678, #687).
  const collisions = crossBatchCollisions({ entries, live: crossBatch.live, externals: [...externalNames] })
  if (collisions.length > 0) {
    const detail = collisions.map((row) => `lane ${row.lane} collides with live lane ${row.live} on ${row.files.join(', ')} (crew dir ${row.dir})`).join('; ')
    refuse(`the fence register grants file(s) that a live lane outside this batch already holds: ${detail}; "ONE register, ONE batch" holds only while one batch runs at a time — settle, archive or narrow the named lane, or narrow this register`, CROSS_BATCH_COLLISION)
  }
  const effectiveFences = entries.map((entry) => ({
    ...entry,
    files: perLane[entry.lane]?.files ? [...perLane[entry.lane].files] : [...entry.files],
  }))
  return { perLane, authoredPerLane, warnings, crossBatch, externals: externalRows, fences: effectiveFences, admissions }
}

// A fence denies a SIBLING's declared surface; it never denied an UNCLAIMED path, so a
// planner could declare a write surface wider than the brief asked for and collide with
// nothing only by luck. The lane's own fence is the authority the driver's plan-accept
// never consulted (crew/drive.mjs:2419 checks siblings only). Refuse and NAME the paths:
// silently narrowing a declaration is how a fence stops meaning anything.
export function checkPlanScope({ lane, declared, files } = {}) {
  const name = laneNameOf(lane)
  const fenceFiles = (Array.isArray(files) ? files : []).map(normaliseRepoPath)
  const inFence = scopeMatcher(fenceFiles)
  const paths = (Array.isArray(declared) ? declared : []).map(normaliseRepoPath)
  const outside = paths.filter((path) => !inFence(path))
  if (outside.length > 0) {
    refuse(`lane ${name} plan declares files_in_scope outside the lane fence: ${outside.join(', ')}; the lane fence is ${fenceFiles.join(', ') || 'empty'}`, PLAN_SCOPE_OUTSIDE_FENCE)
  }
  return { lane: name, declared: paths, fence: fenceFiles }
}

const MACHINERY_ALLOWANCE = 2

// TRD §5 R2 / §10 decision 6. The scope gate adjudicates PATHS; this
// adjudicates PURPOSE-adjacent growth, and it is a FINDING the lead
// disposes of, never a refusal — an over-creating plan may still be the
// right plan. Counts are supplied by the caller, exactly as checkPlanScope
// takes its `declared` list.
export function checkMachineryBudget({ lane, creates = [], newFiles = [], newSymbols = [], allowance = MACHINERY_ALLOWANCE } = {}) {
  const name = laneNameOf(lane)
  const created = (Array.isArray(creates) ? creates : []).map(normaliseRepoPath)
  const files = (Array.isArray(newFiles) ? newFiles : []).map(normaliseRepoPath)
  const symbols = (Array.isArray(newSymbols) ? newSymbols : []).map((symbol) => String(symbol))
  const budget = created.length + allowance
  const counted = files.length + symbols.length
  const excess = counted - budget
  const findings = excess > 0
    ? [{
        id: `MB-${name}`,
        severity: 'should-fix',
        location: files[0] || 'plan.md',
        summary: `lane ${name} plans ${counted} new item(s) — ${files.length} file(s) [${files.join(', ') || 'none'}] and ${symbols.length} exported symbol(s) [${symbols.join(', ') || 'none'}] — against a budget of ${budget} (creates ${created.length} + allowance ${allowance}): ${excess} over. Added machinery is a decision, not a defect: keep it, narrow it, or drop it.`,
        disposition: 'ask-user',
      }]
    : []
  return { lane: name, budget, counted, excess, findings }
}

// #658: a directed lane's PLAN IS ITS BRIEF, and the compiled brief is an artefact the
// dispatcher holds in hand before it boots anything. parseDirectedBrief is the authority the
// driver itself uses (crew/drive.mjs:2332) and its own defect string is reported verbatim, so
// one defect has one sentence rather than two that can drift. The variant is recognised by
// what it DECLARES — sources.gate === 'brief' — exactly as preflightRunOptions recognises a
// ctx validation lane, so a later shape whose gate comes from its brief is checked too.
export function checkDirectedBrief({ lane, variant, briefPath, deps } = {}) {
  const d = normalDeps(deps)
  const name = laneNameOf(lane)
  const resolved = String(variant ?? 'full')
  if (VARIANTS[resolved]?.sources?.gate !== 'brief') return { lane: name, variant: resolved, checked: false }
  let text = null
  try { text = textOf(d.readFileSync(briefPath, 'utf8')) } catch (err) {
    refuse(`cannot read the compiled brief for ${resolved} lane ${name} at ${briefPath}: ${err?.message || String(err)}`, DIRECTED_BRIEF_INVALID)
  }
  const parsed = parseDirectedBrief(text)
  if (parsed.defect) refuse(`lane ${name} runs the ${resolved} shape, whose plan IS its brief, and ${briefPath} is not a plan this driver can run: ${parsed.defect}`, DIRECTED_BRIEF_INVALID)
  return { lane: name, variant: resolved, checked: true, gate_cmd: parsed.gate_cmd, files_in_scope: parsed.files_in_scope }
}

export function seatRolesUnseated({ seats, tier, deps } = {}) {
  const d = normalDeps(deps)
  let roster
  try {
    roster = JSON.parse(d.readFileSync(ROSTER_PATH, 'utf8'))
  } catch (err) {
    refuse(`cannot read or parse ratified roster ${ROSTER_PATH}: ${err?.message || String(err)}`, SEAT_FLOOR_CONFLICT)
  }
  if (!plainObject(roster) || !plainObject(roster.tiers) || !plainObject(roster.tiers[tier])) {
    refuse(`cannot read ratified roster ${ROSTER_PATH}: missing tiers.${tier}`, SEAT_FLOOR_CONFLICT)
  }
  const tierRoster = roster.tiers[tier]
  return [...seatMaps(seats).keys()].filter((role) => !Object.hasOwn(tierRoster, role) || tierRoster[role] == null)
}

// Boot's reasons are a closed enum it renders as `[reason]` (crew/crew.mjs:778);
// this reads that tag rather than the prose around it — the same posture
// readsFromRefusal takes with the compiler.
export function seatFloorRefusal(text) {
  return BAND_FLOOR_REASONS.find((reason) => String(text ?? '').includes(`[${reason}]`)) || null
}

export function planWorktrees({ lanes, parentDir, checkout, deps } = {}) {
  const d = normalDeps(deps)
  const parent = typeof parentDir === 'string' && parentDir.trim() ? parentDir : dirname(resolve(checkout || process.cwd()))
  const root = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  const plans = []
  for (const lane of Array.isArray(lanes) ? lanes : []) {
    const name = laneNameOf(lane)
    const dir = join(parent, 'dt-' + name)
    const branch = name
    let exists
    try { exists = d.existsSync(dir) } catch (err) {
      refuse(`cannot check worktree path ${dir}: ${err?.message || String(err)}`, WORKTREE_EXISTS)
    }
    if (exists) refuse(`worktree already exists: ${dir}`, WORKTREE_EXISTS)
    let branchProbe
    try {
      branchProbe = d.spawn({
        file: 'git',
        args: ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + name],
        cwd: root,
      })
    } catch (err) {
      refuse(`cannot verify branch ${name}: ${err?.message || String(err)}`, BRANCH_TAKEN)
    }
    if (!branchProbe || branchProbe.status === 0) {
      refuse(`branch is already taken or could not be verified as free: ${name}`, BRANCH_TAKEN)
    }
    plans.push({ lane: name, dir, branch })
  }
  return plans
}

export function createWorktrees({ plans, checkout, deps } = {}) {
  const d = normalDeps(deps)
  const root = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  for (const plan of Array.isArray(plans) ? plans : []) {
    let result
    try {
      result = d.spawn({
        file: 'git',
        args: ['-C', root, 'worktree', 'add', '-b', plan.branch, plan.dir, DISPATCH_BASE_REF],
        cwd: root,
      })
    } catch (err) {
      refuse(`worktree creation failed for ${plan.lane}: ${err?.message || String(err)}`, WORKTREE_FAILED)
    }
    if (!result || result.status !== 0) {
      refuse(`worktree creation failed for ${plan.lane}: ${JSON.stringify(childFailure(result))}`, WORKTREE_FAILED)
    }
  }
  return plans
}

export function readsFromRefusal(stderr) {
  const text = textOf(stderr)
  const unfencedPrefix = 'coupled source(s) outside lane fence: '
  const stalePrefix = 'stale read acknowledgement(s): '
  const unfencedAt = text.indexOf(unfencedPrefix)
  const staleAt = text.indexOf(stalePrefix)
  if (unfencedAt < 0 && staleAt < 0) return { reason: null, files: [] }

  const parse = (prefix, at, separator, stripKey) => {
    let details = text.slice(at + prefix.length)
    const end = details.indexOf(' [reason:')
    if (end >= 0) details = details.slice(0, end)
    const files = details.split(separator).map((part) => {
      const value = stripKey ? part.split('·')[0] : part
      return value.trim()
    }).filter(Boolean)
    return [...new Set(files)].sort()
  }
  if (unfencedAt >= 0 && (staleAt < 0 || unfencedAt < staleAt)) {
    return { reason: COUPLED_SOURCE_UNFENCED, files: parse(unfencedPrefix, unfencedAt, ';', true) }
  }
  return { reason: STALE_READ_ACK, files: parse(stalePrefix, staleAt, ',', false) }
}

// `gatherFences` refuses unknown entry keys, including `external`, so strip the marker
// before compile and boot (`scripts/factory/make-brief.mjs:935`). The entry stays inside
// `lanes` because `laneFenceFor` hands every non-own register entry to each lane
// (`scripts/factory/make-brief.mjs:1060`).
export function readRegister({ fencesPath, checkout, outDir, deps } = {}) {
  const d = normalDeps(deps)
  const authored = resolve(fencesPath)
  let raw
  try { raw = JSON.parse(d.readFileSync(authored, 'utf8')) } catch (err) {
    refuse(`cannot read or parse fences ${authored}: ${err?.message || String(err)}`, BATCH_UNREADABLE)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.lanes)) {
    refuse(`fence register ${authored} must be an object carrying a lanes array`, BATCH_UNREADABLE)
  }
  const externals = []
  const lanes = raw.lanes.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      refuse(`fence register ${authored} lanes[${index}] must be an object`, BATCH_UNREADABLE)
    }
    if (!Object.hasOwn(entry, 'external')) return entry
    if (entry.external !== true) {
      refuse(`fence register ${authored} lanes[${index}] external must be true or absent, found ${JSON.stringify(entry.external)}`, BATCH_UNREADABLE)
    }
    if (typeof entry.lane !== 'string' || entry.lane.trim() === '') {
      refuse(`fence register ${authored} lanes[${index}] marks an external entry with no lane name`, BATCH_UNREADABLE)
    }
    if (externals.includes(entry.lane)) refuse(`fence register ${authored} names external lane ${entry.lane} twice`, BATCH_UNREADABLE)
    externals.push(entry.lane)
    const copy = { ...entry }
    delete copy.external
    return copy
  })
  if (externals.length === 0) {
    return { fences: gatherFences({ fencesPath: authored, checkout }), externals: [], registerPath: authored, sanitised: false }
  }
  const target = join(resolve(outDir), EXTERNAL_REGISTER_NAME)
  try {
    mkdirSync(resolve(outDir), { recursive: true })
    writeFileSync(target, JSON.stringify({ ...raw, lanes }, null, 2) + '\n')
  } catch (err) {
    refuse(`cannot write the external-stripped fence register ${target}: ${err?.message || String(err)}`, BATCH_UNREADABLE)
  }
  return { fences: gatherFences({ fencesPath: target, checkout }), externals: [...externals].sort(), registerPath: target, sanitised: true }
}

function registerData({ fences, registerPath, d }) {
  const entries = fenceEntriesOf(fences)
  if (entries.length > 0) {
    return { lanes: entries.map((entry) => ({
      lane: entry.lane,
      files: [...(entry.files || [])],
      ...(Array.isArray(entry.reads) ? { reads: entry.reads.map((read) => ({ ...read })) } : {}),
    })) }
  }
  try { return JSON.parse(d.readFileSync(resolve(registerPath), 'utf8')) } catch (err) {
    refuse(`cannot read compile fence register ${registerPath}: ${err?.message || String(err)}`, COMPILE_REFUSED)
  }
}

function writeUpdatedRegister({ data, lane, reads, outDir, d }) {
  const copy = JSON.parse(JSON.stringify(data))
  if (!Array.isArray(copy?.lanes)) refuse(`compile fence register has no lanes array for ${lane}`, READS_UNRESOLVED)
  const entry = copy.lanes.find((candidate) => candidate && candidate.lane === lane)
  if (!entry) refuse(`compile fence register has no lane ${lane}`, READS_UNRESOLVED)
  const current = Array.isArray(entry.reads) ? entry.reads.filter((read) => read && typeof read.file === 'string') : []
  const byFile = new Map(current.map((read) => [normaliseRepoPath(read.file), { ...read, file: normaliseRepoPath(read.file) }]))
  for (const read of reads) byFile.set(read.file, { file: read.file, why: read.why })
  entry.reads = [...byFile.values()].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
  const path = join(outDir, `${lane}.fences.json`)
  try { writeFileSync(path, JSON.stringify(copy, null, 2) + '\n') } catch (err) {
    refuse(`cannot write compiler retry fence register ${path}: ${err?.message || String(err)}`, READS_UNRESOLVED)
  }
  return path
}

// The compiler proposes a tier on ONE line and renders the proposal block from
// the other two axes: PROPOSAL_KEYS is ['shape', 'strength'] (make-brief.mjs:148)
// and the block never carries a tier at all. Shape is the RISK axis and shares
// the mechanical|build|judge vocabulary with tier, so reading it through
// TIER_NAMES passed the membership guard on the wrong axis and seated every
// lane at its shape. The line anchor keeps a phrase quoted mid-sentence in the
// ask from outranking the compiler's own line.
function proposalFromBrief(text) {
  const match = /^proposed tier:\s*(mechanical|build|judge)\b/im.exec(text)
  return match ? match[1].toLowerCase() : null
}

const INTENT_EVENT = 'lane-intent'

// Reads back what the compiler already decided, exactly as proposalFromBrief
// does. The compiler echoes the authored ask in the title and `## The ask`;
// that framing identifies its own intent section instead of one an ask quotes.
// A brief with no intent section records null — an older brief keeps producing
// the bytes it always did.
function intentFromBrief(text) {
  if (typeof text !== 'string') return null
  const titlePrefix = '# Task: '
  const askHeading = '\n## The ask\n'
  const intentHeading = '\n## Intent\n'
  let framed = false
  let longestEchoedAskLength = -1
  let longestEchoedAskEnd = -1
  if (text.startsWith(titlePrefix)) {
    let heading = text.indexOf(askHeading, titlePrefix.length)
    while (heading >= 0) {
      const ask = text.slice(titlePrefix.length, heading)
      const echoed = heading + askHeading.length
      if (text.startsWith(ask, echoed) && ask.length > longestEchoedAskLength) {
        framed = true
        longestEchoedAskLength = ask.length
        longestEchoedAskEnd = echoed + ask.length
      }
      heading = text.indexOf(askHeading, heading + 1)
    }
    if (framed) {
      if (!text.startsWith(intentHeading, longestEchoedAskEnd)) return null
      const bodyStart = longestEchoedAskEnd + intentHeading.length
      const end = text.indexOf('\n## ', bodyStart)
      const body = text.slice(bodyStart, end < 0 ? text.length : end)
      const value = body.split('\n').find((line) => line.trim() !== '')
      return value ? value.trim() : null
    }
  }
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trim() === '## Intent')
  if (start < 0) return null
  const body = lines.slice(start + 1).find((line) => line.trim() !== '')
  if (body === undefined || body.startsWith('## ')) return null
  return body.trim() || null
}

// Reads what the compiler already decided. The misclassification is a bare line in
// the brief, not part of the block, so it is matched independently: a brief may
// report one with or without a readable block.
export function staffingFromBrief(text) {
  if (typeof text !== 'string' || !text.trim()) return { ...ABSENT_STAFFING }
  const lines = text.split('\n')
  const misclassification = lines.map((line) => line.trim())
    .find((line) => line.startsWith(MISCLASSIFIED_PREFIX)) || null
  const fence = '```' + PROPOSAL_BLOCK
  const blocks = []
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== fence) continue
    const end = lines.findIndex((line, j) => j > i && line.trim() === '```')
    if (end < 0) break
    blocks.push(lines.slice(i + 1, end).join('\n'))
    i = end
  }
  if (blocks.length !== 1) return { ...ABSENT_STAFFING, misclassification }
  let parsed
  try { parsed = JSON.parse(blocks[0]) } catch { return { ...ABSENT_STAFFING, misclassification } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...ABSENT_STAFFING, misclassification }
  }
  const shape = TIER_NAMES.includes(parsed.shape) ? parsed.shape : null
  const strength = LADDER_BANDS.includes(parsed.strength) ? parsed.strength : null
  return { shape, strength, misclassification }
}

export const BASELINE_CACHE_DIRNAME = 'baselines'

// The factory state root, relocatable exactly as the ledger's is
// (scripts/factory/ledger.mjs:3658). One file per commit; a {sha, command} key needs no
// eviction because both halves are immutable facts about that commit.
export function factoryStateRoot(deps) {
  const d = normalDeps(deps)
  return d.env.DEVTEAM_LEDGER_DIR || join(d.home, '.dev-team', 'factory')
}

export function baselineCacheRoot(deps) {
  return join(factoryStateRoot(deps), BASELINE_CACHE_DIRNAME)
}

export function baselineCachePath({ sha, deps } = {}) {
  return join(baselineCacheRoot(deps), `${sha}.json`)
}

// Returns the PATH of a usable record, or null. It never decides reuse: whatever it returns is
// handed to make-brief as --baseline and passes make-brief's own acceptance
// (reuseBaseline, scripts/factory/make-brief.mjs) unchanged.
export function readBaselineCache({ sha, command, deps } = {}) {
  if (typeof sha !== 'string' || !sha.trim()) return null
  const d = normalDeps(deps)
  const path = baselineCachePath({ sha, deps: d })
  let record
  try { record = JSON.parse(textOf(d.readFileSync(path, 'utf8'))) } catch { return null }
  if (!record || typeof record !== 'object') return null
  if (record.sha !== sha) return null
  if (record.command !== command) return null
  return path
}

export function recordBaselineCache({ measured, sha, deps } = {}) {
  const d = normalDeps(deps)
  let record
  try { record = JSON.parse(textOf(d.readFileSync(measured, 'utf8'))) } catch { return null }
  if (!record || record.sha !== sha || typeof record.command !== 'string' || !record.command.trim()) return null
  const path = baselineCachePath({ sha, deps: d })
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(record, null, 2) + '\n')
  } catch (err) {
    d.log(`dispatch-batch: cannot record baseline cache ${path}: ${err?.message || String(err)}`)
    return null
  }
  return path
}

// One `git rev-parse HEAD` per lane, computed ONCE and shared by the baseline measurement and
// the compile scheduler. Returns a Map lane -> sha, or null when any lane's head is unknown.
export function laneHeads({ plans, deps } = {}) {
  const d = normalDeps(deps)
  const heads = new Map()
  for (const plan of Array.isArray(plans) ? plans : []) {
    let result
    try {
      result = d.spawn({
        file: 'git',
        args: ['-C', plan.dir, 'rev-parse', 'HEAD'],
        cwd: plan.dir,
      })
    } catch (err) {
      d.log(`dispatch-batch: cannot measure shared commit for ${plan.lane}: ${err?.message || String(err)}`)
      return null
    }
    const sha = result?.status === 0 ? textOf(result.stdout).trim() : ''
    if (!sha) {
      d.log(`dispatch-batch: cannot measure shared commit for ${plan.lane}; measuring per lane`)
      return null
    }
    heads.set(plan.lane, sha)
  }
  return heads
}

function laneTestCommand({ dir, deps }) {
  const d = normalDeps(deps)
  try {
    const data = JSON.parse(textOf(d.readFileSync(join(dir, 'package.json'), 'utf8')))
    return typeof data?.scripts?.test === 'string' && data.scripts.test.trim() ? data.scripts.test : null
  } catch { return null }
}

// A real worktree is created before this probe. The fallback is only for injected
// seams that report a successful worktree spawn without materialising its path;
// an existing lane worktree with no command remains unknown and cannot claim reuse.
function laneCommandForPlan({ plan, fallbackDir, deps }) {
  const d = normalDeps(deps)
  const command = laneTestCommand({ dir: plan?.dir, deps: d })
  if (command || typeof fallbackDir !== 'string' || !fallbackDir.trim()) return command
  let exists
  try { exists = d.existsSync(plan?.dir) } catch { return null }
  if (exists || d.existsSync === fsExistsSync) return null
  return laneTestCommand({ dir: fallbackDir, deps: d })
}

export function measureBatchBaseline({ plans, outDir, checkout, heads, deps } = {}) {
  const d = normalDeps(deps)
  if (!Array.isArray(plans) || plans.length < 2) return null
  const measuredHeads = heads || laneHeads({ plans, deps: d })
  if (!measuredHeads) return null
  const shas = new Set(measuredHeads.values())
  if (shas.size !== 1) {
    d.log('dispatch-batch: lanes do not share a commit; measuring per lane')
    return null
  }
  if (typeof outDir !== 'string' || !outDir.trim()) return null
  const sha = [...shas][0]
  const command = laneCommandForPlan({ plan: plans[0], fallbackDir: checkout, deps: d })
  const cached = readBaselineCache({ sha, command, deps: d })
  if (cached) {
    d.log(`dispatch-batch: reusing cached baseline sha=${sha} path=${cached}`)
    return cached
  }
  const path = join(outDir, 'batch-baseline.json')
  // Acquire, then LOOK AGAIN (#825). The cache is keyed by sha, so the lane that
  // held this slot before may have recorded the very baseline this one queued to
  // measure: five lanes on one commit become one suite and four reads. The
  // recheck lives INSIDE the slot, because outside it the answer is the one that
  // was already false above.
  return withSuiteSlot({
    owner: `dispatch-batch:${sha}`,
    root: factoryStateRoot(d),
    env: d.env,
    log: (line) => d.log(`dispatch-batch: ${line}`),
    now: d.now,
    sleep: d.sleep,
    slots: d.slots,
  }, () => {
    const queued = readBaselineCache({ sha, command, deps: d })
    if (queued) {
      d.log(`dispatch-batch: reusing cached baseline sha=${sha} path=${queued} (recorded while queued for a suite slot)`)
      return queued
    }
    let result
    try {
      result = d.spawn({
        file: 'node',
        args: ['scripts/factory/make-brief.mjs', '--measure-baseline', path, '--checkout', plans[0].dir],
        cwd: plans[0].dir,
      })
    } catch (err) {
      d.log(`dispatch-batch: batch baseline measurement failed: ${err?.message || String(err)}; measuring per lane`)
      return null
    }
    if (!result || result.status !== 0) {
      d.log(`dispatch-batch: batch baseline measurement failed; measuring per lane`)
      return null
    }
    recordBaselineCache({ measured: path, sha, deps: d })
    d.log(`dispatch-batch: measured shared baseline sha=${sha} path=${path}`)
    return path
  })
}

function compileCommand({ requestPath, lane, laneDir, registerPath, outDir, baselinePath, issueBodyPath, packOmission = null }) {
  const args = [
    'scripts/factory/make-brief.mjs',
    '--request', requestPath,
    '--checkout', laneDir,
    '--fences', registerPath,
    '--lane', lane,
    '--out', join(outDir, `${lane}.brief.md`),
    '--force',
    '--pack', outDir,
  ]
  if (typeof baselinePath === 'string' && baselinePath.trim()) args.push('--baseline', baselinePath)
  if (typeof issueBodyPath === 'string' && issueBodyPath.trim()) args.push('--issue-body', issueBodyPath)
  if (packOmission !== null && packOmission !== undefined) args.push('--pack-omission', packOmission)
  return { file: 'node', args, cwd: laneDir }
}

// Pass one asks the compiler for the reads this lane must acknowledge; the
// compile that follows is the only other pass (#737).
function discoverCommand({ requestPath, lane, laneDir, registerPath }) {
  const args = [
    'scripts/factory/make-brief.mjs',
    '--discover-reads', lane,
    '--request', requestPath,
    '--checkout', laneDir,
    '--fences', registerPath,
  ]
  return { file: 'node', args, cwd: laneDir }
}

// The compiler's --discover-reads payload: a JSON array of {file, why}
// records. The dispatcher transcribes it and never derives coupling itself.
function discoveredReads(stdout, lane) {
  let parsed
  try { parsed = JSON.parse(textOf(stdout)) } catch {
    refuse(`compiler read discovery for lane ${lane} produced no JSON: ${JSON.stringify(textOf(stdout).slice(0, 200))}`, READS_UNRESOLVED)
  }
  if (!Array.isArray(parsed)) refuse(`compiler read discovery for lane ${lane} produced no array`, READS_UNRESOLVED)
  return parsed.map((record, index) => {
    const named = (value) => typeof value === 'string' && value.trim() !== ''
    if (!plainObject(record) || !named(record.file) || !named(record.why)) {
      refuse(`compiler read discovery for lane ${lane} record ${index} is not {file, why}: ${JSON.stringify(record)}`, READS_UNRESOLVED)
    }
    return { file: normaliseRepoPath(record.file), why: record.why }
  })
}

export function briefMeasure(text) {
  if (typeof text !== 'string') text = text == null ? '' : String(text)
  const headings = [...text.matchAll(/^## (.*)$/gm)]
  let top = null
  let largest = -1
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]
    const end = index + 1 < headings.length ? headings[index + 1].index : text.length
    const size = Buffer.byteLength(text.slice(heading.index, end))
    if (size > largest) {
      largest = size
      top = heading[1].replace(/\r$/, '')
    }
  }
  return { bytes: Buffer.byteLength(text), topSection: top }
}

function sectionToken(section) {
  return section == null ? 'none' : String(section).replace(/^## /, '').replaceAll(' ', '_')
}

function emptyIssueBinding() {
  return { issue: null, source: null, declared: null, prose: null, disagreement: false }
}

function issueBindingFromRecord(request) {
  const proseMatch = typeof request?.ask === 'string' ? /#(\d{1,6})\b/.exec(request.ask) : null
  const prose = proseMatch ? Number(proseMatch[1]) : null
  let declared = null
  const doneMeans = typeof request?.done_means === 'string' ? request.done_means : ''
  for (const declaration of doneMeans.matchAll(/details\.closes\s*=\s*\[([^\]]*)\]/g)) {
    const firstInteger = /\d+/.exec(declaration[1])
    if (!firstInteger) continue
    const value = Number(firstInteger[0])
    if (Number.isSafeInteger(value)) {
      declared = value
      break
    }
  }
  const issue = declared ?? prose
  const source = declared !== null ? 'declared' : prose !== null ? 'prose' : null
  return { issue, source, declared, prose, disagreement: declared !== null && prose !== null && declared !== prose }
}

export function issueBindingFrom(requestPath, deps) {
  if (plainObject(requestPath)) return issueBindingFromRecord(requestPath)
  const d = normalDeps(deps)
  let request
  try { request = JSON.parse(textOf(d.readFileSync(requestPath, 'utf8'))) } catch { return emptyIssueBinding() }
  if (!plainObject(request)) return emptyIssueBinding()
  return issueBindingFromRecord(request)
}

export const requestBindingFrom = issueBindingFrom
export const requestIssueBinding = issueBindingFrom

function historicalIssueReport(reason) {
  return {
    totalRequests: null,
    withoutDeclaredClose: null,
    proseWithoutDeclaredClose: null,
    proseCited: null,
    disagreements: null,
    artifactBackedMisbindings: null,
    reason,
  }
}

function historicalArchiveUnreadable() {
  return {
    totalRequests: null,
    withoutDeclaredClose: null,
    proseWithoutDeclaredClose: null,
    proseCited: null,
    disagreements: null,
    artifactBackedMisbindings: null,
    reason: 'archive-unreadable',
  }
}

function notDirectoryError(error) {
  return error?.code === 'ENOTDIR' || /not a directory/i.test(textOf(error?.message || error))
}

function historyEntryName(entry) {
  if (typeof entry === 'string' && entry.trim() !== '') return entry
  if (entry && typeof entry.name === 'string' && entry.name.trim() !== '') return entry.name
  throw new Error('archive entry has no name')
}

function historyEntryDirectory(entry) {
  if (typeof entry === 'string') return null
  if (!entry || typeof entry.isDirectory !== 'function') return null
  const result = entry.isDirectory()
  if (typeof result !== 'boolean') throw new Error('archive entry directory state is unknown')
  return result
}

export function historicalIssueBindings({ home, deps } = {}) {
  const d = normalDeps(deps)
  const archiveRoot = typeof home === 'string' && home.trim() ? home : join(d.home, '.crew')
  const requestPaths = []
  const readEntries = (directory) => {
    const entries = d.readdirSync(directory, { withFileTypes: true })
    if (!Array.isArray(entries)) throw new Error('archive traversal returned no entries')
    return entries
  }
  const visit = (directory) => {
    for (const entry of readEntries(directory)) {
      const name = historyEntryName(entry)
      const isDirectory = historyEntryDirectory(entry)
      const child = join(directory, name)
      if (name.endsWith(REQUEST_SUFFIX)) {
        if (isDirectory === true) throw new Error('request entry is a directory')
        requestPaths.push(child)
        continue
      }
      if (isDirectory === false) continue
      try {
        visit(child)
      } catch (error) {
        if (notDirectoryError(error)) continue
        throw error
      }
    }
  }
  try {
    for (const entry of readEntries(archiveRoot)) {
      const name = historyEntryName(entry)
      if (!name.startsWith('batch-')) continue
      if (historyEntryDirectory(entry) === false) throw new Error('batch entry is not a directory')
      visit(join(archiveRoot, name))
    }
  } catch {
    return historicalArchiveUnreadable()
  }
  if (requestPaths.length === 0) return historicalIssueReport('archive-empty')

  let totalRequests = 0
  let withoutDeclaredClose = 0
  let proseWithoutDeclaredClose = 0
  let proseCited = 0
  let disagreements = 0
  let artifactBackedMisbindings = 0
  try {
    for (const requestPath of requestPaths.sort()) {
      const request = JSON.parse(textOf(d.readFileSync(requestPath, 'utf8')))
      if (!plainObject(request)) throw new Error('archive request is not an object')
      const binding = issueBindingFromRecord(request)
      totalRequests += 1
      if (binding.declared === null) withoutDeclaredClose += 1
      if (binding.prose !== null) proseCited += 1
      if (binding.prose !== null && binding.declared === null) proseWithoutDeclaredClose += 1
      if (binding.disagreement) {
        disagreements += 1
        const lane = basename(requestPath, REQUEST_SUFFIX)
        if (d.existsSync(join(dirname(requestPath), 'out', `${lane}.issue.md`))) artifactBackedMisbindings += 1
      }
    }
  } catch {
    return historicalArchiveUnreadable()
  }
  return { totalRequests, withoutDeclaredClose, proseWithoutDeclaredClose, proseCited, disagreements, artifactBackedMisbindings, reason: null }
}

function issueBodyFor({ requestPath, lane, checkout, outDir, d }) {
  const binding = issueBindingFrom(requestPath, d)
  const unavailable = (reason) => {
    const source = binding.source === null ? '' : ` source=${binding.source}`
    try { d.log(`dispatch-batch: issue-body lane=${lane} issue=${binding.issue ?? 'none'}${source} status=unavailable reason=${reason}`) } catch { /* diagnostics never block a smaller brief */ }
    return null
  }
  const reportDisagreement = () => {
    try { d.log(`dispatch-batch: issue-binding-disagreement lane=${lane} declared=${binding.declared} prose=${binding.prose}`) } catch { /* diagnostics never block a smaller brief */ }
  }
  if (binding.disagreement) reportDisagreement()
  if (binding.issue === null) return unavailable('no-issue-cited')
  let result
  try {
    result = d.spawn({
      file: 'gh',
      args: ['issue', 'view', String(binding.issue), '--json', 'body', '--jq', '.body'],
      cwd: checkout,
    })
  } catch {
    return unavailable('gh-failed')
  }
  if (!result || result.status !== 0) return unavailable('gh-failed')
  const body = textOf(result.stdout)
  if (!body.trim()) return unavailable('gh-empty')
  const path = join(outDir, `${lane}.issue.md`)
  try { d.writeFileSync(path, body) } catch { return unavailable('gh-failed') }
  try { d.log(`dispatch-batch: issue-body lane=${lane} issue=${binding.issue} source=${binding.source} status=available bytes=${Buffer.byteLength(body)}`) } catch { /* diagnostics never block a smaller brief */ }
  return path
}

export async function compileLane({ lane, batchDir, requestPath, laneDir, registerPath, outDir, fences, baselinePath, packOmission = null, deps } = {}) {
  const d = normalDeps(deps)
  const name = laneNameOf(lane)
  const requestDir = resolve(batchDir)
  const checkout = typeof laneDir === 'string' && laneDir.trim() ? laneDir : process.cwd()
  const outputDir = typeof outDir === 'string' && outDir.trim() ? outDir : join(requestDir, 'out')
  const authoredRegister = registerPath || join(outputDir, 'dispatch.fences.json')
  const compileRequest = typeof requestPath === 'string' && requestPath.trim()
    ? requestPath
    : join(requestDir, `${name}${REQUEST_SUFFIX}`)
  try { mkdirSync(outputDir, { recursive: true }) } catch (err) {
    refuse(`cannot create compiler output directory ${outputDir}: ${err?.message || String(err)}`, COMPILE_REFUSED)
  }
  if (!registerPath) {
    const data = registerData({ fences, registerPath: authoredRegister, d })
    try { writeFileSync(authoredRegister, JSON.stringify(data, null, 2) + '\n') } catch (err) {
      refuse(`cannot write compiler fence register ${authoredRegister}: ${err?.message || String(err)}`, COMPILE_REFUSED)
    }
  }

  let discovered
  try { discovered = await d.spawnAsync(discoverCommand({ lane: name, requestPath: compileRequest, laneDir: checkout, registerPath: authoredRegister })) } catch (err) {
    refuse(`compiler could not start read discovery for ${name}: ${err?.message || String(err)}`, COMPILE_REFUSED)
  }
  if (!discovered || discovered.status !== 0) {
    refuse(`compiler could not discover reads for lane ${name}: ${JSON.stringify(childFailure(discovered))}`, READS_UNRESOLVED)
  }
  const reads = discoveredReads(discovered.stdout, name)
  let currentRegister = authoredRegister
  if (reads.length > 0) {
    const data = registerData({ fences, registerPath: authoredRegister, d })
    currentRegister = writeUpdatedRegister({ data, lane: name, reads, outDir: outputDir, d })
  }
  const issueBodyPath = issueBodyFor({ requestPath: compileRequest, lane: name, checkout, outDir: outputDir, d })
  let result
  try { result = await d.spawnAsync(compileCommand({ lane: name, requestPath: compileRequest, laneDir: checkout, registerPath: currentRegister, outDir: outputDir, baselinePath, issueBodyPath, packOmission })) } catch (err) {
    refuse(`compiler could not start for ${name}: ${err?.message || String(err)}`, COMPILE_REFUSED)
  }
  if (!result || result.status !== 0) {
    const stderr = childFailure(result)
    const parsed = readsFromRefusal(stderr)
    // Discovery has already run: a compiler that STILL names reads is naming
    // ones this lane cannot resolve, never a retry (#737).
    const detail = parsed.reason ? `still refuses ${parsed.reason} after read discovery` : 'refused after read discovery'
    refuse(`compiler ${detail} for lane ${name}: ${JSON.stringify(stderr)}`, READS_UNRESOLVED)
  }
  const briefPath = join(outputDir, `${name}.brief.md`)
  let brief
  try { brief = textOf(d.readFileSync(briefPath, 'utf8')) } catch (err) {
    refuse(`compiler produced no readable brief for ${name}: ${err?.message || String(err)}`, COMPILE_REFUSED)
  }
  const measured = briefMeasure(brief)
  return { lane: name, brief: briefPath, registerPath: currentRegister, proposed: proposalFromBrief(brief), staffing: staffingFromBrief(brief), intent: intentFromBrief(brief), bytes: measured.bytes, topSection: measured.topSection }
}

export function tierFloor({ files, extra } = {}) {
  const paths = resolveProtectedPaths(extra)
  const hits = protectedHitsIn(files, paths)
  const forced = hits.length > 0 ? 'judge' : null
  return { hits, forced, floor: forced }
}

export function promptSurfaceVerdict({ files } = {}) {
  const hits = protectedHitsIn(files, PROMPT_SURFACE.paths)
  return { hits, promptChange: hits.length > 0, forced: hits.length > 0 ? 'judge' : null }
}

export function resolveRequestedExecution({ execution, variant } = {}) {
  const executionSupplied = execution !== undefined && execution !== null
  const variantSupplied = variant !== undefined && variant !== null
  if (executionSupplied && (typeof execution !== 'string' || execution.trim() === '' || !VARIANT_NAMES.includes(execution))) {
    refuse(`invalid --execution ${JSON.stringify(execution)}; expected one of ${VARIANT_NAMES.join(', ')}`, BATCH_UNREADABLE)
  }
  if (variantSupplied && (typeof variant !== 'string' || variant.trim() === '' || !VARIANT_NAMES.includes(variant))) {
    refuse(`invalid --variant ${JSON.stringify(variant)}; expected one of ${VARIANT_NAMES.join(', ')}`, BATCH_UNREADABLE)
  }
  // ADR-035 §4: a canonical/alias PAIR refuses, even when the values agree —
  // "no precedence rule to remember and no silent winner". crew/run-configuration.mjs
  // enforces the same rule at boot; this keeps both entry points identical.
  if (executionSupplied && variantSupplied) {
    refuse(`--execution ${JSON.stringify(execution)} was given with the deprecated --variant ${JSON.stringify(variant)}; pass exactly one`, TRANSPORT_CONFLICT)
  }
  return executionSupplied ? execution : variantSupplied ? variant : undefined
}

export function resolveRequestedTier({ tier, assurance } = {}) {
  const tierSupplied = tier !== undefined && tier !== null
  const assuranceSupplied = assurance !== undefined && assurance !== null
  if (tierSupplied && (typeof tier !== 'string' || tier.trim() === '' || !TIER_NAMES.includes(tier))) {
    refuse(`invalid --tier ${JSON.stringify(tier)}; expected one of ${TIER_NAMES.join(', ')}`, BATCH_UNREADABLE)
  }
  if (assuranceSupplied && (typeof assurance !== 'string' || assurance.trim() === '' || !Object.hasOwn(ASSURANCE_ALIAS_OF, assurance))) {
    refuse(`invalid --assurance ${JSON.stringify(assurance)}; expected one of ${Object.keys(ASSURANCE_ALIAS_OF).join(', ')}`, BATCH_UNREADABLE)
  }
  // ADR-035 §4, as above: the PAIR refuses, matching values included.
  if (tierSupplied && assuranceSupplied) {
    refuse(`--assurance ${JSON.stringify(assurance)} was given with the deprecated --tier ${JSON.stringify(tier)}; pass exactly one`, TRANSPORT_CONFLICT)
  }
  if (assuranceSupplied) return ASSURANCE_ALIAS_OF[assurance]
  return tierSupplied ? tier : undefined
}

export function reconcileTier({ lane, forced, proposed, requested, requestedFrom = 'lane', forceReason = TIER_FLOOR_CONFLICT } = {}) {
  if (forced && requestedFrom !== 'batch' && requested && TIER_NAMES.indexOf(requested) < TIER_NAMES.indexOf(forced)) {
    if (forceReason === PROMPT_SURFACE_CONFLICT) {
      refuse(`lane ${lane} requested tier ${requested} below prompt surface floor ${forced}; ${PROMPT_SURFACE_BLIND_SPOT}`, PROMPT_SURFACE_CONFLICT)
    }
    refuse(`lane ${lane} requested tier ${requested} below protected floor ${forced}`, TIER_FLOOR_CONFLICT)
  }
  // #762: an explicit lane tier is the operator's decision. The compiler's
  // proposal advises and never raises it; only the protected floor does.
  const laneChoice = requestedFrom === 'lane' && TIER_NAMES.includes(requested)
  const candidates = laneChoice ? [forced, requested] : [forced, proposed, requested]
  const known = candidates.filter((tier) => TIER_NAMES.includes(tier))
  const tier = known.length === 0
    ? null
    : known.reduce((best, candidate) => TIER_NAMES.indexOf(candidate) > TIER_NAMES.indexOf(best) ? candidate : best)
  const overrodeProposal = laneChoice && TIER_NAMES.includes(proposed) && TIER_NAMES.indexOf(proposed) > TIER_NAMES.indexOf(tier)
  return { lane, tier, forced, proposed, requested, overrodeProposal }
}

// The override is printed, not merely recorded: an operator reading the dispatch
// line must see that the lane's own tier beat a higher proposal (#762).
function overrideNote(result) {
  return result.overrodeProposal ? ` overrode proposal ${result.proposed} with lane tier ${result.tier}` : ''
}

export function checkArrival({ crew, lane, batchTotal, externals } = {}) {
  const state = crew && typeof crew === 'object' ? crew : {}
  if (state.lane_name !== lane) {
    refuse(`crew lane_name is ${JSON.stringify(state.lane_name)}, expected ${lane}`, FENCE_NOT_ARRIVED)
  }
  if (!Array.isArray(state.lane_fence)) {
    refuse(`crew lane_fence is missing or not an array for ${lane}`, FENCE_NOT_ARRIVED)
  }
  const externalNames = new Set((Array.isArray(externals) ? externals : []).filter((name) => typeof name === 'string' && name.trim() !== ''))
  const fence = state.lane_fence
  const members = fence.filter((entry) => !externalNames.has(entry?.lane))
  if (members.length !== batchTotal - 1) {
    refuse(`crew lane_fence for ${lane} names ${members.length} batch sibling(s) besides ${externalNames.size} external fence(s), expected ${batchTotal - 1}`, FENCE_COUNT_MISMATCH)
  }
  const missing = [...externalNames].filter((name) => !fence.some((entry) => entry?.lane === name))
  if (missing.length > 0) {
    refuse(`crew lane_fence for ${lane} does not carry external fence(s): ${missing.join(', ')}`, FENCE_NOT_ARRIVED)
  }
  return { lane, siblings: members, externals: fence.filter((entry) => externalNames.has(entry?.lane)) }
}

export function crewJsonPath({ checkout, lane, deps } = {}) {
  const d = normalDeps(deps)
  return join(d.home, '.crew', slug(basename(checkout)), slug(lane), 'crew.json')
}

function outcomeFromPath(path, d) {
  let exists
  try { exists = d.existsSync(path) } catch {
    return { found: true, outcome: { status: null, commit: null, path } }
  }
  if (!exists) return { found: false, outcome: null }
  try {
    const envelope = JSON.parse(d.readFileSync(path, 'utf8'))
    return {
      found: true,
      outcome: {
        status: typeof envelope?.status === 'string' ? envelope.status : null,
        commit: typeof envelope?.details?.commit === 'string' ? envelope.details.commit : null,
        path,
      },
    }
  } catch {
    return { found: true, outcome: { status: null, commit: null, path } }
  }
}

export function laneOutcome({ lane, laneDir, deps } = {}) {
  const d = normalDeps(deps)
  const crewDir = dirname(crewJsonPath({ checkout: laneDir, lane, deps: d }))
  const livePath = join(crewDir, 'returns', 'task.json')
  const live = outcomeFromPath(livePath, d)
  if (live.found) return live.outcome

  const parent = dirname(crewDir)
  const base = `${basename(crewDir)}.archive-`
  let names
  try { names = d.readdirSync(parent) } catch {
    return { status: null, commit: null, path: null }
  }
  if (!Array.isArray(names)) return { status: null, commit: null, path: null }
  const archives = names
    .map((name) => typeof name === 'string' ? name : name?.name)
    .filter((name) => typeof name === 'string' && name.startsWith(base))
    .sort()
    .reverse()
  for (const archive of archives) {
    const path = join(parent, archive, 'returns', 'task.json')
    const result = outcomeFromPath(path, d)
    if (result.found) return result.outcome
  }
  return { status: null, commit: null, path: null }
}

export function baseContains({ commit, base, checkout, deps } = {}) {
  if (typeof commit !== 'string' || commit.trim() === ''
      || typeof base !== 'string' || base.trim() === '') return false
  const d = normalDeps(deps)
  const root = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  let probe
  try {
    probe = d.spawn({
      file: 'git',
      args: ['-C', root, 'merge-base', '--is-ancestor', commit, base],
      cwd: root,
    })
  } catch {
    return false
  }
  return probe?.status === 0
}

// The transport is a CALLER's choice with headless as the default, so both
// flags at once is a NAMED refusal: a silent precedence is how a whole session
// went by without anyone noticing which transport had booted (#617).
export function resolveTransport({ runFlags = {} } = {}) {
  const panes = runFlags[PANE_TRANSPORT] === true || runFlags[PANE_TRANSPORT] === 'true'
  const headless = runFlags[BOOT_TRANSPORT] === true || runFlags[BOOT_TRANSPORT] === 'true'
  if (panes && headless) {
    refuse(`--${PANE_TRANSPORT} and --${BOOT_TRANSPORT} name different transports; pass exactly one`, TRANSPORT_CONFLICT)
  }
  return panes ? PANE_TRANSPORT : BOOT_TRANSPORT
}

function seatMaps(value) {
  const maps = new Map()
  if (!plainObject(value)) return maps
  for (const role of Object.keys(value).sort()) {
    const fields = value[role]
    if (!plainObject(fields)) continue
    const fieldMap = new Map()
    for (const field of Object.keys(SEAT_FIELDS)) {
      if (Object.hasOwn(fields, field) && typeof fields[field] === 'string' && fields[field].length > 0) {
        fieldMap.set(field, fields[field])
      }
    }
    if (fieldMap.size > 0) maps.set(role, fieldMap)
  }
  return maps
}

function seatsObject(maps) {
  return Object.fromEntries([...maps.entries()].map(([role, fields]) => [role, Object.fromEntries(fields)]))
}

export function batchSeatsFrom(runFlags = {}) {
  const maps = new Map()
  if (!runFlags || typeof runFlags !== 'object') return {}
  for (const [flag, value] of Object.entries(runFlags)) {
    const match = Object.entries(SEAT_FIELDS).find(([, prefix]) => flag.startsWith(prefix) && flag.length > prefix.length)
    if (!match || typeof value !== 'string' || value.length === 0) continue
    const [field, prefix] = match
    const role = flag.slice(prefix.length)
    if (!maps.has(role)) maps.set(role, new Map())
    maps.get(role).set(field, value)
  }
  const ordered = new Map([...maps.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  return seatsObject(ordered)
}

export function mergeSeats(batch, lane) {
  const merged = new Map()
  for (const source of [batch, lane]) {
    for (const [role, fields] of seatMaps(source)) {
      if (!merged.has(role)) merged.set(role, new Map())
      const target = merged.get(role)
      for (const [field, value] of fields) target.set(field, value)
    }
  }
  const ordered = new Map([...merged.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  return seatsObject(ordered)
}

export function seatChain(batch, lane) {
  const batchMap = seatMaps(batch)
  const laneMap = seatMaps(lane)
  const roles = [...new Set([...batchMap.keys(), ...laneMap.keys()])].sort()
  const chain = new Map()
  for (const role of roles) {
    const batchFields = batchMap.get(role) || new Map()
    const laneFields = laneMap.get(role) || new Map()
    const fields = new Map()
    for (const field of Object.keys(SEAT_FIELDS)) {
      if (!batchFields.has(field) && !laneFields.has(field)) continue
      const fromLane = laneFields.has(field)
      fields.set(field, {
        batch: batchFields.get(field) ?? null,
        lane: laneFields.get(field) ?? null,
        settled: fromLane ? laneFields.get(field) : batchFields.get(field),
        from: fromLane ? 'lane' : 'batch',
      })
    }
    if (fields.size > 0) chain.set(role, fields)
  }
  return seatsObject(chain)
}

function seatEntries(seats, fields = Object.keys(SEAT_FIELDS)) {
  const maps = seatMaps(seats)
  const entries = []
  for (const [role, values] of maps) {
    for (const field of fields) {
      if (values.has(field)) entries.push({ role, field, value: values.get(field) })
    }
  }
  return entries
}

export function seatFlagArgs(seats) {
  return seatEntries(seats, Object.keys(SEAT_FIELDS).filter((field) => field !== 'allow_shortfall'))
    .flatMap(({ role, field, value }) => [`--${SEAT_FIELDS[field]}${role}`, value])
}

export function shortfallFlagArgs(seats) {
  return seatEntries(seats, ['allow_shortfall'])
    .flatMap(({ role, field, value }) => [`--${SEAT_FIELDS[field]}${role}`, value])
}

export function seatSpec(seats) {
  const entries = seatEntries(seats)
  return entries.length > 0 ? entries.map(({ role, field, value }) => `${role}.${field}=${value}`).join(',') : 'none'
}

export function seatFromSpec(batch, lane) {
  const chain = seatChain(batch, lane)
  const entries = []
  for (const role of Object.keys(chain).sort()) {
    for (const field of Object.keys(SEAT_FIELDS)) {
      const cell = chain[role]?.[field]
      if (cell) entries.push(`${role}.${field}=${cell.from}`)
    }
  }
  return entries.length > 0 ? entries.join(',') : 'none'
}

// `--adopt <lane>=<archive-dir>` and a request's `adopt` key name the SAME thing: the
// crew dir a previous attempt left behind. The files live under its task subdirectory,
// so an operator who names the task dir itself is taken at their word.
export function adoptSourceDir(archive) {
  return basename(archive) === 'task' ? archive : join(archive, 'task')
}

// #997. A quoted absolute path in a gate is USUALLY DATA -- a fixture constant, an
// escalation message quoted verbatim, a /tmp scratch dir, /usr/bin/gh. Refusing on any
// such literal was measured at 10/214 precision over the 301 archived gates: bare '/'
// hit 58 times and the comment '// gate\n' hit 214, because both begin with a slash.
// What makes an absolute path the DEFECT is that the gate RESOLVES THE REPOSITORY
// through it, so only an import specifier or a repo-root assignment is inspected.
//
// Location is not the test either. A gate pinned to its OWN checkout is equally
// vacuous, because scripts/factory/prove-mutations.mjs runs the gate in a fresh
// temporary worktree -- a pinned gate then measures a tree the mutation was never
// applied to and cannot kill a single check. So any absolute repo resolution refuses,
// its own or a predecessor's, and the adopting checkout is irrelevant.
const GATE_REPO_RESOLUTIONS = Object.freeze([
  { pattern: /\b(?:import|export)\b[^\n;]*?\bfrom\s*(['"`])([^'"`]*)\1/g, scratchExempt: false },
  { pattern: /\bimport\s*(['"`])([^'"`]*)\1/g, scratchExempt: false },
  { pattern: /\bimport\s*\(\s*(['"`])([^'"`]*)\1/g, scratchExempt: false },
  { pattern: /\b(?:const|let|var)\s+\w*(?:REPO|ROOT|CHECKOUT)\w*\s*=\s*(['"`])([^'"`]*)\1/g, scratchExempt: true },
])

function absoluteGatePathLines(text) {
  const lines = textOf(text).split('\n')
  const tempRoots = [resolve(tmpdir())]
  try { tempRoots.push(realpathSync(tmpdir())) } catch { /* best effort */ }
  tempRoots.push('/tmp')
  const underTemp = (candidate) => tempRoots.some((root) => {
    const target = resolve(candidate)
    return target === root || target.startsWith(root + sep)
  })
  const hits = []
  lines.forEach((line, index) => {
    GATE_REPO_RESOLUTIONS.forEach(({ pattern, scratchExempt }) => {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(line)) !== null) {
        const candidate = match[2]
        if (!candidate || !isAbsolute(candidate)) continue
        // A gate that mints its OWN scratch repository under the system temp dir and
        // names it CHECKOUT is building a fixture, not pinning the repository under
        // test. Four of the eight archives this check first flagged were exactly that
        // (b352/b354/b359-slotdriver, b430-validlane: const CHECKOUT = '/tmp/bNNN-gate-repo').
        // An IMPORT specifier is never exempt: importing from temp is still a repo
        // resolution the mutation worktree cannot follow.
        if (scratchExempt && underTemp(candidate)) continue
        if (hits.some((hit) => hit.line === index + 1 && hit.path === candidate)) continue
        hits.push({ line: index + 1, path: candidate })
      }
    })
  })
  return hits
}

export function parseAdoptSpec(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const at = text.indexOf('=')
  if (at <= 0 || at === text.length - 1) {
    refuse(`--adopt must be <lane>=<archive-dir> and received ${JSON.stringify(value)}`, PLAN_ADOPT_UNREADABLE)
  }
  return { lane: text.slice(0, at).trim(), archive: resolve(text.slice(at + 1).trim()) }
}

export function carriedLineage(row) {
  const carriedBaseline = row?.lineage_baseline_bytes
  if (Number.isInteger(carriedBaseline) && carriedBaseline > 0) return { baseline_bytes: carriedBaseline, source: 'carried', reason: null }
  return { baseline_bytes: null, source: null, reason: LINEAGE_BASELINE_REASONS.includes(row?.lineage_reason) ? row.lineage_reason : 'lineage-round1-absent' }
}

export function lineageBaseline({ source, combined_bytes, deps } = {}) {
  const d = normalDeps(deps)
  const journalPath = typeof source === 'string' && source ? join(dirname(source), 'journal.jsonl') : null
  try {
    if (!d.existsSync(journalPath)) return { baseline_bytes: null, source: null, reason: 'lineage-journal-absent' }
  } catch {
    return { baseline_bytes: null, source: null, reason: 'lineage-journal-unreadable' }
  }
  let text
  try { text = textOf(d.readFileSync(journalPath, 'utf8')) } catch {
    return { baseline_bytes: null, source: null, reason: 'lineage-journal-unreadable' }
  }
  let adoptedRow = null
  let predecessorBytes = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row?.event === ADOPT_EVENT) adoptedRow = row
    if (predecessorBytes === null && row?.plan_growth?.round === 1
      && Number.isInteger(row.plan_growth.combined_bytes) && row.plan_growth.combined_bytes > 0) {
      predecessorBytes = row.plan_growth.combined_bytes
    }
  }
  if (adoptedRow !== null) return carriedLineage(adoptedRow)
  if (predecessorBytes !== null) return { baseline_bytes: predecessorBytes, source: 'predecessor-round1', reason: null }
  return { baseline_bytes: null, source: null, reason: 'lineage-round1-absent' }
}

// Verified BEFORE any worktree is created: a partial adoption is worse than none, so a
// refusal here has copied nothing anywhere. A --adopt for a lane also carrying an
// `adopt` request key wins, and the dispatch line says which route was taken.
export function resolveAdoptions({ lanes, runFlags = {}, checkout = process.cwd(), deps } = {}) {
  const d = normalDeps(deps)
  const batch = Array.isArray(lanes) ? lanes : []
  const names = new Set(batch.map(laneNameOf))
  const asked = new Map()
  for (const lane of batch) {
    const value = lane?.adopt
    if (typeof value === 'string' && value.trim() !== '') {
      asked.set(laneNameOf(lane), { archive: resolve(value.trim()), from: 'request' })
    }
  }
  const flag = runFlags.adopt
  const specs = Array.isArray(flag) ? flag : (flag === undefined || flag === null ? [] : [flag])
  for (const spec of specs) {
    const { lane, archive } = parseAdoptSpec(spec)
    asked.set(lane, { archive, from: 'cli' })
  }
  const adoptions = new Map()
  for (const [lane, { archive, from }] of [...asked].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!names.has(lane)) refuse(`--adopt names a lane that is not in this batch: ${lane}`, PLAN_ADOPT_UNREADABLE)
    const source = adoptSourceDir(archive)
    const missing = ADOPT_REQUIRED.filter((name) => !d.existsSync(join(source, name)))
    if (missing.length > 0) refuse(`lane ${lane} cannot adopt ${archive}: the archive holds no ${missing.join(' and no ')} under ${source}`, PLAN_ADOPT_UNREADABLE)
    const checkPath = join(source, ADOPT_OPTIONAL[0])
    const hasCheck = d.existsSync(checkPath)
    let revise = false
    if (hasCheck) {
      let text = ''
      try { text = textOf(d.readFileSync(checkPath, 'utf8')) } catch (err) {
        refuse(`lane ${lane} cannot adopt ${archive}: ${checkPath} is unreadable: ${err?.message || String(err)}`, PLAN_ADOPT_UNREADABLE)
      }
      revise = text.includes(ADOPT_REVISE_MARKER)
    }
    const planPath = join(source, 'plan.md')
    const gatePath = join(source, 'gate.mjs')
    let planText
    let gateText
    let plan_bytes
    let gate_bytes
    try {
      planText = textOf(d.readFileSync(planPath, 'utf8'))
      gateText = textOf(d.readFileSync(gatePath, 'utf8'))
    } catch (err) {
      refuse(`lane ${lane} cannot measure adoption ${archive}: ${err?.message || String(err)}`, PLAN_ADOPT_UNREADABLE)
    }
    plan_bytes = Buffer.byteLength(planText, 'utf8')
    gate_bytes = Buffer.byteLength(gateText, 'utf8')
    const offending = absoluteGatePathLines(gateText)
    if (offending.length > 0) {
      const lines = offending.map(({ line: number }) => number).join(', ')
      const literals = offending.map(({ path }) => JSON.stringify(path)).join(', ')
      refuse(`lane ${lane} cannot adopt ${archive}: gate.mjs resolves the repository through absolute path(s) on line(s) ${lines} — an import specifier or repo-root assignment must derive from process.cwd(), because prove-mutations runs the gate in a fresh worktree and a pinned gate can kill no mutation; offending literal(s): ${literals}`, PLAN_ADOPT_GATE_ABSOLUTE_PATH)
    }
    const combined_bytes = plan_bytes + gate_bytes
    const lineage = lineageBaseline({ source, combined_bytes, deps: d })
    const lineage_ratio = lineage.baseline_bytes !== null
      ? Math.round((combined_bytes / lineage.baseline_bytes) * 100) / 100 : null
    adoptions.set(lane, {
      lane, archive, source, from, revise, planCheck: hasCheck ? checkPath : null,
      plan_bytes, gate_bytes, combined_bytes,
      lineage_baseline_bytes: lineage.baseline_bytes,
      lineage_baseline_source: lineage.source,
      lineage_ratio,
      lineage_reason: lineage.reason,
    })
  }
  return adoptions
}

export function lineageLine(a) {
  return `lineage_baseline=${a.lineage_baseline_bytes} lineage_source=${a.lineage_baseline_source} combined_bytes=${a.combined_bytes} lineage_ratio=${a.lineage_ratio} lineage_reason=${a.lineage_reason}`
}

// The standing block is a CONSTANT: the same sentence for every adopting lane, plus one
// constant clause when the predecessor was bounced. Nothing lane-specific enters it.
export function adoptionBlock(adoption) {
  return ADOPT_BLOCK + (adoption.revise ? ADOPT_FINDINGS_CLAUSE : '')
}

// Copies, appends the block, records the row — once the lane has booted (so its crew dir
// exists) and before its run starts (so the planner sees the files). Returns null for a
// lane that adopts nothing, so a batch with no adoption produces the bytes it always did.
export function applyAdoption({ adoption, crewDir, briefPath, deps } = {}) {
  const d = normalDeps(deps)
  if (!adoption) return null
  const taskDir = join(crewDir, 'task')
  const texts = new Map()
  let names
  try {
    const missingNow = ADOPT_REQUIRED.filter((name) => !d.existsSync(join(adoption.source, name)))
    if (missingNow.length > 0) {
      refuse(`lane ${adoption.lane} cannot adopt ${adoption.archive}: required file(s) gone at copy time: ${missingNow.join(', ')}`, PLAN_ADOPT_UNREADABLE)
    }
    names = [...ADOPT_REQUIRED, ...ADOPT_OPTIONAL.filter((name) => d.existsSync(join(adoption.source, name)))]
    for (const name of names) {
      const from = join(adoption.source, name)
      const text = textOf(d.readFileSync(from, 'utf8'))
      texts.set(name, text)
    }
  } catch (err) {
    if (err instanceof BatchRefusal) throw err
    refuse(`lane ${adoption.lane} could not read adoption ${adoption.archive} from ${adoption.source}: ${err?.message || String(err)}`, PLAN_ADOPT_UNREADABLE)
  }
  const written = []
  try {
    d.mkdirSync(taskDir, { recursive: true })
    for (const name of names) {
      const target = join(taskDir, name)
      written.push(target)
      d.writeFileSync(target, texts.get(name))
    }
  } catch (err) {
    for (const path of written) {
      try { rmSync(path, { force: true }) } catch { /* rollback is best effort after an interrupted write */ }
    }
    refuse(`lane ${adoption.lane} could not adopt ${adoption.archive} into ${taskDir}: ${err?.message || String(err)}`, PLAN_ADOPT_UNREADABLE)
  }
  const planSha = createHash('sha256').update(texts.get('plan.md')).digest('hex')
  try { d.appendFileSync(briefPath, adoptionBlock(adoption)) } catch (err) {
    refuse(`lane ${adoption.lane} could not carry the adoption block into ${briefPath}: ${err?.message || String(err)}`, PLAN_ADOPT_UNREADABLE)
  }
  const row = {
    at: new Date().toISOString(),
    event: ADOPT_EVENT,
    task: adoption.lane,
    lane: adoption.lane,
    archive: adoption.archive,
    source: adoption.source,
    plan_sha: planSha,
    files: [...texts.keys()],
    findings: adoption.revise,
    adopt_from: adoption.from,
    plan_bytes: adoption.plan_bytes,
    gate_bytes: adoption.gate_bytes,
    combined_bytes: adoption.combined_bytes,
    lineage_baseline_bytes: adoption.lineage_baseline_bytes,
    lineage_baseline_source: adoption.lineage_baseline_source,
    lineage_ratio: adoption.lineage_ratio,
    lineage_reason: adoption.lineage_reason,
  }
  // Instrumentation is never load-bearing: the copy has already happened and the
  // dispatch line already names it, so a journal that cannot be appended never fails a lane.
  try { d.appendFileSync(join(crewDir, 'journal.jsonl'), `${JSON.stringify(row)}\n`) } catch { /* the dispatch line carries the same fact */ }
  return { plan_sha: planSha, files: [...texts.keys()], taskDir }
}

// The lane's purpose reaches the two surfaces a running lane is read through.
// Both writes are instrumentation: a lane never fails for want of a record.
function recordIntent({ intent, crewPath, crewDir, lane, deps } = {}) {
  const d = normalDeps(deps)
  if (typeof intent !== 'string' || !intent.trim()) return null
  let crew
  try { crew = JSON.parse(textOf(d.readFileSync(crewPath, 'utf8'))) } catch { crew = null }
  if (crew && typeof crew === 'object' && !Array.isArray(crew)) {
    const merged = { ...crew, intent }
    try { d.writeFileSync(crewPath, JSON.stringify(merged, null, 2) + '\n') } catch { /* the log line carries the same fact */ }
  }
  const row = { at: new Date().toISOString(), event: INTENT_EVENT, task: lane, lane, intent }
  try { d.appendFileSync(join(crewDir, 'journal.jsonl'), `${JSON.stringify(row)}\n`) } catch { /* instrumentation is never load-bearing */ }
  return { intent }
}

export function bootCommand({ lane, laneDir, tier, registerPath, transport, seats, runFlags = {} }) {
  const tierArgs = ['--assurance', ASSURANCE_ALIASES[tier]]
  return {
    file: 'node',
    args: [
      'crew/crew.mjs', 'boot',
      '--task', lane,
      '--checkout', laneDir,
      ...tierArgs,
      '--fences', registerPath,
      '--lane', lane,
      // Snapshot, not live-read: boot copies the bytes once, so an edit made after this dispatch cannot change a running lane.
      '--roster', ROSTER_PATH,
      ...seatFlagArgs(seats),
      ...shortfallFlagArgs(seats),
      ...memoryFlagArgs(runFlags),
      ...turnCeilingFlagArgs(runFlags),
      // crew.mjs boot knows no --panes flag (KNOWN_FLAGS.boot, crew/crew.mjs:2232):
      // a pane seat is what boot produces WITHOUT --headless-all, so the pane
      // transport is the ABSENCE of this flag, never a flag of its own.
      ...(transport === BOOT_TRANSPORT ? ['--' + BOOT_TRANSPORT] : []),
    ],
    cwd: laneDir,
  }
}

function teardownCommand({ lane, laneDir }) {
  return {
    file: 'node',
    args: ['crew/crew.mjs', 'teardown', '--task', lane, '--checkout', laneDir],
    cwd: laneDir,
  }
}

// One boot attempt, as a value: a thrown spawn and a non-zero exit are the same
// outcome to the retry, and a ratified floor reason travels with it so a
// deterministic refusal is never retried.
function bootOnce({ item, registerPath, transport, runFlags, deps }) {
  const d = normalDeps(deps)
  let result
  try { result = d.spawn(bootCommand({ lane: item.lane, laneDir: item.plan.dir, tier: item.tier, registerPath, transport, seats: item.seats, runFlags })) } catch (err) {
    return { ok: false, result: null, floorReason: null, why: err?.message || String(err) }
  }
  if (result && result.status === 0) return { ok: true, result, floorReason: null, why: null }
  const failure = childFailure(result)
  return { ok: false, result, floorReason: seatFloorRefusal(failure), why: JSON.stringify(failure) }
}

// What the teardown between two boot attempts PROVED, read from its payload rather
// than its exit status. Anything short of every seat proven dead is unproven.
export function teardownVerdict(result) {
  const exit = Number.isInteger(result?.status) ? result.status : null
  let payload = null
  for (const line of String(result?.stdout ?? '').split('\n')) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    try { payload = JSON.parse(text) } catch { /* a non-payload line is not the teardown's answer */ }
  }
  if (!payload) return { verdict: TEARDOWN_UNPROVEN, exit, seats: null, why: `teardown printed no readable payload: ${childFailure(result)}` }
  const seats = payload.seats ?? null
  if (seats === null) return { verdict: TEARDOWN_UNPROVEN, exit, seats: null, why: TEARDOWN_SEATS_NULL_WHY }
  if (exit !== 0) return { verdict: TEARDOWN_UNPROVEN, exit, seats, why: `teardown exited ${exit}: ${JSON.stringify(seats)}` }
  if (seats.proven !== seats.seats) return { verdict: TEARDOWN_UNPROVEN, exit, seats, why: `teardown proved ${seats.proven} of ${seats.seats} seat(s) dead: ${JSON.stringify(seats)}` }
  return { verdict: TEARDOWN_PROVEN, exit, seats, why: null }
}

// A failed boot may have left seats alive (#574), so the retry tears the lane down
// before it re-boots and never stacks a second crew on a half-booted first one.
function teardownBetweenAttempts({ item, deps }) {
  const d = normalDeps(deps)
  let result
  try { result = d.spawn(teardownCommand({ lane: item.lane, laneDir: item.plan.dir })) } catch (err) {
    return { verdict: TEARDOWN_UNPROVEN, exit: null, seats: null, why: `teardown did not run: ${err?.message || String(err)}` }
  }
  return teardownVerdict(result)
}

// The row a recovered boot leaves behind. The FIRST failure is the fact nothing else
// on disk records: the retry succeeded, so the lane looks clean everywhere else.
export function bootRetryRow({ lane, first, teardown, at = new Date().toISOString() } = {}) {
  return {
    at,
    event: BOOT_RETRY_EVENT,
    task: lane,
    lane,
    attempts: BOOT_ATTEMPTS,
    first_failure: first,
    teardown: {
      verdict: teardown?.verdict ?? TEARDOWN_UNPROVEN,
      exit: teardown?.exit ?? null,
      why: teardown?.why ?? null,
    },
  }
}

function preflightRunOptions({ execution, runFlags = {}, lanes = [] } = {}) {
  // Both execution checks are PER LANE now: --execution stays the batch default and a lane's own
  // request key wins, so a scout rides in a batch of full lanes (#634). The closed name set
  // and the ctx-lane shapes that require --validation-lane move together.
  const selections = [{ lane: null, selected: execution ?? runFlags.execution ?? runFlags.variant }]
  for (const lane of Array.isArray(lanes) ? lanes : []) {
    if (typeof lane?.execution === 'string') selections.push({ lane: laneNameOf(lane), selected: lane.execution })
  }
  const validationLane = runFlags['validation-lane']
  for (const { lane, selected } of selections) {
    const where = lane ? ` for lane ${lane}` : ''
    if (selected !== undefined && selected !== null && !VARIANT_NAMES.includes(String(selected))) {
      refuse(`unknown run variant${where}: ${selected}`, RUN_FAILED)
    }
    if (VARIANTS[String(selected ?? 'full')]?.sources?.lane === 'ctx'
        && (typeof validationLane !== 'string' || validationLane.trim() === '')) {
      refuse(`run variant ${selected}${where} requires --validation-lane`, RUN_FAILED)
    }
  }
  const rounds = [
    ['plan-rounds', 10], ['build-rounds', 10], ['review-rounds', 10],
  ]
  for (const [flag, max] of rounds) {
    const raw = runFlags[flag]
    if (raw === undefined || raw === null || raw === '') continue
    const text = String(raw).trim()
    if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > max) {
      refuse(`invalid run option --${flag}: ${raw}`, RUN_FAILED)
    }
  }
  const waits = ['wait-builder', 'wait-planner', 'wait-reviewer', 'wait-lead', 'wait-tech-lead']
  for (const flag of waits) {
    const raw = runFlags[flag]
    if (raw === undefined || raw === null || raw === '') continue
    const text = String(raw).trim()
    if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 21600) {
      refuse(`invalid run option --${flag}: ${raw}`, RUN_FAILED)
    }
  }
}

function runCommand({ lane, laneDir, briefPath, files, execution, keep, runFlags = {} }) {
  const args = ['crew/crew.mjs', 'run', '--task', lane, '--checkout', laneDir, '--brief-file', briefPath]
  if (keep) args.push('--keep')
  const add = (flag, value) => {
    if (value === undefined || value === null || value === '') return
    args.push(`--${flag}`, String(value))
  }
  add('execution', execution)
  add('files-in-scope', files.map((entry) => parseFenceScope(entry).path).join(','))
  add('validation-lane', runFlags['validation-lane'])
  for (const flag of [
    'plan-rounds', 'build-rounds', 'review-rounds', 'wait-builder', 'wait-planner',
    'wait-reviewer', 'wait-lead', 'wait-tech-lead', 'suite',
  ]) add(flag, runFlags[flag])
  return { file: 'node', args, cwd: laneDir }
}

function resumeCommand({ batchDir, fences, checkout, parentDir, outDir, tier, execution, runFlags = {}, wave }) {
  const args = ['node', 'scripts/factory/dispatch-batch.mjs']
  const add = (flag, value) => {
    if (value === undefined || value === null || value === '') return
    args.push(`--${flag}`, String(value))
  }
  add('batch', batchDir)
  add('fences', typeof runFlags.fences === 'string' ? runFlags.fences : fences)
  add('checkout', checkout)
  add('parent', parentDir)
  add('out', outDir)
  add('execution', execution)
  add('assurance', ASSURANCE_ALIASES[tier])
  add('baseline', runFlags.baseline)
  add('planner-symbols-holdout-fraction', runFlags['planner-symbols-holdout-fraction'])
  for (const spec of Array.isArray(runFlags.adopt) ? runFlags.adopt : (runFlags.adopt ? [runFlags.adopt] : [])) add('adopt', spec)
  for (const path of Array.isArray(runFlags[TURN_CENSUS_FLAG]) ? runFlags[TURN_CENSUS_FLAG] : (runFlags[TURN_CENSUS_FLAG] ? [runFlags[TURN_CENSUS_FLAG]] : [])) add(TURN_CENSUS_FLAG, path)
  for (const flag of [
    'plan-rounds', 'build-rounds', 'review-rounds', 'wait-builder', 'wait-planner',
    'wait-reviewer', 'wait-lead', 'wait-tech-lead', 'validation-lane', 'suite',
  ]) add(flag, runFlags[flag])
  for (const flag of TURN_CEILING_FLAGS) add(flag, runFlags[flag])
  for (const flag of BOOT_MEMORY_FLAGS) add(flag, runFlags[flag])
  for (const flag of Object.keys(runFlags).filter((flag) => Object.values(SEAT_FIELDS)
    .some((prefix) => flag.startsWith(prefix) && flag.length > prefix.length)).sort()) {
    add(flag, runFlags[flag])
  }
  for (const flag of ['no-keep', PANE_TRANSPORT, BOOT_TRANSPORT, 'force']) {
    if (runFlags[flag] === true) args.push(`--${flag}`)
  }
  add('wave', wave)
  return args.join(' ')
}

export function batchAliasWarnings({ lanes = [], runFlags = {} } = {}) {
  const batchLanes = Array.isArray(lanes) ? lanes : []
  const variantUsed = runFlags.variant !== undefined && runFlags.variant !== null
    || batchLanes.some((lane) => lane?.variantSupplied === true || lane?.executionFromVariant === true)
  const tierUsed = runFlags.tier !== undefined && runFlags.tier !== null
    || batchLanes.some((lane) => lane?.tierSupplied === true || lane?.assuranceFromTier === true)
  const warnings = []
  if (variantUsed) warnings.push(`warning: --variant is a DEPRECATED alias for --execution, removed at the next tagged release (ADR-035 §4)`)
  if (tierUsed) warnings.push(`warning: --tier is a DEPRECATED alias for --assurance, removed at the next tagged release (ADR-035 §4)`)
  return warnings
}

function rawRunFlagSupplied(runFlags, field) {
  return runFlags !== null && typeof runFlags === 'object'
    && Object.hasOwn(runFlags, field)
    && runFlags[field] !== undefined && runFlags[field] !== null
}

function runFlagSpelling(runFlags, canonicalField, aliasField, canonicalSpelling, aliasSpelling) {
  return rawRunFlagSupplied(runFlags, aliasField) ? aliasSpelling
    : rawRunFlagSupplied(runFlags, canonicalField) ? canonicalSpelling
      : 'dispatcher_default'
}

function prepareDispatchContext(options) {
  let {
    batchDir,
    fences,
    checkout,
    parentDir,
    outDir,
    tier,
    execution,
    variant,
    externals,
    registerPath: registerOverride,
    runFlags = {},
    deps,
  } = options
  const plannerSymbolsHoldoutFraction = parsePlannerSymbolsHoldoutFraction(runFlags['planner-symbols-holdout-fraction'])
  const d = normalDeps(deps)
  const transport = resolveTransport({ runFlags })
  const batchExecutionSpelling = runFlagSpelling(runFlags, 'execution', 'variant', '--execution', '--variant')
  const batchAssuranceSpelling = runFlagSpelling(runFlags, 'assurance', 'tier', '--assurance', '--tier')
  execution = execution ?? runFlags.execution ?? variant ?? runFlags.variant
  if (tier === undefined || tier === null) tier = resolveRequestedTier({ tier: runFlags.tier, assurance: runFlags.assurance })
  const lanes = readBatch({ batchDir, deps: d })
  const { waves, graph } = planWaves({ lanes })
  const root = typeof checkout === 'string' && checkout.trim() ? checkout : process.cwd()
  const parent = typeof parentDir === 'string' && parentDir.trim() ? parentDir : dirname(resolve(root))
  const outputDir = typeof outDir === 'string' && outDir.trim() ? resolve(outDir) : join(resolve(batchDir), 'out')
  const fenceReport = checkFences({ fences, lanes, graph, checkout, externals, parentDir: parent, outDir: outputDir, deps: d })
  const hasAdmissions = fenceReport.admissions.length > 0
  const effectiveFences = hasAdmissions ? fenceReport.fences : fences
  // Preflight BEFORE planWorktrees: planWorktrees probes git for existing
  // branches, so an unsupported --variant reached here after the probe and was
  // reported as `branch-taken` when the real cause was an invalid run option
  // (RV3-1). A refusal must name the cause it measured, not the first one it
  // tripped over. Ordering is the whole fix — both refusals still fire.
  preflightRunOptions({ execution, runFlags, lanes })
  const waitBuilder = runFlags['wait-builder']
  const waitSeconds = Number(waitBuilder === undefined || waitBuilder === null || String(waitBuilder).trim() === '' ? WAITS_S.builder : waitBuilder)
  const census = readTurnCensus(runFlags[TURN_CENSUS_FLAG], d)
  d.log(formatTurnBudgetReport(turnBudgetReport({ waitSeconds, censusRows: census.rows, reason: census.reason })))
  // Before any worktree exists: an archive that does not hold a plan refuses here,
  // having copied nothing.
  const adoptions = resolveAdoptions({ lanes, runFlags, checkout: root, deps: d })

  const waveRaw = runFlags.wave === undefined || runFlags.wave === null ? 1 : runFlags.wave
  const waveText = String(waveRaw).trim()
  const waveNumber = /^\d+$/.test(waveText) ? Number(waveText) : NaN
  if (!Number.isSafeInteger(waveNumber) || waveNumber < 1 || waveNumber > waves.length) {
    refuse(`invalid --wave ${JSON.stringify(waveRaw)}; this batch has ${waves.length} wave(s)`, BATCH_UNREADABLE)
  }
  const dispatchedNames = waves[waveNumber - 1]
  const waveLanes = lanes.filter((lane) => dispatchedNames.includes(lane.lane))
  const laneNames = lanes.map(laneNameOf)
  const waveOf = new Map(waves.flatMap((wave, index) => wave.map((name) => [name, index + 1])))
  const depsOf = (name) => graph.deps.get(name) || []
  const deferred = laneNames.filter((name) => !dispatchedNames.includes(name))
    .map((name) => ({ lane: name, wave: waveOf.get(name), predecessors: depsOf(name) }))
  const keep = runFlags['no-keep'] !== true
  const dryRun = runFlags['dry-run'] === true || runFlags.dryRun === true
  for (const warning of batchAliasWarnings({ lanes, runFlags })) d.log(warning)
  const batchSeats = batchSeatsFrom(runFlags)
  const authoredRegisterPath = typeof registerOverride === 'string' && registerOverride.trim()
    ? resolve(registerOverride)
    : typeof runFlags.fences === 'string' && runFlags.fences.trim()
      ? resolve(runFlags.fences)
      : join(outputDir, 'dispatch.fences.json')
  const registerPath = hasAdmissions ? join(outputDir, 'dispatch.fences.json') : authoredRegisterPath
  if (dryRun && hasAdmissions) {
    const data = registerData({ fences: effectiveFences, registerPath, d })
    try {
      d.mkdirSync(outputDir, { recursive: true })
      d.writeFileSync(registerPath, JSON.stringify(data, null, 2) + '\n')
    } catch (err) {
      refuse(`cannot write effective dispatch fence register ${registerPath}: ${err?.message || String(err)}`, COMPILE_REFUSED)
    }
  }
  const unstarted = []

  const logWaveState = () => {
    if (waves.length > 1) {
      d.log(`dispatch-batch: waves=${waves.length} wave=${waveNumber} lanes=${dispatchedNames.join(',')}`)
      for (const item of deferred) {
        d.log(`dispatch-batch: deferred lane=${item.lane} wave=${item.wave} after=${item.predecessors.join(',')} resume=${resumeCommand({ batchDir, fences: registerPath, checkout: root, parentDir: parent, outDir: outputDir, tier, execution, runFlags, wave: item.wave })}`)
      }
      for (const item of unstarted) {
        d.log(`dispatch-batch: unstarted lane=${item.lane} reason=${item.reason} predecessor=${item.predecessor}`)
      }
    }
  }

  if (waveNumber > 1) {
    const blocked = []
    for (const lane of waveLanes) {
      for (const dep of depsOf(lane.lane)) {
        const outcome = laneOutcome({ lane: dep, laneDir: join(parent, 'dt-' + dep), deps: d })
        if (outcome.status !== 'done') {
          blocked.push({
            lane: lane.lane,
            reason: outcome.status === 'escalation' ? PREDECESSOR_ESCALATED : PREDECESSOR_UNSETTLED,
            predecessor: dep,
          })
          break
        }
        const baseRef = DISPATCH_BASE_REF
        if (!baseContains({ commit: outcome.commit, base: baseRef, checkout: root, deps: d })) refuse(`lane ${lane.lane} depends on ${dep} whose result ${outcome.commit || 'none'} is not contained in the dispatch base ${baseRef}; merge it before dispatching wave ${waveNumber}`, DEPENDENT_BASE_STALE)
      }
    }
    if (blocked.length > 0) {
      const first = blocked[0]
      const byLane = new Map(blocked.map((item) => [item.lane, item]))
      for (const lane of waveLanes) {
        unstarted.push(byLane.get(lane.lane) || {
          lane: lane.lane,
          reason: 'wave-stopped',
          predecessor: first.lane,
        })
      }
      logWaveState()
      return { kind: 'terminal', result: { lanes: [], plans: [], registerPath, outDir: outputDir, keep, transport, waves, wave: waveNumber, deferred, unstarted } }
    }
  }
  if (dryRun) {
    const plans = planWorktrees({ lanes: waveLanes, parentDir, checkout, deps: d })
    const dryData = { dispatch: 'dry-run', plans }
    if (hasAdmissions) dryData.fence_admissions = fenceReport.admissions
    d.log(JSON.stringify(dryData))
    for (const lane of waveLanes) {
      d.log(`dispatch-batch: dry-run lane=${lane.lane} tier=${lane.assurance ?? tier ?? 'none'} seats=${seatSpec(mergeSeats(batchSeats, lane.seats))} seats_from=${seatFromSpec(batchSeats, lane.seats)}`)
    }
    for (const lane of waveLanes) {
      const adoption = adoptions.get(lane.lane)
      if (adoption) d.log(`dispatch-batch: dry-run lane=${lane.lane} adopt=${adoption.archive} source=${adoption.source} findings=${adoption.revise} adopt_from=${adoption.from} ${lineageLine(adoption)}`)
    }
    d.log(DRY_RUN_BLIND_SPOT)
    return { kind: 'terminal', result: { dryRun: true, plans, lanes: waveLanes, fences: fenceReport, ...(hasAdmissions ? { registerPath } : {}), waves, wave: waveNumber, deferred, unstarted } }
  }
  logWaveState()
  const plans = planWorktrees({ lanes: waveLanes, parentDir, checkout, deps: d })

  return {
    kind: 'prepared',
    batchDir,
    fences: effectiveFences,
    checkout,
    parentDir,
    outDir,
    tier,
    execution,
    variant,
    externals,
    registerOverride,
    runFlags,
    deps,
    plannerSymbolsHoldoutFraction,
    batchExecutionSpelling,
    batchAssuranceSpelling,
    d,
    transport,
    lanes,
    waves,
    graph,
    root,
    parent,
    outputDir,
    fenceReport,
    adoptions,
    waveNumber,
    dispatchedNames,
    waveLanes,
    deferred,
    keep,
    dryRun,
    batchSeats,
    registerPath,
    unstarted,
    plans,
  }
}

async function compileDispatchWave(prepared) {
  const {
    batchDir,
    fences,
    execution,
    tier,
    runFlags,
    d,
    lanes,
    waveLanes,
    fenceReport,
    root,
    outputDir,
    registerPath,
    batchSeats,
    plannerSymbolsHoldoutFraction,
    batchExecutionSpelling,
    batchAssuranceSpelling,
    plans,
  } = prepared

  try { mkdirSync(outputDir, { recursive: true }) } catch (err) {
    refuse(`cannot create dispatch output directory ${outputDir}: ${err?.message || String(err)}`, COMPILE_REFUSED)
  }
  if (!runFlags.fences || fenceReport.admissions.length > 0) {
    const data = registerData({ fences, registerPath, d })
    try { writeFileSync(registerPath, JSON.stringify(data, null, 2) + '\n') } catch (err) {
      refuse(`cannot write dispatch fence register ${registerPath}: ${err?.message || String(err)}`, COMPILE_REFUSED)
    }
  }

  createWorktrees({ plans, checkout: root, deps: d })
  const heads = laneHeads({ plans, deps: d })
  const supplied = typeof runFlags.baseline === 'string' && runFlags.baseline.trim() ? resolve(runFlags.baseline) : null
  if (supplied) d.log(`dispatch-batch: operator supplied baseline path=${supplied}`)
  const baselinePath = supplied || measureBatchBaseline({ plans, outDir: outputDir, checkout: root, heads, deps: d })
  // The compiler's request schema is closed, so every lane is compiled from a
  // copy of its request with the dispatch-only keys removed. The copy is named
  // so it can never be mistaken for an authored request, even when --out points
  // at the batch directory itself.
  const compileRequests = new Map()
  for (const lane of waveLanes) {
    const requestPath = join(outputDir, `${lane.lane}${COMPILE_REQUEST_SUFFIX}`)
    try { writeFileSync(requestPath, JSON.stringify(lane.request, null, 2) + '\n') } catch (err) {
      refuse(`cannot write compiler request ${requestPath}: ${err?.message || String(err)}`, COMPILE_REFUSED)
    }
    compileRequests.set(lane.lane, requestPath)
  }

  // SCHEDULING ONLY. make-brief owns baseline acceptance (reuseBaseline,
  // scripts/factory/make-brief.mjs) and still decides reuse for every lane; this predicate never
  // changes what a lane is handed. It answers the one question the scheduler must answer BEFORE it
  // spawns: can this compile run a full suite? A lane handed no baseline, or one recorded for a
  // different commit than its own worktree carries, is at risk, and N of those at once is N suites.
  const atRisk = (plan) => {
    if (!baselinePath) return true
    const head = heads?.get(plan.lane) || null
    if (!head) return true
    let record
    try { record = JSON.parse(textOf(d.readFileSync(baselinePath, 'utf8'))) } catch { return true }
    const command = laneCommandForPlan({ plan, fallbackDir: root, deps: d })
    return !record || typeof record !== 'object' || Array.isArray(record)
      || record.sha !== head
      || !command || record.command !== command
      || !Number.isInteger(record.pass) || record.pass < 0
      || !Number.isInteger(record.fail) || record.fail < 0
  }

  let serial = Promise.resolve()
  const runSerialised = (fn) => {
    const next = serial.then(async () => {
      try { await d.assertQuiet(d.env) } catch (err) {
        refuse(`refusing to measure a lane baseline on a saturated host: ${err?.message || String(err)}`, COMPILE_REFUSED)
      }
      return fn()
    })
    serial = next.then(() => {}, () => {})
    return next
  }

  const plannerSymbolsArms = new Map()
  if (plannerSymbolsHoldoutFraction !== null) {
    for (const lane of waveLanes) {
      plannerSymbolsArms.set(lane.lane, selectPlannerSymbolsArm(plannerSymbolsHoldoutFraction, d.random))
    }
  }

  const startCompile = (plan) => {
    const compile = () => compileLane({
      lane: plan.lane,
      batchDir: resolve(batchDir),
      requestPath: compileRequests.get(plan.lane),
      laneDir: plan.dir,
      registerPath,
      outDir: outputDir,
      fences,
      baselinePath,
      packOmission: plannerSymbolsArms.get(plan.lane) === 'symbols-omitted' ? 'symbols' : null,
      deps: d,
    })
    return atRisk(plan) ? runSerialised(compile) : compile()
  }

  const compiled = []
  const results = await Promise.allSettled(plans.map((plan) => startCompile(plan)))
  for (const settled of results) {
    if (settled.status === 'rejected') throw settled.reason
    compiled.push(settled.value)
  }

  const laneByName = new Map(lanes.map((lane) => [lane.lane, lane]))
  const settled = []
  for (const item of compiled) {
    const staffing = item.staffing || { ...ABSENT_STAFFING }
    const plan = plans.find((candidate) => candidate.lane === item.lane)
    const laneFence = fenceReport.perLane[item.lane]
    const authoredFence = fenceReport.authoredPerLane?.[item.lane]
    const assuranceFiles = authoredFence?.files || laneFence.files
    const floor = tierFloor({ files: assuranceFiles, extra: runFlags.protectedPaths })
    const prompt = promptSurfaceVerdict({ files: assuranceFiles })
    const laneEntry = laneByName.get(item.lane)
    // A lane's own assurance is the requested tier for THAT lane; --assurance stays the
    // batch default for every lane that does not name one. A protected floor
    // raises a lower batch default, while an explicit lane assurance below it refuses.
    const laneExecution = laneEntry?.execution ?? execution
    const requested = laneEntry?.assurance ?? tier
    const laneVariant = laneExecution
    const seats = mergeSeats(batchSeats, laneEntry?.seats)
    const laneAssuranceSupplied = laneEntry?.assurance !== undefined && laneEntry?.assurance !== null
    const laneExecutionSupplied = laneEntry?.execution !== undefined && laneEntry?.execution !== null
    const laneExecutionSpelling = laneExecutionSupplied ? laneEntry.executionSpelling : batchExecutionSpelling
    const laneAssuranceSpelling = laneAssuranceSupplied ? laneEntry.assuranceSpelling : batchAssuranceSpelling
    const result = reconcileTier({ lane: item.lane, forced: floor.forced || prompt.forced, proposed: item.proposed, requested, requestedFrom: laneAssuranceSupplied ? 'lane' : 'batch', forceReason: floor.forced ? TIER_FLOOR_CONFLICT : PROMPT_SURFACE_CONFLICT })
    if (!result.tier) refuse(`lane ${item.lane} has no known tier to boot`, BOOT_FAILED)
    d.log(`dispatch-batch: lane=${item.lane} forced=${floor.forced || 'none'} prompt=${prompt.promptChange ? 'change' : 'code-only'} proposed=${item.proposed || 'none'} requested=${requested || 'none'} requested_from=${laneAssuranceSupplied ? 'lane' : (tier ? 'batch' : 'none')} execution=${laneExecution || 'none'} execution_from=${laneExecutionSupplied ? 'lane' : (execution ? 'batch' : 'none')} variant=${laneVariant || 'none'} variant_from=${laneExecutionSupplied ? 'lane' : (execution ? 'batch' : 'none')} settled=${result.tier} seats=${seatSpec(seats)} seats_from=${seatFromSpec(batchSeats, laneEntry?.seats)} shape=${staffing.shape || STAFFING_ABSENT} strength=${staffing.strength || STAFFING_ABSENT} misclassified=${staffing.misclassification ? 'true' : 'false'} brief_bytes=${item.bytes} top_section=${sectionToken(item.topSection)}${overrideNote(result)} granularity=${fenceGranularity(laneFence.files)}`)
    const recordPath = join(outputDir, `${item.lane}${DISPATCH_RECORD_SUFFIX}`)
    const record = {
      lane: item.lane,
      shape: staffing.shape,
      strength: staffing.strength,
      misclassification: staffing.misclassification,
      prompt_surface: {
        hits: prompt.hits,
        prompt_change: prompt.promptChange,
        forced: prompt.forced,
      },
      tier: {
        forced: floor.forced || null,
        proposed: item.proposed || null,
        requested: requested || null,
        settled: result.tier,
        overrode_proposal: result.overrodeProposal === true,
      },
      seats: seatChain(batchSeats, laneEntry?.seats),
      operator_spelling: {
        execution: { spelling: laneExecutionSpelling, unmeasured_reason: null },
        assurance: { spelling: laneAssuranceSpelling, unmeasured_reason: null },
      },
      execution: laneExecution || null,
      variant: laneVariant || null,
      brief: item.brief,
      ...(plannerSymbolsHoldoutFraction === null ? {} : {
        experiment: {
          name: PLANNER_SYMBOLS_EXPERIMENT,
          arm: plannerSymbolsArms.get(item.lane),
          fraction: plannerSymbolsHoldoutFraction,
        },
      }),
    }
    try { writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n') } catch (err) {
      refuse(`cannot write dispatch record ${recordPath}: ${err?.message || String(err)}`, COMPILE_REFUSED)
    }
    settled.push({ ...item, plan, floor, prompt, tier: result.tier, execution: laneExecution, variant: laneVariant, seats, staffing, record: recordPath })
  }

  // #658: every lane whose plan IS its brief is validated before ANY lane boots — the brief is
  // already on disk, and a defect in lane B's brief must not cost lane A's seats. Last in the
  // pre-boot order on purpose: no existing refusal loses the cause it names.
  for (const item of settled) {
    checkDirectedBrief({ lane: item.lane, variant: item.execution, briefPath: item.brief, deps: d })
    if (Object.keys(item.seats).length > 0) {
      const unseated = seatRolesUnseated({ seats: item.seats, tier: item.tier, deps: d })
      if (unseated.length > 0) refuse(`lane ${item.lane} seat override(s) name role(s) the settled tier ${item.tier} does not seat: ${unseated.join(', ')}; crew/roster.json tiers.${item.tier} is the ratified staffing floor and a lane may not staff outside it`, SEAT_FLOOR_CONFLICT)
    }
  }

  return { ...prepared, plannerSymbolsArms, settled }
}

function launchDispatchWave(compiled) {
  const {
    d,
    runFlags,
    registerPath,
    transport,
    lanes,
    externals,
    fenceReport,
    adoptions,
    keep,
    root,
    plannerSymbolsArms,
    plannerSymbolsHoldoutFraction,
    settled,
    plans,
    outputDir,
    waves,
    waveNumber,
    deferred,
    unstarted,
  } = compiled

  const arrivals = []
  for (const item of settled) {
    let firstFailure = null
    let teardown = null
    for (let attempt = 1; attempt <= BOOT_ATTEMPTS; attempt += 1) {
      const boot = bootOnce({ item, registerPath, transport, runFlags, deps: d })
      if (boot.ok) break
      // A ratified floor refusal is a DECISION, not an accident: the same seats refuse
      // the same way on a retry, so retrying it burns a second dispatch to reach the
      // same answer. #767 ask 1 is a retry around a LOST boot, never around one that
      // was answered.
      if (boot.floorReason) refuse(`crew boot refused ${item.lane} at a ratified floor [${boot.floorReason}]: ${boot.why}`, SEAT_FLOOR_CONFLICT)
      if (attempt >= BOOT_ATTEMPTS) {
        refuse(`crew boot failed for ${item.lane} after ${BOOT_ATTEMPTS} attempts - attempt 1: ${firstFailure ?? boot.why}; attempt ${attempt}: ${boot.why}`, BOOT_FAILED)
      }
      firstFailure = boot.why
      teardown = teardownBetweenAttempts({ item, deps: d })
      d.log(`dispatch-batch: boot-retry lane=${item.lane} attempt=${attempt} first_failure=${firstFailure} teardown=${teardown.verdict} teardown_exit=${teardown.exit ?? 'none'} teardown_why=${JSON.stringify(teardown.why)}`)
    }
    const path = crewJsonPath({ checkout: item.plan.dir, lane: item.lane, deps: d })
    if (firstFailure !== null) {
      const row = bootRetryRow({ lane: item.lane, first: firstFailure, teardown })
      // Instrumentation is never load-bearing: the retry has already happened and the
      // log line above carries the same fact, so a journal that cannot be appended
      // never fails a lane.
      try { d.appendFileSync(join(dirname(path), 'journal.jsonl'), `${JSON.stringify(row)}\n`) } catch { /* the dispatch line carries the same fact */ }
    }
    let crew
    try { crew = JSON.parse(d.readFileSync(path, 'utf8')) } catch (err) {
      refuse(`crew boot produced no readable crew.json for ${item.lane}: ${err?.message || String(err)}`, FENCE_NOT_ARRIVED)
    }
    // A pane boot's proof is what boot RETURNED, not the argv it was given:
    // crew.mjs writes workspace_id null whenever no workspace was created
    // (crew/crew.mjs:1626), and a --panes lane with a null workspace is exactly
    // the silent degradation this flag exists to remove.
    const workspaceId = typeof crew.workspace_id === 'string' && crew.workspace_id.trim() ? crew.workspace_id : null
    if (transport === PANE_TRANSPORT && !workspaceId) {
      refuse(`crew boot under --${PANE_TRANSPORT} produced no workspace for ${item.lane}: crew.json workspace_id is ${JSON.stringify(crew.workspace_id ?? null)}`, BOOT_FAILED)
    }
    const arrival = checkArrival({ crew, lane: item.lane, batchTotal: lanes.length, externals })
    const journal = join(dirname(path), 'journal.jsonl')
    const admissionRows = fenceReport.perLane[item.lane]?.fence_admissions || []
    if (admissionRows.length > 0) {
      let journalExists = false
      try { journalExists = d.existsSync(journal) } catch (err) {
        d.log(`dispatch-batch: ${FENCE_ADMISSION_EVENT} journal probe failed lane=${item.lane}: ${err?.message || String(err)}`)
      }
      if (!journalExists) {
        d.log(`dispatch-batch: ${FENCE_ADMISSION_EVENT} journal unavailable lane=${item.lane} path=${journal}`)
      } else {
        for (const admission of admissionRows) {
          const row = { at: new Date().toISOString(), event: FENCE_ADMISSION_EVENT, lane: item.lane, file: admission.file, source: admission.source }
          try {
            d.appendFileSync(journal, `${JSON.stringify(row)}\n`)
          } catch (err) {
            d.log(`dispatch-batch: ${FENCE_ADMISSION_EVENT} journal append failed lane=${item.lane} file=${admission.file}: ${err?.message || String(err)}`)
          }
        }
      }
    }
    arrivals.push({ ...item, crewPath: path, arrival, workspaceId })
  }

  const runs = []
  for (const item of arrivals) {
    const files = fenceReport.perLane[item.lane].files
    const crewDir = dirname(item.crewPath)
    const journal = join(crewDir, 'journal.jsonl')
    const runLog = join(crewDir, 'run.log')
    const arm = plannerSymbolsArms.get(item.lane)
    const fraction = plannerSymbolsHoldoutFraction
    if (arm !== undefined) {
      const row = { at: new Date().toISOString(), event: PLANNER_SYMBOLS_ARM_EVENT, role: 'planner', experiment: PLANNER_SYMBOLS_EXPERIMENT, arm, fraction }
      try {
        d.appendFileSync(journal, `${JSON.stringify(row)}\n`)
      } catch (err) {
        d.log(`dispatch-batch: experiment arm journal append failed lane=${item.lane}: ${err?.message || String(err)}`)
      }
    }
    const adoption = adoptions.get(item.lane) ?? null
    const applied = applyAdoption({ adoption, crewDir, briefPath: item.brief, deps: d })
    const recorded = recordIntent({ intent: item.intent, crewPath: item.crewPath, crewDir, lane: item.lane, deps: d })
    if (recorded) d.log(`dispatch-batch: intent lane=${item.lane} intent=${JSON.stringify(recorded.intent)}`)
    if (applied) d.log(`dispatch-batch: plan-adopted lane=${item.lane} archive=${adoption.archive} source=${adoption.source} plan_sha=${applied.plan_sha} files=${applied.files.join(',')} findings=${adoption.revise} adopt_from=${adoption.from} ${lineageLine(adoption)}`)
    let run
    try {
      run = d.spawn({
        ...runCommand({
          lane: item.lane,
          laneDir: item.plan.dir,
          briefPath: item.brief,
          files,
          execution: item.execution,
          keep,
          runFlags,
        }),
        background: true,
        logPath: runLog,
      })
    } catch (err) {
      refuse(`crew run failed for ${item.lane}: ${err?.message || String(err)}`, RUN_FAILED)
    }
    if (run && run.status !== undefined && run.status !== 0 && run.status !== 3) {
      refuse(`crew run failed for ${item.lane}: ${JSON.stringify(childFailure(run))}`, RUN_FAILED)
    }
    // b313-waitextend's driver died with no pid anywhere on disk (#749 ask 1).
    // The pid is a DIAGNOSTIC, never the run's liveness: the run log's terminal
    // {"status":…} line stays the signal.
    const pid = run && Number.isInteger(run.pid) ? run.pid : null
    if (pid !== null) {
      try { writeFileSync(join(crewDir, 'run.pid'), `${pid}\n`) } catch { /* a lane never fails for want of a diagnostic */ }
    }
    const watchArgs = ['scripts/factory/crew-watch.mjs', item.lane, '--follow']
    d.log(`dispatch-batch: watch lane=${item.lane} crew_dir=${crewDir} journal=${journal} run_log=${runLog} run pid=${pid ?? 'none'} command=node ${watchArgs.join(' ')}`)
    runs.push({ lane: item.lane, laneDir: item.plan.dir, result: run, crewDir, journal, runLog, watch: { file: 'node', args: watchArgs, cwd: root }, workspaceId: item.workspaceId, staffing: item.staffing, record: item.record })
  }

  // Keeping the workspaces is a CHOICE, so the dispatcher states it and names
  // the command that undoes it. crew.mjs self-tears-down only on a done run
  // without --keep (crew/crew.mjs:1888); an escalated lane is kept either way.
  const workspaces = runs.map((item) => `${item.lane}=${item.workspaceId}`).join(', ')
  d.log(transport === PANE_TRANSPORT
    ? `dispatch-batch: transport=${PANE_TRANSPORT} — every seat booted into a cmux pane, so each lane HAS a workspace to open: ${workspaces}. Headless is the software-factory mode and the default; panes exist for the interval in which a running lane has no other surface`
    : `dispatch-batch: transport=${BOOT_TRANSPORT} — every seat booted headless, so this batch created no cmux workspace and no panes (workspace_id is null); headless is the software-factory mode. Follow a lane by the crew dir and journal above, never by a workspace`)
  d.log(keep
    ? 'dispatch-batch: workspaces keep=true — every lane workspace and crew dir is kept for inspection; pass --no-keep to let a lane that finishes done tear itself down'
    : 'dispatch-batch: workspaces keep=false — a lane that finishes done tears itself down and archives its crew dir; an escalated lane is kept either way')
  for (const item of runs) {
    d.log(`dispatch-batch: teardown lane=${item.lane} command=node crew/crew.mjs teardown --task ${item.lane} --checkout ${item.laneDir}`)
  }
  d.log(mergeCheckLine(runs.map((item) => item.lane)))
  return { lanes: runs, plans, registerPath, outDir: outputDir, keep, transport, waves, wave: waveNumber, deferred, unstarted, fences: fenceReport }
}

export async function dispatchBatch({ batchDir, fences, checkout, parentDir, outDir, tier, execution, variant, externals, registerPath: registerOverride, runFlags = {}, deps } = {}) {
  const prepared = prepareDispatchContext({
    batchDir,
    fences,
    checkout,
    parentDir,
    outDir,
    tier,
    execution,
    variant,
    externals,
    registerPath: registerOverride,
    runFlags,
    deps,
  })
  if (prepared.kind === 'terminal') return prepared.result
  const compiled = await compileDispatchWave(prepared)
  return launchDispatchWave(compiled)
}

export function parseCliArgs(argv) {
  if (!Array.isArray(argv)) refuse('arguments must be an array', BATCH_UNREADABLE)
  const flags = {}
  const positional = []
  const valueFlags = new Set([
    'batch', 'fences', 'checkout', 'parent', 'out', 'tier', 'assurance', 'execution', 'variant', 'wave', 'planner-symbols-holdout-fraction',
    'plan-rounds', 'build-rounds', 'review-rounds', 'wait-builder', 'wait-planner',
    'wait-reviewer', 'wait-lead', 'wait-tech-lead', 'validation-lane', 'suite', 'baseline',
    TURN_CENSUS_FLAG,
    ...TURN_CEILING_FLAGS,
    ...BOOT_MEMORY_FLAGS,
  ])
  const booleanFlags = new Set(['dry-run', 'force', 'no-keep', PANE_TRANSPORT, BOOT_TRANSPORT])
  const repeatableFlags = new Set(['adopt', TURN_CENSUS_FLAG])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (typeof argument !== 'string' || !argument.startsWith('--')) {
      positional.push(argument)
      continue
    }
    const name = argument.slice(2)
    if (booleanFlags.has(name)) {
      if (Object.prototype.hasOwnProperty.call(flags, name)) refuse(`duplicate --${name}`, BATCH_UNREADABLE)
      flags[name] = true
      continue
    }
    const seatFlag = Object.values(SEAT_FIELDS).some((prefix) => name.startsWith(prefix) && name.length > prefix.length)
    if (!seatFlag && !valueFlags.has(name) && !repeatableFlags.has(name)) refuse(`unknown option: --${name}`, BATCH_UNREADABLE)
    if (!repeatableFlags.has(name) && Object.prototype.hasOwnProperty.call(flags, name)) refuse(`duplicate --${name}`, BATCH_UNREADABLE)
    const value = argv[index + 1]
    if (value == null || (typeof value === 'string' && value.startsWith('--'))) {
      refuse(`--${name} requires a value`, BATCH_UNREADABLE)
    }
    if (repeatableFlags.has(name)) flags[name] = [...(flags[name] || []), value]
    else flags[name] = value
    index += 1
  }
  if (positional.length > 0) refuse(`unexpected argument: ${positional[0]}`, BATCH_UNREADABLE)
  return flags
}

export async function main(argv, deps = {}) {
  try {
    const flags = parseCliArgs(argv)
    if (typeof flags.batch !== 'string' || flags.batch.trim() === '') {
      refuse('--batch <directory> is required', BATCH_UNREADABLE)
    }
    if (typeof flags.fences !== 'string' || flags.fences.trim() === '') {
      refuse('--fences <register.json> is required', BATCH_UNREADABLE)
    }
    const checkout = resolve(typeof flags.checkout === 'string' ? flags.checkout : process.cwd())
    const parentDir = typeof flags.parent === 'string' ? resolve(flags.parent) : dirname(checkout)
    const outDir = typeof flags.out === 'string' ? resolve(flags.out) : join(resolve(flags.batch), 'out')
    const requestedExecution = resolveRequestedExecution({ execution: flags.execution, variant: flags.variant })
    const requestedTier = resolveRequestedTier({ tier: flags.tier, assurance: flags.assurance })
    let register
    try {
      register = readRegister({ fencesPath: flags.fences, checkout, outDir, deps })
    } catch (err) {
      if (err instanceof BatchRefusal) throw err
      refuse(`cannot read or validate fences ${flags.fences}: ${err?.message || String(err)}`, BATCH_UNREADABLE)
    }
    await dispatchBatch({
      batchDir: resolve(flags.batch),
      fences: register.fences,
      externals: register.externals,
      registerPath: register.sanitised ? register.registerPath : undefined,
      checkout,
      parentDir,
      outDir,
      tier: requestedTier,
      execution: requestedExecution,
      runFlags: flags,
      deps,
    })
    return 0
  } catch (err) {
    if (err instanceof BatchRefusal) {
      process.stderr.write(`${err.message} [reason: ${err.reason}]\n`)
      return 2
    }
    process.stderr.write(`${err?.message || String(err)}\n`)
    return 1
  }
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) main(process.argv.slice(2)).then((code) => { process.exitCode = code })
