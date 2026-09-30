import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logLine, parseAssignment } from '../../driver.mjs'

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
    if (!sameKeys(rule, RULE_KEYS, ['path_pattern'])) return 'schema'
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
  const journalPath = taskDir ? join(dirname(taskDir), 'journal.jsonl') : null
  const record = (row) => { if (journalPath) append(journalPath, row) }
  let raw
  try { raw = read(deps.tablePath || TABLE_PATH, 'utf8') } catch { unusable('unreadable') }
  if (usable) {
    try { table = JSON.parse(raw) } catch { unusable('unparseable'); return { beforeAgentStart, toolResult, get usable() { return usable }, get reason() { return reason } } }
    const invalid = validate(table, read)
    if (invalid) unusable(invalid)
  }
  function beforeAgentStart(event) {
    const assignment = parseAssignment(event?.prompt)
    if (assignment && assignment.id !== currentId) fired.clear()
    if (assignment) currentId = assignment.id
  }
  function toolResult(event) {
    if (!usable || !event || !event.input) return undefined
    if (event.isError && (event.toolName === 'edit' || event.toolName === 'write')) return undefined
    let matched
    let value
    for (const rule of table.rules) {
      if (fired.has(rule.id)) continue
      if (!rule.roles.includes(env.CREW_ROLE)) continue
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
  return { beforeAgentStart, toolResult, get usable() { return usable }, get reason() { return reason } }
}
export function attachReminders(pi, options = {}) {
  const hooks = createReminders(options)
  pi.on('before_agent_start', hooks.beforeAgentStart)
  pi.on('tool_result', hooks.toolResult)
  return hooks
}
export default attachReminders
