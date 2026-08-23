// E3b: same malformed return file, but the worker has NOT exited yet.
// The reader treats an unparseable-but-present file as "nothing on disk yet"
// and polls the ENTIRE wait budget on a condition that can never resolve.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headlessIo, WAIT_POLL_MS } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/headless.mjs'
import { cellFailureKind } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/seat-io.mjs'

const base = mkdtempSync(join(tmpdir(), 'lensB-e3b-'))
const paths = { dir: join(base, 'crewdir'), taskDir: join(base, 'task'), returnsDir: join(base, 'returns') }
for (const p of Object.values(paths)) mkdirSync(p, { recursive: true })
writeFileSync(join(paths.taskDir, 'role-builder.md'), '# builder')
writeFileSync(join(paths.taskDir, 'brief.md'), '# brief')

const crew = { checkout: base, members: { builder: { model: 'sonnet', transport: 'headless-json' } } }
let clock = 0
let polls = 0
const io = headlessIo({
  crew, paths, taskDir: paths.taskDir, checkout: base, adapters: {}, bin: '/usr/bin/false',
  deps: {
    spawn: () => ({ pid: 424242, unref() {} }),
    now: () => clock,
    sleep: (ms) => { polls += 1; clock += ms },
    kill: () => {},
    uuid: () => 's',
    pid: 999,
    log: () => {},
    emit: () => {},
  },
})
const { id, returnPath } = io.assign({ role: 'builder', briefFile: join(paths.taskDir, 'brief.md') })
writeFileSync(returnPath, '{"assignment_id":"' + id + '","role":"builder","status":"done","summary":"a\nb","artifacts":[],"details":{}}')
// NO exit marker: from the reader's point of view the worker is still running.
const BUDGET_S = 3600
try {
  const env = io.wait(returnPath, BUDGET_S)
  console.log('returned', JSON.stringify(env))
} catch (err) {
  console.log('budget requested (s)  =', BUDGET_S)
  console.log('virtual ms burned     =', clock, `(= ${clock / 1000}s)`)
  console.log('poll iterations       =', polls, `@ WAIT_POLL_MS=${WAIT_POLL_MS}`)
  console.log('err.stage             =', JSON.stringify(err.stage))
  console.log('cellFailureKind       =', JSON.stringify(cellFailureKind(err)))
  console.log('err.message           =', err.message)
}
