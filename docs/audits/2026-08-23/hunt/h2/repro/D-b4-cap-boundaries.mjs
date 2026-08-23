// B4: every LAB_* cap at cap-1 / cap / cap+1 through the real RPC path.
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as mod from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/pi/extensions/lab.ts'

function fakeChild(pid) {
  const c = new EventEmitter()
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter()
  c.stdin.write = () => true; c.stdin.end = () => {}; c.stdin.destroy = () => {}
  c.stdout.destroy = () => {}; c.stderr.destroy = () => {}
  c.stdout.removeListener = () => {}; c.stderr.removeListener = () => {}
  c.pid = pid; c.kill = () => true; c.unref = () => {}
  return c
}
// drive one op frame through a lab tool and return the answer frame
async function op(frame, { program = 'x', scratchDir, grepOut = '' } = {}) {
  const holder = mkdtempSync(join(tmpdir(), 'b4-'))
  const dir = join(holder, 'd'); mkdirSync(dir, { recursive: true })
  const child = fakeChild(1111)
  const answers = []
  child.stdin.write = (v) => {
    const a = JSON.parse(String(v).trim()); answers.push(a)
    queueMicrotask(() => {
      if (answers.length === 1) child.stdout.emit('data', Buffer.from(JSON.stringify(frame) + '\n'))
      else { child.stdout.emit('data', Buffer.from(JSON.stringify({ done: true, result: null }) + '\n')); child.emit('close', 0, null) }
    })
    return true
  }
  const tool = mod.createLabTool({
    env: { CREW_ROLE: 'planner', CREW_TASK_DIR: '' },
    isDirectory: () => true,
    spawn: (() => { let calls = 0; return () => {
      calls += 1
      if (calls === 1) { queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ id: 1, op: 'scratchCheckout', args: [] }) + '\n'))); return child }
      const suite = fakeChild(2222)
      queueMicrotask(() => { suite.stdout.emit('data', Buffer.from('TAP version 13\n# pass 1\n# fail 0\n')); suite.emit('close', 0, null) })
      return suite
    } })(),
    spawnSync: (cmd, args) => args[0] === 'grep'
      ? { status: 0, stdout: grepOut, stderr: '' }
      : { status: 0, stdout: 'deadbeef\n', stderr: '' },
    mkTempDir: () => dir, removeDir: () => {}, realpath: () => scratchDir || dir,
    writeFile: () => {}, readFile: () => 'file body\n',
    kill: () => { const e = new Error('gone'); e.code = 'ESRCH'; throw e },
  })
  const out = await tool.execute('id', { program }, null, null, { cwd: '/tmp' })
  rmSync(holder, { recursive: true, force: true })
  return { answers, out }
}

console.log('--- LAB_PROGRAM_CAP_BYTES = ' + mod.LAB_PROGRAM_CAP_BYTES + ' ---')
for (const n of [mod.LAB_PROGRAM_CAP_BYTES - 1, mod.LAB_PROGRAM_CAP_BYTES, mod.LAB_PROGRAM_CAP_BYTES + 1]) {
  const r = await op({ id: 2, op: 'read', args: ['a.mjs'] }, { program: 'a'.repeat(n) })
  console.log(`  program ${String(n).padStart(6)} B -> outcome=${r.out.details.outcome} refused=${r.out.details.refused}`)
}
console.log('  (multibyte) 64 KiB in CHARS but 3x that in bytes:')
{
  const r = await op({ id: 2, op: 'read', args: ['a.mjs'] }, { program: '你'.repeat(mod.LAB_PROGRAM_CAP_BYTES / 3 + 1) })
  console.log(`  -> refused=${r.out.details.refused} (byteLength is the measure, not .length: correct)`)
}
console.log('--- LAB_SUITE_PATHS_MAX = ' + mod.LAB_SUITE_PATHS_MAX + ' ---')
for (const n of [mod.LAB_SUITE_PATHS_MAX - 1, mod.LAB_SUITE_PATHS_MAX, mod.LAB_SUITE_PATHS_MAX + 1]) {
  const r = await op({ id: 2, op: 'runSuite', args: [Array.from({ length: n }, () => 'a.mjs')] })
  const a = r.answers[1]
  console.log(`  ${String(n).padStart(3)} paths -> ${a?.ok ? 'accepted' : 'refused ' + a?.refused}`)
}
console.log('--- LAB_GREP_HITS_MAX = ' + mod.LAB_GREP_HITS_MAX + ' ---')
for (const n of [mod.LAB_GREP_HITS_MAX - 1, mod.LAB_GREP_HITS_MAX, mod.LAB_GREP_HITS_MAX + 1]) {
  const out = Array.from({ length: n }, (_, i) => `a.mjs:${i + 1}:hit`).join('\n') + '\n'
  const r = await op({ id: 2, op: 'grep', args: ['hit'] }, { grepOut: out })
  const a = r.answers[1]
  console.log(`  ${String(n).padStart(4)} raw hits -> returned=${a?.value?.hits?.length} truncated=${a?.value?.truncated}`)
}
console.log('--- opts.maxHits boundary (raw hits fixed at 10) ---')
for (const m of [undefined, 1, 9, 10, 11, 0, -1, 1.5, 10 ** 9]) {
  const out = Array.from({ length: 10 }, (_, i) => `a.mjs:${i + 1}:hit`).join('\n') + '\n'
  const r = await op({ id: 2, op: 'grep', args: m === undefined ? ['hit'] : ['hit', { maxHits: m }] }, { grepOut: out })
  const a = r.answers[1]
  console.log(`  maxHits=${String(m).padStart(11)} -> ${a?.ok ? `hits=${a.value.hits.length} truncated=${a.value.truncated}` : `refused ${a?.refused}`}`)
}
