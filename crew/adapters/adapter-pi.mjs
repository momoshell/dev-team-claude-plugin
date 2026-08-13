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
  // by exact name match). MECHANISM is honest — see the namespace-gap note
  // on `tools`/`deny` below for what it does NOT yet translate.
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
  // is passed through to --exclude-tools UNCHANGED. pi filters tools by an
  // exact, case-sensitive name match against its own namespace
  // (read/bash/edit/write/...), so a claude-shaped deny list currently
  // excludes nothing inside pi. tool_deny: true stays honest at the
  // mechanism level (pi can deny tools, and the flag is wired) — but the
  // namespace translation is deliberately out of scope for this build; see
  // issue #44's live-dogfood acceptance and the recommendation to restrict
  // pi seats to judgment roles until a claude->pi tool-name map exists.
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
  return [
    'env', 'DEVTEAM_WORKER=1', `CREW_ROLE=${role}`, `CREW_TASK_DIR="${taskDir}"`,
    'pi',
    '--model', model,
    ...(effort ? ['--thinking', effort] : []),
    '--exclude-tools', `"${deny}"`,
    '--append-system-prompt', `"${promptFile}"`,
    `"${bootBrief}"`,
  ].join(' ')
}
