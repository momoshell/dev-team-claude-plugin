import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROSTER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'crew', 'roster.json')

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function degraded(path, reason) {
  return {
    path,
    degraded: true,
    error: `${reason}, at ${path}`,
    updated_at: null,
    schema_version: null,
    tiers: null,
    models: null,
  }
}

function catalogRow(key, value) {
  const slash = key.indexOf('/')
  const provider = slash < 0 ? key : key.slice(0, slash)
  const id = slash < 0 ? null : key.slice(slash + 1)
  return {
    key,
    provider,
    id,
    cost_in_per_mtok: value?.cost_in_per_mtok ?? null,
    cost_out_per_mtok: value?.cost_out_per_mtok ?? null,
    context: value?.context ?? null,
    tags: Array.isArray(value?.tags) ? [...value.tags] : (value?.tags ?? null),
    source: value?.source ?? null,
    last_verified: value?.last_verified ?? null,
  }
}

export function createRosterSource({ rosterPath } = {}) {
  const path = resolve(rosterPath || DEFAULT_ROSTER_PATH)

  // The roster changes rarely but is not immutable; read it for every request
  // so a hand edit is visible without restarting the visualizer.
  function readRoster() {
    let roster
    try {
      roster = JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      const reason = err instanceof SyntaxError
        ? `invalid roster JSON: ${err.message}`
        : `unable to read roster: ${err.message || 'unknown read error'}`
      return degraded(path, reason)
    }
    if (!record(roster) || !record(roster.tiers)) return degraded(path, 'roster must contain a JSON object with a tiers object')

    const catalog = record(roster.models) ? roster.models : {}
    const models = Object.entries(catalog).map(([key, value]) => catalogRow(key, value))
    const byKey = new Map(models.map((model) => [model.key, model]))
    const tiers = Object.entries(roster.tiers).map(([tier, tierRoster]) => {
      const seats = []
      const unseated = []
      for (const [role, cell] of Object.entries(record(tierRoster) ? tierRoster : {})) {
        if (cell === null) {
          unseated.push(role)
          continue
        }
        if (!record(cell)) {
          unseated.push(role)
          continue
        }
        const provider = cell.provider ?? null
        const id = cell.id ?? null
        const model_key = provider === null || id === null ? null : `${provider}/${id}`
        seats.push({
          role,
          provider,
          id,
          agent: cell.agent ?? null,
          effort: cell.effort ?? null,
          model_key,
          model: model_key === null ? null : (byKey.get(model_key) || null),
        })
      }
      return { tier, seats, unseated }
    })

    return {
      path,
      degraded: false,
      error: null,
      updated_at: roster.updated_at ?? null,
      schema_version: roster.schema_version ?? null,
      tiers,
      models,
    }
  }

  function health() {
    return { roster_path: path, readonly: true }
  }

  return { readRoster, health }
}
