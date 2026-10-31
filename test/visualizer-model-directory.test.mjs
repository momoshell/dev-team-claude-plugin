import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeModelDirectory } from '../visualizer/server/model-directory.mjs'

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
