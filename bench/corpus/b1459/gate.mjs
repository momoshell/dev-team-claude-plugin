import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

// The external artifact's location must never determine the checkout being tested.
const root = process.cwd()
const read = (file) => readFileSync(resolve(root, file), 'utf8')
const flat = (text) => text.replace(/\s+/g, ' ').trim()
function docs(dir) {
  const result = []
  for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`
    if (entry.isDirectory()) result.push(...docs(file))
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push({ file, text: read(file) })
  }
  if (!result.length) throw new Error(`no markdown files under ${dir}`)
  return result
}
function requireDoc(rows, file) {
  const found = rows.find((row) => row.file === file)
  if (!found?.text.trim()) throw new Error(`missing or empty required document ${file}`)
  return found.text
}
const QA = 'skills/qa-test-writing'
const BACKEND = 'skills/backend-node'
const REVIEW = 'skills/pr-review'
const FALSIFICATION = `${REVIEW}/references/falsification.md`
const IMPACT = 'Report a finding only when its wrong outcome reaches a user, an operator, data, or a security boundary.'
const PREFERENCE = 'A preference, wording, or style point alone is not a finding.'
const RULING = "Do not report a variant that a recorded ruling's rationale already covers."
const checks = {
  SX1() {
    const rows = docs(QA)
    requireDoc(rows, `${QA}/SKILL.md`)
    const gates = flat(requireDoc(rows, `${QA}/references/gates.md`))
    const bad = []
    for (const { file, text } of rows) {
      const prose = flat(text)
      if (/\b(?:declar(?:e|es|ed|ing|ation(?:s)?)|list(?:s|ed|ing)?|enumerat(?:e|es|ed|ing))\b.{0,110}\btripwires?\b/i.test(prose)
          || /\btripwires?\b.{0,80}\bdeclar(?:e|es|ed|ing|ation(?:s)?)\b/i.test(prose)) bad.push(`${file}: tripwire declaration`)
      if (/\borchestrator\b.{0,120}\b(?:author\w*|writ\w*|creat\w*|owns?)\b.{0,60}\bgate\b/i.test(prose)
          || /\bgate\b.{0,70}\b(?:authored|written|created|owned)\b.{0,30}\borchestrator\b/i.test(prose)) bad.push(`${file}: orchestrator gate authorship`)
    }
    if (!/\bgate\b.{0,80}\bplanner\b.{0,25}\bauthors?\b/i.test(gates)
        && !/\bplanner\b.{0,30}\b(?:authors?|writes?|owns?)\b.{0,60}\bgate\b/i.test(gates)) bad.push('gates.md: missing planner ownership')
    return bad.join('; ')
  },
  SX2() {
    const rows = docs(QA)
    requireDoc(rows, `${QA}/SKILL.md`)
    const captures = requireDoc(rows, `${QA}/references/captures.md`)
    const absent = requireDoc(rows, `${QA}/references/absence.md`)
    const removed = ['guardedKill', 'MODIFIER_KINDS', 'openRun', 'foldRpcUsage', 'SHADOW_ABSENT', 'USAGE_ABSENT_CAUSES', 'CREW_BREAKER_THRESHOLD', 'KNOWN_FLAGS']
    const bad = rows.flatMap(({ file, text }) => removed.filter((name) => text.includes(name)).map((name) => `${file}: deleted ${name}`))
    if (captures.includes('stream.jsonl')) bad.push('captures.md: obsolete stream.jsonl recipe')
    if (!captures.includes('task/lean/<role>/<id>.jsonl') || !captures.includes('crew/show.mjs')) bad.push('captures.md: missing lean session capture location/authority')
    const all = rows.map(({ text }) => text).join('\n')
    for (const anchor of ['proveMutations', 'runGate', 'CHECK_REASONS', 'crew/checks.mjs']) if (!all.includes(anchor)) bad.push(`missing live exhibit ${anchor}`)
    if (!absent.includes('crew/pi/extensions/subagent.ts') || !/usage:\s*null/.test(absent)) bad.push('absence.md: missing live null usage example')
    return bad.join('; ')
  },
  SX3() {
    const rows = docs(BACKEND)
    requireDoc(rows, `${BACKEND}/SKILL.md`)
    requireDoc(rows, `${BACKEND}/references/evidence.md`)
    const bad = []
    for (const { file, text } of rows) {
      const pins = text.match(/[A-Za-z0-9_./-]+\.[A-Za-z][A-Za-z0-9_-]*:\d+(?:[-–]\d+)?|`:\d+(?:[-–]\d+)?/g) ?? []
      if (pins.length) bad.push(`${file}: ${[...new Set(pins)].join(', ')}`)
    }
    return bad.join('; ')
  },
  SX4() {
    const rows = docs(REVIEW)
    requireDoc(rows, `${REVIEW}/SKILL.md`)
    requireDoc(rows, FALSIFICATION)
    requireDoc(rows, `${REVIEW}/references/evidence.md`)
    const bad = []
    for (const { file, text } of rows) {
      const tokens = new Set(text.match(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:mjs|cjs|js|ts|jsonl|json|md|yaml|yml|txt)\b/g) ?? [])
      // Include extensionless directory citations and named hand-review recipes.
      for (const [, token] of text.matchAll(/`([^`\n]+)`/g)) {
        if (/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?$/.test(token) && token.includes('/')) tokens.add(token)
      }
      for (const recipe of text.match(/\bsol-[A-Za-z0-9_-]+\b/g) ?? []) tokens.add(recipe)
      for (const [, destination] of text.matchAll(/\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
        if (!/^(?:[a-z]+:|#)/i.test(destination)) tokens.add(destination.split('#')[0])
      }
      for (const token of tokens) {
        if (!token) continue
        const candidates = [resolve(root, token), resolve(root, dirname(file), token), resolve(root, REVIEW, token)]
        // Existing pinned prose spells the scout basename with an explicit parent.
        for (const [, base, parent] of text.matchAll(/`([^`/]+\.(?:json|md|mjs|ts))` under `([^`]+\/)`/g)) {
          if (base === token) candidates.push(resolve(root, parent, base))
        }
        const found = candidates.some((candidate) => {
          const rel = relative(root, candidate)
          if (rel === '..' || rel.startsWith('../')) return false
          return existsSync(candidate) && (statSync(candidate).isFile() || statSync(candidate).isDirectory())
        })
        if (!found) bad.push(`${file}: unresolved ${token}`)
      }
    }
    return [...new Set(bad)].join('; ')
  },
  SX5() {
    const text = read(FALSIFICATION)
    const section = text.match(/## Falsify before you write\s+([\s\S]*?)(?=\n## |$)/)?.[1] ?? ''
    const prose = flat(section)
    if (!prose.includes(IMPACT) || !prose.includes(PREFERENCE)) return 'findings lack the user/operator/data/security impact floor or the preference/wording/style exclusion'
    for (const severity of ['must-fix', 'should-fix', 'consider']) if (!text.includes(severity)) return `local severity scale lost ${severity}`
    return ''
  },
  SX6() {
    const text = read(FALSIFICATION)
    const section = text.match(/## Rulings persist across rounds\s+([\s\S]*?)(?=\n## |$)/)?.[1] ?? ''
    return flat(section).includes(RULING) ? '' : 'rulings section does not forbid reporting a variant already covered by recorded rationale'
  },
}
let failed = 0
let errored = 0
for (const [id, check] of Object.entries(checks)) {
  let reason
  try { reason = check() } catch (error) { errored += 1; reason = `check could not read/inspect the checkout: ${error.message}` }
  if (reason) {
    failed += 1
    console.log(`FAIL ${id}: ${String(reason).replace(/[\r\n]+/g, ' ')}`)
  }
}
console.log(`GATE-SUMMARY ${JSON.stringify({ total: Object.keys(checks).length, failed, errored })}`)
process.exitCode = failed ? 1 : 0
