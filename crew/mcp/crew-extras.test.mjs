import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { ROOT, scratchDir } from '../../test/helpers.mjs'

test('crew-extras lists only granted tools and dispatches retrieve and agent through the pi tools', () => {
  const root = scratchDir('crew-extras-')
  const task = join(root, 'task')
  mkdirSync(task)
  try {
    const anchor = Date.now() - 60000
    writeFileSync(join(task, 'journal.jsonl'), `${JSON.stringify({ event: 'run-start', at: anchor })}\n`)
    writeFileSync(join(task, 'plan.md'), '# plan\n')
    writeFileSync(join(task, 'planner-1.json'), JSON.stringify({ role: 'planner', id: 'lane.planner.1', status: 'done', summary: 's', details: { subject: 'fix(crew): test', plan_path: 'plan.md', gate_path: 'gate.mjs', acceptance: ['AC1'], mutations: [{ check: 'AC1', file: 'inside.mjs', find: 'a', replace: 'b' }], files_in_scope: ['inside.mjs'], validation_lane: 'node --test', gate_cmd: 'node gate.mjs' } }))
    writeFileSync(join(root, 'inside.mjs'), 'const inside = 42\n')
    writeFileSync(join(root, 'outside.mjs'), 'secret\n')
    assert.ok(existsSync(join(ROOT, 'crew/mcp/crew-extras.mjs')))
    const agent = JSON.stringify([{ name: 'scout', def: join(ROOT, 'crew/pi/agents/scout.json') }])
    const requests = [
      { id: 1, method: 'tools/list' },
      { id: 2, method: 'tools/call', params: { name: 'retrieve', arguments: { file: 'inside.mjs', range: '1-1' } } },
      { id: 3, method: 'tools/call', params: { name: 'retrieve', arguments: { file: 'outside.mjs', range: '1-1' } } },
      { id: 4, method: 'tools/call', params: { name: 'agent', arguments: { agent: 'not-granted', task: 'inspect' } } },
      { id: 5, method: 'tools/call', params: { name: 'other', arguments: {} } },
    ]
    for (const grants of [[], ['retrieve'], ['agent'], ['retrieve', 'agent']]) {
      const child = spawnSync(process.execPath, [join(ROOT, 'crew/mcp/crew-extras.mjs')], { cwd: root, input: requests.map((request) => JSON.stringify({ jsonrpc: '2.0', ...request })).join('\n') + '\n', encoding: 'utf8', timeout: 10000, env: { ...process.env, CREW_TASK_DIR: task, CREW_ROLE: 'builder', CREW_EXTRAS: JSON.stringify(grants), CREW_PI_AGENTS: agent } })
      assert.equal(child.status, 0, child.stderr)
      const rows = child.stdout.trim().split('\n').map((line) => JSON.parse(line).result)
      assert.deepEqual(rows[0].tools.map((tool) => tool.name), grants)
      if (grants.includes('retrieve')) assert.match(rows[1].content[0].text, /inside = 42/)
      else assert.equal(rows[1].isError, true)
      assert.equal(rows[2].isError, true)
      assert.equal(rows[3].isError, true)
      if (grants.includes('agent')) assert.match(rows[3].content[0].text, /not granted/)
      assert.equal(rows[4].isError, true)
      assert.ok(rows[4].content[0].text.length < 256)
    }
    const pi = join(root, 'pi')
    const findings = { summary: 'Found it', findings: [{ claim: 'inside is 42', evidence: ['inside.mjs:1'], confidence: 'verified' }] }
    writeFileSync(pi, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: JSON.stringify(${JSON.stringify(findings)}) } }) + '\\n')\n`, { mode: 0o755 })
    const scout = JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'agent', arguments: { agent: 'scout', task: 'inspect inside' } } }) + '\n'
    for (const binary of ['', pi]) {
      const child = spawnSync(process.execPath, [join(ROOT, 'crew/mcp/crew-extras.mjs')], { cwd: root, input: scout, encoding: 'utf8', timeout: 10000, env: { ...process.env, CREW_TASK_DIR: task, CREW_ROLE: 'builder', CREW_EXTRAS: '["agent"]', CREW_PI_AGENTS: agent, CREW_PI_BINARY: binary } })
      assert.equal(child.status, 0, child.stderr)
      const result = JSON.parse(child.stdout.trim()).result
      if (binary) assert.deepEqual(JSON.parse(result.content[0].text), findings)
      else {
        assert.equal(result.isError, true)
        assert.match(result.content[0].text, /executable could not be resolved/)
        assert.equal(existsSync(join(task, 'subagent-spawns.json')), false)
      }
    }
    assert.match(readFileSync(join(task, 'journal.jsonl'), 'utf8'), /subagent_usage/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
