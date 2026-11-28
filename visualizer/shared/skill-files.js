import { parseAgentFile, composeAgentFile, AGENT_FILE_LIMIT } from './agent-files.js'
export { parseAgentFile as parseSkillFile, composeAgentFile as composeSkillFile }
export const SKILL_FILE_LIMIT = AGENT_FILE_LIMIT
export function validateSkillFile(text) {
  if(typeof text!=='string' || text.includes('\0') || new TextEncoder().encode(text).length>SKILL_FILE_LIMIT) return 'Use a Markdown file smaller than 256 KB without NUL characters.'
  const value=parseAgentFile(text)
  if(value.error) return value.error
  if(typeof value.name!=='string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(value.name)) return 'Use up to 80 lowercase letters, numbers and hyphens for the skill name.'
  if(typeof value.description!=='string' || !value.description.trim()) return 'Describe when to use this skill.'
  if(!value.instructions.trim()) return 'Add instructions for this skill.'
  return null
}
export const SKILL_ROLES = ['lead','planner','builder','reviewer','tech-lead']
export const lines = text => [...new Set(text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean))]
export const deliveryLabel = value => value==='inline' ? 'Include in prompt' : 'Load on demand'
export function ruleSummary(rule) {
  const roles=rule.when.roles?.join(', ') || 'All roles'
  return `${roles} · ${rule.when.paths ? 'Matching files' : 'Every task'}`
}
