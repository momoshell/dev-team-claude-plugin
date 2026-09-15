const API_URL = 'https://api.github.com'
const PAGE_SIZE = 100
const MAX_PAGES = 20
const DEFAULT_CACHE_MS = 6 * 60 * 60 * 1000
const NON_WRITING = new Set(['scout', 'review_only', 'verify_only'])

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function state(name, reason, fields = {}, stale = false) {
  return { state: name, reason: text(reason) || 'ship state was not measured', stale: stale === true, ...fields }
}

function unmeasured(reason, stale = false) {
  return state('unmeasured', reason, {}, stale)
}

function uncachedFailure(failureReason) {
  return unmeasured(failureReason)
}

function responseHeader(response, name) {
  const headers = response?.headers
  if (!headers) return null
  try {
    if (typeof headers.get === 'function') return headers.get(name)
  } catch {}
  if (typeof headers === 'object') {
    const wanted = name.toLowerCase()
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)
    return entry ? String(entry[1]) : null
  }
  return null
}

function rateLimitedResponse(response) {
  if (response?.status === 429) return true
  return response?.status === 403 && Number(responseHeader(response, 'x-ratelimit-remaining')) === 0
}

function apiFailure(response, detail = '') {
  const kind = rateLimitedResponse(response) ? 'rate-limited' : 'unreachable'
  const label = kind === 'rate-limited' ? 'rate limit' : 'unreachable'
  const suffix = text(detail)
  return { kind, reason: suffix ? `GitHub ${label}: ${suffix}` : `GitHub ${label}.` }
}

function failureFromError(error) {
  if (error?.kind === 'rate-limited' || error?.kind === 'unreachable') return error
  return { kind: 'unreachable', reason: 'GitHub unreachable.' }
}

function branchFor(run) {
  return text(run?.goal)
}

const GITHUB_PULL_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#]|$)/
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function githubRepository(value) {
  return typeof value === 'string' && GITHUB_REPOSITORY.test(value) ? value : null
}

function repositoryFor(rows, fallback) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const url = rows[index]?.published?.url
    const match = typeof url === 'string' ? url.match(GITHUB_PULL_URL) : null
    if (match) return `${match[1]}/${match[2]}`
  }
  return githubRepository(fallback)
}

function validPublished(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Number.isSafeInteger(value.number) && value.number > 0
}

function journalRows(source, run) {
  if (!source || typeof source.readJournal !== 'function') return []
  try {
    const result = source.readJournal({ repo_slug: run?.repo_slug, task_slug: run?.goal, adw_id: run?.adw_id })
    return Array.isArray(result?.rows) ? result.rows : []
  } catch {
    return []
  }
}

function executionFor(rows) {
  let effective = null
  for (const row of rows) {
    if (row?.event !== 'run-configuration') continue
    const value = text(row?.run_configuration?.execution?.effective)
    if (value) effective = value
  }
  return effective
}

function publishedFor(rows) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (validPublished(rows[index]?.published)) return rows[index].published
  }
  return null
}

function pullUrl(base, repo, page) {
  return `${base}/repos/${encodeURIComponent(repo).replaceAll('%2F', '/')}/pulls?state=all&per_page=${PAGE_SIZE}&page=${page}`
}

async function readPulls({ fetchImpl, base, repo, token }) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  }
  if (token) headers.authorization = `Bearer ${token}`
  const rows = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let response
    try {
      response = await fetchImpl(pullUrl(base, repo, page), { headers })
    } catch {
      throw failureFromError()
    }
    if (!response || response.ok === false || (response.status != null && (response.status < 200 || response.status >= 300))) {
      throw apiFailure(response, `request returned HTTP ${response?.status ?? 'unknown'}`)
    }
    let payload
    try {
      payload = await response.json()
    } catch {
      throw failureFromError()
    }
    if (!Array.isArray(payload)) throw failureFromError()
    rows.push(...payload)
    if (payload.length < PAGE_SIZE) return rows
  }
  throw { kind: 'unreachable', reason: 'GitHub pull request history exceeded the 20-page lookup limit.' }
}

function indexPulls(rows) {
  const byNumber = new Map()
  const byBranch = new Map()
  for (const pull of rows) {
    if (!pull || typeof pull !== 'object' || Array.isArray(pull)) continue
    if (Number.isSafeInteger(pull.number) && pull.number > 0) byNumber.set(pull.number, pull)
    const branch = text(pull.head?.ref)
    if (branch) byBranch.set(branch, pull)
  }
  return { byNumber, byBranch }
}

function shipFor(record, indexes) {
  const { branch, published } = record
  if (!branch) return unmeasured('No lane branch was recorded for this run.', false)
  const { byNumber, byBranch } = indexes
  const pull = published ? byNumber.get(published.number) : byBranch.get(branch)
  if (!pull) return state('unpublished', 'GitHub found no pull request for this lane.')
  if (pull.merged_at) return state('merged', 'GitHub reports the pull request merged.', { merged_at: pull.merged_at, merge_commit_sha: pull.merge_commit_sha, pr_url: pull.html_url })
  if (pull.state === 'open') return state('open', 'GitHub reports the pull request open.', { pr_url: pull.html_url })
  return state('closed-unmerged', 'GitHub reports the pull request closed without a merge.', { pr_url: pull.html_url })
}

export function createShipStateResolver({ journalSource, fetchImpl = globalThis.fetch, token, now = () => Date.now(), cacheMs = DEFAULT_CACHE_MS, apiUrl, repository } = {}) {
  const base = text(apiUrl)?.replace(/\/+$/, '') || API_URL
  const bearer = text(token)
  const configuredRepository = githubRepository(repository)
  const ttl = Number.isFinite(cacheMs) && cacheMs >= 0 ? cacheMs : DEFAULT_CACHE_MS
  const caches = new Map()

  function cacheFor(repo) {
    if (!caches.has(repo)) caches.set(repo, { at: null, rows: null, inFlight: null })
    return caches.get(repo)
  }

  async function refresh(repo, cache) {
    try {
      const rows = await readPulls({ fetchImpl, base, repo, token: bearer })
      cache.rows = rows
      cache.at = now()
      return { rows, stale: false, failure: null }
    } catch (error) {
      const failure = failureFromError(error)
      return { rows: cache.rows, stale: cache.rows !== null, failure }
    }
  }

  async function pullsFor(repo) {
    const cache = cacheFor(repo)
    const current = now()
    if (cache.rows !== null && cache.at !== null && current - cache.at < ttl) return { rows: cache.rows, stale: false, failure: null }
    if (!cache.inFlight) cache.inFlight = refresh(repo, cache).finally(() => { cache.inFlight = null })
    return await cache.inFlight
  }

  async function resolve(runs = []) {
    const source = Array.isArray(runs) ? runs : []
    const result = new Map()
    const records = []
    const repositories = new Map()
    for (const run of source) {
      const rows = journalRows(journalSource, run || {})
      const execution = executionFor(rows)
      if (execution && NON_WRITING.has(execution)) {
        result.set(run?.adw_id, state('not-applicable', `Execution ${execution} declares that this run writes no changes.`))
        records.push(null)
        continue
      }
      const branch = branchFor(run)
      if (!branch) {
        result.set(run?.adw_id, unmeasured('No lane branch was recorded for this run.'))
        records.push(null)
        continue
      }
      const published = publishedFor(rows)
      const repo = repositoryFor(rows, configuredRepository)
      if (!repo) {
        result.set(run?.adw_id, unmeasured('No GitHub repository is recorded for this run.'))
        records.push(null)
        continue
      }
      const record = { run: run || {}, branch, repo, published }
      records.push(record)
      if (!repositories.has(repo)) repositories.set(repo, pullsFor(repo))
    }
    const fetched = new Map()
    await Promise.all([...repositories.entries()].map(async ([repo, promise]) => { fetched.set(repo, await promise) }))
    for (const record of records) {
      if (!record) continue
      const read = fetched.get(record.repo)
      if (!read || read.failure && read.rows === null) {
        const failureReason = read?.failure?.reason || 'GitHub unreachable.'
        result.set(record.run?.adw_id, uncachedFailure(failureReason))
        continue
      }
      const indexes = indexPulls(read.rows || [])
      const ship = shipFor(record, indexes)
      result.set(record.run?.adw_id, read.stale ? { ...ship, stale: true } : ship)
    }
    return result
  }

  return { resolve }
}
