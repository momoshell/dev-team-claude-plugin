import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'

const workflowYml = readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8')
const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const configMd = readFileSync(join(ROOT, '.claude/dev-team/config.md'), 'utf8')

test('CI workflow matrix contains both a "20" and a "24" node-version entry', () => {
  assert.ok(/node-version:\s*\[[^\]]*"20"[^\]]*\]/.test(workflowYml), 'matrix is missing the "20" entry')
  assert.ok(/node-version:\s*\[[^\]]*"24"[^\]]*\]/.test(workflowYml), 'matrix is missing the "24" entry')
})

test('CI workflow declares fail-fast: false', () => {
  assert.ok(/fail-fast:\s*false/.test(workflowYml))
})

test('CI workflow job name is stable per matrix leg', () => {
  const nameLine = workflowYml.split('\n').find((l) => /^\s*name:/.test(l) && l.includes('matrix.node-version'))
  assert.ok(nameLine, 'no name: line found that also references matrix.node-version on the same line')
})

test('CI workflow highest matrix major is >= 24', () => {
  const m = workflowYml.match(/node-version:\s*\[([^\]]*)\]/)
  assert.ok(m, 'matrix node-version list not found — workflow shape changed')
  const majors = [...m[1].matchAll(/"(\d+)"/g)].map((x) => Number(x[1]))
  assert.ok(majors.length > 0, 'no quoted node-version majors found in matrix list')
  assert.ok(Math.max(...majors) >= 24, `highest matrix major ${Math.max(...majors)} is below the required 24 floor`)
})

test('.gitignore contains all four run-trace mirror db artifact patterns', () => {
  const lines = gitignore.split('\n').map((s) => s.trim())
  for (const p of ['*.db', '*.db-wal', '*.db-shm', '*.db-journal']) {
    assert.ok(lines.includes(p), `missing ignore pattern ${p}`)
  }
})

test('package.json exposes the seven read-only ledger recipes pointing at the ledger entry point', () => {
  const names = ['ledger:sessions', 'ledger:phases', 'ledger:tail', 'ledger:procs', 'ledger:gate-review-gap', 'ledger:eligible-tasks', 'ledger:task']
  for (const name of names) {
    assert.ok(name in pkg.scripts, `missing script ${name}`)
    assert.match(pkg.scripts[name], /scripts\/factory\/ledger\.mjs/, `${name} does not invoke the ledger entry point`)
  }
})

test('no npm script name exposes a destructive ledger verb', () => {
  for (const name of Object.keys(pkg.scripts)) {
    assert.doesNotMatch(name, /kill|prune|delete|reset/i, `script name ${name} looks destructive`)
  }
})

test('package.json has no engines field', () => {
  assert.ok(!('engines' in pkg))
})

test('config.md review_defaults section documents scripts/factory/*.mjs', () => {
  const start = configMd.indexOf('## review_defaults')
  assert.ok(start !== -1, 'review_defaults heading not found')
  const rest = configMd.slice(start + '## review_defaults'.length)
  const nextHeadingIdx = rest.indexOf('\n## ')
  const section = nextHeadingIdx === -1 ? rest : rest.slice(0, nextHeadingIdx)
  assert.ok(section.includes('scripts/factory/*.mjs'), 'review_defaults section is missing scripts/factory/*.mjs')
})

test('CI workflow setup-node consumes the matrix variable, not a hardcoded literal', () => {
  assert.ok(
    /^\s*node-version:\s*\$\{\{\s*matrix\.node-version\s*\}\}\s*$/m.test(workflowYml),
    'no node-version: line under with: is wired to ${{ matrix.node-version }}',
  )
  const literalOutsideMatrix = workflowYml
    .split('\n')
    .some((l) => /^\s*node-version:\s*"\d+"\s*$/.test(l))
  assert.ok(!literalOutsideMatrix, 'a node-version: line outside the matrix list still carries a hardcoded literal version')
})

test('CI workflow still runs the test suite via node --test', () => {
  assert.ok(/^\s*-\s*run:\s*node --test\s*$/m.test(workflowYml), 'no run: step invokes node --test')
})
