import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const CATALOG_URL = 'https://models.dev/api.json'

const DIFF_FIELDS = ['cost_in_per_mtok', 'cost_out_per_mtok', 'context']

export function normalizeCatalog(catalog, providers) {
  const wanted = providers ? new Set(providers) : null
  const out = {}
  for (const [providerId, provider] of Object.entries(catalog || {})) {
    if (wanted && !wanted.has(providerId)) continue
    for (const [modelId, model] of Object.entries(provider?.models || {})) {
      const costIn = model?.cost?.input
      const costOut = model?.cost?.output
      const context = model?.limit?.context
      if (!Number.isFinite(costIn) || !Number.isFinite(costOut) || !Number.isFinite(context)) continue
      out[`${providerId}/${modelId}`] = {
        cost_in_per_mtok: costIn,
        cost_out_per_mtok: costOut,
        context,
      }
    }
  }
  return out
}

export function diffModels(before, after) {
  const beforeKeys = Object.keys(before || {}).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const afterKeys = Object.keys(after || {}).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  const added = []
  const removed = []
  const changed = []

  for (const key of afterKeys) {
    if (!Object.prototype.hasOwnProperty.call(before, key)) {
      const m = after[key]
      added.push({ key, cost_in_per_mtok: m.cost_in_per_mtok, cost_out_per_mtok: m.cost_out_per_mtok, context: m.context })
    }
  }

  for (const key of beforeKeys) {
    if (!Object.prototype.hasOwnProperty.call(after, key)) {
      const m = before[key]
      removed.push({ key, cost_in_per_mtok: m.cost_in_per_mtok, cost_out_per_mtok: m.cost_out_per_mtok, context: m.context })
    }
  }

  for (const key of beforeKeys) {
    if (!Object.prototype.hasOwnProperty.call(after, key)) continue
    const b = before[key]
    const a = after[key]
    const fields = []
    for (const field of DIFF_FIELDS) {
      if (b[field] !== a[field]) fields.push({ field, from: b[field], to: a[field] })
    }
    if (fields.length) changed.push({ key, fields })
  }

  return { added, removed, changed }
}

function listSection(title, entries, formatEntry) {
  const lines = [`## ${title} (${entries.length})`]
  for (const entry of entries) lines.push(`- ${formatEntry(entry)}`)
  return lines.join('\n')
}

const formatModel = (m) => `${m.key}: cost_in=${m.cost_in_per_mtok} cost_out=${m.cost_out_per_mtok} context=${m.context}`
const formatChanged = (c) => `${c.key}: ${c.fields.map((f) => `${f.field} ${f.from}->${f.to}`).join(', ')}`

export function renderReport(diff, { generatedAt, rosterUpdatedAt } = {}) {
  const header = [
    '# roster-refresh report',
    `generated_at: ${generatedAt}`,
    `roster_updated_at: ${rosterUpdatedAt}`,
  ].join('\n')

  const hasChanges = diff.added.length || diff.removed.length || diff.changed.length
  if (!hasChanges) {
    return `${header}\n\nNo changes vs crew/roster.json.`
  }

  const body = [
    listSection('New models', diff.added, formatModel),
    listSection('Changed', diff.changed, formatChanged),
    listSection('Disappeared', diff.removed, formatModel),
  ].join('\n\n')

  return `${header}\n\n${body}`
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rosterUrl = new URL('./roster.json', import.meta.url)
  const roster = JSON.parse(readFileSync(rosterUrl, 'utf8'))

  let catalog
  try {
    const res = await fetch(CATALOG_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    catalog = await res.json()
  } catch (err) {
    console.error(`roster-refresh: could not fetch ${CATALOG_URL} — ${err.message}`)
    process.exit(1)
  }

  const providers = new Set()
  for (const seats of Object.values(roster.tiers || {})) {
    for (const seat of Object.values(seats || {})) {
      if (seat) providers.add(seat.provider)
    }
  }

  const before = {}
  for (const [key, m] of Object.entries(roster.models || {})) {
    before[key] = { cost_in_per_mtok: m.cost_in_per_mtok, cost_out_per_mtok: m.cost_out_per_mtok, context: m.context }
  }

  const after = normalizeCatalog(catalog, providers)
  const diff = diffModels(before, after)
  const report = renderReport(diff, { generatedAt: new Date().toISOString(), rosterUpdatedAt: roster.updated_at })

  console.log(report)

  const outIdx = process.argv.indexOf('--out')
  if (outIdx !== -1 && process.argv[outIdx + 1]) {
    writeFileSync(process.argv[outIdx + 1], report)
  }

  process.exit(0)
}
