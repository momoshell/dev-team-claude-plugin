import test from 'node:test'
import assert from 'node:assert/strict'
import { artificialAnalysisVariant, createArtificialAnalysisCatalog, shapeArtificialAnalysisModel } from '../visualizer/server/model-catalog.mjs'

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

test('Artificial Analysis rows preserve missing measurements as null', () => {
  const shaped = shapeArtificialAnalysisModel({
    id: 'aa-1', name: 'Example 27B', slug: 'example-27b', release_date: null,
    model_creator: { id: 'creator-1', name: 'Example AI' },
    evaluations: { artificial_analysis_intelligence_index: 42, artificial_analysis_coding_index: null },
    pricing: { price_1m_input_tokens: 0, price_1m_output_tokens: 0.2 },
    performance: { median_output_tokens_per_second: null },
  })
  assert.deepEqual({
    creator: shaped.creator, provider: shaped.provider_hint, intelligence: shaped.intelligence,
    coding: shaped.coding, input: shaped.price_input, output: shaped.price_output, speed: shaped.output_tokens_per_second,
  }, { creator: 'Example AI', provider: 'example-ai', intelligence: 42, coding: null, input: 0, output: 0.2, speed: null })
})

test('Artificial Analysis reasoning variants preserve one model family and a separate effort', () => {
  assert.deepEqual(artificialAnalysisVariant('Grok 4.6 (xhigh)'), {
    family_name:'Grok 4.6', family_slug:'grok-4-6', reasoning_effort:'xhigh', reasoning_mode:null,
  })
  assert.deepEqual(artificialAnalysisVariant('Claude Opus 5 (Adaptive Reasoning, Medium Effort)'), {
    family_name:'Claude Opus 5', family_slug:'claude-opus-5', reasoning_effort:'medium', reasoning_mode:'adaptive',
  })
  assert.deepEqual(artificialAnalysisVariant("Claude 3.5 Sonnet (Oct '24)"), {
    family_name:"Claude 3.5 Sonnet (Oct '24)", family_slug:'claude-3-5-sonnet-oct-24', reasoning_effort:null, reasoning_mode:null,
  })
})

test('an unconfigured catalog explains how to connect without making a request', async () => {
  let calls = 0
  const catalog = createArtificialAnalysisCatalog({ fetchImpl: async () => { calls += 1 } })
  const result = await catalog.get()
  assert.equal(result.configured, false)
  assert.equal(result.credential_source, null)
  assert.equal(result.models, null)
  assert.match(result.absent, /Add an Artificial Analysis API key/)
  assert.equal(calls, 0)
})

test('a session key can connect and disconnect without ever being returned', async () => {
  const seen = []
  const catalog = createArtificialAnalysisCatalog({ fetchImpl:async (_url, options) => {
    seen.push(options.headers['x-api-key'])
    return response({ tier:'free', intelligence_index_version:4.1, pagination:{ has_more:false }, data:[] })
  } })
  assert.deepEqual(catalog.setApiKey('session-secret'), { configured:true, credential_source:'session' })
  const connected = await catalog.get()
  assert.equal(connected.configured, true)
  assert.equal(connected.credential_source, 'session')
  assert.equal(Object.hasOwn(connected, 'api_key'), false)
  assert.deepEqual(seen, ['session-secret'])
  assert.deepEqual(catalog.clearApiKey(), { configured:false, credential_source:null })
  assert.equal((await catalog.get()).configured, false)
})

test('clearing a temporary override restores the environment key', async () => {
  const seen = []
  const catalog = createArtificialAnalysisCatalog({ apiKey:'environment-secret', fetchImpl:async (_url, options) => {
    seen.push(options.headers['x-api-key'])
    return response({ tier:'free', intelligence_index_version:4.1, pagination:{ has_more:false }, data:[] })
  } })
  assert.equal((await catalog.get()).credential_source, 'environment')
  catalog.setApiKey('temporary-secret')
  assert.equal((await catalog.get()).credential_source, 'session')
  assert.deepEqual(catalog.clearApiKey(), { configured:true, credential_source:'environment' })
  assert.equal((await catalog.get()).credential_source, 'environment')
  assert.deepEqual(seen, ['environment-secret', 'temporary-secret', 'environment-secret'])
})

test('a persisted key becomes the environment baseline immediately', async () => {
  const catalog = createArtificialAnalysisCatalog({ fetchImpl:async () => response({ tier:'free', intelligence_index_version:4.1, pagination:{ has_more:false }, data:[] }) })
  assert.deepEqual(catalog.setPersistentApiKey('saved-secret'), { configured:true, credential_source:'environment' })
  assert.equal((await catalog.get()).credential_source, 'environment')
  catalog.setApiKey('temporary-secret')
  catalog.clearApiKey()
  assert.equal((await catalog.get()).credential_source, 'environment')
})

test('the catalog drains pagination and caches a shaped attributed response', async () => {
  const calls = []
  let clock = Date.parse('2026-08-30T10:00:00.000Z')
  const pages = [
    { tier: 'free', intelligence_index_version: 4.1, pagination: { has_more: true }, data: [{ id:'1', name:'Grok Example', slug:'grok-example', model_creator:{ id:'x', name:'xAI' }, evaluations:{ artificial_analysis_intelligence_index:60 }, pricing:{ price_1m_output_tokens:3 }, performance:{} }] },
    { tier: 'free', intelligence_index_version: 4.1, pagination: { has_more: false }, data: [{ id:'2', name:'Kimi Example', slug:'kimi-example', model_creator:{ id:'k', name:'Kimi' }, evaluations:{ artificial_analysis_coding_index:55 }, pricing:{ price_1m_input_tokens:1 }, performance:{ median_output_tokens_per_second:80 } }] },
  ]
  const catalog = createArtificialAnalysisCatalog({ apiKey:'secret', now:() => clock, fetchImpl:async (url, options) => {
    calls.push({ url, key:options.headers['x-api-key'] })
    return response(pages[calls.length - 1])
  } })
  const first = await catalog.get()
  const second = await catalog.get()
  assert.equal(first.models.length, 2)
  assert.equal(first.source, 'Artificial Analysis')
  assert.equal(first.intelligence_index_version, 4.1)
  assert.equal(first.models[0].provider_hint, 'xai')
  assert.equal(first.models[1].coding, 55)
  assert.equal(second, first)
  assert.equal(calls.length, 2)
  assert.ok(calls.every((call) => call.key === 'secret'))
  assert.match(calls[0].url, /page=1/)
  assert.match(calls[1].url, /page=2/)
  clock += 1_000
})

test('a failed refresh returns an honest absence without exposing the key', async () => {
  const catalog = createArtificialAnalysisCatalog({ apiKey:'top-secret', fetchImpl:async () => response({ error:'invalid' }, 401) })
  const result = await catalog.get()
  assert.equal(result.configured, true)
  assert.equal(result.models, null)
  assert.match(result.absent, /rejected the configured API key/)
  assert.doesNotMatch(result.absent, /top-secret/)
})
