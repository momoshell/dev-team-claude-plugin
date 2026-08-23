// E4: headless-rpc transport, a return file that EXISTS but is not JSON, and a
// settled turn. envelopeAt (headless-rpc.mjs:166-172) swallows the parse error
// and returns null, so wait() takes the "settled but no envelope" branch and
// FABRICATES an envelope the seat never wrote.
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headlessRpcIo } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/headless-rpc.mjs'
import { cellFailureKind } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/seat-io.mjs'

const base = mkdtempSync(join(tmpdir(), 'lensB-e4-'))
const paths = { dir: join(base, 'crewdir'), taskDir: join(base, 'task'), returnsDir: join(base, 'returns') }
for (const p of Object.values(paths)) mkdirSync(p, { recursive: true })
writeFileSync(join(paths.taskDir, 'role-builder.md'), '# builder')
writeFileSync(join(paths.taskDir, 'brief.md'), '# brief')

const crew = { checkout: base, members: { builder: { model: 'gpt', transport: 'headless-rpc' } } }
let clock = 0
const events = []
const journal = []
const sent = []
const io = headlessRpcIo({
  crew, paths, taskDir: paths.taskDir, checkout: base, adapters: {}, bin: 'pi',
  deps: {
    spawn: () => ({ pid: 515151, unref() {} }),
    openSync: () => 7,
    writeSync: (fd, s) => { sent.push(String(s).trim()) },
    closeSync: () => {},
    now: () => clock,
    sleep: (ms) => { clock += ms },
    kill: () => {},
    uuid: () => 'sess-1',
    pid: 111,
    log: (o) => journal.push(o),
    emit: (e) => events.push(e),
  },
})

const { id, returnPath } = io.assign({ role: 'builder', briefFile: join(paths.taskDir, 'brief.md') })
console.log('assigned', id, returnPath)

// The seat did real work and wrote its envelope -- with one literal newline
// inside the summary string.
const RAW = '{"assignment_id":"' + id + '","role":"builder","status":"done","summary":"shipped the fix\nall gates green","artifacts":[],"details":{"pr":"#999"}}'
writeFileSync(returnPath, RAW)

// pi's stream: the turn produced tokens and then settled.
const stream = join(paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl')
appendFileSync(stream, [
  JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: { input: 100, output: 40, cacheWrite: 0, cacheRead: 0 } } }),
  JSON.stringify({ type: 'agent_end' }),
  JSON.stringify({ type: 'agent_settled' }),
  '',
].join('\n'))

let out
try { out = { returned: io.wait(returnPath, 600) } }
catch (err) { out = { threw: { stage: err.stage, kind: cellFailureKind(err), message: err.message } } }

console.log('WAIT RESULT:', JSON.stringify(out, null, 2))
console.log('cell-failure events:', JSON.stringify(events.filter((e) => e.kind === 'cell-failure')))
console.log('journal rpc rows   :', JSON.stringify(journal.filter((r) => r.rpc_outcome)))
console.log('usage events       :', JSON.stringify(events.filter((e) => e.kind === 'usage')))
console.log('the real bytes are still on disk, untouched:', JSON.stringify(readFileSync(returnPath, 'utf8')) === JSON.stringify(RAW))
