import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('the layout module imports only builtins, so every extension that loads it stays dependency-free', () => {
  const source = readFileSync(new URL('./context-layout.mjs', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1])
  assert.deepEqual(imports, ['node:path'])
})
