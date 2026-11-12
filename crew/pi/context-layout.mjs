// Lane context lives inside the task directory.
import { join } from 'node:path'

export const plannerReturnsDirOf = (taskDir) => String(taskDir || '')
export const journalPathOf = (taskDir) => join(String(taskDir || ''), 'journal.jsonl')
export const spawnCountPathOf = (taskDir, file) => join(String(taskDir || ''), file)
export function plannerReturnNumber(name) {
  const match = /^planner-(\d+)\.json$/.exec(String(name))
  return match ? Number(match[1]) : null
}
