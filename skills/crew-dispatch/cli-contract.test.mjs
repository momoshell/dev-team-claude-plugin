import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BOOT_ONLY_FLAGS,
  KNOWN_FLAGS,
  ROLE_FLAG_PREFIXES,
} from '../../crew/crew.mjs'
import { VARIANT_NAMES, VARIANTS } from '../../crew/variants.mjs'
import { ROOT } from '../../test/helpers.mjs'

const HERE = fileURLToPath(new URL('./', import.meta.url))
const FLAGS = join(HERE, 'references/flags.md')
const VARIANTS_DOC = join(HERE, 'references/variants.md')
const TIER = join(HERE, 'references/tier.md')
const SEAT_IO = join(ROOT, 'crew/seat-io.mjs')

function readText(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    assert.fail(`${path} could not be read (${error?.code ?? 'unknown'}): ${error?.message ?? error}`)
  }
  assert.ok(text.length > 0, `${path} is empty`)
  return text
}

function firstJsonBlock(path) {
  const text = readText(path)
  const match = text.match(/```json\n([\s\S]*?)```/)
  assert.ok(match, `${path} has no fenced json block`)
  try {
    return JSON.parse(match[1])
  } catch (error) {
    assert.fail(`${path} has an interrupted or invalid JSON block: ${error.message}`)
  }
}

// The literal block is the expected contract; runtime arrays are only the
// allow-list against which each declared doc entry is checked.
test('documented flags are accepted by their named verbs', () => {
  const block = firstJsonBlock(FLAGS)
  for (const verb of ['boot', 'run']) {
    assert.ok(Array.isArray(block[verb]) && block[verb].length > 0)
    for (const flag of block[verb]) {
      const known = KNOWN_FLAGS[verb].includes(flag)
      const roleOverride = verb === 'boot'
        && ROLE_FLAG_PREFIXES.some((prefix) => flag.startsWith(prefix) && flag.length > prefix.length)
      assert.ok(known || roleOverride, `${verb} does not accept --${flag}`)
    }
  }
})

test('documented boot-only flags equal the runtime contract', () => {
  const block = firstJsonBlock(FLAGS)
  assert.deepEqual(block.boot_only, [...BOOT_ONLY_FLAGS])
})

test('documented variant keys and context equal the runtime contract', () => {
  const block = firstJsonBlock(VARIANTS_DOC)
  assert.deepEqual(Object.keys(block).sort(), [...VARIANT_NAMES].sort())
  for (const name of VARIANT_NAMES) {
    const needsLane = VARIANTS[name]?.sources?.lane === 'ctx'
    const expected = needsLane ? ['--validation-lane'] : []
    assert.deepEqual(block[name]?.ctx, expected, `${name} ctx must match sources.lane`)
  }
})

test('the pane-reseat refusal remains quoted in the tier reference', () => {
  const sentence = 'a pane seat bakes model and effort into its launch command at boot (crew/crew.mjs:265); its reassign: true capability means give a settled seat NEW WORK, never change its cell'
  assert.ok(readText(TIER).includes(sentence))
  assert.ok(readText(SEAT_IO).includes(sentence))
})
