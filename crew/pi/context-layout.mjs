// Lane context lives inside the task directory.
import { join } from 'node:path'

export const CONTEXT_LAYOUT_ENV = 'CREW_CONTEXT_LAYOUT'
export const LEAN_LAYOUT = 'lean'

const laneDir = (taskDir) => String(taskDir || '')
export const plannerReturnsDirOf = (taskDir) => laneDir(taskDir)
export const journalPathOf = (taskDir) => join(plannerReturnsDirOf(taskDir), 'journal.jsonl')
export const spawnCountPathOf = (taskDir, file) => join(plannerReturnsDirOf(taskDir), file)
export function plannerReturnNumber(name) {
  const match = /^planner-(\d+)\.json$/.exec(String(name))
  return match ? Number(match[1]) : null
}
