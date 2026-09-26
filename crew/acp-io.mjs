import { existsSync as fsExistsSync, readFileSync as fsReadFileSync, unlinkSync as fsUnlinkSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { ACP_UPDATE_KINDS, acpClient as defaultClient } from './acp-client.mjs'
import { assignmentDelivery, assignmentPrompt } from './driver.mjs'
import { readEnvelopeOrThrow } from './headless.mjs'
import { acpLaunch as piAcpLaunch, capabilitiesFor as piCapabilitiesFor } from './adapters/adapter-pi.mjs'
import { permissionHandler } from './acp-permission.mjs'

export function acpIo({ crew, paths, taskDir, checkout, adapters = {}, bin = 'pi', deps = {} }) {
  const exists = deps.existsSync || fsExistsSync
  const read = deps.readFileSync || fsReadFileSync
  const unlink = deps.unlinkSync || fsUnlinkSync
  const now = deps.now || (() => Date.now())
  const sleep = deps.sleep || ((ms) => { const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0, ms) })
  const log = deps.log || (() => {})
  const emit = deps.emit || (() => {})
  const clients = new Map()
  const assignments = new Map()
  const current = new Map()
  const parseLogged = new Set()
  let seq = 0
  function getClient(role) {
    if (clients.has(role)) return clients.get(role)
    const member = crew?.members?.[role]
    const adapter = adapters?.[role] || {}
    const profile = (adapter.capabilitiesFor || piCapabilitiesFor)({ transport: 'acp' })
    const searchedPath = deps.env?.PATH ?? process.env.PATH ?? ''
    const canRead = (path) => { try { return exists(path) === true } catch { return false } }
    let binary = null
    if (isAbsolute(bin)) {
      // crew/pi/acp-bridge.mjs refuses a nonexistent absolute CREW_PI_BIN by name at launch; do not re-check it here.
      binary = bin
    } else {
      for (const dir of searchedPath.split(delimiter)) {
        if (!isAbsolute(dir)) continue
        const candidate = join(dir, bin)
        if (canRead(candidate)) { binary = candidate; break }
      }
    }
    if (!binary) {
      const error = new Error(`acp binary "${bin}" was not found on PATH "${searchedPath}"`)
      error.stage = 'acp-bin-unresolved'
      throw error
    }
    const launchFn = adapter.acpLaunch || piAcpLaunch
    const seatTaskDir = taskDir || paths.taskDir
    // The same seat parts headless-rpc hands its command (crew/headless-rpc.mjs): the role charter, the
    // grants (the submit extension delivers the envelope without a gated write), and the seat's env.
    const launch = launchFn({ role, bin: binary, model: member?.model, effort: member?.effort, cwd: checkout || process.cwd(), deny: member?.deny || '',
      promptFile: join(seatTaskDir, `role-${role}.md`), grants: adapter.grants, configDir: adapter.configDir,
      advisorCell: adapter.grants?.advisor === true && crew.advisor?.granted?.includes(role)
        ? { endpoint: crew.advisor.endpoint, model: crew.advisor.model, models: crew.advisor.model_only ? crew.advisor.models : undefined }
        : null,
      env: { DEVTEAM_WORKER: '1', CREW_ROLE: role, CREW_TASK_DIR: seatTaskDir } })
    // #797: the launch policy settles what it can; an unsettled request goes to the injected lead, and with
    // no lead it is reject_once. Fail closed: nothing here approves a request the policy did not name.
    const onPermission = permissionHandler({ policy: launch.policy, lead: deps.permissionLead ?? null,
      log: (row) => log({ at: now(), acp_permission_policy: { role, ...row } }) })
    const clientFactory = deps.clientFactory || defaultClient
    const onUpdate = (update) => {
      const a = assignments.get(current.get(role))
      if (!a) return
      a.sawUpdate = true
      emit({ kind: 'heartbeat', at: update.at, role })
    }
    const client = clientFactory({ launch, dir: join(seatTaskDir, 'acp'), cwd: checkout || process.cwd(), role, onPermission,
      sinks: Object.fromEntries(ACP_UPDATE_KINDS.map((kind) => [kind, onUpdate])),
      deps: { ...deps.clientDeps, log } })
    client.start()
    client.initialize()
    client.newSession({ cwd: checkout || process.cwd(), mcpServers: [] })
    const state = { client, profile, role }
    clients.set(role, state)
    return state
  }
  function assign(spec) {
    const { role, briefFile } = spec
    if (!crew?.members?.[role]) throw new Error(`role ${role} not seated in this crew`)
    const id = spec.reask?.id || spec.id || `d${++seq}`
    const returnPath = spec.reask?.returnPath || spec.returnPath || join(paths.returnsDir, `${id}.${role}.json`)
    try { unlink(returnPath) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    const delivery = assignmentDelivery({ briefFile, readFileSync: read })
    const text = assignmentPrompt({ id, role, briefFile, returnPath, taskDir: taskDir || paths.taskDir, ...delivery })
    const { client, profile } = getClient(role)
    if (spec.reask) {
      if (profile.session_resume) client.resumeSession(client.sessionId)
    }
    const promptId = client.beginPrompt([{ type: 'text', text }])
    assignments.set(returnPath, { id, role, returnPath, promptId, sawUpdate: false, lastTurn: null, profile })
    current.set(role, returnPath)
    return { id, returnPath }
  }
  function readEnvelope(returnPath, id) {
    if (!exists(returnPath)) return null
    let envelope
    try { envelope = readEnvelopeOrThrow(returnPath, { readFileSync: read, existsSync: exists, stage: 'acp-parse-error', role: assignments.get(returnPath)?.role }) }
    catch (error) {
      if (!parseLogged.has(returnPath)) {
        parseLogged.add(returnPath)
        log({ at: now(), acp_parse_error: { role: assignments.get(returnPath)?.role ?? null, returnPath, why: error?.message || String(error) } })
      }
      return null
    }
    const assignment = assignments.get(returnPath)
    if (envelope.assignment_id !== assignment.id) return null
    return envelope
  }
  function noEnvelope(cause, returnPath, assignment) {
    const { role, sawUpdate } = assignment
    const error = new Error(`acp no valid envelope at ${returnPath}`)
    Object.assign(error, { stage: 'acp-no-envelope', graceSpent: sawUpdate, cause, role })
    return error
  }
  function wait(returnPath, timeoutS) {
    const assignment = assignments.get(returnPath)
    if (!assignment) throw new Error(`acp assignment not found at ${returnPath}`)
    const state = clients.get(assignment.role)
    const { client } = state
    const role = assignment.role
    let lastTurn = assignment.lastTurn
    const deadline = now() + Math.max(0, Number(timeoutS) || 0) * 1000
    let logged = false
    // lean: synchronous one-seat wait; move to an async pump if multi-seat throughput matters
    for (;;) {
      const envelope = readEnvelope(returnPath, assignment.id)
      if (envelope) return envelope
      try { lastTurn = assignment.lastTurn = client.pollPrompt(assignment.promptId) }
      catch (cause) { throw noEnvelope(cause, returnPath, assignment) }
      if (lastTurn && !logged) {
        logged = true
        log({ at: now(), acp_turn: { role, assignment_id: assignment.id, returnPath, stopReason: lastTurn.stopReason } })
      }
      if (lastTurn?.refusal) throw noEnvelope(lastTurn.refusal, returnPath, assignment)
      if (now() >= deadline) throw noEnvelope(null, returnPath, assignment)
      sleep(25)
    }
  }
  function closeRole(role) {
    const state = clients.get(role)
    if (!state) return { role, transport: 'acp', outcome: 'unproven', reason: 'client-not-created' }
    clients.delete(role)
    return { role, transport: 'acp', ...state.client.close() }
  }
  function abort(role) {
    const state = clients.get(role)
    if (state) { const { client } = state; client.cancel() }
    return closeRole(role)
  }
  function steer() { const error = new Error('ACP does not support in-turn interjection'); error.stage = 'acp-steer-unsupported'; throw error }
  function entries() { return { available: false, reason: 'acp-stream-cursor-unavailable', entries: null } }
  function retire(role) { return closeRole(role) }
  function close() { return [...clients.keys()].map(closeRole) }
  function teardown() { return close() }
  return { assign, wait, steer, abort, entries, retire, close, teardown }
}
