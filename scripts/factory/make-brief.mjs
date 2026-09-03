#!/usr/bin/env node
// scripts/factory/make-brief.mjs — compile the mechanical half of a brief from
// four ratified authored lines. It verifies the requested paths, finds tests
// that pin those paths and their discoverable keys, measures the target's
// baseline, carries caller-supplied fences, and repeats the standing blocks; a supplied baseline carrying a commit sha may be reused when it describes this clean tree; a profile's recorded baseline
// still may not be consumed. It never decides the carve, acceptance judgment, or crew decisions.
//
// LIBRARY vs CLI: importing this file performs no I/O. main(argv) returns an
// exit code and never calls process.exit; the invokedDirectly guard at the
// bottom sets process.exitCode. Exit codes are 0 for success, 1 for an
// unexpected internal error, and 2 for a usage/refusal error, matching the
// other scripts/factory modules.
//
// The discovery transcription is the specification in
// crew/roles/planner.md:67-83. That charter is cited here, not read at
// runtime: crew/ is a separate lane and coupling a compiler to prose would
// make an unrelated charter edit change a compilation. #240 is why the
// baseline child gets a colour-neutral environment before its output is
// parsed. Repo-specific test_command and conventions now come from a ratified
// repo profile. A supplied baseline carrying a commit sha may be reused when
// it describes this clean tree; the profile's recorded baseline is never
// consumed because it records no commit sha. --require-profile is the explicit autonomous-caller posture;
// hand-driven callers state and use the package.json fallback when profile
// facts are absent.
//
// A tier is proposed, never decided: #45 item 4's ratified rule lives here
// because these mechanical signals exist before boot. Protected paths are the
// authored floor plus additions from the profile, --protected JSON, or a
// library parameter; blueprint proposal is deliberately absent pending #251.
//
// A blank decision slot is not authored by this module: it is emitted as the
// literal UNFILLED SLOT marker so the orchestrator can fill it. The ask is the
// one authored line that is checked at construction time and refused when it
// is blank, too short, or merely repeats its task heading.
//
// The declared write surface comes from the fence register when --lane names
// a lane in it, from the authored where otherwise, and never from the output
// filename.

import {
  existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  ProbeUsageError, ProfileRefusal, defaultProfilePath, profileProtectedPaths, readProfile, repoKeyFor, requireField,
} from './probe-repo.mjs'
import { resolveProtectedPaths } from '../../crew/protected-paths.mjs'

const REQUEST_KEYS = Object.freeze(['ask', 'where', 'done_means', 'out_of_scope'])
// A lane may declare files it will CREATE. The key is OPTIONAL, so every
// request authored before it existed stays valid, and it is a COMPILER key
// rather than a dispatch-only one: the compiler is what exempts the path.
export const OPTIONAL_REQUEST_KEYS = Object.freeze(['creates', 'directed', 'intent'])
const CODE_EXTENSIONS = Object.freeze(['.js', '.mjs'])
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const ERROR_CODE = /^[a-z0-9]+(?:[-:][a-z0-9]+)+$/
const WRITTEN_PATH = /^[A-Za-z0-9_.\-/]+\.[A-Za-z0-9]+$/
const QUOTED_LITERAL = /(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g
const EXPORTED_DECLARATION = /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm
const EXPORTED_LIST = /^export\s*\{([^}]*)\}/gm
const TEST_FILE = /(^|\/)[^/]*\.test\.mjs$/
const BROAD_KEY_LIMIT = 30
const BASELINE_TIMEOUT_MS = 300_000

export const TIER_NAMES = Object.freeze(['mechanical', 'build', 'judge'])
export const DEFAULT_PROTECTED_PATHS = resolveProtectedPaths()
export const LADDER_PATH = new URL('../../crew/model-ladder.json', import.meta.url)

// The four ratified strength bands (crew/model-ladder.json, ratified 2026-08-14).
// A strength proposal is only ever a member of this list; an unreadable ladder
// proposes nothing rather than inventing a name.
export function readLadderBands(ladderPath = LADDER_PATH) {
  try {
    const data = JSON.parse(readFileSync(ladderPath, 'utf8'))
    return Object.freeze(data.bands
      .map((band) => band && band.band)
      .filter((name) => typeof name === 'string' && name.length > 0))
  } catch {
    return Object.freeze([])
  }
}

export const LADDER_BANDS = readLadderBands()

// #291: risk pins the seats that GOVERN (shape) …
const JUDGE_PROTECTED_FLOOR = 2
// … and complexity prices the seats that PRODUCE (strength).
const STRENGTH_BY_COMPLEXITY = Object.freeze({
  mechanical: 'utility', build: 'workhorse', judge: 'frontier',
})
const MECHANICAL_MAX_SOURCES = 1
const BUILD_MAX_SOURCES = 4
const BROAD_TRIPWIRE_FLOOR = 6

// These are the only refusal reasons this CLI publishes. Keeping the list
// closed makes a caller able to enumerate every expected refusal without
// depending on incidental filesystem or parser wording.
const MISSING_LINE = 'missing-line'
const WRONG_TYPE = 'wrong-type'
const UNKNOWN_KEY = 'unknown-key'
const BLANK_ASK = 'blank-ask'
const RESTATING_ASK = 'restating-ask'
const MISSING_PATH = 'missing-path'
const NOT_A_GIT_REPO = 'not-a-git-repo'
const OUT_DIR_MISSING = 'out-dir-missing'
const OUT_EXISTS = 'out-exists'
const BAD_FENCES = 'bad-fences'
const BAD_PROTECTED = 'bad-protected'
const UNKNOWN_LANE = 'unknown-lane'
const COUPLED_SOURCE_UNFENCED = 'coupled-source-unfenced'
const STALE_READ_ACK = 'stale-read-ack'
const PROFILE_UNREADABLE = 'profile-unreadable'
const PROFILE_UNRATIFIED = 'profile-unratified'
const SCOPE_DIRECTORY_UNSLASHED = 'scope-directory-unslashed'
const SCOPE_ENTRY_SHAPE = 'scope-entry-shape'
const SCOPE_ENTRY_CASE = 'scope-entry-case'
const CREATES_EXISTS = 'creates-exists'
const CREATES_PARENT_MISSING = 'creates-parent-missing'
const DIRECTED_UNKNOWN_KEY = 'directed-unknown-key'
const DIRECTED_SHAPE = 'directed-shape'
const DIRECTED_FENCE_COLLISION = 'directed-fence-collision'

export const REFUSAL_REASONS = Object.freeze([
  MISSING_LINE,
  WRONG_TYPE,
  UNKNOWN_KEY,
  BLANK_ASK,
  RESTATING_ASK,
  MISSING_PATH,
  NOT_A_GIT_REPO,
  OUT_DIR_MISSING,
  OUT_EXISTS,
  BAD_FENCES,
  BAD_PROTECTED,
  UNKNOWN_LANE,
  COUPLED_SOURCE_UNFENCED,
  STALE_READ_ACK,
  PROFILE_UNREADABLE,
  PROFILE_UNRATIFIED,
  SCOPE_DIRECTORY_UNSLASHED,
  SCOPE_ENTRY_SHAPE,
  SCOPE_ENTRY_CASE,
  CREATES_EXISTS,
  CREATES_PARENT_MISSING,
  DIRECTED_UNKNOWN_KEY,
  DIRECTED_SHAPE,
  DIRECTED_FENCE_COLLISION,
])

export const BROAD_KEY_HIT_LIMIT = BROAD_KEY_LIMIT
export const SLOT_MARKER = 'UNFILLED SLOT'

// #291 step 3: the compiler's shape and strength proposals travel to the boot
// path as a fenced, machine-readable block beside the prose above. Closed key
// set, same posture as DIRECTED_KEYS (crew/drive.mjs:902): a key nothing reads
// is a claim no reader honours. The reader re-declares this pair locally
// (scripts/factory/emit.mjs) rather than importing this module; the two
// declarations are pinned equal by test/factory-make-brief.test.mjs.
export const PROPOSAL_BLOCK = 'proposal'
export const PROPOSAL_KEYS = Object.freeze(['shape', 'strength'])

// #657: a `directed` lane's PLAN IS ITS BRIEF, and until now the compiler had no
// home for one — the only free-text field rendered exactly once was `out_of_scope`,
// so b248 dispatched with its plan smuggled into the section that says what the lane
// must NOT do. The pair below is RE-DECLARED, not imported: crew/drive.mjs is the
// driver's lane and a compiler that imported it would couple every compiled brief to
// the driver. test/factory-make-brief.test.mjs pins the pair equal to
// crew/drive.mjs's DIRECTED_BLOCK and DIRECTED_KEYS — the same posture PROPOSAL_KEYS
// holds with scripts/factory/emit.mjs.
export const DIRECTED_BLOCK = 'directed'
export const DIRECTED_KEYS = Object.freeze(['gate_cmd', 'files_in_scope'])

// Recorded because nothing said it and the instinct is to commit one: a directed
// lane's gate script cannot live in the repo at all.
export const DIRECTED_GATE_NOTE = Object.freeze(`The gate named below lives outside the repo — in the batch directory — and
\`gate_cmd\` names it by absolute path. A directed lane's write fence is its
deliverable surface, so a committed gate script sits beyond the lane's own scope
and the scope gate refuses it; the dispatcher creates the worktrees itself, so
there is no moment to commit one either. The gate is the orchestrator's artefact.`)

// Copied byte-for-byte from the converged brief's standing acceptance block.
export const ACCEPTANCE_GATE_BLOCK = Object.freeze(`Planner authors it; **RED at baseline**, printing
\`GATE-SUMMARY {"total":n,"failed":n,"errored":n}\` (\`GATE_SUMMARY_PREFIX\`,
\`crew/drive.mjs:70\`) with \`errored: 0\` at baseline (#153). Prove the gate
discriminates (#168), resolve the repo from \`process.cwd()\`, name in a comment
the mutation each check kills, never assert the checkout is clean. If your
gate shells out to the suite, strip ANSI before parsing it (#240).`)

// #672: a lane's gate runs in the SAME environment as its build, so a test that
// only passes on the author's machine is invisible to it. b254-retryvis shipped a
// green gate and a green suite and CI still failed on a worker binary the author
// happened to have installed. Stated here rather than enforced by a lint: the
// standing block reaches every future lane, a mechanical scan for "reaches a
// resolution seam" is a bigger surface and its own lane.
export const HOSTILE_ENV_BLOCK = Object.freeze(`Your gate runs in the SAME environment as your build, so an advantage your box
happens to have is invisible to both: a resolved binary, a real \`$HOME\`, a
populated \`$PATH\`. Run the test files this lane TOUCHED once more with those
advantages removed —

    env -u CREW_CLAUDE_BIN HOME=<an empty dir> node --test --test-reporter=tap <your touched test files>

— and require it green. Not the whole suite: one extra run of your own files.
\`b254-retryvis\` reported a gate at 29/0/0 and a suite at 2593/0 and CI still
failed with \`no frozen headless worker binary found\`; its harness injected
\`deps.headlessIo\`, but the worker binary resolves BEFORE that seam, so the mock
was unreachable on a machine with no \`claude\` installed (#672).

A new test that reaches a binary-resolution seam (\`resolveWorkerBin\` and its
siblings) must do one of exactly two things: STUB the resolution —
\`crew/crew.test.mjs:546\` sets \`CREW_CLAUDE_BIN\` around the call and restores it
— or SKIP with a named reason — \`crew/adapter-pi.test.mjs:62\`,
\`if (!command) return t.skip('pi is not installed on PATH')\`. Doing neither, on a
path that resolves a binary, is the reviewable signal.`)

// The task-specific write-surface and grep lines precede this unchanged
// standing tail in the rendered Conventions block.
export const CONVENTIONS_BLOCK = Object.freeze(`- The factory scripts carry a Node ≥26 floor; follow the existing
  \`scripts/factory/*\` conventions rather than inventing new ones.
- No version bump (#137). Commit on green only. Never push, never open a PR.
  No \`Co-Authored-By\` trailers.
- If interrupted, write your ReturnEnvelope first on resume — \`status:
  insufficient\` if incomplete. A silent seat is indistinguishable from a dead
  one.`)

// The per-check mutation contract quoted from its single enforcement point,
// `validateMutations` in crew/drive.mjs. Two lanes lost a plan round each to a
// format documented nowhere a planner reads (#330, #345); a standing block is the
// only delivery that does not depend on an orchestrator remembering. The
// discrimination proof asks whether a mutation reddens a check, never whether it
// exercises what the check claims, so the author-side rule ships in the brief (#409).
export const MUTATION_CONTRACT_BLOCK = Object.freeze(`A per-check mutation declaration is MACHINE-APPLIED: the driver find-and-replaces
on a scratch copy of the built tree, re-runs the gate, and requires that one check
to redden. A prose field (\`"kills": "leaving the loop unconditional"\`) cannot be
applied and is refused — \`validateMutations\` in \`crew/drive.mjs\` is the single
enforcement point. Each entry in \`details.mutations\` is EITHER a mutation OR an
exemption, never both, and at most 32 entries in all (\`MUTATIONS_MAX\`).

A mutation entry carries exactly:

    { "check": "C1", "file": "lib/widget.mjs", "find": "<literal text present in the file>", "replace": "<literal replacement>" }

- \`check\` — a stable token matching \`/^[A-Za-z0-9][A-Za-z0-9._-]*$/\` (letters,
  digits, dot, underscore, hyphen; starting with a letter or digit), unique across
  all entries. The gate MUST print \`FAIL <check>\` on that check's failing line
  (\`CHECK_FAIL_PREFIX\`), matched as an exact token — the label you declare and the
  label the gate prints are one string.
  Nothing may FOLLOW that label except a colon. \`checkFailureLine\`
  (\`crew/drive.mjs\`) is the matcher that decides, and it accepts the bare line or a
  single colon delimiter — nothing else. Literally:

      FAIL <check>                  ← accepted, the bare line
      FAIL <check>: <why>           ← accepted, the ONE delimiter is a colon
      FAIL <check> — <why>          ← REJECTED, an em dash is not a delimiter
      FAIL <check> <why>            ← REJECTED, a space is not a delimiter

  The reason, not merely the prohibition: a label may not be EXTENDED by what follows
  it. Were a space or a dash a legal delimiter, \`FAIL cache\` would match a
  \`FAIL cache-v2\` line and one check's red would be credited to another — the
  whole-gate false positive #330 exists to remove. Two planners in one day each wrote
  a human-readable separator instead, costing four gate generations across three lanes
  and escalating one lane whose code was correct (#387).
- \`file\` — required, repo-relative, a file and not a directory, and inside
  \`files_in_scope\`.
- \`find\` — required, non-empty LITERAL text naming the token sequence to bind in
  that file; not a regex, not a description. The exact-then-normalized rule below
  decides whether it binds; byte-identical whitespace is not required.
- \`replace\` — required string, and must DIFFER from \`find\`; an identical pair
  mutates nothing. A pair whose whitespace-NORMALIZED forms are equal is refused for
  the same reason: it binds the same token sequence and rewrites the same tokens. The
  driver says so in those words — \`find and replace differ only in whitespace — that
  mutates no token\`.

A declared \`find\` **binds by TOKEN SEQUENCE**, not by the bytes you typed. The driver
tries an exact match first and, only on a miss, a whitespace-normalized one, so
**whitespace and line wrapping are not load-bearing** and a re-wrapped line still binds.
Normalization is **whitespace-only**. It is not a regex, not a symbol lookup, not
fuzzy: a find whose TOKENS differ from the built source does not bind.
The anchor must be **unique** after normalization.
The four ways an anchor fails to reach the built tree, by name: **\`unapplied\`** (the
declared file does not exist in the built tree), **\`anchor-absent\`** (the find text
is nowhere in the file under either attempt), **\`anchor-ambiguous\`** (the normalized
find matches more than one span), or **\`anchor-unsafe\`** (the normalized match
crosses a line carrying a \`//\` comment inside the span, so a verbatim replacement
would land in that comment — declare a find that starts after the comment). None of
the four is a gate defect — each says the plan predicted source the builder did not
write, and **\`survived\` remains the only gate defect**. Cite **#733**, **#742**.

An exemption entry carries exactly \`{ "check": "<token>", "exempt": "<non-empty reason>" }\`
and no \`file\`, \`find\` or \`replace\`.

The human sentence saying what a mutation kills belongs in a comment beside the
check in the gate file and in \`plan.md\`, never in the entry. Worked example — the
gate carries, above the check that prints \`FAIL C1\`:

    // MUTATION C1: neutralise the standing block in renderBrief's lines array and
    // no compiled brief carries the contract any more.

and the declaration is \`{ "check": "C1", "file": "scripts/factory/make-brief.mjs", "find": "standingBlocks().mutations", "replace": "standingBlocks().nothing" }\`.
Rationale: #330.

A gate that shells out to \`node --test\` MUST pass \`--test-reporter=tap\`. node
--test picks its reporter by context and the summary lines differ in their
leading character; measured on this checkout, same file and same environment,
the two shapes are LITERALLY:

    ℹ pass 7      ← default reporter, no --test-reporter flag
    ℹ fail 0
    # pass 7      ← --test-reporter=tap
    # fail 0

That leading character is \`ℹ\` (U+2139 INFORMATION SOURCE), not the ASCII
letter \`i\`, so a gate greping \`^# fail (\\d+)$\` parses NOTHING under the
default reporter and reports no failures for a suite it never read. Pin the
reporter rather than widening the regex: the default is context-dependent and a
future Node release may change it again, so a tolerant regex accepting both
shapes still silently depends on the reporter for every shape it does not
anticipate. Match the LAST summary line, not the first — an earlier echoed
\`# fail 0\` otherwise satisfies the check while a later real nonzero summary
passes it.

Colour is the other half: \`FORCE_COLOR\` OVERRIDES \`NO_COLOR\`, so a
colour-neutral child must DELETE \`FORCE_COLOR\` (and \`CLICOLOR_FORCE\`) from its
environment rather than only setting \`NO_COLOR=1\`. Under \`FORCE_COLOR=3
NO_COLOR=1\` the measured line is \`ESC[34mℹ pass 7ESC[39m\` (ESC = 0x1b), so an
\`^\`-anchored grep matches nothing. Strip ANSI before parsing either shape
(#240). Rationale: #399.

A declared mutation must exercise the check's NARROWEST claimed property, not
merely redden the check. The per-check proof asks only "does this mutation redden
this check?"; it cannot ask "does this mutation exercise what this check
CLAIMS?", and on 2026-08-20 four checks certified \`killed\` were each weaker
than their own prose. Read your own mutation as an adversary: what is the cheapest
implementation that violates the sentence beside the check and still passes it?
Two measured counter-examples, both certified \`killed\`:

- A mutation landing IN A COMMENT. \`C1\` claimed "≥3 tests are named for the
  re-ask, one naming the bound"; its declared mutation rewrote a \`re-ask\`
  occurrence inside a COMMENT — text the check never reads — so it reddened
  nothing the check counts and the real mutation had to be found by hand.
  Mutate the text the check actually parses; if no such \`find\` exists, the
  check is reading something other than what its prose claims.
- A negative-claim fixture INDISTINGUISHABLE from what already exists. \`G15\`
  claimed "an unknown adapter's overlay cannot silently widen another
  adapter", and injected an overlay carrying an extension the target ALREADY
  had, then asserted only that a third adapter stayed empty. An implementation
  merging every overlay into the target passes it: the duplicate dedupes and
  the third adapter is untouched. State a negative claim positively — the
  injected fixture must be DISTINCTIVE, a value nothing else in the fixture
  carries so its arrival is unambiguous, and the protected side must be
  compared BEFORE-AND-AFTER, never merely observed to be empty.

A COMPOUND CLAIM needs one mutation per half. \`G15\` ("cannot widen" AND
"another adapter") and \`L11\` ("every anchor" AND "one a resolver reads") each
had a half no declared mutation probed: \`L11\`'s check added every discovered RANGE
citation to its own resolved set, while its mutation used the single-line form,
so the range hole was never touched. If the sentence beside your check has two
verbs, declare two entries or write a narrower sentence.
Rationale: #409.`)

function standingBlocks() {
  const acceptance = [ACCEPTANCE_GATE_BLOCK, HOSTILE_ENV_BLOCK].join('\n\n')
  return { acceptance, mutations: MUTATION_CONTRACT_BLOCK, conventions: CONVENTIONS_BLOCK }
}

export class BriefUsageError extends Error {
  constructor(message, reason = MISSING_LINE) {
    super(message)
    this.name = 'BriefUsageError'
    this.reason = reason
  }
}

function refuseUsage(message, reason = MISSING_LINE) {
  throw new BriefUsageError(`brief: ${message}`, reason)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function repoRelative(repoRoot, filePath) {
  const value = relative(repoRoot, filePath).split(sep).join('/')
  return value === '' ? '.' : value
}

function normaliseRepoPath(value) {
  const normal = String(value).replaceAll('\\', '/')
  if (normal === './') return '.'
  return normal.startsWith('./') ? normal.slice(2) : normal
}

function gitRoot(checkout) {
  const cwd = realpathOr(resolve(checkout || process.cwd()))
  let result
  try {
    result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 10_000,
    })
  } catch {
    refuseUsage(`checkout is not a git repository: ${cwd}`, NOT_A_GIT_REPO)
  }
  if (!result || result.status !== 0 || !nonEmptyString(result.stdout)) {
    refuseUsage(`checkout is not a git repository: ${cwd}`, NOT_A_GIT_REPO)
  }
  return realpathOr(resolve(result.stdout.trim()))
}

function parseTaskStem(filePath) {
  const file = basename(filePath)
  const extension = extname(file)
  return extension ? file.slice(0, -extension.length) : file
}

function askTokens(value) {
  return String(value).toLowerCase().match(/[a-z0-9]+/g) || []
}

// This is deliberately the compiler's construction-time definition of a
// heading-restating ask: at least three alphanumeric tokens, and every unique
// ask token appears in the task-name token set.
export function validateAsk(ask, taskName) {
  if (typeof ask !== 'string') refuseUsage('ask must be a string', WRONG_TYPE)
  if (!ask.trim()) refuseUsage('ask must not be blank', BLANK_ASK)
  const tokens = askTokens(ask)
  if (tokens.length < 3) {
    refuseUsage('ask must contain at least three alphanumeric tokens', MISSING_LINE)
  }
  const heading = new Set(askTokens(taskName || ''))
  const distinct = new Set(tokens)
  if (heading.size > 0 && [...distinct].every((token) => heading.has(token))) {
    refuseUsage('ask merely restates the task name', RESTATING_ASK)
  }
  return ask
}

function collapseSentence(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

// One sentence: up to the first terminator followed by a space or the end.
// A one-line ask with no terminator IS the sentence.
function firstSentence(text) {
  const match = /^.*?[.!?](?=\s|$)/.exec(text)
  return match ? match[0] : text
}

// The lane's purpose in one sentence. An explicitly authored `intent` beats
// the sentence derived from the ask; nothing else is consulted.
export function resolveIntent(request = {}) {
  const given = collapseSentence(request?.intent)
  if (given) return given
  return firstSentence(collapseSentence(request?.ask))
}

// DECISION (#657 item 5) — a `directed` plan on a request whose resolved variant
// cannot consume it is ACCEPTED, never refused. This compiler is variant-blind by
// construction: dispatch-batch.mjs splits `variant`, `tier` and `depends_on` off as
// DISPATCH_ONLY_REQUEST_KEYS before the closed schema ever sees the request, so
// refusing on variant would need a fact this module is deliberately denied. The
// block is inert in a non-directed brief — only the directed path calls
// parseDirectedBrief — so what is checked here is the SHAPE, always, and never the
// variant. What is NOT accepted is a key nothing reads: the compiler refuses exactly
// the shape parseDirectedBrief refuses, four seats earlier.
function validateDirected(plan) {
  if (plan === undefined) return
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    refuseUsage('directed must be a JSON object', DIRECTED_SHAPE)
  }
  const extra = Object.keys(plan).filter((key) => !DIRECTED_KEYS.includes(key))
  if (extra.length) {
    refuseUsage(`directed declares ${extra.join(', ')}, which nothing reads — the keys are exactly ${DIRECTED_KEYS.join(', ')}`, DIRECTED_UNKNOWN_KEY)
  }
  if (typeof plan.gate_cmd !== 'string' || !plan.gate_cmd.trim()) {
    refuseUsage('directed.gate_cmd must be the non-empty command the driver runs as the acceptance gate', DIRECTED_SHAPE)
  }
  if (!Array.isArray(plan.files_in_scope) || plan.files_in_scope.length === 0) {
    refuseUsage('directed.files_in_scope must be a non-empty list of repo-relative entries', DIRECTED_SHAPE)
  }
  for (const entry of plan.files_in_scope) {
    if (typeof entry !== 'string' || !entry.trim()) {
      refuseUsage('every directed.files_in_scope entry must be a non-blank string', DIRECTED_SHAPE)
    }
  }
}

export function validateRequest(request, { taskName } = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    refuseUsage('request must be a JSON object', WRONG_TYPE)
  }
  for (const key of Object.keys(request)) {
    if (!REQUEST_KEYS.includes(key) && !OPTIONAL_REQUEST_KEYS.includes(key)) {
      refuseUsage(`unknown request key: ${key}`, UNKNOWN_KEY)
    }
  }
  for (const key of REQUEST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(request, key)) {
      refuseUsage(`request is missing ${key}`, MISSING_LINE)
    }
  }
  if (typeof request.ask !== 'string') refuseUsage('ask must be a string', WRONG_TYPE)
  if (!request.ask.trim()) refuseUsage('ask must not be blank', BLANK_ASK)
  if (!Array.isArray(request.where)) refuseUsage('where must be an array', WRONG_TYPE)
  if (request.where.length === 0) refuseUsage('where must not be empty', MISSING_LINE)
  for (const path of request.where) {
    if (typeof path !== 'string') refuseUsage('every where entry must be a string', WRONG_TYPE)
    if (!path.trim()) refuseUsage('every where entry must be non-blank', MISSING_LINE)
  }
  if (Object.prototype.hasOwnProperty.call(request, 'creates')) {
    if (!Array.isArray(request.creates)) refuseUsage('creates must be an array', WRONG_TYPE)
    for (const path of request.creates) {
      if (typeof path !== 'string') refuseUsage('every creates entry must be a string', WRONG_TYPE)
      if (!path.trim()) refuseUsage('every creates entry must be non-blank', MISSING_LINE)
    }
  }
  if (Object.prototype.hasOwnProperty.call(request, 'intent')) {
    if (typeof request.intent !== 'string') refuseUsage('intent must be a string', WRONG_TYPE)
    if (!request.intent.trim()) refuseUsage('intent must not be blank', MISSING_LINE)
  }
  for (const key of ['done_means', 'out_of_scope']) {
    if (typeof request[key] !== 'string') refuseUsage(`${key} must be a string`, WRONG_TYPE)
    if (!request[key].trim()) refuseUsage(`${key} must not be blank`, MISSING_LINE)
  }
  validateDirected(request.directed)
  validateAsk(request.ask, taskName)
  return request
}

function absoluteWhere(checkout, entry) {
  return resolve(realpathOr(resolve(checkout)), entry)
}

export function verifyWhere({ checkout, where }) {
  const root = gitRoot(checkout)
  if (!Array.isArray(where)) refuseUsage('where must be an array', WRONG_TYPE)
  return where.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      refuseUsage(`where entry is invalid: ${String(entry)}`, MISSING_LINE)
    }
    const absolute = absoluteWhere(root, entry)
    const relativePath = relative(root, absolute).split(sep).join('/')
    if (relativePath === '..' || relativePath.startsWith('../')) {
      refuseUsage(`where path is outside checkout: ${entry}`, MISSING_PATH)
    }
    let stat
    try {
      stat = statSync(absolute)
    } catch {
      refuseUsage(`where path does not exist: ${entry}`, MISSING_PATH)
    }
    if (!stat.isFile() && !stat.isDirectory()) {
      refuseUsage(`where path is neither a file nor directory: ${entry}`, MISSING_PATH)
    }
    // Resolve the repository once here as a refusal, even for an otherwise
    // valid path. The return keeps the author's spelling for rendering.
    if (!root) refuseUsage(`checkout is not a git repository: ${checkout}`, NOT_A_GIT_REPO)
    return { path: entry, kind: stat.isDirectory() ? 'directory' : 'file' }
  })
}

// The OPPOSITE of verifyWhere, deliberately: an edited path must exist, a
// created path must NOT, and its parent directory must — so a typo in a
// declared creation is still caught instead of waved through. The compiler
// EXEMPTS rather than the dispatcher SEEDING a stub, because a seeded stub
// makes a typo indistinguishable from an intent: the stub satisfies
// verifyWhere for whatever path was written. Shape (glob, absolute, . or ..,
// wrong case) is already validateScopeEntries' business, so only the
// existence pair is new here.
export function verifyCreates({ checkout, creates = [] } = {}) {
  if (!Array.isArray(creates)) refuseUsage('creates must be an array', WRONG_TYPE)
  const root = gitRoot(checkout)
  validateScopeEntries({ checkout, files: creates, context: 'creates' })
  const seen = new Set()
  return creates.map((entry) => {
    const normalised = normaliseRepoPath(entry)
    if (normalised.endsWith('/')) {
      refuseUsage(`creates entry must name a file, not a directory: ${entry}`, SCOPE_ENTRY_SHAPE)
    }
    const absolute = absoluteWhere(root, normalised)
    const relativePath = relative(root, absolute).split(sep).join('/')
    if (relativePath === '' || relativePath === '..' || relativePath.startsWith('../')) {
      refuseUsage(`creates path has no parent directory in the checkout: ${entry}`, CREATES_PARENT_MISSING)
    }
    let pathSegment = root
    for (const segment of relativePath.split('/').filter(Boolean)) {
      pathSegment = join(pathSegment, segment)
      let segmentStat = null
      try { segmentStat = lstatSync(pathSegment) } catch (error) {
        if (error?.code === 'ENOENT') break
        refuseUsage(`creates path includes a symlink or inaccessible segment: ${entry}`, CREATES_PARENT_MISSING)
      }
      if (segmentStat.isSymbolicLink()) {
        refuseUsage(`creates path ${pathSegment === absolute ? 'already exists' : 'includes a symlink or inaccessible segment'}: ${entry}`, pathSegment === absolute ? CREATES_EXISTS : CREATES_PARENT_MISSING)
      }
    }
    if (seen.has(relativePath)) refuseUsage(`creates path is listed twice: ${entry}`, WRONG_TYPE)
    seen.add(relativePath)
    let stat = null
    try { stat = statSync(absolute) } catch { stat = null }
    if (stat) refuseUsage(`creates path already exists: ${entry}`, CREATES_EXISTS)
    let parent = null
    try { parent = statSync(dirname(absolute)) } catch { parent = null }
    if (!parent || !parent.isDirectory()) {
      refuseUsage(`creates path has no parent directory in the checkout: ${entry}`, CREATES_PARENT_MISSING)
    }
    return { path: relativePath, kind: 'created' }
  })
}

function listDirectoryFiles(checkout, repoRoot, entry) {
  const absolute = absoluteWhere(checkout, entry.path)
  const relativeEntry = repoRelative(repoRoot, absolute)
  const pathspec = relativeEntry === '.' ? '.' : relativeEntry
  let result
  try {
    result = spawnSync('git', ['-C', checkout, 'ls-files', '-z', '--', pathspec], {
      encoding: 'utf8',
      timeout: 10_000,
    })
  } catch {
    refuseUsage(`cannot list files under ${entry.path}`, NOT_A_GIT_REPO)
  }
  if (!result || result.status !== 0) {
    refuseUsage(`cannot list files under ${entry.path}`, NOT_A_GIT_REPO)
  }
  return String(result.stdout || '')
    .split('\0')
    .filter(Boolean)
    .map((file) => normaliseRepoPath(file))
}

function expandFiles({ checkout, entries, repoRoot }) {
  const files = []
  for (const entry of entries) {
    if (entry.kind === 'file') {
      files.push({
        file: repoRelative(repoRoot, absoluteWhere(checkout, entry.path)),
        absolute: absoluteWhere(checkout, entry.path),
      })
      continue
    }
    for (const file of listDirectoryFiles(checkout, repoRoot, entry)) {
      files.push({ file, absolute: join(repoRoot, ...file.split('/')) })
    }
  }
  const byFile = new Map()
  for (const file of files) byFile.set(normaliseRepoPath(file.file), file)
  return [...byFile.values()].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
}

function addQuotedKeys(source, keys) {
  for (const match of source.matchAll(QUOTED_LITERAL)) {
    const literal = match[2]
    if (ERROR_CODE.test(literal) || WRITTEN_PATH.test(literal)) {
      keys.add(literal)
      if (WRITTEN_PATH.test(literal)) {
        const base = literal.split('/').filter(Boolean).pop()
        if (base) keys.add(base)
      }
    }
  }
}

export function isTripwireFile(file) {
  return TEST_FILE.test(file) || file.startsWith('test/')
}

export function discoverTripwires({ checkout, files }) {
  const repoRoot = gitRoot(checkout)
  if (!Array.isArray(files)) refuseUsage('files must be an array', WRONG_TYPE)
  const entries = files.map((entry) => {
    if (typeof entry === 'string') return verifyWhere({ checkout, where: [entry] })[0]
    if (!entry || typeof entry !== 'object' || !['file', 'directory'].includes(entry.kind) || typeof entry.path !== 'string') {
      refuseUsage('files must contain verified path entries', WRONG_TYPE)
    }
    return entry
  })
  const sourceFiles = expandFiles({ checkout: repoRoot, entries, repoRoot })
  const keyOwners = new Map()
  const symbolOwners = new Map()
  const ownerFiles = new Set()
  const allKeys = new Set()
  for (const sourceFile of sourceFiles) {
    let source
    try {
      source = readFileSync(sourceFile.absolute, 'utf8')
    } catch {
      refuseUsage(`where path cannot be read: ${sourceFile.file}`, MISSING_PATH)
    }
    const keys = extractKeys(source, sourceFile.file)
    const symbols = extractSymbols(source, sourceFile.file)
    ownerFiles.add(sourceFile.file)
    for (const key of keys) {
      allKeys.add(key)
      if (!keyOwners.has(key)) keyOwners.set(key, new Set())
      keyOwners.get(key).add(sourceFile.file)
    }
    for (const symbol of symbols) {
      if (!symbolOwners.has(symbol)) symbolOwners.set(symbol, new Set())
      symbolOwners.get(symbol).add(sourceFile.file)
    }
  }

  // Check 1: seed coupling with each owner's OWN repo path and basename, so a
  // non-test code file that only CITES a fenced path — in a comment, sharing no
  // exported symbol — surfaces through the same coupled-source flow (#327).
  const citationOwners = new Map()
  for (const owner of ownerFiles) {
    for (const citation of [owner, basename(owner)]) {
      if (!allKeys.has(citation)) allKeys.add(citation)
      if (!keyOwners.has(citation)) keyOwners.set(citation, new Set())
      keyOwners.get(citation).add(owner)
      if (!citationOwners.has(citation)) citationOwners.set(citation, new Set())
      citationOwners.get(citation).add(owner)
    }
  }

  const hitsByKey = grepHitsForKeys(repoRoot, [...allKeys]), mentionsByOwner = new Map()
  // The owner-path mention is intentionally unbounded: it only narrows the
  // exported-symbol coupling set, never the existing broad-key tripwire set.
  for (const owner of [...ownerFiles].sort()) {
    const mentions = new Set([
      ...(hitsByKey.get(owner) || []),
      ...(hitsByKey.get(basename(owner)) || []),
    ])
    mentions.delete(owner)
    mentionsByOwner.set(owner, mentions)
  }

  const tripwireMap = new Map()
  const coupledMap = new Map()
  const broadKeys = []
  for (const key of [...allKeys].sort()) {
    const hits = hitsByKey.get(key) || []
    if (hits.length > BROAD_KEY_LIMIT) {
      broadKeys.push({ key, count: hits.length })
      continue
    }
    for (const hit of hits) {
      if (isTripwireFile(hit)) {
        if (keyOwners.get(key)?.has(hit)) continue
        if (!tripwireMap.has(hit)) tripwireMap.set(hit, new Set())
        tripwireMap.get(hit).add(key)
        continue
      }
      if (!CODE_EXTENSIONS.includes(extname(hit).toLowerCase())) continue
      if (ownerFiles.has(hit)) continue
      const owners = symbolOwners.get(key) ?? citationOwners.get(key)
      if (!owners) continue
      const namedOwner = [...owners].find((owner) => mentionsByOwner.get(owner)?.has(hit))
      if (!namedOwner) continue
      if (!coupledMap.has(hit)) coupledMap.set(hit, new Set())
      coupledMap.get(hit).add(key)
    }
  }

  const tripwires = [...tripwireMap.entries()]
    .map(([file, keys]) => ({ file, keys: [...keys].sort() }))
    .sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
  const coupled = [...coupledMap.entries()]
    .map(([file, keys]) => ({ file, keys: [...keys].sort() }))
    .sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
  const candidateSet = new Set(sourceFiles.map(({ file }) => file))
  for (const tripwire of tripwires) candidateSet.add(tripwire.file)
  // candidates feeds proposeTier, where sourceCount = candidates −
  // tripwireFiles drives the ratified tier bands; adding coupled sources would
  // silently raise tiers, and this lane may not change that ratified rule.
  // Coupling therefore gets its own rendered section.
  const result = {
    candidates: [...candidateSet].sort(),
    tripwires,
    broadKeys: broadKeys.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    coupled,
  }
  // Keep the complete key register available to the pure renderer without
  // changing the documented enumerable return fields.
  Object.defineProperty(result, 'keys', { value: [...allKeys].sort(), enumerable: false })
  return result
}

function colourNeutralEnv(base = process.env) {
  // Copied from crew/seat-io.mjs:1304 rather than imported: crew/ is a separate
  // lane, and this compiler must keep the #240 child-environment rule local.
  const env = { ...base }
  delete env.FORCE_COLOR
  delete env.CLICOLOR_FORCE
  // A compiler invoked by node --test inherits this worker marker; leaving it
  // in place makes the target's own node --test invocation recurse and emit
  // no summary. It is runner control state, not a lane credential.
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_TEST_WORKER_ID
  env.NO_COLOR = '1'
  return env
}

export function gatherProfile({ checkout, profilePath, factoryRoot, requireProfile = false } = {}) {
  let path = null
  let located = 'none'
  if (profilePath != null) {
    path = resolve(profilePath)
    located = 'flag'
  } else {
    try {
      path = resolve(defaultProfilePath({ repoKey: repoKeyFor({ checkout }), factoryRoot }))
      located = 'default-path'
    } catch (err) {
      if (!(err instanceof ProbeUsageError)) throw err
      if (requireProfile) {
        refuseUsage(`cannot resolve the default profile path for checkout ${resolve(checkout || process.cwd())}`, PROFILE_UNREADABLE)
      }
      return { path: null, profile: null, reason: PROFILE_UNREADABLE, located: 'none' }
    }
  }

  try {
    const profile = readProfile(path)
    if (profile == null) {
      if (requireProfile) refuseUsage(`profile is unreadable at ${path}`, PROFILE_UNREADABLE)
      return { path, profile: null, reason: PROFILE_UNREADABLE, located }
    }
    return { path, profile, reason: null, located }
  } catch (err) {
    if (!(err instanceof ProbeUsageError)) throw err
    if (requireProfile) refuseUsage(`profile is unreadable at ${path}`, PROFILE_UNREADABLE)
    return { path, profile: null, reason: PROFILE_UNREADABLE, located }
  }
}

export function profileField(profileResult, name) {
  const result = profileResult || {}
  const path = result.path || null
  const profile = result.profile || null
  if (!profile) {
    const reason = result.reason || PROFILE_UNREADABLE
    const basis = path
      ? `no profile at ${path} (${reason})`
      : 'no profile path could be resolved'
    return { used: false, value: null, basis, reason }
  }
  try {
    const value = requireField(profile, name)
    return {
      used: true,
      value,
      basis: `ratified profile field ${name} · ${path}`,
      reason: null,
    }
  } catch (err) {
    if (!(err instanceof ProfileRefusal)) throw err
    const status = profile?.fields?.[name]?.status ?? 'absent'
    if (err.reason === 'profile-ratification-refused') {
      return {
        used: false,
        value: null,
        recorded: profile?.fields?.[name]?.value,
        basis: `profile field ${name} is ratified but commit-scoped, so a direct read refuses it · ${path}`,
        reason: err.reason,
      }
    }
    if (err.reason === 'profile-ratification-invalid') {
      return {
        used: false,
        value: null,
        basis: `profile field ${name} is ratified but invalid · ${path}`,
        reason: err.reason,
      }
    }
    return {
      used: false,
      value: null,
      basis: `profile field ${name} is ${status}, not ratified · ${path}`,
      reason: err.reason,
    }
  }
}

function unknownBaseline(lane, reason, laneBasis = 'package.json scripts.test') {
  return {
    lane: lane || null,
    pass: null,
    fail: null,
    status: 'unknown',
    reason,
    laneBasis,
  }
}

export function gatherBaseline({ checkout, lane = null, laneBasis = null } = {}) {
  const root = resolve(checkout || process.cwd())
  const basis = nonEmptyString(laneBasis) ? laneBasis : 'package.json scripts.test'
  let selectedLane = nonEmptyString(lane) ? lane : null
  if (!selectedLane) {
    let packageData
    try {
      packageData = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    } catch {
      return unknownBaseline(null, 'bad-package-json', basis)
    }
    selectedLane = packageData && packageData.scripts && packageData.scripts.test
    if (typeof selectedLane !== 'string' || !selectedLane.trim()) {
      return unknownBaseline(null, 'no-test-script', basis)
    }
  }

  let result
  try {
    result = spawnSync('/bin/sh', ['-c', selectedLane], {
      cwd: root,
      encoding: 'utf8',
      env: colourNeutralEnv(),
      timeout: BASELINE_TIMEOUT_MS,
    })
  } catch {
    return unknownBaseline(selectedLane, 'spawn-error', basis)
  }
  if (!result || result.error) {
    const timeout = result && (result.signal === 'SIGTERM' || result.error?.code === 'ETIMEDOUT')
    return unknownBaseline(selectedLane, timeout ? 'timeout' : 'spawn-error', basis)
  }
  if (result.signal) return unknownBaseline(selectedLane, 'timeout', basis)

  const output = `${result.stdout || ''}\n${result.stderr || ''}`.replace(ANSI_CSI, '')
  const passMatch = output.match(/^\s*(?:ℹ\s*)?pass\s+(\d+)\s*$/m)
  const failMatch = output.match(/^\s*(?:ℹ\s*)?fail\s+(\d+)\s*$/m)
  if (!passMatch || !failMatch) return unknownBaseline(selectedLane, 'missing-summary', basis)
  const pass = Number(passMatch[1])
  const fail = Number(failMatch[1])
  if (fail > 0) return { lane: selectedLane, pass, fail, status: 'red', reason: null, laneBasis: basis }
  if (result.status !== 0) return { lane: selectedLane, pass, fail, status: 'unknown', reason: 'nonzero-exit', laneBasis: basis }
  return { lane: selectedLane, pass, fail, status: 'green', reason: null, laneBasis: basis }
}

export function gatherFences({ fencesPath, checkout } = {}) {
  if (fencesPath == null) return null
  let data
  try {
    data = JSON.parse(readFileSync(resolve(fencesPath), 'utf8'))
  } catch {
    refuseUsage(`cannot read or parse fences file: ${fencesPath}`, BAD_FENCES)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some((key) => key !== 'lanes')) {
    refuseUsage('fences must contain only a lanes array', BAD_FENCES)
  }
  if (!Array.isArray(data.lanes)) refuseUsage('fences.lanes must be an array', BAD_FENCES)
  const lanes = data.lanes.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      refuseUsage(`fences.lanes[${index}] must be an object`, BAD_FENCES)
    }
    if (!nonEmptyString(entry.lane) || !Array.isArray(entry.files)) {
      refuseUsage(`fences.lanes[${index}] must contain lane and files`, BAD_FENCES)
    }
    if (entry.files.some((file) => typeof file !== 'string' || !file.trim())) {
      refuseUsage(`fences.lanes[${index}].files must contain non-blank strings`, BAD_FENCES)
    }
    const unknown = Object.keys(entry).filter((key) => !['lane', 'files', 'reads', 'external'].includes(key))
    if (Object.hasOwn(entry, 'external') && entry.external !== true) {
      refuseUsage(`fences.lanes[${index}] external must be true or absent, found ${JSON.stringify(entry.external)}`, BAD_FENCES)
    }
    if (unknown.length > 0) refuseUsage(`fences.lanes[${index}] has unknown keys`, BAD_FENCES)
    let reads = []
    if (Object.prototype.hasOwnProperty.call(entry, 'reads')) {
      if (!Array.isArray(entry.reads)) refuseUsage(`fences.lanes[${index}].reads must be an array`, BAD_FENCES)
      const seen = new Set()
      reads = entry.reads.map((read, readIndex) => {
        if (!read || typeof read !== 'object' || Array.isArray(read)) {
          refuseUsage(`fences.lanes[${index}].reads[${readIndex}] must be an object`, BAD_FENCES)
        }
        const readUnknown = Object.keys(read).filter((key) => key !== 'file' && key !== 'why')
        if (readUnknown.length > 0) {
          refuseUsage(`fences.lanes[${index}].reads[${readIndex}] has unknown keys`, BAD_FENCES)
        }
        if (!nonEmptyString(read.file)) {
          refuseUsage(`fences.lanes[${index}].reads[${readIndex}].file must be a non-blank string`, BAD_FENCES)
        }
        if (!nonEmptyString(read.why)) {
          refuseUsage(`fences.lanes[${index}].reads[${readIndex}].why must be a non-blank string`, BAD_FENCES)
        }
        const file = normaliseRepoPath(read.file)
        if (seen.has(file)) {
          refuseUsage(`fences.lanes[${index}].reads contains duplicate file: ${file}`, BAD_FENCES)
        }
        seen.add(file)
        return { file, why: read.why }
      }).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
    }
    // #537: the register's sibling surfaces BECOME the runtime deny list
    // (laneFenceFor -> crew.mjs boot -> lane_fence in crew.json), so an entry the
    // matcher cannot read denies nothing at all. Validating here, not at the
    // caller, is what makes compile and boot agree: both readers of this register
    // go through this function and nothing else. `reads` entries are
    // acknowledgements, never a deny surface, and are deliberately not validated.
    validateScopeEntries({
      checkout,
      files: entry.files,
      context: `fences.lanes[${index}] (lane "${entry.lane}")`,
    })
    return { lane: entry.lane, files: [...new Set(entry.files)].sort(), reads }
  })
  return lanes.sort((a, b) => a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0)
}

// Check 2: an entry that resolves to an existing directory can ONLY be satisfied
// by the trailing slash scopeMatcher requires (crew/drive.mjs:997); without it the
// driver compares it as an exact file path and every file under it falls out of
// scope — #145 attempt 3 died there with a gate-green tree. The matching rule is
// correct; the silence was the defect, so this refuses at compile time.
// Check 3: the matcher compares STRINGS (crew/protected-paths.mjs:45-47), so
// an entry whose on-disk spelling differs only in case matches nothing git
// ever prints. Resolved segment by segment with readdirSync so the verdict is
// identical on a case-insensitive (macOS) and a case-sensitive (Linux CI)
// filesystem: realpathSync.native silently CORRECTS the spelling on one and
// throws ENOENT on the other. A segment nothing matches at all is a file the
// lane is about to create, and is not this check's business.
function onDiskSpelling(root, normalised) {
  const segments = normalised.replace(/\/+$/, '').split('/').filter(Boolean)
  let dir = root
  for (let i = 0; i < segments.length; i += 1) {
    let names
    try { names = readdirSync(dir) } catch { return null }
    if (names.includes(segments[i])) { dir = resolve(dir, segments[i]); continue }
    const lower = segments[i].toLowerCase()
    const actual = names.find((name) => name.toLowerCase() === lower)
    if (!actual) return null
    return [...segments.slice(0, i), actual, ...segments.slice(i + 1)].join('/')
  }
  return null
}

export function validateScopeEntries({ checkout, files = [], context = '' } = {}) {
  if (!Array.isArray(files)) refuseUsage('files_in_scope must be an array', WRONG_TYPE)
  const root = gitRoot(checkout)
  const label = context ? `${context}: ` : ''
  for (const entry of files) {
    if (typeof entry !== 'string' || !entry.trim()) {
      refuseUsage(`${label}scope entry is invalid: ${String(entry)}`, WRONG_TYPE)
    }
    if (entry !== entry.trim()) {
      refuseUsage(`${label}scope entry has leading or trailing whitespace: ${JSON.stringify(entry)}`, SCOPE_ENTRY_SHAPE)
    }
    const normalised = normaliseRepoPath(entry)
    if (/[*?[\]{}]/.test(normalised)) {
      refuseUsage(`${label}scope entry uses a glob pattern; list literal paths or a trailing-slash directory: ${entry}`, SCOPE_ENTRY_SHAPE)
    }
    if (normalised.startsWith('/')) {
      refuseUsage(`${label}scope entry is an absolute path; paths must be repo-relative, as git status prints them: ${entry}`, SCOPE_ENTRY_SHAPE)
    }
    if (normalised.split('/').some((segment) => segment === '.' || segment === '..')) {
      refuseUsage(`${label}scope entry must be a plain repo-relative path (no . or .. segments): ${entry}`, SCOPE_ENTRY_SHAPE)
    }
    const actual = onDiskSpelling(root, normalised)
    if (actual !== null) {
      refuseUsage(`${label}scope entry's on-disk spelling is ${actual}, not ${normalised} — the matcher compares strings: ${entry}`, SCOPE_ENTRY_CASE)
    }
    if (normalised === '.') continue
    if (normalised.endsWith('/')) continue
    let stat
    try { stat = statSync(resolve(root, normalised)) } catch { continue }
    if (!stat.isDirectory()) continue
    refuseUsage(`${label}scope entry resolves to a directory and can only match with a trailing slash: ${entry} (write "${normalised}/")`, SCOPE_DIRECTORY_UNSLASHED)
  }
  return files
}

export function resolveWriteSurface({ fences, lane, where = [], creates = [] } = {}) {
  if (lane == null) {
    const files = [...new Set([...where.map((entry) => normaliseRepoPath(entry.path)), ...creates.map((entry) => normaliseRepoPath(entry.path))])].sort()
    return { lane: null, basis: 'where', files, reads: [] }
  }
  if (!nonEmptyString(lane)) refuseUsage('--lane requires a value', MISSING_LINE)
  if (fences == null) {
    refuseUsage(`no fence register supplied for lane: ${lane}`, UNKNOWN_LANE)
  }
  const entry = fences.find((candidate) => candidate.lane === lane)
  if (!entry) refuseUsage(`lane is not in the fence register: ${lane}`, UNKNOWN_LANE)
  const files = [...new Set(entry.files.map((file) => normaliseRepoPath(file)))].sort()
  return { lane, basis: 'fences', files, reads: entry.reads || [] }
}

// The OTHER lanes' write surfaces, for a RUNTIME that must refuse to write what
// another live lane owns. Resolving this lane's own surface first is load-bearing:
// resolveWriteSurface refuses a missing register and an unknown lane name, so a typo
// can never resolve to "every lane is somebody else's" and fence off the whole tree.
// Returns [] when the register names only this lane. Additive: nothing above changes.
export function laneFenceFor({ fences, lane } = {}) {
  if (lane == null) refuseUsage('lane fence requires a lane name', MISSING_LINE)
  if (!Array.isArray(fences)) refuseUsage(`no fence register supplied for lane: ${lane}`, UNKNOWN_LANE)
  resolveWriteSurface({ fences, lane })
  return fences
    .filter((entry) => entry.lane !== lane)
    .map((entry) => ({
      lane: entry.lane,
      files: [...new Set(entry.files.map((file) => normaliseRepoPath(file)))].sort(),
    }))
    .sort((a, b) => (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0))
}

function normaliseCoupledEntries(discovery) {
  if (!Array.isArray(discovery?.coupled)) return null
  const entries = new Map()
  for (const entry of discovery.coupled) {
    if (!entry || typeof entry !== 'object' || !nonEmptyString(entry.file)) continue
    const file = normaliseRepoPath(entry.file)
    const keys = Array.isArray(entry.keys)
      ? [...new Set(entry.keys.filter((key) => typeof key === 'string' && key.length > 0))].sort()
      : []
    if (!entries.has(file)) entries.set(file, { file, keys })
    else entries.get(file).keys = [...new Set([...entries.get(file).keys, ...keys])].sort()
  }
  return [...entries.values()].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
}

// One derivation, two callers (#737): the refusal below and --discover-reads both read the fence partition from here, so the dispatcher never re-implements what a coupled source is.
function partitionCoupling({ discovery, writeSurface } = {}) {
  const coupled = normaliseCoupledEntries(discovery)
  const records = coupled == null
    ? null
    : coupled.map((entry) => ({ ...entry, status: 'no-fence' }))
  if (writeSurface?.basis !== 'fences') {
    return { records, inFence: [], acknowledged: [], unfenced: [], stale: [] }
  }

  const fenceFiles = new Set(Array.isArray(writeSurface.files)
    ? writeSurface.files.map((file) => normaliseRepoPath(file))
    : [])
  const reads = Array.isArray(writeSurface.reads) ? writeSurface.reads : []
  const readsByFile = new Map()
  for (const read of reads) {
    if (!read || typeof read !== 'object' || !nonEmptyString(read.file)) continue
    readsByFile.set(normaliseRepoPath(read.file), read)
  }
  const inFence = []
  const acknowledged = []
  const unfenced = []
  for (const entry of records || []) {
    const record = { ...entry }
    if (fenceFiles.has(entry.file)) {
      record.status = 'in-fence'
      inFence.push(record)
    } else if (readsByFile.has(entry.file)) {
      record.status = 'acknowledged'
      record.why = readsByFile.get(entry.file).why
      acknowledged.push(record)
    } else {
      record.status = 'unfenced'
      unfenced.push(record)
    }
  }
  const coupledOutsideFence = new Set([...acknowledged, ...unfenced].map(({ file }) => file))
  const stale = reads
    .filter((read) => read && typeof read === 'object' && nonEmptyString(read.file))
    .map((read) => ({ file: normaliseRepoPath(read.file), why: read.why }))
    .filter((read) => !coupledOutsideFence.has(read.file))
    .sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)

  return { records, inFence, acknowledged, unfenced, stale }
}

export function crossCheckCoupling({ discovery, writeSurface, enforce = true } = {}) {
  const { records, inFence, acknowledged, unfenced, stale } = partitionCoupling({ discovery, writeSurface })
  if (writeSurface?.basis !== 'fences') {
    // compileIntakeBrief supplies `fences: null, lane: null`: its write
    // surface is authored `where`, so no fence exists for coupling to
    // contradict. Rendering is informative; refusing would break #52's
    // shipped intake loop.
    return {
      enforced: false,
      coupled: records,
      in_fence: [],
      acknowledged: [],
      unfenced: [],
      stale: [],
    }
  }

  const result = {
    enforced: enforce !== false,
    coupled: records == null ? null : [
      ...inFence,
      ...acknowledged,
      ...unfenced,
    ].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
    in_fence: inFence.map(({ file }) => file),
    acknowledged: acknowledged.map(({ file, why }) => ({ file, why })),
    unfenced: unfenced.map(({ file }) => file),
    stale,
  }
  if (enforce !== false && stale.length > 0) {
    refuseUsage(`stale read acknowledgement(s): ${stale.map((read) => read.file).join(', ')}`, STALE_READ_ACK)
  }
  if (enforce !== false && unfenced.length > 0) {
    const details = unfenced
      .map((entry) => `${entry.file} · ${entry.keys.join(', ')}`)
      .join('; ')
    refuseUsage(`coupled source(s) outside lane fence: ${details}`, COUPLED_SOURCE_UNFENCED)
  }
  return result
}

export function coupledReadWhy(lane) {
  return `compiler reported a coupled source while compiling lane ${lane}`
}

// The reads a lane must acknowledge: exactly the records the
// coupled-source-unfenced refusal names, as {file, why} register entries.
export function readsToAcknowledge({ discovery, writeSurface } = {}) {
  const { unfenced } = partitionCoupling({ discovery, writeSurface })
  return unfenced.map(({ file }) => ({ file, why: coupledReadWhy(writeSurface?.lane ?? null) }))
}

function normaliseProtectedPaths(protectedPaths) {
  if (!Array.isArray(protectedPaths)) {
    refuseUsage('protectedPaths must be an array', BAD_PROTECTED)
  }
  const paths = protectedPaths.map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      refuseUsage(`protectedPaths[${index}] must be a non-blank string`, BAD_PROTECTED)
    }
    return normaliseRepoPath(entry)
  })
  return [...new Set(paths)].sort()
}

export function gatherProtectedPaths({ protectedPathsFile, extra = [] } = {}) {
  let fileEntries = []
  if (protectedPathsFile != null) {
    let data
    try {
      data = JSON.parse(readFileSync(resolve(protectedPathsFile), 'utf8'))
    } catch {
      refuseUsage(`cannot read or parse protected paths file: ${protectedPathsFile}`, BAD_PROTECTED)
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some((key) => key !== 'paths')) {
      refuseUsage('protected paths must contain only a paths array', BAD_PROTECTED)
    }
    if (!Array.isArray(data.paths)) refuseUsage('protected paths must contain a paths array', BAD_PROTECTED)
    fileEntries = normaliseProtectedPaths(data.paths)
  }
  return resolveProtectedPaths([...fileEntries, ...extra])
}

function proposalTierAfterRaise(tier) {
  const index = TIER_NAMES.indexOf(tier)
  return index === -1 || index === TIER_NAMES.length - 1 ? tier : TIER_NAMES[index + 1]
}

function proposalBand(sourceCount) {
  if (sourceCount <= MECHANICAL_MAX_SOURCES) return { band: '1', tier: 'mechanical' }
  if (sourceCount <= BUILD_MAX_SOURCES) return { band: '2-4', tier: 'build' }
  return { band: '≥5', tier: 'judge' }
}

function proposeShape(protectedHits) {
  if (protectedHits.length === 0) {
    return { shape: 'mechanical', reasons: ['risk signal · protected-path hits: none — shape mechanical'] }
  }
  if (protectedHits.length < JUDGE_PROTECTED_FLOOR) {
    return { shape: 'build', reasons: [`risk signal · protected path hit: ${protectedHits.join(', ')} — shape build`] }
  }
  return {
    shape: 'judge',
    reasons: [`risk signal · ${protectedHits.length} protected path hits: ${protectedHits.join(', ')} — shape judge`],
  }
}

// #291 step 3: `mechanical` has no reinforced column. A mechanical SHAPE priced
// above the mechanical column is a MISCLASSIFICATION, not a cheap reinforcement:
// the compiler says so and asks for the shape to be reproposed. It rewrites
// neither proposal — "a tier is proposed, never decided".
const MISCLASSIFIED_PREFIX = 'misclassified · shape mechanical has no reinforced column'

// MUTATION M2: widen this guard and the note stops discriminating — it becomes
// a line every reinforced brief carries.
// MUTATION M1: invert the column comparison and a mechanical shape priced
// frontier carries no note at all.
function noteMisclassification(shape, strength, complexityTier) {
  if (shape !== 'mechanical' || strength == null) return null
  if (strength === STRENGTH_BY_COMPLEXITY.mechanical) return null
  return `${MISCLASSIFIED_PREFIX}: complexity ${complexityTier} prices ${strength} — repropose the shape`
}

function proposeStrength(complexityTier, signals, ladderBands) {
  const band = STRENGTH_BY_COMPLEXITY[complexityTier] ?? null
  const reasons = [
    `complexity signal · scope breadth: ${signals.sourceCount} source file(s) named by where`,
    `complexity signal · tripwire tests pinning that scope: ${signals.tripwireCount}`,
    `complexity signal · directory where: ${signals.directoryWhere.length ? signals.directoryWhere.join(', ') : 'none'}`,
  ]
  if (band == null || !ladderBands.includes(band)) {
    return { strength: null, reasons: [...reasons, `no ratified ladder band for complexity ${complexityTier} — proposing none`] }
  }
  return { strength: band, reasons: [...reasons, `complexity ${complexityTier} → ratified ladder band ${band}`] }
}

// The three absence cases propose NEITHER and say why, rather than defaulting.
function absentProposal(reasons, signals) {
  return {
    tier: null, shape: null, strength: null,
    reasons, shapeReasons: [...reasons], strengthReasons: [...reasons], signals,
    misclassification: null,
  }
}

export function proposeTier({ where, discovery, protectedPaths = DEFAULT_PROTECTED_PATHS, protectedBasis = null, ladderBands = LADDER_BANDS } = {}) {
  const normalised = normaliseProtectedPaths(protectedPaths)
  const protectedEntries = resolveProtectedPaths(normalised)
  const basisReason = `protected paths in force: ${protectedEntries.length}${protectedBasis ? ` · ${protectedBasis}` : ' · authored floor (no profile basis supplied)'}`
  const verifiedWhere = Array.isArray(where)
    ? where.filter((entry) => entry && typeof entry === 'object'
      && typeof entry.path === 'string'
      && ['file', 'directory'].includes(entry.kind))
    : []
  if (verifiedWhere.length === 0) {
    return absentProposal(
      [basisReason, 'no verified where entries — nothing to measure'],
      {
        sourceCount: 0,
        tripwireCount: 0,
        directoryWhere: [],
        protectedHits: [],
        suppressedKeys: [],
      },
    )
  }

  const sourceDiscovery = discovery && typeof discovery === 'object' ? discovery : {}
  const candidates = Array.isArray(sourceDiscovery.candidates)
    ? [...new Set(sourceDiscovery.candidates
      .filter((candidate) => typeof candidate === 'string')
      .map((candidate) => normaliseRepoPath(candidate)))]
      .sort()
    : []
  if (candidates.length === 0) {
    return absentProposal(
      [basisReason, 'discovery produced no scope candidates'],
      {
        sourceCount: 0,
        tripwireCount: 0,
        directoryWhere: [...new Set(verifiedWhere
          .filter((entry) => entry.kind === 'directory')
          .map((entry) => entry.path))].sort(),
        protectedHits: [],
        suppressedKeys: [],
      },
    )
  }

  const tripwires = Array.isArray(sourceDiscovery.tripwires) ? sourceDiscovery.tripwires : []
  const broadKeys = Array.isArray(sourceDiscovery.broadKeys) ? sourceDiscovery.broadKeys : []
  const tripwireFiles = new Set(tripwires
    .filter((tripwire) => tripwire && typeof tripwire.file === 'string')
    .map((tripwire) => normaliseRepoPath(tripwire.file)))
  const sourceCount = candidates.filter((candidate) => !tripwireFiles.has(candidate)).length
  const directoryWhere = [...new Set(verifiedWhere
    .filter((entry) => entry.kind === 'directory')
    .map((entry) => entry.path))].sort()
  const suppressedKeys = [...new Set(broadKeys
    .map((entry) => typeof entry === 'string' ? entry : entry && entry.key)
    .filter((key) => typeof key === 'string'))].sort()
  const signals = {
    sourceCount,
    tripwireCount: tripwires.length,
    directoryWhere,
    protectedHits: [],
    suppressedKeys,
  }

  if (tripwires.length === 0 && broadKeys.length > 0) {
    return absentProposal(
      [basisReason, `breadth is unmeasured: 0 tripwire tests found while ${broadKeys.length} key(s) exceeded the broad-key limit — absent, not zero`],
      signals,
    )
  }

  const { band, tier: baseTier } = proposalBand(sourceCount)
  let tier = baseTier
  const reasons = [
    basisReason,
    `scope breadth: ${sourceCount} source file${sourceCount === 1 ? '' : 's'} named by where (${band} → ${baseTier})`,
    `tripwire tests pinning that scope: ${tripwires.length}`,
  ]

  if (baseTier === 'mechanical' && directoryWhere.length > 0) {
    tier = 'build'
    reasons.push(`directory where: ${directoryWhere.join(', ')} — raised mechanical → build`)
  }
  if (baseTier === 'mechanical' && tripwires.length >= BROAD_TRIPWIRE_FLOOR) {
    tier = 'build'
    reasons.push(`broad pinning: ${tripwires.length} tripwire tests — raised mechanical → build`)
  }

  const complexityTier = tier   // raises so far are complexity-only
  signals.protectedHits = candidates.filter((candidate) => protectedEntries.some((protectedPath) => (
    protectedPath.endsWith('/')
      ? candidate.startsWith(protectedPath)
      : candidate === protectedPath
  )))
  if (signals.protectedHits.length === 0) {
    reasons.push('protected-path hits: none')
  } else {
    const before = tier
    const raised = proposalTierAfterRaise(before)
    if (raised === before) {
      reasons.push(`protected path hit: ${signals.protectedHits.join(', ')} — tier ${before} unchanged (already highest)`)
    } else {
      tier = raised
      reasons.push(`protected path hit: ${signals.protectedHits.join(', ')} — raised ${before} → ${raised}`)
    }
  }

  const { shape, reasons: shapeReasons } = proposeShape(signals.protectedHits)
  const { strength, reasons: strengthReasons } = proposeStrength(complexityTier, signals, ladderBands)
  return {
    tier, shape, strength, reasons, shapeReasons, strengthReasons, signals,
    misclassification: noteMisclassification(shape, strength, complexityTier),
  }
}

function formatCountBasis(profileBaseline, supplied) {
  const basis = 'count basis: measured this compile — a recorded baseline is a fact about a commit and is never consumed'
  let rendered = supplied?.used === true
    ? `count basis: reused a supplied baseline — recorded sha ${supplied.sha} equals HEAD, recorded command byte-identical to the lane command, checkout clean`
    : basis
  if (supplied?.offered === true && supplied.used !== true) {
    rendered += ` (supplied baseline not reused: ${supplied.reason})`
  }
  if (profileBaseline?.recorded !== undefined) {
    const value = profileBaseline.recorded
    if (value && typeof value === 'object' && !Array.isArray(value)
      && (typeof value.passed === 'number' || typeof value.passed === 'string')) {
      return `${rendered} (profile records passed ${value.passed} in a ratified cell, refused at the read boundary as commit-scoped and not used)`
    }
    return `${rendered} (profile records a ratified baseline, refused at the read boundary as commit-scoped and not used)`
  }
  if (!profileBaseline?.used) return rendered
  const value = profileBaseline.value
  if (value && typeof value === 'object' && !Array.isArray(value)
    && (typeof value.passed === 'number' || typeof value.passed === 'string')) {
    return `${rendered} (profile records passed ${value.passed}, not used)`
  }
  return `${rendered} (profile records a ratified baseline, not used)`
}

function normaliseSourceInput(source, filePath = '') {
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    filePath = source.file || source.path || ''
    source = source.source || ''
  }
  if (filePath && typeof filePath === 'object') filePath = filePath.file || filePath.path || ''
  return { source, filePath }
}

// Line numbers were O(n²) until #892: this closure re-sliced and re-split the
// whole prefix of the source for every match, so a file with N exported symbols
// paid ~N²/2 character copies. MEASURED on this checkout, 2026-09-03, 16 cores
// at load ~3.5: one exportEntries call over a 70,000-export source cost 32.6s
// (2.40s at 20k, 0.17s at 5k — 4x the symbols for ~13.6x the time). A
// precomputed newline table with a binary search does the same 70k in 4.9ms.
// That is the whole of #892: the two ARG_MAX fixtures took 110.8s and 70.2s and
// npm test went from 35s to 218s.
function lineIndex(source) {
  const starts = [0]
  for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) starts.push(at + 1)
  return (index) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (starts[mid] <= index) low = mid
      else high = mid - 1
    }
    return low + 1
  }
}

function exportedSymbolEntries(source) {
  const entries = []
  const lineOf = lineIndex(source)
  for (const match of source.matchAll(EXPORTED_DECLARATION)) entries.push({ name: match[1], line: lineOf(match.index) })
  for (const match of source.matchAll(EXPORTED_LIST)) {
    for (const part of match[1].split(',')) {
      const item = part.trim()
      if (!item) continue
      const alias = item.match(/\bas\s+([A-Za-z_$][\w$]*)/) || item.match(/^([A-Za-z_$][\w$]*)/)
      if (alias) entries.push({ name: alias[1], line: lineOf(match.index) })
    }
  }
  return entries
}

function exportedSymbols(source) {
  return new Set(exportedSymbolEntries(source).map((entry) => entry.name))
}

function isCodeFile(filePath) {
  return !nonEmptyString(filePath)
    || CODE_EXTENSIONS.includes(extname(String(filePath)).toLowerCase())
}

export function extractSymbols(source, filePath = '') {
  ({ source, filePath } = normaliseSourceInput(source, filePath))
  if (typeof source !== 'string') refuseUsage('source must be a string', WRONG_TYPE)
  if (!isCodeFile(filePath)) return []
  const names = exportEntries(source, filePath).map((entry) => entry.name)
  return [...new Set(names)].filter((key) => key.length >= 4).sort()
}

export function exportEntries(source, filePath = '') {
  ({ source, filePath } = normaliseSourceInput(source, filePath))
  if (typeof source !== 'string') refuseUsage('source must be a string', WRONG_TYPE)
  if (!isCodeFile(filePath)) return []
  return exportedSymbolEntries(source).sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export function testTitleEntries(source, filePath = '') {
  ({ source, filePath } = normaliseSourceInput(source, filePath))
  if (typeof source !== 'string') refuseUsage('source must be a string', WRONG_TYPE)
  if (!isCodeFile(filePath)) return []
  const entries = []
  const titleLineOf = lineIndex(source)
  for (const match of source.matchAll(TEST_TITLE)) {
    entries.push({ title: match[2] ?? match[3], line: titleLineOf(match.index) })
  }
  return entries
}

const TEST_TITLE = /\b(test|describe|it)\s*\(\s*(?:'([^'\n]*)'|"([^"\n]*)")/g
export const SYMBOL_INDEX_ENTRY_LIMIT = 200
// The per-file cap on entries actually INDEXED. #869 bounded the REPORT
// (SYMBOL_INDEX_ENTRY_LIMIT above); this bounds the scan behind it, and every
// entry past it is RECORDED as skipped, never silently dropped — the same
// discipline as the "… and K more" line.
// MEASURED on this checkout, 2026-09-03, over every tracked .mjs/.js: the
// largest index-entry count is 576 (crew/drive.test.mjs), then 320
// (crew/crew.test.mjs), 306 (test/factory-ledger.test.mjs), 204 (crew/drive.mjs).
// The largest fixture the suite builds needs 402. 2000 is 3.5x the largest real
// file and 5x the largest fixture, and holds a per-file sidecar row under ~33KB.
// It is chosen to be unreachable by any real fence and reachable only by the
// pathological 70,000-symbol ARG_MAX fixtures, which are exactly what it is for.
export const SYMBOL_INDEX_SCAN_LIMIT = 2000

function boundedIndexEntries(all, limit) {
  return { entries: all.slice(0, limit), skipped: Math.max(0, all.length - limit) }
}

export const SYMBOL_INDEX_ABSENT_REASONS = Object.freeze(['unreadable', 'not-text'])

export function extractKeys(source, filePath = '') {
  ({ source, filePath } = normaliseSourceInput(source, filePath))
  if (typeof source !== 'string') refuseUsage('source must be a string', WRONG_TYPE)
  const keys = new Set()
  if (nonEmptyString(filePath)) keys.add(normaliseRepoPath(filePath))
  if (isCodeFile(filePath)) {
    for (const symbol of exportedSymbols(source)) keys.add(symbol)
    addQuotedKeys(source, keys)
  }
  return [...keys].filter((key) => key.length >= 4).sort()
}

function trackedFiles(checkout) {
  let result
  try {
    result = spawnSync('git', ['-C', checkout, 'ls-files', '-z', '--', '.'], {
      encoding: 'utf8',
      timeout: 30_000,
    })
  } catch {
    refuseUsage('cannot list tracked files for tripwire keys', NOT_A_GIT_REPO)
  }
  if (!result || result.status !== 0) {
    refuseUsage('cannot list tracked files for tripwire keys', NOT_A_GIT_REPO)
  }
  return String(result.stdout || '')
    .split('\0')
    .map((file) => normaliseRepoPath(file))
    .filter(Boolean)
}

function trackedFileText(checkout, file) {
  const target = resolve(checkout, file)
  let metadata
  try { metadata = lstatSync(target) } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    refuseUsage(`cannot inspect tracked file for tripwire keys: ${file}`, MISSING_PATH)
  }
  // git grep ignores symlinks, gitlinks, and every other non-regular entry.
  if (!metadata.isFile()) return null
  try { return readFileSync(target, 'utf8') } catch (error) {
    // A regular entry can disappear or become a directory after lstatSync.
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EISDIR') return null
    refuseUsage(`cannot read tracked file for tripwire keys: ${file}`, MISSING_PATH)
  }
}

function keyMatcher(keys) {
  const root = { next: new Map(), failure: null, output: null, keys: [] }
  for (const key of keys) {
    let node = root
    for (let index = 0; index < key.length; index += 1) {
      const character = key[index]
      if (!node.next.has(character)) node.next.set(character, { next: new Map(), failure: null, output: null, keys: [] })
      node = node.next.get(character)
    }
    node.keys.push(key)
  }
  const queue = []
  for (const node of root.next.values()) {
    node.failure = root
    queue.push(node)
  }
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index]
    for (const [character, child] of node.next) {
      let failure = node.failure
      while (failure !== root && !failure.next.has(character)) failure = failure.failure
      child.failure = failure.next.get(character) || root
      child.output = child.failure.keys.length > 0 ? child.failure : child.failure.output
      queue.push(child)
    }
  }
  return (source) => {
    const found = new Set()
    let node = root
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index]
      while (node !== root && !node.next.has(character)) node = node.failure
      node = node.next.get(character) || root
      for (let match = node; match !== null; match = match.output) {
        for (const key of match.keys) found.add(key)
      }
    }
    return found
  }
}

function grepHitsForKeys(checkout, keys) {
  // Generated modules can put one `-e` per key past ARG_MAX; scan the tracked
  // files once in-process so a failed exec can never become an empty discovery.
  const wanted = [...new Set(keys.filter((key) => typeof key === 'string' && key.length > 0))]
  if (wanted.length === 0) return new Map()
  const hits = new Map(wanted.map((key) => [key, new Set()]))
  const match = keyMatcher(wanted)
  for (const file of trackedFiles(checkout)) {
    const contents = trackedFileText(checkout, file)
    if (contents === null) continue
    for (const key of match(contents)) hits.get(key).add(file)
  }
  return new Map([...hits].map(([key, paths]) => [key, [...paths].sort()]))
}

const BASELINE_UNREADABLE = 'unreadable-baseline'
const BASELINE_MALFORMED = 'malformed-baseline'

export function resolveBaselineCommand({ checkout, lane = null } = {}) {
  if (nonEmptyString(lane)) return lane
  let packageData
  try {
    packageData = JSON.parse(readFileSync(join(resolve(checkout || process.cwd()), 'package.json'), 'utf8'))
  } catch {
    return null
  }
  const command = packageData?.scripts?.test
  return nonEmptyString(command) ? command : null
}

export function gitState({ checkout } = {}) {
  let root
  try { root = resolve(checkout || process.cwd()) } catch { return { sha: null, clean: null } }
  let sha = null
  try {
    const result = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      env: colourNeutralEnv(),
      timeout: 10_000,
    })
    const value = result?.status === 0 && !result.error ? String(result.stdout || '').trim() : ''
    if (/^[0-9a-f]{7,64}$/.test(value)) sha = value
  } catch { /* an unavailable probe leaves sha unknown */ }

  let clean = null
  try {
    const result = spawnSync('git', ['-C', root, 'status', '--porcelain'], {
      encoding: 'utf8',
      env: colourNeutralEnv(),
      timeout: 10_000,
    })
    if (result?.status === 0 && !result.error) clean = String(result.stdout || '').trim().length === 0
  } catch { /* an unavailable probe leaves cleanliness unknown */ }
  return { sha, clean }
}

export function readSuppliedBaseline(path) {
  let data
  try {
    data = JSON.parse(readFileSync(resolve(path), 'utf8'))
  } catch {
    return { value: null, reason: BASELINE_UNREADABLE }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || !nonEmptyString(data.sha) || !nonEmptyString(data.command)
    || !Number.isInteger(data.pass) || data.pass < 0
    || !Number.isInteger(data.fail) || data.fail < 0) {
    return { value: null, reason: BASELINE_MALFORMED }
  }
  return {
    value: { sha: data.sha, command: data.command, pass: data.pass, fail: data.fail },
    reason: null,
  }
}

export function reuseBaseline({ checkout, command, laneBasis, path } = {}) {
  const reject = (reason) => ({
    baseline: null,
    supplied: { offered: true, used: false, reason },
  })
  if (path == null) return { baseline: null, supplied: { offered: false, used: false, reason: null } }
  const read = readSuppliedBaseline(path)
  if (!read.value) return reject(read.reason)
  const supplied = read.value
  const state = gitState({ checkout })
  if (state.clean !== true) return reject(state.clean === null ? 'status-unavailable' : 'dirty-tree')
  if (state.sha == null) return reject('sha-unavailable')
  if (supplied.sha !== state.sha) return reject('sha-mismatch')
  if (!nonEmptyString(command) || supplied.command !== command) return reject('command-mismatch')
  return {
    baseline: {
      lane: supplied.command,
      pass: supplied.pass,
      fail: supplied.fail,
      status: supplied.fail > 0 ? 'red' : 'green',
      reason: null,
      laneBasis,
      reused: true,
    },
    supplied: { offered: true, used: true, reason: null, sha: supplied.sha },
  }
}

export function laneFromProfile(testCommand) {
  const lane = testCommand.used && nonEmptyString(testCommand.value)
    ? testCommand.value
    : null
  const laneBasis = testCommand.used && lane == null
    ? `package.json scripts.test — ${testCommand.basis} (value is not a non-blank string)`
    : testCommand.used
      ? testCommand.basis
      : `package.json scripts.test — ${testCommand.basis}`
  return { lane, laneBasis }
}

function formatBaseline(baseline, profile = null, supplied = null) {
  const lane = baseline.lane || '(no test lane)'
  const line = baseline.status === 'unknown'
    ? `lane: ${lane} · unknown · reason: ${baseline.reason}`
    : `lane: ${lane} · pass ${baseline.pass} · fail ${baseline.fail} · status: ${baseline.status}`
  const laneBasis = baseline.laneBasis
    || profile?.testCommand?.basis
    || 'package.json scripts.test — no profile consulted'
  return `${line}\nlane basis: ${laneBasis}\n${formatCountBasis(profile?.baseline, supplied)}`
}

function keyList(discovery) {
  const keys = new Set(discovery.keys || [])
  for (const tripwire of discovery.tripwires || []) {
    for (const key of tripwire.keys || []) keys.add(key)
  }
  for (const broad of discovery.broadKeys || []) {
    keys.add(typeof broad === 'string' ? broad : broad.key)
  }
  return [...keys].filter(Boolean).sort()
}

function generatedGrep(discovery) {
  const keys = keyList(discovery)
  return `grep -rn "${keys.join('\\|')}" crew/ test/ scripts/ docs/`
}

function renderWhere(where, creates = []) {
  return [
    ...where.map((entry) => `verified · ${entry.kind} · ${entry.path}`),
    ...creates.map((entry) => `declared · created · ${entry.path}`),
  ].join('\n')
}

function renderTripwires(discovery) {
  const lines = []
  lines.push(`candidates: ${discovery.candidates.length ? discovery.candidates.join(', ') : '(none)'}`)
  lines.push('tripwire tests:')
  if (discovery.tripwires.length === 0) lines.push('- (none discovered)')
  for (const tripwire of discovery.tripwires) {
    lines.push(`- ${tripwire.file} · ${tripwire.keys.join(', ')}`)
  }
  lines.push('broad keys (not used as tripwires):')
  if (discovery.broadKeys.length === 0) lines.push('- (none)')
  for (const broad of discovery.broadKeys) {
    const key = typeof broad === 'string' ? broad : broad.key
    const count = typeof broad === 'string' ? '?' : broad.count
    lines.push(`- ${key} · ${count} hits`)
  }
  lines.push(`declare every hit: ${generatedGrep(discovery)}`)
  return lines.join('\n')
}

// The coupling bound is a floor, not a proof: grep cannot see dynamic,
// string-built, or renamed couplings.
function renderCoupled(coupling) {
  const lines = [
    'coupling rule: a coupled source is a non-test .js/.mjs file that names an exported symbol of a where file and names that file; a key-based grep sees a coupling only when both sides share a named symbol, so this is a floor, not a proof (dynamic, string-built, or renamed couplings are invisible); a non-test code file which only CITES a where/fence path by repo path or basename, for example in a comment, is coupled too, and a citation key over the broad-key limit is reported as broad rather than coupled.',
  ]
  if (!coupling || coupling.coupled == null) {
    lines.push('- (not discovered — this caller supplied no coupling discovery)')
    return lines.join('\n')
  }
  if (coupling.coupled.length === 0) {
    lines.push('- (none discovered)')
    return lines.join('\n')
  }
  const acknowledgements = new Map((coupling.acknowledged || [])
    .filter((entry) => entry && typeof entry.file === 'string')
    .map((entry) => [normaliseRepoPath(entry.file), entry.why]))
  for (const entry of coupling.coupled) {
    const keys = Array.isArray(entry.keys) && entry.keys.length ? entry.keys.join(', ') : '(none)'
    let status = 'no fence in play'
    if (entry.status === 'in-fence') status = 'inside this lane\'s fence'
    if (entry.status === 'acknowledged') {
      status = `acknowledged read-only: ${acknowledgements.get(normaliseRepoPath(entry.file)) ?? entry.why ?? ''}`
    }
    if (entry.status === 'unfenced') status = 'not in any fence (refused)'
    lines.push(`- ${entry.file} · ${keys} · ${status}`)
  }
  return lines.join('\n')
}

export function renderProposedTier(proposal) {
  const tier = proposal && TIER_NAMES.includes(proposal.tier) ? proposal.tier : null
  const reasons = proposal && Array.isArray(proposal.reasons)
    ? proposal.reasons.filter((reason) => typeof reason === 'string' && reason.length > 0)
    : []
  const shape = proposal && TIER_NAMES.includes(proposal.shape) ? proposal.shape : null
  const strength = proposal && LADDER_BANDS.includes(proposal.strength) ? proposal.strength : null
  const shapeReasons = proposal && Array.isArray(proposal.shapeReasons)
    ? proposal.shapeReasons.filter((reason) => typeof reason === 'string' && reason.length > 0)
    : []
  const strengthReasons = proposal && Array.isArray(proposal.strengthReasons)
    ? proposal.strengthReasons.filter((reason) => typeof reason === 'string' && reason.length > 0)
    : []
  const misclassification = proposal && typeof proposal.misclassification === 'string'
    && proposal.misclassification.startsWith(MISCLASSIFIED_PREFIX)
    ? proposal.misclassification
    : null
  return [
    'PROPOSAL ONLY — compiled from mechanical signals. The orchestrator confirms',
    'or overrides this at boot; the compiler never decides the tier.',
    `proposed tier: ${tier || 'no proposal'}`,
    'because:',
    ...(reasons.length ? reasons.map((reason) => `- ${reason}`) : ['- no mechanical signals were available']),
    `proposed shape: ${shape || 'no proposal'}`,
    'because (risk signals):',
    ...(shapeReasons.length ? shapeReasons.map((reason) => `- ${reason}`) : ['- no risk signals were available']),
    `proposed strength: ${strength || 'no proposal'}`,
    'because (complexity signals):',
    ...(strengthReasons.length ? strengthReasons.map((reason) => `- ${reason}`) : ['- no complexity signals were available']),
    ...(misclassification ? [misclassification] : []),
  ].join('\n')
}

// A RENDERING of signals the prose already shows — never a new input. Both
// values are filtered through the same closed vocabularies renderProposedTier
// uses, so an absent or unratified proposal renders explicit JSON null rather
// than a guess, and the bytes are a pure function of the proposal object.
export function renderProposalBlock(proposal) {
  const shape = proposal && TIER_NAMES.includes(proposal.shape) ? proposal.shape : null
  const strength = proposal && LADDER_BANDS.includes(proposal.strength) ? proposal.strength : null
  return ['```' + PROPOSAL_BLOCK, JSON.stringify({ shape, strength }, null, 2), '```'].join('\n')
}

// The plan renders in EXACTLY ONE place. `ask` and `done_means` each render twice on
// purpose and that is not changing (#657); this key exists so a plan never has to
// ride inside a field that does.
function renderDirectedPlan(plan) {
  const body = {}
  for (const key of DIRECTED_KEYS) body[key] = plan[key]
  return [DIRECTED_GATE_NOTE, '', '```' + DIRECTED_BLOCK, JSON.stringify(body, null, 2), '```'].join('\n')
}

function directedSection(plan) {
  if (!plan) return []
  return ['## Directed plan', renderDirectedPlan(plan)]
}

function renderFences(fences) {
  if (fences == null) return 'no fence register supplied (`--fences` not given)'
  const lines = []
  for (const lane of fences) {
    for (const file of lane.files) lines.push(`${lane.lane} owns ${file}`)
  }
  return lines.length ? lines.join('\n') : '(fence register is empty)'
}

function renderWriteSurface(writeSurface, discovery) {
  const files = Array.isArray(writeSurface?.files) ? writeSurface.files : []
  const listedFiles = files.length ? files.join(', ') : '(none)'
  const basis = writeSurface?.basis === 'fences'
    ? `fence register, lane "${writeSurface.lane}"`
    : 'authored where paths, no lane fence applied'
  const writable = new Set(files)
  const discovered = Array.isArray(discovery?.candidates)
    ? [...new Set(discovery.candidates.map((file) => normaliseRepoPath(file)))].sort()
    : []
  const tripwireFiles = discovered.filter((file) => !writable.has(file))
  return [
    `files_in_scope (expected write surface; basis: ${basis}): ${listedFiles}`,
    `read-and-keep-green (discovered tripwire surface — pinned by keys you touch; do not edit): ${tripwireFiles.length ? tripwireFiles.join(', ') : '(none)'}`,
  ].join('\n')
}

function renderConventions(profileConventions) {
  if (!profileConventions) {
    return 'conventions of record: (not available) — basis: no profile consulted'
  }
  if (!profileConventions.used) {
    return `conventions of record: (not available) — basis: ${profileConventions.basis}`
  }
  const files = profileConventions.value?.files
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string')) {
    return `conventions of record: (not available) — basis: ${profileConventions.basis} (value.files must be an array of strings)`
  }
  return `conventions of record (basis: ${profileConventions.basis}): ${files.length ? files.join(', ') : '(none)'}`
}

const NO_ISSUE_CITED = 'no-issue-cited'
const NO_ISSUE_BODY = 'no-issue-body-supplied'
const ISSUE_BODY_UNREADABLE = 'issue-body-unreadable'
const NO_JOURNAL_NAMED = 'no-journal-named'
const JOURNAL_UNREADABLE = 'journal-unreadable'
export const PACK_ABSENT_REASONS = Object.freeze([NO_ISSUE_CITED, NO_ISSUE_BODY, ISSUE_BODY_UNREADABLE, NO_JOURNAL_NAMED, JOURNAL_UNREADABLE])
const TREE_ENTRY_LIMIT = 40
const FIXTURE_ROW_LIMIT = 500
const ISSUE_CITATION = /#(\d{1,6})\b/
const JOURNAL_CITATION = /\/[A-Za-z0-9._\-/]+\.jsonl\b/g

function readAndKeepGreenFiles(writeSurface, discovery) {
  const writable = new Set(Array.isArray(writeSurface?.files)
    ? writeSurface.files.map((file) => normaliseRepoPath(file))
    : [])
  return (Array.isArray(discovery?.candidates) ? discovery.candidates : [])
    .map((file) => normaliseRepoPath(file))
    .filter((file, index, files) => !writable.has(file) && files.indexOf(file) === index)
    .sort()
}

function conventionsFile(discovery, writeSurface, profile) {
  const surface = renderWriteSurface(writeSurface, discovery).split('\n')[1]
    || 'read-and-keep-green (discovered tripwire surface — pinned by keys you touch; do not edit): (none)'
  return [surface, renderConventions(profile?.conventions), generatedGrep(discovery), CONVENTIONS_BLOCK].join('\n')
}

function issueFor(request, issueBodyPath) {
  const match = typeof request?.ask === 'string' ? ISSUE_CITATION.exec(request.ask) : null
  if (!match) return { number: null, body: null, reason: NO_ISSUE_CITED }
  const number = Number(match[1])
  if (typeof issueBodyPath !== 'string' || issueBodyPath.length === 0) {
    return { number, body: null, reason: NO_ISSUE_BODY }
  }
  let body
  try { body = readFileSync(resolve(issueBodyPath), 'utf8') } catch {
    return { number, body: null, reason: ISSUE_BODY_UNREADABLE }
  }
  if (typeof body !== 'string' || body.trim().length === 0) {
    return { number, body: null, reason: ISSUE_BODY_UNREADABLE }
  }
  return { number, body: body.replace(/[\r\n]+$/, ''), reason: null }
}

function journalCitations(request) {
  const citations = []
  for (const field of ['ask', 'done_means', 'out_of_scope']) {
    const text = typeof request?.[field] === 'string' ? request[field] : ''
    for (const match of text.matchAll(JOURNAL_CITATION)) citations.push(match[0])
  }
  return citations
}

function journalFor(request, packDir, taskName) {
  const citations = journalCitations(request)
  if (citations.length === 0) {
    return {
      descriptor: { path: null, rows: null, copied: 0, truncated: false, reason: NO_JOURNAL_NAMED },
      rows: null,
    }
  }
  for (const path of citations) {
    let source
    try { source = readFileSync(path, 'utf8') } catch { continue }
    const allRows = source.split('\n')
    if (allRows.at(-1) === '') allRows.pop()
    const rows = allRows.slice(0, FIXTURE_ROW_LIMIT)
    return {
      descriptor: {
        path,
        rows: allRows.length,
        copied: rows.length,
        truncated: allRows.length > FIXTURE_ROW_LIMIT,
        reason: null,
      },
      rows,
      fixture: join(packDir, 'fixtures', `${taskName}.jsonl`),
    }
  }
  return {
    descriptor: { path: citations[0], rows: null, copied: 0, truncated: false, reason: JOURNAL_UNREADABLE },
    rows: null,
  }
}

function lineCountsFor({ checkout, writeSurface, coupling }) {
  const files = []
  const seen = new Set()
  const add = (file, label) => {
    if (typeof file !== 'string' || !file.trim()) return
    const normal = normaliseRepoPath(file)
    if (seen.has(normal)) return
    seen.add(normal)
    let lines = null
    try { lines = readFileSync(resolve(checkout, normal), 'utf8').split('\n').length } catch { /* unreadable source is carried as unknown */ }
    files.push({ file: normal, lines, label })
  }
  for (const file of Array.isArray(writeSurface?.files) ? writeSurface.files : []) add(file, 'in fence')
  for (const entry of Array.isArray(coupling?.coupled) ? coupling.coupled : []) add(entry?.file, 'coupled')
  return files
}

function treeFor({ checkout, writeSurface }) {
  const directories = [...new Set((Array.isArray(writeSurface?.files) ? writeSurface.files : [])
    .filter((file) => typeof file === 'string' && file.trim())
    .map((file) => dirname(normaliseRepoPath(file).replace(/\/+$/, ''))))].sort()
  return directories.map((dir) => {
    const base = resolve(checkout, dir)
    let names
    try { names = readdirSync(base) } catch { return { dir, entries: [], more: 0 } }
    const listed = names
      .map((name) => typeof name === 'string' ? name : name?.name)
      .filter((name) => typeof name === 'string')
      .sort()
      .map((name) => {
        try { return statSync(join(base, name)).isDirectory() ? `${name}/` : name } catch { return name }
      })
    return {
      dir,
      entries: listed.slice(0, TREE_ENTRY_LIMIT),
      more: Math.max(0, listed.length - TREE_ENTRY_LIMIT),
    }
  })
}

export function symbolIndexFor({ checkout, writeSurface, coupling } = {}) {
  const rows = []
  const seen = new Set()
  const add = (file, label) => {
    if (typeof file !== 'string' || !file.trim()) return
    const normal = normaliseRepoPath(file)
    if (seen.has(normal)) return
    seen.add(normal)
    if (!CODE_EXTENSIONS.includes(extname(normal).toLowerCase())) return
    let source
    try { source = readFileSync(resolve(checkout, normal), 'utf8') } catch {
      rows.push({ file: normal, label, reason: 'unreadable', exports: [], exportsSkipped: 0, titles: [], titlesSkipped: 0 })
      return
    }
    if (source.includes(String.fromCharCode(0))) {
      rows.push({ file: normal, label, reason: 'not-text', exports: [], exportsSkipped: 0, titles: [], titlesSkipped: 0 })
      return
    }
    const exportScan = boundedIndexEntries(exportEntries(source, normal), SYMBOL_INDEX_SCAN_LIMIT)
    const titleScan = boundedIndexEntries(
      label === 'in fence' && isTripwireFile(normal) ? testTitleEntries(source, normal) : [],
      SYMBOL_INDEX_SCAN_LIMIT,
    )
    rows.push({
      file: normal,
      label,
      reason: null,
      exports: exportScan.entries,
      exportsSkipped: exportScan.skipped,
      titles: titleScan.entries,
      titlesSkipped: titleScan.skipped,
    })
  }
  for (const file of Array.isArray(writeSurface?.files) ? writeSurface.files : []) add(file, 'in fence')
  for (const entry of Array.isArray(coupling?.coupled) ? coupling.coupled : []) add(entry?.file, 'coupled')
  return rows
}

function renderSymbolSidecar(index) {
  const rows = []
  for (const entry of Array.isArray(index) ? index : []) {
    if (entry.reason !== null) {
      rows.push(`- ${entry.file} · unindexed · ${entry.reason}`)
      continue
    }
    for (const [kind, all, skipped, render] of [
      ['exports', entry.exports, entry.exportsSkipped ?? 0, (item) => `${item.name}:${item.line}`],
      ['test titles', entry.titles, entry.titlesSkipped ?? 0, (item) => `${item.title}:${item.line}`],
    ]) {
      if (all.length === 0) continue
      rows.push(`- ${entry.file} · ${kind} · ${all.map(render).join(', ')}`)
      if (skipped > 0) rows.push(`- ${entry.file} · ${kind} · ${skipped} not indexed — the per-file scan cap of ${SYMBOL_INDEX_SCAN_LIMIT} entries was reached`)
    }
  }
  return ['symbol index (full static scan):', ...rows].join('\n')
}

export function writePack({ packDir, taskName, checkout, request, discovery, writeSurface, coupling, profile, issueBodyPath } = {}) {
  const directory = resolve(packDir)
  const name = String(taskName || 'brief')
  const paths = {
    vocabulary: join(directory, `${name}.tripwires.txt`),
    rows: join(directory, `${name}.tripwires.md`),
    conventions: join(directory, `${name}.conventions.md`),
    fixture: null,
    symbols: join(directory, `${name}.symbols.md`),
  }
  const issue = issueFor(request, issueBodyPath)
  const journal = journalFor(request, directory, name)
  if (journal.fixture) {
    paths.fixture = journal.fixture
    try {
      mkdirSync(join(directory, 'fixtures'))
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  const keys = keyList(discovery)
  const keepGreen = readAndKeepGreenFiles(writeSurface, discovery)
  const lineCounts = lineCountsFor({ checkout: resolve(checkout || process.cwd()), writeSurface, coupling })
  const tree = treeFor({ checkout: resolve(checkout || process.cwd()), writeSurface })
  const symbolIndex = symbolIndexFor({ checkout: resolve(checkout || process.cwd()), writeSurface, coupling })
  writeFileSync(paths.vocabulary, `${keyList(discovery).join('\n')}\n`)
  writeFileSync(paths.rows, `${renderTripwires(discovery)}\n`)
  writeFileSync(paths.conventions, `${conventionsFile(discovery, writeSurface, profile)}\n`)
  if (symbolIndex.length > 0) {
    writeFileSync(paths.symbols, `${renderSymbolSidecar(symbolIndex)}\n`)
  } else {
    paths.symbols = null
  }
  if (paths.fixture) {
    const rows = journal.rows || []
    writeFileSync(paths.fixture, `${rows.join('\n')}\n`)
  }
  return {
    ...paths,
    counts: {
      candidates: Array.isArray(discovery?.candidates) ? discovery.candidates.length : 0,
      tripwires: Array.isArray(discovery?.tripwires) ? discovery.tripwires.length : 0,
      broadKeys: Array.isArray(discovery?.broadKeys) ? discovery.broadKeys.length : 0,
      keys: keys.length,
      readAndKeepGreen: keepGreen.length,
    },
    issue,
    journal: journal.descriptor,
    lineCounts,
    tree,
    symbolIndex,
  }
}

function renderTripwirePointer(discovery, pack) {
  if (pack == null) return renderTripwires(discovery)
  const counts = pack.counts || {}
  const paths = pack
  return [
    `tripwires: ${counts.candidates ?? 0} candidate(s) · ${counts.tripwires ?? 0} tripwire test(s) · ${counts.broadKeys ?? 0} broad key(s) · ${counts.keys ?? 0} vocabulary key(s)`,
    `vocabulary: ${paths.vocabulary} — consume it once with: grep -rn -f ${paths.vocabulary} crew/ test/ scripts/ docs/`,
    `rows: ${paths.rows} — every candidate, tripwire test with its keys, and broad key; read it once with: cat ${paths.rows}`,
  ].join('\n')
}

function renderTripwireSlot(discovery, pack) {
  return renderTripwirePointer(discovery, pack)
}

function renderConventionsPointer(writeSurface, pack) {
  if (pack == null) return renderWriteSurface(writeSurface, writeSurface?.__discovery || null)
  const files = Array.isArray(writeSurface?.files) ? writeSurface.files : []
  const listedFiles = files.length ? files.join(', ') : '(none)'
  const basis = writeSurface?.basis === 'fences'
    ? `fence register, lane "${writeSurface.lane}"`
    : 'authored where paths, no lane fence applied'
  const count = pack.counts?.readAndKeepGreen ?? 0
  return [
    `files_in_scope (expected write surface; basis: ${basis}): ${listedFiles}`,
    `conventions: ${pack.conventions} — the read-and-keep-green surface (${count} file(s)), the conventions of record, the declare-every-hit grep and the standing factory conventions; read it once with: cat ${pack.conventions}`,
  ].join('\n')
}

function renderConventionsSlot(writeSurface, pack) {
  return renderConventionsPointer(writeSurface, pack)
}

function renderSymbolIndex(pack) {
  const index = Array.isArray(pack.symbolIndex) ? pack.symbolIndex : []
  const symbolRows = []
  for (const entry of index) {
    if (entry.reason !== null) {
      symbolRows.push(`- ${entry.file} · unindexed · ${entry.reason}`)
      continue
    }
    let remaining = SYMBOL_INDEX_ENTRY_LIMIT
    for (const [kind, all, skipped, render] of [
      ['exports', entry.exports, entry.exportsSkipped ?? 0, (item) => `${item.name}:${item.line}`],
      ['test titles', entry.titles, entry.titlesSkipped ?? 0, (item) => `${item.title}:${item.line}`],
    ]) {
      if (all.length === 0) continue
      const limit = remaining
      const listed = all.slice(0, limit)
      if (limit === 0) {
        symbolRows.push(`- ${entry.file} · ${kind} · not listed — the per-file budget of ${SYMBOL_INDEX_ENTRY_LIMIT} entries was spent`)
        symbolRows.push(`  … and ${all.length} more — full index: ${pack.symbols}`)
        if (skipped > 0) symbolRows.push(`  … ${skipped} further ${kind} were not indexed — the per-file scan cap of ${SYMBOL_INDEX_SCAN_LIMIT} entries was reached`)
        continue
      }
      symbolRows.push(`- ${entry.file} · ${kind} · ${listed.map(render).join(', ')}`)
      remaining -= listed.length
      const more = all.length - listed.length
      if (more > 0) symbolRows.push(`  … and ${more} more — full index: ${pack.symbols}`)
      if (skipped > 0) symbolRows.push(`  … ${skipped} further ${kind} were not indexed — the per-file scan cap of ${SYMBOL_INDEX_SCAN_LIMIT} entries was reached`)
    }
  }
  if (symbolRows.length === 0) return []
  return [`symbol index (static scan — the same exported-symbol scan test-reach-unfenced runs; a symbol match is not a resolved import; at most ${SYMBOL_INDEX_ENTRY_LIMIT} entries listed per file):`, ...symbolRows]
}

function renderContextPack(pack) {
  if (pack == null) return []
  const lines = ['## Context pack']
  const issue = pack.issue || { number: null, body: null, reason: NO_ISSUE_CITED }
  if (issue.number === null) {
    lines.push(`issue: (none) — basis: ${issue.reason}`)
  } else {
    if (typeof issue.body === 'string') {
      const body = issue.body
      lines.push(`issue: #${issue.number} · body inlined below`)
      lines.push(`--- ISSUE ${issue.number} BODY ---`)
      lines.push(body)
      lines.push(`--- END ISSUE ${issue.number} BODY ---`)
    } else {
      lines.push(`issue: #${issue.number} · body unavailable — basis: ${issue.reason}`)
    }
  }
  const lineCounts = Array.isArray(pack.lineCounts) ? pack.lineCounts : []
  const rows = []
  lines.push('line counts:')
  for (const { file, lines: count, label } of lineCounts) {
    if (count === null) rows.push(`- ${file} · (unreadable) · ${label}`)
    else rows.push(`- ${file} · ${count} lines · ${label}`)
  }
  lines.push(...rows)
  rows.length = 0
  lines.push('tree (one level, directories named by the fence):')
  for (const { dir, entries, more } of Array.isArray(pack.tree) ? pack.tree : []) {
    rows.push(`- ${dir}/ · ${entries.join(', ')}${more ? ` (+${more} more)` : ''}`)
  }
  lines.push(...rows)
  const symbolRows = renderSymbolIndex(pack)
  if (symbolRows.length > 0) lines.push(...symbolRows)
  const journal = pack.journal || { path: null, rows: null, copied: 0, truncated: false, reason: NO_JOURNAL_NAMED }
  if (pack.fixture && journal.reason === null) {
    const truncation = journal.truncated ? ` (truncated from ${journal.rows} row(s))` : ''
    lines.push(`fixture rows: ${pack.fixture} · ${journal.copied} row(s) copied from ${journal.path}${truncation} — read it once with: cat ${pack.fixture}`)
  } else {
    lines.push(`fixture rows: (none) — basis: ${journal.reason}`)
  }
  return lines
}

function renderValidation(baseline, discovery) {
  const tests = discovery.tripwires.map((tripwire) => tripwire.file).sort()
  const narrow = tests.length ? `node --test ${tests.join(' ')}` : 'no tripwire tests discovered'
  const full = baseline.lane || 'no full test lane'
  const count = baseline.status === 'unknown'
    ? `unknown (${baseline.reason})`
    : `pass ${baseline.pass}, fail ${baseline.fail}`
  const basis = baseline.reused === true ? 'reused baseline' : 'measured baseline'
  return `narrow: ${narrow}\nfull: ${full} · ${basis} ${count}`
}

export function renderBrief(gathered) {
  const request = gathered.request || gathered
  const where = gathered.where || []
  const creates = gathered.creates || []
  const discovery = gathered.discovery || gathered.tripwires || { candidates: [], tripwires: [], broadKeys: [] }
  const baseline = gathered.baseline || { lane: null, pass: null, fail: null, status: 'unknown', reason: 'not-gathered' }
  const supplied = gathered.supplied ?? null
  const profile = gathered.profile || null
  const pack = gathered.pack ?? null
  const fences = Object.prototype.hasOwnProperty.call(gathered, 'fences') ? gathered.fences : null
  const baseWriteSurface = Object.prototype.hasOwnProperty.call(gathered, 'writeSurface')
    ? gathered.writeSurface
    : resolveWriteSurface({ fences, lane: gathered.lane ?? null, where, creates })
  const writeSurface = { ...(baseWriteSurface || {}), __discovery: discovery }
  const coupling = gathered.coupling ?? crossCheckCoupling({ discovery, writeSurface, enforce: false })
  const proposal = gathered.proposal ?? proposeTier({ where, discovery })
  const lines = [
    `# Task: ${request.ask}`,
    '## The ask',
    request.ask,
    '## Intent',
    resolveIntent(request),
    ...directedSection(request.directed ?? null),
    '## Proposed tier',
    renderProposedTier(proposal),
    renderProposalBlock(proposal),
    '## Where',
    renderWhere(where, creates),
    ...renderContextPack(pack),
    '## Done means',
    request.done_means,
    '## Tripwires',
    renderTripwireSlot(discovery, pack),
    '## Coupled sources',
    renderCoupled(coupling),
    '## Baseline',
    formatBaseline(baseline, profile, supplied),
    '## Out of scope',
    request.out_of_scope,
    '## Fences',
    renderFences(fences),
    '## What the crew decides',
    SLOT_MARKER,
    '## Acceptance',
    `${request.done_means} · Full suite green. · ${SLOT_MARKER}`,
    '## Acceptance gate',
    standingBlocks().acceptance,
    '## Per-check mutations',
    standingBlocks().mutations,
    '## Validation lane',
    renderValidation(baseline, discovery),
    '## Conventions',
    renderConventionsSlot(writeSurface, pack),
    ...(pack == null ? [
      renderConventions(profile?.conventions),
      generatedGrep(discovery),
      standingBlocks().conventions,
    ] : []),
    '',
  ]
  const content = lines.join('\n')
  // A request field may quote a plan; a BARE fence line inside one would hand the
  // driver two blocks and escalate the lane at directed:r1 — the #657 failure itself.
  // Refuse here rather than four seats later.
  if (request.directed) {
    const fences = content.split('\n').filter((line) => line.trim() === '```' + DIRECTED_BLOCK).length
    if (fences !== 1) {
      refuseUsage(`the rendered brief carries ${fences} \`\`\`${DIRECTED_BLOCK} fence lines — exactly one of them is the plan; no request field may carry a bare fence line`, DIRECTED_FENCE_COLLISION)
    }
  }
  return content
}

function parseCliArgs(argv) {
  const flags = {}
  const positional = []
  const valueFlags = new Set(['request', 'checkout', 'out', 'fences', 'protected', 'lane', 'profile', 'baseline', 'measure-baseline', 'discover-reads', 'pack', 'issue-body'])
  const booleanFlags = new Set(['force', 'require-profile'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) {
      positional.push(argument)
      continue
    }
    const name = argument.slice(2)
    if (booleanFlags.has(name)) {
      if (Object.prototype.hasOwnProperty.call(flags, name)) refuseUsage(`duplicate --${name}`, MISSING_LINE)
      flags[name] = true
      continue
    }
    if (!valueFlags.has(name)) refuseUsage(`unknown option: --${name}`, MISSING_LINE)
    if (Object.prototype.hasOwnProperty.call(flags, name)) refuseUsage(`duplicate --${name}`, MISSING_LINE)
    const value = argv[index + 1]
    if (value == null || value.startsWith('--')) refuseUsage(`--${name} requires a value`, MISSING_LINE)
    flags[name] = value
    index += 1
  }
  if (positional.length > 0) refuseUsage(`unexpected argument: ${positional[0]}`, MISSING_LINE)
  return flags
}

function readRequestFile(requestPath) {
  let data
  try {
    data = JSON.parse(readFileSync(resolve(requestPath), 'utf8'))
  } catch {
    refuseUsage(`cannot read or parse request file: ${requestPath}`, MISSING_LINE)
  }
  return data
}

function outputPathOrNull(value) {
  if (value == null || value === '-') return null
  return resolve(value)
}

function writeBrief(content, outPath, force) {
  if (outPath == null) {
    process.stdout.write(content)
    return
  }
  const parent = dirname(outPath)
  if (!existsSync(parent)) refuseUsage(`output directory does not exist: ${parent}`, OUT_DIR_MISSING)
  let parentStat
  try { parentStat = statSync(parent) } catch { refuseUsage(`output directory does not exist: ${parent}`, OUT_DIR_MISSING) }
  if (!parentStat.isDirectory()) refuseUsage(`output directory does not exist: ${parent}`, OUT_DIR_MISSING)
  if (existsSync(outPath)) {
    let outputStat
    try { outputStat = statSync(outPath) } catch { outputStat = null }
    if (outputStat && outputStat.isDirectory()) {
      refuseUsage(`output path is a directory, not a file: ${outPath}`, OUT_EXISTS)
    }
    if (!force) refuseUsage(`output already exists: ${outPath}`, OUT_EXISTS)
  }
  writeFileSync(outPath, content)
}

function measureOnly(flags) {
  if (flags.request != null || flags.out != null) {
    refuseUsage('--measure-baseline cannot be combined with --request or --out', MISSING_LINE)
  }
  const checkout = gitRoot(flags.checkout || process.cwd())
  const profileResult = gatherProfile({
    checkout,
    profilePath: flags.profile,
    requireProfile: flags['require-profile'] === true,
  })
  const testCommand = profileField(profileResult, 'test_command')
  if (flags['require-profile'] === true && !testCommand.used) {
    refuseUsage(`test_command is not ratified: ${testCommand.basis}`, PROFILE_UNRATIFIED)
  }
  const { lane, laneBasis } = laneFromProfile(testCommand)
  const baseline = gatherBaseline({ checkout, lane, laneBasis })
  const state = gitState({ checkout })
  const status = baseline.status === 'green' || baseline.status === 'red' ? baseline.status : 'unknown'
  const output = {
    sha: state.clean === true ? state.sha : null,
    command: baseline.lane,
    pass: baseline.pass,
    fail: baseline.fail,
    status,
  }
  writeFileSync(resolve(flags['measure-baseline']), `${JSON.stringify(output, null, 2)}\n`)
  return 0
}

function compile(flags) {
  if (flags['measure-baseline'] != null) return measureOnly(flags)
  if (typeof flags.request !== 'string' || !flags.request) refuseUsage('--request <file> is required', MISSING_LINE)
  const outPath = outputPathOrNull(flags.out)
  if (flags.pack != null && outPath == null) refuseUsage('--pack requires --out', MISSING_LINE)
  if (flags['issue-body'] != null && flags.pack == null) refuseUsage('--issue-body requires --pack', MISSING_LINE)
  const packPath = flags.pack == null ? null : resolve(flags.pack)
  if (packPath != null) {
    let present = false
    try { present = existsSync(packPath) } catch { present = false }
    if (!present) refuseUsage(`pack directory does not exist: ${packPath}`, OUT_DIR_MISSING)
    let packStat
    try { packStat = statSync(packPath) } catch { packStat = null }
    if (!packStat || !packStat.isDirectory()) refuseUsage(`pack directory does not exist: ${packPath}`, OUT_DIR_MISSING)
  }
  const taskName = parseTaskStem(outPath || flags.request)
  const packTaskName = taskName.endsWith('.brief') ? taskName.slice(0, -'.brief'.length) : taskName
  const request = readRequestFile(flags.request)
  validateRequest(request, { taskName })
  const checkout = gitRoot(flags.checkout || process.cwd())
  const where = verifyWhere({ checkout, where: request.where })
  const creates = verifyCreates({ checkout, creates: request.creates ?? [] })
  const discovery = discoverTripwires({ checkout, files: where })
  const profileResult = gatherProfile({
    checkout,
    profilePath: flags.profile,
    requireProfile: flags['require-profile'] === true,
  })
  const testCommand = profileField(profileResult, 'test_command')
  if (flags['require-profile'] === true && !testCommand.used) {
    refuseUsage(`test_command is not ratified: ${testCommand.basis}`, PROFILE_UNRATIFIED)
  }
  const conventions = profileField(profileResult, 'conventions')
  // A profile baseline is a fact about a commit with no recorded sha, so it
  // remains evidence only; a caller-supplied baseline is checked separately.
  const recordedBaseline = profileField(profileResult, 'baseline')
  // default_branch and ci have no consumer in this module (ci belongs to the
  // sibling profile-ci-shape lane), so they deliberately stay out of wiring.
  const { lane, laneBasis } = laneFromProfile(testCommand)
  const fences = gatherFences({ fencesPath: flags.fences, checkout })
  const writeSurface = resolveWriteSurface({ fences, lane: flags.lane ?? null, where, creates })
  if (writeSurface.basis === 'fences') validateScopeEntries({ checkout, files: writeSurface.files })
  const coupling = crossCheckCoupling({ discovery, writeSurface })
  const command = resolveBaselineCommand({ checkout, lane })
  const reuse = reuseBaseline({ checkout, command, laneBasis, path: flags.baseline ?? null })
  const baseline = reuse.baseline || gatherBaseline({ checkout, lane, laneBasis })
  let fromProfile
  try {
    fromProfile = profileProtectedPaths(profileResult.profile, { path: profileResult.path })
  } catch (err) {
    if (!(err instanceof ProfileRefusal)) throw err
    refuseUsage(err.message, BAD_PROTECTED)
  }
  const protectedPaths = gatherProtectedPaths({ protectedPathsFile: flags.protected, extra: fromProfile.paths })
  const proposal = proposeTier({ where, discovery, protectedPaths, protectedBasis: fromProfile.basis })
  const profile = { testCommand, conventions, baseline: recordedBaseline }
  const pack = packPath == null ? null : writePack({
    packDir: packPath,
    taskName: packTaskName,
    checkout,
    request,
    discovery,
    writeSurface,
    coupling,
    profile,
    issueBodyPath: flags['issue-body'],
  })
  const content = renderBrief({
    request,
    where,
    creates,
    discovery,
    coupling,
    baseline,
    supplied: reuse.supplied,
    fences,
    lane: flags.lane ?? null,
    writeSurface,
    proposal,
    profile,
    pack,
  })
  writeBrief(content, outPath, flags.force === true)
  return 0
}

// --discover-reads <lane>: the same derivation the coupled-source-unfenced
// refusal uses, printed instead of refused, so the dispatcher can acknowledge
// the reads and compile ONCE (#737). It refuses what the compile path refuses.
function discoverReadsOnly(flags) {
  const lane = flags['discover-reads']
  if (flags.lane != null || flags.out != null || flags.force === true || flags['measure-baseline'] != null) {
    refuseUsage('--discover-reads cannot be combined with --lane, --out, --force or --measure-baseline', MISSING_LINE)
  }
  if (typeof flags.request !== 'string' || !flags.request) refuseUsage('--request <file> is required', MISSING_LINE)
  const request = readRequestFile(flags.request)
  validateRequest(request, { taskName: parseTaskStem(`${lane}.brief.md`) })
  const checkout = gitRoot(flags.checkout || process.cwd())
  const discoverWhere = verifyWhere({ checkout, where: request.where })
  const discoverCreates = verifyCreates({ checkout, creates: request.creates ?? [] })
  const discovery = discoverTripwires({ checkout, files: discoverWhere })
  const fences = gatherFences({ fencesPath: flags.fences, checkout })
  const writeSurface = resolveWriteSurface({ fences, lane, where: discoverWhere, creates: discoverCreates })
  const records = readsToAcknowledge({ discovery, writeSurface })
  process.stdout.write(`${JSON.stringify(records)}\n`)
  return 0
}

export function main(argv) {
  try {
    const flags = parseCliArgs(argv)
    return flags['discover-reads'] != null ? discoverReadsOnly(flags) : compile(flags)
  } catch (err) {
    if (err instanceof BriefUsageError) {
      process.stderr.write(`${err.message} [reason: ${err.reason}]\n`)
      return 2
    }
    process.stderr.write(`${err && err.stack}\n`)
    return 1
  }
}

function realpathOr(path) {
  try { return realpathSync(path) } catch { return path }
}

const invokedDirectly = process.argv[1] && realpathOr(process.argv[1]) === realpathOr(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2))
}
