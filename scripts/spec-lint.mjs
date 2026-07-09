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
// npm/pnpm/yarn all support omitting "run" for a script name (npm test,
// yarn lint, pnpm build); anything NOT a recognized package-manager verb is
// treated as a script name and checked against package.json.
const PKG_MGR_VERBS = new Set([
  'run', 'run-script', 'install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall',
  'update', 'up', 'upgrade', 'exec', 'dlx', 'link', 'unlink', 'init', 'create',
  'publish', 'pack', 'audit', 'outdated', 'prune', 'list', 'ls', 'why', 'config',
  'cache', 'doctor', 'login', 'logout', 'whoami', 'view', 'info',
])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn'])

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

// Lines in the file, ignoring one trailing newline (a file ending "a\nb\n"
// is 2 lines, not 3) so a citation of the true last line doesn't false-fail
// and a citation one past it doesn't false-pass.
function lineCount(path) {
  const content = readFileSync(path, 'utf8')
  if (content === '') return 0
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  return body.split('\n').length
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

// A citation's first path segment looking like a domain (contains a dot,
// e.g. "github.com", "api.example.com") means it's almost certainly a URL
// fragment, not a repo-relative path — skip rather than false-FAIL on it.
function looksLikeDomain(path) {
  return path.split('/')[0].includes('.')
}

function checkFileLineRef(label, abs, line) {
  const hasDir = label.includes('/')
  if (hasDir && !label.startsWith('/') && looksLikeDomain(label)) return
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    if (hasDir) fail('discovery_context', `cited ${label}:${line} — file does not exist`)
    else warn('discovery_context', `cited ${label}:${line} — file not found from project root (basename-only reference?)`)
    return
  }
  const lines = lineCount(abs)
  if (Number(line) > lines) fail('discovery_context', `cited ${label}:${line} — file has only ${lines} lines`)
}

// Lint path references in discovery_context.
//   dir/file.ext:123   relative to --root; must resolve, line must be in range.
//   /dir/file.ext:123  a leading "/" is project-root-relative (not a URL —
//                      excluded from matching mid-URL by requiring the "/"
//                      not be preceded by another "/" or a ":").
//   file.ext:123       slash-less: only warns (could be a basename/memory-dir ref).
//   dir/file.ext       (no line number) bare mention — must exist if cited.
function checkDiscoveryRefs(spec, root) {
  const ctx = String(spec.discovery_context || '')
  if (!ctx || ctx.trim() === 'none') {
    if ((spec.files_in_scope || []).length > 0) {
      warn('discovery_context', 'empty/none while files_in_scope is non-empty — the coder starts blind')
    }
    return
  }

  const relRefs = ctx.matchAll(/(?<![\w@:./])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]{1,8}):(\d+)/g)
  for (const [, path, line] of relRefs) {
    checkFileLineRef(path, resolve(root, path), line)
  }

  const absRefs = ctx.matchAll(/(?<![\w@:./])\/((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]{1,8}):(\d+)/g)
  for (const [, path, line] of absRefs) {
    checkFileLineRef('/' + path, resolve(root, path), line)
  }

  const bare = ctx.matchAll(/(?<![\w@:./])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]{1,8})(?![\w:])/g)
  for (const [, path] of bare) {
    if (looksLikeDomain(path)) continue
    const abs = resolve(root, path)
    if (!existsSync(abs)) fail('discovery_context', `mentions ${path} — file does not exist`)
  }
}

function onPath(cmd, root) {
  if (cmd.includes('/')) {
    const abs = isAbsolute(cmd) ? cmd : resolve(root, cmd)
    return existsSync(abs)
  }
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
    const tokens = String(cmd).trim().split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t))
    if (!tokens.length) {
      fail('validation_commands', `empty command: ${JSON.stringify(cmd)}`)
      continue
    }
    const [bin, sub, scriptName] = tokens
    if (PACKAGE_MANAGERS.has(bin) && sub) {
      const name = (sub === 'run' || sub === 'run-script') ? scriptName : (PKG_MGR_VERBS.has(sub) ? null : sub)
      if (name) {
        if (scripts === null) fail('validation_commands', `"${cmd}" — no readable package.json at project root`)
        else if (!(name in scripts)) fail('validation_commands', `"${cmd}" — script "${name}" not in package.json`)
        continue
      }
      // a recognized package-manager verb (install, exec, ...) — just needs the binary, checked below.
    }
    if (!onPath(bin, root)) fail('validation_commands', `"${cmd}" — "${bin}" not found on PATH`)
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
