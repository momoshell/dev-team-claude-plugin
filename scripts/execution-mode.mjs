import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// EXECUTION MODE (A10 config-key half).
// ---------------------------------------------------------------------------

const EXECUTION_MODE_LINE_RE = /^execution_mode:\s*(.*)$/gm

// canonical accepted values (whitelist, not a blacklist) — widening this
// requires a deliberate edit to the EXECUTION_MODES drift-guard test too.
export const EXECUTION_MODES = Object.freeze(['agent-tool', 'cmux'])
// legacy spellings normalized on read; 'subagent' predates the agent-tool
// rename (issue #5) but must keep working.
export const EXECUTION_MODE_ALIASES = Object.freeze({ subagent: 'agent-tool' })
export const DEFAULT_EXECUTION_MODE = 'agent-tool'

// note for assertExecutionModeCmux (below): because 'subagent' normalizes to
// 'agent-tool' here, a config saying `execution_mode: subagent` now produces
// a gate refusal naming "agent-tool" — intended, since the mode IS
// agent-tool and subagent is only a spelling of it.
// trust C2: a config.md with MORE THAN ONE `execution_mode:` line (a fenced
// example quoting the key is the obvious case) is ambiguous — refusing
// beats silently matching whichever line the regex found first.
//
// parseExecutionMode(configText) -> { present: boolean, mode } is the ONE
// shared matcher behind both readExecutionMode (project-file layer, kept
// byte-identical below) and resolveExecutionMode's home-file layer (be-76).
// Deliberately fence-blind, like readExecutionMode always was — never fork a
// second matcher for the home file.
function parseExecutionMode(configText) {
  const matches = [...(configText || '').matchAll(EXECUTION_MODE_LINE_RE)]
  if (matches.length > 1) {
    throw new Error(`readExecutionMode: config text contains ${matches.length} 'execution_mode:' lines — ambiguous (a fenced example?), refusing`)
  }
  if (matches.length === 0) return { present: false, mode: DEFAULT_EXECUTION_MODE }
  const raw = matches[0][1].trim()
  const value = EXECUTION_MODE_ALIASES[raw] ?? raw
  if (!EXECUTION_MODES.includes(value)) {
    // quote the RAW configured spelling, not the normalized one, so the
    // operator sees what their file actually says — capped before
    // JSON.stringify (sanitize-and-cap, conventions.md): this message is now
    // reachable from two files (project + home config), so a volume cap
    // beside the existing injection-safety cap (JSON.stringify) is due.
    const cappedRaw = raw.length > 80 ? `${raw.slice(0, 80)}...<truncated, ${raw.length} chars total>` : raw
    throw new Error(`readExecutionMode: unknown execution_mode value: ${JSON.stringify(cappedRaw)}`)
  }
  return { present: true, mode: value }
}

export function readExecutionMode(configText) {
  return parseExecutionMode(configText).mode
}

// be-76: whether configText carries a live execution_mode: line at all —
// exported so callers/tests can distinguish "absent" from "present and
// equal to the default value".
export function executionModeIsSet(configText) {
  return parseExecutionMode(configText).present
}

// MODE_SOURCES — diagnostic only, never a control-flow input. Names which
// layer resolveExecutionMode's result came from. resolveExecutionMode below
// builds its `source` field FROM this array (indexed by named lookup, never
// a bare string literal) so a mutation to the emitted 'project'/'home'/
// 'default' token trips the drift-guard test pinning this array's contents.
export const MODE_SOURCES = Object.freeze(['project', 'home', 'default'])
const [MODE_SOURCE_PROJECT, MODE_SOURCE_HOME, MODE_SOURCE_DEFAULT] = MODE_SOURCES

// resolveExecutionMode({ projectConfigText, homeConfigText }) -> { mode, source }
// Two-layer read (be-76, issue #41-adjacent): the project checkout's
// .claude/dev-team/config.md governs when it carries a bare execution_mode:
// line; when it is silent, ~/.claude/dev-team/config.md supplies a
// machine-level default; when neither does, DEFAULT_EXECUTION_MODE applies.
// Ambiguity (>1 line) is evaluated PER FILE via parseExecutionMode — never
// across the concatenation of both files.
//
// SHORT-CIRCUIT (deliberate): the home file is not parsed at all when the
// project layer is present — a project file with a live execution_mode:
// line short-circuits before homeConfigText is ever touched, so an
// ambiguous (or malformed) home file cannot affect a checkout that already
// states its own mode.
//
// D2 (deliberate, non-layering): cmux_env_file, env_file_keys and
// cmux_preview_url are NOT layered here or anywhere else (ADR-018:
// env_file_keys, the primary allowlist control, must be evaluated against
// the same file that names the env file — splitting them across layers
// would be a permission-surface change needing its own ADR amendment).
// Only execution_mode is layered.
export function resolveExecutionMode({ projectConfigText, homeConfigText }) {
  const project = parseExecutionMode(projectConfigText)
  if (project.present) return { mode: project.mode, source: MODE_SOURCE_PROJECT }
  const home = parseExecutionMode(homeConfigText)
  if (home.present) return { mode: home.mode, source: MODE_SOURCE_HOME }
  return { mode: DEFAULT_EXECUTION_MODE, source: MODE_SOURCE_DEFAULT }
}

export function readDevTeamConfigText(rootDir) {
  const p = join(rootDir, '.claude', 'dev-team', 'config.md')
  if (!existsSync(p)) return ''
  return readFileSync(p, 'utf8')
}
