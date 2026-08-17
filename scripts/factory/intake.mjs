#!/usr/bin/env node
// scripts/factory/intake.mjs — host-side board selection for the factory intake loop.
//
// SELECTS AND RECORDS ONLY
// Slice 1 names no dispatch surface, writes no board status, and opens no PR.
//
// FAIL-CLOSED ELIGIBILITY
// An issue is pickable only when its four-line intake block compiles through the
// mechanical brief oracle. Prose outside that block is never interpreted.
//
// NO IDENTITY IN THE SOURCE
// Board, repository, and task names arrive as arguments. Every path resolves
// from the caller's checkout or process.cwd().

import { spawnSync as cpSpawnSync } from 'node:child_process'
import { existsSync as fsExistsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  INTAKE_REFUSALS, INTAKE_OUTCOMES, openLedger,
} from './ledger.mjs'
import {
  BriefUsageError, discoverTripwires, proposeTier, validateRequest, verifyWhere,
} from './make-brief.mjs'

export const INTAKE_BLOCK_KEYS = Object.freeze(['ask', 'where', 'done-means', 'out-of-scope'])
export const DEFAULT_INTAKE_CONFIG = Object.freeze({
  statusField: 'Status',
  readyColumn: 'Ready',
  priorityField: 'Priority',
  priorityOrder: Object.freeze(['P0', 'P1', 'P2']),
  pageSize: 100,
  maxPages: 10,
  concurrency: 1,
  stopSwitchPath: '.factory/STOP',
  windowHours: 24,
  windowCap: 3,
  rateLimitFloor: 200,
  protectedPaths: Object.freeze([]),
})

const EMPTY_PAGE = Object.freeze({
  items: Object.freeze([]),
  pageInfo: Object.freeze({ hasNextPage: false, endCursor: null }),
  rateLimit: null,
  drafts: 0,
})

function defaultGithub(d, { owner, projectNumber, first, after }) {
  const query = `query($owner:String!,$number:Int!,$first:Int!,$after:String){
    user(login:$owner){projectV2(number:$number){items(first:$first,after:$after){nodes{
      content{... on Issue{number title url body createdAt}}
      fieldValues(first:100){nodes{... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2SingleSelectField{name}}}}}
    }pageInfo{hasNextPage endCursor}}}}
    organization(login:$owner){projectV2(number:$number){items(first:$first,after:$after){nodes{
      content{... on Issue{number title url body createdAt}}
      fieldValues(first:100){nodes{... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2SingleSelectField{name}}}}}
    }pageInfo{hasNextPage endCursor}}}}
    rateLimit{remaining resetAt}
  }`
  const args = [
    'api', 'graphql',
    '-f', `query=${query}`,
    '-F', `owner=${owner}`,
    '-F', `number=${projectNumber}`,
    '-F', `first=${first}`,
  ]
  if (after != null) args.push('-f', `after=${after}`)
  let result
  try {
    result = d.spawnSync('gh', args, { encoding: 'utf8' })
  } catch (err) {
    throw new Error(`github runner failed: ${String(err?.message || err)}`)
  }
  if (!result || result.error || result.status !== 0) {
    throw new Error(`github runner failed: ${String(result?.stderr || result?.error?.message || 'unknown error')}`)
  }
  try {
    return JSON.parse(String(result.stdout || ''))
  } catch {
    throw new Error('github runner returned non-JSON output')
  }
}

function defaultRunsInWindow({ since, dbPath } = {}) {
  if (dbPath == null) return 0
  let ledger = null
  try {
    ledger = openLedger({ dbPath })
    const sinceMs = Date.parse(since)
    return ledger.listSessions().filter((session) => {
      const started = Date.parse(session.started_at)
      return Number.isFinite(started) && (!Number.isFinite(sinceMs) || started >= sinceMs)
    }).length
  } catch {
    return 0
  } finally {
    try { ledger?.close() } catch {}
  }
}

export function normalDeps(deps = {}) {
  const d = {
    spawnSync: deps.spawnSync || cpSpawnSync,
    existsSync: deps.existsSync || fsExistsSync,
    now: deps.now || (() => Date.now()),
  }
  d.github = deps.github || ((request) => defaultGithub(d, request))
  d.runsInWindow = deps.runsInWindow || defaultRunsInWindow
  return d
}

function emptyPage() {
  return {
    items: [],
    pageInfo: { hasNextPage: false, endCursor: null },
    rateLimit: null,
    drafts: 0,
  }
}

function fieldName(node) {
  return node && typeof node === 'object' && node.field && typeof node.field === 'object'
    ? node.field.name
    : null
}

// The Projects v2 envelope is intentionally confined here. It is an assumed
// shape until a read-only response is captured from the live API; re-capture
// that response here if GitHub changes the envelope.
export function normaliseBoardPage(response, { statusField, priorityField } = {}) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return emptyPage()
  const data = response.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return emptyPage()
  const owner = data.user ?? data.organization
  const project = owner && typeof owner === 'object' ? owner.projectV2 : null
  const connection = project && typeof project === 'object' ? project.items : null
  if (!connection || typeof connection !== 'object' || !Array.isArray(connection.nodes)) return emptyPage()

  const items = []
  let drafts = 0
  for (const node of connection.nodes) {
    const content = node && typeof node === 'object' && node.content && typeof node.content === 'object'
      ? node.content
      : null
    if (!content || content.number == null) {
      drafts += 1
      continue
    }
    const values = node.fieldValues && typeof node.fieldValues === 'object'
      && Array.isArray(node.fieldValues.nodes)
      ? node.fieldValues.nodes
      : []
    let status = null
    let priority = null
    for (const value of values) {
      if (!value || typeof value !== 'object') continue
      const name = fieldName(value)
      if (typeof name !== 'string' || typeof value.name !== 'string') continue
      if (name === statusField && status == null) status = value.name
      if (name === priorityField && priority == null) priority = value.name
    }
    items.push({
      issue: content.number,
      title: content.title ?? null,
      url: content.url ?? null,
      body: content.body ?? null,
      created_at: content.createdAt ?? null,
      priority,
      status,
    })
  }

  const pageInfo = connection.pageInfo && typeof connection.pageInfo === 'object'
    ? connection.pageInfo
    : {}
  const rawRateLimit = response.rateLimit ?? data.rateLimit
  const rateLimit = rawRateLimit && typeof rawRateLimit === 'object'
    ? {
        remaining: rawRateLimit.remaining == null ? null : Number(rawRateLimit.remaining),
        reset_at: rawRateLimit.resetAt ?? rawRateLimit.reset_at ?? null,
      }
    : null
  return {
    items,
    pageInfo: {
      hasNextPage: pageInfo.hasNextPage === true,
      endCursor: pageInfo.endCursor ?? null,
    },
    rateLimit,
    drafts,
  }
}

function priorityRank(priority, priorityOrder) {
  const index = Array.isArray(priorityOrder) ? priorityOrder.indexOf(priority) : -1
  return index < 0 ? Number.MAX_SAFE_INTEGER : index
}

function createdRank(value) {
  if (value == null) return Number.MAX_SAFE_INTEGER
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER
}

export function orderCandidates(candidates, { priorityOrder = DEFAULT_INTAKE_CONFIG.priorityOrder } = {}) {
  return [...(Array.isArray(candidates) ? candidates : [])].sort((a, b) => {
    const priorityDifference = priorityRank(a?.priority, priorityOrder) - priorityRank(b?.priority, priorityOrder)
    if (priorityDifference !== 0) return priorityDifference
    const createdDifference = createdRank(a?.created_at) - createdRank(b?.created_at)
    if (createdDifference !== 0) return createdDifference
    const aIssue = a?.issue
    const bIssue = b?.issue
    if (typeof aIssue === 'number' && typeof bIssue === 'number' && aIssue !== bIssue) return aIssue - bIssue
    const aText = String(aIssue ?? '')
    const bText = String(bIssue ?? '')
    return aText < bText ? -1 : aText > bText ? 1 : 0
  })
}

export function fetchBoard({ board, config = DEFAULT_INTAKE_CONFIG, deps = {} } = {}) {
  const d = normalDeps(deps)
  const settings = { ...DEFAULT_INTAKE_CONFIG, ...(config || {}) }
  const owner = board?.owner
  const projectNumber = board?.projectNumber
  const maxPages = Number.isInteger(settings.maxPages) && settings.maxPages > 0
    ? settings.maxPages
    : DEFAULT_INTAKE_CONFIG.maxPages
  const first = Number.isInteger(settings.pageSize) && settings.pageSize > 0
    ? settings.pageSize
    : DEFAULT_INTAKE_CONFIG.pageSize
  const items = []
  let pages = 0
  let drafts = 0
  let cursor = null
  let nextPage = { hasNextPage: true, endCursor: null }
  let rateLimit = null

  while (nextPage.hasNextPage && pages < maxPages) {
    let response
    try {
      response = d.github({ owner, projectNumber, first, after: cursor })
    } catch {
      return { ok: false, items, pages, drafts, rateLimit, degraded: false, reason: 'board-fetch-failed' }
    }
    const page = normaliseBoardPage(response, {
      statusField: settings.statusField,
      priorityField: settings.priorityField,
    })
    pages += 1
    items.push(...page.items)
    drafts += page.drafts
    nextPage = page.pageInfo
    cursor = nextPage.endCursor

    if (page.rateLimit && page.rateLimit.remaining != null && Number.isFinite(page.rateLimit.remaining)) {
      const remaining = Number(page.rateLimit.remaining)
      if (rateLimit == null || remaining <= rateLimit.remaining) {
        rateLimit = { remaining, reset_at: page.rateLimit.reset_at ?? null }
      }
      if (remaining < settings.rateLimitFloor) {
        return {
          ok: false,
          items,
          pages,
          drafts,
          rateLimit,
          degraded: true,
          reason: 'rate-limit-floor',
        }
      }
    } else if (page.rateLimit && rateLimit == null) {
      rateLimit = { remaining: null, reset_at: page.rateLimit.reset_at ?? null }
    }

    if (nextPage.hasNextPage && cursor == null) break
  }

  if (nextPage.hasNextPage && pages >= maxPages) {
    return { ok: false, items, pages, drafts, rateLimit, degraded: true, reason: 'page-limit' }
  }
  return { ok: true, items, pages, drafts, rateLimit, degraded: false, reason: null }
}

function nowValue(d) {
  try { return d.now() } catch { return Date.now() }
}

function timestamp(value) {
  if (value instanceof Date) {
    try { return value.toISOString() } catch {}
  }
  if (typeof value === 'number' || typeof value === 'string') {
    const parsed = typeof value === 'number' ? value : Date.parse(value)
    if (Number.isFinite(parsed)) {
      try { return new Date(parsed).toISOString() } catch {}
    }
  }
  return new Date().toISOString()
}

function boardUsable(board) {
  if (!board || typeof board !== 'object' || Array.isArray(board)) return null
  if (typeof board.owner !== 'string' || board.owner.trim().length === 0) return null
  const projectNumber = Number(board.projectNumber)
  if (!Number.isInteger(projectNumber) || projectNumber <= 0) return null
  return { owner: board.owner.trim(), projectNumber }
}

function emptyRateLimit(degraded = false, rateLimit = null) {
  return {
    remaining: rateLimit?.remaining ?? null,
    reset_at: rateLimit?.reset_at ?? null,
    degraded,
  }
}

function withLedger(dbPath, fn) {
  if (dbPath == null) return
  let ledger = null
  try {
    ledger = openLedger({ dbPath })
    fn(ledger)
  } catch {
    // Recording is best effort: a ledger failure never changes selection.
  } finally {
    try { ledger?.close() } catch {}
  }
}

function recordResult({ dbPath, board, result }) {
  withLedger(dbPath, (ledger) => {
    ledger.recordIntakeSweep({
      board_owner: board.owner,
      board_project: board.projectNumber,
      outcome: result.outcome,
      reason: result.reason,
      considered: result.considered,
      pages: result.pages,
      picked_issue: result.picked?.issue ?? null,
      rate_limit_remaining: result.rate_limit.remaining,
      rate_limit_reset_at: result.rate_limit.reset_at,
      created_at: result.swept_at,
    })
    for (const refusal of result.refusals) {
      ledger.recordIntakeRefusal({
        board_owner: board.owner,
        board_project: board.projectNumber,
        issue: refusal.issue,
        reason: refusal.reason,
        detail: refusal.detail,
        priority: refusal.priority,
        issue_created_at: refusal.created_at,
        created_at: result.swept_at,
      })
    }
  })
}

function parkedResult({ sweptAt, board, reason, pages = 0, considered = 0, drafts = 0, rateLimit = null, degraded = false }) {
  return {
    ok: true,
    outcome: 'parked',
    reason,
    swept_at: sweptAt,
    board: { owner: board.owner, project_number: board.projectNumber },
    pages,
    considered,
    drafts,
    picked: null,
    refusals: [],
    rate_limit: emptyRateLimit(degraded, rateLimit),
  }
}

function refusalFor(item, reason, detail = null) {
  return {
    issue: item.issue,
    reason,
    detail,
    priority: item.priority ?? null,
    created_at: item.created_at ?? null,
  }
}

export function intakeSweep({ board, checkout = process.cwd(), dbPath = null, config = {}, deps = {} } = {}) {
  const usableBoard = boardUsable(board)
  if (!usableBoard) return { ok: false, reason: 'board-config-unusable' }

  const settings = { ...DEFAULT_INTAKE_CONFIG, ...(config || {}) }
  const d = normalDeps(deps)
  const rawNow = nowValue(d)
  const sweptAt = timestamp(rawNow)
  const root = typeof checkout === 'string' && checkout.length > 0 ? checkout : process.cwd()

  let stopped = false
  try { stopped = d.existsSync(resolve(root, settings.stopSwitchPath)) } catch { stopped = false }
  if (stopped) {
    const result = parkedResult({ sweptAt, board: usableBoard, reason: 'stop-switch' })
    recordResult({ dbPath, board: usableBoard, result })
    return result
  }

  const nowMs = Date.parse(sweptAt)
  const windowHours = Number(settings.windowHours)
  const windowStart = Number.isFinite(windowHours)
    ? new Date(nowMs - windowHours * 60 * 60 * 1000).toISOString()
    : new Date(nowMs - DEFAULT_INTAKE_CONFIG.windowHours * 60 * 60 * 1000).toISOString()
  let runs = 0
  try {
    runs = Number(d.runsInWindow({ since: windowStart, now: rawNow, dbPath }))
  } catch { runs = 0 }
  if (Number.isFinite(runs) && runs >= settings.windowCap) {
    const result = parkedResult({ sweptAt, board: usableBoard, reason: 'window-cap' })
    recordResult({ dbPath, board: usableBoard, result })
    return result
  }

  const fetched = fetchBoard({ board: usableBoard, config: settings, deps: d })
  const rateLimit = fetched.rateLimit
  if (!fetched.ok) {
    const result = parkedResult({
      sweptAt,
      board: usableBoard,
      reason: fetched.reason,
      pages: fetched.pages,
      considered: fetched.items.filter((item) => item.status === settings.readyColumn).length,
      drafts: fetched.drafts,
      rateLimit,
      degraded: fetched.degraded === true,
    })
    // Operational runner/page-limit failures are caller-visible failures, not
    // named candidate refusals. The rate-limit floor is the measured park.
    if (fetched.reason === 'rate-limit-floor') {
      recordResult({ dbPath, board: usableBoard, result })
      return result
    }
    return { ok: false, reason: fetched.reason, pages: fetched.pages, items: fetched.items }
  }

  const candidates = fetched.items.filter((item) => item.status === settings.readyColumn)
  const refusals = []
  const survivors = []
  for (const item of candidates) {
    if (!Array.isArray(settings.priorityOrder) || !settings.priorityOrder.includes(item.priority)) {
      refusals.push(refusalFor(item, 'priority-unknown'))
      continue
    }

    const block = extractIntakeBlock(item.body)
    if (!block.ok) {
      refusals.push(refusalFor(item, block.reason))
      continue
    }

    let verifiedWhere
    let discovery
    let proposal
    try {
      validateRequest(block.request, { taskName: item.title })
      verifiedWhere = verifyWhere({ checkout: root, where: block.request.where })
      discovery = discoverTripwires({ checkout: root, files: verifiedWhere })
      proposal = proposeTier({
        where: verifiedWhere,
        discovery,
        protectedPaths: Array.isArray(settings.protectedPaths) ? settings.protectedPaths : [],
      })
    } catch (err) {
      if (err instanceof BriefUsageError) {
        refusals.push(refusalFor(item, 'brief-uncompilable', err.reason || null))
      } else {
        refusals.push(refusalFor(item, 'brief-uncompilable', 'compile-error'))
      }
      continue
    }

    if (proposal.signals?.protectedHits?.length > 0) {
      refusals.push(refusalFor(item, 'protected-path', proposal.signals.protectedHits.join(', ')))
      continue
    }
    if (proposal.tier === 'judge') {
      refusals.push(refusalFor(item, 'tier-judge'))
      continue
    }
    survivors.push({ item, request: block.request, where: verifiedWhere, tier: proposal.tier })
  }

  const ordered = orderCandidates(survivors.map((candidate) => candidate.item), {
    priorityOrder: settings.priorityOrder,
  })
  const byIssue = new Map(survivors.map((candidate) => [String(candidate.item.issue), candidate]))
  const concurrency = Number.isInteger(settings.concurrency) && settings.concurrency > 0
    ? settings.concurrency
    : DEFAULT_INTAKE_CONFIG.concurrency
  const pickedCandidate = ordered.length > 0 ? byIssue.get(String(ordered[0].issue)) : null
  for (const candidate of ordered.slice(1)) {
    refusals.push(refusalFor(candidate, 'not-first-in-order', `concurrency=${concurrency}`))
  }

  const picked = pickedCandidate
    ? {
        issue: pickedCandidate.item.issue,
        title: pickedCandidate.item.title,
        url: pickedCandidate.item.url,
        priority: pickedCandidate.item.priority,
        created_at: pickedCandidate.item.created_at,
        tier: pickedCandidate.tier,
        where: pickedCandidate.where,
        request: pickedCandidate.request,
      }
    : null
  const result = {
    ok: true,
    outcome: picked ? 'picked' : 'none',
    reason: null,
    swept_at: sweptAt,
    board: { owner: usableBoard.owner, project_number: usableBoard.projectNumber },
    pages: fetched.pages,
    considered: candidates.length,
    drafts: fetched.drafts,
    picked,
    refusals,
    rate_limit: emptyRateLimit(false, rateLimit),
  }
  recordResult({ dbPath, board: usableBoard, result })
  return result
}

export function extractIntakeBlock(body) {
  if (typeof body !== 'string') return { ok: false, reason: 'intake-block-missing' }
  const lines = body.replaceAll('\r\n', '\n').split('\n').map((line) => line.trim())
  const askLines = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^ask:\s*/.test(lines[index])) askLines.push(index)
  }
  if (askLines.length === 0) return { ok: false, reason: 'intake-block-missing' }
  if (askLines.length > 1) return { ok: false, reason: 'intake-block-malformed' }

  const start = askLines[0]
  const expected = INTAKE_BLOCK_KEYS.map((key) => new RegExp(`^${key}:\\s*(.*)$`))
  const values = []
  for (let offset = 0; offset < expected.length; offset += 1) {
    const match = lines[start + offset]?.match(expected[offset])
    if (!match || !match[1].trim()) return { ok: false, reason: 'intake-block-malformed' }
    values.push(match[1].trim())
  }
  const where = values[1].split(',').map((entry) => entry.trim()).filter(Boolean)
  if (where.length === 0) return { ok: false, reason: 'intake-block-malformed' }
  return {
    ok: true,
    request: {
      ask: values[0],
      where,
      done_means: values[2],
      out_of_scope: values[3],
    },
  }
}

