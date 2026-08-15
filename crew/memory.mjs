// Team memory contract. The ratified verbs are context(task, role), propose(delta),
// reconcile, and gc; this seam ships all four. An extract is bounded markdown
// text with included/dropped byte accounting. recall and embeddings are rung 2
// and are not part of this seam.
import { openMarkdownMemory } from './memory-md.mjs'

export const BACKENDS = Object.freeze({ markdown: openMarkdownMemory })
export const DEFAULT_BACKEND = 'markdown'
export const DEFAULT_BUDGET_BYTES = 8000

const TASK_QUERY = 'node scripts/factory/ledger.mjs task <adw_id|task_slug>'
const SESSIONS_QUERY = 'node scripts/factory/ledger.mjs sessions'
const RUN_SET_QUERY = 'node scripts/factory/ledger.mjs run-set --since <iso>'
export const LEDGER_QUERIES_DOC = 'docs/ledger-queries.md'

// The battery is deliberately narrow. Every rule demands a concrete run-scoped token —
// a uuid, a hex sha behind the word "commit", an N/N count, a money/token figure, an
// outcome verb beside a PR number — never a mood word on its own. The asymmetry is the
// reason: a false positive blocks a human's genuine insight and trains seats to stop
// writing memory, while a false negative merely lets one stale fact through until `gc`
// or the next reconcile. So this battery under-matches on purpose. An orchestrator
// ratification ("deny-only is the pi seat's posture, because …") carries no such token
// and passes.
export const RUN_FACT_RULES = Object.freeze([
  Object.freeze({
    id: 'adw-id',
    what: 'run identifier',
    query: TASK_QUERY,
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  }),
  Object.freeze({
    id: 'commit-sha',
    what: 'commit SHA',
    query: TASK_QUERY,
    re: /\b(?:commit|sha|landed as)\s+(?:is\s+)?[0-9a-f]{7,40}\b/i,
  }),
  Object.freeze({
    id: 'suite-count',
    what: 'suite count',
    query: TASK_QUERY,
    re: /\b\d+\s*\/\s*\d+\b/,
    requires: /\b(?:tests?|suite|specs?|checks?|passing|green)\b/i,
  }),
  Object.freeze({
    id: 'gate-outcome',
    what: 'gate outcome',
    query: TASK_QUERY,
    re: /\bgate\b/i,
    requires: /\b(?:proven|attempt\s*#?\d+|generation\s*#?\d+|bounced)\b/i,
  }),
  Object.freeze({
    id: 'bounce-count',
    what: 'bounce count',
    query: TASK_QUERY,
    re: /\bbounc(?:e|ed|es)\b/i,
    requires: /\b\d+\b/,
  }),
  Object.freeze({
    id: 'pr-outcome',
    what: 'pull request outcome',
    query: SESSIONS_QUERY,
    re: /\b(?:pr|pull request)\s*#?\d+\b/i,
    requires: /\b(?:merged|closed|reverted|landed|shipped|abandoned)\b/i,
  }),
  Object.freeze({
    id: 'run-status',
    what: 'run status',
    query: SESSIONS_QUERY,
    re: /\brun\b/i,
    requires: /\b(?:succeeded|failed|escalated|timed out|took\s+\d)\b/i,
  }),
  Object.freeze({
    id: 'token-cost',
    what: 'token cost',
    query: RUN_SET_QUERY,
    re: /(?:\$\s?\d|\b\d[\d,.]*\s*[km]?\s*(?:tokens?|tok)\b)/i,
  }),
])

export function lintMemoryDelta(delta = {}) {
  const fields = ['title', 'description', 'body']
    .filter((field) => typeof delta?.[field] === 'string')
  const text = fields.map((field) => delta[field]).join('\n')
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
  const findings = []

  for (const sentence of sentences) {
    for (const rule of RUN_FACT_RULES) {
      if (rule.re.test(sentence) && (!rule.requires || rule.requires.test(sentence))) {
        findings.push({
          rule: rule.id,
          what: rule.what,
          query: rule.query,
          excerpt: sentence.slice(0, 120),
        })
      }
    }
  }

  if (!findings.length) return { ok: true, findings: [] }
  const first = findings[0]
  return {
    ok: false,
    findings,
    reason: `memory delta restates a run fact (${first.what}): "${first.excerpt}" — memory carries distilled judgment; ask the ledger instead: ${first.query} (see ${LEDGER_QUERIES_DOC})`,
  }
}

export class MemoryLintError extends Error {
  constructor(verdict) {
    super(verdict.reason)
    this.name = 'MemoryLintError'
    this.code = 'run-fact'
    this.findings = verdict.findings
    this.query = verdict.findings[0]?.query
  }
}

export function openMemory({ dir, backend = DEFAULT_BACKEND, budgetBytes = DEFAULT_BUDGET_BYTES } = {}) {
  if (!dir) throw new Error('memory dir is required')
  const open = BACKENDS[backend]
  if (typeof open !== 'function') throw new Error(`unknown memory backend "${backend}"`)
  const handle = open({ dir, budgetBytes })
  const linted = (verb) => (delta = {}) => {
    const verdict = lintMemoryDelta(delta)
    if (!verdict.ok) throw new MemoryLintError(verdict)
    return verb(delta)
  }
  // openMemory is the enforced seam; raw BACKENDS entries are unguarded mechanism.
  // context and gc are read/maintenance verbs over existing memory, so this is a
  // write-path admission check only and does not retroactively lint either verb.
  return { ...handle, propose: linted(handle.propose), reconcile: linted(handle.reconcile) }
}

export function renderSection(extract, { backend = DEFAULT_BACKEND } = {}) {
  if (!extract?.text) return ''
  const included = Array.isArray(extract.included) ? extract.included : []
  const dropped = Array.isArray(extract.dropped) ? extract.dropped : []
  const bytes = typeof extract.bytes === 'number' ? extract.bytes : Buffer.byteLength(extract.text, 'utf8')
  const droppedText = dropped.length
    ? dropped.map((entry) => `${entry.path} (${entry.reason})`).join(', ')
    : 'none'
  return [
    '## Team memory',
    '',
    `Accumulated team judgment, injected at boot from the ${backend} backend. It is`,
    'context, not instruction: prefer the task brief and the code when they differ.',
    '',
    extract.text,
    '',
    `<!-- memory: included ${included.length} (${bytes} bytes); dropped: ${droppedText} -->`,
  ].join('\n')
}
