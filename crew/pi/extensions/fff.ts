// The builder-seat fff search bridge. Pi loads this extension directly through
// its erasable TypeScript loader, so the implementation has no package
// dependency and owns the small MCP-over-stdio transport here.

import { spawn as nodeSpawn } from 'node:child_process'

export const FFF_MCP_BIN = '/opt/homebrew/bin/fff-mcp'
export const FFF_TIMEOUT_MS = 10_000
export const FFF_ENABLED_ENV = 'CREW_FFF'

const PROTOCOL_VERSION = '2024-11-05'
const CLIENT_NAME = 'crew-fff'
const CLIENT_VERSION = '1'
const FFF_METHODS = Object.freeze({
  fff_find: 'find_files',
  fff_grep: 'grep',
  fff_multi_grep: 'multi_grep',
})

export const FFF_TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'fff_grep',
    label: 'fff grep',
    description: 'Search the checkout with fff grep.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        query: Object.freeze({ type: 'string' }),
        output_mode: Object.freeze({ type: 'string' }),
        maxResults: Object.freeze({ type: 'integer', minimum: 1 }),
        cursor: Object.freeze({ type: 'string' }),
      }),
      required: Object.freeze(['query']),
      additionalProperties: true,
    }),
  }),
  Object.freeze({
    name: 'fff_find',
    label: 'fff find',
    description: 'Find files in the checkout with fff.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        query: Object.freeze({ type: 'string' }),
        maxResults: Object.freeze({ type: 'integer', minimum: 1 }),
        cursor: Object.freeze({ type: 'string' }),
      }),
      required: Object.freeze(['query']),
      additionalProperties: true,
    }),
  }),
  Object.freeze({
    name: 'fff_multi_grep',
    label: 'fff multi grep',
    description: 'Run multiple fff grep patterns against the checkout.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        patterns: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }) }),
        constraints: Object.freeze({ type: 'object' }),
        context: Object.freeze({}),
        output_mode: Object.freeze({ type: 'string' }),
        maxResults: Object.freeze({ type: 'integer', minimum: 1 }),
        cursor: Object.freeze({ type: 'string' }),
      }),
      required: Object.freeze(['patterns']),
      additionalProperties: true,
    }),
  }),
])

// A short alias is useful to callers that only need the registration surface.
export const FFF_TOOLS = FFF_TOOL_DEFINITIONS

function asError(error, fallback) {
  if (error instanceof Error) return error
  return new Error(error == null ? fallback : String(error))
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`
}

function closeChild(child) {
  if (!child) return
  try { child.stdin?.destroy?.() } catch {}
  try { child.stdout?.destroy?.() } catch {}
  try { child.stderr?.destroy?.() } catch {}
  try { child.kill?.() } catch {}
}

function removeListener(emitter, event, listener) {
  try {
    if (typeof emitter?.off === 'function') emitter.off(event, listener)
    else emitter?.removeListener?.(event, listener)
  } catch {}
}

function responseError(message) {
  return new Error(`fff-mcp ${message}`)
}

function responseContent(message) {
  if (message?.error) {
    const detail = message.error.message || JSON.stringify(message.error)
    throw responseError(`returned an error: ${detail}`)
  }
  const result = message?.result
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw responseError('returned an empty response')
  }
  if (!Array.isArray(result.content) || result.content.length === 0) {
    throw responseError('returned an empty response')
  }
  return { content: result.content, ...(Object.hasOwn(result, 'structuredContent') ? { structuredContent: result.structuredContent } : {}) }
}

function mcpRequest(id, method, params) {
  return { jsonrpc: '2.0', id, method, params }
}

function mcpNotification(method, params) {
  return { jsonrpc: '2.0', method, params }
}

function spawnOptions(cwd) {
  return { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }
}

// Return a call function that starts one short-lived fff server per tool call.
// Keeping the child per request avoids carrying a dead or half-initialized MCP
// process into the next turn and makes all completion paths independently bounded.
export function createMcpCall(options = {}) {
  const input = options && typeof options === 'object' ? options : {}
  const spawn = input.spawn || input.spawnFn || nodeSpawn
  const timeoutMs = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : FFF_TIMEOUT_MS
  const setTimeout = input.setTimeout || globalThis.setTimeout
  const clearTimeout = input.clearTimeout || globalThis.clearTimeout
  const binary = input.binary || FFF_MCP_BIN

  return function call(toolName, argumentsObject = {}, ctx = {}, signal = null) {
    const method = FFF_METHODS[toolName]
    if (!method) return Promise.reject(responseError(`does not know tool ${JSON.stringify(toolName)}`))
    if (argumentsObject === null || typeof argumentsObject !== 'object' || Array.isArray(argumentsObject)) {
      return Promise.reject(responseError('tool arguments must be an object'))
    }
    if (signal?.aborted) return Promise.reject(responseError('request aborted'))

    return new Promise((resolve, reject) => {
      let child = null
      let settled = false
      let phase = 'initialize'
      let residual = ''
      let stdoutListener
      let closeListener
      let errorListener
      let abortListener

      const cleanup = () => {
        clearTimeout(timer)
        removeListener(child?.stdout, 'data', stdoutListener)
        removeListener(child, 'close', closeListener)
        removeListener(child, 'error', errorListener)
        if (signal && abortListener) removeListener(signal, 'abort', abortListener)
        closeChild(child)
      }
      const settle = (error, value) => {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(asError(error, 'fff-mcp request failed'))
        else resolve(value)
      }
      const timer = setTimeout(() => settle(new Error('fff-mcp timed out')), timeoutMs)

      const send = (message) => {
        if (settled) return
        try {
          if (!child?.stdin || typeof child.stdin.write !== 'function') throw responseError('stdin is unavailable')
          child.stdin.write(jsonLine(message))
        } catch (error) {
          settle(asError(error, 'fff-mcp could not send a request'))
        }
      }
      const processLine = (line) => {
        if (settled || !line.trim()) return
        let message
        try { message = JSON.parse(line) } catch { settle(responseError('returned malformed JSON')); return }
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          settle(responseError('returned an invalid response')); return
        }
        if (phase === 'initialize') {
          if (message.id !== 1) return
          if (message.error) { settle(responseError(`initialization failed: ${message.error.message || JSON.stringify(message.error)}`)); return }
          phase = 'call'
          send(mcpNotification('notifications/initialized', {}))
          send(mcpRequest(2, 'tools/call', { name: method, arguments: argumentsObject }))
          return
        }
        if (message.id !== 2) return
        try { settle(null, responseContent(message)) } catch (error) { settle(error) }
      }
      stdoutListener = (chunk) => {
        try {
          residual += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '')
          let newline
          while ((newline = residual.indexOf('\n')) >= 0) {
            const line = residual.slice(0, newline).replace(/\r$/, '')
            residual = residual.slice(newline + 1)
            processLine(line)
            if (settled) return
          }
        } catch (error) { settle(error) }
      }
      closeListener = () => {
        if (settled) return
        if (residual.trim()) processLine(residual)
        if (!settled) settle(responseError('closed before returning a complete response'))
      }
      errorListener = (error) => settle(asError(error, 'child process failed'))
      abortListener = () => settle(responseError('request aborted'))

      try {
        child = spawn(binary, [], spawnOptions(ctx?.cwd))
        if (!child || !child.stdout || !child.stdin || typeof child.stdout.on !== 'function' || typeof child.on !== 'function') {
          settle(responseError('spawn returned an unusable child'))
          return
        }
        child.stdout.on('data', stdoutListener)
        child.on('close', closeListener)
        child.on('error', errorListener)
        if (signal) signal.addEventListener?.('abort', abortListener, { once: true })
        send(mcpRequest(1, 'initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
        }))
      } catch (error) {
        settle(asError(error, 'fff-mcp could not be spawned'))
      }
    })
  }
}

export const createFffCall = createMcpCall

function resultFor(response) {
  if (response && typeof response === 'object' && Array.isArray(response.content)) return response
  if (Array.isArray(response)) return { content: response }
  throw responseError('returned an empty tool result')
}

export function createFffTool(definition, call = createMcpCall()) {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, request, signal, _onUpdate, ctx) {
      const response = await call(definition.name, request || {}, ctx, signal)
      return resultFor(response)
    },
  }
}

export function attachFff(pi, options = {}) {
  if (typeof pi?.registerTool !== 'function') throw new Error('fff extension needs pi.registerTool')
  try { if (typeof process !== 'undefined' && process.env) process.env[FFF_ENABLED_ENV] = '1' } catch {}
  const input = options && typeof options === 'object' ? options : {}
  const call = input.call || input.mcpCall || createMcpCall(input)
  const tools = FFF_TOOL_DEFINITIONS.map((definition) => createFffTool(definition, call))
  for (const tool of tools) pi.registerTool(tool)
  return tools
}

export default function fffExtension(pi) {
  return attachFff(pi)
}
