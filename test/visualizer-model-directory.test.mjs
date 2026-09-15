import test from 'node:test'
import assert from 'node:assert/strict'
import { directoryModelMatchesChip, directoryVariantLabel, groupDirectoryModels, mergeModelDirectory, selectedDirectoryVariant } from '../visualizer/web/src/lib/model-directory.js'

function grok(source_id, reasoning_effort, intelligence, slug) {
  return {
    source_id, name:`Grok 4.6 (${reasoning_effort})`, family_name:'Grok 4.6', family_slug:'grok-4-6',
    creator:'SpaceXAI', creator_id:'spacexai', provider_hint:'spacexai', slug,
    reasoning_effort, reasoning_mode:null, intelligence,
  }
}

test('catalog effort measurements collapse into one selectable model family', () => {
  const rows = [
    grok('low', 'low', 51.7, 'grok-4-6-low'),
    grok('medium', 'medium', 59, 'grok-4-6-medium'),
    grok('high', 'high', 60.9, 'grok-4-6'),
    grok('xhigh', 'xhigh', 60, 'grok-4-6-xhigh'),
  ]
  const grouped = groupDirectoryModels(rows)
  assert.equal(grouped.length, 1)
  assert.equal(grouped[0].name, 'Grok 4.6')
  assert.equal(grouped[0].variant_count, 4)
  assert.equal(grouped[0].primary_source_id, 'high')
  assert.deepEqual(grouped[0].variants.map((variant) => variant.reasoning_effort), ['low', 'medium', 'high', 'xhigh'])
  assert.equal(selectedDirectoryVariant(grouped[0], {}).source_id, 'high')
  assert.equal(selectedDirectoryVariant(grouped[0], { [grouped[0].family_key]:'medium' }).source_id, 'medium')
  assert.equal(directoryVariantLabel(rows[3]), 'Extra high')
})

test('different model families from one creator remain separate rows', () => {
  const grouped = groupDirectoryModels([
    grok('g46', 'high', 60, 'grok-4-6'),
    { ...grok('g45', 'high', 55, 'grok-4-5'), name:'Grok 4.5 (high)', family_name:'Grok 4.5', family_slug:'grok-4-5' },
  ])
  assert.deepEqual(grouped.map((family) => family.name), ['Grok 4.6', 'Grok 4.5'])
})

function openRouterRow(runtime_id, name, price_input, price_output) {
  const slug = runtime_id.split('/').slice(1).join('/')
  return {
    source_id:runtime_id, runtime_id, name, slug, family_name:name, family_slug:slug,
    creator:'Meta', creator_id:'meta', provider_hint:'meta', provider:'meta',
    price_input, price_output, context_length:131072, context_window_tokens:131072,
    intelligence:null, coding:null, agentic:null, reasoning_effort:null, reasoning_mode:null,
  }
}

function mergedMuse() {
  return mergeModelDirectory({
    openRouter: {
      source:'OpenRouter', source_url:'https://openrouter.ai/api/v1/models', absent:null,
      models: [
        openRouterRow('meta/muse-spark-1.3', 'Muse Spark 1.3', 0.5, 1.2),
        openRouterRow('meta/muse-spark-1.3-contributor', 'Muse Spark 1.3 Contributor', 0.1, 0.2),
        openRouterRow('meta/unmatched-model', 'Unmatched Model', 0.3, 0.4),
      ],
    },
    artificialAnalysis: {
      configured:true, source:'Artificial Analysis', absent:null,
      models: [
        { source_id:'aa-muse-max', name:'Muse Spark 1.3 (max)', slug:'muse-spark-1-3-max', family_name:'Muse Spark 1.3', family_slug:'muse-spark-1-3', creator:'Meta', creator_id:'meta-aa', provider_hint:'meta', intelligence:88, coding:77, agentic:66, reasoning_effort:'max', reasoning_mode:null, benchmark_cost_per_task:0.2, output_tokens_per_second:90, time_to_first_token_seconds:1.2, price_input:9, price_output:10, context_window_tokens:999 },
        { source_id:'aa-orphan', name:'Orphan Benchmark', slug:'orphan-benchmark', family_name:'Orphan Benchmark', family_slug:'orphan-benchmark', creator:'Meta', creator_id:'meta-aa', provider_hint:'meta', intelligence:42, coding:null, agentic:null, reasoning_effort:null, reasoning_mode:null },
      ],
    },
  })
}

test('A1 OpenRouter tier suffix joins base scores and keeps tier pricing', () => {
  const merged = mergedMuse()
  const rows = merged.models.filter((model) => model.runtime_id?.startsWith('meta/muse-spark'))
  assert.equal(rows.length, 2)
  assert.equal(rows.find((model) => model.runtime_id.endsWith('-contributor')).intelligence, 88)
  assert.equal(rows.find((model) => model.runtime_id.endsWith('-contributor')).price_input, 0.1)
  assert.equal(rows.find((model) => model.runtime_id.endsWith('-contributor')).price_output, 0.2)
  assert.equal(rows.find((model) => model.runtime_id.endsWith('-contributor')).runtime_id, 'meta/muse-spark-1.3-contributor')
  assert.equal(rows.every((model) => model.score_absent_reason === null), true)
  const orphan = merged.models.find((model) => model.source_id === 'aa-orphan')
  assert.equal(orphan.runtime_id, null)
  assert.equal(orphan.score_absent_reason, 'no-runtime-listing')
})

test('tier variants match distinct runtime chips', () => {
  const family = groupDirectoryModels(mergedMuse().models).find((model) => model.family_key === 'meta/muse-spark-1.3')
  const base = family.variants.find((variant) => variant.runtime_id === 'meta/muse-spark-1.3')
  const contributor = family.variants.find((variant) => variant.runtime_id === 'meta/muse-spark-1.3-contributor')
  assert.equal(directoryModelMatchesChip(family, { key:'meta/muse-spark-1.3' }), true)
  assert.equal(directoryModelMatchesChip(family, { key:'meta/muse-spark-1.3-contributor' }), true)
  assert.equal(directoryModelMatchesChip(base, { key:'meta/muse-spark-1.3-contributor' }), false)
  assert.equal(directoryModelMatchesChip(contributor, { key:'meta/muse-spark-1.3' }), false)
})

test('B1 unmatched OpenRouter score stays null with closed reason', () => {
  const merged = mergedMuse()
  const unmatched = merged.models.find((model) => model.runtime_id === 'meta/unmatched-model')
  assert.equal(unmatched.intelligence, null)
  assert.equal(unmatched.coding, null)
  assert.equal(unmatched.score_absent_reason, 'not-benchmarked')
  assert.notEqual(unmatched.intelligence, 0)
})

test('RV2-1 configured AA failure carries an unavailable score reason', () => {
  const absent = 'Artificial Analysis rejected the configured API key'
  const merged = mergeModelDirectory({
    openRouter: { source:'OpenRouter', models:[openRouterRow('meta/muse-spark-1.3', 'Muse Spark 1.3', 0.1, 0.2)], absent:null },
    artificialAnalysis: { configured:true, credential_source:'environment', source:'Artificial Analysis', models:null, absent },
  })
  assert.equal(merged.models[0].intelligence, null)
  assert.equal(merged.models[0].score_absent_reason, 'aa-unavailable')
  assert.equal(merged.artificial_analysis_unavailable, true)
  assert.equal(merged.artificial_analysis_absent, absent)
  assert.equal(merged.absent, absent)
})

test('C1 merged directory reports matched and total', () => {
  const merged = mergedMuse()
  assert.deepEqual(merged.join, { matched:2, total:3 })
  assert.equal(merged.models.filter((model) => model.runtime_id !== null).length, 3)
  assert.equal(merged.models.filter((model) => model.runtime_id === null).length, 1)
})
