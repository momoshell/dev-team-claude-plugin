// E3: headless-json transport, a return file that EXISTS but is not JSON.
// The pane path (seat-io.mjs readEnvelopeFile:1327) fails FAST at the read
// boundary with stage 'pane-parse-error' -> cellFailureKind 'unusable-envelope'
// -> one bounded re-ask. Does headless-json do the same?
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headlessIo } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/headless.mjs'
import { cellFailureKind, reaskDecision } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/seat-io.mjs'

const base = mkdtempSync(join(tmpdir(), 'lensB-e3-'))
const paths = { dir: join(base, 'crewdir'), taskDir: join(base, 'task'), returnsDir: join(base, 'returns') }
for (const p of Object.values(paths)) mkdirSync(p, { recursive: true })
writeFileSync(join(paths.taskDir, 'role-builder.md'), '# builder')
writeFileSync(join(paths.taskDir, 'brief.md'), '# brief')

const crew = { checkout: base, members: { builder: { model: 'sonnet', transport: 'headless-json' } } }
let clock = 1_000_000
const events = []
const journal = []
const io = headlessIo({
  crew, paths, taskDir: paths.taskDir, checkout: base, adapters: {}, bin: '/usr/bin/false',
  deps: {
    spawn: () => ({ pid: 424242, unref() {} }),
    now: () => clock,
    sleep: (ms) => { clock += ms },
    kill: () => {},
    uuid: () => 'session-fixed',
    pid: 999,
    log: (o) => journal.push(o),
    emit: (e) => events.push(e),
  },
})

const { id, returnPath } = io.assign({ role: 'builder', briefFile: join(paths.taskDir, 'brief.md') })
console.log('assigned', id, returnPath)

// The seat DID answer. Its bytes are on disk. One literal newline inside a
// summary string -- the exact b52-heartbeat defect the pane path now catches.
const RAW = '{"assignment_id":"' + id + '","role":"builder","status":"done","summary":"line one\nline two","artifacts":[],"details":{}}'
writeFileSync(returnPath, RAW)
// the worker also exited cleanly and its stream carries a terminal result frame
const runDir = join(paths.taskDir, 'headless', id)
writeFileSync(join(runDir, 'stream.jsonl'), JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n' + JSON.stringify({ type: 'result', subtype: 'success' }) + '\n')
writeFileSync(join(runDir, 'exit'), '0')

try {
  const env = io.wait(returnPath, 600)
  console.log('RESULT: returned an envelope', JSON.stringify(env))
} catch (err) {
  console.log('RESULT: threw')
  console.log('  err.stage          =', JSON.stringify(err.stage))
  console.log('  cellFailureKind    =', JSON.stringify(cellFailureKind(err)))
  console.log('  err.message        =', err.message)
  console.log('  err.raw present    =', Object.prototype.hasOwnProperty.call(err, 'raw'))
  console.log('  reaskDecision.ask  =', JSON.stringify(reaskDecision({
    kind: cellFailureKind(err), transport: 'headless-json', surfaceId: null, alive: true, asked: false,
  })))
}
console.log('journal outcome rows:', JSON.stringify(journal.filter((r) => r.headless_outcome)))
console.log('file still on disk, unmodified:', JSON.stringify(RAW) === JSON.stringify(String(readFileSync(returnPath, "utf8"))))
