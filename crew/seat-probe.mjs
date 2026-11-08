import { mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRoster, resolveAgents } from './agents.mjs'
import { TIERS } from './protocols.mjs'
import { runAcpSeat } from './acp/seat.mjs'
import { acpProviderFailureKind } from './acp/provider.mjs'

export const SEAT_UNMEASURED_REASONS = Object.freeze(['timeout', 'binary-missing', 'spawn-failed', 'agent-exited', 'rate-limited', 'provider-error', 'turn-incomplete', 'probe-failed'])

export async function probeRoster({ checkout, crewRoot, binaries, clientFactory, env }) {
  const { overrides } = loadRoster({ personal: join(crewRoot, 'agents.json'), project: join(checkout, '.crew', 'agents.json'), readFileSync })
  const cells = new Map()
  for (const tier of TIERS) {
    const { seats, advisor } = resolveAgents(tier, undefined, overrides)
    for (const [role, cell] of [...Object.entries(seats), ...(advisor ? [['advisor', advisor]] : [])]) {
      const model = `${cell.provider}/${cell.id}`
      const key = JSON.stringify([cell.agent, model, cell.effort])
      if (!cells.has(key)) cells.set(key, { agent: cell.agent, model, effort: cell.effort, uses: [] })
      cells.get(key).uses.push({ role, tier })
    }
  }
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'crew-seat-probe-'))
  const refusal = (error) => {
    const text = error.errorMessage ?? error.message
    const kind = acpProviderFailureKind(error.errorKind, text)
    if (kind === 'rate_limit') return { status: 'unmeasured', reason: 'rate-limited' }
    if (kind === 'server_error') return { status: 'unmeasured', reason: 'provider-error' }
    return { status: 'unavailable', text }
  }
  try {
    for (const [index, cell] of [...cells.values()].entries()) {
      try {
        const turn = await runAcpSeat({ definition: { agent: cell.agent, model: cell.model, effort: cell.effort, writes: 'none', skills: [], wait_s: 120 }, cwd: checkout, prompt: 'Reply with the single word OK. Do not use any tools.', sessionFile: join(runtimeRoot, 'sessions', `${index}.ndjson`), binaries, deps: { runtimeRoot, clientFactory, env } })
        Object.assign(cell, turn.refusal != null ? refusal(turn.refusal) : turn.stopReason === 'end_turn' ? { status: 'available' } : { status: 'unmeasured', reason: 'turn-incomplete' })
      } catch (error) {
        const reason = error?.code === 'ACP_BINARY_MISSING' ? 'binary-missing' : ({ 'acp-request-timeout': 'timeout', 'acp-seat-deadline': 'timeout', 'acp-prompt-write-timeout': 'timeout', 'acp-spawn-failed': 'spawn-failed', 'acp-seat-closed': 'agent-exited' })[error?.reason]
        if (reason) Object.assign(cell, { status: 'unmeasured', reason: SEAT_UNMEASURED_REASONS.includes(reason) ? reason : 'probe-failed' })
        else if (error?.method === 'session/new' && (!error.reason || error.reason === 'acp-protocol-mismatch')) Object.assign(cell, refusal(error))
        else Object.assign(cell, { status: 'unmeasured', reason: 'probe-failed' })
      }
    }
    return [...cells.values()]
  } finally {
    rmSync(join(runtimeRoot, 'sessions'), { recursive: true, force: true })
    try { rmdirSync(runtimeRoot) } catch { /* unproven teardown keeps its runtime */ }
  }
}
