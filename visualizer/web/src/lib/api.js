async function request(path, options) {
  const response = await fetch(path, options)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `request failed (${response.status})`)
  return data
}
export const getSessions = (filters = {}, options) => request(`/api/sessions?${new URLSearchParams(filters)}`, options)
export const getEvents = (adwId, after = 0, limit, filters = {}, options) => {
  const params = new URLSearchParams({ adw_id: adwId, after })
  if (limit != null) params.set('limit', limit)
  for (const key of ['type', 'role', 'phase_id']) if (filters[key] !== undefined && filters[key] !== '' && filters[key] !== null) params.set(key, filters[key])
  return request(`/api/events?${params}`, options)
}
export const getReturns = (repoSlug, taskSlug, adwId, options) => request(`/api/returns?${new URLSearchParams({ repo_slug: repoSlug, task_slug: taskSlug, adw_id: adwId })}`, options)
export const getJournal = (repoSlug, taskSlug, adwId, options) => request(`/api/journal?${new URLSearchParams({ repo_slug: repoSlug, task_slug: taskSlug, adw_id: adwId })}`, options)
export const getSeatSessions = (repoSlug, taskSlug, adwId, role, options) => request(`/api/seat-sessions?${new URLSearchParams({ repo_slug: repoSlug, task_slug: taskSlug, adw_id: adwId, role })}`, options)
export const getAgents = () => request('/api/agents')
export const proposeAgentEdit = (role, field, value, tier = null) => request('/api/agents/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role, tier, field, value }) })
export const proposeAgent = (name, entry) => request('/api/agents/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, entry }) })
export const proposeSkills = (role, skills) => request('/api/skills/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role, skills }) })
export const getModelCatalog = () => request('/api/model-catalog')
export const setModelCatalogKey = (apiKey, options = {}) => request('/api/model-catalog/key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: apiKey, ...(apiKey === null ? {} : { persist:options.persist === true }) }) })
export const getPluginWriteMode = () => request('/api/plugin-write-mode')

export const getAgentLibrary = () => request('/api/agent-library')
export const saveAgentFile = (input) => request('/api/agent-library/save', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(input) })

export const saveHarnessSettings = input => request('/api/harness-settings', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})

export const getSkillLibrary = () => request('/api/skill-library')
export const saveSkillFile = input => request('/api/skill-library/save', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})
export const saveSkillRules = input => request('/api/skill-rules', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})

