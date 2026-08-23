// E10: THE SAME BYTES, two transports, through the real seatIo entry point.
// seat-io-runclean.test.mjs:853-884 pins the pane answer (fail fast, kind
// 'unusable-envelope', clock <= WAIT_POLL_MS). Nothing pins the headless answer.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seatIo, WAIT_POLL_MS, cellFailureKind } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/seat-io.mjs'
import { headlessIo as realHeadlessIo } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/headless.mjs'
import { headlessRpcIo as realRpcIo } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/headless-rpc.mjs'

// One literal newline inside the summary: the b52-heartbeat defect, verbatim
// from the shape the existing pane test uses.
const MALFORMED = '{"assignment_id":"d1","role":"builder","status":"done","summary":"finished\nthe build","artifacts":[],"details":{}}'
const BUDGET_S = 600

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'lensB-e10-'))
  const paths = { dir: join(base, 'crewdir'), taskDir: join(base, 'task'), returnsDir: join(base, 'returns') }
  for (const p of Object.values(paths)) mkdirSync(p, { recursive: true })
  writeFileSync(join(paths.taskDir, 'role-builder.md'), '# builder')
  writeFileSync(join(paths.taskDir, 'brief.md'), '# brief')
  return { base, paths }
}

function run(label, transport) {
  const { base, paths } = fixture()
  let clock = 0
  const events = []
  const member = transport === 'pane'
    ? { surface_id: 'surface-builder', transport: 'pane' }
    : { model: 'm', transport }
  const crew = { checkout: base, members: { builder: member } }
  const inner = {
    spawn: () => ({ pid: 909090, unref() {} }),
    openSync: () => 7, writeSync: () => {}, closeSync: () => {},
    now: () => clock, sleep: (ms) => { clock += ms }, kill: () => {},
    uuid: () => 'sess', pid: 1,
  }
  const io = seatIo(crew, paths, base, null, {}, {}, {
    now: () => clock,
    sleep: (ms) => { clock += ms },
    sendLine: () => {},
    tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
    locate: () => false,     // not steerable: isolates the read boundary, no re-ask
    cmux: () => ({ ok: false, stdout: '' }),
    headlessIo: (a) => realHeadlessIo({ ...a, bin: '/usr/bin/false', deps: { ...a.deps, ...inner } }),
    headlessRpcIo: (a) => realRpcIo({ ...a, deps: { ...a.deps, ...inner } }),
    spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
  })
  io.emit = (e) => events.push(e)
  const a = io.assign({ role: 'builder', briefFile: join(paths.taskDir, 'brief.md') })
  writeFileSync(a.returnPath, MALFORMED)
  if (transport === 'headless-rpc') {
    writeFileSync(join(paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl'), '{"type":"agent_settled"}\n')
  } else if (transport === 'headless-json') {
    const d = join(paths.taskDir, 'headless', a.id)
    writeFileSync(join(d, 'stream.jsonl'), '{"type":"result","terminal_reason":"done"}\n')
    writeFileSync(join(d, 'exit'), '0')
  }
  let out
  try { out = { returned: io.wait(a.returnPath, BUDGET_S) } }
  catch (err) { out = { stage: err.stage, kind: cellFailureKind(err), message: err.message.split('\n')[0] } }
  const cf = events.filter((e) => e.kind === 'cell-failure')
  console.log(`\n### ${label}`)
  console.log('  outcome            :', JSON.stringify(out))
  console.log('  cell-failure kind  :', JSON.stringify(cf.map((e) => e.failure)))
  console.log(`  wait clock burned  : ${clock} ms of a ${BUDGET_S * 1000} ms budget  (pane pin: <= ${WAIT_POLL_MS})`)
  console.log('  bytes still on disk:', readFileSync(a.returnPath, 'utf8') === MALFORMED)
}

console.log('SAME BYTES:', JSON.stringify(MALFORMED))
run('pane            (pinned by seat-io-runclean.test.mjs:853)', 'pane')
run('headless-json   (unpinned)', 'headless-json')
run('headless-rpc    (unpinned)', 'headless-rpc')
