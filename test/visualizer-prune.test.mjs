import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { startServer, ROUTE_PARAMS } from '../visualizer/server/server.mjs'
import { createJournalSource } from '../visualizer/server/journal-source.mjs'
import { createLeanSource } from '../visualizer/server/lean-source.mjs'

// MUTATION: DV1 replace the App import in main.js with const App = null.
test('every web module is statically reachable from main', () => {
  const root = fileURLToPath(new URL('../visualizer/web/src/', import.meta.url))
  function walk(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = join(dir, entry.name)
      return entry.isDirectory() ? walk(path) : [path]
    })
  }
  const files = walk(root)
  const modules = files.filter(path => /\.(?:js|svelte)$/.test(path))
  const seen = new Set(), todo = [join(root, 'main.js')]
  while (todo.length) {
    const file = todo.pop()
    if (seen.has(file)) continue
    seen.add(file)
    if (!/\.(?:js|mjs|svelte)$/.test(file)) continue
    let source = readFileSync(file, 'utf8')
    if (file.endsWith('.svelte')) source = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n')
    // Static declarations only; imports in comments and dynamic import() are not graph edges.
    source = source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '')
    const declarations = /(?:^|[;\n])\s*(?:import\s*(?:[^'";]*?\s+from\s*)?|export\s+(?:\{[^}]*\}|\*)\s+from\s*)['"]([^'"]+)['"]/gm
    for (const match of source.matchAll(declarations)) {
      const spec = match[1]
      if (!spec.startsWith('.')) continue
      const base = resolve(dirname(file), spec)
      const choices = extname(base) ? [base] : [base, `${base}.js`, `${base}.svelte`, `${base}.mjs`, join(base, 'index.js')]
      const target = choices.find(path => files.includes(path))
      assert.ok(target, `missing static import ${relative(root, file)} -> ${spec}`)
      todo.push(target)
    }
  }
  assert.deepEqual(modules.filter(file => !seen.has(file)).map(file => relative(root, file)).sort(), [])
})

// MUTATION: DV2 inject an old-ledger read helper after the server schema constant.
test('journal refuses a legacy directory and reads a lean journal with diagnostics', () => {
  const serverDir = new URL('../visualizer/server/', import.meta.url)
  function scan(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) scan(path)
      else if (/\.(?:js|mjs)$/.test(entry.name)) {
        const source = readFileSync(path, 'utf8')
        assert.doesNotMatch(source, /ledger[\\/]run\.json|['"`]ledger['"`][\s\S]{0,100}?['"`]run\.json['"`]/, path)
      }
    }
  }
  scan(fileURLToPath(serverDir))
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

// MUTATION: DV3 retarget the health handler to /api/returns.
test('removed returns route stays absent while health remains available', async () => {
  assert.equal(Object.hasOwn(ROUTE_PARAMS, '/api/returns'), false)
  const root = mkdtempSync(join(tmpdir(), 'viz-no-returns-'))
  const { server } = startServer({ port: 0, host: '127.0.0.1', crewRoot: root, env: {} })
  try {
    await once(server, 'listening')
    const base = `http://127.0.0.1:${server.address().port}`
    for (const path of ['/api/returns', '/api/returns?repo_slug=repo&task_slug=task&adw_id=old']) {
      const response = await fetch(base + path)
      assert.equal(response.status, 404)
      await response.text()
    }
    const post = await fetch(base + '/api/returns', { method: 'POST' })
    assert.equal(post.status, 405)
    assert.equal(post.headers.get('allow'), 'GET')
    await post.text()
    const health = await fetch(base + '/api/health')
    assert.equal(health.status, 200)
    assert.equal(Object.hasOwn(await health.json(), 'returns_readonly'), false)
  } finally {
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
})
