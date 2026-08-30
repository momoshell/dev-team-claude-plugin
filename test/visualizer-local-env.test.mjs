import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from './helpers.mjs'
import { saveArtificialAnalysisKey } from '../visualizer/server/local-env.mjs'

test('saving the catalog key preserves unrelated env values and removes duplicate assignments', () => {
  const dir = scratchDir('visualizer-local-env-')
  const path = join(dir, '.env.local')
  try {
    writeFileSync(path, '# local settings\nOTHER=value\nARTIFICIAL_ANALYSIS_API_KEY="old-value"\nexport ARTIFICIAL_ANALYSIS_API_KEY=duplicate\n')
    assert.deepEqual(saveArtificialAnalysisKey(path, 'new-secret-value'), { saved:true, variable:'ARTIFICIAL_ANALYSIS_API_KEY' })
    const source = readFileSync(path, 'utf8')
    assert.match(source, /^# local settings\nOTHER=value\nARTIFICIAL_ANALYSIS_API_KEY="new-secret-value"\n$/)
    assert.equal((statSync(path).mode & 0o777), 0o600)
  } finally { rmSync(dir, { recursive:true, force:true }) }
})

test('catalog keys with line breaks are refused before touching the env file', () => {
  const dir = scratchDir('visualizer-local-env-refusal-')
  const path = join(dir, '.env.local')
  try {
    assert.throws(() => saveArtificialAnalysisKey(path, 'secret-value\nINJECTED=yes'), /single line/)
    assert.throws(() => readFileSync(path, 'utf8'), { code:'ENOENT' })
  } finally { rmSync(dir, { recursive:true, force:true }) }
})
