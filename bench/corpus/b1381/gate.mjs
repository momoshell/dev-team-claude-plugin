import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const self = fileURLToPath(import.meta.url)
const ids = ['PR1', 'PR2', 'PR3']
// Isolated workers ensure even an unbounded retry is a measured failure, not a hung gate.
if (process.argv[2] !== '--case') {
  let failed = false
  for (const id of ids) {
    const result = spawnSync(process.execPath, [self, '--case', id], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
    })
    if (result.status !== 0 || result.signal || result.error) {
      failed = true
      const why = String(result.error?.message ?? result.stderr?.trim() ?? 'check failed').replace(/\s+/g, ' ').slice(0, 600)
      console.log(`FAIL ${id}: ${why || 'check failed'}`)
    }
  }
  process.exitCode = failed ? 1 : 0
} else {
  let root
  try {
    const repo = resolve(process.cwd())
    const { runLean } = await import(pathToFileURL(join(repo, 'crew/lean.mjs')))
    const { runAcpSeat } = await import(pathToFileURL(join(repo, 'crew/acp/seat.mjs')))
    const { PROVIDER_RETRY_MAX: max, PROVIDER_RETRY_TOTAL_WAIT_MS: total, PROVIDER_RESET_SETTLE_MS: settle } =
      await import(pathToFileURL(join(repo, 'crew/headless.mjs')))
    root = mkdtempSync(join(dirname(self), 'gate-runtime-'))
    let fixtureNumber = 0
    const green = { status: 'green', reason: null, code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
    const accepted = (usage = { input_tokens: 17, output_tokens: 9 }) => ({ stopReason: 'end_turn', usage, refusal: null })
    const refused = (kind, message = 'provider refused') => ({ stopReason: null, usage: null, refusal: { code: -32000, errorKind: kind, message } })
    const resetText = (at, hours) => {
      const d = new Date(at + hours * 3600000)
      const h = d.getUTCHours()
      return `Limit reached; resets ${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'} (UTC)`
    }
    function fixture({ script = () => accepted(), oversleep = 0, skill = false, tamper = null, deny = null } = {}) {
      const taskDir = join(root, String(++fixtureNumber))
      mkdirSync(taskDir, { recursive: true })
      const files = new Map(), calls = [], sleeps = [], reads = [], rows = [], effects = [], logs = []
      const sessions = [], clients = []
      let clock = Date.parse('2026-10-26T00:00:00Z'), active = 0
      const spec = { id: 'probe', cwd: repo, taskDir, tier: 'build', shape: 'standard', brief: 'Gate fixture', acceptance: ['G1'],
        source: 'operator decision', branch: 'probe', base: 'main', suite: { command: 'never-executed' } }
      const failure = (code) => Object.assign(new Error(`${code} injected recording error`), { code })
      const append = (file, text) => {
        if (deny?.(String(text))) throw failure('EIO')
        if (!files.has(file)) files.set(file, '')
        files.set(file, files.get(file) + String(text))
      }
      const envelope = (input, id) => ({ role: input.definition.role, id, status: 'done', summary: 'gate fixture',
        details: input.definition.role === 'planner'
          ? { subject: 'fix(crew): retry provider failures', plan_path: join(taskDir, 'plan.md'), gate_path: join(taskDir, 'gate.mjs'), acceptance: ['G1'], mutations: [{ check: 'G1', file: 'unused.mjs', find: 'before', replace: 'after' }] }
          : input.definition.role === 'builder' ? { summary: 'fixture' } : { verdict: 'pass', findings: [] } })
      const deps = {
        now: () => clock,
        sleep: async (ms) => {
          assert.equal(active, 0, 'failed ACP client must close before provider wait')
          assert.ok(Number.isFinite(ms) && ms >= 0, 'finite nonnegative wait')
          sleeps.push(ms)
          if (sleeps.length > max + 2) throw new Error('retry wait safety limit')
          clock += ms + oversleep
        },
        mkdirSync: () => {},
        writeFileSync: (file, text, opts) => {
          if (opts?.flag === 'wx' && files.has(file)) throw failure('EEXIST')
          files.set(file, String(text))
        },
        appendFileSync: append,
        readFileSync: (file, ...rest) => {
          if (files.has(file)) return files.get(file)
          let text = readFileSync(file, ...rest)
          if (skill && file === join(repo, 'crew/agents/planner.md')) {
            text = text.replace('advisor: null', 'advisor: null\nskills: ["alpha"]\nrequires: ["alpha"]')
          }
          return text
        },
        log: (line) => logs.push(JSON.parse(line)),
        runAcpSeat: async (input) => {
          const id = /^Envelope id: (.+)$/m.exec(input.prompt)?.[1]
          const returnPath = /^Return path: (.+)$/m.exec(input.prompt)?.[1]
          assert.ok(id && returnPath, 'issued id and return path')
          assert.ok(calls.length < max + 8, 'bounded fake transport')
          const call = { input, id, at: clock }
          calls.push(call)
          const turn = script(input, calls.length - 1, clock)
          call.turn = turn
          // A refused attempt also writes an envelope: it must not be consumed as success.
          files.set(returnPath, JSON.stringify(envelope(input, id)))
          const update = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `attempt-${calls.length}` } }
          if (skill) {
            const emit = (row) => { try { input.deps.appendFileSync(input.sessionFile, JSON.stringify(row) + '\n', 'utf8') } catch {} }
            emit({ sessionId: `s${calls.length}`, update })
            if (input.definition.role === 'planner') {
              emit({ sessionId: 'skill', update: { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'read', kind: 'read', status: 'completed', rawInput: { path: join(repo, 'skills/alpha/SKILL.md') } } })
              if (tamper === 'rewrite') files.set(input.sessionFile, 'rewritten\n')
              if (tamper === 'delete') files.delete(input.sessionFile)
            }
            return turn
          }
          // Real runAcpSeat, but no process: each client/newSession/close is observable.
          return runAcpSeat({ ...input, binaries: { pi: process.execPath }, deps: {
            ...input.deps, runtimeRoot: taskDir, now: () => clock, sleep: () => { throw new Error('unexpected ACP polling') },
            clientFactory: (options) => {
              const token = {}
              clients.push(token)
              let closed = false
              return {
                start() { active++ }, initialize() {}, setMode() {},
                newSession() { sessions.push(token); return `s${sessions.length}` },
                beginPrompt() { return 1 },
                pollPrompt() { options.sinks.agent_message_chunk({ sessionId: `s${sessions.length}`, update }); return turn },
                close() { assert.equal(closed, false); closed = true; active--; return { outcome: 'proven' } },
              }
            },
          } })
        },
        loopDeps: {
          resolveAgents: () => ({ seats: Object.fromEntries(['planner', 'builder', 'reviewer'].map((role) => [role, { agent: 'pi', provider: 'openai', id: 'gpt-6.1-sol', effort: 'high' }])), advisor: null }),
          mkdir: async () => {},
          readFile: async (file) => { reads.push(file); return files.get(file) ?? '' },
          journal: async (row) => rows.push(row),
          checkBaseline: async () => { effects.push('baseline'); return { accepted: true, reason: 'gate-failed', result: { ...green, status: 'red', reason: 'gate-failed', code: 1, failingIds: ['G1'] } } },
          runGate: async () => green,
          proveMutations: async () => ({ status: 'green', reason: null, rows: [{ check: 'G1', outcome: 'killed', reason: null }] }),
          runSuite: async () => green,
          commitChanges: async () => ({ status: 'green', reason: null, head: 'a'.repeat(40) }),
          rebaseBranch: async () => ({ status: 'green', reason: null, head: 'b'.repeat(40) }),
          openPullRequest: async () => ({ status: 'green', reason: null, pr: { number: 1, url: 'https://example.test/1' } }),
          run: async (input) => ({ ...green, stdout: input.args.includes('status') ? ' M unused.mjs\0' : '' }),
        },
      }
      const go = () => runLean(spec, deps)
      const recording = (call) => {
        const raw = files.get(call.input.sessionFile)
        assert.ok(raw?.endsWith('\n'), 'recording ends with newline')
        return raw.trim().split('\n').map((line) => JSON.parse(line))
      }
      const measured = () => {
        assert.equal(new Set(calls.map((c) => c.input.sessionFile)).size, calls.length, 'unique session file per attempt')
        for (const call of calls) {
          const rs = recording(call)
          assert.deepEqual(rs[0], { type: 'prompt', text: call.input.prompt })
          assert.equal(rs.filter((r) => r.type === 'turn').length, 1, 'exactly one turn row')
          assert.deepEqual(rs.at(-1), { type: 'turn', stopReason: call.turn?.stopReason ?? null, usage: call.turn?.usage ?? null, refusal: call.turn?.refusal ?? null })
        }
      }
      const halted = (result) => {
        assert.deepEqual(result, { status: 'stopped', reason: 'seat-unmeasured', pr: null })
        assert.equal(reads.length, 0, 'no refused envelope read')
        assert.deepEqual(effects, [], 'no stage after failed planner')
        assert.ok(calls.every((c) => c.input.definition.role === 'planner'), 'no later seat')
      }
      return { go, calls, sleeps, reads, rows, effects, logs, sessions, clients, recording, measured, halted }
    }

    const tests = {
      async PR1() {
        for (const kind of ['rate_limit', 'server_error', 'overloaded']) {
          const f = fixture({ script: (_input, n, at) => n === 0 ? refused(kind, resetText(at, 2)) : accepted() })
          assert.equal((await f.go()).status, 'done', `${kind} must recover and continue lane`)
          assert.deepEqual(f.calls.map((c) => c.input.definition.role), ['planner', 'planner', 'builder', 'reviewer'])
          assert.equal(f.calls[0].id, f.calls[1].id, 'retry same issued turn')
          assert.equal(f.calls[0].input.prompt, f.calls[1].input.prompt, 'retry same prompt')
          assert.deepEqual(f.calls[0].input.definition, f.calls[1].input.definition)
          assert.equal(f.sleeps.length, 1)
          assert.ok(f.sleeps[0] > 0 && f.sleeps[0] <= total)
          assert.equal(f.calls[1].at - f.calls[0].at, f.sleeps[0], 'wait before retry')
          if (kind === 'rate_limit') assert.equal(f.sleeps[0], 2 * 3600000 + settle, 'honor stated reset and shared settle')
          assert.equal(f.sessions.length, f.calls.length, 'new ACP session on every attempt')
          assert.equal(new Set(f.clients).size, f.calls.length, 'fresh ACP client')
          assert.equal(f.reads.length, 3, 'only accepted envelopes read')
          f.measured()
        }
        const exhausted = fixture({ script: () => refused('server_error') })
        exhausted.halted(await exhausted.go())
        assert.equal(exhausted.calls.length, max + 1, 'initial attempt plus bounded retries')
        assert.equal(exhausted.sleeps.length, max)
        assert.ok(exhausted.sleeps.reduce((a, b) => a + b, 0) <= total)
        exhausted.measured()

        const distant = fixture({ script: (_i, _n, at) => refused('rate_limit', resetText(at, 6)) })
        distant.halted(await distant.go())
        assert.equal(distant.calls.length, 1, 'beyond-bound reset never starts a replacement')
        assert.equal(distant.sleeps.length, 0)
        distant.measured()

        const cumulative = fixture({ script: (_i, _n, at) => refused('rate_limit', resetText(at, 2)) })
        cumulative.halted(await cumulative.go())
        assert.equal(cumulative.sleeps.length, 2, 'cumulative budget consumed across attempts')
        assert.equal(cumulative.calls.length, 3)
        assert.ok(cumulative.sleeps.reduce((a, b) => a + b, 0) <= total)
        cumulative.measured()

        const overslept = fixture({ script: () => refused('server_error'), oversleep: total + 1 })
        overslept.halted(await overslept.go())
        assert.equal(overslept.sleeps.length, 1)
        assert.equal(overslept.calls.length, 1, 'actual wait beyond bound cannot buy replacement')

        const denied = fixture({ script: () => refused('server_error'), deny: (text) => text.includes('agent_message_chunk') })
        denied.halted(await denied.go())
        assert.equal(denied.calls.length, 1)
        assert.equal(denied.sleeps.length, 0, 'recording error cannot be retried as provider failure')
        assert.equal(denied.rows.find((r) => r.event === 'verdict').observation.error.code, 'EIO')
      },
      async PR2() {
        for (const kind of ['authentication_failed', 'oauth_org_not_allowed', 'verification_required', 'billing_error', null]) {
          const message = resetText(Date.parse('2026-10-26T00:00:00Z'), 2)
          const turn = refused(kind, message)
          const f = fixture({ script: () => turn })
          f.halted(await f.go())
          assert.equal(f.calls.length, 1, `${kind}: do not retry`)
          assert.equal(f.sleeps.length, 0, `${kind}: no wait`)
          assert.deepEqual(f.rows.find((r) => r.event === 'verdict').observation.error, { code: -32000, message })
          f.measured()
        }
        const missing = fixture({ script: () => ({ stopReason: null, usage: null, refusal: null }) })
        missing.halted(await missing.go())
        assert.equal(missing.calls.length, 1)
        assert.equal(missing.sleeps.length, 0)
        missing.measured()
      },
      async PR3() {
        for (const usage of [{ input_tokens: 71, output_tokens: 23, cached_input_tokens: 5 }, null]) {
          const f = fixture({ script: () => accepted(usage) })
          assert.equal((await f.go()).status, 'done')
          assert.equal(f.calls.length, 3)
          f.measured()
          for (const call of f.calls) assert.deepEqual(f.recording(call).at(-1).usage, usage, 'accepted usage persisted')
        }
        const honest = fixture({ skill: true })
        assert.equal((await honest.go()).status, 'done', 'runtime turn row must not invalidate honest skill proof')
        honest.measured()
        for (const tamper of ['rewrite', 'delete']) {
          const f = fixture({ skill: true, tamper })
          assert.equal((await f.go()).status, 'stopped', `${tamper}: intactness still enforced`)
          assert.equal(f.calls.length, 1)
          assert.equal(f.effects.length, 0)
          assert.equal(f.rows.find((r) => r.event === 'envelope').defects.includes('required-skills-unproven'), true)
        }
        const denied = fixture({ deny: (text) => text.includes('"type":"turn"') })
        denied.halted(await denied.go())
        assert.equal(denied.calls.length, 1, 'accepted turn-row write failure stops lane')
        assert.equal(denied.rows.find((r) => r.event === 'verdict').observation.error.code, 'EIO')
      },
    }
    assert.ok(ids.includes(process.argv[3]), 'unknown check')
    await tests[process.argv[3]]()
  } catch (error) {
    console.error(error?.stack ?? String(error))
    process.exitCode = 1
  } finally {
    if (root) rmSync(root, { recursive: true, force: true })
  }
}
