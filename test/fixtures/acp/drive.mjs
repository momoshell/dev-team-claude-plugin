// Drives one ACP scenario and writes a fixture. Usage:
//   node drive.mjs --agent claude|pi --scenario handshake|turn|cancel|permission --out <file>
import { createRecorder, createClient } from './record.mjs'
import { mkdirSync } from 'node:fs'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }

const AGENTS = {
  claude: { bin: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp@0.70.0'] },
  pi:     { bin: 'npx', args: ['-y', 'pi-acp@0.0.33'] },
}

const agentName = arg('agent', 'claude')
const scenario = arg('scenario', 'handshake')
const cwd = arg('cwd', `${process.env.TMPDIR || '/tmp'}/acp-scratch-${agentName}`)
const out = arg('out', `./fixtures/${agentName}-${scenario}.ndjson`)
const spec = AGENTS[agentName]
if (!spec) { console.error(`unknown agent: ${agentName}`); process.exit(2) }
mkdirSync(cwd, { recursive: true })

const recorder = createRecorder(out)
recorder.write('meta', { agent: agentName, scenario, package: spec.args.at(-1), cwd, node: process.version, at: new Date().toISOString() })

const updates = []
const client = createClient({
  ...spec, cwd, recorder,
  onNotify: (f) => { if (f.method === 'session/update') updates.push(f.params?.update?.sessionUpdate ?? '?') },
  // Record the permission request, then answer with the FIRST offered option.
  onRequest: (f) => {
    if (f.method !== 'session/request_permission') return {}
    const want = arg('permission-choice', 'reject')   // reject | allow | allow_always
    const opts = f.params?.options ?? []
    const byKind = { reject: 'reject_once', allow: 'allow_once', allow_always: 'allow_always' }[want]
    const pick = opts.find((o) => o.kind === byKind) ?? opts[0]
    return { outcome: { outcome: 'selected', optionId: pick?.optionId ?? 'allow' } }
  },
})

const die = async (msg, code = 1) => { console.error(msg); client.close(); await recorder.close(); process.exit(code) }

try {
  const init = await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  }, 120000)
  if (init.error) await die(`initialize failed: ${JSON.stringify(init.error)}`)
  console.log(`[${agentName}] initialize ok — protocolVersion=${init.result?.protocolVersion} authMethods=${JSON.stringify(init.result?.authMethods ?? [])}`)
  console.log(`[${agentName}] agentCapabilities=${JSON.stringify(init.result?.agentCapabilities ?? {})}`)

  if (scenario === 'handshake') { client.close(); await recorder.close(); console.log(`[${agentName}] wrote ${out}`); process.exit(0) }

  const rawSdk = argv.includes('--raw-sdk')
  const newParams = { cwd, mcpServers: [] }
  if (rawSdk) newParams._meta = { claudeCode: { emitRawSDKMessages: true } }
  const ses = await client.request('session/new', newParams, 120000)
  if (ses.error) await die(`session/new failed: ${JSON.stringify(ses.error)}`)
  const sessionId = ses.result?.sessionId
  console.log(`[${agentName}] sessionId=${sessionId}`)

  const mode = arg('mode', null)
  if (mode) {
    const m = await client.request('session/set_mode', { sessionId, modeId: mode }, 60000)
    console.log(`[${agentName}] set_mode ${mode} -> ${m.error ? JSON.stringify(m.error) : 'ok'}`)
  }

  const text = arg('prompt', 'Create a file named acp-probe.txt containing exactly the word RECORDED, then reply with the single line ENVELOPE: done.')
  const promptCall = client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 600000)

  if (scenario === 'cancel') {
    await new Promise((r) => setTimeout(r, Number(arg('cancel-after-ms', '4000'))))
    client.notify('session/cancel', { sessionId })
  }
  const res = await promptCall
  console.log(`[${agentName}] stopReason=${res.result?.stopReason ?? JSON.stringify(res.error)}`)
  console.log(`[${agentName}] update kinds: ${JSON.stringify([...new Set(updates)])}`)
} catch (err) {
  recorder.write('meta', { error: String(err?.message ?? err) }, 'DRIVER ERROR')
  console.error(`[${agentName}] ${err?.message ?? err}`)
} finally {
  client.close()
  await recorder.close()
  console.log(`[${agentName}] wrote ${out}`)
}
