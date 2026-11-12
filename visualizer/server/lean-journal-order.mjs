export function stateless(rows, row, index) {
  if (typeof row?.event !== 'string' || row.event === 'stage-end') return true
  if (row.event === 'check' && Array.isArray(rows) && Number.isSafeInteger(index)) {
    for (let i = Math.min(index, rows.length) - 1; i >= 0; i--) {
      if (rows[i]?.event === 'stage-start') break
      if (rows[i]?.event === 'verdict' && rows[i].status === 'stopped') return true
    }
  }
  return false
}

// A detached return can write its own rows before its parent's decision reaches the journal.
export function supersededReturn(rows, row, index) {
  return row?.event === 'finish-decision' && row.choice === 'return' && Number.isSafeInteger(row.launchedAt)
    && row.launchedAt >= 0 && row.launchedAt <= index && rows.slice(row.launchedAt, index).some((next) =>
      next.event === 'run-start' || next.event === 'stage-start' || next.event === 'finish-ready' || (next.event === 'verdict' && next.status === 'stopped'))
}
