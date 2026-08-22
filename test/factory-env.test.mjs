import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, posix } from 'node:path'
import { ROOT } from './helpers.mjs'
import { NODE_FLOOR } from '../scripts/factory/ledger.mjs'

const workflowYml = readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8')
const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const configMd = readFileSync(join(ROOT, '.claude/dev-team/config.md'), 'utf8')

test('CI workflow runs exactly one Node job, at or above NODE_FLOOR', () => {
  const matches = [...workflowYml.matchAll(/node-version:\s*"?(\d+)/g)]
  assert.equal(matches.length, 1, `expected exactly one concrete node-version declaration, found ${matches.length}`)
  const major = Number(matches[0][1])
  const floorMajor = Number(NODE_FLOOR.split('.')[0])
  assert.ok(major >= floorMajor, `CI node major ${major} is below NODE_FLOOR ${NODE_FLOOR}`)
})

test('CI workflow declares no Node 20 leg', () => {
  const versionLines = workflowYml.split('\n').filter((line) => line.includes('node-version:'))
  assert.ok(!versionLines.some((line) => /\b20\b/.test(line)), 'a node-version line still mentions Node 20')
})

test('.gitignore contains all four run-trace mirror db artifact patterns', () => {
  const lines = gitignore.split('\n').map((s) => s.trim())
  for (const p of ['*.db', '*.db-wal', '*.db-shm', '*.db-journal']) {
    assert.ok(lines.includes(p), `missing ignore pattern ${p}`)
  }
})

test('package.json exposes the eight read-only ledger recipes pointing at the ledger entry point', () => {
  const names = ['ledger:sessions', 'ledger:phases', 'ledger:tail', 'ledger:procs', 'ledger:gate-review-gap', 'ledger:eligible-tasks', 'ledger:run-set', 'ledger:task']
  for (const name of names) {
    assert.ok(name in pkg.scripts, `missing script ${name}`)
    assert.match(pkg.scripts[name], /scripts\/factory\/ledger\.mjs/, `${name} does not invoke the ledger entry point`)
  }
})

// #439: the enforcement is an explicit allowlist of read-only recipes, not a
// name blacklist. `/kill|prune|delete|reset/i` never saw a destructive verb
// spelled any other way (`crew:obliterate`), and it could not see a read-only
// NAME whose COMMAND reclaims (`crew:reap -- --reclaim`). Each entry says why
// the recipe is read-only; a new script is refused until someone adds one.
const READ_ONLY_RECIPES = new Map([
  ['test', 'runs node --test over the suite; the suite writes only under per-test temp dirs'],
  ['ledger:sessions', 'read-only ledger query — SELECT-only recipe over the run register'],
  ['ledger:phases', 'read-only ledger query — SELECT-only recipe over the run register'],
  ['ledger:tail', 'read-only ledger query — SELECT-only recipe over the run register'],
  ['ledger:procs', 'read-only ledger query — SELECT-only recipe over the run register'],
  ['ledger:gate-review-gap', 'read-only ledger query — SELECT-only recipe over the run register'],
  ['ledger:eligible-tasks', 'read-only ledger query — SELECT-only recipe over the run register'],
  ['ledger:run-set', 'read-only ledger query — SELECT-only recipe over the run register'],
  ['ledger:task', 'read-only ledger query — SELECT-only recipe over the run register'],
  ['viz:serve', 'serves the visualizer read-only over localhost; mutates no repo file'],
  ['viz:build', 'vite build — writes only its own build output directory'],
  ['viz:dev', 'vite dev server; mutates no repo file'],
  ['crew:watch', 'watches lanes and prints; signals nothing'],
  ['crew:reap', 'dry run by default — signalling requires an explicit -- --reclaim (#439)'],
])
const RECLAIM_FLAGS = ['--reclaim']

function recipeVerdict(name, command) {
  if (!READ_ONLY_RECIPES.has(name)) return 'unlisted'
  if (RECLAIM_FLAGS.some((flag) => String(command).split(/\s+/).includes(flag))) return 'mutating-flag'
  return 'read-only'
}

test('every npm script is an allowlisted read-only recipe, whatever it is called', () => {
  const offenders = Object.entries(pkg.scripts).filter(([name, command]) => recipeVerdict(name, command) !== 'read-only')
  assert.deepEqual(offenders, [], `these npm scripts are not allowlisted read-only recipes: ${offenders.map(([name]) => name).join(', ')}`)
})

test('the recipe verdict catches a destructive name the four-word blacklist missed', () => {
  assert.equal(recipeVerdict('crew:obliterate', 'node scripts/factory/reap-stale.mjs --reclaim'), 'unlisted')
  assert.doesNotMatch('crew:obliterate', /kill|prune|delete|reset/i)
  assert.equal(recipeVerdict('crew:reap', 'node scripts/factory/reap-stale.mjs --reclaim'), 'mutating-flag')
  assert.equal(recipeVerdict('crew:reap', pkg.scripts['crew:reap']), 'read-only')
})

test('every read-only recipe allowlist entry names a live script and a reason', () => {
  for (const [name, why] of READ_ONLY_RECIPES) {
    assert.ok(name in pkg.scripts, `allowlist entry ${name} is not a live npm script — delete it`)
    assert.ok(why.length > 20, `allowlist entry ${name} carries no reason`)
  }
})

// Replaced the former "has no `engines` field" assertion; superseded by ADR-031.
test("package.json's engines.node floor is exactly NODE_FLOOR", () => {
  const declared = pkg.engines?.node
  const message = `package.json engines.node (${declared}) must declare the same floor as NODE_FLOOR (${NODE_FLOOR}) in scripts/factory/ledger.mjs — change both or neither`
  assert.ok(declared, message)
  const match = String(declared).match(/(\d+)\.(\d+)\.(\d+)/)
  assert.ok(match, message)
  assert.equal(match[0], NODE_FLOOR, message)
  assert.match(String(declared), />=/, message)
})

test('config.md review_defaults section documents scripts/factory/*.mjs', () => {
  const start = configMd.indexOf('## review_defaults')
  assert.ok(start !== -1, 'review_defaults heading not found')
  const rest = configMd.slice(start + '## review_defaults'.length)
  const nextHeadingIdx = rest.indexOf('\n## ')
  const section = nextHeadingIdx === -1 ? rest : rest.slice(0, nextHeadingIdx)
  assert.ok(section.includes('scripts/factory/*.mjs'), 'review_defaults section is missing scripts/factory/*.mjs')
})

// Ledger sandbox tripwire (#477). A test file can reach the operator's ledger
// through an imported door that is not itself named `openRun`, so this registry
// records the exported reach points and the explicit openers. The registry is
// deliberately reviewed against every production home-defaulting expression.
const LEDGER_DOORS = new Map([
  ['scripts/factory/emit.mjs#openRun', {
    kind: 'opener',
    why: 'emit.mjs:498 exports openRun, whose omitted dbPath reaches its state-directory default',
  }],
  ['scripts/factory/ledger.mjs#openLedger', {
    kind: 'opener',
    why: 'ledger.mjs:1210 exports openLedger and refuses only when its explicit dbPath is absent',
  }],
  ['crew/crew.mjs#bootCmd', {
    kind: 'home-default',
    why: 'crew.mjs:1063 bootCmd reaches ledgerDbPath through its boot and cell-failure paths',
  }],
  ['crew/crew.mjs#runCmd', {
    kind: 'home-default',
    why: 'crew.mjs:1377 runCmd resolves the ledgerDbPath used by its run emitter',
  }],
  ['crew/crew.mjs#teardownCmd', {
    kind: 'home-default',
    why: 'crew.mjs:1758 teardownCmd resolves the ledgerDbPath used by teardown instrumentation',
  }],
  ['crew/child.mjs#runChild', {
    kind: 'home-default',
    why: 'child.mjs:97 runChild resolves its ledger path before the daemon-forked run opens',
  }],
  ['crew/daemon.mjs#daemon', {
    kind: 'home-default',
    why: 'daemon.mjs:343 daemon computes its budget ledger path from the home default',
  }],
  ['scripts/factory/ledger.mjs#defaultDbPath', {
    kind: 'home-default',
    why: 'ledger.mjs:3156 defaultDbPath computes the CLI home ledger when no environment path exists',
  }],
  ['scripts/factory/ledger.mjs#main', {
    kind: 'home-default',
    why: 'ledger.mjs:3624 main calls defaultDbPath before dispatching the ledger CLI verb',
  }],
  ['visualizer/server/server.mjs#parseCliArgs', {
    kind: 'home-default',
    why: 'server.mjs:51 parseCliArgs calls defaults, which computes the visualizer ledger path',
  }],
  ['visualizer/server/server.mjs#startServer', {
    kind: 'home-default',
    why: 'server.mjs:155 startServer calls defaults before constructing its default ledger feed',
  }],
])

// The mechanism is textual, but text is sufficient against these four tricks:
// the writer question is decided on the import specifier and the imported name,
// which an alias cannot change and which the module's export list fixes; the
// reach question is decided by a registry whose completeness is re-derived from
// every home-defaulting expression in production code rather than from a call
// name; and the sandbox question is decided over a comment-and-string-masked
// copy with the value's definition chain resolved. Text does not see a spawned
// child process (it inherits the module-scope redirect, so a sandboxed file
// covers its children — an unsandboxed file that ONLY spawns a repo CLI is not
// detected), a dynamically-built specifier, or a door reached through a
// re-export. The spawn arm is absent rather than silent: a spawn-plus-path-
// mention rule was measured during planning and produced 13 offenders, nearly
// all from a mere path mention in a comment.
function maskCode(source) {
  const out = String(source).split('')
  let i = 0
  while (i < out.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      while (i < out.length && source[i] !== '\n') {
        out[i] = ' '
        i += 1
      }
      continue
    }
    if (ch === '/' && next === '*') {
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      while (i < out.length) {
        if (source[i] === '*' && source[i + 1] === '/') {
          out[i] = ' '
          out[i + 1] = ' '
          i += 2
          break
        }
        if (source[i] !== '\n' && source[i] !== '\r') out[i] = ' '
        i += 1
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      out[i] = ' '
      i += 1
      while (i < out.length) {
        if (source[i] === '\\') {
          out[i] = ' '
          if (i + 1 < out.length) {
            if (source[i + 1] !== '\n' && source[i + 1] !== '\r') out[i + 1] = ' '
          }
          i += 2
          continue
        }
        if (source[i] === quote) {
          out[i] = ' '
          i += 1
          break
        }
        if (source[i] !== '\n' && source[i] !== '\r') out[i] = ' '
        i += 1
      }
      continue
    }
    i += 1
  }
  return out.join('')
}

function importBindings(source, dir) {
  const code = maskCode(source)
  const bindings = []
  const imports = /\bimport\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([\s\S]*?)\}\s*from\s*(['"])([^'"]+)\2/g
  for (const match of source.matchAll(imports)) {
    if (code[match.index] !== 'i') continue
    const modulePath = posix.normalize(posix.join(dir, match[3]))
    for (const part of match[1].split(',')) {
      const text = part.trim()
      if (!text) continue
      const pieces = text.split(/\s+as\s+/)
      const imported = pieces[0].trim()
      const local = (pieces[1] || imported).trim()
      const door = `${modulePath}#${imported}`
      if (LEDGER_DOORS.has(door)) bindings.push({ door, local })
    }
  }
  return bindings
}

function doorsUsed(source, dir) {
  return new Set(importBindings(source, dir).map(({ door }) => door))
}

function callArgs(source, name) {
  const code = maskCode(source)
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const calls = new RegExp(`\\b${escaped}\\s*\\(`, 'g')
  const spans = []
  for (const match of code.matchAll(calls)) {
    const open = match.index + match[0].lastIndexOf('(')
    let depth = 0
    let close = -1
    for (let i = open; i < code.length; i += 1) {
      if (code[i] === '(') depth += 1
      else if (code[i] === ')') {
        depth -= 1
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    // Argument predicates read masked bytes so comments and string bodies cannot fake containment.
    if (close !== -1) spans.push(code.slice(open + 1, close))
  }
  return spans
}

const REAL_LEDGER_MARKERS = [/homedir\s*\(/, /\.dev-team/, /process\.env\.HOME/]
const TEMP_MARKERS = [/mkdtempSync\s*\(/, /mkdtemp\s*\(/, /tmpdir\s*\(/]
const IDENTIFIER = /\b[A-Za-z_$][\w$]*\b/g

function identifiersIn(text) {
  return [...String(text).matchAll(IDENTIFIER)].map((match) => match[0])
}

function resolvedValue(rhs, definitions) {
  let resolved = rhs
  let frontier = identifiersIn(rhs)
  const seen = new Set()
  for (let hop = 0; hop < 3 && frontier.length; hop += 1) {
    const next = []
    for (const identifier of frontier) {
      if (seen.has(identifier) || !definitions.has(identifier)) continue
      seen.add(identifier)
      const value = definitions.get(identifier)
      resolved += `\n${value}`
      next.push(...identifiersIn(value))
    }
    frontier = next
  }
  return resolved
}

function sandboxVerdict(source) {
  const code = maskCode(source)
  const definitions = new Map()
  for (const match of code.matchAll(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/gm)) {
    const equals = match[0].indexOf('=')
    const start = match.index + equals + 1
    definitions.set(match[1], code.slice(start, match.index + match[0].length).trim())
  }
  const assignments = [...code.matchAll(/^process\.env\.DEVTEAM_LEDGER_(DIR|DB)\s*=\s*(.+)$/gm)]
  if (assignments.length === 0) return 'unsandboxed'
  let allTempRooted = true
  for (const match of assignments) {
    const equals = match[0].indexOf('=')
    const start = match.index + equals + 1
    const rhs = code.slice(start, match.index + match[0].length).trim()
    const resolved = resolvedValue(rhs, definitions)
    if (REAL_LEDGER_MARKERS.some((marker) => marker.test(resolved))) return 'points-at-real-ledger'
    if (!TEMP_MARKERS.some((marker) => marker.test(resolved))) allTempRooted = false
  }
  return allTempRooted ? 'sandboxed' : 'unsandboxed'
}

function ledgerSandboxVerdict(source, dir) {
  const doors = doorsUsed(source, dir)
  const bindings = importBindings(source, dir)
  const hasHomeDefault = [...doors].some((door) => LEDGER_DOORS.get(door)?.kind === 'home-default')
  const hasUncontainedOpener = bindings.some(({ door, local }) => {
    if (LEDGER_DOORS.get(door)?.kind !== 'opener') return false
    return callArgs(source, local).some((args) => !/\bdbPath\b/.test(args))
  })
  if (!hasHomeDefault && !hasUncontainedOpener) return 'not-a-writer'
  return sandboxVerdict(source)
}

function functionHeaders(code) {
  const headers = []
  const pattern = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm
  for (const match of code.matchAll(pattern)) headers.push({ name: match[1], start: match.index, end: match.index + match[0].length })
  return headers
}

function nearestFunction(headers, offset) {
  let nearest = null
  for (const header of headers) {
    if (header.start > offset) break
    nearest = header
  }
  return nearest
}

function callersOf(code, headers, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const calls = new RegExp(`\\b${escaped}\\s*\\(`, 'g')
  const callers = new Set()
  for (const match of code.matchAll(calls)) {
    const header = nearestFunction(headers, match.index)
    if (!header || (match.index >= header.start && match.index < header.end)) continue
    callers.add(header.name)
  }
  return callers
}

function reachesHomeDoor(modulePath, code, headers, start) {
  let frontier = [start]
  const seen = new Set()
  for (let depth = 0; depth <= 3 && frontier.length; depth += 1) {
    const next = []
    for (const name of frontier) {
      if (seen.has(name)) continue
      seen.add(name)
      const door = LEDGER_DOORS.get(`${modulePath}#${name}`)
      if (door?.kind === 'home-default') return true
      for (const caller of callersOf(code, headers, name)) if (!seen.has(caller)) next.push(caller)
    }
    frontier = next
  }
  return false
}

function testFilesUnder(dir) {
  return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => join(entry.parentPath, entry.name).slice(ROOT.length + 1).replaceAll('\\', '/'))
}

function productionFilesUnder(dir) {
  return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs'))
    .map((entry) => join(entry.parentPath, entry.name).slice(ROOT.length + 1).replaceAll('\\', '/'))
}

// These exemptions are deliberately warranties, not an allow-anything list.
// Each warranty rechecks the measured containment shape on every test run.
const LEDGER_SANDBOX_EXEMPT = new Map([
  ['test/factory-emit.test.mjs', {
    why: 'factory-emit.test.mjs:17 passes every openRun call an explicit temp stateDir; emit.mjs:637 resolves its database below that directory',
    warranty: (source) => {
      const spans = callArgs(source, 'openRun')
      return spans.length > 0 && spans.every((args) => /\bstateDir\b/.test(args))
    },
  }],
  ['crew/drive.test.mjs', {
    why: 'drive.test.mjs:4852 injects DEVTEAM_LEDGER_DB into its only runChild call; child.mjs:35 reads that exact injected environment key',
    warranty: (source) => {
      const spans = callArgs(source, 'runChild')
      return spans.length > 0 && spans.every((args) => /\bDEVTEAM_LEDGER_DB\b/.test(args))
    },
  }],
  ['test/visualizer-server.test.mjs', {
    why: 'visualizer-server.test.mjs:87 injects a feed into its only startServer call, so server.mjs:174 takes config.feed and never builds the default ledger feed; its 13 openLedger calls all name an explicit dbPath, and parseCliArgs only returns a config. The warranty reads doors and their call arguments, not the import list, so a newly imported door must prove its own containment.',
    warranty: (source, dir) => {
      // Per-door containment: an imported door with no entry here fails the warranty,
      // so widening the import list cannot silently widen the exemption.
      const contained = new Map([
        ['visualizer/server/server.mjs#startServer', /\bfeed\b/],
        ['visualizer/server/server.mjs#parseCliArgs', null],
        ['scripts/factory/ledger.mjs#openLedger', /\bdbPath\b/],
      ])
      let homeDoors = 0
      for (const { door, local } of importBindings(source, dir)) {
        if (!contained.has(door)) return false
        if (LEDGER_DOORS.get(door)?.kind === 'home-default') homeDoors += 1
        const predicate = contained.get(door)
        if (!predicate) continue
        const spans = callArgs(source, local)
        if (spans.length === 0 || !spans.every((args) => predicate.test(args))) return false
      }
      // No home-default door left means the exemption is spent, not warranted.
      return homeDoors > 0
    },
  }],
  ['test/visualizer-shape.test.mjs', {
    why: 'visualizer-shape.test.mjs:470 supplies an explicit feed to every startServer call, so server.mjs:159 never creates the default ledger feed',
    warranty: (source) => {
      const spans = callArgs(source, 'startServer')
      return spans.length > 0 && spans.every((args) => /\bfeed\b/.test(args))
    },
  }],
])
const TRIPWIRE_SELF = 'test/factory-env.test.mjs'

// MUTATION A1: removing the openRun registry key lets the aliased opener pass unnamed.
test('ledger sandbox tripwire — alias imports retain the exported opener door', () => {
  const source = [
    "import { openRun as x } from '../scripts/factory/emit.mjs'",
    "const emitter = x({ stateDir: 'd' })",
  ].join('\n')
  assert.notEqual(ledgerSandboxVerdict(source, 'test'), 'not-a-writer')
})

// MUTATION: reading unmasked call arguments lets a string spell dbPath for a call that has none.
test('ledger sandbox tripwire — a dbPath spelled inside a string does not contain an opener', () => {
  const source = [
    "import { openRun } from '../scripts/factory/emit.mjs'",
    "const emitter = openRun({ stateDir: 'd', note: 'dbPath' })",
  ].join('\n')
  assert.equal(ledgerSandboxVerdict(source, 'test'), 'unsandboxed')
})

// MUTATION A2: removing the bootCmd registry key erases the indirect home-default reach.
test('ledger sandbox tripwire — an imported home-default helper is a writer without a local opener name', () => {
  const source = "import { bootCmd } from '../crew/crew.mjs'\nawait bootCmd({ task: 't' })\n"
  assert.notEqual(ledgerSandboxVerdict(source, 'test'), 'not-a-writer')
})

// MUTATION A3: scanning raw source instead of the masked copy credits a commented assignment.
test('ledger sandbox tripwire — block, line, and template comments never credit a sandbox', () => {
  const source = [
    "import { openRun } from '../scripts/factory/emit.mjs'",
    "const emitter = openRun({ stateDir: 'd' })",
    '/*',
    'process.env.DEVTEAM_LEDGER_DIR = mkdtempSync(join(tmpdir(), \'block-\'))',
    '*/',
    '// process.env.DEVTEAM_LEDGER_DIR = mkdtempSync(join(tmpdir(), \'line-\'))',
    'const text = `',
    'process.env.DEVTEAM_LEDGER_DIR = mkdtempSync(join(tmpdir(), \'template-\'))',
    '`',
  ].join('\n')
  assert.equal(ledgerSandboxVerdict(source, 'test'), 'unsandboxed')
})

// MUTATION A4: removing the real-ledger markers lets the temp mention credit a real path.
test('ledger sandbox tripwire — a real-ledger assignment beats a deliberate temp mention', () => {
  const source = [
    "import { openRun } from '../scripts/factory/emit.mjs'",
    "const emitter = openRun({ stateDir: 'd' })",
    "process.env.DEVTEAM_LEDGER_DIR = process.env.CI ? mkdtempSync(join(tmpdir(), 'x-')) : join(homedir(), '.dev-team', 'factory')",
  ].join('\n')
  assert.equal(ledgerSandboxVerdict(source, 'test'), 'points-at-real-ledger')
})

// MUTATION A5/A6: removing either indirect registry door blinds its production reach.
test('ledger sandbox tripwire — registry doors include child and visualizer entrypoints', () => {
  assert.equal(LEDGER_DOORS.get('crew/child.mjs#runChild')?.kind, 'home-default')
  assert.equal(LEDGER_DOORS.get('visualizer/server/server.mjs#startServer')?.kind, 'home-default')
})

// MUTATION A7: removing TEMP_MARKERS makes the genuine mkdtemp redirect cry wolf.
test('ledger sandbox tripwire — a one-hop module-scope mkdtemp redirect is accepted', () => {
  const imported = "import { bootCmd } from '../crew/crew.mjs'\n"
  const sandboxed = `${imported}const d = mkdtempSync(join(tmpdir(), 'x-'))\nprocess.env.DEVTEAM_LEDGER_DIR = d\nawait bootCmd({ task: 't' })\n`
  const indented = `${imported}const d = mkdtempSync(join(tmpdir(), 'x-'))\n  process.env.DEVTEAM_LEDGER_DIR = d\nawait bootCmd({ task: 't' })\n`
  assert.equal(ledgerSandboxVerdict(sandboxed, 'test'), 'sandboxed')
  assert.equal(ledgerSandboxVerdict(indented, 'test'), 'unsandboxed')
  assert.equal(ledgerSandboxVerdict(`${imported}const x = 1\n`, 'test'), 'unsandboxed')
  assert.equal(ledgerSandboxVerdict('const x = 1\n', 'test'), 'not-a-writer')
})

test('ledger sandbox tripwire — every registered door is live and carries its reason', () => {
  for (const [key, door] of LEDGER_DOORS) {
    const split = key.indexOf('#')
    const modulePath = key.slice(0, split)
    const symbol = key.slice(split + 1)
    const source = readFileSync(join(ROOT, modulePath), 'utf8')
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    assert.match(source, new RegExp(`export\\s+(?:async\\s+)?function\\s+${escaped}\\s*\\(`), `${key} is not exported as a function`)
    assert.ok(door.why.length > 20, `${key} carries no anchor-backed reason`)
  }
})

test('ledger sandbox tripwire — every production home default resolves to a registered door', () => {
  const offenders = []
  for (const file of [...productionFilesUnder('crew'), ...productionFilesUnder('scripts'), ...productionFilesUnder('visualizer')]) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    const code = maskCode(source)
    const lines = source.split('\n')
    const maskedLines = code.split('\n')
    const headers = functionHeaders(code)
    let offset = 0
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      const masked = maskedLines[i] || ''
      if (line.includes('homedir(') && line.includes('.dev-team') && line.includes('DEVTEAM_LEDGER_')
          && masked.includes('homedir(') && masked.includes('DEVTEAM_LEDGER_')) {
        const header = nearestFunction(headers, offset)
        if (!header || !reachesHomeDoor(file, code, headers, header.name)) {
          offenders.push(`${file}:${i + 1}${header ? ` (${header.name})` : ' (no function header)'}`)
        }
      }
      offset += line.length + 1
    }
  }
  assert.deepEqual(offenders, [], `these home-defaulting expressions do not resolve to a registered door: ${offenders.join(', ')}`)
})

test('ledger sandbox tripwire — every test file is either not a writer or sandboxed', () => {
  const offenders = []
  for (const file of [...testFilesUnder('crew'), ...testFilesUnder('test')]) {
    if (file === TRIPWIRE_SELF || LEDGER_SANDBOX_EXEMPT.has(file)) continue
    const verdict = ledgerSandboxVerdict(readFileSync(join(ROOT, file), 'utf8'), posix.dirname(file))
    if (!['not-a-writer', 'sandboxed'].includes(verdict)) offenders.push(`${file} (${verdict})`)
  }
  assert.deepEqual(offenders, [], `these test files are ledger writers without a credited sandbox: ${offenders.join(', ')}`)
})

test('ledger sandbox tripwire — every exemption has a live, load-bearing warranty', () => {
  for (const [file, exemption] of LEDGER_SANDBOX_EXEMPT) {
    let source
    try { source = readFileSync(join(ROOT, file), 'utf8') }
    catch (err) { assert.fail(`exemption ${file} is missing or unreadable: ${err.message}`) }
    const dir = posix.dirname(file)
    assert.ok(exemption.why.length > 20, `exemption ${file} carries no anchor-backed reason`)
    assert.equal(exemption.warranty(source, dir), true, `exemption ${file} warranty no longer holds`)
    const verdict = ledgerSandboxVerdict(source, dir)
    assert.ok(!['not-a-writer', 'sandboxed'].includes(verdict), `exemption ${file} is redundant; ignoring it gives ${verdict}`)
  }
  for (const file of ['crew/crew.test.mjs', 'crew/daemon.test.mjs', 'crew/reclaim-descendants.test.mjs']) {
    assert.ok(!LEDGER_SANDBOX_EXEMPT.has(file), `${file} is a live ledger leak and may never be exempted`)
  }
})
