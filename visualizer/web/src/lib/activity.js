// Turns a /api/sessions response into the feed state: lean lanes are the only source, so the feed is unavailable
// exactly when the lean read failed or the response states nothing about it (unreadable, never assumed readable).
export function sessionsFeedState(result = {}) {
  const entry = result?.sources?.lean
  const lean = entry && typeof entry === 'object'
    ? { readable: entry.readable === true, runs: Number.isFinite(entry.runs) ? entry.runs : null, absent: typeof entry.absent === 'string' && entry.absent ? entry.absent : null }
    : { readable: false, runs: null, absent: null }
  const degraded = !lean.readable
  return { degraded, available: !degraded, sources: { lean } }
}
