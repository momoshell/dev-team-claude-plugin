import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ROOT } from './helpers.mjs'

const read = (path) => readFileSync(join(ROOT, path), 'utf8')
const lineCount = (text) => text === '' ? 0 : text.split('\n').length - Number(text.endsWith('\n'))
const files = (dir) => readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(ROOT.length + 1))
const prose = [...files('skills').filter((p) => p.endsWith('.md')),
  ...files('commands').filter((p) => /^commands\/[^/]+\.md$/.test(p)),
  ...files('crew/agents').filter((p) => /^crew\/agents\/[^/]+\.md$/.test(p)),
  'README.md', 'crew/README.md', 'CLAUDE.md', 'docs/conventions.md']
const register = read('docs/adr/README.md')
const adrFiles = files('docs/adr')

// Skip quoted strings and templates before extracting line and block comments.
const commentsIn = (source) => [...source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g)]
  .map((match) => match[0]).filter((token) => token.startsWith('//') || token.startsWith('/*')).join('\n')

// This resolves references, not behaviour described in prose.
const scan = (documents, sources) => {
  const errors = []
  const checkAdr = (file, text) => {
    for (const match of text.matchAll(/\bADR-(\d{3})(?:\s+(phase|section)\s+(\d+)|\s+§(\d+))?/gi)) {
      const [, number, kind, n, section] = match
      if (!new RegExp(`^\\| ${number} \\|`, 'm').test(register)) {
        errors.push(`${file}: ADR-${number} missing from register`)
        continue
      }
      const locator = n || section
      if (!locator) continue
      const adr = adrFiles.find((p) => p.includes(`/adr-${number}-`))
      if (!adr) { errors.push(`${file}: ADR-${number} locator has no document`); continue }
      const body = read(adr)
      const pattern = kind?.toLowerCase() === 'phase'
        ? new RegExp(`\\bphase\\s+${locator}\\b`, 'i')
        : new RegExp(`^#{1,6}\\s+${locator}\\.`, 'm')
      if (!pattern.test(body)) errors.push(`${file}: ADR-${number} ${kind || 'section'} ${locator} missing`)
    }
  }
  for (const [file, text] of documents) {
    checkAdr(file, text)
    for (const match of text.matchAll(/`([^`\n]+)`/g)) {
      const token = match[1]
      if (/[<~$*{}]/.test(token)) continue
      const citation = /^((?:[\w.-]+\/)*[\w.-]+\/?)(?::(\d+))?$/.exec(token)
      if (!citation) continue
      const path = citation[1]
      const first = path.split('/')[0]
      // Bare filenames can also be relative links, task artifacts or external sources.
      if (!path.includes('/') && !/^[\w.-]+\.(?:md|mjs|js|ts|json)$/.test(path)) continue
      if (path === 'plan.md' && file === 'crew/agents/planner.md') continue
      if (path === 'vercel-web-interface-guidelines.md' && /\/references\/sources\.md$/.test(file)) continue
      // Runtime envelopes, teaching examples and a retired script are not repo paths.
      if ((file === 'skills/qa-test-writing/references/dev-team-evidence.md' && ['builder-2.json', 'reviewer-1.json'].includes(path)) ||
          (file === 'skills/qa-test-writing/references/node-test.md' && ['math.mjs', 'math.test.mjs'].includes(path)) ||
          (file === 'skills/qa-test-writing/references/vitest.md' && ['math.ts', 'math.test.ts'].includes(path)) ||
          (file === 'docs/conventions.md' && path === 'spec-lint.mjs')) continue
      // These are Git refs, runtime artifacts, example-project paths or import specifiers, not repo paths.
      if ((path === 'origin/HEAD' && file === 'skills/crew-onboard/SKILL.md') ||
          (path === 'origin/main' && ['skills/devops/SKILL.md', 'commands/review.md'].includes(file)) ||
          (path === 'task/lean.json' && file === 'skills/crew-recovery/SKILL.md') ||
          (path === 'src/' && ['skills/test-economy/SKILL.md', 'crew/agents/planner.md'].includes(file)) ||
          (path === 'src/lib.rs' && file === 'skills/qa-test-writing/references/cargo-test.md') ||
          (path === 'node_modules/' && file === 'skills/qa-test-writing/references/dev-team-evidence.md') ||
          (path === 'dist/' && file === 'CLAUDE.md') ||
          (['../../adapters/adapter-pi.mjs', '../context-layout.mjs'].includes(path) && file === 'skills/backend-node/references/zero-dep.md')) continue
      let target = resolve(ROOT, (first === 'pi' && file === 'crew/README.md') || (path === 'acp/' && ['README.md', 'crew/README.md'].includes(file)) ? `crew/${path}` : path)
      if (!path.includes('/') && !existsSync(target) && existsSync(resolve(ROOT, dirname(file), path))) target = resolve(ROOT, dirname(file), path)
      // These prose passages name the containing directory separately.
      if (!existsSync(target) && !path.includes('/')) {
        const base = file === 'README.md' && path === 'plugin.json' ? '.claude-plugin'
          : file === 'README.md' && ['start.mjs', 'lean.mjs', 'loop.mjs', 'proof.mjs', 'checks.mjs', 'agents.mjs', 'protocols.mjs', 'acp-client.mjs'].includes(path) ? 'crew'
          : ['skills/pr-review/references/findings-shape.md', 'skills/pr-review/references/rubric.md'].includes(file) && path === 'scout.json' ? 'crew/pi/agents'
          : file === 'docs/conventions.md' && path === 'adapter-claude.mjs' ? 'crew/adapters' : null
        if (base) target = resolve(ROOT, base, path)
      }
      if (first === 'references') {
        const skill = /^skills\/[^/]+/.exec(file)?.[0]
        if (!skill) continue
        target = resolve(ROOT, skill, path)
      }
      if (!existsSync(target)) { errors.push(`${file}: missing path ${path}`); continue }
      if (citation[2] && statSync(target).isFile() && Number(citation[2]) > lineCount(readFileSync(target, 'utf8'))) errors.push(`${file}: ${token} past EOF`)
    }
    for (const match of text.matchAll(/\b((?:[\w.-]+\/)*[\w.-]+\.[\w.-]+):(\d+)\b/g)) {
      const [, path, line] = match
      if (existsSync(join(ROOT, path)) && statSync(join(ROOT, path)).isFile() && Number(line) > lineCount(read(path))) errors.push(`${file}: ${path}:${line} past EOF`)
    }
    const checkSymbol = (raw, path) => {
      const symbol = raw.replace(/\(.*/, '')
      if (!/\.(?:mjs|js|ts|svelte)$/.test(path)) return
      if (!existsSync(join(ROOT, path))) errors.push(`${file}: ${symbol} references missing ${path}`)
      else if (!new RegExp(`(?<![\\w$])${symbol.replace(/[$]/g, '\\$&')}(?![\\w$])`).test(read(path))) errors.push(`${file}: ${symbol} absent from ${path}`)
    }
    // Resolve explicit associations in either order, not unrelated tokens in a sentence.
    for (const match of text.matchAll(/`([A-Za-z_$][\w$]*(?:\([^`]*\))?)`\s+(?:(?:in|from)\s+|\(\s*)`((?:[\w.-]+\/)+[\w.-]+)(?::\d+)?`/g)) checkSymbol(match[1], match[2])
    for (const match of text.matchAll(/`((?:[\w.-]+\/)+[\w.-]+\.(?:mjs|js|ts|svelte))(?::\d+)?`(?:\s*,\s*|\s*\(\s*|\s+\(its\s+|\s+)`([A-Za-z_$][\w$]*)`/g)) checkSymbol(match[2], match[1])
  }
  for (const [file, text] of sources) checkAdr(file, commentsIn(text))
  return errors
}

test('reference resolver finds no stale citation in the swept prose', () => {
  const sources = ['crew', 'bin', 'scripts', 'hooks'].flatMap((dir) => files(dir).filter((p) => /\.(?:mjs|ts|js)$/.test(p)))
  assert.deepEqual(scan(prose.map((p) => [p, read(p)]), sources.map((p) => [p, read(p)])), [])
})

test('reference resolver rejects missing root Markdown paths and past-EOF citations', () => {
  for (const [text, expected] of [
    ['`README.md:999999`', /README\.md:999999 past EOF/],
    ['`missing-root-reference.md`', /missing path missing-root-reference\.md/],
    ['`missing-root-reference.mjs`', /missing path missing-root-reference\.mjs/],
    ['`missing-dir/file.mjs`', /missing path missing-dir\/file\.mjs/],
    ['README.md:999999', /README\.md:999999 past EOF/],
    ['`DefinitelyMissingSymbol` in `crew/loop.mjs:25`', /DefinitelyMissingSymbol absent from crew\/loop\.mjs/],
    ['`DefinitelyMissingSymbol` (`crew/loop.mjs`)', /DefinitelyMissingSymbol absent from crew\/loop\.mjs/],
    ['`DefinitelyMissingSymbol` (`crew/loop.mjs:25`)', /DefinitelyMissingSymbol absent from crew\/loop\.mjs/],
    ['`crew/loop.mjs:25` `DefinitelyMissingSymbol`', /DefinitelyMissingSymbol absent from crew\/loop\.mjs/],
  ]) assert.match(scan([['README.md', text]], []).join('\n'), expected)
})

test('reference resolver scans trailing ADR comments but not string contents', () => {
  const source = `const url = "https://example.org/ADR-999"; const text = '/* ADR-999 */'; const tpl = \`// ADR-999\`;
const limit = 1 // ADR-998
/* ADR-997 */`
  const errors = scan([], [['crew/example.mjs', source]]).join('\n')
  assert.match(errors, /ADR-998 missing from register/)
  assert.match(errors, /ADR-997 missing from register/)
  assert.doesNotMatch(errors, /ADR-999/)
})

test('adr register records the ADR-050 and ADR-055 amendment notes', () => {
  const entry = (id) => register.split('\n').find((line) => line.startsWith(`| ${id} |`))
  for (const [id, patterns] of [
    ['050', [/amendment/i, /147-150/, /skill-gate\.mjs/, /deny `main`/, /DEVTEAM_WORKER/, /builderloop\.ts/, /no longer exists/]],
    ['055', [/amendment/i, /§10/, /map-grant/, /tech-lead/, /builder/, /reviewer/, /crew\/lean\.mjs/]],
  ]) for (const pattern of patterns) assert.match(entry(id), pattern)
})
