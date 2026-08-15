import {
  existsSync as fsExistsSync, readFileSync as fsReadFileSync, writeFileSync as fsWriteFileSync,
  unlinkSync as fsUnlinkSync, renameSync as fsRenameSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execSync as cpExecSync, execFileSync as cpExecFileSync, spawnSync as cpSpawnSync } from 'node:child_process'

import {
  cmux as defaultCmux, tree as defaultTree, locate as defaultLocate, sendLine as defaultSendLine,
  closeSurface as defaultCloseSurface, logLine as defaultLogLine, assignmentLine as defaultAssignmentLine,
} from './driver.mjs'
import { headlessIo as defaultHeadlessIo } from './headless.mjs'
import { headlessRpcIo as defaultHeadlessRpcIo } from './headless-rpc.mjs'

export const DEFAULT_TRANSPORT = 'pane'
export const HEADLESS_TRANSPORT = 'headless-json'
export const HEADLESS_RPC_TRANSPORT = 'headless-rpc'
export const WAIT_POLL_MS = 5000
export const LIVENESS_PROBE_MS = 30_000
export const LIVENESS_MISSES_TO_DIE = 2

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

export function phaseForStage(label) {
  const head = String(label ?? '').split(':')[0]
  if (head === 'plan' || head === 'check') return 'planning'
  if (['build', 'scope-gate', 'lane', 'gate', 'gate-baseline', 'gate-repair', 'gate-reverify'].includes(head)) return 'build'
  if (head === 'review') return 'review'
  if (head === 'suite' || head === 'commit') return 'finish'
  if (head === 'done') return 'done'
  if (head === 'escalate') return 'escalation'
  return 'build'
}

export function emitAdapter(emitter) {
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
  const io = {
    assign(spec) {
      // Destructure EVERY field the pane path uses: `briefFile` is not in
      // realIo's scope (it is runCmd's local), so leaving it out of this
      // pattern makes it a free identifier and every pane assignment dies
      // with a bare ReferenceError before a single line is sent.
      const { role, briefFile } = spec
      const m = crew.members[role]
      if (!m) throw new Error(`role ${role} not seated in this crew`)
      if (m.transport !== DEFAULT_TRANSPORT) {
        const transport = transportIo(m.transport, role)
        const result = transport.assign(spec)
        transportForPath.set(result.returnPath, transport)
        return result
      }
      seq += 1
      const id = `d${seq}`
      const returnPath = join(paths.returnsDir, `${id}.${role}.json`)
      // Anti-replay: seq restarts every process, so a crashed/escalated run
      // leaves files a re-run's wait() would instantly (and wrongly) accept.
      if (existsSync(returnPath)) unlinkSync(returnPath)
      seatFor.set(returnPath, { role, surface_id: m.surface_id })
      sendLine(m.surface_id, assignmentLine({ id, role, briefFile, returnPath, taskDir: paths.taskDir }))
      return { id, returnPath }
    },
    wait(returnPath, timeoutS) {
      const transport = transportForPath.get(returnPath)
      if (transport) return transport.wait(returnPath, timeoutS)
      const seat = seatFor.get(returnPath)
      try {
        return waitForEnvelope({
          returnPath, timeoutS, role: seat?.role || 'unknown',
          readEnvelope: () => {
            if (!existsSync(returnPath)) return null
            try { return JSON.parse(readFileSync(returnPath, 'utf8')) } catch { return null }
          },
          probeSeat: seat ? () => paneAlive(seat.surface_id, { tree, locate }) : null,
          now, sleep,
        })
      } catch (err) {
        if (err.stage === 'seat-died') io.log({ at: now(), seat_died: seat?.role || 'unknown', returnPath })
        throw err
      }
    },
    writeFile(path, content) { writeFileSync(path, content) },
    readFile(path) { return existsSync(path) ? readFileSync(path, 'utf8') : null },
    run(cmd) {
      const res = spawnSync('/bin/sh', ['-c', cmd], { cwd: checkout, encoding: 'utf8', timeout: 900_000 })
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
  if (emitter) io.emit = emitAdapter(emitter)
  return io
}
