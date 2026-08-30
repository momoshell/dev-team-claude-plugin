const SOURCE = 'Artificial Analysis'
const SOURCE_URL = 'https://artificialanalysis.ai/'
const API_URL = 'https://artificialanalysis.ai/api/v2/language/models/free'
const CACHE_MS = 6 * 60 * 60 * 1000
const MAX_PAGES = 20

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function measured(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function shapeArtificialAnalysisModel(model) {
  if (!record(model) || typeof model.id !== 'string' || typeof model.name !== 'string' || typeof model.slug !== 'string') return null
  const evaluations = record(model.evaluations) ? model.evaluations : {}
  const pricing = record(model.pricing) ? model.pricing : {}
  const performance = record(model.performance) ? model.performance : {}
  const indexCost = record(model.artificial_analysis_intelligence_index_cost) ? model.artificial_analysis_intelligence_index_cost : {}
  const costPerTask = record(indexCost.cost_per_task) ? indexCost.cost_per_task : {}
  const creator = record(model.model_creator) ? model.model_creator : {}
  return {
    source_id: model.id,
    name: model.name,
    slug: model.slug,
    creator: typeof creator.name === 'string' ? creator.name : 'Unknown creator',
    creator_id: typeof creator.id === 'string' ? creator.id : null,
    provider_hint: slug(creator.name) || null,
    runtime_id_hint: typeof model.openrouter_api_id === 'string' && model.openrouter_api_id ? model.openrouter_api_id : model.slug,
    release_date: typeof model.release_date === 'string' ? model.release_date : null,
    intelligence: measured(evaluations.artificial_analysis_intelligence_index),
    coding: measured(evaluations.artificial_analysis_coding_index),
    agentic: measured(evaluations.artificial_analysis_agentic_index),
    price_input: measured(pricing.price_1m_input_tokens),
    price_output: measured(pricing.price_1m_output_tokens),
    price_cache_hit: measured(pricing.price_1m_cache_hit_tokens),
    price_cache_write: measured(pricing.price_1m_cache_write_tokens),
    benchmark_cost_per_task: measured(costPerTask.total_cost),
    output_tokens_per_second: measured(performance.median_output_tokens_per_second),
    time_to_first_token_seconds: measured(performance.median_time_to_first_token_seconds),
    context_window_tokens: measured(model.context_window_tokens),
  }
}

function errorMessage(status, payload) {
  const detail = record(payload) && typeof payload.error === 'string' ? `: ${payload.error}` : ''
  if (status === 401) return `Artificial Analysis rejected the configured API key${detail}`
  if (status === 403) return `The configured Artificial Analysis tier does not cover the model catalog${detail}`
  if (status === 429) return `Artificial Analysis rate limit reached${detail}`
  return `Artificial Analysis request failed (${status})${detail}`
}

export function createArtificialAnalysisCatalog({ apiKey, fetchImpl = globalThis.fetch, now = () => Date.now(), cacheMs = CACHE_MS } = {}) {
  let cache = null
  let inFlight = null
  let currentApiKey = typeof apiKey === 'string' ? apiKey.trim() : ''

  async function readPage(page) {
    const response = await fetchImpl(`${API_URL}?page=${page}`, {
      headers: { 'x-api-key': currentApiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    let payload = null
    try { payload = await response.json() } catch { /* status below remains authoritative */ }
    if (!response.ok) throw new Error(errorMessage(response.status, payload))
    if (!record(payload) || !Array.isArray(payload.data)) throw new Error('Artificial Analysis returned an invalid model catalog')
    return payload
  }

  async function refresh() {
    const rows = []
    let page = 1
    let version = null
    let tier = null
    while (page <= MAX_PAGES) {
      const payload = await readPage(page)
      version = payload.intelligence_index_version ?? version
      tier = payload.tier ?? tier
      rows.push(...payload.data)
      if (payload.pagination?.has_more !== true) break
      page += 1
    }
    if (page > MAX_PAGES) throw new Error(`Artificial Analysis pagination exceeded ${MAX_PAGES} pages`)
    const models = rows.map(shapeArtificialAnalysisModel).filter(Boolean)
    const value = {
      configured: true,
      source: SOURCE,
      source_url: SOURCE_URL,
      fetched_at: new Date(now()).toISOString(),
      stale: false,
      tier,
      intelligence_index_version: version,
      models,
      absent: null,
    }
    cache = { at: now(), value }
    return value
  }

  async function get() {
    if (currentApiKey === '') return {
      configured: false,
      source: SOURCE,
      source_url: SOURCE_URL,
      fetched_at: null,
      stale: false,
      tier: null,
      intelligence_index_version: null,
      models: null,
      absent: 'Set ARTIFICIAL_ANALYSIS_API_KEY on the visualizer server to load the benchmark catalog.',
    }
    if (cache && now() - cache.at < cacheMs) return cache.value
    if (!inFlight) inFlight = refresh().finally(() => { inFlight = null })
    try { return await inFlight } catch (err) {
      if (cache) return { ...cache.value, stale: true, absent: err?.message || String(err) }
      return {
        configured: true,
        source: SOURCE,
        source_url: SOURCE_URL,
        fetched_at: null,
        stale: false,
        tier: null,
        intelligence_index_version: null,
        models: null,
        absent: err?.message || String(err),
      }
    }
  }

  function setApiKey(value) {
    if (typeof value !== 'string' || value.trim().length < 8 || value.trim().length > 512) throw new Error('api_key must be between 8 and 512 characters')
    currentApiKey = value.trim()
    cache = null
    return { configured:true }
  }

  function clearApiKey() {
    currentApiKey = ''
    cache = null
    return { configured:false }
  }

  return { get, setApiKey, clearApiKey }
}
