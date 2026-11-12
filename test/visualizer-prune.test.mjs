import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJournalSource } from '../visualizer/server/journal-source.mjs'
import { createLeanSource } from '../crew/lean-source.mjs'

function exportAudit(files, entries) {
  const sources = {}, uses = {}, exports = {}, edges = {}, unresolved = new Set(), orphans = []
  for (const [file, text] of Object.entries(files)) {
    let source = file.endsWith('.svelte') ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n') : text
    source = source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '')
    sources[file] = source
    // A Svelte template uses imports outside <script>, so a binding's use is counted over the whole file.
    uses[file] = file.endsWith('.svelte') ? text.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '') : source
    exports[file] = new Set()
    if (/\.(?:js|mjs)$/.test(file)) {
      for (const match of source.matchAll(/^\s*export\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([\w$]+)/gm)) exports[file].add(match[1])
      for (const match of source.matchAll(/^\s*export\s*\{([^}]*)\}(?!\s*from)/gm)) {
        for (const item of match[1].split(',')) exports[file].add(item.trim().split(/\s+as\s+/).at(-1))
      }
    }
    if (file.startsWith('web/src/') && file.endsWith('.js')) {
      for (const match of source.matchAll(/^(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([\w$]+)/gm)) {
        const name = match[1]
        if ([...source.matchAll(new RegExp(`(?<![\\w$])${name}(?![\\w$])`, 'g'))].length === 1) orphans.push(`${file}:${name}`)
      }
    }
  }
  for (const [file, source] of Object.entries(sources)) {
    edges[file] = []
    const declarations = /(?:^|[;\n])\s*(?:import\s*((?:[^'";]*?\s+from\s*)?)|export\s+((?:\{[^}]*\}|\*)\s+from\s*))['"]([^'"]+)['"]/gm
    for (const match of source.matchAll(declarations)) {
      const spec = match[3], clause = match[1] ?? match[2] ?? ''
      if (!spec.startsWith('.') || spec.endsWith('.css')) continue
      const base = posix.normalize(posix.join(posix.dirname(file), spec))
      if (!base.startsWith('web/src/') && !base.startsWith('server/')) continue
      const target = ['', '.js', '.svelte', '.mjs'].map(ext => base + ext).find(path => Object.hasOwn(files, path))
      if (!target) { unresolved.add(`${file} -> ${spec}`); continue }
      const bindings = (clause.match(/\{([^}]*)\}/)?.[1] ?? '').split(',').map(item => item.trim()).filter(Boolean).map(item => {
        const [name, local = name] = item.split(/\s+as\s+/)
        return { name, local }
      })
      const names = bindings.map(binding => binding.name)
      const all = /\*\s+as\s+\w+/.test(clause)
      for (const name of names) if (!exports[target].has(name)) unresolved.add(`${file}:${name}`)
      edges[file].push({ target, names, bindings, all })
    }
  }
  const seen = new Set(), todo = [...entries]
  while (todo.length) {
    const file = todo.pop()
    if (seen.has(file)) continue
    seen.add(file)
    for (const edge of edges[file] ?? []) todo.push(edge.target)
  }
  const called = new Set()
  for (const file of seen) for (const edge of edges[file] ?? []) {
    if (file === edge.target) continue
    if (edge.all) { for (const name of exports[edge.target]) called.add(`${edge.target}:${name}`); continue }
    // An import is a call only when the importing file uses the binding beyond the import itself.
    for (const { name, local } of edge.bindings) {
      if ([...uses[file].matchAll(new RegExp(`(?<![\\w$])${local.replaceAll('$', '\\$')}(?![\\w$])`, 'g'))].length > 1) called.add(`${edge.target}:${name}`)
    }
  }
  const web = Object.keys(files).filter(file => file.startsWith('web/src/') && /\.(?:js|svelte)$/.test(file))
  const unreachable = web.filter(file => !seen.has(file)).sort()
  const uncalled = web.filter(file => file.endsWith('.js')).flatMap(file => [...exports[file]].map(name => `${file}:${name}`)).filter(name => !called.has(name)).sort()
  return { unreachable, uncalled, unresolved: [...unresolved].sort(), orphans: orphans.sort() }
}

// MUTATION: add export const UNUSED_PROBE = 1 to visualizer/web/src/lib/route.js.
// MUTATION: seed the walk from every module instead of entries.
// MUTATION: count references inside the exporting module as callers.
// MUTATION: count an imported binding as a call without a use beyond the import.
test('every web export has a production caller', () => {
  const entries = ['web/src/main.js', 'server/server.mjs']
  const fixture = {
    'web/src/main.js': "import { used, idle as quiet } from './lib/a.js'\nused()",
    'web/src/lib/a.js': 'function helper() {}\nexport function used() { helper(); selfOnly() }\nexport function selfOnly() {}\nexport function idle() {}\nexport const onlyByD = 1',
    'web/src/lib/b.js': "import { fromC } from './c.js'\nexport const fromB = fromC",
    'web/src/lib/c.js': "import { fromB } from './b.js'\nexport const fromC = fromB",
    'web/src/lib/d.js': "import { onlyByD, missing } from './a.js'\nimport './gone.js'\nconst lonely = 1\nexport const fromD = onlyByD",
    'web/src/lib/e.js': 'export const shared = 1',
    'server/server.mjs': "import { shared } from '../web/src/lib/e.js'\nconsole.log(shared)",
  }
  assert.deepEqual(exportAudit(fixture, entries), {
    unreachable: ['web/src/lib/b.js', 'web/src/lib/c.js', 'web/src/lib/d.js'],
    uncalled: ['web/src/lib/a.js:idle', 'web/src/lib/a.js:onlyByD', 'web/src/lib/a.js:selfOnly', 'web/src/lib/b.js:fromB', 'web/src/lib/c.js:fromC', 'web/src/lib/d.js:fromD'],
    unresolved: ['web/src/lib/d.js -> ./gone.js', 'web/src/lib/d.js:missing'],
    orphans: ['web/src/lib/d.js:lonely'],
  })
  const root = fileURLToPath(new URL('../visualizer/', import.meta.url))
  function walk(dir) {
    return readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry => {
      const path = posix.join(dir, entry.name)
      return entry.isDirectory() ? walk(path) : [path]
    })
  }
  const paths = [...walk('web/src').filter(path => /\.(?:js|svelte)$/.test(path)), ...readdirSync(join(root, 'server')).filter(path => path.endsWith('.mjs')).map(path => `server/${path}`)]
  const files = Object.fromEntries(paths.map(path => [path, readFileSync(join(root, path), 'utf8')]))
  assert.deepEqual(exportAudit(files, entries), { unreachable: [], uncalled: [], unresolved: [], orphans: [] })
})

// MUTATION: DV2 inject an old-ledger read helper after the server schema constant.
test('journal refuses a legacy directory and reads a lean journal with diagnostics', () => {
  const serverDir = new URL('../visualizer/server/', import.meta.url)
  function scanFile(path) {
    const source = readFileSync(path, 'utf8')
    assert.doesNotMatch(source, /ledger[\\/]run\.json|['"`]ledger['"`][\s\S]{0,100}?['"`]run\.json['"`]/, path)
  }
  function scan(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) scan(path)
      else if (/\.(?:js|mjs)$/.test(entry.name)) scanFile(path)
    }
  }
  scan(fileURLToPath(serverDir))
  for (const file of ['lean-source.mjs', 'lean-journal-order.mjs']) scanFile(fileURLToPath(new URL(`../crew/${file}`, import.meta.url)))
  const root = mkdtempSync(join(tmpdir(), 'viz-journal-prune-'))
  try {
    const legacy = join(root, 'repo', 'task')
    mkdirSync(join(legacy, 'ledger'), { recursive: true })
    writeFileSync(join(legacy, 'ledger', 'run.json'), JSON.stringify({ adw_id: 'old' }))
    writeFileSync(join(legacy, 'journal.jsonl'), '{"event":"old"}\n')
    writeFileSync(join(legacy, 'plan.md'), '# Old plan\n')
    writeFileSync(join(legacy, 'brief.md'), '# Old brief\n')
    const lane = join(root, 'dt-lane', 'lane')
    mkdirSync(join(lane, 'task'), { recursive: true })
    writeFileSync(join(lane, 'crew.json'), JSON.stringify({ members: { builder: { agent: 'pi' } } }))
    writeFileSync(join(lane, 'task', 'lean.json'), JSON.stringify({ id: 'lane', tier: 'build' }))
    writeFileSync(join(lane, 'task', 'journal.jsonl'), '{"event":"run-start"}\ninvalid\n')
    const source = createJournalSource({ crewRoot: root, lean: createLeanSource({ crewRoot: root }) })
    const old = source.readJournal({ repo_slug: 'repo', task_slug: 'task', adw_id: 'old' })
    assert.equal(old.verified, false)
    assert.deepEqual(old.rows, [])
    assert.ok(old.error)
    const current = source.readJournal({ repo_slug: 'dt-lane', task_slug: 'lane', adw_id: 'lean:lane' })
    assert.equal(current.verified, true)
    assert.equal(current.rows[0].event, 'run-start')
    assert.equal(current.skipped_malformed, 1)
    assert.deepEqual(current.skipped_line_numbers, [2])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// MUTATION: restore channels: JOURNAL_CHANNELS in the empty object
test('journal read returns no constant plan, step-title, acceptance or channel fields', async () => {
  const root = mkdtempSync(join(tmpdir(), 'viz-journal-fields-'))
  try {
    const lane = join(root, 'dt-lane', 'lane')
    mkdirSync(join(lane, 'task'), { recursive: true })
    writeFileSync(join(lane, 'crew.json'), JSON.stringify({ members: { builder: { agent: 'pi' } } }))
    writeFileSync(join(lane, 'task', 'lean.json'), JSON.stringify({ id: 'lane', tier: 'build' }))
    writeFileSync(join(lane, 'task', 'journal.jsonl'), '{"event":"run-start"}\n')
    const source = createJournalSource({ crewRoot: root, lean: createLeanSource({ crewRoot: root }) })
    const current = source.readJournal({ repo_slug: 'dt-lane', task_slug: 'lane', adw_id: 'lean:lane' })
    const refused = source.readJournal({ repo_slug: '../invalid', task_slug: 'lane' })
    assert.equal(current.verified, true)
    assert.equal(current.rows[0].event, 'run-start')
    assert.equal(refused.verified, false)
    assert.deepEqual(refused.rows, [])
    for (const result of [current, refused]) {
      for (const key of ['channels', 'plan', 'step_titles', 'step_titles_reason', 'acceptance', 'acceptance_reason']) assert.equal(Object.hasOwn(result, key), false, key)
    }
    const journal = await import('../visualizer/server/journal-source.mjs')
    for (const key of ['STEP_TITLE_REASONS', 'ACCEPTANCE_REASONS']) assert.equal(Object.hasOwn(journal, key), false, key)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
