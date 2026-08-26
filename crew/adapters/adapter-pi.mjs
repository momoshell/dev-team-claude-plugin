import { fileURLToPath } from 'node:url'

// crew/adapters/adapter-pi.mjs — the pi agent adapter.
//
// An adapter is the seam between a crew seat and the CLI agent that fills it:
// `capabilitiesFor(...)` resolves one frozen profile per (adapter, transport)
// pair, and `seatCommand(...)` composes the pane's command line. crew.mjs resolves the
// adapter by seat.agent (default 'claude', overridable via --agent-<role>),
// by filename, so no adapter name is hard-coded on the seat-resolution path.
// One site outside it does branch on the literal 'pi': assertAdvisorCellLive
// (crew/crew.mjs) refuses an advisor cell whose builder adapter is anything
// else. pi's flag grammar
// differs from claude's (see below), so there is no byte-identity bar here
// the way there is for adapter-claude.mjs; this adapter is judged on
// honesty of its capability claims, not on matching another agent's shape.
const INVARIANT = Object.freeze({
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
  // pi ships no subagent tool, so fan-out is a GRANT: an extension plus an
  // agent definition named in the checkout-pinned capability register, never
  // an assumption about the binary.
  subagents: false,
  // --thinking <off|minimal|low|medium|high|xhigh|max> (also the
  // ':<level>' model-string shorthand) — live-verified 2026-08-13: a
  // luna:high seat showed "gpt-5.6-luna • high" in its status bar.
  effort: true,
  // PI_CODING_AGENT_DIR (below) and the pi_provider namespace lookup
  // (modelString) are the checkout-pinned local-provider seams.
  local_provider: true,
})

const PROFILES = Object.freeze({
  pane: Object.freeze({
    // ADR-029 §3:52 — pane interjection is not established by a capture.
    interjection: 'none',
    // ADR-029 §3:53 — pane owns no process handle for an abort.
    abort: 'none',
    // ADR-029 §3:54 — pane command passes no --session-id.
    session_resume: false,
    // ADR-029 §3:54 — pane has no client-resumable observation cursor.
    durable_cursor: 'none',
    // #131 — drive.mjs bounce paths reassign a settled pane seat.
    reassign: true,
  }),
  'headless-rpc': Object.freeze({
    // ADR-029 §3:52 — pi RPC steer delivers at a tool boundary.
    interjection: 'boundary',
    // ADR-029 §3:53 — pi RPC exposes an in-protocol abort command.
    abort: 'command',
    // ADR-029 §3:54 — RPC resumes the persisted pi session.
    session_resume: true,
    // ADR-029 §3:54 — pi RPC's session entry id is a durable cursor.
    durable_cursor: 'entry_id',
    // #148 — captured 2026-08-14 (captures/pi-b11-reassign.jsonl): a SETTLED
    // session takes a further assignment both on the same process and on a new
    // process resuming it with --session, with history intact across the
    // process boundary (the recall arm answered with turn 1's marker from a
    // different process). #131's `false` recorded the absence of a capture,
    // not an observed limitation.
    reassign: true,
  }),
})

export function capabilitiesFor({ transport, grants } = {}) {
  const p = PROFILES[transport]
  if (!p) throw new Error(`adapter-pi: no capability profile for transport "${transport}" (shipped: ${Object.keys(PROFILES).join(', ')}) — refusing a guessed passthrough`)
  return Object.freeze({
    ...INVARIANT, ...p,
    // A FUNCTION OF THE GRANTS, on both transports (#693). It was pane-only
    // while rpcCommand emitted neither `-e` nor `--tools`; it now emits both,
    // live-probed against pi 0.84.3.
    subagents: (grants?.agents?.length ?? 0) > 0,
  })
}

// pi namespaces models as <pi-provider>/<id>. openai -> openai-codex is
// DELIBERATE: that provider routes through the ChatGPT subscription OAuth
// (verified `pi auth check --provider openai-codex`).
export const PI_PROVIDERS = Object.freeze({ openai: 'openai-codex', anthropic: 'anthropic' })

export function modelString({ provider, id, localProviders }) {
  const p = PI_PROVIDERS[provider] ?? localProviders?.[provider]?.pi_provider
  if (!p) {
    const known = Object.keys({ ...PI_PROVIDERS, ...(localProviders || {}) })
    throw new Error(`adapter-pi: no pi provider for roster provider "${provider}" (known: ${known.join(', ')}) — refusing a guessed passthrough: pi synthesizes phantom models on narrowed lookups`)
  }
  return `${p}/${id}`
}

// claude tool name -> pi tool name. null = the tool has no pi equivalent, so
// denying it is vacuously satisfied: pi has NO subagent tool at all, which is
// why Task/Agent drop. The drop stays honest only because the grant that would
// make pi fan out is refused at boot (assertFanoutCoherent, crew/crew.mjs); the
// dropped denial itself enforces nothing.
const PI_TOOL_NAMES = Object.freeze({
  Read: 'read', Write: 'write', Edit: 'edit', Bash: 'bash',
  NotebookEdit: null, Task: null, Agent: null,
})

// pi's COMPLETE built-in tool set, in pi's own namespace, as literals
// (dist/core/tools/index.js:17 — allToolNames, pi 0.84.2). This is the
// adapter's own knowledge of pi, NOT a translation of the seat's
// claude-named `tools` allowlist: #146/#147 ratified that that list stays
// unused, and mapping it here would undo both.
export const PI_BUILTIN_TOOLS = Object.freeze(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'])

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

// The tool name crew/pi/extensions/subagent.ts registers. Exported so the
// register-path tests can name it without a literal.
export const PI_SUBAGENT_TOOL = 'agent'

// The advisor extension a register-granted seat loads. The register grants a
// BOOLEAN, not a path, so the path is the adapter's own checkout-pinned
// knowledge — resolved from this file's URL, never from cwd.
export const PI_ADVISOR_EXTENSION = fileURLToPath(new URL('../pi/extensions/advisor.ts', import.meta.url))
export const PI_ADVISOR_ENV = 'CREW_ADVISOR'
export const PI_ADVISOR_ENDPOINT_ENV = 'CREW_ADVISOR_ENDPOINT'
export const PI_ADVISOR_MODEL_ENV = 'CREW_ADVISOR_MODEL'

// POSIX single-quoting: a literal apostrophe closes the quote, escapes and
// reopens. A loopback URL may legally contain one and a model id is a
// command-line value, so neither is interpolated raw.
export function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `\'"\'"\'`)}'`
}

const NO_GRANTS = Object.freeze({ tools: [], extensions: [], agents: [], skills: [], advisor: false })

export function seatCommand({ role, model, promptFile, tools, deny, taskDir, bootBrief, effort, grants = NO_GRANTS, configDir = null, advisorCell = null }) {
  // Same env-var contract as the claude adapter (`env`, DEVTEAM_WORKER=1,
  // CREW_ROLE, CREW_TASK_DIR) so plugin-quieting and role/taskDir discovery
  // work regardless of which binary fills the seat.
  //
  // #146/#217: deny-only for enforcement, full built-in activation for
  // capability — #217 does not reverse #146. `tools` stays in the signature
  // for contract symmetry: adapter-claude.mjs genuinely passes it as
  // --allowedTools in both seatCommand and headlessCommand, so deleting it
  // would break the shared adapter contract. There is no translateTools()
  // counterpart: the activator below is a literal list in pi's namespace,
  // never translated from `tools`; `tools` stays unused and stays
  // enforced-unused by the test.
  // Only read/bash/edit/write are active by default (dist/core/sdk.js:132),
  // so --tools is an activator, not a restrictor; without it a pi-seated
  // planner reaches the filesystem through bash alone. pi silently ignores
  // an unmapped name (dist/cli/args.js:85-90), so a stale list would disable
  // a live tool while looking enforced — hence the drift pin in
  // crew/adapter-pi.test.mjs.
  // --exclude-tools beats --tools on both of pi's filter paths
  // (dist/core/sdk.js:137 and dist/core/agent-session.js:1945), so activation
  // cannot widen the denial of any tool pi ACTUALLY HAS.
  // Activation is append-only over pi's built-in set: register tools can add
  // names, but never remove or replace a built-in.
  // What that ANDed denial does NOT cover, and this is the honest statement of
  // it: a claude name with no pi equivalent translates to nothing, so for the
  // FANOUT_TOOLS names (PI_TOOL_NAMES maps Task/Agent/NotebookEdit to null,
  // :95-98) the deny list comes back EMPTY, --exclude-tools is omitted, and
  // there is nothing for a grant to be ANDed with. The fan-out boundary for a
  // pi seat is therefore NOT --exclude-tools: it is assertFanoutCoherent
  // (crew/crew.mjs), which refuses at boot a register that grants fan-out to a
  // seat whose defaults withhold it.
  // --no-extensions disables discovery while explicit -e paths remain usable;
  // --no-skills is the matching closed posture when no skill is granted. These
  // flags make a seat a function of this checkout rather than user-global pi
  // state, and are enforced by crew/adapter-pi.test.mjs.
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
  // This omission is ENFORCED, not merely explained: crew/adapter-pi.test.mjs
  // fails if `--provider` ever appears in a composed seat command (#147).
  // effort is OPTIONAL and additive: absent, the command is unchanged. It
  // maps to --thinking (NOT the ':<level>' model-string shorthand, so a
  // roster model id passes through untouched and effort stays a separate,
  // auditable dimension).
  const piDeny = translateDeny(deny)
  // An agent grant must ALSO activate the tool: pi filters EXTENSION tools
  // through this same --tools allowlist (dist/core/agent-session.js:1945 and
  // :1953 drop any registered tool the allowlist omits), so a granted seat
  // whose activator omits the name loads the extension and registers nothing
  // callable. Extension tools are active by default ONLY when --tools is
  // absent (:2003-2007) — this adapter always passes it, so activation is
  // mandatory here, not merely additive.
  const fanout = (grants?.agents?.length ?? 0) > 0 ? [PI_SUBAGENT_TOOL] : []
  const activatedTools = [...new Set([...PI_BUILTIN_TOOLS, ...(grants?.tools || []), ...fanout])]
  const advisor = grants?.advisor === true
  const extensions = [...new Set([...(grants?.extensions || []), ...(advisor ? [PI_ADVISOR_EXTENSION] : [])])]
  const skills = grants?.skills || []
  return [
    'env', 'DEVTEAM_WORKER=1', `CREW_ROLE=${role}`, `CREW_TASK_DIR="${taskDir}"`,
    ...(configDir !== null && configDir !== undefined ? [`PI_CODING_AGENT_DIR="${configDir}"`] : []),
    // The advisor activates no tool; --tools stays the complete built-in set.
    ...(advisor ? [
      `${PI_ADVISOR_ENV}=1`,
      ...(advisorCell?.endpoint !== undefined ? [`${PI_ADVISOR_ENDPOINT_ENV}=${shellSingleQuote(advisorCell.endpoint)}`] : []),
      ...(advisorCell?.model !== undefined ? [`${PI_ADVISOR_MODEL_ENV}=${shellSingleQuote(advisorCell.model)}`] : []),
    ] : []),
    // The register-resolved allowlist, transported to the extension. Emitted
    // ONLY when an agent is granted, so every ungranted command is unchanged.
    // Before `pi`, because the boot brief must stay last.
    ...(grants?.agents?.length
      ? [`CREW_PI_AGENTS='${JSON.stringify(grants.agents.map(({ name, def }) => ({ name, def })))}'`]
      : []),
    'pi',
    '--model', model,
    ...(effort ? ['--thinking', effort] : []),
    '--tools', `"${activatedTools.join(',')}"`,
    ...(piDeny.length ? ['--exclude-tools', `"${piDeny.join(',')}"`] : []),
    '--no-extensions',
    ...extensions.flatMap((extension) => ['-e', `"${extension}"`]),
    ...(skills.length ? skills.flatMap((skill) => ['--skill', `"${skill}"`]) : ['--no-skills']),
    '--append-system-prompt', `"${promptFile}"`,
    `"${bootBrief}"`,
  ].join(' ')
}
