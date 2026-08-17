import {
  existsSync as fsExistsSync, readFileSync as fsReadFileSync, writeFileSync as fsWriteFileSync,
  unlinkSync as fsUnlinkSync, renameSync as fsRenameSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execSync as cpExecSync, execFileSync as cpExecFileSync, spawnSync as cpSpawnSync } from 'node:child_process'

import {
  cmux as defaultCmux, tree as defaultTree, locate as defaultLocate, sendLine as defaultSendLine,
  closeSurface as defaultCloseSurface, logLine as defaultLogLine, assignmentLine as defaultAssignmentLine,
} from './driver.mjs'
import { headlessIo as defaultHeadlessIo } from './headless.mjs'
import { headlessRpcIo as defaultHeadlessRpcIo } from './headless-rpc.mjs'
import { modelString as claudeModelString } from './adapters/adapter-claude.mjs'
import { modelString as piModelString } from './adapters/adapter-pi.mjs'

export const DEFAULT_TRANSPORT = 'pane'
export const HEADLESS_TRANSPORT = 'headless-json'
export const HEADLESS_RPC_TRANSPORT = 'headless-rpc'
export const WAIT_POLL_MS = 5000
export const LIVENESS_PROBE_MS = 30_000
export const LIVENESS_MISSES_TO_DIE = 2

const HERE = dirname(fileURLToPath(import.meta.url))

// One rung stronger = the SAME seat's cell one tier up, read from the crew
// RUNTIME's own roster (the rule crew/crew.mjs:364-371 states), never the
// target checkout's. No new roster field, no ctx plumbing, no boot change.
export const RESEAT_LADDER = Object.freeze(['mechanical', 'build', 'judge'])
export const RESEAT_REASONS = Object.freeze(['transport', 'exhausted', 'no-tier', 'agent-change'])

// The shipped adapters' roster-cell translations, keyed by the seat's own
// `agent` name — the same "injected wins, shipped default otherwise" shape
// crew/headless.mjs:128 and crew/headless-rpc.mjs:122 already use for command
// composition (#239). realIo is synchronous, so it cannot do crew.mjs's
// dynamic import(): an agent whose adapter is not one of these two has nothing
// here that can vouch for the translation, and reseat refuses rather than
// writing a bare id.
const SHIPPED_MODEL_STRINGS = Object.freeze({ claude: claudeModelString, pi: piModelString })

export function modelStringFor(adapters, role, agent) {
  const injected = adapters?.[role]?.adapter
  if (typeof injected?.modelString === 'function') return injected.modelString.bind(injected)
  const shipped = SHIPPED_MODEL_STRINGS[String(agent)]
  return typeof shipped === 'function' ? shipped : null
}

export function nextRung(roster, tier, role) {
  const tiers = roster?.tiers || roster
  const index = RESEAT_LADDER.indexOf(tier)
  if (index < 0 || index >= RESEAT_LADDER.length - 1) return null
  const next = RESEAT_LADDER[index + 1]
  const cell = tiers?.[next]?.[role]
  if (!cell || typeof cell !== 'object') return null
  return {
    rung: `${tier}→${next}`,
    cell: { provider: cell.provider, id: cell.id, effort: cell.effort, agent: cell.agent },
  }
}

export function nextModelRung(roster, cell) {
  try {
    const provider = cell?.provider
    const id = cell?.id
    if (typeof provider !== 'string' || provider.trim() === '' || typeof id !== 'string' || id.trim() === '') return null
    const models = roster?.models
    if (!models || typeof models !== 'object' || Array.isArray(models)) return null
    const currentKey = `${provider}/${id}`
    if (!Object.hasOwn(models, currentKey)) return null
    const current = models[currentKey]
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Number.isFinite(current.cost_in_per_mtok)) return null
    const prefix = `${provider}/`
    const candidates = []
    for (const [key, entry] of Object.entries(models)) {
      if (!key.startsWith(prefix)) continue
      const nextId = key.slice(prefix.length)
      if (!nextId || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      if (!Number.isFinite(entry.cost_in_per_mtok) || entry.cost_in_per_mtok <= current.cost_in_per_mtok) continue
      if (Array.isArray(entry.tags) && entry.tags.includes('override-only')) continue
      candidates.push({ id: nextId, cost: entry.cost_in_per_mtok })
    }
    candidates.sort((a, b) => a.cost - b.cost || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const next = candidates[0]
    if (!next) return null
    return {
      rung: `model:${id}→${next.id}`,
      cell: { provider, id: next.id, effort: cell.effort, agent: cell.agent },
    }
  } catch { return null }
}

function addTotals(prev, delta) {
  return {
    billed_input_tokens: (prev?.billed_input_tokens ?? 0) + (delta?.billed_input_tokens ?? 0),
    billed_output_tokens: (prev?.billed_output_tokens ?? 0) + (delta?.billed_output_tokens ?? 0),
    billed_cache_write_tokens: (prev?.billed_cache_write_tokens ?? 0) + (delta?.billed_cache_write_tokens ?? 0),
    billed_cache_read_tokens: (prev?.billed_cache_read_tokens ?? 0) + (delta?.billed_cache_read_tokens ?? 0),
  }
}

export function saveCrew(paths, crew, fs = {}) {
  const writeFileSync = fs.writeFileSync || fsWriteFileSync
  const renameSync = fs.renameSync || fsRenameSync
  const p = join(paths.dir, 'crew.json')
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(crew, null, 2))
  renameSync(tmp, p)
}

export function resolveWorkerBin(args = {}) {
  const explicit = args['claude-bin']
  const env = process.env.CREW_CLAUDE_BIN
  const home = join(homedir(), '.local', 'bin', 'claude')
  const candidates = [
    ['--claude-bin', explicit],
    ['$CREW_CLAUDE_BIN', env],
    ['${HOME}/.local/bin/claude', home],
  ]
  for (const [label, candidate] of candidates) {
    if (!candidate) continue
    if (!String(candidate).startsWith('/')) {
      if (label === '--claude-bin' || label === '$CREW_CLAUDE_BIN') throw new Error(`headless worker binary ${label} must be an absolute path, got ${JSON.stringify(candidate)}`)
      continue
    }
    if (fsExistsSync(candidate)) return candidate
  }
  throw new Error(`no frozen headless worker binary found: checked --claude-bin, $CREW_CLAUDE_BIN, and ${home} (spike-findings.md:39-48)`)
}

export function docOpenArgs({ path, workspaceId, windowId }) {
  return ['open', path, '--workspace', workspaceId, '--window', windowId, '--direction', 'down', '--focus', 'false']
}

function newSurfaceIds(before, after) {
  const seen = new Set()
  for (const w of before.windows || []) for (const ws of w.workspaces || []) for (const p of ws.panes || []) for (const s of p.surfaces || []) seen.add(s.id)
  const fresh = []
  for (const w of after.windows || []) for (const ws of w.workspaces || []) for (const p of ws.panes || []) for (const s of p.surfaces || []) if (!seen.has(s.id)) fresh.push(s.id)
  return fresh
}

// Blueprint variants (#251): a shape's opening stage IS its own name; a bounded
// triage is that shape's planning phase. An envelope shape's acceptance is a
// terminal settle, not a build. A DATA map, so a new member is a data edit here
// too — not a new branch. Duplicated rather than imported: realio must not
// import the driver (the MODIFIER_OUTCOMES convention at :608); crew/crew.test.mjs
// pins this map against crew/drive.mjs's enum.
export const VARIANT_STAGE_PHASES = Object.freeze({ scout: 'planning', repair: 'planning', 'envelope-accept': 'finish' })

export function phaseForStage(label) {
  const head = String(label ?? '').split(':')[0]
  if (head === 'plan' || head === 'check') return 'planning'
  const declared = Object.prototype.hasOwnProperty.call(VARIANT_STAGE_PHASES, head)
    ? VARIANT_STAGE_PHASES[head] : null
  if (declared) return declared
  if (['build', 'scope-gate', 'lane', 'gate', 'gate-baseline', 'gate-repair', 'gate-reverify'].includes(head)) return 'build'
  if (head === 'review') return 'review'
  if (head === 'suite' || head === 'commit') return 'finish'
  if (head === 'done') return 'done'
  if (head === 'escalate') return 'escalation'
  return 'build'
}

// Map a transport's own err.stage onto the ledger's closed availability set.
// The stage strings are the transports' (crew/headless.mjs:204-212/:298,
// crew/headless-rpc.mjs:133-138, waitForEnvelope :248); anything unrecognised
// is a transport error, never a silent drop.
export function cellFailureKind(err) {
  const stage = String((err && err.stage) || '')
  if (stage === 'seat-died') return 'seat-died'
  const tail = stage.replace(/^(headless|rpc)-/, '')
  if (tail !== stage) {
    if (tail === 'timeout') return 'timeout'
    if (tail === 'no-envelope') return 'no-envelope'
    if (tail === 'malformed' || tail === 'parse-error') return 'unusable-envelope'
    if (tail === 'aborted') return 'aborted'
  }
  return 'transport-error'
}

export function emitAdapter(emitter, crew = null) {
  // The emitter owns the phase cursor and hands it back from every
  // phaseTransition; carry it onto every event so agent rows can be
  // associated with the phase they ran in (#123). A null cursor (degraded
  // emitter, or events before the first stage) is what recordEvent already
  // stores today, so this can never change a run.
  let phaseId = null
  const usageTotals = new Map()
  const record = (type, payload) => emitter.emit((handle, nextSeq) => handle.recordEvent({
    adw_id: emitter.adwId, type, seq: nextSeq('event'), phase_id: phaseId, payload,
  }))
  return (event) => {
    if (!event || typeof event !== 'object') return
    if (event.kind === 'stage') {
      const t = emitter.phaseTransition(phaseForStage(event.label))
      phaseId = typeof t?.phase_id === 'number' ? t.phase_id : null
      record('log', { level: 'info', message: event.label })
    } else if (event.kind === 'assign') {
      record('agent_start', { role: event.role, dispatch_id: event.id })
    } else if (event.kind === 'envelope') {
      record('agent_end', { role: event.role, outcome: event.status, dispatch_id: event.id })
      if (event.review) emitter.emit((handle) => handle.recordReviewOutcome({
        adw_id: emitter.adwId, phase_id: phaseId, dispatch_id: event.id, role: event.role,
        verdict: event.review.verdict, must_fix: event.review.must_fix ?? null,
        should_fix: event.review.should_fix ?? null, consider: event.review.consider ?? null,
      }))
    } else if (event.kind === 'decision') {
      record('decision', { decided: event.decided, why: event.why })
    } else if (event.kind === 'dissent') {
      record('decision', {
        decided: event.lead_decision,
        why: `dissent from ${event.from}`,
        alternatives: [event.recommendation],
      })
    } else if (event.kind === 'gate') {
      // The ledger's own gate tables, not a generic log row (#130).
      emitter.emit((handle) => handle.recordGateResult({
        adw_id: emitter.adwId, phase_id: phaseId,
        gate_name: String(event.name ?? 'gate'), attempt: event.attempt, ok: !!event.ok,
        checks: event.summary ? [event.summary] : [], violations: [],
        gate_generation: event.generation ?? null, pristine: !!event.pristine,
      }))
    } else if (event.kind === 'discrimination') {
      emitter.emit((handle) => handle.recordGateDiscrimination({
        adw_id: emitter.adwId, phase_id: phaseId, gate_generation: event.generation,
        verdict: event.verdict, checks_total: event.summary?.total ?? null,
        checks_failed: event.summary?.failed ?? null, checks_errored: event.summary?.errored ?? null,
        note: event.note ?? null,
      }))
    } else if (event.kind === 'accept-decision') {
      const residuals = Array.isArray(event.residuals) ? event.residuals : []
      const refuted = Array.isArray(event.refuted) ? event.refuted : []
      const unverified = Array.isArray(event.unverified) ? event.unverified : []
      const errors = Array.isArray(event.errors) ? event.errors : []
      emitter.emit((handle) => handle.recordAcceptDecision({
        adw_id: emitter.adwId, phase_id: phaseId, where: event.where, outcome: event.outcome,
        findings_total: event.findings_total ?? null,
        residual_count: residuals.length,
        refuted_count: refuted.length,
        cosmetic_count: residuals.filter((residual) => residual.type === 'cosmetic').length,
        unverified_count: unverified.length,
        invalid_reasons: errors.map(({ id, why }) => `${id ?? ''}: ${why}`).join('; '),
      }))
    } else if (event.kind === 'seat-teardown') {
      const m = (crew && crew.members && crew.members[event.role]) || null
      emitter.emit((handle) => handle.recordSeatTeardown({
        adw_id: emitter.adwId, phase_id: phaseId, role: event.role ?? null,
        transport: event.transport ?? m?.transport ?? null,
        session_id: event.session_id ?? null, pgid: event.pgid ?? null,
        reservation_id: event.reservation_id ?? null, outcome: event.outcome,
        reason: event.reason ?? null, forced: event.forced ? 1 : 0,
        evidence_kind: event.evidence_kind ?? null,
      }))
    } else if (event.kind === 'cell-failure') {
      // AVAILABILITY, not quality: the cell could not hold its seat or produce
      // anything usable. The cell itself is read from the booted crew, because
      // the driver only ever knows the role.
      const m = (crew && crew.members && crew.members[event.role]) || null
      emitter.emit((handle) => handle.recordCellFailure({
        adw_id: emitter.adwId, task_slug: (crew && crew.task) || null, phase_id: phaseId,
        dispatch_id: event.id ?? null, role: event.role ?? null,
        agent: m?.agent ?? null, provider: m?.provider ?? null, model_id: m?.id ?? null,
        model: m?.model ?? null, effort: m?.effort ?? null, transport: m?.transport ?? null,
        kind: event.failure, stage: event.stage ?? null, detail: event.detail ?? null,
      }))
    } else if (event.kind === 'modifier') {
      // MEASUREMENT, not policy (#238): every ATTEMPT lands a row, applied or not.
      // The transport is read from the booted crew because the driver only ever
      // knows the role — the same reason cell-failure enriches above.
      const m = (crew && crew.members && crew.members[event.role]) || null
      const cell = (c) => ({
        provider: c?.provider ?? null, model_id: c?.id ?? null, model: c?.model ?? null,
        agent: c?.agent ?? null, effort: c?.effort ?? null,
      })
      const from = cell(event.from || m)   // a null `from` means the role was not seated
      const to = cell(event.to)            // non-null iff the attempt APPLIED
      try {
        emitter.emit((handle) => handle.recordModifierAttempt({
          adw_id: emitter.adwId, task_slug: (crew && crew.task) || null, phase_id: phaseId,
          role: event.role ?? null, modifier: event.modifier, bounce: event.bounce ?? null,
          outcome: event.outcome, why: event.why ?? null, rung: event.rung ?? null,
          transport: m?.transport ?? null,
          from_provider: from.provider, from_model_id: from.model_id, from_model: from.model,
          from_agent: from.agent, from_effort: from.effort,
          to_provider: to.provider, to_model_id: to.model_id, to_model: to.model,
          to_agent: to.agent, to_effort: to.effort,
        }))
      } catch { /* modifier measurement is never load-bearing */ }
    } else if (event.kind === 'attention') {
      // ADR-029 §4: attention rides the existing closed log vocabulary.
      record('log', { level: 'warn', message: `attention:${event.moment} park_id=${event.park_id ?? 'null'} task=${event.task} ${event.why}` })
    } else if (event.kind === 'usage') {
      // agent_sessions is the per-assignment home; sessions.billed_* stays
      // NULL (per-run totals + money are the #119 follow-up). The table is
      // unique on (adw_id, claude_session_id) and a seat reuses ONE worker
      // session across assignments, while endAgentSession overwrites without
      // COALESCE — so what is written is the seat's RUNNING TOTAL, never a
      // delta that would clobber the previous assignment.
      emitter.emit((handle) => handle.startAgentSession({
        adw_id: emitter.adwId, dispatch_id: event.id ?? null, role: event.role ?? null,
        model: event.model ?? null, claude_session_id: event.session_id ?? null,
        transcript_path: event.transcript_path ?? null,
      }))
      if (event.usage) {                       // absent usage stays NULL, never 0
        const key = `${event.role}\u0000${event.session_id}`
        const total = addTotals(usageTotals.get(key), event.usage)
        usageTotals.set(key, total)
        emitter.emit((handle) => handle.endAgentSession({
          adw_id: emitter.adwId, claude_session_id: event.session_id ?? null,
          context_tokens: null, context_window: null,
          raw_read_tokens: null, raw_written_tokens: null, ...total,
        }))
      }
    }
  }
}

export function waitForEnvelope({ returnPath, timeoutS, role, readEnvelope, probeSeat, now, sleep }) {
  const started = now()
  const deadline = started + timeoutS * 1000
  let lastProbeAt = started
  let misses = 0
  while (now() < deadline) {
    const env = readEnvelope()
    if (env != null) return env

    const current = now()
    if (probeSeat && current - lastProbeAt >= LIVENESS_PROBE_MS) {
      lastProbeAt = current
      const alive = probeSeat()
      if (alive === true) misses = 0
      else if (alive === false) misses += 1
      if (misses >= LIVENESS_MISSES_TO_DIE) {
        const arrived = readEnvelope()
        if (arrived != null) return arrived
        const err = new Error(`seat died: ${role} — its pane is gone (${LIVENESS_MISSES_TO_DIE} consecutive liveness probes) and no envelope arrived at ${returnPath}`)
        err.stage = 'seat-died'
        err.role = role
        throw err
      }
    }
    sleep(WAIT_POLL_MS)
  }
  return null
}

export function paneAlive(surfaceId, deps = {}) {          // true | false | null (indeterminate)
  const tree = deps.tree || defaultTree
  const locate = deps.locate || defaultLocate
  try { const t = tree(); return Array.isArray(t?.windows) ? !!locate(t, surfaceId) : null }
  catch { return null }
}

// #240: FORCE_COLOR is commonly set in the environment a crew is launched
// from, and Node's test runner honours it even into a pipe — so a gate that
// parses `node --test`'s summary reads "\x1b[34mℹ pass 965\x1b[39m" and calls a
// green suite red (2026-08-16, a whole build round lost). Neutralise colour
// once, where the driver spawns, so every gate ever authored is covered and no
// gate bytes change. The child env is EXTENDED, not sanitised: PATH, HOME and
// every credential a lane needs survive. A command that genuinely wants colour
// can still ask — it is a /bin/sh string, so `FORCE_COLOR=3 cmd` re-enables it
// for that command alone.
export function colorNeutralEnv(base = process.env) {
  const env = { ...base }
  delete env.FORCE_COLOR
  delete env.CLICOLOR_FORCE
  env.NO_COLOR = '1'
  return env
}

export function realIo(crew, paths, checkout, emitter, adapters, args = {}, deps = {}) {
  const sendLine = deps.sendLine || defaultSendLine
  const assignmentLine = deps.assignmentLine || defaultAssignmentLine
  const tree = deps.tree || defaultTree
  const locate = deps.locate || defaultLocate
  const cmux = deps.cmux || defaultCmux
  const closeSurface = deps.closeSurface || defaultCloseSurface
  const logLine = deps.logLine || defaultLogLine
  const existsSync = deps.existsSync || fsExistsSync
  const readFileSync = deps.readFileSync || fsReadFileSync
  const writeFileSync = deps.writeFileSync || fsWriteFileSync
  const unlinkSync = deps.unlinkSync || fsUnlinkSync
  const renameSync = deps.renameSync || fsRenameSync
  const execSync = deps.execSync || cpExecSync
  const execFileSync = deps.execFileSync || cpExecFileSync
  const spawnSync = deps.spawnSync || cpSpawnSync
  const now = deps.now || (() => Date.now())
  const readRoster = deps.readRoster || (() => JSON.parse(readFileSync(join(HERE, 'roster.json'), 'utf8')))
  const sleep = deps.sleep || ((ms) => {
    const sab = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(sab), 0, 0, ms)
  })
  const resolveBin = deps.resolveWorkerBin || resolveWorkerBin
  let seq = 0
  const seatFor = new Map()
  const transportForPath = new Map()
  const transportFactories = {
    [HEADLESS_TRANSPORT]: deps.headlessIo || defaultHeadlessIo,
    [HEADLESS_RPC_TRANSPORT]: deps.headlessRpcIo || defaultHeadlessRpcIo,
  }
  const transportInstances = new Map()
  const transportArgs = {
    crew, paths, taskDir: paths.taskDir, checkout, adapters, bin: null,
    deps: {
      log: (obj) => logLine(join(paths.dir, 'journal.jsonl'), obj),
      emit: (event) => { try { io.emit?.(event) } catch { /* never load-bearing */ } },
    },
  }
  function transportIo(name, role) {
    if (!transportFactories[name]) throw new Error(`unknown transport "${name}" for seat ${role}`)
    if (!transportInstances.has(name)) {
      // Claude's frozen worker binary is for headless-json only; RPC is
      // explicitly pi --mode rpc and must never inherit crew.claude_bin.
      const factoryArgs = {
        ...transportArgs,
        bin: name === HEADLESS_RPC_TRANSPORT ? 'pi' : (crew.claude_bin || resolveBin(args)),
      }
      transportInstances.set(name, transportFactories[name](factoryArgs))
    }
    return transportInstances.get(name)
  }
  const noteCellFailure = (role, id, failure, err) => {
    try {
      io.emit?.({
        kind: 'cell-failure', role, id: id ?? null, failure,
        stage: (err && err.stage) || null, detail: (err && err.message) || null,
      })
    } catch { /* never load-bearing */ }
  }
  const io = {
    assign(spec) {
      // Destructure EVERY field the pane path uses: `briefFile` is not in
      // realIo's scope (it is runCmd's local), so leaving it out of this
      // pattern makes it a free identifier and every pane assignment dies
      // with a bare ReferenceError before a single line is sent.
      const { role, briefFile } = spec
      let id = null
      try {
        const m = crew.members[role]
        if (!m) throw new Error(`role ${role} not seated in this crew`)
        if (m.transport !== DEFAULT_TRANSPORT) {
          const transport = transportIo(m.transport, role)
          const result = transport.assign(spec)
          id = result?.id ?? null
          transportForPath.set(result.returnPath, transport)
          seatFor.set(result.returnPath, { role, id })
          return result
        }
        seq += 1
        id = `d${seq}`
        const returnPath = join(paths.returnsDir, `${id}.${role}.json`)
        // Anti-replay: seq restarts every process, so a crashed/escalated run
        // leaves files a re-run's wait() would instantly (and wrongly) accept.
        if (existsSync(returnPath)) unlinkSync(returnPath)
        seatFor.set(returnPath, { role, surface_id: m.surface_id, id })
        sendLine(m.surface_id, assignmentLine({ id, role, briefFile, returnPath, taskDir: paths.taskDir }))
        return { id, returnPath }
      } catch (err) {
        noteCellFailure(role, id, cellFailureKind(err), err)
        throw err
      }
    },
    wait(returnPath, timeoutS) {
      const transport = transportForPath.get(returnPath)
      const info = seatFor.get(returnPath)
      try {
        const env = transport
          ? transport.wait(returnPath, timeoutS)
          : waitForEnvelope({
            returnPath, timeoutS, role: info?.role || 'unknown',
            readEnvelope: () => {
              if (!existsSync(returnPath)) return null
              try { return JSON.parse(readFileSync(returnPath, 'utf8')) } catch { return null }
            },
            probeSeat: info ? () => paneAlive(info.surface_id, { tree, locate }) : null,
            now, sleep,
          })
        if (env == null) {
          noteCellFailure(info?.role, info?.id, 'timeout', { message: `no envelope at ${returnPath} within ${timeoutS}s` })
        }
        return env
      } catch (err) {
        if (err.stage === 'seat-died') io.log({ at: now(), seat_died: info?.role || 'unknown', returnPath })
        noteCellFailure(info?.role, info?.id, cellFailureKind(err), err)
        throw err
      }
    },
    writeFile(path, content) { writeFileSync(path, content) },
    readFile(path) { return existsSync(path) ? readFileSync(path, 'utf8') : null },
    run(cmd) {
      const res = spawnSync('/bin/sh', ['-c', cmd], { cwd: checkout, encoding: 'utf8', timeout: 900_000, env: colorNeutralEnv(deps.env || process.env) })
      // A timeout kill or a spawn failure must be legible in the output a
      // bounce brief pastes verbatim — never an empty "Failures:" block.
      let output = `${res.stdout || ''}${res.stderr || ''}`
      if (res.error) output += `\n[spawn error: ${res.error.message}]`
      if (res.signal) output += `\n[killed by ${res.signal}${res.signal === 'SIGTERM' ? ' — likely the 900s run timeout' : ''}]`
      return { ok: res.status === 0, output }
    },
    // Prove a command red on the PRE-BUILD tree: set the working changes
    // aside, run, restore. The pop lives in a finally so a throwing command
    // can never leave the builder's work stashed, and a failed round-trip
    // throws loudly rather than silently reporting a result from the wrong
    // tree (runCmd turns the throw into an escalation envelope).
    runClean(cmd) {
      const dirty = execSync('git status --porcelain -uall', { cwd: checkout, encoding: 'utf8' }).trim()
      if (!dirty) return this.run(cmd) // nothing to set aside — the tree IS pristine
      const push = spawnSync('git', ['stash', 'push', '--include-untracked', '-m', 'crew:runClean'], { cwd: checkout, encoding: 'utf8' })
      if (push.status !== 0) throw new Error(`runClean: git stash push failed, refusing to judge a gate against the wrong tree:\n${push.stderr || push.stdout || ''}`)
      try {
        return this.run(cmd)
      } finally {
        const pop = spawnSync('git', ['stash', 'pop'], { cwd: checkout, encoding: 'utf8' })
        if (pop.status !== 0) throw new Error(`runClean: git stash pop FAILED — the checkout is half-restored and the builder's work is in the stash (git stash list):\n${pop.stderr || pop.stdout || ''}`)
      }
    },
    // Only a transport this run actually instantiated can be holding a worker, so
    // an empty instance map is a MEASURED ZERO (a pane-only crew has nothing to
    // retire), never an unproven. headless-json is deliberately not covered: it
    // spawns one process per assignment which exits on its own and ships no
    // teardown operation — its absence from this record is honest, not a clean
    // bill of health.
    teardown() {
      const rows = []
      for (const transport of transportInstances.values()) {
        if (typeof transport.teardown !== 'function') continue
        try { rows.push(...transport.teardown()) }
        catch (err) { rows.push({ role: null, outcome: 'unproven', reason: 'teardown-threw', why: String(err?.message ?? err) }) }
      }
      return rows
    },
    reseat(role, options = {}) {
      let from = null
      try {
        const { reason } = options || {}
        const roleName = String(role)
        const m = crew.members?.[role]
        if (!m) return { applied: false, reason: 'transport', why: `role ${roleName} is not seated in this crew`, from: null, to: null }
        const live = crew.seats?.[role] || m
        const snapshot = (cell) => ({
          provider: cell?.provider ?? null,
          id: cell?.id ?? null,
          effort: cell?.effort ?? null,
          agent: cell?.agent ?? null,
          model: cell?.model ?? null,
        })
        from = snapshot(live)
        const floorTier = typeof options.tier === 'string' && options.tier ? options.tier : null
        let floorTarget = null
        let roster
        if (floorTier) {
          try {
            roster = readRoster()
          } catch (err) {
            const message = err?.message ?? String(err)
            return { applied: false, reason: 'transport', why: `could not read the runtime roster: ${message}`, from, to: null }
          }
          floorTarget = roster?.tiers?.[floorTier]?.[role]
          if (!floorTarget || typeof floorTarget !== 'object' || Array.isArray(floorTarget)) {
            return { applied: false, reason: 'exhausted', why: `tier ${floorTier} seats no ${roleName}`, from, to: null }
          }
          const sameFloorCell = live.provider === floorTarget.provider
            && live.id === floorTarget.id
            && live.effort === floorTarget.effort
            && (live.agent == null || floorTarget.agent == null || live.agent === floorTarget.agent)
          if (sameFloorCell) {
            return {
              applied: true,
              already: true,
              from,
              to: { ...floorTarget, model: live.model ?? null },
              rung: `${crew.tier ?? 'unseated'}→${floorTier}`,
            }
          }
        }
        if (m.transport !== HEADLESS_TRANSPORT && m.transport !== HEADLESS_RPC_TRANSPORT) {
          const why = m.transport === DEFAULT_TRANSPORT
            ? 'a pane seat bakes model and effort into its launch command at boot (crew/crew.mjs:265); its reassign: true capability means give a settled seat NEW WORK, never change its cell'
            : `transport ${String(m.transport)} cannot change a seat cell in-session`
          return { applied: false, reason: 'transport', why, from, to: null }
        }
        if (!crew.tier && !floorTier) return { applied: false, reason: 'no-tier', why: 'booted with --roles rather than --tier, so there is no ladder', from, to: null }

        if (!roster) {
          try {
            roster = readRoster()
          } catch (err) {
            const message = err?.message ?? String(err)
            return { applied: false, reason: 'transport', why: `could not read the runtime roster: ${message}`, from, to: null }
          }
        }
        const currentCell = roster?.tiers?.[crew.tier]?.[role] || roster?.[crew.tier]?.[role]
        const currentCellOrLive = currentCell || live
        const modelFallbackWhy = 'model catalog has no costlier same-provider, non-override-only candidate'
        let rung = floorTier
          ? { rung: `${crew.tier ?? 'unseated'}→${floorTier}`, cell: floorTarget }
          : nextRung(roster, crew.tier, role)
        if (!floorTier && !rung) {
          const index = RESEAT_LADDER.indexOf(crew.tier)
          const why = index < 0
            ? `tier ${String(crew.tier)} is unknown; the ladder is mechanical → build → judge`
            : index === RESEAT_LADDER.length - 1
              ? `tier ${String(crew.tier)} is already at the top of the mechanical → build → judge ladder`
              : `the next tier ${RESEAT_LADDER[index + 1]} seats no ${roleName}`
          // An unknown tier is not a usable ladder position, so retain its
          // existing exhausted result rather than treating the live cell as a
          // model-only upgrade opportunity.
          if (index < 0) return { applied: false, reason: 'exhausted', why, from, to: null }
          rung = nextModelRung(roster, currentCellOrLive)
          if (!rung) return { applied: false, reason: 'exhausted', why: `${why}; ${modelFallbackWhy}`, from, to: null }
        }
        const sameCell = !floorTier && currentCell
          && currentCell.provider === rung.cell.provider
          && currentCell.id === rung.cell.id
          && currentCell.effort === rung.cell.effort
        if (sameCell) {
          rung = nextModelRung(roster, currentCellOrLive)
          if (!rung) {
            return {
              applied: false,
              reason: 'exhausted',
              why: `the next rung repeats the identical cell ${currentCell.id} with effort ${currentCell.effort}; ${modelFallbackWhy}`,
              from,
              to: null,
            }
          }
        }
        if (rung.cell.agent !== m.agent) {
          return {
            applied: false,
            reason: 'agent-change',
            why: `the next rung changes agent from ${m.agent} to ${rung.cell.agent}; the adapter is fixed at boot (crew/crew.mjs:389), so it cannot run in-session`,
            from,
            to: null,
          }
        }
        // #239: the run path passes no adapters (crew/crew.mjs:673), so the
        // old `: rung.cell.id` fallback fired in production and persisted an
        // un-namespaced pi id. Resolve the seat's own shipped adapter here, and
        // refuse when nothing can vouch: reseat is optional and never
        // load-bearing (ADR-024/026 clause 1), so no reseat beats a model
        // string no adapter translated. `reason` stays 'transport' because
        // crew/drive.mjs:42 MODIFIER_OUTCOMES is a closed set and the driver is
        // not in scope; the specificity lives in `why`.
        const translate = modelStringFor(adapters, role, rung.cell.agent ?? m.agent)
        if (!translate) {
          return {
            applied: false,
            reason: 'transport',
            why: `no adapter can translate the ${rung.rung} cell for ${roleName}: agent "${String(rung.cell.agent ?? m.agent)}" has no modelString here, and reseating to an untranslated id is the guessed passthrough adapter-pi refuses (#147/#239)`,
            from,
            to: null,
          }
        }
        let model
        try {
          model = translate({ provider: rung.cell.provider, id: rung.cell.id })
        } catch (err) {
          return {
            applied: false,
            reason: 'transport',
            why: `the ${String(rung.cell.agent ?? m.agent)} adapter refused to translate the ${rung.rung} cell for ${roleName}: ${err?.message ?? err}`,
            from,
            to: null,
          }
        }
        if (typeof model !== 'string' || model.trim() === '') {
          return {
            applied: false,
            reason: 'transport',
            why: `the ${String(rung.cell.agent ?? m.agent)} adapter returned no model string for the ${rung.rung} cell of ${roleName}`,
            from,
            to: null,
          }
        }
        const to = { ...rung.cell, model }
        if (m.transport === HEADLESS_RPC_TRANSPORT) {
          const refuse = (why) => ({ applied: false, reason: 'transport', why: String(why || `headless-rpc seat ${roleName} could not be retired`), from, to: null })
          try {
            const transport = transportIo(HEADLESS_RPC_TRANSPORT, role)
            if (typeof transport?.retire !== 'function') return refuse(`headless-rpc seat ${roleName} has no retire operation`)
            const retired = transport.retire(role)
            if (retired?.retired !== true && retired?.reason !== 'not-running') return refuse(retired?.why || `headless-rpc seat ${roleName} could not be retired (${retired?.reason || 'unknown reason'})`)
          } catch (err) {
            return refuse(err?.why || err?.message || String(err))
          }
        }
        for (const target of [m, crew.seats?.[role]]) {
          if (!target) continue
          target.model = model
          target.effort = rung.cell.effort
          target.provider = rung.cell.provider
          target.id = rung.cell.id
        }
        try { saveCrew(paths, crew, { writeFileSync, renameSync }) } catch { /* persistence is best-effort */ }
        const record = { role, from, to, rung: rung.rung, reason }
        if (m.transport === HEADLESS_RPC_TRANSPORT) record.retired = true
        try { io.log({ at: now(), reseat: record }) } catch { /* journal is diagnostics */ }
        return { applied: true, from, to, rung: rung.rung }
      } catch (err) {
        return { applied: false, reason: 'transport', why: `io.reseat failed: ${err?.message ?? err}`, from, to: null }
      }
    },
    changedFiles() {
      // -z: NUL-delimited, no quoting of paths with spaces; -uall: untracked
      // files individually, never a collapsed '?? dir/'. Rename/copy entries
      // ('R'/'C' in X) carry the ORIGINAL path as the following NUL record —
      // both sides are real changes the scope gate must see.
      const out = execSync('git status --porcelain -uall -z', { cwd: checkout, encoding: 'utf8' })
      const parts = out.split('\0')
      const files = []
      for (let i = 0; i < parts.length; i += 1) {
        const entry = parts[i]
        if (!entry) continue
        files.push(entry.slice(3))
        if (entry[0] === 'R' || entry[0] === 'C') { i += 1; if (parts[i]) files.push(parts[i]) }
      }
      return files
    },
    commit(files, message) {
      // argv-form git (no shell string: planner-supplied paths are data, not
      // syntax), staging only what actually changed within scope — a planned-
      // but-never-created path must not crash the run after a green suite.
      const changed = this.changedFiles()
      const present = files.filter((f) => changed.includes(f))
      if (present.length === 0) throw new Error('commit: nothing in scope actually changed — refusing an empty commit')
      execFileSync('git', ['add', '--', ...present], { cwd: checkout })
      execFileSync('git', ['commit', '-q', '-F', '-'], { cwd: checkout, input: message })
      return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim()
    },
    status(label) {
      if (!crew.workspace_id) return // A workspace-less (all-headless) crew has no pill to set.
      // Workspace pill: glanceable "which code stage is running" for the
      // humans watching. Best-effort — a pill failure never touches the loop.
      cmux('set-status', ['crew-stage', label, '--workspace', crew.workspace_id])
    },
    // Mount the plan of record in cmux's live-watching markdown viewer, ONCE.
    // The viewer follows the file, and the plan path is stable for the whole
    // task, so a revision needs no remount — this is a no-op after the first
    // call. Idempotency is persisted on crew.doc_viewer so a re-run against a
    // still-standing (escalated) workspace does not mount a second pane.
    // Best-effort like status(): a mount failure warns and returns.
    showDoc(path) {
      try {
        if (!crew.workspace_id) return // A workspace-less (all-headless) crew has no plan viewer to mount.
        if (crew.doc_viewer?.path === path) return
        if (crew.doc_viewer?.surface_id) closeSurface(crew.doc_viewer.surface_id)
        const before = tree()
        const res = cmux('markdown', docOpenArgs({ path, workspaceId: crew.workspace_id, windowId: crew.window_id }))
        if (!res.ok) throw new Error(res.error.message)
        // markdown open prints no id — recover it by tree diff. An ambiguous
        // diff still records the mount (surface_id null) so the singleton
        // guard holds; only the teardown close is lost.
        const surfaceId = newSurfaceIds(before, tree())
        crew.doc_viewer = { path, surface_id: surfaceId.length === 1 ? surfaceId[0] : null }
        saveCrew(paths, crew, { writeFileSync, renameSync })
        logLine(join(paths.dir, 'journal.jsonl'), { at: new Date(now()).toISOString(), event: 'doc-viewer', path, surface_id: crew.doc_viewer.surface_id })
      } catch (err) {
        process.stderr.write(`warning: plan viewer mount failed (${err.message}) — continuing\n`)
      }
    },
    log(obj) { logLine(join(paths.dir, 'journal.jsonl'), obj) },
    now() { return now() },
  }
  if (emitter) io.emit = emitAdapter(emitter, crew)
  return io
}
