#!/usr/bin/env node
// Mechanical Handover Spec lint — the checkable half of handover-spec.md's
// self-check. Verifies what a machine can verify (schema shape, paths
// exist, cited file:line references resolve, validation commands are
// runnable) so the orchestrator's pre-dispatch eyeball only has to cover
// the semantic half (symbols named, gotchas, interface_contract ownership).
//
// Library surface: lintSpec(spec, root) -> { ok, failures, warnings } is a
// pure function — no I/O beyond reading the (memoized) schema and noise-glob
// data, never writes to stdout/stderr, never calls process.exit. main(argv)
// is the CLI wrapper: parse -> lint -> print -> exit code.
//
// usage: node spec-lint.mjs [--root <project-dir>] [--json] <spec.json | ->
//   spec.json  a Handover Spec as JSON (handover-spec.schema.json shape)
//   -          read the spec JSON from stdin
//   --json     emit one JSON line on stdout ({ok, failures, warnings});
//              human FAIL/WARN lines and the summary go to stderr instead.
//
// Exit 0 = PASS (warnings allowed), exit 1 = FAIL, exit 2 = usage/parse/tool error.
// New files are legal: a missing files_in_scope path whose parent directory
// exists is a warning ("treated as new file"), not a failure.
import { readFileSync, existsSync, statSync, accessSync, constants, realpathSync } from 'node:fs'
import { resolve, dirname, delimiter, join, isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validate } from './cmux/contract.mjs'

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

// The schema and noise-glob data are read lazily and memoized below — a
// bare import of this module performs no I/O.
const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = resolve(HERE, '..', 'handover-spec.schema.json')
const NOISE_GLOBS_PATH = resolve(HERE, 'noise-globs.json')

// realpathOr(path) -> string — realpath both sides of the direct-invocation
// check (and of the in-root containment check in checkAbsoluteFileLineRef):
// the ESM loader realpaths import.meta.url while argv[1] stays literal, so
// under a symlinked path component (macOS TMPDIR is /var -> /private/var) a
// literal compare is silently false and the CLI no-ops.
function realpathOr(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

let _schema = null
function loadSchema() {
  if (_schema) return _schema
  let raw
  try {
    raw = readFileSync(SCHEMA_PATH, 'utf8')
  } catch (e) {
    throw new Error(`spec-lint: cannot read handover-spec schema at ${SCHEMA_PATH}: ${e.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`spec-lint: handover-spec schema at ${SCHEMA_PATH} is not valid JSON: ${e.message}`)
  }
  // Well-formed-but-wrong is a contract-author error too: a schema reduced
  // to `{}` (interrupted write, bad merge, truncated checkout) parses fine
  // and would otherwise validate() everything as [] — zero violations,
  // silently. Assert the two shapes every check actually depends on.
  const hasRequired = Array.isArray(parsed.required) && parsed.required.length > 0 && parsed.required.every((k) => typeof k === 'string')
  const hasProperties = parsed.properties !== null && typeof parsed.properties === 'object' && !Array.isArray(parsed.properties)
  if (!hasRequired || !hasProperties) {
    throw new Error(`spec-lint: handover-spec schema at ${SCHEMA_PATH} is missing a well-formed "required"/"properties" shape`)
  }
  _schema = parsed
  return _schema
}

let _noiseGlobs = null
function loadNoiseGlobs() {
  if (_noiseGlobs) return _noiseGlobs
  let raw
  try {
    raw = readFileSync(NOISE_GLOBS_PATH, 'utf8')
  } catch (e) {
    throw new Error(`spec-lint: cannot read noise globs at ${NOISE_GLOBS_PATH}: ${e.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`spec-lint: noise globs at ${NOISE_GLOBS_PATH} is not valid JSON: ${e.message}`)
  }
  // Never degrade a shape drift to an empty (silently permissive) list —
  // noise-globs.json is owned by a different issue; a renamed key or a
  // wrapper-object change here must throw, not quietly disable every WARN.
  if (!Array.isArray(parsed?.globs) || !parsed.globs.every((g) => typeof g === 'string')) {
    throw new Error(`spec-lint: noise globs at ${NOISE_GLOBS_PATH} do not have the expected {"globs": string[]} shape`)
  }
  _noiseGlobs = parsed.globs
  return _noiseGlobs
}

// git-pathspec-ish translation: '*' and '?' are the only wildcards, '*'
// CROSSES '/' (translated to '.*', which matches slashes too), and the
// whole pattern is anchored — which is exactly what makes a slash-less
// pattern ("dist/**", "package-lock.json") match only at the project root:
// an anchored regex with no leading wildcard cannot match a nested path.
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const pattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${pattern}$`)
}

function matchesNoiseGlob(p) {
  for (const g of loadNoiseGlobs()) {
    if (globToRegExp(g).test(p)) return g
  }
  return null
}

// A usage/parse/tool error, tagged so main's catch can map it to exit 2
// without conflating it with an unexpected internal throw (e.g. a corrupt
// schema, also mapped to 2 today, but kept as a distinct class in case that
// ever needs its own convention).
class UsageError extends Error {}

function parseArgs(argv) {
  let root = process.cwd()
  let input = null
  let json = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = argv[++i]
    else if (argv[i] === '--json') json = true
    else if (input === null) input = argv[i]
    else usage(`unexpected argument: ${argv[i]}`)
  }
  if (!input) usage('missing spec argument')
  if (!root || !existsSync(root)) usage(`--root does not exist: ${root}`)
  return { root: resolve(root), input, json }
}

// Never calls process.exit directly — throws so main's try/catch maps it to
// exit 2. Never called from lintSpec (only from parseArgs/readSpec, both of
// which run inside main's try).
function usage(msg) {
  throw new UsageError(`spec-lint: ${msg}\nusage: node spec-lint.mjs [--root <project-dir>] [--json] <spec.json | ->`)
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

// A citation's first path segment looking like a domain (contains a dot,
// e.g. "github.com", "api.example.com") means it's almost certainly a URL
// fragment, not a repo-relative path — skip rather than false-FAIL on it.
function looksLikeDomain(path) {
  return path.split('/')[0].includes('.')
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

// readValidateFullCommand(root) -> string | null. Per-project INSTANCE data
// (unlike loadSchema/loadNoiseGlobs, which read PACKAGED plugin assets) —
// must never throw for any input (absent file, unreadable file, directory
// in place of a file, no "## validate" heading, no fenced block, no "full:"
// line, empty value all return null) and must NEVER be memoized: a
// memoized value would leak across two lintSpec calls with different roots
// in one process (see the CROSS-CONTAMINATION test).
function readValidateFullCommand(root) {
  let raw
  try {
    raw = readFileSync(join(root, '.claude', 'dev-team', 'config.md'), 'utf8')
  } catch {
    return null
  }
  const headingMatch = /^##\s+validate\s*$/m.exec(raw)
  if (!headingMatch) return null
  const rest = raw.slice(headingMatch.index + headingMatch[0].length)
  const nextHeadingMatch = /^##\s/m.exec(rest)
  const section = nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest
  const fenceMatch = /```[^\n]*\n([\s\S]*?)```/.exec(section)
  if (!fenceMatch) return null
  // First "full:" wins on a duplicate — this reader is advisory, so
  // ambiguity degrades to the first value rather than refusing (the
  // opposite of readExecutionMode's refuse-on-ambiguity, which gates a
  // real dispatch).
  const fullMatch = /^\s*full:\s*(.+)$/m.exec(fenceMatch[1])
  if (!fullMatch) return null
  const value = fullMatch[1].trim()
  return value || null
}

// lintSpec(spec, root) -> { ok, failures, warnings }. Pure with respect to
// process state — no stdout/stderr, no process.exit. The accumulators live
// in this call's own closure so two calls in one process cannot
// cross-contaminate. Throws only for a packaging/contract-author error
// (schema or noise-globs.json missing/corrupt); instance data problems are
// always returned as diagnostics, never thrown.
export function lintSpec(spec, root) {
  const resolvedRoot = resolve(root)
  const failures = []
  const warnings = []
  const fail = (check, detail) => failures.push({ check, detail })
  const warn = (check, detail) => warnings.push({ check, detail })

  function checkSchema(spec) {
    const schema = loadSchema()
    for (const v of validate(schema, spec)) {
      fail('schema', `${v.path}: ${v.message}`)
    }
  }

  function checkFilesInScope(spec, root) {
    // A non-array files_in_scope (e.g. a bare string) is already reported by
    // checkSchema (type violation) — iterating it with for...of would walk
    // a string character-by-character, producing spurious per-character
    // diagnostics.
    if (!Array.isArray(spec.files_in_scope)) return
    for (const p of spec.files_in_scope) {
      // Non-string entries are already reported by checkSchema (type
      // violation) — reporting them again here would double-count.
      if (typeof p !== 'string') continue
      if (!p.trim()) {
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
      const noiseGlob = matchesNoiseGlob(p)
      if (noiseGlob) {
        warn('files_in_scope', `"${p}" matches noise glob "${noiseGlob}" — the QA gate will not filter it; name it here only if editing it is the point`)
      }
      const abs = isAbsolute(p) ? p : resolve(root, p)
      if (existsSync(abs)) continue
      if (existsSync(dirname(abs))) warn('files_in_scope', `"${p}" does not exist — treated as a new file (parent dir exists)`)
      else fail('files_in_scope', `"${p}" does not exist and neither does its parent directory`)
    }
  }

  // Lint path references in discovery_context.
  //   dir/file.ext:123   relative to --root; must resolve, line must be in range.
  //   /dir/file.ext:123  a leading "/" carries two possible meanings — project-
  //                      root-relative (kept first, for backward compatibility)
  //                      and filesystem-absolute — see checkAbsoluteFileLineRef.
  //   file.ext:123       slash-less: only warns (could be a basename/memory-dir ref).
  //   dir/file.ext       (no line number) bare mention — governed by the same
  //                      exists / missing-with-parent / missing-without-parent
  //                      table as a citation, minus the line-count check.
  //
  // Existence table (the ONE retained FAIL is missing-path-with-missing-parent;
  // every other previously-FAIL branch is now a WARN — softened, never silent):
  //   path exists                             -> no diagnostic (line still checked)
  //   missing, parent directory exists        -> WARN (treated as not-yet-created)
  //   missing, parent directory missing       -> FAIL (retained)
  //   line number exceeds current line count  -> WARN
  //   slash-less basename not found from root -> WARN (unchanged)
  function checkDiscoveryRefs(spec, root) {
    const ctx = String(spec.discovery_context || '')
    if (!ctx || ctx.trim() === 'none') {
      if ((spec.files_in_scope || []).length > 0) {
        warn('discovery_context', 'empty/none while files_in_scope is non-empty — the coder starts blind')
      }
      return
    }

    // The ONE retained FAIL path for discovery_context: a missing path whose
    // parent directory is ALSO missing. Every other missing-path branch
    // (citation or bare mention) routes through this single function, so
    // "discovery_context retains exactly one FAIL" is structural — there is
    // exactly one fail() call site to remove, not three independent ones.
    function reportMissingPath(prefix, label, parentExists) {
      if (parentExists) {
        warn('discovery_context', `${prefix} ${label} — file does not exist (parent directory exists — treated as a not-yet-created file)`)
      } else {
        fail('discovery_context', `${prefix} ${label} — file does not exist and neither does its parent directory`)
      }
    }

    function checkFileLineRef(label, abs, line) {
      const hasDir = label.includes('/')
      if (hasDir && !label.startsWith('/') && looksLikeDomain(label)) return
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        if (!hasDir) {
          warn('discovery_context', `cited ${label}:${line} — file not found from project root (basename-only reference?)`)
          return
        }
        reportMissingPath('cited', `${label}:${line}`, existsSync(dirname(abs)))
        return
      }
      const lines = lineCount(abs)
      if (Number(line) > lines) warn('discovery_context', `cited ${label}:${line} — file has only ${lines} lines (stale citation)`)
    }

    // A leading "/" citation is checked under BOTH meanings: root-relative
    // (rootJoined, kept first for backward compatibility) and filesystem-
    // absolute (fsAbs). The two meanings agree for the common case of an
    // in-root citation, so this only changes behavior for a genuinely
    // filesystem-absolute path (e.g. one copied from a shell prompt).
    function checkAbsoluteFileLineRef(path, root, line) {
      const label = '/' + path
      const rootJoined = resolve(root, path)
      const fsAbs = '/' + path

      if (existsSync(rootJoined) && statSync(rootJoined).isFile()) {
        const lines = lineCount(rootJoined)
        if (Number(line) > lines) warn('discovery_context', `cited ${label}:${line} — file has only ${lines} lines (stale citation)`)
        return
      }

      if (existsSync(fsAbs) && statSync(fsAbs).isFile()) {
        const r = relative(realpathOr(root), realpathOr(fsAbs))
        const inRoot = r !== '' && !r.startsWith('..') && !isAbsolute(r)
        if (inRoot) {
          const lines = lineCount(fsAbs)
          if (Number(line) > lines) warn('discovery_context', `cited ${label}:${line} — file has only ${lines} lines (stale citation)`)
        } else {
          warn('discovery_context', `cited ${label}:${line} — resolves outside the project root; not verifiable from here`)
        }
        return
      }

      // Neither interpretation resolved to a real file — a citation is
      // "present" (WARN, not FAIL) if either interpretation's parent exists.
      reportMissingPath('cited', `${label}:${line}`, existsSync(dirname(rootJoined)) || existsSync(dirname(fsAbs)))
    }

    function checkBareMention(path, abs) {
      if (looksLikeDomain(path)) return
      if (existsSync(abs)) return
      reportMissingPath('mentions', path, existsSync(dirname(abs)))
    }

    // Citation passes run first and record the character span each match
    // claims; the bare-mention pass below skips anything overlapping a
    // claimed span (5c) — a mention carrying a line number is a citation,
    // already handled here, and the bare pass exists only for mentions no
    // citation pass claimed. Order matters: do not reorder or merge these.
    const claimedSpans = []

    for (const m of ctx.matchAll(/(?<![\w@:./-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]{1,8}):(\d+)/g)) {
      const [full, path, line] = m
      claimedSpans.push([m.index, m.index + full.length])
      checkFileLineRef(path, resolve(root, path), line)
    }

    for (const m of ctx.matchAll(/(?<![\w@:./-])\/((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]{1,8}):(\d+)/g)) {
      const [full, path, line] = m
      claimedSpans.push([m.index, m.index + full.length])
      checkAbsoluteFileLineRef(path, root, line)
    }

    for (const m of ctx.matchAll(/(?<![\w@:./-])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]{1,8})(?![\w:])/g)) {
      const [full, path] = m
      const s = m.index
      const e = m.index + full.length
      if (claimedSpans.some(([cs, ce]) => s < ce && e > cs)) continue
      checkBareMention(path, resolve(root, path))
    }
  }

  function checkValidationCommands(spec, root) {
    // Same reasoning as checkFilesInScope's guard: a non-array
    // validation_commands is already a schema violation; don't also iterate
    // it character-by-character if it happens to be a string.
    if (!Array.isArray(spec.validation_commands)) return
    const scripts = packageScripts(root)
    for (const cmd of spec.validation_commands) {
      // Non-string entries are already reported by checkSchema.
      if (typeof cmd !== 'string') continue
      const tokens = cmd.trim().split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t))
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

  // The config-side value is compared trimmed only, never re-tokenized —
  // odd internal whitespace in config.md yields a false NEGATIVE (silence)
  // rather than a false positive, the safe direction for an advisory check.
  function checkValidationLane(spec, root) {
    if (!Array.isArray(spec.validation_commands)) return
    const full = readValidateFullCommand(root)
    if (!full) return
    for (const cmd of spec.validation_commands) {
      if (typeof cmd !== 'string') continue
      const tokens = cmd.trim().split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t))
      if (!tokens.length) continue
      if (tokens.join(' ') === full) {
        warn('validation_lane', `"${cmd}" matches config.validate.full verbatim — the full suite runs once at /dev-team:ship, not per coder; use the scoped fast lane narrowed to files_in_scope instead`)
      }
    }
  }

  // check (b) treats exactly two things as ownership signals — a test file
  // in files_in_scope, and the literal substring 'dev-team:test-engineer' in
  // any criterion (ADR-025) — never a schema field. At most one diagnostic
  // per spec.
  function checkTestOwnership(spec) {
    if (!Array.isArray(spec.acceptance_criteria)) return
    let mentionsTest = false
    let namesGateOwner = false
    for (const c of spec.acceptance_criteria) {
      if (typeof c !== 'string') continue
      if (c.includes('dev-team:test-engineer')) namesGateOwner = true
      const stripped = c.replace(/"[^"]*"|`[^`]*`/g, ' ')
      if (/\b(test|tests|testing|coverage|tested)\b/i.test(stripped)) mentionsTest = true
    }
    if (!mentionsTest || namesGateOwner) return
    const hasTestFile = Array.isArray(spec.files_in_scope) && spec.files_in_scope.some((p) => {
      if (typeof p !== 'string') return false
      return /(^|\/)(tests?|__tests__)\//i.test(p) ||
        /(^|\/)[^/]*\.(test|spec)\.[A-Za-z0-9]+$/i.test(p) ||
        /(^|\/)test_[^/]*\.[A-Za-z0-9]+$/i.test(p) ||
        /(^|\/)[^/]*_test\.[A-Za-z0-9]+$/i.test(p)
    })
    if (hasTestFile) return
    warn('test_ownership', 'acceptance_criteria mentions test coverage but no owner is named (no test file in files_in_scope, and dev-team:test-engineer not named) — see handover-spec.md\'s completeness checklist')
  }

  checkSchema(spec)
  checkFilesInScope(spec, resolvedRoot)
  checkDiscoveryRefs(spec, resolvedRoot)
  checkValidationCommands(spec, resolvedRoot)
  checkValidationLane(spec, resolvedRoot)
  checkTestOwnership(spec)

  return { ok: failures.length === 0, failures, warnings }
}

// main(argv) -> exit code (0 pass, 1 fail, 2 usage/parse/tool error). argv
// excludes 'node' and the script path. Always RETURNS its exit code — never
// calls process.exit itself, so it is safe to call in-process (a future
// consumer) as well as from the invokedDirectly block below.
export function main(argv) {
  try {
    const { root, input, json } = parseArgs(argv)
    const spec = readSpec(input)
    const result = lintSpec(spec, root)
    const humanLines = [
      ...result.failures.map((f) => `FAIL ${f.check}: ${f.detail}`),
      ...result.warnings.map((w) => `WARN ${w.check}: ${w.detail}`),
    ]
    const summary = `spec-lint: ${result.ok ? 'PASS' : 'FAIL'} (${result.failures.length} failure(s), ${result.warnings.length} warning(s))`
    if (json) {
      process.stdout.write(`${JSON.stringify(result)}\n`)
      for (const line of humanLines) process.stderr.write(`${line}\n`)
      process.stderr.write(`${summary}\n`)
    } else {
      for (const line of humanLines) process.stdout.write(`${line}\n`)
      process.stdout.write(`${summary}\n`)
    }
    return result.ok ? 0 : 1
  } catch (err) {
    process.stderr.write(`${err instanceof UsageError ? err.message : err.stack}\n`)
    return 2
  }
}

const invokedDirectly = process.argv[1] && realpathOr(process.argv[1]) === realpathOr(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  // process.exitCode, not process.exit: stdout is a pipe when a consumer
  // spawns this CLI (exactly the A2/B1/orchestrator case), and pipe writes
  // are asynchronous — process.exit() tears the process down before Node
  // flushes the buffer, silently truncating a large --json payload. Setting
  // exitCode lets the event loop drain naturally; no open handles survive
  // readFileSync/readFileSync(0), so the process still exits promptly.
  process.exitCode = main(process.argv.slice(2))
}
