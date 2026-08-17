#!/usr/bin/env node
// scripts/factory/intake.mjs — host-side board selection for the factory intake loop.
//
// DISPATCHES, MOVES THE BOARD, AND NEVER MERGES, APPROVES, CLOSES OR PUSHES
// Slice 2 claims a picked issue, runs one crew, and observes a PR without
// creating or changing one.
//
// FAIL-CLOSED ELIGIBILITY
// An issue is pickable only when its four-line intake block compiles through the
// mechanical brief oracle. Prose outside that block is never interpreted.
//
// NO IDENTITY IN THE SOURCE
// Board, repository, and task names arrive as arguments. Every path resolves
// from the caller's checkout or process.cwd().

import { spawnSync as cpSpawnSync } from 'node:child_process'
import {
  existsSync as fsExistsSync, readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync, mkdirSync as fsMkdirSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import {
  INTAKE_REFUSALS, INTAKE_OUTCOMES, openLedger,
} from './ledger.mjs'
import {
  BriefUsageError, discoverTripwires, proposeTier, renderBrief, resolveWriteSurface,
  validateRequest, verifyWhere,
} from './make-brief.mjs'

export const INTAKE_BLOCK_KEYS = Object.freeze(['ask', 'where', 'done-means', 'out-of-scope'])
// These values are defaults for callers that have no board configuration. A
// ratified board is resolved outside this module by probe-repo's
// checkoutIntakeBoard; importing that resolver here would breach the intake
// firewall and turn this host-side loop into an identity-bearing consumer.
export const DEFAULT_INTAKE_CONFIG = Object.freeze({
  statusField: 'Status',
  readyColumn: 'Ready',
  priorityField: 'Priority',
  priorityOrder: Object.freeze(['P0', 'P1', 'P2']),
  pageSize: 100,
  maxPages: 10,
  concurrency: 1,
  stopSwitchPath: '.factory/STOP',
  workColumn: 'In progress',
  reviewColumn: 'In review',
  taskPrefix: 'intake',
  variant: 'full',
  workCheckout: null,
  windowHours: 24,
  windowCap: 3,
  rateLimitFloor: 200,
  protectedPaths: Object.freeze([]),
})

export const REQUIRED_INTAKE_CONFIG_KEYS = Object.freeze([
  'statusField', 'readyColumn', 'workColumn', 'reviewColumn',
])

const EMPTY_PAGE = Object.freeze({
  items: Object.freeze([]),
  pageInfo: Object.freeze({ hasNextPage: false, endCursor: null }),
  rateLimit: null,
  drafts: 0,
})

function defaultGithub(d, { owner, projectNumber, first, after }) {
  const query = `query($owner:String!,$number:Int!,$first:Int!,$after:String){
    user(login:$owner){projectV2(number:$number){items(first:$first,after:$after){nodes{
      id
      content{... on Issue{number title url body createdAt}}
      fieldValues(first:100){nodes{... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2SingleSelectField{name}}}}}
    }pageInfo{hasNextPage endCursor}}}}
    organization(login:$owner){projectV2(number:$number){items(first:$first,after:$after){nodes{
      id
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

function runGhJson(d, args) {
  let result
  try {
    result = d.spawnSync('gh', args, { encoding: 'utf8' })
  } catch {
    return { ok: false, value: null }
  }
  if (!result || result.error || result.status !== 0) return { ok: false, value: null }
  try {
    return { ok: true, value: JSON.parse(String(result.stdout || '')) }
  } catch {
    return { ok: false, value: null }
  }
}

function projectFromResponse(response) {
  const data = response?.data
  if (!data || typeof data !== 'object') return null
  for (const owner of [data.user, data.organization]) {
    const project = owner?.projectV2
    if (project && typeof project === 'object') return project
  }
  return null
}

function defaultBoardMove(d, { board, itemId, from, to, config = {} } = {}) {
  const owner = board?.owner
  const projectNumber = board?.projectNumber
  if (typeof owner !== 'string' || !Number.isInteger(Number(projectNumber)) || itemId == null) {
    return { ok: false, status: null, reason: 'board-write-failed' }
  }
  const schema = `query($owner:String!,$number:Int!,$itemId:ID!){
    user(login:$owner){projectV2(number:$number){id fields(first:100){nodes{
      ... on ProjectV2SingleSelectField{id name options{id name}}
    }}}}
    organization(login:$owner){projectV2(number:$number){id fields(first:100){nodes{
      ... on ProjectV2SingleSelectField{id name options{id name}}
    }}}}
    node(id:$itemId){... on ProjectV2Item{fieldValues(first:100){nodes{
      ... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2SingleSelectField{id}}}
    }}}}
  }`
  const schemaResult = runGhJson(d, [
    'api', 'graphql', '-f', `query=${schema}`,
    '-F', `owner=${owner}`, '-F', `number=${Number(projectNumber)}`,
    '-f', `itemId=${itemId}`,
  ])
  const project = schemaResult.ok ? projectFromResponse(schemaResult.value) : null
  const field = project?.fields?.nodes?.find((candidate) => candidate?.name === config.statusField)
  const fromOption = field?.options?.find((option) => option?.name === from)
  const toOption = field?.options?.find((option) => option?.name === to)
  if (!project?.id || !field?.id || !fromOption?.id || !toOption?.id) {
    return { ok: false, status: null, reason: 'board-write-failed' }
  }
  const currentValues = schemaResult.value?.data?.node?.fieldValues?.nodes
  const currentValue = Array.isArray(currentValues)
    ? currentValues.find((value) => value?.field?.id === field.id)
    : null
  const currentStatus = currentValue?.name ?? null
  // The source option is checked before the write so a stale board envelope
  // cannot turn a different transition into a claimed issue.
  if (currentStatus !== from) return { ok: true, status: currentStatus, reason: 'board-write-unverified' }
  const mutation = `mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$optionId:String!){
    updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{singleSelectOptionId:$optionId}}){projectV2Item{id}}
  }`
  const mutationResult = runGhJson(d, [
    'api', 'graphql', '-f', `query=${mutation}`,
    '-f', `projectId=${project.id}`, '-f', `itemId=${itemId}`,
    '-f', `fieldId=${field.id}`, '-f', `optionId=${toOption.id}`,
  ])
  if (!mutationResult.ok) return { ok: false, status: null, reason: 'board-write-failed' }
  const readback = `query($itemId:ID!){
    node(id:$itemId){... on ProjectV2Item{fieldValues(first:100){nodes{
      ... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2SingleSelectField{id}}}
    }}}}}
  }`
  const readbackResult = runGhJson(d, [
    'api', 'graphql', '-f', `query=${readback}`, '-f', `itemId=${itemId}`,
  ])
  if (!readbackResult.ok) return { ok: false, status: null, reason: 'board-write-failed' }
  const values = readbackResult.value?.data?.node?.fieldValues?.nodes
  const statusValue = Array.isArray(values)
    ? values.find((value) => value?.field?.id === field.id)
    : null
  const status = statusValue?.name ?? null
  return { ok: true, status, reason: status === to ? null : 'board-write-unverified' }
}

function defaultBranchFor(d, { checkout } = {}) {
  const root = typeof checkout === 'string' && checkout.length > 0 ? checkout : process.cwd()
  let result
  try {
    result = d.spawnSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' })
  } catch {
    return null
  }
  if (!result || result.error || result.status !== 0) return null
  const branch = String(result.stdout || '').trim()
  return branch || null
}

function defaultCrewBoot(d, { task, checkout, tier } = {}) {
  const root = resolve(typeof checkout === 'string' && checkout.length > 0 ? checkout : process.cwd())
  const argv = [join(root, 'crew', 'crew.mjs'), 'boot', '--task', task, '--checkout', root, '--tier', tier]
  try {
    const result = d.spawnSync(process.execPath, argv, { cwd: root, encoding: 'utf8' })
    return {
      exit: result?.status ?? null,
      stdout: String(result?.stdout || ''),
      stderr: String(result?.stderr || ''),
    }
  } catch (err) {
    return { exit: null, stdout: '', stderr: String(err?.message || err) }
  }
}

function defaultCrewRun(d, { task, checkout, briefPath, variant } = {}) {
  const root = resolve(typeof checkout === 'string' && checkout.length > 0 ? checkout : process.cwd())
  const argv = [
    join(root, 'crew', 'crew.mjs'), 'run', '--task', task, '--checkout', root,
    '--brief-file', briefPath, '--variant', variant, '--keep',
  ]
  try {
    const result = d.spawnSync(process.execPath, argv, { cwd: root, encoding: 'utf8' })
    return {
      exit: result?.status ?? null,
      stdout: String(result?.stdout || ''),
      stderr: String(result?.stderr || ''),
    }
  } catch (err) {
    return { exit: null, stdout: '', stderr: String(err?.message || err) }
  }
}

function defaultPullRequestFor(d, { checkout, branch } = {}) {
  if (typeof branch !== 'string' || !branch) return null
  const root = typeof checkout === 'string' && checkout.length > 0 ? checkout : process.cwd()
  let result
  try {
    result = d.spawnSync('gh', [
      'pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url', '--limit', '1',
    ], { cwd: root, encoding: 'utf8' })
  } catch {
    return null
  }
  if (!result || result.error || result.status !== 0) return null
  let rows
  try { rows = JSON.parse(String(result.stdout || '')) } catch { return null }
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row || row.number == null || typeof row.url !== 'string' || !row.url) return null
  return { number: Number(row.number), url: row.url }
}

export function normalDeps(deps = {}) {
  const d = {
    spawnSync: deps.spawnSync || cpSpawnSync,
    existsSync: deps.existsSync || fsExistsSync,
    readFileSync: deps.readFileSync || fsReadFileSync,
    writeFileSync: deps.writeFileSync || fsWriteFileSync,
    mkdirSync: deps.mkdirSync || fsMkdirSync,
    now: deps.now || (() => Date.now()),
  }
  d.github = deps.github || ((request) => defaultGithub(d, request))
  d.runsInWindow = deps.runsInWindow || defaultRunsInWindow
  d.branchFor = deps.branchFor || ((request) => defaultBranchFor(d, request))
  d.boardMove = deps.boardMove || ((request) => defaultBoardMove(d, request))
  d.crewBoot = deps.crewBoot || ((request) => defaultCrewBoot(d, request))
  d.crewRun = deps.crewRun || ((request) => defaultCrewRun(d, request))
  d.pullRequestFor = deps.pullRequestFor || ((request) => defaultPullRequestFor(d, request))
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
      item_id: node.id ?? null,
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

export function intakeConfigUsable(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { key: REQUIRED_INTAKE_CONFIG_KEYS[0] }
  }
  for (const key of REQUIRED_INTAKE_CONFIG_KEYS) {
    if (typeof settings[key] !== 'string' || settings[key].trim().length === 0) return { key }
  }
  const columns = ['readyColumn', 'workColumn', 'reviewColumn']
  for (let index = 1; index < columns.length; index += 1) {
    if (columns.slice(0, index).some((key) => settings[key] === settings[columns[index]])) {
      return { key: columns[index] }
    }
  }
  return null
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

function parkedResult({ sweptAt, board, reason, pages = 0, considered = 0, drafts = 0, rateLimit = null, degraded = false, boardItems = [] }) {
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
    board_items: boardItems,
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
  const unusable = intakeConfigUsable(settings)
  if (unusable) return { ok: false, reason: 'intake-config-unusable', detail: unusable.key }
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
    board_items: fetched.items.map(({ issue, item_id, status, priority, created_at }) => ({
      issue, item_id, status, priority, created_at,
    })),
    refusals,
    rate_limit: emptyRateLimit(false, rateLimit),
  }
  recordResult({ dbPath, board: usableBoard, result })
  return result
}

function lastJsonLine(stdout) {
  const lines = String(stdout || '').split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line) continue
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {
      // Child-process logs may precede the one JSON result line.
    }
  }
  return null
}

function outcomeForStatus(status) {
  if (status === 'done') return 'done'
  if (status === 'escalation') return 'escalation'
  if (status === 'converge' || status === 'converged') return 'converge'
  return null
}

function adjudicateCrewRun(result, { deps, crewDir, checkout }) {
  const exit = result?.exit ?? result?.status ?? null
  const line = lastJsonLine(result?.stdout)
  const lineOutcome = outcomeForStatus(line?.status)
  if (result?.error) {
    return {
      outcome: 'unreadable', exit, task_return: null,
      why: `dispatch-unreadable: ${result.error.message || result.error}`,
    }
  }
  // A preflight {error: ...} line must not fall through to an old envelope.
  if (!lineOutcome) {
    return { outcome: 'unreadable', exit, task_return: line?.task_return ?? null, why: 'dispatch-unreadable: invalid-dispatch-result' }
  }
  if (!Number.isInteger(exit) || (lineOutcome === 'done' ? exit !== 0 : exit === 0)) {
    return { outcome: 'unreadable', exit, task_return: line?.task_return ?? null, why: 'dispatch-unreadable: status-exit-mismatch' }
  }
  if (typeof line.task_return !== 'string' || !line.task_return.trim()) {
    return { outcome: 'unreadable', exit, task_return: null, why: 'dispatch-unreadable: task-return-unreadable' }
  }
  const taskReturn = isAbsolute(line.task_return)
    ? line.task_return
    : resolve(crewDir || checkout || process.cwd(), line.task_return)
  let envelope
  try {
    envelope = JSON.parse(String(deps.readFileSync(taskReturn, 'utf8')))
  } catch {
    return { outcome: 'unreadable', exit, task_return: taskReturn, why: 'dispatch-unreadable: task-return-unreadable' }
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || typeof envelope.status !== 'string') {
    return { outcome: 'unreadable', exit, task_return: taskReturn, why: 'dispatch-unreadable: task-return-unreadable' }
  }
  const status = outcomeForStatus(envelope.status)
  if (!status || status !== lineOutcome) {
    return { outcome: 'unreadable', exit, task_return: taskReturn, why: 'dispatch-unreadable: status-envelope-mismatch' }
  }
  const escalation = status === 'escalation' && envelope.details?.escalation
    && typeof envelope.details.escalation === 'object'
    ? envelope.details.escalation
    : null
  return {
    outcome: status,
    exit,
    task_return: taskReturn,
    why: status === 'escalation' ? (escalation?.why || 'driver escalation') : null,
  }
}

function dispatchBoard(board) {
  return {
    owner: board?.owner,
    projectNumber: Number(board?.projectNumber ?? board?.project_number),
  }
}

function taskSlugFor(picked, settings) {
  const prefix = typeof settings.taskPrefix === 'string' && settings.taskPrefix.trim()
    ? settings.taskPrefix.trim()
    : DEFAULT_INTAKE_CONFIG.taskPrefix
  return `${prefix}-${picked.issue}`
}

function recordDispatchStep({ dbPath, board, picked, sweptAt, deps, outcome, reason = null, ...fields }) {
  const row = {
    board_owner: board.owner,
    board_project: board.projectNumber,
    issue: picked.issue,
    sweep_at: sweptAt,
    outcome,
    reason,
    tier: picked.tier ?? null,
    task_slug: fields.task_slug ?? null,
    board_item_id: fields.board_item_id ?? null,
    branch: fields.branch ?? null,
    brief_path: fields.brief_path ?? null,
    crew_dir: fields.crew_dir ?? null,
    task_return: fields.task_return ?? null,
    exit_code: fields.exit_code ?? null,
    board_from: fields.board_from ?? null,
    board_to: fields.board_to ?? null,
    pr_number: fields.pr_number ?? null,
    pr_url: fields.pr_url ?? null,
  }
  let recorded = { ...row, created_at: timestamp(nowValue(deps)) }
  withLedger(dbPath, (ledger) => {
    recorded = ledger.recordIntakeDispatch({ ...row, created_at: timestamp(nowValue(deps)) })
  })
  return recorded
}

export function compileIntakeBrief({ picked, checkout, taskDir, deps = {} } = {}) {
  const d = normalDeps(deps)
  try {
    validateRequest(picked.request, { taskName: picked.title })
    const where = picked.where
    const discovery = discoverTripwires({ checkout, files: where })
    const proposal = proposeTier({ where, discovery })
    const writeSurface = resolveWriteSurface({ fences: null, lane: null, where })
    const bytes = renderBrief({
      request: picked.request,
      where,
      discovery,
      writeSurface,
      fences: null,
      proposal,
    })
    d.mkdirSync(taskDir, { recursive: true })
    const path = join(taskDir, `intake-${picked.issue}.md`)
    d.writeFileSync(path, bytes)
    return { ok: true, path, bytes, why: null }
  } catch (err) {
    if (err instanceof BriefUsageError || err?.name === 'BriefUsageError') {
      return { ok: false, path: null, bytes: null, why: `brief-refused: ${err.reason || 'usage'}` }
    }
    return { ok: false, path: null, bytes: null, why: `brief-refused: ${err?.message || String(err)}` }
  }
}

export function dispatchPicked({ board, picked, sweptAt, boardItems = [], checkout = process.cwd(), dbPath = null, config = {}, deps = {} } = {}) {
  const settings = { ...DEFAULT_INTAKE_CONFIG, ...(config || {}) }
  const d = normalDeps(deps)
  const selectedBoard = dispatchBoard(board)
  const task = taskSlugFor(picked, settings)
  const workCheckout = settings.workCheckout == null ? checkout : settings.workCheckout
  const common = { task_slug: task }
  if (picked.tier == null) {
    return recordDispatchStep({
      dbPath, board: selectedBoard, picked, sweptAt, deps: d,
      outcome: 'refused', reason: 'tier-unproposed', ...common,
    })
  }
  const item = Array.isArray(boardItems)
    ? boardItems.find((candidate) => String(candidate?.issue) === String(picked.issue))
    : null
  if (item?.item_id == null) {
    return recordDispatchStep({
      dbPath, board: selectedBoard, picked, sweptAt, deps: d,
      outcome: 'refused', reason: 'board-item-unknown', ...common,
    })
  }
  let branch = null
  try { branch = d.branchFor({ checkout: workCheckout }) } catch { branch = null }
  let move
  try {
    move = d.boardMove({
      board: selectedBoard,
      itemId: item.item_id,
      issue: picked.issue,
      from: settings.readyColumn,
      to: settings.workColumn,
      config: settings,
    })
  } catch {
    move = { ok: false, status: null }
  }
  if (!move?.ok || move.status !== settings.workColumn) {
    // Claim-before-execute: a failed or unverified write never boots a crew,
    // so this issue remains eligible and is safe to pick on the next sweep.
    return recordDispatchStep({
      dbPath, board: selectedBoard, picked, sweptAt, deps: d,
      outcome: 'refused',
      reason: move?.ok ? 'board-write-unverified' : 'board-write-failed',
      board_item_id: item.item_id, branch, ...common,
    })
  }
  // The verified move is the first irreversible step. A claimed row lands
  // before boot; if boot or run crashes, that stranded claim is visible and
  // the issue is deliberately not dispatched again while out of Ready.
  recordDispatchStep({
    dbPath, board: selectedBoard, picked, sweptAt, deps: d,
    outcome: 'claimed', reason: null,
    board_item_id: item.item_id, branch,
    board_from: settings.readyColumn, board_to: settings.workColumn, ...common,
  })

  const boot = d.crewBoot({ task, checkout: workCheckout, tier: picked.tier })
  const bootExit = boot?.exit ?? boot?.status ?? null
  const bootLine = lastJsonLine(boot?.stdout)
  const rawTaskDir = typeof bootLine?.task_dir === 'string' && bootLine.task_dir.trim()
    ? bootLine.task_dir
    : null
  const crewDir = rawTaskDir == null
    ? null
    : (isAbsolute(rawTaskDir) ? rawTaskDir : resolve(workCheckout || process.cwd(), rawTaskDir))
  if (!Number.isInteger(bootExit) || bootExit !== 0 || crewDir == null) {
    return recordDispatchStep({
      dbPath, board: selectedBoard, picked, sweptAt, deps: d,
      outcome: 'refused', reason: 'boot-failed',
      board_item_id: item.item_id, branch, crew_dir: crewDir, exit_code: bootExit, ...common,
    })
  }
  const brief = compileIntakeBrief({ picked, checkout: workCheckout, taskDir: crewDir, deps: d })
  if (!brief.ok) {
    return recordDispatchStep({
      dbPath, board: selectedBoard, picked, sweptAt, deps: d,
      outcome: 'refused', reason: brief.why,
      board_item_id: item.item_id, branch, crew_dir: crewDir, ...common,
    })
  }
  const run = d.crewRun({
    task, checkout: workCheckout, briefPath: brief.path, variant: settings.variant,
  })
  const settled = adjudicateCrewRun(run, { deps: d, crewDir, checkout: workCheckout })
  return recordDispatchStep({
    dbPath, board: selectedBoard, picked, sweptAt, deps: d,
    outcome: settled.outcome, reason: settled.why,
    board_item_id: item.item_id, branch, brief_path: brief.path,
    crew_dir: crewDir, task_return: settled.task_return, exit_code: settled.exit,
    ...common,
  })
}

function laterThan(row, claim) {
  if (row.created_at !== claim.created_at) return String(row.created_at || '') > String(claim.created_at || '')
  return Number(row.id || 0) > Number(claim.id || 0)
}

export function observeDispatches({ board, boardItems = [], checkout = process.cwd(), dbPath = null, config = {}, deps = {} } = {}) {
  if (dbPath == null) return []
  const settings = { ...DEFAULT_INTAKE_CONFIG, ...(config || {}) }
  const d = normalDeps(deps)
  const selectedBoard = dispatchBoard(board)
  const workCheckout = settings.workCheckout == null ? checkout : settings.workCheckout
  let rows = null
  withLedger(dbPath, (ledger) => { rows = ledger.dumpTable('intake_dispatches') })
  if (!Array.isArray(rows)) return []
  const promotions = []
  for (const item of boardItems) {
    if (item?.status !== settings.workColumn || item?.item_id == null) continue
    const same = (row) => row.board_owner === selectedBoard.owner
      && Number(row.board_project) === selectedBoard.projectNumber
      && String(row.issue) === String(item.issue)
    const claims = rows.filter((row) => same(row) && row.outcome === 'claimed')
      .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || Number(a.id || 0) - Number(b.id || 0))
    const claim = claims.at(-1)
    if (!claim || rows.some((row) => same(row) && row.outcome === 'promoted' && laterThan(row, claim))) continue
    if (typeof claim.branch !== 'string' || !claim.branch) continue
    let pr = null
    try { pr = d.pullRequestFor({ checkout: workCheckout, branch: claim.branch, issue: item.issue }) } catch { pr = null }
    const prNumber = Number(pr?.number)
    if (!Number.isInteger(prNumber) || prNumber <= 0 || typeof pr?.url !== 'string' || !pr.url) continue
    let move
    try {
      move = d.boardMove({
        board: selectedBoard,
        itemId: item.item_id,
        issue: item.issue,
        from: settings.workColumn,
        to: settings.reviewColumn,
        config: settings,
      })
    } catch { move = { ok: false, status: null } }
    if (!move?.ok || move.status !== settings.reviewColumn) continue
    // Promotion is observational: only a returned PR number and URL, followed
    // by a verified read-back, can produce this row; no PR is ever created here.
    const promoted = recordDispatchStep({
      dbPath, board: selectedBoard,
      picked: {
        issue: item.issue,
        tier: claim.tier,
      },
      sweptAt: claim.sweep_at,
      deps: d,
      outcome: 'promoted', reason: null,
      task_slug: claim.task_slug, board_item_id: item.item_id,
      branch: claim.branch, brief_path: claim.brief_path,
      crew_dir: claim.crew_dir, task_return: claim.task_return,
      exit_code: claim.exit_code, board_from: settings.workColumn,
      board_to: settings.reviewColumn, pr_number: prNumber, pr_url: pr.url,
    })
    promotions.push({ ...promoted, pr: { number: prNumber, url: pr.url } })
  }
  return promotions
}

export function intakeRun({ board, checkout = process.cwd(), dbPath = null, config = {}, deps = {} } = {}) {
  const settings = { ...DEFAULT_INTAKE_CONFIG, ...(config || {}) }
  const d = normalDeps(deps)
  const sweep = intakeSweep({ board, checkout, dbPath, config: settings, deps: d })
  if (sweep.ok === false) return { sweep, dispatch: null, promotions: [] }
  const selectedBoard = boardUsable(board) || dispatchBoard(sweep.board)
  const dispatch = sweep.outcome === 'picked'
    ? dispatchPicked({
        board: selectedBoard,
        picked: sweep.picked,
        sweptAt: sweep.swept_at,
        boardItems: sweep.board_items,
        checkout,
        dbPath,
        config: settings,
        deps: d,
      })
    : null
  const promotions = observeDispatches({
    board: selectedBoard,
    boardItems: sweep.board_items,
    checkout,
    dbPath,
    config: settings,
    deps: d,
  })
  return { sweep, dispatch, promotions }
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

