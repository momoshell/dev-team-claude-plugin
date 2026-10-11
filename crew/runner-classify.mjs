import { basename } from 'node:path'

// Classifies a test command by its executable. Lives under crew/ so the driver can use it without
// crossing the scripts import firewall; scripts/factory/probe-repo.mjs re-exports it.
export function classifyTestRunner(command) {
  if (typeof command !== 'string') return 'unparsed'
  const trimmed = command.trim()
  if (!trimmed) return 'unparsed'
  const executable = basename(trimmed.split(/\s+/u, 1)[0])
  if (executable === 'cargo') return 'cargo'
  if (['node', 'npm', 'npx', 'yarn', 'pnpm'].includes(executable)) return 'node'
  return 'unparsed'
}
