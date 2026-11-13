#!/usr/bin/env node
// Claude PreToolUse hook for read-only seats: a refused Bash command is denied with a reason that
// names its first non-read-only segment. Git is also refused when the payload cwd is not CREW_READ_ONLY_ROOT.
// Allowed commands print nothing, so the ACP gate still decides.
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { readOnlyCommandResult } from '../acp-permission.mjs'

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
const MALFORMED = 'Refusing Bash: unable to verify the command is read-only.'

export function readOnlyHookDecision(payload, env = process.env) {
  if (env?.CREW_READ_ONLY !== '1') return undefined
  let value = payload
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return deny(MALFORMED) }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return deny(MALFORMED)
  const name = value.tool_name ?? value.toolName
  if (name === undefined) return deny(MALFORMED)
  if (name !== 'Bash') return undefined
  const input = value.tool_input ?? value.toolInput ?? value.input
  if (!input || typeof input !== 'object' || typeof input.command !== 'string') return deny(MALFORMED)
  const result = readOnlyCommandResult(input.command)
  if (!result.allowed) return deny(result.reason)
  const root = env.CREW_READ_ONLY_ROOT
  let atRoot = false
  try {
    atRoot = typeof value.cwd === 'string' && value.cwd.length > 0 && typeof root === 'string' && root.length > 0
      && realpathSync(value.cwd) === realpathSync(root)
  } catch { /* unverifiable paths are not the root */ }
  if (!atRoot) {
    const gitRefusal = `git runs only in the seat's root directory${root ? ` ${root}` : ''}; cd there in a call of its own first`
    const checked = readOnlyCommandResult(input.command, { gitRefusal })
    if (!checked.allowed) return deny(checked.reason)
  }
  return undefined
}

// A resolution failure must not skip the check: when realpath cannot tell, fall back to the unresolved
// path and then to the script name, so an unverifiable direct invocation still runs the hook.
function invokedDirectly() {
  const self = fileURLToPath(import.meta.url)
  const entry = process.argv[1]
  if (!entry) return false
  try { return realpathSync(entry) === realpathSync(self) } catch {
    return entry === self || basename(entry) === basename(self)
  }
}

if (invokedDirectly()) {
  let raw
  try { raw = readFileSync(0, 'utf8') } catch { raw = undefined }
  const decision = readOnlyHookDecision(raw ?? '')
  if (decision) process.stdout.write(`${JSON.stringify(decision)}\n`)
}
