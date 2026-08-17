#!/usr/bin/env node
// Staged structural codemod. propose -> stage; apply --resolve "<reason>" ->
// write. The accept gate is checked BEFORE the binary is resolved or spawned,
// so a refused apply provably runs ast-grep zero times.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const REMEDIATION = 'ast-grep is required. Install: brew install ast-grep (or set AST_GREP_BIN to its path)'
const DEFAULT_STAGE = '.agents/skills/ast-grep-codemod/.stage/proposal.json'

function repoRoot() {
  let dir = resolve(process.cwd())
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const up = dirname(dir)
    if (up === dir) return resolve(process.cwd())
    dir = up
  }
}

function parseArgs(argv) {
  const flags = {}
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) flags[arg.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true
    else rest.push(arg)
  }
  return { flags, rest }
}

function die(code, message) {
  console.error(message)
  process.exit(code)
}

// Returns { command, prefix } or exits 3 with remediation. A .mjs bin is run
// through this node executable — the offline fixture seam.
function resolveBinary() {
  const configured = process.env.AST_GREP_BIN
  const candidates = configured ? [configured] : ['ast-grep', 'sg']
  for (const candidate of candidates) {
    const prefix = candidate.endsWith('.mjs') ? [process.execPath] : []
    if (candidate.includes('/') && !candidate.endsWith('.mjs') && !existsSync(candidate)) continue
    if (candidate.endsWith('.mjs') && !existsSync(candidate)) continue
    const probe = spawnSync(prefix[0] || candidate, [...prefix.slice(1), ...(prefix.length ? [candidate] : []), '--version'], { encoding: 'utf8' })
    if (!probe.error && probe.status === 0) return { command: prefix[0] || candidate, prefix: prefix.length ? [candidate] : [] }
  }
  die(3, REMEDIATION)
}

function runBinary(bin, args) {
  return spawnSync(bin.command, [...bin.prefix, ...args], { encoding: 'utf8', cwd: repoRoot() })
}

const { flags, rest } = parseArgs(process.argv.slice(3))
const verb = process.argv[2]
const stagePath = process.env.CODEMOD_STAGE || join(repoRoot(), DEFAULT_STAGE)

if (verb === 'propose') {
  const pattern = typeof flags.pattern === 'string' ? flags.pattern : ''
  const rewrite = typeof flags.rewrite === 'string' ? flags.rewrite : ''
  if (!pattern || !rewrite) die(2, 'expected --pattern <p> and --rewrite <r>, found none')
  const lang = typeof flags.lang === 'string' ? flags.lang : 'js'
  const paths = rest.length ? rest : ['.']
  const bin = resolveBinary()
  const result = runBinary(bin, ['run', '--lang', lang, '--pattern', pattern, '--rewrite', rewrite, ...paths])
  if (result.error || result.status !== 0) die(3, REMEDIATION)
  const diff = `${result.stdout || ''}`
  const hits = diff.split('\n').filter((line) => line.startsWith('@@')).length
  mkdirSync(dirname(stagePath), { recursive: true })
  writeFileSync(stagePath, `${JSON.stringify({ pattern, rewrite, lang, paths, hits, diff }, null, 2)}\n`)
  console.log(diff.trim() || `0 matches for ${pattern}`)
  console.log(`staged ${hits} rewrite(s) at ${stagePath} — apply with: apply --resolve "<reason>"`)
  process.exit(0)
}

if (verb === 'apply') {
  // The accept gate, first and before any spawn: no reason, no rewrite.
  const reason = typeof flags.resolve === 'string' ? flags.resolve.trim() : ''
  if (!reason) die(2, 'expected --resolve "<reason>", found none — a staged codemod applies only on an explicit resolve-with-reason')
  if (!existsSync(stagePath)) die(2, `expected a staged proposal, found nothing, at ${stagePath} — run propose first`)
  let staged
  try {
    staged = JSON.parse(readFileSync(stagePath, 'utf8'))
  } catch (err) {
    die(2, `expected a readable staged proposal, found ${err.message}, at ${stagePath}`)
  }
  if (!staged.pattern || !staged.rewrite) die(2, `expected the stage to record pattern and rewrite, found ${JSON.stringify(staged)}, at ${stagePath}`)
  const bin = resolveBinary()
  const check = runBinary(bin, ['run', '--lang', staged.lang, '--pattern', staged.pattern, '--rewrite', staged.rewrite, ...staged.paths])
  if (check.error || check.status !== 0) die(3, REMEDIATION)
  const hits = `${check.stdout || ''}`.split('\n').filter((line) => line.startsWith('@@')).length
  if (hits !== staged.hits) die(2, `expected ${staged.hits} match(es) as staged, found ${hits} — the tree moved under the proposal, re-propose`)
  const applied = runBinary(bin, ['run', '--lang', staged.lang, '--pattern', staged.pattern, '--rewrite', staged.rewrite, '--update-all', ...staged.paths])
  if (applied.error || applied.status !== 0) die(3, REMEDIATION)
  appendFileSync(`${stagePath}.log`, `${JSON.stringify({ reason, hits: staged.hits, paths: staged.paths })}\n`)
  console.log(`applied ${staged.hits} rewrite(s); reason: ${reason}`)
  process.exit(0)
}

die(2, `expected propose|apply, found ${JSON.stringify(verb ?? null)}`)
