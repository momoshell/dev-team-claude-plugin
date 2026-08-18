#!/usr/bin/env node
// crew/crew.mjs — crew v3: a self-contained team runtime (zero legacy
// dev-team imports). v3 inverts control: crew/drive.mjs (CODE) runs the
// task loop; the LEAD pane is a judge consulted only at decision points. One cmux workspace per task, booted in a single
// declarative call. A LEAD pane runs the task from inside the workspace —
// it drives the planner/builder/reviewer/tech-lead members, runs the
// validation lanes and the full suite, does the git scope check, and commits.
// The orchestrator (a separate session) does exactly three things: size the
// crew before boot, hand the task to the lead, and — on the lead's final
// envelope — push/PR and talk to the human. Task work never leaves the
// workspace.
//
// Verbs:
//   crew.mjs boot  --task <slug> [--roles lead,planner,builder,reviewer[,tech-lead]]
//                  [--checkout <dir>] [--model-<role> <id>] [--agent-<role> <name>]...
//                  [--headless-all] [--memory-dir <dir>] [--memory-backend <name>]
//                  [--memory-budget-bytes <n>] [--fences <register.json> --lane <name>]
//                  # paired: both or neither
//   crew.mjs run   --task <slug> --brief-file <path> [--variant <name>] [--files-in-scope <a,b>] # hand the task to the lead
//                  variant names come from crew/drive.mjs's VARIANTS
//   crew.mjs wait  --task <slug> [--timeout-s N]       # await the LEAD's envelope
//   crew.mjs status --task <slug>
//   crew.mjs teardown --task <slug>
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync,
} from 'node:fs'
import { join, dirname, resolve as resolvePath } from 'node:path'
import { homedir, loadavg as osLoadavg, cpus as osCpus } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { execSync } from 'node:child_process'

import { cmux, tree, sendLine, renameTab, closeSurface, closeWorkspace, logLine } from './driver.mjs'
import { slug } from './slug.mjs'
import { driveTask, VARIANTS, VARIANT_NAMES, DEFAULT_VARIANT, validateScopeEntries } from './drive.mjs'
import { reclaimStore } from './reclaim.mjs'
import {
  realIo, settleSeatTeardown, saveCrew, resolveWorkerBin, paneAlive, DEFAULT_TRANSPORT, HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT,
} from './realio.mjs'
export {
  docOpenArgs, phaseForStage, emitAdapter, waitForEnvelope, resolveWorkerBin,
  DEFAULT_TRANSPORT, HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT, WAIT_POLL_MS, LIVENESS_PROBE_MS,
  LIVENESS_MISSES_TO_DIE,
} from './realio.mjs'
import { openRun, recordCellFailure } from '../scripts/factory/emit.mjs'
import { checkoutProtectedPaths } from '../scripts/factory/probe-repo.mjs'
import { gatherFences, laneFenceFor } from '../scripts/factory/make-brief.mjs'
import { breakerPolicy, cellHealth, assertCellsClosed } from './breaker.mjs'
import {
  DEFAULT_BACKEND, DEFAULT_BUDGET_BYTES, openMemory, renderSection,
} from './memory.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROLES_DIR = join(HERE, 'roles')
const SHARED_PROMPT = join(ROLES_DIR, '_shared.md')

export const HEADLESS_TRANSPORTS = Object.freeze([HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT])

// Per-seat defaults. Model is overridable per task (--model-<role>) so the
// orchestrator can size the crew: cheap seats for mechanical work, capable
// seats where judgment lives. Tools are role-scoped; the LEAD alone gets the
// integration surface (Bash for tests+git, no repo Edit — it verifies and
// commits, never authors source).
// `tools` is the seat's auto-approve surface (--allowedTools — inert under
// bypassPermissions, kept for any non-bypass relaunch). `deny` is the seat's
// ENFORCED tool boundary (--disallowedTools holds even under bypass): only
// the builder may Edit, only planner/reviewer may spawn subagents. Note Write
// stays available everywhere — every seat writes envelopes and task-dir
// artifacts — so the REPO boundary for non-builder seats is the git scope
// gate + commit-in-scope, not tool denial.
// `agent` names the adapter (crew/adapters/adapter-<name>.mjs) that fills
// the seat; overridable per task via --agent-<role>, default 'claude'.
// `requires` names the capability keys the charter depends on; a seat whose
// adapter cannot deliver one refuses to boot. The fan-out tool itself is a
// register-backed grant in crew/capabilities.json, not a hardcoded seat
// default. FANOUT_TOOLS is the deny-side set for seats that withhold fan-out.
// Only the PLANNER requires `subagents`, and the asymmetry is
// deliberate: its charter is "domain lead + architect + scout-commander", and
// fan-out discovery IS the third of those. The reviewer's charter — conformance
// to plan, then correctness, plus gate-defect triage and perspective duty —
// names no fan-out, and the roster deliberately seats pi/terra on review at
// `build`/`mechanical` under the ratified review-vendor rule. Requiring it
// there would make two of three tiers unbootable, which is how this landed the
// first time (#144).
// Every fan-out tool name, in ONE place. Task and Agent spawn subagents;
// Workflow fans out wider still — a script that spawns many seats at once —
// and no seat denied the first two was ever denied it. A seat that withholds
// fan-out withholds every name here, so a future fan-out tool is a single
// edit to this line rather than a hunt through per-role deny literals.
export const FANOUT_TOOLS = Object.freeze(['Task', 'Agent', 'Workflow'])
const NO_FANOUT = FANOUT_TOOLS.join(',')

export const SEAT_DEFAULTS = Object.freeze({
  lead: { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write', deny: `Edit,NotebookEdit,${NO_FANOUT}`, requires: [], prompt: 'lead.md', agent: 'claude' },
  planner: { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write', deny: 'Edit,NotebookEdit', requires: ['subagents'], prompt: 'planner.md', agent: 'claude' },
  builder: { model: 'sonnet', tools: 'Read,Edit,Write,Glob,Grep,Bash', deny: NO_FANOUT, requires: [], prompt: 'builder.md', agent: 'claude' },
  reviewer: { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write', deny: 'Edit,NotebookEdit', requires: [], prompt: 'reviewer.md', agent: 'claude' },
  'tech-lead': { model: 'opus', tools: 'Read,Glob,Grep,Bash,Write', deny: `Edit,NotebookEdit,${NO_FANOUT}`, requires: [], prompt: 'tech-lead.md', agent: 'claude' },
})

// The seat's EFFECTIVE auto-approve allowlist: the seat default plus whatever
// the register granted, in that order (identical to adapter-claude's own
// allowedTools() merge, so the composed command is byte-unchanged).
// crew.json records THIS, not the bare default: crew/headless.mjs rebuilds a
// headless worker command from members.<role>.tools alone — grants never reach
// it — so recording the default would silently narrow every factory seat.
export function effectiveTools(role, grants = EMPTY_GRANTS) {
  return [...new Set([...String(SEAT_DEFAULTS[role].tools || '').split(','), ...(grants?.tools || [])].filter(Boolean))].join(',')
}

export const DEFAULT_ROLES = Object.freeze(['lead', 'planner', 'builder', 'reviewer'])
export const MEMORY_ROLES = Object.freeze(['lead', 'planner'])
// Canonical seating order — also layout order (index 0 takes the left half).
// Must stay key-identical to SEAT_DEFAULTS (pinned by a test).
export const ROLE_ORDER = Object.freeze(['lead', 'planner', 'builder', 'reviewer', 'tech-lead'])

export const CAPABILITY_REFUSALS = Object.freeze([
  'register-invalid', 'capability-shortfall', 'unknown-grant', 'grant-unsupported',
  'extension-missing', 'unknown-skill', 'agent-def-invalid', 'local-settings-missing',
  'local-endpoint-dead',
])
const CAPABILITIES_PATH = join(HERE, 'capabilities.json')
const CAPABILITIES_SCHEMA_PATH = join(HERE, 'capabilities.schema.json')
const REGISTER_ROOT = resolvePath(join(HERE, '..'))

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

export function refuse(reason, message) {
  if (!CAPABILITY_REFUSALS.includes(reason)) throw new Error(`unknown capability refusal reason ${JSON.stringify(reason)}`)
  return Object.assign(new Error(`${message} [${reason}]`), { reason })
}

export function validateCapabilities(schema, value) {
  const errors = []
  walk(schema, value, '$')
  return errors

  function resolve(node) {
    if (!node || typeof node !== 'object' || !node.$ref) return node
    return resolve(byPath(node.$ref))
  }

  function byPath(ref) {
    let node = schema
    const parts = String(ref).replace(/^#\/?/, '').split('/').filter(Boolean)
    for (const part of parts) node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')]
    return node
  }

  function matchedTypes(current) {
    const matched = new Set()
    if (current === null) matched.add('null')
    else if (Array.isArray(current)) matched.add('array')
    else if (typeof current === 'number') {
      matched.add('number')
      if (Number.isInteger(current)) matched.add('integer')
    } else if (typeof current === 'string') matched.add('string')
    else if (typeof current === 'boolean') matched.add('boolean')
    else if (typeof current === 'object') matched.add('object')
    return matched
  }

  function walk(schemaNode, current, path) {
    const s = resolve(schemaNode)
    if (!s || typeof s !== 'object') {
      errors.push(`${path}: invalid schema reference`)
      return
    }
    if (Object.hasOwn(s, 'const')) {
      if (current !== s.const) errors.push(`${path}: expected const ${JSON.stringify(s.const)}, got ${JSON.stringify(current)}`)
      return
    }
    if (s.enum && !s.enum.includes(current)) {
      errors.push(`${path}: ${JSON.stringify(current)} not in enum ${JSON.stringify(s.enum)}`)
      return
    }

    const matched = matchedTypes(current)
    if (s.type) {
      const types = Array.isArray(s.type) ? s.type : [s.type]
      if (!types.some((type) => matched.has(type))) {
        errors.push(`${path}: expected type ${types.join('|')}, got ${[...matched].join('|') || typeof current}`)
        return
      }
    }
    if (current === null) return
    if (typeof current === 'string' && s.pattern) {
      let valid = false
      try { valid = new RegExp(s.pattern).test(current) } catch { valid = false }
      if (!valid) errors.push(`${path}: ${JSON.stringify(current)} does not match pattern ${s.pattern}`)
    }
    if (Array.isArray(current) && s.items) {
      current.forEach((item, index) => walk(s.items, item, `${path}[${index}]`))
    }
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      for (const key of s.required || []) {
        if (!Object.hasOwn(current, key)) errors.push(`${path}: missing required property ${JSON.stringify(key)}`)
      }
      const patterns = Object.entries(s.patternProperties || {}).map(([pattern, child]) => [new RegExp(pattern), child])
      for (const [key, childValue] of Object.entries(current)) {
        const matchedSchemas = []
        if (s.properties && Object.hasOwn(s.properties, key)) matchedSchemas.push(s.properties[key])
        for (const [pattern, child] of patterns) if (pattern.test(key)) matchedSchemas.push(child)
        if (!matchedSchemas.length && s.additionalProperties === false) {
          errors.push(`${path}: additional property ${JSON.stringify(key)} not allowed`)
          continue
        }
        for (const child of matchedSchemas) walk(child, childValue, `${path}.${key}`)
      }
    }
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

// The register is runtime policy: grant paths resolve against this checkout,
// not the target checkout. The shipped file carries the claude Task fan-out
// grant; checkout-pinned pi assets remain reserved for a later slice, as does
// advisor runtime behavior.
export function loadCapabilities({ path = CAPABILITIES_PATH, schemaPath = CAPABILITIES_SCHEMA_PATH, register = null } = {}) {
  let schema
  try {
    schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
  } catch (err) {
    throw refuse('register-invalid', `runtime capability policy schema ${schemaPath} is unreadable or unparseable under the runtime-policy rule: ${err.message}`)
  }

  let value
  if (register === null) {
    try {
      value = JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      throw refuse('register-invalid', `runtime capability register ${path} is unreadable or unparseable under the runtime-policy rule: ${err.message}`)
    }
  } else {
    try {
      value = cloneJson(register)
    } catch (err) {
      throw refuse('register-invalid', `injected runtime capability register for ${path} is unparseable under the runtime-policy rule: ${err.message}`)
    }
  }

  const errors = validateCapabilities(schema, value)
  if (errors.length) {
    throw refuse('register-invalid', `runtime capability register ${path} failed schema validation under the runtime-policy rule: ${errors.slice(0, 3).join('; ')}`)
  }
  return deepFreeze(value)
}

function resolvedGrantPath(root, relativePath) {
  return resolvePath(join(resolvePath(root), relativePath))
}

function pathExists(exists, path) {
  try { return !!exists(path) } catch { return false }
}

function pathMessage(reason, seat, kind, expected, found, path) {
  return refuse(reason, `seat ${seat} ${kind} expected ${expected}, found ${found}, at ${path}`)
}

export function grantsFor(register, role, { root = REGISTER_ROOT, exists = existsSync, readFile = readFileSync } = {}) {
  const spec = register?.roles && Object.hasOwn(register.roles, role) ? register.roles[role] : null
  if (!spec) throw refuse('register-invalid', `runtime capability register has no grant for unknown role ${JSON.stringify(role)} under the runtime-policy rule`)

  const extensions = spec.extensions.map((relativePath) => {
    const path = resolvedGrantPath(root, relativePath)
    if (!pathExists(exists, path)) throw pathMessage('extension-missing', role, 'extension grant', 'an existing checkout-relative path', 'missing', path)
    return path
  })
  const skills = spec.skills.map((relativePath) => {
    const path = resolvedGrantPath(root, relativePath)
    if (!pathExists(exists, path)) throw pathMessage('unknown-skill', role, 'skill grant', 'an existing checkout-relative path', 'missing', path)
    return path
  })
  const agents = spec.agents.map((grant) => {
    const path = resolvedGrantPath(root, grant.def)
    let raw
    try {
      raw = readFile(path, 'utf8')
    } catch (err) {
      throw pathMessage('agent-def-invalid', role, `agent definition ${grant.name}`, 'a readable JSON definition', `unreadable (${err.message})`, path)
    }
    let definition
    try {
      definition = JSON.parse(String(raw))
    } catch (err) {
      throw pathMessage('agent-def-invalid', role, `agent definition ${grant.name}`, 'parseable JSON', `unparseable (${err.message})`, path)
    }
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)
      || typeof definition.name !== 'string' || definition.name.trim() === '' || definition.name !== grant.name) {
      const found = definition && typeof definition === 'object' ? JSON.stringify(definition.name) : JSON.stringify(definition)
      throw pathMessage('agent-def-invalid', role, `agent definition ${grant.name}`, `name ${JSON.stringify(grant.name)}`, `name ${found}`, path)
    }
    if (typeof definition.prompt !== 'string' || definition.prompt.trim() === '') {
      const found = definition && Object.hasOwn(definition, 'prompt') ? JSON.stringify(definition.prompt) : 'missing prompt'
      throw pathMessage('agent-def-invalid', role, `agent definition ${grant.name}`, 'a non-empty prompt', found, path)
    }
    return { name: grant.name, def: path }
  })

  return deepFreeze({
    tools: [...spec.tools], extensions, agents, skills,
    advisor: spec.advisor, requires: [...spec.requires],
  })
}

function relativeGrantMatches(declared, resolved) {
  const declaration = String(declared).replaceAll('\\', '/')
  const candidate = String(resolved).replaceAll('\\', '/')
  return candidate === declaration || candidate.endsWith(`/${declaration}`)
}

export function assertGrantsBacked(role, grants, register) {
  const spec = register?.roles && Object.hasOwn(register.roles, role) ? register.roles[role] : null
  if (!spec) throw refuse('unknown-grant', `seat ${role} has grants but no matching register role`)
  for (const tool of grants?.tools || []) {
    if (!spec.tools.includes(tool)) throw refuse('unknown-grant', `seat ${role} has unregistered tool grant ${JSON.stringify(tool)}`)
  }
  for (const extension of grants?.extensions || []) {
    if (!spec.extensions.some((declared) => relativeGrantMatches(declared, extension))) {
      throw refuse('unknown-grant', `seat ${role} has unregistered extension grant ${JSON.stringify(extension)}`)
    }
  }
  for (const skill of grants?.skills || []) {
    if (!spec.skills.some((declared) => relativeGrantMatches(declared, skill))) {
      throw refuse('unknown-grant', `seat ${role} has unregistered skill grant ${JSON.stringify(skill)}`)
    }
  }
  for (const agent of grants?.agents || []) {
    if (!spec.agents.some((declared) => declared.name === agent.name && relativeGrantMatches(declared.def, agent.def))) {
      throw refuse('unknown-grant', `seat ${role} has unregistered agent grant ${JSON.stringify(agent)}`)
    }
  }
  if (grants?.advisor === true && spec.advisor !== true) {
    throw refuse('unknown-grant', `seat ${role} has unregistered advisor grant`)
  }
  return grants
}

export const EMPTY_GRANTS = deepFreeze({
  tools: [], extensions: [], agents: [], skills: [], advisor: false, requires: [],
})

// A capability the REGISTER hands out, not one the binary simply has. The
// adapter declares what its CLI can do; crew/capabilities.json decides what
// THIS seat is given. HOW a grant delivers a capability is adapter-owned:
// pi turns `subagents` false→true when an agent definition is granted
// (crew/adapters/adapter-pi.mjs:74), while claude declares it invariantly true
// and carries fan-out only in the `Task` tool it was granted
// (crew/adapters/adapter-claude.mjs:17,61-63). So an adapter-owned false→true
// transition is trusted as delivery, and an already-true (invariant) profile
// still has to be backed by the registered tool — otherwise a claude seat with
// an agents-only grant would boot with no Task in its command line.
// Deliberately NOT inside adapter.capabilitiesFor(): visualizer/server/
// roster-edit.mjs and crew/daemon.mjs call that seam WITHOUT grants to
// pre-flight a roster cell, and narrowing there would refuse every claude
// planner in the propose-only editor.
export const CAPABILITY_DELIVERY = Object.freeze({
  subagents: Object.freeze({
    // claude: the CLI ships the Task tool and adapter-claude.mjs:61-63 merges a
    // granted tool into --allowedTools. Its declaration is invariantly true, so
    // the tool grant is the only thing that makes that declaration real.
    tools: Object.freeze(['Task']),
    // pi: the CLI ships NO subagent tool, so fan-out is an extension that
    // implements it plus an agent definition that names it
    // (crew/adapters/adapter-pi.mjs:24-26). Its capabilitiesFor flips on
    // grants.agents alone (:74), but seatCommand (:182-194) emits `-e
    // <extension>` and never emits the agent grant — an agents-only seat boots
    // --no-extensions with nothing to fan out with. The whole bundle or nothing.
    bundle: Object.freeze(['extensions', 'agents']),
  }),
})

export function effectiveCapabilities({ declared, bare, grants = EMPTY_GRANTS } = {}) {
  const nonEmpty = (key) => ((grants?.[key]) || []).length > 0
  const out = { ...declared }
  for (const [cap, delivery] of Object.entries(CAPABILITY_DELIVERY)) {
    if (out[cap] !== true) continue
    const delivered = bare?.[cap] === true
      // declared with no grants at all: the registered tool is what gives it to this seat
      ? delivery.tools.some((tool) => (grants?.tools || []).includes(tool))
      // declared only because of a grant: every piece the command line needs
      : delivery.bundle.every(nonEmpty)
    if (!delivered) out[cap] = false
  }
  return Object.freeze(out)
}

export async function probeLocalEndpoint(url, { fetchFn = fetch, timeoutMs = 2000 } = {}) {
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) })
    return response?.status < 500
  } catch {
    return false
  }
}

export const LOAD_ENV = Object.freeze({ threshold: 'CREW_LOAD_THRESHOLD' })

// Opt-in, exactly like the cell breaker: an absent/empty threshold means no
// policy and nothing is measured; every other malformed value is a boot-time
// configuration error. There is deliberately NO default threshold — a guessed
// number is a number nobody measured.
export function loadPolicy(env = process.env) {
  const raw = env?.[LOAD_ENV.threshold]
  if (raw === undefined || raw === '') return null
  const threshold = Number(raw)
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new Error(`${LOAD_ENV.threshold} must be a finite number > 0 (got ${JSON.stringify(raw)})`)
  }
  return { threshold }
}

const LOAD_BASIS = 'os.loadavg()[0] / os.cpus().length'

function loadRecord(policy, verdict, why, load_1m = null, cores = null, per_core = null) {
  return {
    configured: true, threshold: policy.threshold, basis: LOAD_BASIS,
    load_1m, cores, per_core, verdict, why,
  }
}

export function hostLoad({ policy, loadavg = osLoadavg, cpus = osCpus, platform = process.platform } = {}) {
  if (policy == null) return null
  if (platform === 'win32') {
    return loadRecord(policy, 'unmeasurable', 'Node documents win32 os.loadavg() as a constant, not a measured host load')
  }

  let load_1m
  try {
    load_1m = loadavg()?.[0]
  } catch (err) {
    return loadRecord(policy, 'unmeasurable', `os.loadavg() failed: ${err?.message || String(err)}`)
  }
  if (typeof load_1m !== 'number' || !Number.isFinite(load_1m) || load_1m < 0) {
    return loadRecord(policy, 'unmeasurable', 'os.loadavg()[0] was not a finite non-negative number')
  }

  let coreList
  try {
    coreList = cpus()
  } catch (err) {
    return loadRecord(policy, 'unmeasurable', `os.cpus() failed: ${err?.message || String(err)}`)
  }
  if (!Array.isArray(coreList) || coreList.length === 0) {
    return loadRecord(policy, 'unmeasurable', 'os.cpus() did not return a non-empty array')
  }

  const cores = coreList.length
  const per_core = load_1m / cores
  const verdict = per_core > policy.threshold ? 'saturated' : 'quiet'
  return loadRecord(policy, verdict, null, load_1m, cores, per_core)
}

function loadError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function assertHostQuiet(record) {
  if (!record || record.verdict === 'quiet') return
  if (record.verdict === 'unmeasurable') {
    throw loadError(
      'host-load-unmeasurable',
      `host load: CREW_LOAD_THRESHOLD=${record.threshold} is configured but host load is unmeasurable (${record.why || 'unknown reason'}) — refusing to boot without a measured host load; repair the host load probe or unset CREW_LOAD_THRESHOLD.`,
    )
  }
  if (record.verdict !== 'saturated') return
  throw loadError(
    'host-load-open',
    `host load: 1-minute load average ${record.load_1m} over ${record.cores} cores = ${record.per_core.toFixed(2)} per core exceeds CREW_LOAD_THRESHOLD=${record.threshold} (basis: ${record.basis}, measured at boot) — refusing to boot a crew onto a saturated host; wait for the host to quiet down, seat fewer roles (--roles/--tier), or unset CREW_LOAD_THRESHOLD.`,
  )
}

// The rule itself lives in the leaf module `slug.mjs`, so daemon.mjs can share
// it without importing this file (which pulls in drive.mjs). Re-exported here
// because this module's own consumers already reach for it by this name.
export { slug }

function pathsFor(taskSlug, checkout) {
  const repo = slug(checkout.split('/').filter(Boolean).pop() || 'repo')
  const dir = join(homedir(), '.crew', repo, taskSlug)
  return { repo, dir, taskDir: join(dir, 'task'), returnsDir: join(dir, 'returns') }
}

function loadCrew(paths) {
  const p = join(paths.dir, 'crew.json')
  if (!existsSync(p)) throw new Error(`no crew booted for this task (missing ${p})`)
  return JSON.parse(readFileSync(p, 'utf8'))
}

function seatModel(role, args) {
  return args[`model-${role}`] || SEAT_DEFAULTS[role].model
}

function seatAgent(role, args) {
  return args[`agent-${role}`] || SEAT_DEFAULTS[role].agent
}

// Enforce that the resolved adapter can actually deliver what the seat's
// charter needs. Every seat has a non-empty deny list, so an adapter that
// can't enforce it would boot a silently weaker seat. Returns undefined on
// success.

// The closed set lives in crew/drive.mjs and is IMPORTED, never restated:
// a second list here is exactly how the CLI and the driver drift apart, and
// a shape added to VARIANTS becomes selectable from the CLI with no edit.
export function resolveVariant(args = {}) {
  const raw = args.variant
  if (raw === undefined) return DEFAULT_VARIANT
  // parseArgs turns a valueless --variant into boolean true — that is a
  // missing value, not a shape name.
  if (raw === true) {
    throw new Error(`--variant needs a shape name — the closed set is: ${VARIANT_NAMES.join(', ')}`)
  }
  const name = String(raw)
  if (!VARIANT_NAMES.includes(name)) {
    throw new Error(`unknown variant ${JSON.stringify(name)} — the closed set is: ${VARIANT_NAMES.join(', ')}`)
  }
  return name
}

export function resolveFilesInScope(args = {}, variant, taskReturn, deps = {}) {
  const raw = args['files-in-scope']
  const exists = deps.existsSync || existsSync
  const read = deps.readFileSync || readFileSync
  const defectsMessage = (defects) => defects.map(({ entry, why }) => `${JSON.stringify(entry)} (${why})`).join(', ')
  if (raw === true) throw new Error('--files-in-scope needs a comma-separated list of repo-relative paths')
  if (raw !== undefined) {
    if (typeof raw !== 'string') throw new Error('--files-in-scope needs a comma-separated list of repo-relative paths')
    const files = raw.split(',').map((entry) => entry.trim()).filter(Boolean)
    if (files.length === 0) throw new Error(`--files-in-scope supplied an empty list ${JSON.stringify(raw)} — an empty scope is never a scope`)
    const defects = validateScopeEntries(files)
    if (defects.length) throw new Error(`--files-in-scope contains unsupported entries: ${defectsMessage(defects)}`)
    return files
  }
  if (VARIANTS[variant]?.sources?.scope !== 'inherited') return null

  const envelopePath = taskReturn || '<missing task return path>'
  if (!taskReturn || !exists(taskReturn)) {
    throw new Error(`cannot inherit files_in_scope for ${variant} run: failing-run envelope ${envelopePath} is missing or unreadable`)
  }
  let envelope
  try { envelope = JSON.parse(String(read(taskReturn, 'utf8'))) }
  catch (err) { throw new Error(`cannot read failing-run envelope ${envelopePath} for ${variant} scope inheritance: ${err?.message || String(err)}`) }
  const details = envelope && typeof envelope === 'object' && !Array.isArray(envelope) && envelope.details && typeof envelope.details === 'object' && !Array.isArray(envelope.details)
    ? envelope.details : null
  if (!details) throw new Error(`failing-run envelope ${envelopePath} for ${variant} scope inheritance has no details object declaring a non-empty scope`)
  // Mirror scripts/factory/ci-repair.mjs:108-110: prefer files_in_scope
  // whenever the key is present, otherwise inherit files_committed.
  const hasForwardScope = Object.prototype.hasOwnProperty.call(details, 'files_in_scope')
  const files = hasForwardScope ? details.files_in_scope : details.files_committed
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`failing-run envelope ${envelopePath} for ${variant} scope inheritance declares no non-empty files_in_scope/files_committed list`)
  }
  const defects = validateScopeEntries(files)
  if (defects.length) throw new Error(`inherited scope from ${envelopePath} contains unsupported entries: ${defectsMessage(defects)}`)
  return [...files]
}

// --fences/--lane are the brief compiler's flag names for the SAME register, so the
// orchestrator authors one file and both readers agree. Both or neither: a --lane
// with no register, or a register with no lane, is a boot refusal — never a silently
// unfenced run. Returns null when neither is given, and boot is unchanged.
export function resolveLaneFence(args = {}, deps = {}) {
  const gather = deps.gatherFences || gatherFences
  const forLane = deps.laneFenceFor || laneFenceFor
  const rawLane = args.lane
  const rawFences = args.fences
  if (rawLane === undefined && rawFences === undefined) return null
  if (typeof rawLane !== 'string' || !rawLane.trim()) {
    throw new Error('--lane needs a lane name from the fence register (--fences and --lane are given together or not at all)')
  }
  if (typeof rawFences !== 'string' || !rawFences.trim()) {
    throw new Error('--fences needs a path to the fence register JSON (--fences and --lane are given together or not at all)')
  }
  const lane = rawLane.trim()
  return { lane, fence: forLane({ fences: gather({ fencesPath: rawFences }), lane }) }
}

export function transportFor(role, args = {}) {
  const headless = String(args.headless === true ? '' : (args.headless || ''))
    .split(',').map((s) => s.trim()).filter(Boolean)
  const rpc = String(args['headless-rpc'] === true ? '' : (args['headless-rpc'] || ''))
    .split(',').map((s) => s.trim()).filter(Boolean)
  if (headless.includes(role) && rpc.includes(role)) {
    throw new Error(`role ${role} is named by both --headless and --headless-rpc`)
  }
  if (rpc.includes(role)) return HEADLESS_RPC_TRANSPORT
  if (headless.includes(role)) return HEADLESS_TRANSPORT
  return DEFAULT_TRANSPORT
}

export function seatTransport({ role, args = {}, adapter, agentName } = {}) {
  const explicit = transportFor(role, args)
  if (explicit !== DEFAULT_TRANSPORT) return explicit
  const raw = args['headless-all']
  if (raw === undefined) return DEFAULT_TRANSPORT
  if (raw !== true && raw !== 'true') throw new Error(`--headless-all takes no value (got ${JSON.stringify(raw)})`)
  const refusals = []
  for (const transport of HEADLESS_TRANSPORTS) {
    try {
      adapter.capabilitiesFor({ transport })
      return transport
    } catch (err) {
      refusals.push(err?.message || String(err))
    }
  }
  const last = refusals.at(-1) || 'unknown refusal'
  throw new Error(`seat ${role}: agent "${agentName}" ships no headless transport — tried ${HEADLESS_TRANSPORTS.join(', ')} (last refusal: ${last})`)
}

export function assertCapabilities(role, agentName, capabilities, allowed = [], requires = SEAT_DEFAULTS[role].requires, { withheld = [] } = {}) {
  if (SEAT_DEFAULTS[role].deny && capabilities?.tool_deny !== true) {
    const err = new Error(`seat ${role} needs tool denial (deny: "${SEAT_DEFAULTS[role].deny}") but agent adapter "${agentName}" declares tool_deny: false — refusing to boot a weaker seat`)
    err.reason = 'capability-shortfall'
    throw err
  }
  for (const cap of requires || []) {
    if (capabilities?.[cap] === true) continue
    if (allowed.includes(cap)) continue
    const err = withheld.includes(cap)
      ? new Error(`seat ${role} requires capability "${cap}" but crew/capabilities.json grants seat ${role} nothing that delivers it (tools: [...], agents: [...]) — refusing to boot a weaker seat (grant it in crew/capabilities.json roles.${role}, or pass --allow-shortfall-${role} ${cap} to boot it degraded on purpose)`)
      : new Error(`seat ${role} requires capability "${cap}" but agent adapter "${agentName}" declares ${cap}: ${JSON.stringify(capabilities?.[cap])} — refusing to boot a weaker seat (pass --allow-shortfall-${role} ${cap} to boot it degraded on purpose)`)
    err.reason = 'capability-shortfall'
    throw err
  }
}

export function seatShortfalls(role, args = {}) {
  const raw = args[`allow-shortfall-${role}`]
  if (raw === true) throw new Error(`--allow-shortfall-${role} needs a capability name (e.g. --allow-shortfall-${role} subagents) — a bare flag would waive every capability`)
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)
}

export function bootAllocation(roles, args = {}, sources = null, transports = null) {
  const out = {}
  for (const role of roles) {
    const shortfall = seatShortfalls(role, args)
    const transport = transports?.[role]
    const cell = {
      ...(sources?.[role] || {}),
      ...(shortfall.length ? { shortfall } : {}),
      ...(transport !== undefined ? { transport } : {}),
    }
    if (Object.keys(cell).length) out[role] = cell
  }
  return Object.keys(out).length ? out : null
}

// Resolve a roster tier into seated roles, per-seat cells, and a per-field
// provenance map. PURE: sync, no imports, no adapter knowledge — the
// per-adapter model-string translation is a separate step (resolveSeatModels)
// so this function stays testable with a bare roster object.
export function resolveTier(roster, tier, args = {}) {
  const cells = roster?.tiers?.[tier]
  if (!cells) throw new Error(`unknown tier "${tier}" — valid tiers: ${Object.keys(roster?.tiers || {}).join(', ')}`)
  // Canonical order first, then any roster-typo keys ROLE_ORDER doesn't know
  // about — a typo must surface at boot's SEAT_DEFAULTS check, never be
  // silently dropped.
  const order = [...ROLE_ORDER.filter((r) => r in cells), ...Object.keys(cells).filter((r) => !ROLE_ORDER.includes(r))]
  const roles = []
  const seats = {}
  const sources = {}
  for (const role of order) {
    const cell = cells[role]
    if (!cell) continue // null/absent -> not seated
    roles.push(role)
    const agentOverride = args[`agent-${role}`]
    const effortOverride = args[`effort-${role}`]
    const modelOverride = args[`model-${role}`]
    seats[role] = {
      agent: agentOverride || cell.agent,
      effort: effortOverride || cell.effort,
      provider: cell.provider,
      id: cell.id,
      // null = "translate from provider/id"; a flag value is a RAW
      // passthrough, never translated (the operator is speaking their own
      // CLI's namespace).
      model: modelOverride || null,
    }
    sources[role] = {
      agent: agentOverride ? 'override' : 'roster',
      model: modelOverride ? 'override' : 'roster',
      effort: effortOverride ? 'override' : 'roster',
    }
  }
  // A flag naming a role the tier does not seat is a loud throw — silently
  // dropping operator intent is the worse failure.
  for (const key of Object.keys(args)) {
    const m = /^(model|agent|effort)-(.+)$/.exec(key)
    if (m && !roles.includes(m[2])) {
      throw new Error(`--${m[1]}-${m[2]} given but tier ${tier} seats no ${m[2]}`)
    }
  }
  return { roles, seats, sources }
}

// The per-adapter translation step, kept out of the pure resolver: a roster
// cell is translated by the adapter that will run it; a --model-<role>
// override is already the operator's own CLI namespace and passes through
// raw. `adapters` is the {role: {name, adapter}} map resolveAdapters returns.
export function resolveSeatModels(seats, adapters, localProviders = null) {
  const out = {}
  for (const [role, seat] of Object.entries(seats)) {
    // A raw --model-<role> override is the operator's own CLI namespace: it is
    // never translated, AND it invalidates the roster cell it replaced. Keeping
    // that cell's provider/id would make the boot record name a model the seat
    // is not running (#161). Never guess a provider from a raw string — null is
    // the honest answer.
    if (seat.model) { out[role] = { ...seat, provider: null, id: null }; continue }
    const adapter = adapters[role]?.adapter
    // The typeof fallback keeps a third-party adapter without modelString
    // bootable.
    const model = typeof adapter?.modelString === 'function'
      ? adapter.modelString({ provider: seat.provider, id: seat.id, localProviders })
      : seat.id
    out[role] = { ...seat, model }
  }
  return out
}

// Resolve each role's agent name to its adapter module, by filename — this
// IS the seam: adding an agent means dropping a file in crew/adapters/, not
// editing crew.mjs. Dynamic import() is inherently async. `seats` (optional)
// is a tier's resolved seat map — when present, its agent choice wins over
// the --agent-<role>/SEAT_DEFAULTS flags-or-default path.
export async function resolveAdapters(roles, args, seats = null, deps = {}) {
  const out = {}
  const sourceArgs = args || {}
  for (const key of Object.keys(sourceArgs)) {
    const m = /^allow-shortfall-(.+)$/.exec(key)
    if (m && !roles.includes(m[1])) throw new Error(`--allow-shortfall-${m[1]} given but crew seats no ${m[1]}`)
  }
  const registry = deps.register ? loadCapabilities({ register: deps.register }) : loadCapabilities()
  const root = deps.root ?? REGISTER_ROOT
  const exists = deps.exists || existsSync
  const probeEndpoint = deps.probeEndpoint || probeLocalEndpoint
  for (const role of roles) {
    try {
      const name = String(seats?.[role]?.agent || seatAgent(role, sourceArgs))
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`invalid agent adapter name "${name}" for seat ${role}`)
      const file = join(HERE, 'adapters', `adapter-${name}.mjs`)
      if (!existsSync(file)) throw new Error(`unknown agent adapter "${name}" for seat ${role}: no such adapter file ${file}`)
      const adapter = await import(pathToFileURL(file).href)
      if (typeof adapter.seatCommand !== 'function') throw new Error(`agent adapter "${name}" for seat ${role} (${file}) does not export a seatCommand function`)
      if (typeof adapter.capabilitiesFor !== 'function') throw new Error(`agent adapter "${name}" for seat ${role} (${file}) does not export a capabilitiesFor function`)
      const transport = seatTransport({ role, args: sourceArgs, adapter, agentName: name })
      const grants = grantsFor(registry, role, { root, exists })
      assertGrantsBacked(role, grants, registry)

      let configDir = null
      const provider = seats?.[role]?.provider
      const localProvider = provider && Object.hasOwn(registry.local_providers, provider) ? registry.local_providers[provider] : null
      if (localProvider) {
        const settingsPath = resolvedGrantPath(root, localProvider.settings)
        if (!pathExists(exists, settingsPath)) {
          throw pathMessage('local-settings-missing', role, `local provider ${provider} settings`, 'an existing checkout-relative path', 'missing', settingsPath)
        }
        let live = false
        try { live = await probeEndpoint(localProvider.base_url) } catch { live = false }
        if (!live) {
          throw refuse('local-endpoint-dead', `seat ${role} local provider ${provider} endpoint ${localProvider.base_url} is unavailable — refusing to boot a dead local-provider cell`)
        }
        const capabilities = adapter.capabilitiesFor({ transport })
        if (capabilities.local_provider !== true) {
          throw refuse('grant-unsupported', `seat ${role} local provider ${provider} is not supported by adapter ${name} — refusing to boot a silently weaker seat`)
        }
        configDir = dirname(settingsPath)
      }

      const requires = [...new Set([...(SEAT_DEFAULTS[role].requires || []), ...grants.requires])]
      const bare = adapter.capabilitiesFor({ transport, grants: EMPTY_GRANTS })
      const declared = adapter.capabilitiesFor({ transport, grants })
      const effective = effectiveCapabilities({ declared, bare, grants })
      const withheld = Object.keys(CAPABILITY_DELIVERY).filter((cap) => declared[cap] === true && effective[cap] !== true)
      assertCapabilities(role, name, effective, seatShortfalls(role, sourceArgs), requires, { withheld })
      if (transport === HEADLESS_TRANSPORT && typeof adapter.headlessCommand !== 'function') {
        throw new Error(`agent adapter "${name}" for seat ${role} (${file}) does not export a headlessCommand function`)
      }
      out[role] = { name, adapter, transport, grants, configDir }
    } catch (err) {
      if (err.role === undefined) { err.role = role; err.cell = seats?.[role] ?? null }
      throw err
    }
  }
  Object.defineProperty(out, 'registry', { value: registry, enumerable: false })
  return out
}

export function memoryConfig(args = {}) {
  const source = args || {}
  const dir = source['memory-dir'] || process.env.CREW_MEMORY_DIR || null
  if (!dir) return null
  const backend = source['memory-backend'] || process.env.CREW_MEMORY_BACKEND || DEFAULT_BACKEND
  const rawBudget = source['memory-budget-bytes'] || process.env.CREW_MEMORY_BUDGET_BYTES || DEFAULT_BUDGET_BYTES
  const budget = typeof rawBudget === 'number'
    ? rawBudget
    : typeof rawBudget === 'string' && rawBudget.trim() ? Number(rawBudget) : NaN
  const valid = Number.isFinite(budget) && budget >= 0
  return {
    dir, backend,
    budgetBytes: valid ? budget : DEFAULT_BUDGET_BYTES,
    ...(valid ? {} : { reason: 'invalid-budget' }),
  }
}

export function memoryExtracts(roles, args, taskSlug) {
  try {
    const cfg = memoryConfig(args)
    if (!cfg) return { sections: {}, record: null }
    const memory = openMemory(cfg)
    const sections = {}
    const injected = []
    let bytes = 0
    let included = 0
    let dropped = 0
    let reason = cfg.reason || null
    for (const role of roles || []) {
      if (!MEMORY_ROLES.includes(role)) continue
      const extract = memory.context({ task: taskSlug, role })
      bytes += Number(extract.bytes) || 0
      included += Array.isArray(extract.included) ? extract.included.length : 0
      dropped += Array.isArray(extract.dropped) ? extract.dropped.length : 0
      const section = renderSection(extract, { backend: cfg.backend })
      if (section) {
        sections[role] = section
        injected.push(role)
      }
      if (!reason && extract.reason) reason = extract.reason
    }
    return {
      sections,
      record: {
        backend: cfg.backend, dir: cfg.dir, budget_bytes: cfg.budgetBytes,
        injected, bytes, included, dropped, reason,
      },
    }
  } catch (err) {
    return { sections: {}, record: { injected: [], error: err?.message || String(err) } }
  }
}

function writeRolePrompt(role, taskDir, section = '') {
  const seat = SEAT_DEFAULTS[role]
  // --append-system-prompt-file is LAST-WINS, not cumulative (verified against
  // claude 2.1.229): passing shared + role as two flags silently drops shared.
  // So the shared contract and the role card are merged into ONE prompt file
  // per seat, generated in the task dir at boot.
  const merged = join(taskDir, `role-${role}.md`)
  const shared = readFileSync(SHARED_PROMPT, 'utf8')
  const card = readFileSync(join(ROLES_DIR, seat.prompt), 'utf8')
  writeFileSync(merged, `${shared}\n\n${card}${section ? `\n\n${section}` : ''}`)
  return merged
}

function paneCommand(role, args, { taskDir, bootBrief, adapter, tierSeat, grants = EMPTY_GRANTS, configDir = null }) {
  const seat = SEAT_DEFAULTS[role]
  const merged = join(taskDir, `role-${role}.md`)
  // effort: per-seat boot flag (--effort-<role> high), OPTIONAL — or, when a
  // --tier was used, the roster's resolved seat (tierSeat), which flags still
  // override. Both shipped adapters declare transport-invariant effort in
  // the resolved profile and map it to their own flag (claude --effort, pi
  // --thinking).
  return adapter.seatCommand({
    role, model: tierSeat?.model || seatModel(role, args), promptFile: merged,
    tools: seat.tools, deny: seat.deny, taskDir, bootBrief,
    effort: tierSeat?.effort || args[`effort-${role}`] || undefined,
    grants, configDir,
  })
}

function stackVertical(nodes) {
  if (nodes.length === 1) return nodes[0]
  const [head, ...rest] = nodes
  return { direction: 'vertical', split: 1 / nodes.length, children: [head, stackVertical(rest)] }
}

// the first seated role takes the left half; the rest stack on the right.
export function composeLayout(roles, mk) {
  const panes = roles.map((r) => ({ pane: { surfaces: [{ type: 'terminal', name: r, command: mk(r) }] } }))
  if (panes.length === 1) return panes[0]
  const [head, ...rest] = panes
  return { direction: 'horizontal', split: 0.42, children: [head, stackVertical(rest)] }
}

// The park's seats are the crew's seated members. sessionId prefers the pane
// surface (what a human would reattach to) and falls back so a headless seat
// still yields a non-blank, unique key; `warm` records whether a live pane
// survived the escalation.
export function parkSeats(crew) {
  return (crew?.roles || [])
    .filter((role) => crew.members?.[role])
    .map((role) => {
      const m = crew.members[role]
      return { role, sessionId: m.surface_id || m.pane_id || `${m.transport}:${role}`, warm: !!m.surface_id }
    })
}

// ADR-029 §4's canonical attention shape, escalation moment. park_id is
// PRESENT on every event, minted or null.
export function escalationAttention({ task, park_id, why, artifacts = [] }) {
  return { kind: 'attention', moment: 'escalation', park_id: park_id ?? null, task, why, artifacts }
}

// Outcome-gated in the function itself, so `done mints nothing` is a property
// of the seam and not of its one call site. Returns {park_id, error}; NEVER
// throws (D2) — a store that cannot be opened or a mint that cannot complete
// is reported, not raised.
export function parkOnOutcome(result, { crew, runId, dir, reason, actor = 'crew', openStore } = {}) {
  if (result?.status !== 'escalation') return { park_id: null, error: null }
  const open = openStore || ((d) => reclaimStore({ dir: d, actor }))
  let res
  try {
    const seats = parkSeats(crew)
    if (!seats.length) return { park_id: null, error: 'no seated members to park' }
    res = open(dir).mintPark({ run_id: runId, seats, reason: reason || '' })
  } catch (err) { return { park_id: null, error: err?.message || String(err) } }
  if (!res?.ok || !res.park?.park_id) return { park_id: null, error: res?.reason || 'mint failed' }
  return { park_id: res.park.park_id, error: null }
}

export async function bootCmd(args, deps = {}) {
  const {
    cmux: cmuxFn = cmux, tree: treeFn = tree, renameTab: renameTabFn = renameTab,
    openLedger: openLedgerDep = null, existsSync: existsSyncDep = null,
    loadavg: loadavgDep = null, cpus: cpusDep = null,
  } = deps
  // Capture the invocation environment before async adapter resolution so the
  // breaker and host-load policies cannot be lost while boot is awaiting imports.
  const bootEnv = { ...process.env }
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const laneFence = resolveLaneFence(args)
  let roles, tierName = null, tierSeats = null, sources = null
  if (args.tier) {
    if (args.roles) throw new Error('--tier and --roles are mutually exclusive: the tier defines the seating')
    // The roster is the RUNTIME's policy, not the target checkout's. A
    // corrupt/missing roster must name the file and that rule, not throw a
    // bare "Unexpected token".
    const rosterPath = join(HERE, 'roster.json')
    let roster
    try { roster = JSON.parse(readFileSync(rosterPath, 'utf8')) } catch (err) {
      throw new Error(`--tier needs the crew runtime's own roster at ${rosterPath} (not the target checkout's): ${err.message}`)
    }
    ;({ roles, seats: tierSeats, sources } = resolveTier(roster, String(args.tier), args))
    tierName = String(args.tier)
  } else {
    roles = (args.roles ? args.roles.split(',') : [...DEFAULT_ROLES]).map((r) => r.trim())
    if (!roles.includes('lead')) roles = ['lead', ...roles]
  }
  for (const r of roles) if (!SEAT_DEFAULTS[r]) throw new Error(`unknown crew role: ${r}`)
  const headlessNames = String(args.headless === true ? '' : (args.headless || ''))
    .split(',').map((r) => r.trim()).filter(Boolean)
  const rpcNames = String(args['headless-rpc'] === true ? '' : (args['headless-rpc'] || ''))
    .split(',').map((r) => r.trim()).filter(Boolean)
  for (const role of [...headlessNames, ...rpcNames]) if (!roles.includes(role)) {
    throw new Error(`transport role ${role} given but crew seats no ${role}`)
  }
  for (const role of roles) transportFor(role, args) // detects ambiguous lists before cmux boot
  // #309: refuse a saturated HOST the way ADR-032's breaker refuses an open
  // cell. Opt-in (CREW_LOAD_THRESHOLD); with no policy nothing is measured and
  // boot is unchanged. Refuse HERE: before resolveAdapters, before the
  // noteRunlessCellFailure wrapper below, and before pathsFor/mkdirSync or any
  // cmux call, so a refusal leaves no state dir and no workspace behind. Host
  // saturation is not evidence against a cell, so it is never recorded as one.
  const load = hostLoad({
    policy: loadPolicy(bootEnv),
    ...(loadavgDep ? { loadavg: loadavgDep } : {}),
    ...(cpusDep ? { cpus: cpusDep } : {}),
  })
  assertHostQuiet(load)

  // Resolve adapters before touching cmux — a bad --agent-<role> or a
  // capability shortfall must fail before a workspace gets created.
  let adapters
  try {
    adapters = await resolveAdapters(roles, args, tierSeats)
  } catch (err) {
    noteRunlessCellFailure({ taskSlug, role: err.role ?? null, kind: 'boot-refusal', err, cell: err.cell ?? null })
    throw err
  }
  const registry = adapters.registry || loadCapabilities()
  const seats = tierSeats ? resolveSeatModels(tierSeats, adapters, registry.local_providers) : null
  // #45 Tier B: opt-in cell breaker. With no policy configured this is a
  // null and the ledger is never opened (acceptance #1). An open cell
  // refuses here, before any state dir or seat exists, and is NOT recorded
  // as a cell failure — a policy decision is not evidence against the cell.
  // An injected opener IS the ledger source, so its dbPath precheck is
  // meaningless; the precheck exists so a real boot never creates a ledger DB
  // as a side effect of the breaker check. Callers can still pin the precheck
  // explicitly through existsSync for a fake or custom ledger.
  const breaker = cellHealth({
    policy: breakerPolicy(bootEnv), seats, dbPath: ledgerDbPath(),
    ...(openLedgerDep ? {
      openLedger: openLedgerDep,
      existsSync: existsSyncDep ?? (() => true),
    } : {}),
  })
  assertCellsClosed(breaker)
  const paneRoles = roles.filter((role) => adapters[role].transport === DEFAULT_TRANSPORT)
  const headlessOnly = paneRoles.length === 0
  // #249 / ADR-033: transport follows the MODE, never the seat. A cmux workspace
  // exists so a human can inspect every seat in it, so a piped seat inside one is
  // a mode error, not a configuration. Refuse HERE: after resolveAdapters
  // (transport is unknowable before it) and before pathsFor/mkdirSync or any cmux
  // call, so a refusal leaves no state dir and no workspace behind. Deliberately
  // outside the noteRunlessCellFailure wrapper above — operator misconfiguration
  // is not evidence against a cell (ADR-032's posture).
  if (!headlessOnly) {
    const piped = roles.filter((role) => adapters[role].transport !== DEFAULT_TRANSPORT)
    if (piped.length) {
      const named = piped.map((role) => `${role} (${adapters[role].transport})`).join(', ')
      const err = new Error(
        `mixed transport: this boot would create a cmux workspace, but ${named} would be piped instead of seated in a pane. `
        + 'A workspace exists so a human can inspect EVERY seat in it; a piped seat there is visible only by tailing '
        + 'task/headless-rpc/<role>/stream.jsonl. Pick a mode: drop --headless/--headless-rpc so every seat gets a pane, '
        + 'or pass --headless-all for the factory shape, which creates no workspace at all.'
      )
      err.code = 'mixed-transport'
      throw err
    }
  }
  const workerBin = roles.some((role) => adapters[role].transport === HEADLESS_TRANSPORT) ? resolveWorkerBin(args) : null

  const paths = pathsFor(taskSlug, checkout)
  // The state dir keys on the checkout's BASENAME — two different checkouts
  // sharing a directory name would silently share (and clobber) one crew.
  // Refuse to boot over a live crew that belongs to a different checkout.
  const existing = existsSync(join(paths.dir, 'crew.json'))
    ? JSON.parse(readFileSync(join(paths.dir, 'crew.json'), 'utf8')) : null
  if (existing && existing.checkout !== checkout) {
    throw new Error(`a crew for task ${taskSlug} already exists for a DIFFERENT checkout (${existing.checkout}) — tear it down first or pick another task slug`)
  }
  mkdirSync(paths.taskDir, { recursive: true })
  mkdirSync(paths.returnsDir, { recursive: true })

  const bootBrief = `Crew for task ${taskSlug}. Task dir ${paths.taskDir}. Read your role in the system prompt, reply exactly ready: your-role, then wait.`
  const memory = memoryExtracts(roles, args, taskSlug)
  for (const role of roles) writeRolePrompt(role, paths.taskDir, memory.sections[role] || '')
  let workspace = null
  let windowId = null
  const members = {}
  const memberFor = (role, pane = null, surface = null) => ({
    pane_id: pane?.id || null, surface_id: surface?.id || null,
    transport: adapters[role].transport, model: seats?.[role]?.model || seatModel(role, args), agent: adapters[role].name,
    tools: effectiveTools(role, adapters[role].grants), deny: SEAT_DEFAULTS[role].deny,
    ...(seats ? { effort: seats[role].effort, provider: seats[role].provider, id: seats[role].id } : {}),
  })
  if (headlessOnly) {
    for (const role of roles) members[role] = memberFor(role)
  } else {
    const mk = (role) => paneCommand(role, args, {
      taskDir: paths.taskDir, bootBrief, adapter: adapters[role].adapter, tierSeat: seats?.[role],
      grants: adapters[role].grants, configDir: adapters[role].configDir,
    })
    const layout = composeLayout(paneRoles, mk)

    const before = treeFn()
    const res = cmuxFn('new-workspace', ['--name', `crew-${taskSlug}`, '--cwd', checkout, '--layout', JSON.stringify(layout), '--focus', 'true'])
    if (!res.ok) throw new Error(`new-workspace --layout failed: ${res.error.message}`)
    const after = treeFn()

    // Identify OUR workspace by the name we just set, never positionally —
    // "the last unseen id" mis-targets the moment two boots race. Name plus
    // new-since-before must yield exactly one workspace.
    const beforeWs = new Set()
    for (const w of before.windows || []) for (const ws of w.workspaces || []) beforeWs.add(ws.id)
    const candidates = []
    for (const w of after.windows || []) for (const ws of w.workspaces || []) {
      if (!beforeWs.has(ws.id) && (ws.name === undefined || ws.name === `crew-${taskSlug}`)) candidates.push({ ws, windowId: w.id })
    }
    if (candidates.length !== 1) throw new Error(`boot: expected exactly one new crew-${taskSlug} workspace, found ${candidates.length}`)
    const found = candidates[0]
    workspace = found.ws
    windowId = found.windowId
    const panes = workspace.panes || []
    if (panes.length !== paneRoles.length) throw new Error(`boot: expected ${paneRoles.length} panes, found ${panes.length}`)

    // Seat every role by its SURFACE NAME (set in the layout) — positional
    // mapping mis-seats every role silently if the tree's pane order ever
    // differs from layout order. Fall back to position only when the tree
    // carries no surface names at all, and fail loudly on a partial match.
    const byName = new Map()
    for (const p of panes) {
      const s = (p.surfaces || [])[0]
      if (s?.name) byName.set(String(s.name).toLowerCase(), { pane: p, surface: s })
    }
    if (byName.size > 0) {
      for (const role of paneRoles) {
        const hit = byName.get(role)
        if (!hit) throw new Error(`boot: no surface named ${role} in the new workspace (tree names: ${[...byName.keys()].join(', ')})`)
        members[role] = memberFor(role, hit.pane, hit.surface)
      }
    } else {
      paneRoles.forEach((role, i) => {
        const surface = (panes[i].surfaces || [])[0]
        members[role] = memberFor(role, panes[i], surface)
      })
    }
    // Unreachable since #249: the mixed-transport guard above refuses any
    // workspace boot with a non-pane seat. Kept as the symmetric partner of
    // the headlessOnly offender check below.
    for (const role of roles.filter((r) => adapters[r].transport !== DEFAULT_TRANSPORT)) members[role] = memberFor(role)
    for (const role of paneRoles) renameTabFn(members[role].surface_id, role)
  }

  const crew = {
    schema_version: 3, task: taskSlug, checkout,
    workspace_id: workspace ? workspace.id : null, window_id: windowId ?? null,
    roles, members, task_return: join(paths.returnsDir, 'task.json'),
    created_at: new Date().toISOString(),
    ...(workerBin ? { claude_bin: workerBin } : {}),
    ...(tierName ? { tier: tierName, seats } : {}),
    ...(laneFence ? { lane_name: laneFence.lane, lane_fence: laneFence.fence } : {}),
  }
  // crew/daemon.mjs paneSeat() is the consumer: daemon run refuses pane transport.
  if (headlessOnly) {
    const offender = roles.find((role) => !members[role]?.transport || members[role].transport === DEFAULT_TRANSPORT)
    if (offender) throw new Error(`boot: all-headless crew has a missing or pane transport for seat ${offender}`)
  }
  saveCrew(paths, crew)
  const allocation = bootAllocation(roles, args, sources, Object.fromEntries(roles.map((r) => [r, members[r].transport])))
  logLine(join(paths.dir, 'journal.jsonl'), {
    at: new Date().toISOString(), event: 'boot', roles,
    models: Object.fromEntries(roles.map((r) => [r, members[r].model])),
    transports: Object.fromEntries(roles.map((r) => [r, members[r].transport])),
    ...(workerBin ? { claude_bin: workerBin } : {}),
    ...(tierName ? { tier: tierName, seats } : {}),
    ...(allocation ? { allocation } : {}),
    ...(breaker ? { breaker } : {}),
    ...(load ? { load } : {}),
    ...(laneFence ? { lane_name: laneFence.lane, fenced_lanes: laneFence.fence.length } : {}),
    capabilities: { schema_version: registry.schema_version, roles: Object.keys(registry.roles) },
    ...(memory.record ? { memory: memory.record } : {}),
  })
  process.stdout.write(`${JSON.stringify({ workspace_id: workspace ? workspace.id : null, members, task_dir: paths.taskDir, crew_json: join(paths.dir, 'crew.json') })}\n`)
}

function ledgerDbPath() {
  return process.env.DEVTEAM_LEDGER_DB
    || join(process.env.DEVTEAM_LEDGER_DIR || join(homedir(), '.dev-team', 'factory'), 'ledger.db')
}

// A boot refusal and a seat that never came up both happen BEFORE openRun
// (:610) — there is no adw_id to key them on, and the ledger's cell_failures
// table takes a NULL one for exactly this reason. Never load-bearing.
function noteRunlessCellFailure({ taskSlug, role, kind, err, cell = null, member = null }) {
  if (!role) return
  recordCellFailure({
    dbPath: ledgerDbPath(), task_slug: taskSlug, role, kind,
    agent: member?.agent ?? cell?.agent ?? null,
    provider: member?.provider ?? cell?.provider ?? null,
    model_id: member?.id ?? cell?.id ?? null,
    model: member?.model ?? cell?.model ?? null,
    effort: member?.effort ?? cell?.effort ?? null,
    transport: member?.transport ?? null,
    stage: err?.stage ?? null, detail: err?.message ?? null,
  })
}


export function runCmd(args, deps = {}) {
  // Refuse an unknown shape BEFORE any state is read, spawned or written —
  // the same posture as boot's assertCellsClosed and mixed-transport guards.
  const variant = resolveVariant(args)
  const { drive = driveTask } = deps
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  const crew = loadCrew(paths)
  assertSameCheckout(crew, checkout)
  if (!args['brief-file']) throw new Error('run requires --brief-file <path to the task brief>')
  const briefFile = resolvePath(args['brief-file'])
  if (!existsSync(briefFile)) throw new Error(`brief file not found: ${briefFile}`)
  // The driver assigns planner/builder/reviewer unconditionally — discover a
  // missing seat NOW, not mid-loop after a plan and a build are spent.
  assertSeats(crew)
  const filesInScope = resolveFilesInScope(
    args, variant, crew.task_return ? resolvePath(paths.dir, crew.task_return) : join(paths.returnsDir, 'task.json'),
  )
  // The scope gate reads `git status` as ground truth — a dirty checkout at
  // start would be attributed to the builder and poison every scope verdict.
  const dirty = execSync('git status --porcelain', { cwd: checkout, encoding: 'utf8' }).trim()
  if (dirty) throw new Error(`checkout is dirty — commit or stash before a crew run:\n${dirty.split('\n').slice(0, 10).join('\n')}`)

  const journal = join(paths.dir, 'journal.jsonl')
  const protectedFloor = checkoutProtectedPaths({ checkout })
  logLine(journal, { at: new Date().toISOString(), event: 'protected-paths',
    basis: protectedFloor.basis, count: protectedFloor.paths.length })
  const laneFence = Array.isArray(crew.lane_fence) ? crew.lane_fence : null
  if (laneFence) {
    logLine(journal, { at: new Date().toISOString(), event: 'lane-fence',
      lane_name: crew.lane_name ?? null, lanes: laneFence.length,
      files: laneFence.reduce((n, record) => n + record.files.length, 0) })
  }
  // Keep the test lane at 30 s per test: the slowest real test is ~25 ms,
  // giving ~1200× headroom even when the machine is saturated by three crews.
  // This is well below realIo.run's 900 s kill, so a hung test is reported by
  // name as timed out instead of ending as an anonymous SIGTERM.
  // --test-timeout is per-test: it bounds one hung test, not a pathological
  // whole-suite case. A wall-clock bound on the lane would be a driver change,
  // deliberately not done here. Keep this string identical to
  // package.json's scripts.test and crew/child.mjs's default;
  // crew/crew.test.mjs pins the three-way agreement.
  const ctx = {
    task: taskSlug, briefFile, taskDir: paths.taskDir, checkout, journal,
    protectedPaths: protectedFloor.paths,
    protectedPathsBasis: protectedFloor.basis,
    ...(laneFence ? { laneFence, laneName: crew.lane_name ?? null } : {}),
    roles: crew.roles, lane: args.lane || null, suite: args.suite || 'node --test --test-timeout=30000', variant,
    ...(filesInScope ? { files_in_scope: filesInScope } : {}),
  }
  // Seats are TUI processes and the first assignment must not race their
  // boot: characters typed into a pty before the TUI grabs it are silently
  // swallowed (live-hit 2026-08-13 — the leading chunk of the first
  // assignment vanished on both crews). Gate on each seat actually replying
  // ready (or, as a fallback, rendering agent chrome) before driving.
  try {
    awaitSeatsReady(crew, 120, journal)
  } catch (err) {
    for (const role of err.roles || []) {
      noteRunlessCellFailure({ taskSlug, role, kind: 'seat-not-ready', err, member: crew.members[role] })
    }
    throw err
  }

  // The factory ledger mirror (#94). openRun() never throws and degrades
  // to an inert emitter; the extra try/catch covers a caller-side surprise
  // (a bad path, an unwritable home) so instrumentation can never take a
  // crew run down. nodeVersion is deliberately NOT passed: openLedger's own
  // default is process.versions.node, and passing process.version silently
  // fails the ledger floor parse and drops every mirror row.
  let emitter = null
  try {
    emitter = openRun({ stateDir: paths.dir, repoSlug: paths.repo, taskSlug, dbPath: ledgerDbPath() })
    emitter.startRun()
  } catch { emitter = null }

  const io = realIo(crew, paths, checkout, emitter, null, args)
  // A throw out of the driver (member timeout, dead pane, git failure) is an
  // OUTCOME, not a stack trace: it must still produce a task envelope, or a
  // concurrent `crew.mjs wait` spins its full timeout for nothing.
  let result
  try {
    result = drive(ctx, io)
  } catch (err) {
    logLine(journal, { at: new Date().toISOString(), event: 'driver-crash', error: err.message })
    result = {
      status: 'escalation',
      summary: `Task ${taskSlug} needs a human: the driver crashed (${err.message})`,
      artifacts: [journal],
      details: { stages: null, commit: null, dissents: [], escalation: { where: err.stage || 'driver', why: err.message } },
    }
  }
  // Outcome-gated recovery state (#165): an escalation leaves a parked/null
  // park whose seats are this crew's, and the attention event carries its id.
  // A mint failure is loud but non-fatal (ADR-029 §4 amendment): the run still
  // escalates, and the workspace it never tears down stays the fallback
  // context.
  const { park_id, error: parkError } = parkOnOutcome(result, {
    crew, runId: emitter?.adwId || `${taskSlug}-${new Date().toISOString()}`,
    dir: join(paths.dir, 'reclaim'), actor: `crew:${taskSlug}`,
    reason: result.details?.escalation?.why || result.summary || '',
  })
  if (parkError) {
    logLine(journal, { at: new Date().toISOString(), event: 'park-mint-failed', error: parkError })
    process.stderr.write(`warning: could not mint an escalation park (${parkError}) — the workspace at ${paths.dir} is the recovery context\n`)
  }
  if (result.status === 'escalation') {
    const attention = escalationAttention({
      task: taskSlug, park_id,
      why: result.details?.escalation?.why || result.summary || '',
      artifacts: result.artifacts || [],
    })
    logLine(journal, { at: new Date().toISOString(), ...attention })
    try { io.emit?.(attention) } catch { /* instrumentation is never load-bearing */ }
  }
  // The task envelope is written by CODE — same path `wait` watches. It is
  // written BEFORE the seats are settled: a worker that refuses to die must
  // never change the run's recorded outcome.
  writeFileSync(crew.task_return, JSON.stringify(result, null, 2))
  settleSeatTeardown(io)
  try { emitter?.endRun({ status: result.status === 'done' ? 'ok' : 'aborted' }) } catch { /* never load-bearing */ }

  // Outcome-gated lifecycle, in code as policy:
  //   done       -> auto-teardown (archive the record, close the view),
  //                 unless --keep was passed for pane inspection.
  //   escalation -> NEVER teardown: the workspace IS the escalation context
  //                 (warm members, readable panes) the human needs.
  // An archive failure degrades to a warning: it must never turn an
  // already-committed task into a reported error.
  let archived = null
  if (result.status === 'done' && !args.keep) {
    try { archived = teardownCore(paths, crew) } catch (err) {
      process.stderr.write(`warning: teardown/archive failed (${err.message}) — crew dir left at ${paths.dir}\n`)
    }
  }
  // After archive the envelope moves with the dir — report where it lives now.
  const taskReturn = archived ? crew.task_return.replace(paths.dir, archived) : crew.task_return
  process.stdout.write(`${JSON.stringify({ status: result.status, commit: result.details?.commit ?? null, task_return: taskReturn, archived })}\n`)
  if (result.status !== 'done') process.exitCode = 1
}

// A seat's readiness, layered so it stays agent-agnostic:
// 1. PRIMARY: the seat's own ready reply. Every boot brief instructs exactly
//    `ready: <role>`, and the brief's own text says the literal "your-role",
//    so the echoed brief can never satisfy a real role's pattern.
// 2. FALLBACK: agent TUI chrome, for panes that have scrolled past the reply
//    (re-runs against a long-lived workspace). Loose by design and documented
//    as second-rate evidence: chrome proves the TUI is up, not that the seat
//    read its brief. A false positive costs one assignment typed a beat early;
//    a false negative costs a 120s hang and a killed boot.
export const READY_CHROME = Object.freeze([
  /bypass permissions|shift\+tab to cycle|❯/, // claude
  /\(sub\)|\s•\s/, // pi status line: "$0.000 (sub) … gpt-5.6-luna • high"
])
export function seatReadySignal(screen, role) {
  const s = String(screen || '')
  if (new RegExp(`ready:\\s*${role}\\b`, 'i').test(s)) return 'ready-reply'
  return READY_CHROME.some((re) => re.test(s)) ? 'chrome' : null
}

export function awaitSeatsReady(crew, timeoutS = 120, journal = null, deps = {}) {
  const cmuxFn = deps.cmux || cmux
  const logLineFn = deps.logLine || logLine
  const now = deps.now || (() => Date.now())
  const sleep = deps.sleep || ((ms) => {
    const sab = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(sab), 0, 0, ms)
  })
  const deadline = now() + timeoutS * 1000
  const pending = new Set(Object.keys(crew.members).filter((role) => crew.members[role].surface_id))
  while (pending.size > 0) {
    for (const role of [...pending]) {
      const res = cmuxFn('read-screen', ['--surface', crew.members[role].surface_id, '--lines', '40'])
      const sig = res.ok && seatReadySignal(res.stdout, role)
      if (sig) {
        pending.delete(role)
        if (journal) logLineFn(journal, { at: new Date().toISOString(), event: 'seat-ready', role, signal: sig })
      }
    }
    if (pending.size === 0) break
    if (now() > deadline) {
      const err = new Error(`seats never became ready within ${timeoutS}s: ${[...pending].join(', ')}`)
      err.roles = [...pending]
      throw err
    }
    sleep(2000)
  }
}

// planner/builder/reviewer are assigned unconditionally by the driver. The
// lead is required ONLY if the crew was booted with one: a lead-less crew
// (mechanical tier) is valid, and drive.mjs escalates where it would consult.
export function assertSeats(crew) {
  for (const role of ['planner', 'builder', 'reviewer']) {
    if (!crew.members[role]) throw new Error(`v3 run requires a ${role} seat (booted roles: ${crew.roles.join(', ')})`)
  }
  if (crew.roles.includes('lead') && !crew.members.lead) {
    throw new Error(`v3 run requires a lead seat (booted roles: ${crew.roles.join(', ')})`)
  }
}

// pathsFor keys on the checkout BASENAME — assert the crew on disk actually
// belongs to the checkout this command is about to drive against.
function assertSameCheckout(crew, checkout) {
  if (crew.checkout && crew.checkout !== checkout) {
    throw new Error(`this crew was booted for ${crew.checkout}, not ${checkout} — same directory name, different checkout`)
  }
}

// v2 legacy: hand the whole task to the LEAD as the driver (agent-driven).
function handoffCmd(args) {
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  const crew = loadCrew(paths)
  assertSameCheckout(crew, checkout)
  if (!args['brief-file']) throw new Error('handoff requires --brief-file <path to the task brief>')
  const briefFile = resolvePath(args['brief-file'])
  if (!existsSync(briefFile)) throw new Error(`brief file not found: ${briefFile}`)
  if (!crew.members.lead) throw new Error(`handoff needs a lead seat; this crew was booted lead-less (roles: ${crew.roles.join(', ')})`)

  const line = `TASK: run this task end to end. Read the brief at ${briefFile} and the crew map at ${join(paths.dir, 'crew.json')}. Drive the crew, verify, commit on green, then write your ReturnEnvelope to ${crew.task_return} and print CREW-DONE lead task`
  sendLine(crew.members.lead.surface_id, line)
  logLine(join(paths.dir, 'journal.jsonl'), { at: new Date().toISOString(), event: 'handoff', brief: briefFile })
  process.stdout.write(`${JSON.stringify({ handed_to: 'lead', task_return: crew.task_return })}\n`)
}

// The newest archived task envelope for a torn-down crew, or null. run's
// auto-teardown moves the whole dir — wait/status must be able to follow it
// rather than reporting "no crew booted" for a task that COMPLETED.
function archivedReturn(paths) {
  const parent = dirname(paths.dir)
  const base = `${paths.dir.split('/').pop()}.archive-`
  if (!existsSync(parent)) return null
  const archives = readdirSync(parent).filter((n) => n.startsWith(base)).sort()
  for (let i = archives.length - 1; i >= 0; i -= 1) {
    const p = join(parent, archives[i], 'returns', 'task.json')
    if (existsSync(p)) return p
  }
  return null
}

function waitCmd(args) {
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  // No loadCrew here: the live dir may vanish mid-wait when run auto-tears
  // down on done — poll the live envelope path AND the archive fallback.
  const livePath = join(paths.returnsDir, 'task.json')
  const timeoutMs = Number(args['timeout-s'] || 3600) * 1000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const p of [livePath, archivedReturn(paths)]) {
      if (!p || !existsSync(p)) continue
      let env = null
      try { env = JSON.parse(readFileSync(p, 'utf8')) } catch { env = null }
      if (env && typeof env.status === 'string') {
        process.stdout.write(`${JSON.stringify({ status: env.status, summary: env.summary, artifacts: env.artifacts || [], details: env.details || {}, task_return: p })}\n`)
        return
      }
    }
    const sab = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(sab), 0, 0, 5000)
  }
  process.stdout.write(`${JSON.stringify({ status: 'still-running' })}\n`)
  process.exitCode = 1
}

export function seatLiveness(crew, probe = paneAlive) {
  const alive = {}
  for (const [role, m] of Object.entries(crew.members)) alive[role] = m.surface_id ? probe(m.surface_id) : 'headless'
  return alive
}

function statusCmd(args) {
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  if (!existsSync(join(paths.dir, 'crew.json'))) {
    const archived = archivedReturn(paths)
    if (archived) { process.stdout.write(`${JSON.stringify({ task: taskSlug, archived: true, task_return: archived })}\n`); return }
  }
  const crew = loadCrew(paths)
  assertSameCheckout(crew, checkout)
  const alive = seatLiveness(crew)
  process.stdout.write(`${JSON.stringify({ task: crew.task, workspace_id: crew.workspace_id, alive })}\n`)
}

// Archive the crew dir (the durable record: envelopes, journal, artifacts)
// and close the ephemeral view (panes, workspace). Everything evidentiary is
// on disk by contract before this runs — deliverables live in files, never
// pane scrollback.
export function teardownCore(paths, crew, deps = {}) {
  const closeSurfaceFn = deps.closeSurface || closeSurface
  const closeWorkspaceFn = deps.closeWorkspace || closeWorkspace
  const renameSyncFn = deps.renameSync || renameSync
  for (const m of Object.values(crew.members)) if (m.surface_id) closeSurfaceFn(m.surface_id)
  // The viewer is not in crew.members, so the loop above never sees it, and
  // close-workspace is documented to no-op while a live pane occupies the
  // workspace — close it by id rather than trusting the workspace close.
  if (crew.doc_viewer?.surface_id) closeSurfaceFn(crew.doc_viewer.surface_id)
  if (crew.workspace_id) closeWorkspaceFn(crew.workspace_id)
  // Full timestamp, not date-only: a second same-day run of the same slug
  // must never ENOTEMPTY onto the first run's archive.
  const archived = `${paths.dir}.archive-${new Date().toISOString().replace(/[:.]/g, '-')}`
  renameSyncFn(paths.dir, archived)
  return archived
}

function teardownCmd(args) {
  const taskSlug = slug(args.task)
  const checkout = resolvePath(args.checkout || process.cwd())
  const paths = pathsFor(taskSlug, checkout)
  const crew = loadCrew(paths)
  assertSameCheckout(crew, checkout)
  const archived = teardownCore(paths, crew)
  process.stdout.write(`${JSON.stringify({ archived })}\n`)
}

// A --flag followed by another --flag (or by nothing) is a BOOLEAN true —
// otherwise `run --brief-file x --keep` silently loses --keep.
function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]
    if (!t.startsWith('--')) { out._.push(t); continue }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) { out[t.slice(2)] = true } else { out[t.slice(2)] = next; i += 1 }
  }
  return out
}

const COMMANDS = { boot: bootCmd, run: runCmd, handoff: handoffCmd, wait: waitCmd, status: statusCmd, teardown: teardownCmd }
const invokedDirectly = process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const [verb, ...rest] = process.argv.slice(2)
  const fn = COMMANDS[verb]
  if (!fn) { process.stderr.write(`usage: crew.mjs <${Object.keys(COMMANDS).join('|')}> --task <slug> ...\n`); process.exit(2) }
  // fn may be async (boot resolves adapters via dynamic import) — a sync
  // try/catch cannot see an async rejection, so a promise result is also
  // routed to `fail` explicitly.
  const fail = (err) => {
    process.stderr.write(`error: ${err.message}\n`)
    process.stdout.write(`${JSON.stringify({ error: err.message })}\n`)
    process.exit(1)
  }
  try {
    const r = fn(parseArgs(rest))
    if (r && typeof r.then === 'function') r.catch(fail)
  } catch (err) { fail(err) }
}
