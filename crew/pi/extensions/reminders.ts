import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAssignment } from '../../acp/assignment.mjs'
import { logLine } from '../../acp/log.mjs'
import { journalPathOf } from '../context-layout.mjs'

const TABLE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'reminders.json')
const TOP_KEYS = ['schema_version', 'rules']
const RULE_KEYS = ['id', 'roles', 'tools', 'field', 'pattern', 'source', 'reminder']
const SOURCE_KEYS = ['path', 'quote']
const ROLES = ['builder', 'planner', 'reviewer']
function sameKeys(value, keys, optional = []) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key) || optional.includes(key))
    && keys.every((key) => Object.hasOwn(value, key))
}
function validate(table, read) {
  if (!sameKeys(table, TOP_KEYS) || table.schema_version !== 1 || !Array.isArray(table.rules) || !table.rules.length) return 'schema'
  const ids = new Set()
  let absent = false
  for (const rule of table.rules) {
    if (!sameKeys(rule, RULE_KEYS, ['path_pattern', 'requires_fff'])) return 'schema'
    if (Object.hasOwn(rule, 'requires_fff') && typeof rule.requires_fff !== 'boolean') return 'schema'
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rule.id) || ids.has(rule.id)) return 'schema'
    ids.add(rule.id)
    if (!Array.isArray(rule.roles) || !rule.roles.length || rule.roles.some((role) => !ROLES.includes(role))) return 'schema'
    if (!Array.isArray(rule.tools) || !rule.tools.length || new Set(rule.tools).size !== rule.tools.length || rule.tools.some((tool) => !['bash', 'edit', 'write'].includes(tool))) return 'schema'
    if ((rule.tools.length === 1 && rule.tools[0] === 'bash') ? rule.field !== 'command' : rule.tools.includes('bash') || rule.field !== 'text') return 'schema'
    if (typeof rule.pattern !== 'string' || typeof rule.reminder !== 'string' || !rule.reminder.trim() || rule.reminder.length > 240 || /[\r\n]/.test(rule.reminder)) return 'schema'
    try { new RegExp(rule.pattern) } catch { return 'schema' }
    if (rule.path_pattern !== undefined) {
      if (!rule.tools.every((tool) => tool === 'edit' || tool === 'write') || typeof rule.path_pattern !== 'string') return 'schema'
      try { new RegExp(rule.path_pattern) } catch { return 'schema' }
    }
    if (!sameKeys(rule.source, SOURCE_KEYS) || typeof rule.source.path !== 'string' || rule.source.path.startsWith('/') || rule.source.path.split(/[\\/]/).includes('..') || typeof rule.source.quote !== 'string' || !rule.source.quote) return 'schema'
    // A source file missing from the working checkout (a foreign repo) is not a broken
    // table: it gets its own closed reason, and the table still does not fire there. The
    // rest of the table is still validated, so a real defect anywhere reports `schema`.
    let text
    try { text = String(read(join(process.cwd(), rule.source.path), 'utf8')) } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') { absent = true; continue }
      return 'schema'
    }
    if (!text.includes(rule.source.quote)) return 'schema'
  }
  return absent ? 'source-absent' : null
}
export function createReminders({ env = process.env, deps = {} } = {}) {
  const read = deps.readFileSync || readFileSync
  const append = deps.append || logLine
  let table
  let currentId = null
  const fired = new Set()
  let reason = null
  const unusable = (value) => { reason = value; usable = false; record({ event: 'rule_reminder_table_unusable', rule_reminder_table_unusable: { reason } }) }
  let usable = true
  const taskDir = env.CREW_TASK_DIR
  const journalPath = taskDir ? journalPathOf(taskDir, env) : null
  const record = (row) => { if (journalPath) append(journalPath, row) }
  let raw
  try { raw = read(deps.tablePath || TABLE_PATH, 'utf8') } catch { unusable('unreadable') }
  if (usable) {
    try { table = JSON.parse(raw) } catch { unusable('unparseable'); return { beforeAgentStart, sessionStart, toolResult, exportState, importState, get usable() { return usable }, get reason() { return reason } } }
    const invalid = validate(table, read)
    if (invalid) unusable(invalid)
  }
  function beforeAgentStart(event) {
    const assignment = parseAssignment(event?.prompt)
    if (assignment && assignment.id !== currentId) fired.clear()
    if (assignment) currentId = assignment.id
  }
  const eligible = (rule) => rule.roles.includes(env.CREW_ROLE) && (rule.requires_fff !== true || env.CREW_FFF === '1')
  // A host with a session-start channel (the claude seat plugin) shows the role's table at the start.
  function sessionStart() {
    if (!usable) return undefined
    const rules = table.rules.filter(eligible)
    for (const rule of rules) record({ event: 'rule_reminder', rule_reminder: { rule: rule.id, role: env.CREW_ROLE, tool: 'session-start', assignment_id: currentId } })
    return rules.length ? rules.map((rule) => `reminder (${rule.id}): ${rule.reminder}`).join('\n') : undefined
  }
  // A host that runs each hook in a fresh process keeps the fired set between calls; pi never calls these.
  function exportState() { return { current_id: currentId, fired: [...fired] } }
  function importState(state) {
    if (!state || typeof state !== 'object' || !Array.isArray(state.fired) || !state.fired.every((id) => typeof id === 'string') || (state.current_id !== null && typeof state.current_id !== 'string')) throw new Error('reminders state is malformed')
    currentId = state.current_id
    fired.clear(); for (const id of state.fired) fired.add(id)
  }
  function toolResult(event) {
    if (!usable || !event || !event.input) return undefined
    if (event.isError && (event.toolName === 'edit' || event.toolName === 'write')) return undefined
    let matched
    let value
    for (const rule of table.rules) {
      if (fired.has(rule.id)) continue
      if (!eligible(rule)) continue
      if (!rule.tools.includes(event.toolName)) continue
      if (rule.path_pattern && !new RegExp(rule.path_pattern).test(event.input.path)) continue
      if (rule.field === 'command') value = event.input.command
      else if (event.toolName === 'edit') {
        if (!Array.isArray(event.input.edits)) continue
        value = event.input.edits.map((edit) => edit.newText).join('\n')
      } else value = event.input.text ?? event.input.content
      if (typeof value === 'string' && new RegExp(rule.pattern).test(value)) { matched = rule; break }
    }
    if (!matched) return undefined
    fired.add(matched.id)
    const reminderPart = { type: 'text', text: `reminder (${matched.id}): ${matched.reminder}` }
    const row = { event: 'rule_reminder', rule_reminder: { rule: matched.id, role: env.CREW_ROLE, tool: event.toolName, assignment_id: currentId } }
    if (journalPath) {
      append(journalPath, row)
    }
    return { content: [reminderPart, ...event.content] }
  }
  return { beforeAgentStart, sessionStart, toolResult, exportState, importState, get usable() { return usable }, get reason() { return reason } }
}
// Idea credit: the rule reminders follow oh-my-pi's TTSR and the non-interrupting tool_result rule reminder; no oh-my-pi source is copied, ideas only, and no licence notice is invented.
export function attachReminders(pi, options = {}) {
  const hooks = createReminders(options)
  pi.on('before_agent_start', hooks.beforeAgentStart)
  pi.on('tool_result', hooks.toolResult)
  return hooks
}
export default attachReminders
