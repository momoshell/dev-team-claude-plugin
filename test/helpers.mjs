// Test helpers: load the workflow body with its meta block stripped and the
// runtime globals (args/log/parallel/agent/pipeline) injected, so the real
// scheduler logic can be exercised with a mock agent — no live model needed.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export function loadWorkflowSource() {
  return readFileSync(join(ROOT, 'team-build.workflow.mjs'), 'utf8')
}

export function listAgents() {
  return readdirSync(join(ROOT, 'agents')).filter((f) => f.endsWith('.md'))
}

// Returns run(args, agent) => { out, logs }. `out` is the workflow's return value.
export function makeRunner() {
  const src = loadWorkflowSource().replace(/^export const meta\s*=\s*\{[\s\S]*?\n\}\n/m, '')
  if (/export const meta/.test(src)) throw new Error('failed to strip the meta block from the workflow')
  // eslint-disable-next-line no-new-func
  const fn = new Function('args', 'log', 'parallel', 'agent', 'pipeline', `return (async () => {\n${src}\n})()`)
  return async (args, agent) => {
    const logs = []
    const log = (m) => logs.push(String(m))
    const parallel = (thunks) => Promise.all(thunks.map((t) => t()))
    const pipeline = async () => { throw new Error('pipeline() should not be called by the wave scheduler') }
    const out = await fn(args, log, parallel, agent, pipeline)
    return { out, logs }
  }
}

// Configurable mock agent, dispatched by the label prefix the workflow sets
// (plan/amend, build/rebuild, gate, build-check). Records every call.
export function mockAgent(opts = {}) {
  const { calls = [], specFor, returnFor, gatePass = () => true, buildNull = () => false, buildPass = () => true } = opts
  return async (_prompt, o) => {
    const label = o.label || ''
    const kind = label.split(':')[0]
    const domain = (label.split(':')[1] || '').split('-')[0] || 'backend'
    calls.push({ kind, domain, agentType: o.agentType, label, phase: o.phase })
    if (kind === 'plan' || kind === 'amend') {
      const base = {
        task_id: `spec-${domain}`, domain, goal: 'g',
        files_in_scope: ['f.ts'], constraints: [], acceptance_criteria: ['works'],
        validation_commands: ['npm test'], discovery_context: 'ctx',
        out_of_scope: [], depends_on: [], interface_contract: 'none',
      }
      return specFor ? { ...base, ...specFor(o, base) } : base
    }
    if (kind === 'build' || kind === 'rebuild') {
      return returnFor ? returnFor(o) : { status: 'done', reason: 'ok', changes: ['f.ts — impl'], validation: 'pass' }
    }
    if (kind === 'gate') {
      const ok = gatePass(o)
      return { pass: ok, findings: ok ? [] : ['review found an issue'] }
    }
    if (kind === 'build-check') {
      if (buildNull(o)) return null
      const ok = buildPass(o)
      return { pass: ok, summary: ok ? 'clean' : 'build broke' }
    }
    throw new Error('unexpected agent label: ' + label)
  }
}

// Parse the "wave N: K task(s) [ids]" log lines into [[ids], ...].
export function waves(logs) {
  return logs
    .filter((l) => /^wave \d+: /.test(l))
    .map((l) => {
      const m = l.match(/\[([^\]]*)\]/)
      return m && m[1] ? m[1].split(', ').filter(Boolean) : []
    })
}
