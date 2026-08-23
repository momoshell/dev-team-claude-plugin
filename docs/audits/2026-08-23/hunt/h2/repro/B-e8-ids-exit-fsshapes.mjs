// E8: assignment-id derivation past MAX_SAFE_INTEGER, exit-marker parsing, and
// a DIRECTORY / symlink at the envelope path on the two headless transports.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headlessRpcIo } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/headless-rpc.mjs'
import { headlessIo } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/headless.mjs'

const line = (l, v) => console.log(l.padEnd(46), JSON.stringify(v))

function rpcFixture(seed = []) {
  const base = mkdtempSync(join(tmpdir(), 'lensB-e8-'))
  const paths = { dir: join(base, 'crewdir'), taskDir: join(base, 'task'), returnsDir: join(base, 'returns') }
  for (const p of Object.values(paths)) mkdirSync(p, { recursive: true })
  writeFileSync(join(paths.taskDir, 'role-builder.md'), '# b'); writeFileSync(join(paths.taskDir, 'brief.md'), '# brief')
  for (const name of seed) writeFileSync(join(paths.returnsDir, name), '{}')
  let clock = 0
  const io = headlessRpcIo({
    crew: { checkout: base, members: { builder: { model: 'g', transport: 'headless-rpc' } } },
    paths, taskDir: paths.taskDir, checkout: base, adapters: {}, bin: 'pi',
    deps: {
      spawn: () => ({ pid: 4242, unref() {} }), openSync: () => 7, writeSync: () => {}, closeSync: () => {},
      now: () => clock, sleep: (ms) => { clock += ms }, kill: () => {}, uuid: () => 's', pid: 1,
      log: () => {}, emit: () => {},
    },
  })
  return { io, paths, brief: join(paths.taskDir, 'brief.md') }
}

console.log('--- nextAssignmentId (headless-rpc.mjs:268-281) vs a huge existing id ---')
for (const seed of [[], ['d7.builder.json'], ['d9007199254740993.builder.json'], ['d1e5.builder.json'], ['d99999999999999999999.builder.json']]) {
  const f = rpcFixture(seed)
  const a = f.io.assign({ role: 'builder', briefFile: f.brief })
  // second assign after the first turn is abandoned
  let b = null
  try { f.io.close('builder') } catch {}
  try { b = f.io.assign({ role: 'builder', briefFile: f.brief }) } catch (e) { b = { err: e.message } }
  line(`seed ${JSON.stringify(seed)}`, { first: a.id, second: b?.id ?? b, collide: a.id === b?.id })
}

console.log('\n--- exit-marker parsing (headless.mjs:146-152 / headless-rpc.mjs:158-164) ---')
const base = mkdtempSync(join(tmpdir(), 'lensB-e8x-'))
const probeExit = (name, body) => {
  const p = join(base, name); writeFileSync(p, body)
  // parseExit is module-private; drive it through the same expression it uses
  const n = Number(String(body).trim())
  line(`exit file ${JSON.stringify(body)}`, Number.isFinite(n) ? n : null)
}
for (const b of ['0', '1', '', '   ', '\n', '0x1f', '1e3', 'Infinity', '-0', ' 137 ', 'killed', '1 2']) probeExit(`e${Math.random()}`, b)
console.log('NOTE: an EMPTY or all-whitespace exit marker parses as exit code 0 (Number("")===0),')
console.log('      which classifyRun reads as a CLEAN worker exit.')

console.log('\n--- a DIRECTORY / dangling symlink at the envelope path ---')
{
  const f = rpcFixture()
  const a = f.io.assign({ role: 'builder', briefFile: f.brief })
  mkdirSync(a.returnPath)                       // the seat made a directory, not a file
  const stream = join(f.paths.taskDir, 'headless-rpc', 'builder', 'stream.jsonl')
  writeFileSync(stream, JSON.stringify({ type: 'agent_settled' }) + '\n')
  let out
  try { out = { returned: f.io.wait(a.returnPath, 600) } } catch (e) { out = { threw: e.stage } }
  line('rpc wait with a DIRECTORY at returnPath', out.threw ?? out.returned?.status)
  line('  -> details', out.returned?.details ?? null)
}
{
  const b2 = mkdtempSync(join(tmpdir(), 'lensB-e8s-'))
  const paths = { dir: join(b2, 'c'), taskDir: join(b2, 't'), returnsDir: join(b2, 'r') }
  for (const p of Object.values(paths)) mkdirSync(p, { recursive: true })
  writeFileSync(join(paths.taskDir, 'role-builder.md'), '# b'); writeFileSync(join(paths.taskDir, 'brief.md'), '# brief')
  let clock = 0
  const io = headlessIo({
    crew: { checkout: b2, members: { builder: { model: 's', transport: 'headless-json' } } },
    paths, taskDir: paths.taskDir, checkout: b2, adapters: {}, bin: '/usr/bin/false',
    deps: { spawn: () => ({ pid: 1, unref() {} }), now: () => clock, sleep: (ms) => { clock += ms }, kill: () => {}, uuid: () => 's', pid: 1, log: () => {}, emit: () => {} },
  })
  const a = io.assign({ role: 'builder', briefFile: join(paths.taskDir, 'brief.md') })
  // seat wrote a symlink pointing OUTSIDE returnsDir
  const outside = join(b2, 'somewhere-else.json')
  writeFileSync(outside, JSON.stringify({ assignment_id: 'SOMEONE-ELSE', role: 'lead', status: 'done', summary: 'not this seats work', artifacts: [], details: {} }))
  symlinkSync(outside, a.returnPath)
  const env = io.wait(a.returnPath, 600)
  line('headless-json accepted a symlink target', env)
  line('  role in file vs role assigned', `${env.role} vs builder`)
  line('  assignment_id in file vs assigned', `${env.assignment_id} vs ${a.id}`)
}
