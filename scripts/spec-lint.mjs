#!/usr/bin/env node
// Mechanical Handover Spec lint — the checkable half of handover-spec.md's
// self-check. Verifies what a machine can verify (paths exist, cited
// file:line references resolve, validation commands are runnable) so the
// orchestrator's pre-dispatch eyeball only has to cover the semantic half
// (symbols named, gotchas, interface_contract ownership).
//
// usage: node spec-lint.mjs [--root <project-dir>] <spec.json | ->
//   spec.json  a Handover Spec as JSON (handover-spec.schema.json shape)
//   -          read the spec JSON from stdin
//
// Exit 0 = PASS (warnings allowed), exit 1 = FAIL, exit 2 = usage/parse error.
// New files are legal: a missing files_in_scope path whose parent directory
// exists is a warning ("treated as new file"), not a failure.
import { readFileSync, existsSync, statSync, accessSync, constants } from 'node:fs'
import { resolve, dirname, delimiter, join, isAbsolute } from 'node:path'

const REQUIRED_FIELDS = [
  'task_id', 'domain', 'goal', 'files_in_scope', 'constraints', 'acceptance_criteria',
  'validation_commands', 'discovery_context', 'out_of_scope', 'depends_on', 'interface_contract',
]
// npm test/start work without "run"; everything else needs run <script>.
const NPM_SHORTHANDS = new Set(['test', 'start', 'stop', 'restart'])

const failures = []
const warnings = []
const fail = (check, detail) => failures.push(`FAIL ${check}: ${detail}`)
const warn = (check, detail) => warnings.push(`WARN ${check}: ${detail}`)

function parseArgs(argv) {
  let root = process.cwd()
  let input = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = argv[++i]
    else if (input === null) input = argv[i]
    else usage(`unexpected argument: ${argv[i]}`)
  }
  if (!input) usage('missing spec argument')
  if (!root || !existsSync(root)) usage(`--root does not exist: ${root}`)
  return { root: resolve(root), input }
}

function usage(msg) {
  process.stderr.write(`spec-lint: ${msg}\nusage: node spec-lint.mjs [--root <project-dir>] <spec.json | ->\n`)
  process.exit(2)
}

function readSpec(input) {
  const raw = input === '-' ? readFileSync(0, 'utf8') : readFileSync(input, 'utf8')
  try {
    return JSON.parse(raw)
  } catch (e) {
    usage(`spec is not valid JSON (${e.message})`)
  }
}

function lineCount(path) {
  return readFileSync(path, 'utf8').split('\n').length
}

function checkFields(spec) {
  for (const f of REQUIRED_FIELDS) {
    if (!(f in spec)) fail('fields', `missing required field "${f}"`)
  }
}

function checkFilesInScope(spec, root) {
  for (const p of spec.files_in_scope || []) {
    if (typeof p !== 'string' || !p.trim()) {
      fail('files_in_scope', `empty or non-string entry: ${JSON.stringify(p)}`)
      continue
    }
    if (/[*?[\]{}]/.test(p)) {
      fail('files_in_scope', `"${p}" is a glob — the spec requires concrete paths`)
      continue
    }
    if (/\s/.test(p)) {
      fail('files_in_scope', `"${p}" contains whitespace — looks like prose, not a path`)
      continue
    }
    const abs = isAbsolute(p) ? p : resolve(root, p)
    if (existsSync(abs)) continue
    if (existsSync(dirname(abs))) warn('files_in_scope', `"${p}" does not exist — treated as a new file (parent dir exists)`)
    else fail('files_in_scope', `"${p}" does not exist and neither does its parent directory`)
  }
}

// Lint path references in discovery_context. `dir/file.ext:123` (with a
// slash) must resolve and the line must be within the file; slash-less
// `file.ext:123` only warns (could be a basename or a memory-dir file).
function checkDiscoveryRefs(spec, root) {
  const ctx = String(spec.discovery_context || '')
  if (!ctx || ctx.trim() === 'none') {
    if ((spec.files_in_scope || []).length > 0) {
      warn('discovery_context', 'empty/none while files_in_scope is non-empty — the coder starts blind')
    }
    return
  }
  const refs = ctx.matchAll(/(?<![\w@:/])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]{1,8}):(\d+)/g)
  for (const [, path, line] of refs) {
    const hasDir = path.includes('/')
    const abs = resolve(root, path)
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      if (hasDir) fail('discovery_context', `cited ${path}:${line} — file does not exist`)
      else warn('discovery_context', `cited ${path}:${line} — file not found from project root (basename-only reference?)`)
      continue
    }
    const lines = lineCount(abs)
    if (Number(line) > lines) fail('discovery_context', `cited ${path}:${line} — file has only ${lines} lines`)
  }
  const bare = ctx.matchAll(/(?<![\w@:/.])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]{1,8})(?![\w:])/g)
  for (const [, path] of bare) {
    const abs = resolve(root, path)
    if (!existsSync(abs)) fail('discovery_context', `mentions ${path} — file does not exist`)
  }
}

function onPath(cmd) {
  if (cmd.includes('/')) return existsSync(cmd)
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    try {
      accessSync(join(dir, cmd), constants.X_OK)
      return true
    } catch { /* keep looking */ }
  }
  return false
}

function packageScripts(root) {
  const p = join(root, 'package.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')).scripts || {}
  } catch {
    return null
  }
}

function checkValidationCommands(spec, root) {
  const scripts = packageScripts(root)
  for (const cmd of spec.validation_commands || []) {
    const tokens = String(cmd).trim().split(/\s+/).filter((t) => !/^[A-Z_][A-Z0-9_]*=/.test(t))
    if (!tokens.length) {
      fail('validation_commands', `empty command: ${JSON.stringify(cmd)}`)
      continue
    }
    const [bin, sub, scriptName] = tokens
    if (['npm', 'pnpm'].includes(bin)) {
      const name = sub === 'run' ? scriptName : NPM_SHORTHANDS.has(sub) ? sub : null
      if (name) {
        if (scripts === null) fail('validation_commands', `"${cmd}" — no readable package.json at project root`)
        else if (!(name in scripts)) fail('validation_commands', `"${cmd}" — script "${name}" not in package.json`)
        continue
      }
    }
    if (bin === 'yarn' && sub === 'run' && scriptName) {
      if (scripts === null) fail('validation_commands', `"${cmd}" — no readable package.json at project root`)
      else if (!(scriptName in scripts)) fail('validation_commands', `"${cmd}" — script "${scriptName}" not in package.json`)
      continue
    }
    if (!onPath(bin)) fail('validation_commands', `"${cmd}" — "${bin}" not found on PATH`)
  }
}

const { root, input } = parseArgs(process.argv.slice(2))
const spec = readSpec(input)

checkFields(spec)
checkFilesInScope(spec, root)
checkDiscoveryRefs(spec, root)
checkValidationCommands(spec, root)

for (const line of [...failures, ...warnings]) process.stdout.write(line + '\n')
process.stdout.write(`spec-lint: ${failures.length ? 'FAIL' : 'PASS'} (${failures.length} failure(s), ${warnings.length} warning(s))\n`)
process.exit(failures.length ? 1 : 0)
