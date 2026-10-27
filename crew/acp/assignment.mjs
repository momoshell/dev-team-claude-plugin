// crew/acp/assignment.mjs — parse the one-line crew assignment a seat is handed.

export const SAFE_PATH_RE = /^\/[A-Za-z0-9._/-]+$/
// Path separators are already outside SAFE_TOKEN_RE; dot-only tokens ('.', '..')
// are not, and they are the ones that turn into traversal when a caller joins an
// id or role into a filesystem path.
export const DOTS_ONLY_RE = /^\.+$/
export const SAFE_RUN_TOKEN_RE = /^[A-Za-z0-9._-]{1,64}$/

export function runTokenFromReturnPath(returnPath) {
  if (typeof returnPath !== 'string' || !returnPath.startsWith('/')) return null
  const segments = returnPath.split('/')
  const returns = segments.lastIndexOf('returns')
  if (returns < 1 || returns + 3 !== segments.length) return null
  const token = segments[returns + 1]
  const file = segments[returns + 2]
  if (typeof token !== 'string' || !SAFE_RUN_TOKEN_RE.test(token) || DOTS_ONLY_RE.test(token)) return null
  if (typeof file !== 'string' || !/^[A-Za-z0-9._-]+\.json$/.test(file)) return null
  return token
}

export function parseAssignment(text) {
  if (typeof text !== 'string' || !text.length) return null
  const line = text.split(/\r?\n/, 1)[0]
  const safePath = (value) => SAFE_PATH_RE.test(value) && value.split('/').every((part) => part !== '.' && part !== '..')
  const match = line.match(/^ASSIGNMENT ([A-Za-z0-9._-]+): (?:read your brief at ([^ ]+)\.|your brief body follows below verbatim — do not re-read the brief file; if the brief itself names a plan, a diff or files, read those\.) Task dir: ([^ ]+)\. Write your ReturnEnvelope to ([^ ]+)(?: Add top-level JSON field "run_id":"([A-Za-z0-9._-]+)" to your ReturnEnvelope\.)? then print exactly: CREW-DONE ([A-Za-z0-9._-]+) ([A-Za-z0-9._-]+)$/)
  if (!match) return null
  const [, id, briefFile, taskDir, returnPath, instructedRunId, role, tailId] = match
  if (tailId !== id || !SAFE_RUN_TOKEN_RE.test(id) || DOTS_ONLY_RE.test(id) || DOTS_ONLY_RE.test(role)) return null
  if ((briefFile && !safePath(briefFile)) || !safePath(taskDir) || !safePath(returnPath)) return null
  const runId = runTokenFromReturnPath(returnPath)
  if (instructedRunId && instructedRunId !== runId) return null
  return { id, role, returnPath, taskDir, runId: instructedRunId ? runId : null }
}
