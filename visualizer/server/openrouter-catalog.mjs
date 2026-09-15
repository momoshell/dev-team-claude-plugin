const SOURCE = 'OpenRouter'
const SOURCE_URL = 'https://openrouter.ai/api/v1/models'
const API_URL = SOURCE_URL
const CACHE_MS = 6 * 60 * 60 * 1000

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finite(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function pricePerMillion(value) {
  const amount = finite(value)
  return amount === null ? null : Number((amount * 1_000_000).toFixed(12))
}

function errorMessage(status, payload) {
  const detail = record(payload) && typeof payload.error === 'string' ? `: ${payload.error}` : ''
  return `OpenRouter request failed (${status})${detail}`
}

function emptyCatalog(absent) {
  return {
    configured: true,
    credential_source: null,
    source: SOURCE,
    source_url: SOURCE_URL,
    fetched_at: null,
    stale: false,
    models: null,
    absent,
  }
}

export function shapeOpenRouterModel(model) {
  if (!record(model) || typeof model.id !== 'string' || !model.id.trim() || typeof model.name !== 'string' || !model.name.trim()) return null
  const runtimeId = model.id.trim()
  const name = model.name.trim()
  const slash = runtimeId.indexOf('/')
  const provider = slash > 0 ? runtimeId.slice(0, slash) : null
  const modelSlug = slash >= 0 ? runtimeId.slice(slash + 1) : runtimeId
  const pricing = record(model.pricing) ? model.pricing : {}
  const contextLength = model.context_length ?? null
  return {
    source_id: runtimeId,
    name,
    slug: modelSlug,
    family_name: name,
    family_slug: modelSlug,
    creator: provider || 'Unknown provider',
    creator_id: provider,
    provider_hint: provider,
    provider,
    runtime_id: runtimeId,
    release_date: null,
    reasoning_effort: null,
    reasoning_mode: null,
    benchmark_variant: null,
    intelligence: null,
    coding: null,
    agentic: null,
    price_input: pricePerMillion(pricing.prompt),
    price_output: pricePerMillion(pricing.completion),
    price_cache_hit: null,
    price_cache_write: null,
    benchmark_cost_per_task: null,
    output_tokens_per_second: null,
    time_to_first_token_seconds: null,
    context_length: contextLength,
    context_window_tokens: finite(contextLength),
  }
}

export function createOpenRouterCatalog({ fetchImpl = globalThis.fetch, now = () => Date.now(), cacheMs = CACHE_MS } = {}) {
  let cache = null
  let inFlight = null

  async function refresh() {
    const response = await fetchImpl(API_URL, { headers: { accept: 'application/json' } })
    let payload = null
    try { payload = await response.json() } catch { /* status below remains authoritative */ }
    if (!response?.ok) throw new Error(errorMessage(response?.status, payload))
    if (!record(payload) || !Array.isArray(payload.data)) throw new Error('OpenRouter returned an invalid model catalog')
    const models = payload.data.map(shapeOpenRouterModel).filter(Boolean)
    const value = {
      configured: true,
      credential_source: null,
      source: SOURCE,
      source_url: SOURCE_URL,
      fetched_at: new Date(now()).toISOString(),
      stale: false,
      models,
      absent: null,
    }
    cache = { at: now(), value }
    return value
  }

  async function get() {
    if (cache && now() - cache.at < cacheMs) return cache.value
    if (!inFlight) inFlight = refresh().finally(() => { inFlight = null })
    try { return await inFlight } catch (err) {
      if (cache) return { ...cache.value, stale: true, absent: err?.message || String(err) }
      return emptyCatalog(err?.message || String(err))
    }
  }

  return { get }
}
