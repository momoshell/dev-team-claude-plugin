import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { createAgentsSource } from '../visualizer/server/agents-source.mjs'

const cwd = process.cwd()
const retired = 'roles'
const read = (path) => readFileSync(join(cwd, path), 'utf8')

// MUTATION: invert the absence assertion.
test('DR1: retired directory is absent', () => {
  const retiredDirectory = join(cwd, 'crew', retired)
  assert.equal(existsSync(retiredDirectory), false, 'DR1: retired directory must be absent')
})

// MUTATION: replace the vitest operator introduction with the automatic-delivery claim.
test('DR2: guidelines are live or operator references', () => {
  const directory = 'crew/guidelines'
  const markdowns = (dir) => readdirSync(join(cwd, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`
    return entry.isDirectory() ? markdowns(path) : entry.isFile() && entry.name.endsWith('.md') ? [path] : []
  })
  const docs = markdowns(directory)
  const live = `${directory}/review-do-not-flag.md`
  const reference = `${directory}/vitest-gates.md`
  assert.ok(docs.includes(live))
  assert.ok(docs.includes(reference))
  assert.ok(!docs.includes(`${directory}/seat-pre-return-checklist.md`))
  for (const path of docs.filter((path) => path !== live)) assert.match(read(path), /\boperator reference\b/i, path)
  assert.ok(existsSync(join(cwd, directory, 'gate-kit.mjs')))
  assert.ok(!read(reference).includes('The planner receives this document as an absolute plugin path.'))
  const loader = spawnSync(process.execPath, [join(cwd, '.agents/skills/review-procedure/scripts/load-guidelines.mjs')], { cwd, encoding: 'utf8' })
  assert.equal(loader.status, 0, loader.stderr)
  assert.equal(loader.stdout, read(live))
})

// MUTATION: redirect the visualizer prompt reader to the retired directory.
test('DR3: no live retired paths and visualizer reads delivered definitions', () => {
  const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
  const options = { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  let files = spawnSync('git', args, options)
  if (files.status !== 0 && /not a git repository/i.test(files.stderr)) {
    // Snapshot checkouts may omit Git metadata; retain Git's ignore semantics.
    const gitDir = mkdtempSync(join(tmpdir(), 'crew-prose-git-'))
    try {
      const init = spawnSync('git', ['init', '--bare', '-q', gitDir], options)
      assert.equal(init.status, 0, init.stderr)
      files = spawnSync('git', [`--git-dir=${gitDir}`, `--work-tree=${cwd}`, ...args], options)
    } finally { rmSync(gitDir, { recursive: true, force: true }) }
  }
  assert.equal(files.status, 0, files.stderr)
  const history = /^(?:docs\/adr|docs\/archive|docs\/audits|bench\/corpus)\//
  const prefix = `crew/${retired}/`
  const relative = new RegExp(`(?:\\.\\.?/)+${retired}/`)
  const components = new RegExp(`(['"\x60])crew\\1\\s*,\\s*(['"\x60])${retired}\\2`)
  const shorthand = new RegExp(`\\b${retired}/(?:\\*|[\\w-]+\\.md)`)
  const offenders = []
  for (const path of new Set(files.stdout.split('\0').filter(Boolean))) {
    if (history.test(path)) continue
    let bytes
    try {
      if (!lstatSync(join(cwd, path)).isFile()) continue
      bytes = readFileSync(join(cwd, path))
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (bytes.includes(0)) continue
    const text = bytes.toString('utf8').replace(/\\+\//g, '/')
    if (text.includes(prefix) || relative.test(text) || components.test(text) ||
        (path.startsWith('crew/') && path.endsWith('.md') && shorthand.test(text))) offenders.push(path)
  }
  assert.deepEqual(offenders, [])
  const view = createAgentsSource({ checkout: cwd, pluginRoot: cwd, crewRoot: join(cwd, '__no_recorded_delivery__') }).read()
  assert.deepEqual(view.prompts.map((row) => row.role), ['lead', 'planner', 'builder', 'reviewer', 'tech-lead'])
  for (const row of view.prompts) {
    assert.equal(row.path, `crew/agents/${row.role}.md`)
    assert.equal(row.text, read(row.path))
  }
})
