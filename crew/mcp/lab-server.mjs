import { createLabTool, LAB_PARAMS, LAB_TOOL_NAME } from '../pi/extensions/lab.ts'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'

export function createLabServer({ tool = createLabTool(), cwd = process.cwd(), write }) {
  const calls = new Map()
  let tail = Promise.resolve()
  const reply = (message) => write?.(message)
  const validId = (id) => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))
  const error = (id, code, message) => reply({ jsonrpc: '2.0', id, error: { code, message } })

  return async function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      if (message && typeof message === 'object' && validId(message.id)) error(message.id, -32600, 'Invalid Request')
      return
    }
    const hasId = Object.hasOwn(message, 'id')
    if (hasId && !validId(message.id)) return error(message.id, -32600, 'Invalid Request')
    const id = hasId ? message.id : undefined

    if (message.method === 'notifications/cancelled') {
      calls.get(message.params?.requestId)?.abort()
      return
    }
    if (message.method === 'notifications/initialized') return
    if (message.method === 'initialize') {
      if (!hasId) return
      return reply({ jsonrpc: '2.0', id, result: { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'lab', version: '1.0.0' } } })
    }
    if (message.method === 'ping') return hasId ? reply({ jsonrpc: '2.0', id, result: {} }) : undefined
    if (message.method === 'tools/list') {
      return hasId ? reply({ jsonrpc: '2.0', id, result: {
        tools: [{ name: LAB_TOOL_NAME, description: tool.description, inputSchema: LAB_PARAMS }],
      } }) : undefined
    }
    if (message.method !== 'tools/call') return hasId ? error(id, -32601, 'Method not found') : undefined
    if (!hasId || !message.params || typeof message.params !== 'object' || Array.isArray(message.params) ||
      message.params.name !== LAB_TOOL_NAME || !Object.hasOwn(message.params, 'arguments') ||
      !message.params.arguments || typeof message.params.arguments !== 'object' || Array.isArray(message.params.arguments)) {
      return hasId ? error(id, -32602, 'Invalid params') : undefined
    }

    const controller = new AbortController()
    calls.set(id, controller)
    const execute = async () => {
      try {
        const result = await tool.execute(id, message.params.arguments, controller.signal, undefined, { cwd })
        const response = {
          content: result.content,
          isError: Boolean(result.details?.refused),
        }
        reply({ jsonrpc: '2.0', id, result: response })
      } catch (err) {
        error(id, -32603, err?.message || 'Internal error')
      } finally {
        calls.delete(id)
      }
    }
    const pending = tail.then(execute, execute)
    tail = pending.then(() => undefined, () => undefined)
    await pending
  }
}

// lean: sequential lab calls; per-call scratch state if parallel throughput is needed
async function main() {
  const server = createLabServer({ write: (reply) => {
    try { process.stdout.write(`${JSON.stringify(reply)}\n`) } catch (error) { if (error.code !== 'EPIPE') process.stderr.write(`${error.message}\n`) }
  } })
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const pending = new Set()
  input.on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    const task = Promise.resolve(server(message))
    pending.add(task)
    task.finally(() => pending.delete(task))
  })
  process.stdout.on('error', (error) => { if (error.code === 'EPIPE') input.close() })
  await new Promise((resolve) => input.on('close', resolve))
  await Promise.allSettled([...pending])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1 })
}
