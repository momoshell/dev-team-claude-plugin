// Journal summaries only. Keep in sync with crew/base-ci-summary.mjs.
export function summarizeBaseCi(runs) {
  const bases = new Map(), stops = new Map()
  for (const run of runs) {
    const { base_ci: snapshot, base_ci_repository: repository, base_ci_branch: branch, task_slug: lane } = run
    if (snapshot) {
      const key = JSON.stringify([repository, branch, repository && branch ? null : lane])
      const previous = bases.get(key)
      if (!previous || (snapshot.recorded_at ?? '') > (previous.recorded_at ?? '')) {
        bases.set(key, { key, repository, branch, lane, ...snapshot })
      }
    }
    for (const link of run.base_red_links ?? []) {
      if (!stops.has(link)) stops.set(link, new Set())
      stops.get(link).add(lane)
    }
  }
  return { bases: [...bases.values()], stops: [...stops].map(([link, lanes]) => ({ link, count: lanes.size })) }
}
