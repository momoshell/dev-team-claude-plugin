import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

// All repository inputs come from the checkout in which the loop runs us.
const root = process.cwd()
const pathFor = (file) => {
  const path = resolve(root, file)
  const rel = relative(root, path)
  assert.ok(rel !== '..' && !rel.startsWith(`..${sep}`), `outside checkout: ${file}`)
  return path
}
const read = file => readFileSync(pathFor(file), 'utf8')
const json = file => JSON.parse(read(file))
const removed = ['@xyflow/svelte', '@dagrejs/dagre', 'codemirror', '@codemirror/lang-json', '@codemirror/lang-markdown']
const sorted = values => [...new Set(values)].sort()
const packageRoot = specifier => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]

function walk(directory) {
  return readdirSync(pathFor(directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (['node_modules', 'dist', '.git', '.vite', 'coverage', '__tests__', 'test', 'tests'].includes(entry.name)) return []
    const file = `${directory}/${entry.name}`
    if (entry.isDirectory()) return walk(file)
    if (!entry.isFile() || /\.(?:test|spec)\.[^.]+$/.test(entry.name)) return []
    return /\.(?:mjs|cjs|js|jsx|ts|tsx|svelte|css)$/.test(entry.name) ? [file] : []
  })
}

function importedPackages() {
  const found = new Set()
  for (const file of walk('visualizer')) {
    const text = read(file)
    // Static imports/re-exports (including multiline clauses), side-effect
    // imports, and literal dynamic imports/requires. Never execute UI code.
    const patterns = [
      /(?:^|[\n;])\s*(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"\n]+)['"]/g,
      /(?:\bimport|\brequire)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
      /@import\s+(?:url\(\s*)?['"]([^'"\n]+)['"]/g,
    ]
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const specifier = match[1]
        if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':')) found.add(packageRoot(specifier))
      }
    }
  }
  return found
}

function indexStatuses(register) {
  const index = register.match(/^## Index\s*\n([\s\S]*?)(?=^##?\s|$(?![\s\S]))/m)?.[1]
  assert.ok(index, 'ADR register Index section is missing')
  const rows = new Map()
  for (const line of index.split('\n')) {
    if (!/^\|\s*\d{3}\s*\|/.test(line)) continue
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim())
    assert.equal(cells.length, 4, `malformed index row: ${line}`)
    assert.ok(!rows.has(cells[0]), `duplicate ADR-${cells[0]} index row`)
    rows.set(cells[0], cells[2])
  }
  assert.ok(rows.size > 0, 'ADR index has no numbered rows')
  return rows
}

function plain(text) {
  return text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trim()
}
const category = text => plain(text).match(/^(superseded|withdrawn|proposed|ratified|written)\b/i)?.[1]?.toLowerCase()
const target = text => plain(text).match(/\b(?:superseded|withdrawn)\b[^·]*?\bby\s+(ADR-\d{3})\b/i)?.[1]
function adrFiles() {
  const found = new Map()
  for (const name of readdirSync(pathFor('docs/adr')).sort()) {
    const number = name.match(/^adr-(\d{3})-.*\.md$/)?.[1]
    if (!number) continue
    const file = `docs/adr/${name}`
    const status = read(file).match(/^\*\*Status:\*\*\s*(.+)$/m)?.[1]
    assert.ok(status, `${file} has no Status line`)
    assert.ok(!found.has(number), `duplicate standalone ADR-${number}`)
    found.set(number, { file, status })
  }
  assert.ok(found.size > 0, 'no standalone ADRs found')
  return found
}

const checks = {
  DM1() {
    const plugin = json('.claude-plugin/plugin.json')
    const marketplace = json('.claude-plugin/marketplace.json')
    const entry = marketplace.plugins?.find(item => item.name === plugin.name)
    assert.ok(entry, 'marketplace must list the plugin')
    const descriptions = []
    const collect = (value, location) => {
      if (!value || typeof value !== 'object') return
      for (const [key, child] of Object.entries(value)) {
        if (key === 'description') descriptions.push([`${location}.${key}`, child])
        else collect(child, `${location}.${key}`)
      }
    }
    collect(plugin, 'plugin')
    collect(marketplace, 'marketplace')
    for (const [location, description] of descriptions) {
      assert.equal(typeof description, 'string', `${location} is not a description string`)
      assert.doesNotMatch(description, /cmux|daemon|factoryctl/i, `${location} describes the deleted runtime`)
    }
    assert.ok(plugin.description?.trim(), 'plugin description must be nonempty')
    assert.equal(entry.description, plugin.description, 'plugin and marketplace descriptions drifted')
  },

  DM2() {
    const pkg = json('package.json')
    const declared = pkg.devDependencies
    assert.ok(declared && Object.keys(declared).length, 'visualizer devDependencies missing')
    const used = importedPackages()
    const unused = Object.keys(declared).filter(name => !used.has(name))
    assert.deepEqual(unused, [], `devDependencies without visualizer/build imports: ${unused.join(', ')}`)
    const remaining = removed.filter(name => Object.hasOwn(declared, name))
    assert.deepEqual(remaining, [], `approved removals still declared: ${remaining.join(', ')}`)
    const lock = json('package-lock.json')
    assert.deepEqual(lock.packages?.['']?.devDependencies, declared, 'lock root devDependencies differ from package.json')
    const leftovers = removed.filter(name => Object.hasOwn(lock.packages ?? {}, `node_modules/${name}`))
    assert.deepEqual(leftovers, [], `removed packages still locked: ${leftovers.join(', ')}`)
  },

  DM3() {
    const doc = read('CLAUDE.md')
    const start = doc.indexOf('**The runtime ships zero dependencies;')
    assert.ok(start >= 0, 'runtime/visualizer dependency paragraph is missing')
    const end = doc.indexOf('\n## ', start)
    const paragraph = doc.slice(start, end < 0 ? undefined : end)
    const names = new Set()
    const nonPackages = new Set(['dependencies', 'devDependencies', 'jq', 'node_modules'])
    for (const [, token] of paragraph.matchAll(/`([^`\n]+)`/g)) {
      if (/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(token) &&
          !nonPackages.has(token) && !/\.(?:json|mjs|cjs|js|ts|md|svelte)$/i.test(token)) names.add(token)
    }
    // Scoped package names anywhere in this live operating doc, plus the known
    // unscoped removed editor, cannot be hidden outside the main paragraph.
    for (const match of doc.matchAll(/@[a-z0-9._-]+\/[a-z0-9._-]+/gi)) names.add(match[0])
    for (const name of ['svelte', 'vite', 'lucide-svelte', 'codemirror']) {
      if (new RegExp(`(^|[^a-z0-9@/_-])${name}($|[^a-z0-9/_-])`, 'i').test(paragraph)) names.add(name)
    }
    if (/(^|[^a-z0-9@/_-])codemirror($|[^a-z0-9/_-])/i.test(doc)) names.add('codemirror')
    assert.ok(names.size > 0, 'dependency paragraph must name its actual packages')
    const declared = json('package.json').devDependencies ?? {}
    const undeclared = sorted(names).filter(name => !Object.hasOwn(declared, name))
    assert.deepEqual(undeclared, [], `CLAUDE.md names undeclared visualizer packages: ${undeclared.join(', ')}`)
  },

  DM4() {
    const rows = indexStatuses(read('docs/adr/README.md'))
    const files = adrFiles()
    for (const number of ['029', '035', '040', '042', '044', '046']) {
      assert.equal(category(files.get(number)?.status ?? ''), 'superseded', `keep ADR-${number}'s authoritative superseded status`)
    }
    const mismatches = []
    for (const [number, { status }] of files) {
      if (!/\bsuperseded\b/i.test(plain(status))) continue
      const indexed = rows.get(number) ?? ''
      if (category(indexed) !== 'superseded' || (target(status) && target(indexed) !== target(status))) {
        mismatches.push(`ADR-${number}: file ${plain(status).split('·')[0].trim()}, index ${plain(indexed) || 'missing'}`)
      }
    }
    assert.deepEqual(mismatches, [], `superseded ADRs disagree with index: ${mismatches.join('; ')}`)
  },

  DM5() {
    const indexed = indexStatuses(read('docs/adr/README.md')).get('041') ?? ''
    const status = read('docs/adr/adr-041-claims-at-plan-accept.md').match(/^\*\*Status:\*\*\s*(.+)$/m)?.[1] ?? ''
    assert.equal(category(indexed), 'withdrawn', 'ADR-041 index must retain its withdrawn decision')
    assert.equal(category(status), category(indexed), `ADR-041 status is ${category(status) ?? 'missing'}, index is ${category(indexed)}`)
    assert.equal(target(indexed), 'ADR-043', 'ADR-041 index must name withdrawal by ADR-043')
    assert.equal(target(status), target(indexed), 'ADR-041 Status line must name withdrawal by ADR-043')
  },

  DM6() {
    const register = read('docs/adr/README.md')
    const end = register.indexOf('\n## Where a record lives')
    assert.ok(end > 0, 'ADR register introduction boundary missing')
    const intro = register.slice(0, end)
    const references = new Set()
    for (const [, code] of intro.matchAll(/`([^`\n]+)`/g)) {
      for (const match of code.matchAll(/(?:\.{1,2}\/)?(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.(?:mjs|cjs|js|ts|json|md|svelte)\b/gi)) references.add(match[0])
    }
    for (const [, destination] of intro.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      if (/^(?:[a-z]+:|#)/i.test(destination)) continue
      references.add(destination.split('#')[0])
    }
    assert.ok(references.size > 0, 'intro must retain a concrete source-file example')
    const missing = []
    for (const reference of references) {
      const file = reference.startsWith('./') || reference.startsWith('../') ? `docs/adr/${reference}` : reference
      try { if (!statSync(pathFor(file)).isFile()) missing.push(reference) } catch { missing.push(reference) }
    }
    assert.deepEqual(missing, [], `intro cites missing files: ${missing.join(', ')}`)
  },

  DM7() {
    const server = read('visualizer/server/server.mjs')
    const block = server.match(/export\s+const\s+ROUTE_PARAMS\s*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\)/)?.[1]
    assert.ok(block, 'server ROUTE_PARAMS registry not found')
    const registered = sorted([...block.matchAll(/^\s*['"](\/api\/[^'"\n]+)['"]\s*:/gm)].map(match => match[1]))
    assert.ok(registered.length > 0, 'ROUTE_PARAMS registry has no routes')
    const documented = sorted([...read('visualizer/README.md').matchAll(/`(\/api\/[^`\s]+)`/g)].map(match => match[1]))
    const missing = registered.filter(route => !documented.includes(route))
    const extra = documented.filter(route => !registered.includes(route))
    assert.ok(missing.length === 0 && extra.length === 0, `route inventory differs: missing [${missing.join(', ')}]; unregistered/wildcard [${extra.join(', ')}]`)
  },
}

let failed = false
for (const [id, check] of Object.entries(checks)) {
  try { check() } catch (error) {
    failed = true
    const reason = String(error?.message ?? error).split('\n')[0].replace(/\s+/g, ' ').trim()
    console.log(`FAIL ${id}: ${reason}`)
  }
}
process.exitCode = failed ? 1 : 0
