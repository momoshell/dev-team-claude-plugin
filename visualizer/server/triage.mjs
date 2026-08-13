// Triage is intentionally stored in a sidecar projection. The factory ledger
// is rebuildable from JSONL, while this UI-only flag has no JSONL record;
// keeping it here guarantees that observability performs zero ledger writes.
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export function createTriage({ ledgerDb, triageDb } = {}) {
  const path = triageDb || join(dirname(ledgerDb), 'visualizer.db')
  let db = null
  let degraded = false
  let reason = null
  function open() {
    if (db || degraded) return db
    try {
      const { DatabaseSync } = require('node:sqlite')
      db = new DatabaseSync(path)
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('CREATE TABLE IF NOT EXISTS run_triage (adw_id TEXT PRIMARY KEY, reviewed_at TEXT, reviewed_by TEXT)')
      return db
    } catch (err) {
      degraded = true
      reason = err?.message || String(err)
      return null
    }
  }
  function readTriage(ids = []) {
    const handle = open()
    const out = new Map()
    if (!handle || !ids.length) return out
    const marks = ids.map(() => '?').join(',')
    for (const row of handle.prepare(`SELECT adw_id, reviewed_at FROM run_triage WHERE adw_id IN (${marks})`).all(...ids)) out.set(row.adw_id, row)
    return out
  }
  function setTriage({ adw_id, reviewed }) {
    const handle = open()
    if (!handle) return { adw_id, reviewed_at: null, degraded: true }
    const reviewedAt = reviewed ? new Date().toISOString() : null
    handle.prepare('INSERT INTO run_triage (adw_id, reviewed_at, reviewed_by) VALUES (?, ?, ?) ON CONFLICT(adw_id) DO UPDATE SET reviewed_at = excluded.reviewed_at, reviewed_by = excluded.reviewed_by').run(adw_id, reviewedAt, null)
    return { adw_id, reviewed_at: reviewedAt }
  }
  return {
    readTriage,
    setTriage,
    health: () => ({ degraded, path, reason }),
    close: () => { if (db) { try { db.close() } catch {} db = null } },
  }
}
