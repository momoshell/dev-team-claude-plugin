import { createInterface } from 'node:readline'
import { createRetrieveTool, createSkeletonTool } from '../pi/extensions/skeletonread.ts'
import { createAgentTool, toolResultPatch } from '../pi/extensions/subagent.ts'

let granted = []
try { granted = JSON.parse(process.env.CREW_EXTRAS || '[]') } catch { /* no grants */ }
if (!Array.isArray(granted)) granted = []
const tools = {
  retrieve: createRetrieveTool(),
  skeleton: createSkeletonTool(),
  // The MCP server is not pi: never let the tool resolve this script as its child.
  agent: createAgentTool({ argv: [], execPath: process.env.CREW_PI_BINARY || '/node' }),
}
const enabled = Object.fromEntries(Object.entries(tools).filter(([name]) => granted.includes(name)))
const refusal = () => ({ content: [{ type: 'text', text: 'refused: tool is not granted' }], isError: true })

async function handle(message) {
  if (message.method === 'initialize') return { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'crew-extras', version: '1' } }
  if (message.method === 'tools/list') return { tools: Object.values(enabled).map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters })) }
  if (message.method === 'tools/call') {
    const name = message.params?.name
    const tool = Object.hasOwn(enabled, name) ? enabled[name] : null
    if (!tool) return refusal()
    const result = await tool.execute(String(message.id ?? ''), message.params?.arguments, undefined, undefined, { cwd: process.cwd() })
    if (typeof result === 'string') return { content: [{ type: 'text', text: result }], ...(result.startsWith('refused:') ? { isError: true } : {}) }
    return { ...result, ...toolResultPatch({ toolName: name, details: result?.details }) }
  }
  throw new Error('method not found')
}

let pending = Promise.resolve()
createInterface({ input: process.stdin }).on('line', (line) => {
  pending = pending.then(async () => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (!Object.hasOwn(message, 'id')) return
    try { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: await handle(message) })}\n`) }
    catch { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'request failed' } })}\n`) }
  })
})
