// crew/adapters/adapter-claude.mjs — the claude agent adapter.
//
// An adapter is the seam between a crew seat and the CLI agent that fills it:
// `capabilities` (frozen) declares what the agent can enforce, and
// `seatCommand(...)` composes the pane's command line. crew.mjs resolves the
// adapter by seat.agent (default 'claude', overridable via --agent-<role>)
// and never builds the invocation itself — that composition lives here.
//
// seatCommand's output is a compatibility surface: for this adapter it is
// byte-identical to the pre-refactor paneCommand() in crew.mjs (see
// crew.test.mjs's byte-identity pin). Any change to the string below is a
// behavior change, not a refactor.
export const capabilities = Object.freeze({
  prompt_file: true, tool_deny: true, unattended: true, session_resume: true,
  // claude --effort <low|medium|high|xhigh|max> (verified against the
  // installed CLI 2026-08-13) — the roster's effort dimension is enforceable.
  effort: true,
})

export function seatCommand({ role, model, promptFile, tools, deny, taskDir, bootBrief, effort }) {
  // `env` (a real binary) sets the vars regardless of how cmux runs the
  // command. DEVTEAM_WORKER=1 keeps any installed dev-team plugin hooks
  // quiet inside the pane (defensive; a no-op when the plugin is absent).
  // bypassPermissions: crew seats run unattended (no human at their pane to
  // approve). The ENFORCED tool boundary is --disallowedTools (it holds even
  // under bypass; --allowedTools is only an auto-approve list and is inert
  // here) — beyond that, containment is the git scope gate, the feature-
  // branch blast radius, and the operator's global deny rules.
  // effort is OPTIONAL: absent, the command stays byte-identical to the
  // pre-effort adapter (the compatibility pin in crew.test.mjs holds).
  return [
    'env', 'DEVTEAM_WORKER=1', `CREW_ROLE=${role}`, `CREW_TASK_DIR="${taskDir}"`,
    'claude', '--model', model, '--permission-mode', 'bypassPermissions',
    ...(effort ? ['--effort', `"${effort}"`] : []),
    '--allowedTools', `"${tools}"`,
    '--disallowedTools', `"${deny}"`,
    '--append-system-prompt-file', `"${promptFile}"`,
    `"${bootBrief}"`,
  ].join(' ')
}
