async function request(path, options) {
  const response = await fetch(path, options)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `request failed (${response.status})`)
  return data
}
export const getSessions = (filters = {}) => request(`/api/sessions?${new URLSearchParams(filters)}`)
export const getEvents = (adwId, after = 0, limit, filters = {}) => {
  const params = new URLSearchParams({ adw_id: adwId, after })
  if (limit != null) params.set('limit', limit)
  for (const key of ['type', 'role', 'phase_id']) if (filters[key] !== undefined && filters[key] !== '' && filters[key] !== null) params.set(key, filters[key])
  return request(`/api/events?${params}`)
}
export const getReturns = (repoSlug, taskSlug, adwId) => request(`/api/returns?${new URLSearchParams({ repo_slug: repoSlug, task_slug: taskSlug, adw_id: adwId })}`)
export const getRoster = () => request('/api/roster')
export const getCellHealth = (params = {}) => request(`/api/cell-health?${new URLSearchParams(params)}`)
export const getRunSet = (params = {}) => request(`/api/run-set?${new URLSearchParams(params)}`)
export const getIntake = (params = {}) => request(`/api/intake?${new URLSearchParams(params)}`)
export const postTriage = (adwId, reviewed) => request('/api/triage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adw_id: adwId, reviewed }) })
export const proposeRosterEdit = (tier, role, cell) => request('/api/roster/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tier, role, cell }) })
export const getRosterLadder = () => request('/api/roster/ladder')
export const stageRosterLadder = (moves) => request('/api/roster/ladder/stage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ moves }) })
export const composeRosterLadder = (moves) => request('/api/roster/ladder/compose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ moves }) })
