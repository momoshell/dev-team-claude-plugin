// Standalone report for batch ledgers written by crew/batch.mjs. Groups rows
// by batch ID and states each batch's measured cache-read share (with
// token/item denominators) and its whole-warmed-prefix hits. Rows with
// unmeasured usage are counted, never coerced; a batch whose base row is
// unmeasured reports null prefix hits with a closed reason, and the
// fresh-call baseline is always honest absence: no fresh call is recorded.
import { readFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const KNOWN_ROLES = new Set(['base', 'item'])
const KNOWN_STATUSES = new Set(['ok', 'failed'])

function fail(why) {
  throw new Error(`crew/batch-report: ${why}`)
}

function checkTokenField(row, field) {
  const value = row[field]
  if (value !== null && !(Number.isFinite(value) && value >= 0)) {
    fail(`row for batch ${JSON.stringify(row.batch_id)} has unusable ${field} ${JSON.stringify(value)}`)
  }
}

function checkRow(row) {
  if (typeof row !== 'object' || row === null) fail('each ledger row must be an object')
  if (typeof row.batch_id !== 'string' || row.batch_id.length === 0) fail('each ledger row needs a nonempty batch_id')
  if (!KNOWN_ROLES.has(row.role)) fail(`row for batch ${JSON.stringify(row.batch_id)} has invalid role ${JSON.stringify(row.role)}`)
  if (!KNOWN_STATUSES.has(row.status)) fail(`row for batch ${JSON.stringify(row.batch_id)} has invalid status ${JSON.stringify(row.status)}`)
  if (typeof row.strategy !== 'string' || row.strategy.length === 0) fail(`row for batch ${JSON.stringify(row.batch_id)} needs a nonempty strategy`)
  for (const field of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) checkTokenField(row, field)
}

export function measuredUsage(row) {
  return [row.input_tokens, row.cache_read_input_tokens, row.cache_creation_input_tokens].every((value) => value !== null && Number.isFinite(value) && value >= 0)
}

function reportOne(batchId, rows) {
  const bases = rows.filter((row) => row.role === 'base')
  if (bases.length !== 1) fail(`batch ${JSON.stringify(batchId)} must hold exactly one base row, found ${bases.length}`)
  const base = bases[0]
  for (const row of rows) {
    if (row.strategy !== base.strategy) fail(`batch ${JSON.stringify(batchId)} mixes strategies ${JSON.stringify(base.strategy)} and ${JSON.stringify(row.strategy)}`)
  }
  const items = rows.filter((row) => row.role === 'item')
  const total = items.length
  const ok = items.filter((row) => row.status === 'ok').length
  const failed = items.filter((row) => row.status === 'failed').length
  const measured = items.filter((row) => row.status === 'ok' && measuredUsage(row))
  let numerator = 0
  let denominator = 0
  for (const row of measured) {
    numerator += row.cache_read_input_tokens
    denominator += row.input_tokens + row.cache_read_input_tokens + row.cache_creation_input_tokens
  }
  const cache_read_share = denominator === 0
    ? { share: null, numerator_tokens: numerator, denominator_tokens: denominator, items: measured.length, reason: 'zero-denominator' }
    : { share: numerator / denominator, numerator_tokens: numerator, denominator_tokens: denominator, items: measured.length, reason: null }
  let prefix_hits = null
  let prefix_hits_reason = null
  if (base.cache_read_input_tokens === null || base.cache_creation_input_tokens === null) {
    prefix_hits = null; prefix_hits_reason = 'base-usage-unmeasured'
  } else {
    const threshold = base.cache_read_input_tokens + base.cache_creation_input_tokens
    const hits = measured.filter((row) => row.cache_read_input_tokens >= threshold).length
    prefix_hits = { hits, items: measured.length }
    prefix_hits_reason = null
  }
  return {
    batch_id: batchId,
    strategy: base.strategy,
    total,
    ok,
    failed,
    unmeasured_items: ok - measured.length,
    cache_read_share,
    prefix_hits,
    prefix_hits_reason,
    fresh_baseline: null,
    fresh_baseline_reason: 'no-fresh-call-recorded',
  }
}

export function reportBatches(rows) {
  if (!Array.isArray(rows)) fail('rows must be an array')
  const order = []
  const groups = new Map()
  for (const row of rows) {
    checkRow(row)
    if (!groups.has(row.batch_id)) {
      groups.set(row.batch_id, [])
      order.push(row.batch_id)
    }
    groups.get(row.batch_id).push(row)
  }
  return order.map((batchId) => reportOne(batchId, groups.get(batchId)))
}

function formatBatchLine(batch) {
  const share = batch.cache_read_share
  const shareText = share.share === null ? `null (${share.reason})` : share.share.toFixed(4)
  const hitsText = batch.prefix_hits === null ? String(batch.prefix_hits_reason) : `${batch.prefix_hits.hits} of ${batch.prefix_hits.items}`
  return `${batch.batch_id}: ${shareText} (${share.numerator_tokens}/${share.denominator_tokens} tokens, ${share.items} items), prefix_hits ${hitsText}`
}

function readLedger(dir) {
  const ledgerPath = join(dir, 'batch.jsonl')
  let raw
  try {
    raw = readFileSync(ledgerPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`missing batch ledger ${ledgerPath}: line 1`)
    throw new Error(`cannot read batch ledger ${ledgerPath}: ${error?.message ?? String(error)}`)
  }
  const rows = []
  const lines = String(raw).split('\n')
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim().length === 0) continue
    try {
      rows.push(JSON.parse(lines[index]))
    } catch {
      throw new Error(`invalid JSON in batch ledger ${ledgerPath}: line ${index + 1}`)
    }
  }
  if (rows.length === 0) fail(`empty batch ledger ${ledgerPath}`)
  return rows
}

function main(args) {
  let json = false
  const dirs = []
  for (const arg of args) {
    if (arg === '--json') json = true
    else if (arg.startsWith('-')) fail(`unknown flag ${JSON.stringify(arg)}`)
    else dirs.push(arg)
  }
  if (dirs.length === 0) fail('need at least one <out-dir>')
  const rows = dirs.flatMap((dir) => readLedger(dir))
  const reports = reportBatches(rows)
  if (json) {
    process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`)
    return
  }
  for (const batch of reports) {
    process.stdout.write(`${formatBatchLine(batch)}\n`)
    process.stdout.write(`  strategy=${batch.strategy} total=${batch.total} ok=${batch.ok} failed=${batch.failed} unmeasured=${batch.unmeasured_items} fresh_baseline=${batch.fresh_baseline_reason}\n`)
  }
}

const invoked = resolvePath(process.argv[1] ?? '') === fileURLToPath(import.meta.url)
if (invoked) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error?.message ?? String(error)}\n`)
    process.exitCode = 1
  }
}
