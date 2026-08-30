import test from 'node:test'
import assert from 'node:assert/strict'
import { directoryVariantLabel, groupDirectoryModels, selectedDirectoryVariant } from '../visualizer/web/src/lib/model-directory.js'

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
