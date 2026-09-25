// An ACP v1 server that runs INSIDE a pi seat (#1534). It listens on the unix
// socket named by CREW_ACP_SOCKET, accepts ONE client, and speaks
// newline-delimited JSON-RPC 2.0 in the exact shapes crew/acp-client.mjs sends
// and reads. crew/pi/acp-bridge.mjs is the stdio binary that client launches;
// it spawns pi with this extension and pipes its stdin/stdout to the socket.
//
// Contracts come from the installed pi dist/core/extensions/types.d.ts, never
// invented: every handler is (event, ctx) and ctx is only ever the SECOND
// argument (ExtensionAPI has no ctx); a tool_call event carries toolCallId; a
// message_update carries assistantMessageEvent; ToolCallEventResult is
// { block, reason }. The client sends session/cancel as a NOTIFICATION and
// answers session/request_permission with a JSON-RPC RESPONSE to our id.
//
// Stated limitations:
// - A SECOND session/new is refused. pi offers newSession() only on
//   ExtensionCommandContext, which an event handler never receives, and a
//   session replacement invalidates this extension instance and its socket.
// - pi swallows a sendUserMessage that fails before the run starts (no model,
//   no key) into its extension error channel; no agent_settled follows, so
//   that prompt stays unanswered until the client times out or cancels, and
//   after such a cancel no further prompt is accepted (acp-client sends none
//   after a cancel either).
// - The default gated set adds powershell to the specified bash,edit,write:
//   it executes commands exactly as bash does, and an ungated executor is a
//   hole in the gate.
//
// No pi or package dependency: pi loads this through its erasable TypeScript
// loader, and the tests import it straight into node.

import net from 'node:net'
import { unlinkSync } from 'node:fs'
import { ACP_PROTOCOL_VERSION, ACP_STOP_REASONS, ACP_UPDATE_KINDS } from '../../acp-client.mjs'

export const SOCKET_ENV = 'CREW_ACP_SOCKET'
export const GATED_TOOLS_ENV = 'CREW_ACP_GATED_TOOLS'
export const PERMISSION_TIMEOUT_ENV = 'CREW_ACP_PERMISSION_TIMEOUT_MS'
export const DEFAULT_GATED_TOOLS = Object.freeze(['bash', 'edit', 'write', 'powershell'])
export const DEFAULT_PERMISSION_TIMEOUT_MS = 300000
export const MAX_PARTIAL_FRAME_BYTES = 1024 * 1024
export const PERMISSION_OPTIONS = Object.freeze([
  Object.freeze({ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }),
  Object.freeze({ optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' }),
  Object.freeze({ optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }),
  Object.freeze({ optionId: 'reject_always', name: 'Always reject', kind: 'reject_always' }),
])

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603
const SESSION_BUSY = -32000

// The closed stop-reason map. pi reports how an agent run ended through the
// agent_before_settle outcome (completed | aborted | error) and each assistant
// message's stopReason; ACP answers session/prompt with one of
// ACP_STOP_REASONS. A session/cancel answers `cancelled` directly.
//   completed, last assistant stopReason 'length' -> max_tokens
//   completed, any other stopReason               -> end_turn
//   aborted                                       -> cancelled
//   error, or an outcome pi never reported        -> NO stop reason: the prompt
//     is answered with a JSON-RPC error (data.errorKind 'pi-agent-error'),
//     because a provider failure is not a refusal and must not read as one.
export function stopReasonFor(outcome: any, lastStopReason: any = null): any {
  let mapped = null
  if (outcome === 'completed') mapped = lastStopReason === 'length' ? 'max_tokens' : 'end_turn'
  else if (outcome === 'aborted') mapped = 'cancelled'
  return mapped !== null && ACP_STOP_REASONS.includes(mapped) ? mapped : null
}

// pi's Usage (input/output/cacheRead/cacheWrite/totalTokens) summed over the
// assistant messages every agent_end of this prompt carried, in the ACP usage
// shape the client reads. No numeric field anywhere means null, never a zero.
const USAGE_FIELDS = Object.freeze([
  ['inputTokens', 'input'], ['outputTokens', 'output'], ['cachedReadTokens', 'cacheRead'],
  ['cachedWriteTokens', 'cacheWrite'], ['totalTokens', 'totalTokens'],
])
export function usageFrom(messages: any[]): any {
  const total: any = {}
  let seen = false
  for (const message of messages) {
    if (message?.role !== 'assistant' || !message.usage || typeof message.usage !== 'object') continue
    for (const [acp, native] of USAGE_FIELDS) {
      const value = message.usage[native]
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      total[acp] = (total[acp] || 0) + value
      seen = true
    }
  }
  return seen ? total : null
}

// ACP tool kinds for tool_call updates; any tool not listed is 'other'.
const TOOL_KINDS: any = Object.freeze({ bash: 'execute', powershell: 'execute', read: 'read', edit: 'edit', write: 'edit', grep: 'search', find: 'search', ls: 'search' })
export function toolKindFor(toolName: any): any { return Object.hasOwn(TOOL_KINDS, toolName) ? TOOL_KINDS[toolName] : 'other' }

export function gatedToolsFrom(value: any): Set<string> {
  const names = String(value ?? '').split(',').map((name) => name.trim()).filter(Boolean)
  // Blank or unset is the default list, never gate-nothing: fail closed.
  return new Set(names.length ? names : DEFAULT_GATED_TOOLS)
}

export function permissionTimeoutFrom(value: any): number {
  const parsed = Number(value)
  return value !== undefined && value !== '' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PERMISSION_TIMEOUT_MS
}

export default function acpServerExtension(pi: any) {
  if (!process.env.CREW_ACP_SOCKET) return
  const socketPath = process.env.CREW_ACP_SOCKET
  const gated = gatedToolsFrom(process.env[GATED_TOOLS_ENV])
  const permissionTimeoutMs = permissionTimeoutFrom(process.env[PERMISSION_TIMEOUT_ENV])

  let ctx: any = null
  let server: any = null
  let client: any = null
  let clientSeen = false
  let buffer = ''
  let sessionId: any = null
  let prompt: any = null
  // Set by session/cancel and cleared only by the cancelled run settling.
  // While set, a run that starts (the cancel landed during pi's asynchronous
  // prompt preflight, when abort has nothing to stop) is aborted on start,
  // and every tool call is blocked.
  let cancelledRun = false
  let permissionSeq = 0
  const permissions = new Map()
  const decisions = new Map()

  const remember = (handlerCtx: any) => { if (handlerCtx) ctx = handlerCtx }
  const note = (text: string) => { try { process.stderr.write(`acp-server: ${text}\n`) } catch { /* never load-bearing */ } }
  const send = (frame: any) => { if (client && !client.destroyed) client.write(`${JSON.stringify(frame)}\n`) }
  const reply = (id: any, result: any) => send({ jsonrpc: '2.0', id, result })
  const fail = (id: any, code: number, message: string, data: any = undefined) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
  const update = (sessionUpdate: string, fields: any) => {
    if (!ACP_UPDATE_KINDS.includes(sessionUpdate) || !sessionId) return
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate, ...fields } } })
  }

  // One pending session/prompt, answered exactly once.
  function finishPrompt(stopReason: any) {
    if (!prompt) return undefined
    const { id, messages, outcome, lastStopReason } = prompt
    prompt = null
    const usage = usageFrom(messages)
    const reason = stopReason ?? stopReasonFor(outcome, lastStopReason)
    if (reason === null) return fail(id, INTERNAL_ERROR, `pi agent run ended with outcome ${JSON.stringify(outcome)}`, { errorKind: 'pi-agent-error' })
    return reply(id, { stopReason: reason, ...(usage ? { usage } : {}) })
  }
  function settlePrompt() {
    if (cancelledRun) { cancelledRun = false; return }
    finishPrompt(null)
  }

  // A permission waiter resolves to { optionId } or to { failed: reason } for
  // every failure: timeout, disconnect, cancelled, error, unknown option.
  function settlePermission(id: any, answer: any) {
    const waiter = permissions.get(id)
    if (!waiter) return
    permissions.delete(id)
    clearTimeout(waiter.timer)
    waiter.resolve(answer)
  }
  function dropPermissions(why: string) { for (const id of [...permissions.keys()]) settlePermission(id, { failed: why }) }

  function handleResponse(frame: any) {
    if (!permissions.has(frame.id)) return
    const outcome = frame.result?.outcome
    if (frame.error || !outcome) return settlePermission(frame.id, { failed: 'ACP permission answer invalid' })
    if (outcome.outcome === 'cancelled') return settlePermission(frame.id, { failed: 'ACP permission cancelled' })
    const known = PERMISSION_OPTIONS.some((option) => option.optionId === outcome.optionId)
    if (outcome.outcome !== 'selected' || !known) return settlePermission(frame.id, { failed: 'ACP permission answer invalid' })
    settlePermission(frame.id, { optionId: outcome.optionId })
  }

  function cancel(params: any) {
    if (!prompt || (params?.sessionId != null && params.sessionId !== sessionId)) return
    dropPermissions('ACP permission cancelled')
    cancelledRun = true
    if (ctx) ctx.abort()
    finishPrompt('cancelled')
  }

  function handleRequest(frame: any) {
    const { id, method } = frame
    const params = frame.params && typeof frame.params === 'object' ? frame.params : {}
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentInfo: { name: 'crew-pi-acp', title: 'pi ACP server (crew)', version: '1' },
        agentCapabilities: { loadSession: false },
        authMethods: [],
      })
    }
    if (method === 'session/new') {
      if (sessionId !== null) return fail(id, METHOD_NOT_FOUND, 'session replacement unsupported: pi offers newSession only on ExtensionCommandContext')
      const current = ctx?.sessionManager?.getSessionId?.()
      if (typeof current !== 'string' || !current) return fail(id, INTERNAL_ERROR, 'the running pi session has no id yet')
      sessionId = current
      decisions.clear()
      const requested = Array.isArray(params.mcpServers) ? params.mcpServers.length : 0
      return reply(id, { sessionId, _meta: { mcpServers: { supported: false, requested } } })
    }
    if (method === 'session/prompt') {
      if (!sessionId || params.sessionId !== sessionId) return fail(id, INVALID_PARAMS, `unknown session ${JSON.stringify(params.sessionId ?? null)}`)
      if (prompt || cancelledRun) return fail(id, SESSION_BUSY, 'a prompt is already in flight on this session')
      const blocks = Array.isArray(params.prompt) ? params.prompt : []
      const text = blocks.filter((block: any) => block?.type === 'text' && typeof block.text === 'string').map((block: any) => ({ type: 'text', text: block.text }))
      if (!text.length) return fail(id, INVALID_PARAMS, 'session/prompt carried no text block')
      prompt = { id, messages: [], outcome: null, lastStopReason: null }
      pi.sendUserMessage(text)
      return undefined
    }
    if (method === 'session/cancel') { cancel(params); return reply(id, {}) }
    return fail(id, METHOD_NOT_FOUND, `acp server does not implement ${method}`)
  }

  function handleFrame(frame: any) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame) || frame.jsonrpc !== '2.0') return fail(null, INVALID_REQUEST, 'not a JSON-RPC 2.0 frame')
    const hasId = Object.hasOwn(frame, 'id')
    if (typeof frame.method === 'string' && hasId) {
      try { return handleRequest(frame) } catch (err: any) { return fail(frame.id, INTERNAL_ERROR, `acp server failed on ${frame.method}: ${err?.message || err}`) }
    }
    if (typeof frame.method === 'string') {
      if (frame.method === 'session/cancel') { try { cancel(frame.params) } catch (err: any) { note(`session/cancel failed: ${err?.message || err}`) } }
      return undefined
    }
    if (hasId && (Object.hasOwn(frame, 'result') || Object.hasOwn(frame, 'error'))) return handleResponse(frame)
    return fail(hasId ? frame.id : null, INVALID_REQUEST, 'neither a request, a notification nor a response')
  }

  function receive(chunk: any) {
    buffer += String(chunk)
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (!line.trim()) continue
      let frame
      try { frame = JSON.parse(line) } catch { fail(null, PARSE_ERROR, 'parse error'); continue }
      handleFrame(frame)
    }
    // Only the unterminated remainder counts against the cap.
    if (Buffer.byteLength(buffer, 'utf8') > MAX_PARTIAL_FRAME_BYTES) { note('partial frame over the cap; closing the client'); client?.destroy() }
  }

  function detach() {
    client = null
    buffer = ''
    prompt = null
    dropPermissions('ACP client disconnected')
  }

  function listen() {
    if (server) return
    server = net.createServer((socket: any) => {
      if (clientSeen) { socket.destroy(); return }
      clientSeen = true
      client = socket
      // A streaming decoder: a UTF-8 character split across chunks stays whole.
      socket.setEncoding('utf8')
      socket.on('data', receive)
      socket.on('error', () => {})
      socket.on('close', () => { if (client === socket) detach() })
    })
    server.on('error', (err: any) => note(`socket ${err?.code || err?.message || err}: no ACP client can connect, gated tools stay blocked`))
    server.listen(socketPath)
  }

  function shutdown() {
    const socket = client
    detach()
    try { socket?.destroy() } catch {}
    if (server) {
      try { server.close() } catch {}
      try { unlinkSync(socketPath) } catch {}
    }
    server = null
  }

  async function gate(event: any, handlerCtx: any) {
    remember(handlerCtx)
    if (cancelledRun) return { block: true, reason: 'ACP prompt cancelled' }
    if (!gated.has(event?.toolName)) return undefined
    // Availability first: a cached allow never outlives the client that gave it.
    if (!client || client.destroyed) return { block: true, reason: 'ACP client unavailable' }
    if (!sessionId) return { block: true, reason: 'ACP session not established' }
    const cached = decisions.get(event.toolName)
    if (cached === 'allow_always') return undefined
    if (cached === 'reject_always') return { block: true, reason: 'ACP permission rejected (always)' }
    permissionSeq += 1
    const id = permissionSeq
    const answer: any = await new Promise((resolve) => {
      const timer = setTimeout(() => settlePermission(id, { failed: 'ACP permission timed out' }), permissionTimeoutMs)
      timer.unref?.()
      permissions.set(id, { resolve, timer })
      send({
        jsonrpc: '2.0', id, method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId: event.toolCallId, title: event.toolName, kind: toolKindFor(event.toolName), status: 'pending', rawInput: event.input ?? null },
          options: PERMISSION_OPTIONS,
        },
      })
    })
    if (!answer?.optionId) return { block: true, reason: answer?.failed || 'ACP permission unanswered' }
    const choice = answer.optionId
    if (choice === 'allow_always' || choice === 'reject_always') decisions.set(event.toolName, choice)
    if (choice === 'allow_once' || choice === 'allow_always') return undefined
    return { block: true, reason: 'ACP permission rejected' }
  }

  pi.on('session_start', (_event: any, handlerCtx: any) => { remember(handlerCtx); listen() })
  pi.on('session_shutdown', (_event: any, handlerCtx: any) => { remember(handlerCtx); shutdown() })
  pi.on('tool_call', gate)
  pi.on('message_update', (event: any, handlerCtx: any) => {
    remember(handlerCtx)
    const step = event?.assistantMessageEvent
    if (!prompt || typeof step?.delta !== 'string') return
    if (step.type === 'text_delta') update('agent_message_chunk', { content: { type: 'text', text: step.delta } })
    else if (step.type === 'thinking_delta') update('agent_thought_chunk', { content: { type: 'text', text: step.delta } })
  })
  pi.on('tool_execution_start', (event: any, handlerCtx: any) => {
    remember(handlerCtx)
    if (!prompt) return
    update('tool_call', { toolCallId: event.toolCallId, title: event.toolName, kind: toolKindFor(event.toolName), status: 'in_progress', rawInput: event.args ?? null })
  })
  pi.on('tool_execution_end', (event: any, handlerCtx: any) => {
    remember(handlerCtx)
    if (!prompt) return
    update('tool_call_update', { toolCallId: event.toolCallId, status: event.isError ? 'failed' : 'completed' })
  })
  pi.on('agent_start', (_event: any, handlerCtx: any) => {
    remember(handlerCtx)
    if (cancelledRun && ctx) ctx.abort()
  })
  pi.on('agent_end', (event: any, handlerCtx: any) => {
    remember(handlerCtx)
    if (!prompt || !Array.isArray(event?.messages)) return
    prompt.messages.push(...event.messages)
    const last = [...event.messages].reverse().find((message: any) => message?.role === 'assistant')
    if (last) prompt.lastStopReason = last.stopReason ?? null
  })
  pi.on('agent_before_settle', (event: any, handlerCtx: any) => {
    remember(handlerCtx)
    if (prompt) prompt.outcome = event?.outcome ?? null
    return undefined
  })
  pi.on('agent_settled', (_event: any, handlerCtx: any) => { remember(handlerCtx); settlePrompt() })
}
