// Roster-level boot validation: the refusals `crew boot --tier` would raise for a
// roster, without booting. Every policy lives in crew.mjs; this file only runs
// boot's resolve -> translate -> floor -> advisor sequence per tier and transport
// and reports what threw. Nothing is spawned, probed or written: endpoint
// liveness is operational state, not roster validity, so the probe is stubbed live.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ASSURANCE_ALIAS_OF } from './assurances.mjs'
import * as piAdapter from './adapters/adapter-pi.mjs'
import { advisorBootRecord, assertAdvisorCellLive, assertBandFloors, loadLadder, resolveAdapters, resolveSeatModels, resolveTier } from './crew.mjs'

const transports = [['default', {}], ['headless-all', { 'headless-all': true }]]

export async function bootRefusals(roster) {
  const refusals = []
  for (const tier of Object.values(ASSURANCE_ALIAS_OF)) {
    for (const [transport, args] of transports) {
      try {
        const { roles, seats: tierSeats, advisor: cell } = resolveTier(roster, tier, args)
        const adapters = await resolveAdapters(roles, args, tierSeats, { roster: { tiers: { [tier]: tierSeats } }, probeEndpoint: async () => true })
        const localProviders = adapters.registry.local_providers
        const seats = resolveSeatModels(tierSeats, adapters, localProviders)
        const advisor = cell ? { ...cell, model: piAdapter.modelString({ provider: cell.provider, id: cell.id, localProviders }) } : null
        assertBandFloors({ ...seats, ...(advisor ? { advisor } : {}) }, tier, loadLadder(), { adapters, localProviders, models: roster?.models })
        const record = advisorBootRecord({ adapters, models: roster?.models, advisor })
        await assertAdvisorCellLive({ record, adapters, models: roster?.models, probeEndpoint: async () => true, note: () => {} })
      } catch (error) {
        refusals.push({
          code: 'boot_refused',
          reason: error?.reason ?? null,
          tier,
          transport,
          role: error?.role ?? null,
          message: error?.message || String(error),
        })
      }
    }
  }
  return refusals
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = process.argv[2]
  if (!path) {
    console.error('usage: node crew/roster-validate.mjs <roster.json>')
    process.exitCode = 1
  } else {
    let roster
    try { roster = JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
      console.error(`cannot read roster ${path}: ${error?.message || String(error)}`)
      process.exitCode = 1
    }
    if (roster !== undefined) {
      const refusals = await bootRefusals(roster)
      for (const refusal of refusals) console.log(JSON.stringify(refusal))
      process.exitCode = refusals.length ? 1 : 0
    }
  }
}
