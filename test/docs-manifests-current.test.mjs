import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROOT as root } from './helpers.mjs'
const read = path => readFileSync(resolve(root, path), 'utf8')
const json = path => JSON.parse(read(path))
const removed = ['@xyflow/svelte', '@dagrejs/dagre', 'codemirror', '@codemirror/lang-json', '@codemirror/lang-markdown']
const sorted = values => [...new Set(values)].sort()
const packageRoot = name => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]

function sources(dir) {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'dist', '.git', '.vite', 'coverage', 'test', 'tests', '__tests__'].includes(entry.name)) return []
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) return sources(path)
    return entry.isFile() && /\.(mjs|cjs|js|jsx|ts|tsx|svelte|css)$/.test(entry.name) && !/\.(test|spec)\.[^.]+$/.test(entry.name) ? [path] : []
  })
}
function imports() {
  const result = new Set()
  for (const file of sources('visualizer')) {
    for (const pattern of [/(?:^|[\n;])\s*(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"\n]+)['"]/g, /(?:\bimport|\brequire)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, /@import\s+(?:url\(\s*)?['"]([^'"\n]+)['"]/g]) {
      for (const [, specifier] of read(file).matchAll(pattern)) {
        if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':')) result.add(packageRoot(specifier))
      }
    }
  }
  return result
}
function index() {
  const section = read('docs/adr/README.md').split('## Index\n')[1].split('\n## ')[0]
  return new Map([...section.matchAll(/^\| (\d{3}) \|.*? \| (.*?) \| .*? \|$/gm)].map(([, id, status]) => [id, status]))
}
const plain = value => value.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trim().toLowerCase()
const target = value => plain(value).match(/\bby\s+(adr-\d{3})\b/)?.[1]

// MUTATION: DM1 inserts daemon into the plugin description.
test('DM1: manifests describe the same lean runtime', () => {
  const plugin = json('.claude-plugin/plugin.json')
  const market = json('.claude-plugin/marketplace.json')
  assert.equal(market.plugins.find(item => item.name === plugin.name).description, plugin.description)
  for (const manifest of [plugin, market]) {
    const visit = value => {
      if (!value || typeof value !== 'object') return
      for (const [key, child] of Object.entries(value)) {
        if (key === 'description') assert.doesNotMatch(child, /cmux|daemon|factoryctl/i)
        else visit(child)
      }
    }
    visit(manifest)
  }
})

// MUTATION: DM2 adds an unused devDependency.
test('DM2: visualizer dependencies are used and the lock is pruned', () => {
  const deps = json('package.json').devDependencies
  const lock = json('package-lock.json').packages
  const used = imports()
  assert.deepEqual(Object.keys(deps).filter(name => !used.has(name)), [])
  assert.deepEqual(lock[''].devDependencies, deps)
  for (const name of removed) {
    assert.ok(!Object.hasOwn(deps, name), name)
    assert.ok(!Object.hasOwn(lock, `node_modules/${name}`), name)
  }
  // Traverse npm's nested resolution paths, including optional dependencies.
  const seen = new Set([''])
  const queue = ['']
  while (queue.length) {
    const path = queue.shift()
    const entry = lock[path]
    for (const name of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies, ...(path === '' ? entry.devDependencies : {}) })) {
      let base = path
      let found
      for (;;) {
        const candidate = `${base ? `${base}/` : ''}node_modules/${name}`
        if (lock[candidate]) { found = candidate; break }
        if (!base) break
        const pos = base.lastIndexOf('node_modules/')
        base = pos > 0 ? base.slice(0, pos - 1) : ''
      }
      assert.ok(found, `${path} cannot resolve ${name}`)
      if (!seen.has(found)) { seen.add(found); queue.push(found) }
    }
  }
  assert.deepEqual(Object.keys(lock).filter(path => !seen.has(path)), [])
})

// MUTATION: DM3 replaces the documented icon package with an undeclared one.
test('DM3: documented visualizer packages are declared', () => {
  const doc = read('CLAUDE.md')
  const paragraph = doc.split('**The runtime ships zero dependencies;')[1].split('\n## ')[0]
  const ignored = new Set(['dependencies', 'devDependencies', 'jq', 'node_modules'])
  const names = [...paragraph.matchAll(/`([^`\n]+)`/g)].map(match => match[1]).filter(name => /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(name) && !ignored.has(name) && !/\.(json|mjs|js|md|svelte)$/i.test(name))
  names.push(...[...doc.matchAll(/@[a-z0-9._-]+\/[a-z0-9._-]+/gi)].map(match => match[0]))
  if (/\bcodemirror\b/i.test(doc)) names.push('codemirror')
  assert.ok(names.length)
  assert.deepEqual(sorted(names).filter(name => !Object.hasOwn(json('package.json').devDependencies, name)), [])
})

// MUTATION: DM4 marks ADR-029 ratified in the index.
test('DM4: every superseded ADR agrees with the index', () => {
  const rows = index()
  const statuses = new Map()
  for (const file of readdirSync(resolve(root, 'docs/adr'))) {
    const id = file.match(/^adr-(\d{3})-.*\.md$/)?.[1]
    if (!id) continue
    const status = read(`docs/adr/${file}`).match(/^\*\*Status:\*\*\s*(.+)$/m)?.[1]
    assert.ok(status, file)
    statuses.set(id, status)
    if (/\bsuperseded\b/i.test(status)) {
      assert.match(plain(rows.get(id) ?? ''), /^superseded\b/, id)
      if (target(status)) assert.equal(target(rows.get(id)), target(status), id)
    }
  }
  for (const id of ['029', '035', '040', '042', '044', '046']) assert.match(plain(statuses.get(id)), /^superseded\b/)
})

// MUTATION: DM5 reverts ADR-041 to proposed.
test('DM5: ADR-041 is withdrawn by ADR-043 in both places', () => {
  const status = read('docs/adr/adr-041-claims-at-plan-accept.md').match(/^\*\*Status:\*\*\s*(.+)$/m)[1]
  for (const value of [status, index().get('041')]) {
    assert.match(plain(value), /^withdrawn\b/)
    assert.equal(target(value), 'adr-043')
  }
})

// MUTATION: DM6 replaces the real loop citation with a deleted file.
test('DM6: register introduction cites existing files', () => {
  const intro = read('docs/adr/README.md').split('\n## Where a record lives')[0]
  const refs = [...intro.matchAll(/`([^`\n]+\.(?:mjs|cjs|js|ts|json|md|svelte))`/g)].map(match => match[1])
  for (const [, ref] of intro.matchAll(/\[[^\]]*\]\(([^)#]+)(?:#[^)]*)?\)/g)) if (!/^(?:[a-z]+:|#)/i.test(ref)) refs.push(ref.startsWith('.') ? `docs/adr/${ref}` : ref)
  assert.ok(refs.length)
  for (const ref of refs) assert.ok(existsSync(resolve(root, ref)), ref)
})

// MUTATION: DM7 changes the propose route in the README.
test('DM7: README routes exactly match the server registry', () => {
  const block = read('visualizer/server/server.mjs').match(/export const ROUTE_PARAMS = Object\.freeze\(\{([\s\S]*?)\n\}\)/)[1]
  const registered = [...block.matchAll(/^\s*['"](\/api\/[^'"\n]+)['"]\s*:/gm)].map(match => match[1])
  const doc = read('visualizer/README.md')
  const documented = [...doc.matchAll(/`(\/api\/[^`\s]+)`/g)].map(match => match[1])
  assert.ok(registered.length)
  assert.deepEqual(sorted(documented), sorted(registered))
  assert.equal(documented.filter(route => route === '/api/prompts/propose').length, 1)
})

test('ancillary prose describes the current runtime and marks history', () => {
  const conventions = read('docs/conventions.md')
  assert.match(conventions, /2026-08-02 \(a literal NUL/)
  for (const name of removed) assert.ok(conventions.includes(`\`${name}\``))
  assert.match(conventions, /operator approved removing these unused dependencies on 2026-10-31/)
  const scope = read('docs/adr/README.md').split('## Note on scope')[1].split('## Entries')[0]
  assert.match(scope, /024[\s\S]*026[\s\S]*027[\s\S]*historical/)
  assert.doesNotMatch(read('visualizer/README.md'), /returns (?:and journal )?sources?/i)
  const claude = read('CLAUDE.md')
  assert.ok(claude.includes('`node bin/crew.mjs <verb>`'))
  assert.equal((claude.match(/^\|.*`skills\/lane-brief\/`.*\|$/gm) ?? []).length, 1)
  const crew = read('crew/README.md')
  assert.ok(crew.includes('`~/.crew/dt-<lane>/<lane>/`'))
  assert.doesNotMatch(crew.match(/State lives under[\s\S]*?session file\./)[0], /DEVTEAM_CREW_ROOT/)
  assert.match(crew, /skill-map selector, not a registered hook/)
  assert.ok(crew.includes('visualizer/web/src/lib/LeanWaterfall.svelte'))
  assert.match(read('test/fixtures/acp/README.md'), /Historical measurements[\s\S]*replayed by current/)
  assert.match(read('docs/decisions-needed.md'), /Historical register/)
  assert.match(read('README.md'), /decisions-needed\.md`\]\(docs\/decisions-needed\.md\) is the historical\s+owner-decision register/)
})
