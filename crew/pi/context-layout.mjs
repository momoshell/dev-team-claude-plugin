// Where a pi seat's arms find the lane's context: the journal and its run-start anchor, the planner's
// return and the subagent spawn counter. The old layout keeps them beside the task dir
// (dirname(CREW_TASK_DIR)); a lean lane keeps them inside it. A seat is told which one by
// CREW_CONTEXT_LAYOUT, and a lean seat never reads a parent directory: the parent is another lane's.
import { dirname, join } from 'node:path'

export const CONTEXT_LAYOUT_ENV = 'CREW_CONTEXT_LAYOUT'
export const LEAN_LAYOUT = 'lean'

export const isLeanLayout = (env) => env?.[CONTEXT_LAYOUT_ENV] === LEAN_LAYOUT

const laneDir = (taskDir, env) => (isLeanLayout(env) ? String(taskDir || '') : dirname(String(taskDir || '')))

export const journalPathOf = (taskDir, env) => join(laneDir(taskDir, env), 'journal.jsonl')

export const spawnCountPathOf = (taskDir, env, file) => join(laneDir(taskDir, env), file)

// The directory holding planner returns. The old layout has a flat returns/ and, for the readers that scope by
// run, returns/<run id>; a lean lane writes <role>-<turn>.json straight into its task dir.
export function plannerReturnsDirOf(taskDir, env, runId = null) {
  if (isLeanLayout(env)) return String(taskDir || '')
  return runId === null ? join(laneDir(taskDir, env), 'returns') : join(laneDir(taskDir, env), 'returns', runId)
}

// The turn number a file name carries, or null when the name is not a planner return of this layout.
export function plannerReturnNumber(name, env) {
  const match = (isLeanLayout(env) ? /^planner-(\d+)\.json$/ : /^d(\d+)\.planner\.json$/).exec(String(name))
  return match ? Number(match[1]) : null
}
