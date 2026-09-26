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
      env: { DEVTEAM_WORKER: '1', CREW_ROLE: role, CREW_TASK_DIR: seatTaskDir,
        ...(deps.permissionLead ? { CREW_ACP_PERMISSION_TIMEOUT_MS: String(deps.permissionTimeoutMs) } : {}) } })
    // #797: the launch policy settles what it can; an unsettled request goes to the injected lead, and with
    // no lead it is reject_once. Fail closed: nothing here approves a request the policy did not name.
    let permissionToolCall = null
    const decidePermission = permissionHandler({ policy: launch.policy, lead: role !== 'lead' && deps.permissionLead ? (payload) => deps.permissionLead({ ...payload, role }) : null,
      log: (row) => { const toolCall = permissionToolCall; log({ at: now(), acp_permission_policy: { role, tool_call_id: toolCall?.toolCallId ?? null, ...row } }) } })
    const onPermission = (request) => { permissionToolCall = request?.toolCall ?? null; try { return decidePermission(request) } finally { permissionToolCall = null } }
    const clientFactory = deps.clientFactory || defaultClient
    const onUpdate = (update) => {
      const a = assignments.get(current.get(role))
      if (!a) return
      a.sawUpdate = true
      const frame = update.update ?? update
      if (frame?.sessionUpdate === 'tool_call' || frame?.sessionUpdate === 'tool_call_update') {
        const data = frame.toolCall ?? frame
        const id = data.toolCallId ?? null
        const previous = a.tools.get(id) ?? {}
        const locations = Array.isArray(data.locations) ? data.locations.map((item) => item?.path).filter((path) => typeof path === 'string') : previous.locations ?? []
        const has_diff = Boolean(previous.has_diff || data.content?.some?.((item) => item?.type === 'diff'))
        const snapshot = { ...(data.kind == null ? { kind: previous.kind } : { kind: data.kind }), status: data.status ?? previous.status ?? null, title: data.title ?? previous.title ?? null, locations, has_diff }
        a.tools.set(id, snapshot)
        log({ at: now(), acp_tool_call: { role, assignment_id: a.id, tool_call_id: id, ...snapshot } })
      }
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
    const priorPath = current.get(role)
    const prior = priorPath ? assignments.get(priorPath) : null
    if (prior) settle(prior, { closing: true })
    const { client, profile } = getClient(role)
    if (spec.reask) {
      if (profile.session_resume) client.resumeSession(client.sessionId)
    }
    const promptId = client.beginPrompt([{ type: 'text', text }])
    assignments.set(returnPath, { id, role, returnPath, promptId, sawUpdate: false, lastTurn: null, profile, tools: new Map(), settled: false })
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
  function settle(assignment, { closing = false, strict = false } = {}) {
    if (assignment.settled) return assignment.lastTurn
    const client = clients.get(assignment.role)?.client
    let turn = null
    try { turn = client?.pollPrompt(assignment.promptId) ?? null } catch (error) { if (!closing && strict) throw error; turn = null }
    if (!turn && !closing) return null
    assignment.settled = true
    assignment.lastTurn = turn
    const refusal = Boolean(turn?.refusal)
    const usageObject = turn && turn.usage && typeof turn.usage === 'object' && !Array.isArray(turn.usage) ? turn.usage : null
    const usageReason = !turn || refusal || !usageObject ? 'usage-unavailable' : null
    let billed = null
    if (usageObject) {
      const raw = usageObject
      const classes = ['inputTokens', 'outputTokens', 'cachedReadTokens', 'cachedWriteTokens']
      const complete = classes.every((name) => Number.isSafeInteger(raw[name]) && raw[name] >= 0)
      if (complete) billed = { billed_input_tokens: raw.inputTokens, billed_output_tokens: raw.outputTokens, billed_cache_read_tokens: raw.cachedReadTokens, billed_cache_write_tokens: raw.cachedWriteTokens }
    }
    const finalUsageReason = usageReason ?? (usageObject && !billed ? 'usage-incomplete' : null)
    if (billed) emit({ kind: 'usage', id: assignment.id, role: assignment.role, model: crew.members[assignment.role]?.model ?? null, session_id: client?.sessionId ?? null, transcript_path: join(taskDir || paths.taskDir, 'acp', assignment.role, 'stream.jsonl'), usage: billed })
    log({ at: now(), acp_turn: { role: assignment.role, assignment_id: assignment.id, returnPath: assignment.returnPath, stopReason: refusal || !turn ? null : turn.stopReason ?? null, stop_reason_absent: refusal ? 'refused' : !turn ? 'response-unread' : null, usage: billed, usage_reason: finalUsageReason } })
    return turn
  }
  function wait(returnPath, timeoutS) {
    const assignment = assignments.get(returnPath)
    if (!assignment) throw new Error(`acp assignment not found at ${returnPath}`)
    let lastTurn = assignment.lastTurn
    const deadline = now() + Math.max(0, Number(timeoutS) || 0) * 1000
    // lean: synchronous one-seat wait; move to an async pump if multi-seat throughput matters
    for (;;) {
      const envelope = readEnvelope(returnPath, assignment.id)
      if (envelope) { settle(assignment); return envelope }
      try { lastTurn = assignment.lastTurn = settle(assignment, { strict: true }) }
      catch (cause) { throw noEnvelope(cause, returnPath, assignment) }
      if (lastTurn?.refusal) throw noEnvelope(lastTurn.refusal, returnPath, assignment)
      if (now() >= deadline) throw noEnvelope(null, returnPath, assignment)
      sleep(25)
    }
  }
  function closeRole(role) {
    const state = clients.get(role)
    if (!state) return { role, transport: 'acp', outcome: 'unproven', reason: 'client-not-created' }
    const activePath = current.get(role)
    const assignment = activePath ? assignments.get(activePath) : null
    if (assignment) settle(assignment, { closing: true })
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
