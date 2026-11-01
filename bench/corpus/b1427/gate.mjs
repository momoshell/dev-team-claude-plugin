import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const advisor = await import(pathToFileURL(join(root, 'crew/pi/extensions/advisor.ts')).href)
const { runAcpSeat } = await import(pathToFileURL(join(root, 'crew/acp/seat.mjs')).href)
const failures = []
const check = (id, fn) => Promise.resolve().then(fn).catch((error) => failures.push(`${id}: ${error.message}`))
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const temps = []
const temp = (name) => { const dir = mkdtempSync(join(tmpdir(), name)); temps.push(dir); return dir }
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' })

function sink() {
  const rows = []
  return { rows, appendFile: (_path, text) => { for (const line of String(text).split('\n')) if (line.trim()) rows.push(JSON.parse(line)) } }
}
function fakeSpawn(payloads) {
  return () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
    child.stdin = { end(value) { payloads.push(JSON.parse(value)); setImmediate(() => {
      const lines = payloads.at(-1).delta.flatMap((entry) => String(entry.text ?? entry).split('\n'))
      const anchor = lines.map((line) => /^(.+?):(\d+): /.exec(line)?.slice(1, 3)).find(Boolean)
      const judgment = { class: 'edge-path', severity: 'medium', claim: 'grounded consult finding', evidence: [anchor ? `${anchor[0]}:${anchor[1]}` : 'lib/widget.mjs:1'] }
      child.stdout.write(`${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: JSON.stringify(judgment), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } })}\n`)
      child.emit('close', 0)
    }) } }
    return child
  }
}
function oldTask() {
  const base = temp('gate-task-'); const taskDir = join(base, 'task'); const returns = join(base, 'returns')
  mkdirSync(taskDir, { recursive: true }); mkdirSync(returns, { recursive: true }); mkdirSync(join(base, 'tree', 'lib'), { recursive: true })
  writeFileSync(join(taskDir, advisor.TRIPWIRE_MANIFEST_FILE), JSON.stringify({ schema_version: 1, run_started_at: 1, tripwires: [], cell: { provider: 'provider', id: 'model', agent: 'pi', effort: 'medium', model: 'provider/model' } }))
  writeFileSync(join(returns, 'd1.planner.json'), JSON.stringify({ details: { files_in_scope: ['lib/'], validation_lane: 'npm test' } }))
  return { base, taskDir }
}
function makeAdvisor({ taskDir, cwd, payloads, journal, extraDeps = {}, lean = false }) {
  return advisor.createAdvisor({
    env: { CREW_ROLE: 'builder', CREW_TASK_DIR: taskDir, ...(lean ? { CREW_CONTEXT_LAYOUT: 'lean' } : {}) },
    deps: { cwd, taskDir, appendFile: journal.appendFile, resolveBinary: () => ({ command: '/fake/pi', args: [] }), spawn: fakeSpawn(payloads), ...extraDeps },
  })
}
function repoWithCommittedFile(path, lines) {
  const repo = temp('gate-repo-'); mkdirSync(join(repo, 'lib'), { recursive: true })
  writeFileSync(join(repo, path), lines.join('\n') + '\n'); git(repo, 'init', '-q'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base'); return repo
}
const deltaText = (payload) => payload.delta.map((entry) => String(entry.text ?? entry)).join('\n')

await check('PW1', async () => {
  const { taskDir } = oldTask(); const journal = sink(); const payloads = []
  const lines = Array.from({ length: 250 }, (_, i) => `const v${i + 1} = ${i + 1}`)
  const repo = repoWithCommittedFile('lib/big.mjs', lines)
  lines[199] = 'const v200 = "PW1-LINE-200-MARKER"'; writeFileSync(join(repo, 'lib/big.mjs'), lines.join('\n') + '\n')
  const a = makeAdvisor({ taskDir, cwd: repo, payloads, journal })
  await a.onToolCall({ toolCallId: 'r1', toolName: 'write', input: { path: join(taskDir, 'builder-1.json'), content: '{}\n' } }, {})
  assert(payloads.length === 1 && payloads[0].trigger === 'pre-return', 'pre-return consult did not spawn from the whole diff alone')
  assert(deltaText(payloads[0]).includes('lib/big.mjs:200: const v200 = "PW1-LINE-200-MARKER"'), 'line 200 change missing from pre-return prompt')
})

await check('PW2', async () => {
  // Brief text -> seat laneContext manifest -> advisor loadContext -> pre-return child prompt, end to end.
  const lane = temp('gate-lane-'); const taskDir = join(lane, 'task'); const runtimeRoot = join(lane, 'runtime'); mkdirSync(taskDir, { recursive: true }); mkdirSync(runtimeRoot, { recursive: true })
  const anchor = Date.now() - 60_000
  writeFileSync(join(taskDir, 'journal.jsonl'), `${JSON.stringify({ event: 'run-start', at: anchor })}\n`)
  const plannerPath = join(taskDir, 'planner-1.json')
  writeFileSync(plannerPath, JSON.stringify({ role: 'planner', id: 'x.planner.1', status: 'done', summary: 's', details: { files_in_scope: ['lib/'], validation_lane: 'node --test x', gate_cmd: 'node gate.mjs', plan_path: 'p', gate_path: 'g', acceptance: ['PW2'], mutations: [{ check: 'PW2', file: 'a.mjs', find: 'a', replace: 'b' }], subject: 'fix(crew): x' } }))
  utimesSync(plannerPath, (anchor + 5000) / 1000, (anchor + 5000) / 1000)
  const briefText = '## Acceptance\n- (PW1) first item\n- (PW2) PW2-ACCEPTANCE-MARKER the brief item text\n'
  runAcpSeat({ definition: { role: 'builder', agent: 'pi', writes: 'repo', effort: 'high', skills: [], model: 'openai/gpt-6.1-sol', advisor: { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high' } }, cwd: lane, taskDir, prompt: 'p', briefText, sessionFile: join(taskDir, 'session.jsonl'), binaries: { pi: process.execPath }, deps: { runtimeRoot, env: { PATH: process.env.PATH }, clientFactory: () => ({ start() {}, initialize() {}, newSession() {}, setMode() {}, beginPrompt: () => 1, pollPrompt: () => ({ stopReason: 'end_turn', refusal: null }), close: () => ({ outcome: 'proven' }) }) } })
  const manifest = JSON.parse(readFileSync(join(taskDir, 'advisor-manifest.json'), 'utf8'))
  assert(JSON.stringify(manifest.acceptance_items ?? null).includes('PW2-ACCEPTANCE-MARKER'), 'seat manifest does not carry brief acceptance items')
  const journal = sink(); const payloads = []; const repo = repoWithCommittedFile('lib/a.mjs', ['const a = 1'])
  writeFileSync(join(repo, 'lib/a.mjs'), 'const a = 2\n')
  const a = makeAdvisor({ taskDir, cwd: repo, payloads, journal, lean: true })
  await a.onToolCall({ toolCallId: 'r1', toolName: 'write', input: { path: join(taskDir, 'builder-1.json'), content: '{}\n' } }, {})
  assert(payloads.length === 1, 'pre-return consult did not spawn')
  assert(JSON.stringify(payloads[0].acceptance_items ?? payloads[0].acceptance ?? null).includes('PW2-ACCEPTANCE-MARKER'), 'pre-return prompt does not carry brief acceptance items')
})

await check('PW3', async () => {
  const { taskDir } = oldTask(); const journal = sink(); const payloads = []
  const repo = temp('gate-big-'); git(repo, 'init', '-q'); git(repo, 'commit', '-q', '--allow-empty', '-m', 'base')
  for (let f = 0; f < 16; f += 1) {
    const name = `f${String(f).padStart(2, '0')}.txt`; const token = `OMIT${String(f).padStart(2, '0')}`
    writeFileSync(join(repo, name), Array.from({ length: 300 }, (_, i) => `${token} line ${i} xxxxxxxx`).join('\n') + '\n')
  }
  const a = makeAdvisor({ taskDir, cwd: repo, payloads, journal })
  await a.onToolCall({ toolCallId: 'r1', toolName: 'write', input: { path: join(taskDir, 'builder-1.json'), content: '{}\n' } }, {})
  assert(payloads.length === 1, 'pre-return consult did not spawn')
  const payload = payloads[0]; const bytes = Buffer.byteLength(deltaText(payload), 'utf8')
  assert(bytes <= 48 * 1024, `pre-return diff over budget: ${bytes} bytes`)
  const omitted = payload.omitted_files ?? []
  assert(Array.isArray(omitted) && omitted.includes('f15.txt'), `over-budget files not named as omitted: ${JSON.stringify(omitted)}`)
  assert(!deltaText(payload).includes('OMIT15'), 'a file named as omitted was silently included/cut inconsistently')
  const row = journal.rows.find((r) => r.advisor_consult?.trigger === 'pre-return')?.advisor_consult
  assert(row && Array.isArray(row.omitted_files) && row.omitted_files.includes('f15.txt'), 'consult journal row does not record omitted files')
  assert(row.window_bytes === bytes && row.window_entries === payload.delta.length, 'consult journal row does not record the window bytes/entries it was given')
})

await check('PW4', async () => {
  const { base, taskDir } = oldTask(); const journal = sink(); const payloads = []
  const tree = join(base, 'tree'); writeFileSync(join(tree, 'lib/widget.mjs'), 'a\nb\n')
  const diff = { lines: 0, entries: [] }
  const a = makeAdvisor({ taskDir, cwd: tree, payloads, journal, extraDeps: { diffLines: () => ({ lines: diff.lines, entries: diff.entries, text: diff.entries.join('\n') }), diffSize: () => null } })
  a.onToolResult({ toolCallId: 'g', toolName: 'read', input: { path: join(tree, 'lib/widget.mjs') }, content: [{ type: 'text', text: 'lib/widget.mjs:2: grounded' }] }, {})
  diff.lines = advisor.DIFF_GROWTH_LINES
  diff.entries = Array.from({ length: 20 }, (_, e) => Array.from({ length: 20 }, (_, i) => `lib/widget.mjs:${i + 1}: ${'x'.repeat(80)}`).join('\n'))
  await a.onToolCall({ toolCallId: 'b1', toolName: 'bash', input: { command: 'true' } }, {})
  a.onToolResult({ toolCallId: 'b1', toolName: 'bash', input: { command: 'true' }, content: [{ type: 'text', text: 'ok' }] }, {})
  await a.settled()
  const payload = payloads.find((p) => p.trigger === 'diff-growth')
  assert(payload, 'diff-growth consult did not spawn')
  assert(payload.delta.length <= 12, `diff-growth delta has ${payload.delta.length} entries over 12`)
  assert(payload.delta.every((entry) => Buffer.byteLength(String(entry.text ?? entry), 'utf8') <= 512), 'diff-growth delta entry over 512 bytes')
})

for (const dir of temps) rmSync(dir, { recursive: true, force: true })
for (const failure of failures) console.log(`FAIL ${failure}`)
process.exit(failures.length ? 1 : 0)
