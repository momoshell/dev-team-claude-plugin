// Personal, fail-open instrumentation; never select an executable from the lane or project.
import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './checks.mjs'

export async function runEndCommand(spec, result, deps = {}) {
  try {
    const d = { crewRoot: join(homedir(), '.crew'), readFileSync, appendFileSync, run: runSuite, now: Date.now, ...deps }
    const ending = result.status === 'stopped' ? 'stopped'
      : result.status === 'done' && result.pr ? 'pr'
        : result.status === 'done' && spec.shape === 'finish' ? 'finish-ready' : null
    if (!ending) return
    const row = {
      event: 'run-end-command', lane: spec.id, ending,
      payload: ending === 'stopped' ? result.reason : ending === 'pr' ? result.pr.url : 'finish-ready',
      command: null, at: null, status: 'unmeasured', reason: 'settings-unreadable', code: null, signal: null, timedOut: null,
    }
    try {
      let raw
      try { raw = d.readFileSync(join(d.crewRoot, 'settings.json'), 'utf8') } catch (error) {
        if (error?.code === 'ENOENT') return
        throw error
      }
      row.reason = 'invalid-settings'
      const settings = JSON.parse(raw)
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings must be an object')
      if (!Object.hasOwn(settings, 'runEndCommand')) return
      row.reason = 'invalid-command'
      row.command = typeof settings.runEndCommand === 'string' ? settings.runEndCommand : null
      if (!row.command || !row.command.trim() || row.command.includes('\0')) throw new Error('invalid runEndCommand')
      const [command, ...args] = row.command.trim().split(/\s+/)
      row.reason = 'runner-threw'
      const execution = await d.run({ cwd: spec.cwd, command, args: [...args, spec.id, ending, row.payload, spec.cwd], timeoutMs: 5000 })
      row.status = execution?.status ?? 'unmeasured'
      row.reason = execution?.reason ?? (execution?.status === 'green' ? null : 'runner-threw')
      row.code = execution?.code ?? null
      row.signal = execution?.signal ?? null
      row.timedOut = execution?.timedOut ?? null
    } catch { /* Keep the failed stage unmeasured, separate from the lane's result. */ }
    try { row.at = d.now() } catch { /* An unknown timestamp stays null. */ }
    try {
      if (d.journal) await d.journal(row)
      else d.appendFileSync(join(spec.taskDir, 'journal.jsonl'), `${JSON.stringify(row)}\n`)
    } catch { /* Instrumentation cannot change the lane's outcome. */ }
  } catch { /* Even instrumentation setup must fail open. */ }
}
