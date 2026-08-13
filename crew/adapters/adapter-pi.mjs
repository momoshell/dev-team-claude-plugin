// crew/adapters/adapter-pi.mjs — the pi agent adapter.
//
// An adapter is the seam between a crew seat and the CLI agent that fills it:
// `capabilities` (frozen) declares what the agent can enforce, and
// `seatCommand(...)` composes the pane's command line. crew.mjs resolves the
// adapter by seat.agent (default 'claude', overridable via --agent-<role>),
// by filename — nothing in crew.mjs knows pi exists. pi's flag grammar
// differs from claude's (see below), so there is no byte-identity bar here
// the way there is for adapter-claude.mjs; this adapter is judged on
// honesty of its capability claims, not on matching another agent's shape.
export const capabilities = Object.freeze({
  // --append-system-prompt treats an existing path as file contents
  // (verified in pi's resource-loader), so the merged role file lands intact.
  prompt_file: true,
  // --exclude-tools is pi's enforced denylist (filters the active tool set
  // by exact name match). translateDeny() maps the seat's claude-named deny
  // list into pi's own tool namespace before it reaches this flag — see the
  // translation table below.
  tool_deny: true,
  // pi has no per-tool approval gate at all, so there is nothing to bypass.
  // (--approve/-a only governs trusting project-local config files, not
  // tool calls — deliberately not passed here.)
  unattended: true,
  // --session-id can create/resume an exact session; crew does not pass one
  // today, but the mechanism exists.
  session_resume: true,
  // --thinking <off|minimal|low|medium|high|xhigh|max> (also the
  // ':<level>' model-string shorthand) — live-verified 2026-08-13: a
  // luna:high seat showed "gpt-5.6-luna • high" in its status bar.
  effort: true,
})

// pi namespaces models as <pi-provider>/<id>. openai -> openai-codex is
// DELIBERATE: that provider routes through the ChatGPT subscription OAuth
// (verified `pi auth check --provider openai-codex`).
export const PI_PROVIDERS = Object.freeze({ openai: 'openai-codex', anthropic: 'anthropic' })

export function modelString({ provider, id }) {
  const p = PI_PROVIDERS[provider]
  if (!p) throw new Error(`adapter-pi: no pi provider for roster provider "${provider}" (known: ${Object.keys(PI_PROVIDERS).join(', ')}) — refusing a guessed passthrough: pi synthesizes phantom models on narrowed lookups`)
  return `${p}/${id}`
}

// claude tool name -> pi tool name. null = the tool has no pi equivalent, so
// denying it is vacuously satisfied: pi has NO subagent tool at all, which is
// why Task/Agent drop. That drop is honest, not a hole.
const PI_TOOL_NAMES = Object.freeze({
  Read: 'read', Write: 'write', Edit: 'edit', Bash: 'bash',
  NotebookEdit: null, Task: null, Agent: null,
})

// Unknown claude names DROP rather than pass through: passing an unmatched
// name would be inert inside pi anyway, and a typo must not look enforced.
export function translateDeny(deny) {
  const out = []
  for (const raw of String(deny || '').split(',')) {
    const name = raw.trim()
    if (!name) continue
    const mapped = PI_TOOL_NAMES[name]
    if (!mapped) continue
    if (!out.includes(mapped)) out.push(mapped)
  }
  return out
}

export function seatCommand({ role, model, promptFile, tools, deny, taskDir, bootBrief, effort }) {
  // Same env-var contract as the claude adapter (`env`, DEVTEAM_WORKER=1,
  // CREW_ROLE, CREW_TASK_DIR) so plugin-quieting and role/taskDir discovery
  // work regardless of which binary fills the seat.
  //
  // `tools` (the claude-named allowedTools list) is intentionally accepted
  // and unused: pi's --tools/-t allowlist takes pi-namespaced names
  // (read/bash/edit/write/find/grep/ls), so feeding it the seat's
  // claude-named allowlist would disable every real tool. It stays in the
  // signature for contract symmetry with the adapter interface.
  //
  // `deny` (the claude-named disallowedTools list, e.g. "Edit,NotebookEdit")
  // is translated via translateDeny() into pi's own tool namespace before it
  // reaches --exclude-tools. A seat whose translated list comes back empty
  // (e.g. the builder: "Task,Agent" has no pi equivalent) omits the flag
  // entirely rather than passing pi an empty/quoted no-op — pi has no
  // subagent tool at all, so that boundary is vacuously satisfied, not
  // silently dropped.
  //
  // --print/-p and --no-session are deliberately never passed: --print exits
  // after the boot brief and --no-session drops the seat's session — either
  // one would destroy the pane's persistence, so their absence here is
  // load-bearing, not incidental.
  //
  // --provider is deliberately never passed either, same class of omission:
  // with no --provider, pi pattern-matches the model id across all providers
  // and an unmatched id is a hard `Model "X" not found` error
  // (model-resolver.js:424-430). Passing --provider google narrows the
  // candidate set (model-resolver.js:349), and buildFallbackModel
  // (:398-422) then synthesizes a google model whose id is the literal
  // pattern, returning it with only a warning — a phantom seat that dies on
  // its first message instead of failing to boot.
  // effort is OPTIONAL and additive: absent, the command is unchanged. It
  // maps to --thinking (NOT the ':<level>' model-string shorthand, so a
  // roster model id passes through untouched and effort stays a separate,
  // auditable dimension).
  const piDeny = translateDeny(deny)
  return [
    'env', 'DEVTEAM_WORKER=1', `CREW_ROLE=${role}`, `CREW_TASK_DIR="${taskDir}"`,
    'pi',
    '--model', model,
    ...(effort ? ['--thinking', effort] : []),
    ...(piDeny.length ? ['--exclude-tools', `"${piDeny.join(',')}"`] : []),
    '--append-system-prompt', `"${promptFile}"`,
    `"${bootBrief}"`,
  ].join(' ')
}
