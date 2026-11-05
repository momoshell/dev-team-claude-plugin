// A detached return can write its own rows before its parent's decision reaches the journal.
export function supersededReturn(rows, row, index) {
  return row?.event === 'finish-decision' && row.choice === 'return' && Number.isSafeInteger(row.launchedAt)
    && row.launchedAt >= 0 && row.launchedAt <= index && rows.slice(row.launchedAt, index).some((next) =>
      next.event === 'run-start' || next.event === 'stage-start' || next.event === 'finish-ready' || (next.event === 'verdict' && next.status === 'stopped'))
}
