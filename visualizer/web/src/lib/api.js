async function request(path, options) {
  const response = await fetch(path, options)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `request failed (${response.status})`)
  return data
}
export const getSessions = (filters = {}) => request(`/api/sessions?${new URLSearchParams(filters)}`)
export const getEvents = (adwId, after = 0, limit) => request(`/api/events?adw_id=${encodeURIComponent(adwId)}&after=${after}${limit == null ? '' : `&limit=${limit}`}`)
export const postTriage = (adwId, reviewed) => request('/api/triage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adw_id: adwId, reviewed }) })
