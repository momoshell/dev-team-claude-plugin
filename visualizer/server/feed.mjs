// Feed contract for the observability board. Implementations are swappable:
// callers depend only on this interface, not on a storage engine. The ledger
// implementation keeps the factory projection read-only; triage is isolated
// in its own sidecar because the projection can be rebuilt from JSONL.
import { createLedgerFeed } from './ledger-feed.mjs'

export function createFeed({ kind = 'ledger', ledgerDb, triageDb } = {}) {
  if (kind === 'ledger') return createLedgerFeed({ ledgerDb, triageDb })
  throw new Error(`unknown feed kind: ${kind}`)
}
