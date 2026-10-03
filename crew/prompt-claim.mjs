import { promptDocumentHits, promptSurfacePaths } from './protected-paths.mjs'

const PROMPT_CLAIM_LINE_START = String.raw`(?:^|\n)`
const PROMPT_MEASURE_NAME = String.raw`(?:first-round pass rate|turns per seat|[a-z0-9][a-z0-9._-]* refusal frequency)`
const PROMPT_MEASURE_SAMPLE = String.raw`[^;\n]+\s+\(n=[1-9]\d*\)`
export const PROMPT_MEASURED_CLAIM = new RegExp(String.raw`${PROMPT_CLAIM_LINE_START}Measure: ${PROMPT_MEASURE_NAME}; before: ${PROMPT_MEASURE_SAMPLE}; after: ${PROMPT_MEASURE_SAMPLE}\.?(?:\n|$)`, 'i')
export const PROMPT_UNMEASURED_CLAIM = new RegExp(String.raw`${PROMPT_CLAIM_LINE_START}unmeasured — n insufficient; reason: [^;\n]*[^\s;\n][^;\n]*; re-measure after [1-9]\d* seats\.?(?:\n|$)`, 'i')
export const PROMPT_NOT_APPLICABLE = 'not applicable — citation-only; no seat-behaviour change intended.'
const matches = (line) => PROMPT_MEASURED_CLAIM.test(line) || PROMPT_UNMEASURED_CLAIM.test(line) || line === PROMPT_NOT_APPLICABLE
export function promptClaimLines(intent) { return String(intent ?? '').split('\n').filter((line) => matches(line)) }
export function validPlanPromptClaim(claim) { return typeof claim === 'string' && !claim.includes('\n') && promptClaimLines(claim).length === 1 }
export function stripPromptClaims(body) { return String(body ?? '').split('\n').filter((line) => !matches(line)).join('\n') }

// The lookbehind refuses a match that starts mid-token, so a URL host:port is never a citation.
// lean: a bare host:port with no scheme (example.com:8000) still reads as a citation; refuse known TLD extensions if one is seen.
const citation = /(?<![A-Za-z0-9_./@:-])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z][A-Za-z0-9]*):(\d+)(?:-(\d+))?(?![A-Za-z0-9_-])/g
function citationShape(line) { return line.replace(citation, (_m, path, start, end) => `${path}:#${end === undefined ? '' : '-#'}`) }
export function citationOnlyDiff(output) {
  if (typeof output !== 'string' || !output || output.includes('\0')) return false
  const lines = output.split('\n')
  if (lines.at(-1) === '') lines.pop()
  let hunks = 0, inHunk = false, removed = [], added = [], expectedOld = 0, expectedNew = 0
  const finish = () => {
    if (!inHunk) return true
    if (removed.length !== expectedOld || added.length !== expectedNew || removed.length <= 0 || removed.length !== added.length) return false
    if (removed.some((line, i) => line === added[i] || citationShape(line) !== citationShape(added[i]))) return false
    inHunk = false; removed = []; added = []; return true
  }
  for (const line of lines) {
    if (line.startsWith('diff --git ')) { if (!finish()) return false; continue }
    if (/^index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?$/.test(line)) continue
    if (line.startsWith('@@ ')) {
      if (!finish()) return false
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line)
      if (!m) return false
      expectedOld = m[2] === undefined ? 1 : Number(m[2]); expectedNew = m[4] === undefined ? 1 : Number(m[4]); inHunk = true; hunks++; continue
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue
    if (line === '\\ No newline at end of file') return false
    if (!inHunk) { if (line.trim()) return false; continue }
    if (line.startsWith('-')) removed.push(line.slice(1))
    else if (line.startsWith('+')) added.push(line.slice(1))
    else return false
  }
  return finish() && hunks > 0
}
export function readPromptDiff({ files, baseSha, io, quote } = {}) {
  let result = null
  if (typeof baseSha === 'string' && baseSha.trim() && typeof io?.run === 'function' && typeof quote === 'function' && Array.isArray(files)) {
    try { result = io.run(`git diff -U0 ${quote(baseSha)}...HEAD -- ${files.map(quote).join(' ')}`) } catch { result = null }
  }
  if (result?.ok !== true || typeof result.output !== 'string' || result.output.includes('\0')) return { citation_only: null, reason: 'diff-unreadable' }
  const citationOnly = citationOnlyDiff(result.output)
  return { citation_only: citationOnly, reason: null }
}
export function publishPromptClaim({ files, baseSha, io, quote, register, planClaim } = {}) {
  const hits = promptDocumentHits(files, promptSurfacePaths(register))
  if (!hits.length) return null
  const paths = [...new Set(hits)].sort()
  const diff = readPromptDiff({ files: paths, baseSha, io, quote })
  return { source: diff.citation_only === true ? 'driver-citation-only' : 'plan', citation_only: diff.citation_only, reason: diff.reason, files: paths, claim: diff.citation_only === true ? PROMPT_NOT_APPLICABLE : (validPlanPromptClaim(planClaim) ? planClaim : null) }
}
export function askClosingIssues(brief) {
  const text = typeof brief === 'string' ? brief : ''
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line === '## The ask')
  if (start < 0) return []
  let end = lines.findIndex((line, i) => i > start && line.startsWith('## ')); if (end < 0) end = lines.length
  const ask = lines.slice(start + 1, end).join('\n')
  const found = []
  for (const line of ask.split('\n')) { const m = /^Closes #([1-9]\d*)$/.exec(line); if (m && !found.includes(`#${m[1]}`)) found.push(`#${m[1]}`) }
  return found
}
