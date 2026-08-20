// The crew's first-party pi subagent extension: one `agent` tool that spawns a
// read-only pi child from a register-granted agent definition, blocks on it, and
// returns schema-validated findings plus a complete-or-absent pi Usage.
//
// Why .ts: pi loads extensions through jiti (dist/core/extensions/loader.js:14,
// :358, :368), so no build step exists. Node imports this file directly via
// unflagged type stripping, which means it MUST stay erasable-syntax-only:
// annotations, `interface`, `type`, `as`, `satisfies` — never `enum`, never
// `namespace`, never parameter properties.
//
// Why zero-dep: pi is not a dependency of this checkout, so pi's types are
// declared locally instead of imported, and nothing outside `node:` is reachable.
// The repo's own suite must be able to import this file.
//
// Re-authored from the bundled subagent example in
// @earendil-works/pi-coding-agent 0.84.2 (examples/extensions/subagent).
// pi is MIT-licensed (package.json "license": "MIT", "author": "Mario Zechner",
// upstream github.com/earendil-works/pi), but its npm tarball ships NO licence
// file: the package.json `files` allowlist is ["dist","docs","examples",
// "containerization.md","CHANGELOG.md","npm-shrinkwrap.json"] and there is no
// LICENSE, COPYING or NOTICE anywhere in the installed package. A notice that
// pointed at that file would point at nothing, so the licence is vendored HERE,
// in full:
//
//   MIT License
//
//   Copyright (c) 2025 Mario Zechner
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.
//
// Nothing here is a copy: the tool surface, the schema validation, the
// register-sourced allowlist, the depth guard, the complete-or-absent usage
// record and the journal row are this repo's own.

import { spawn as nodeSpawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { appendFileSync, existsSync as nodeExists, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const AGENT_TOOL_NAME = 'agent'
export const AGENTS_ENV = 'CREW_PI_AGENTS'
export const DEPTH_ENV = 'CREW_PI_SUBAGENT_DEPTH'

// The child's enforced boundary. --exclude-tools beats --tools on pi's filter,
// so this is the real read-only line; the definition's `tools` is an activator.
export const SUBAGENT_DENY = ['edit', 'write', 'bash']

// A plain JSON Schema object: pi takes an explicit non-TypeBox branch when the
// schema carries no Symbol.for('TypeBox.Kind')
// (@earendil-works/pi-ai/dist/utils/validation.js:285-286), so no typebox
// import is needed.
//
// PERMISSIVE BY DESIGN, and that is load-bearing rather than lazy. pi validates
// tool arguments BEFORE execute() and, when validation fails, throws a message
// that embeds `JSON.stringify(toolCall.arguments, null, 2)` verbatim and
// unbounded (validation.js:302-307); agent-loop.js:445-450 turns that message
// into the tool RESULT the model reads, and the session file persists it.
// execute() is never reached, so nothing written here can bound it. A TIGHTER
// schema therefore makes refusals LESS payload-free, not more: a missing key, an
// extra key and a wrong type all divert into pi's unbounded echo instead of our
// bounded, payload-free refusal. Measured both ways in
// evidence/schema-permissive.out — and the tight schema also silently COERCED
// (`agent: 12` arrived as `"12"`), which is a second reason to type-check below.
// Every constraint therefore lives in execute(), and the properties carry
// descriptions only: a `type` here is a constraint that can fail.
//
// This is NOT a claim that a refusal is payload-free end to end. pi also emits
// the raw arguments to the terminal on every call, before validation and before
// execute (@earendil-works/pi-agent-core/dist/agent-loop.js:335-340), and we
// cannot bound that. What is bounded is everything THIS tool returns.
export const AGENT_PARAMS = {
  type: 'object',
  additionalProperties: true,
  properties: {
    agent: { description: 'The name of an agent granted to this seat by the crew capability register.' },
    task: { description: 'The one narrow question the scout must answer.' },
  },
}

export const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string', minLength: 1 },
    findings: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'evidence', 'confidence'],
        properties: {
          claim: { type: 'string', minLength: 1 },
          evidence: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          confidence: { enum: ['verified', 'assumed'] },
        },
      },
    },
    gaps: { type: 'array', items: { type: 'string' } },
  },
}

// pi's stated limits for content returned TO THE MODEL
// (dist/core/tools/truncate.js:10-11). They bound the result, nothing else.
export const OUTPUT_CAP_BYTES = 50 * 1024
export const OUTPUT_CAP_LINES = 2000

// A separate, larger defensive bound on the CHILD'S EVENT STREAM. pi's JSON mode
// replays every message across message_end/turn_end/agent_end, so a scout that
// reads thirty files emits hundreds of KB around a 2KB payload. Collapsing the
// two bounds would reject that scout.
// ONE bound, in bytes. A line counter would be a second metric with no
// independent safety property: a stream of arbitrarily many tiny lines is
// already bounded by the byte total, and an untested second constant is worse
// than no constant at all.
export const STREAM_CAP_BYTES = 4 * 1024 * 1024

// A model-supplied agent name is an IDENTIFIER, not a payload. Clamped once at
// the top of execute so every downstream use — details.agent and the journal
// row — is bounded by construction rather than by remembering to bound it.
export const AGENT_NAME_CAP_BYTES = 128

// The child's deadline. Enforced by an injected timer that reuses the abort
// path's SIGTERM-then-SIGKILL escalation. node's own spawn `timeout` option is
// deliberately NOT used: measured, it emits close(null, 'SIGTERM') with no
// escalation and no distinguishing signal, so a child that ignores SIGTERM
// leaves execute pending forever (evidence/spawn-timeout.out).
export const CHILD_TIMEOUT_MS = 10 * 60 * 1000

// Every code this validator can return, as a closed set. The refusal text is
// built from these and NOTHING else, which is what bounds it: a payload cannot
// lengthen the refusal, because the only strings that reach it come from here.
// Structural impossibility over an assertion (docs/conventions.md 2026-08-01).
export const FINDINGS_ERROR_CODES = Object.freeze([
  'payload-not-an-object', 'unknown-key', 'summary-invalid', 'findings-not-a-non-empty-array',
  'finding-not-an-object', 'finding-unknown-key', 'finding-claim-invalid',
  'finding-evidence-invalid', 'finding-confidence-invalid', 'gaps-invalid',
])

// Same spirit as validateCapabilities (crew/crew.mjs:140-218): returns codes,
// never throws. DELIBERATELY payload-free and index-free, and deduped by the
// caller: a payload with 50k unknown keys, or an unknown key whose NAME is 50KB,
// must not be able to grow the model-visible refusal by one byte. Interpolating
// the offending key or value here is exactly how a schema-invalid child bypassed
// the result cap and echoed itself into the parent's context.
export function validateFindings(value: any): string[] {
  const errors: string[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['payload-not-an-object']
  for (const key of Object.keys(value)) {
    if (!['summary', 'findings', 'gaps'].includes(key)) errors.push('unknown-key')
  }
  if (typeof value.summary !== 'string' || value.summary.length < 1) errors.push('summary-invalid')
  if (!Array.isArray(value.findings) || value.findings.length < 1) {
    errors.push('findings-not-a-non-empty-array')
  } else {
    value.findings.forEach((item: any) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push('finding-not-an-object'); return }
      for (const key of Object.keys(item)) {
        if (!['claim', 'evidence', 'confidence'].includes(key)) errors.push('finding-unknown-key')
      }
      if (typeof item.claim !== 'string' || item.claim.length < 1) errors.push('finding-claim-invalid')
      if (!Array.isArray(item.evidence) || item.evidence.length < 1) {
        errors.push('finding-evidence-invalid')
      } else if (item.evidence.some((one: any) => typeof one !== 'string' || one.length < 1)) {
        errors.push('finding-evidence-invalid')
      }
      if (item.confidence !== 'verified' && item.confidence !== 'assumed') {
        errors.push('finding-confidence-invalid')
      }
    })
  }
  if (value.gaps !== undefined) {
    if (!Array.isArray(value.gaps) || value.gaps.some((one: any) => typeof one !== 'string')) errors.push('gaps-invalid')
  }
  return errors
}

export function extractFindings(text: string): any {
  const raw = String(text ?? '').trim()
  if (!raw) return { error: 'the child returned no text' }
  if (raw.startsWith('{')) {
    // V8's JSON.parse message embeds a snippet of the INPUT ("Unexpected token
    // 'Q', \"{\\\"a\\\":QQQ\"... is not valid JSON"), so it is payload-derived and
    // does not belong in model-visible text. The class alone is the diagnosis.
    try { return { value: JSON.parse(raw) } } catch { return { error: 'the child\'s JSON did not parse' } }
  }
  const fences = [...raw.matchAll(/```json\s*\n([\s\S]*?)\n\s*```/g)]
  if (fences.length === 0) return { error: 'the child returned prose, not a findings payload' }
  if (fences.length > 1) return { error: `the child returned ${fences.length} json blocks; exactly one is required` }
  try { return { value: JSON.parse(fences[0][1]) } } catch { return { error: 'the child\'s fenced JSON did not parse' } }
}

// Only for an `agent` result that refused. pi splits the mechanisms: a returned
// value never sets the error flag, the tool_result patch does. The patch carries
// ONLY isError — the runner merges field-by-field and copies a handler field only
// when it is !== undefined (dist/core/extensions/runner.js:660-677), so our
// details and usage survive untouched.
export function toolResultPatch(event: any): any {
  if (!event || event.toolName !== AGENT_TOOL_NAME) return undefined
  if (!event.details || !event.details.refused) return undefined
  return { isError: true }
}

export function parseAgentAllowlist(raw: any): any[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  let parsed
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((one) => one && typeof one.name === 'string' && typeof one.def === 'string')
}

// The four refusal classes and the wording of grantsFor (crew/crew.mjs:284-303),
// so the two validators cannot drift apart silently.
export function loadAgentDefinition(grant: any, deps: any = {}): any {
  const readFile = deps.readFile || readFileSync
  const path = String(grant?.def || '')
  let text
  try { text = readFile(path, 'utf8') } catch (err: any) {
    return { error: `expected a readable JSON definition, found unreadable (${err.message}), at ${path}` }
  }
  let definition
  try { definition = JSON.parse(text) } catch (err: any) {
    return { error: `expected parseable JSON, found unparseable (${err.message}), at ${path}` }
  }
  if (typeof definition?.name !== 'string' || definition.name !== grant.name) {
    return { error: `expected name ${JSON.stringify(grant.name)}, found name ${JSON.stringify(definition?.name)}, at ${path}` }
  }
  if (typeof definition.prompt !== 'string' || !definition.prompt.trim()) {
    return { error: `expected a non-empty prompt, found ${JSON.stringify(definition.prompt)}, at ${path}` }
  }
  const tools = Array.isArray(definition.tools) && definition.tools.length ? definition.tools.map(String) : ['read', 'grep', 'find', 'ls']
  return { definition: { name: definition.name, prompt: definition.prompt, tools, model: typeof definition.model === 'string' ? definition.model : undefined, thinking: typeof definition.thinking === 'string' && definition.thinking.trim() ? definition.thinking : undefined } }
}

// -p/--no-session are correct HERE (a one-shot child) and forbidden on a seat
// command. --no-extensions (dist/cli/args.js:124-126) is the structural half of
// the depth guard: it disables extension DISCOVERY, and since this argv passes
// no `-e` at all — the one thing --no-extensions still honours (args.js:279) —
// the child cannot load this file again by any route. No --provider, ever.
export function childArgs({ def, task, promptFile, model, thinking }: any): string[] {
  const args = ['--mode', 'json', '-p', '--no-session']
  if (model) args.push('--model', model)
  if (thinking) args.push('--thinking', thinking)
  args.push('--tools', def.tools.join(','))
  args.push('--exclude-tools', SUBAGENT_DENY.join(','))
  args.push('--no-extensions', '--no-skills')
  args.push('--append-system-prompt', promptFile)
  args.push(`Task: ${task}`)
  return args
}

// A bare 'pi' would silently run a different version than the parent, and a
// PATH-resolved command also destroys the one distinction the classifier rests
// on: node reports a spawn failure as an `error` event followed by close(-2)
// (evidence/spawn-error-ordering.out), so ENOENT is only distinguishable from a
// child exiting 1 while the command is one the OS can either execute or fail on
// for a knowable reason. process.execPath is always absolute; when neither tier
// applies we REFUSE rather than guess PATH, and the absoluteness is checked
// structurally rather than assumed.
export function resolvePiBinary(deps: any = {}): any {
  const argv = deps.argv || process.argv
  const execPath = deps.execPath || process.execPath
  const exists = deps.existsSync || nodeExists
  const absolute = (command: string, args: string[]) => (String(command).startsWith('/')
    ? { command, args }
    : { error: 'the pi executable could not be resolved to an absolute path' })
  const script = argv[1]
  if (script && !String(script).startsWith('/$bunfs/root/') && exists(script)) {
    return absolute(execPath, [String(script)])
  }
  const base = String(execPath).split('/').pop() || ''
  if (base && base !== 'node' && base !== 'bun') return absolute(execPath, [])
  return { error: 'the pi executable could not be resolved to an absolute path' }
}

// THE reducer. The child's transcript is never retained: each frame is folded
// the moment it is decoded and then dropped, so the memory bound is one line
// plus two small accumulators — not the stream.
//
// message_end carries the spend; turn_end and agent_end REPLAY it, and
// message_update is cumulative — folding any of them double-counts
// (crew/headless-rpc.mjs:100-102). agent-loop.js:551 also emits a message_end
// whose message.role is 'toolResult': that is a nested tool's spend, not the
// child's, so the role filter is load-bearing.
export function createStreamReducer() {
  let measured = false
  let text = ''
  const billed = { billed_input_tokens: 0, billed_output_tokens: 0, billed_cache_write_tokens: 0, billed_cache_read_tokens: 0 }
  const pi = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
  return {
    push(frame: any) {
      if (!frame || frame.type !== 'message_end') return
      const message = frame.message
      if (!message || message.role !== 'assistant') return
      // The LAST assistant message_end wins, concatenating EVERY text part:
      // first-only silently drops a reply split across parts.
      const content = message.content
      if (typeof content === 'string') text = content
      else if (Array.isArray(content)) {
        text = content.filter((part: any) => part && part.type === 'text').map((part: any) => String(part.text ?? '')).join('')
      }
      const usage = message.usage
      if (!usage) return
      measured = true
      billed.billed_input_tokens += Number(usage.input) || 0
      billed.billed_output_tokens += Number(usage.output) || 0
      billed.billed_cache_write_tokens += Number(usage.cacheWrite) || 0
      billed.billed_cache_read_tokens += Number(usage.cacheRead) || 0
      pi.input += Number(usage.input) || 0
      pi.output += Number(usage.output) || 0
      pi.cacheRead += Number(usage.cacheRead) || 0
      pi.cacheWrite += Number(usage.cacheWrite) || 0
      pi.totalTokens += Number(usage.totalTokens) || 0
      const cost = usage.cost || {}
      pi.cost.input += Number(cost.input) || 0
      pi.cost.output += Number(cost.output) || 0
      pi.cost.cacheRead += Number(cost.cacheRead) || 0
      pi.cost.cacheWrite += Number(cost.cacheWrite) || 0
      pi.cost.total += Number(cost.total) || 0
    },
    // null when nothing was measured — never a fabricated zero.
    usage: () => (measured ? billed : null),
    // COMPLETE or null. pi's dist/core/usage-totals.js:15 is
    // `totals.cost += usage.cost.total`, an unconditional dereference, so a
    // partial object is a TypeError inside pi's own /session breakdown and a
    // missing scalar NaN-poisons the totals.
    piUsage: () => (measured ? pi : null),
    text: () => text,
  }
}

// The three array-taking helpers below exist for direct unit tests. `execute`
// drives the reducer itself and never builds a transcript array.
function reduceAll(lines: any[]) {
  const reducer = createStreamReducer()
  for (const line of lines || []) reducer.push(line)
  return reducer
}

export function foldUsage(lines: any[]): any {
  return reduceAll(lines).usage()
}

export function foldPiUsage(lines: any[]): any {
  return reduceAll(lines).piUsage()
}

export function lastAssistantText(lines: any[]): string {
  return reduceAll(lines).text()
}

// crew/crew.mjs:488-492 + crew/child.mjs:94 — the journal sits beside the task dir.
// The LAST line of defence on model-visible refusal text, applied in the single
// result constructor so it covers every refusal class that exists now and every
// one added later. The schema class is payload-free by construction (above), but
// a bound that depends on remembering to keep each individual message short is
// not a bound — this is. Truncation is by BYTES through a StringDecoder, so a cut
// never tears a code point into U+FFFD: the decoder holds the partial sequence
// back and, with no end() call, it is dropped.
export function boundRefusalText(text: string): string {
  const mark = ' …[truncated]'
  let out = String(text ?? '')
  const lines = out.split('\n')
  if (lines.length > OUTPUT_CAP_LINES) out = `${lines.slice(0, OUTPUT_CAP_LINES).join('\n')}${mark}`
  if (Buffer.byteLength(out) > OUTPUT_CAP_BYTES) {
    const room = OUTPUT_CAP_BYTES - Buffer.byteLength(mark)
    out = `${new StringDecoder('utf8').write(Buffer.from(out, 'utf8').subarray(0, room))}${mark}`
  }
  return out
}

// The same byte-truncation, for the one model-supplied IDENTIFIER this tool
// carries. Applied at the entry point, so details.agent and the journal row are
// bounded by construction: b33 shipped a 52,287-byte details.agent because the
// bound lived at the exits instead (evidence/repro-early-refusal-before.out).
export function boundAgentName(name: string): string {
  const out = String(name ?? '')
  if (Buffer.byteLength(out) <= AGENT_NAME_CAP_BYTES) return out
  return new StringDecoder('utf8').write(Buffer.from(out, 'utf8').subarray(0, AGENT_NAME_CAP_BYTES))
}

export function journalPathFrom(taskDir: string): string {
  return join(dirname(String(taskDir)), 'journal.jsonl')
}

// A bare presence key is how every other journal row discriminates itself.
export function usageRow({ at, role, agent, spawnId, model, usage, outcome }: any): any {
  return {
    at,
    subagent_usage: { spawn_id: spawnId, parent_role: role, agent, model: model ?? null, outcome },
    role,
    usage: usage ?? null,
  }
}

// Both caps are measured on the content the model actually receives, so the
// rendering is part of the contract rather than an implementation detail.
// Internal on purpose: the execute-path cap fixtures pin its behaviour, so a
// public export would widen the API for nothing.
function renderFindings(findings: any): string {
  return JSON.stringify(findings, null, 2)
}

export function createAgentTool(deps: any = {}) {
  const env = deps.env || process.env
  const spawn = deps.spawn || nodeSpawn
  const readFile = deps.readFile || readFileSync
  const writeFile = deps.writeFile || writeFileSync
  const appendFile = deps.appendFile || appendFileSync
  const mkTempDir = deps.mkTempDir || (() => mkdtempSync(join(tmpdir(), 'crew-pi-subagent-')))
  const removeDir = deps.removeDir || ((dir: string) => rmSync(dir, { recursive: true, force: true }))
  const now = deps.now || (() => new Date().toISOString())
  const randomId = deps.randomId || (() => Math.random().toString(36).slice(2, 10))
  // Injected so the abort escalation is deterministic in a test rather than a
  // two-second wall-clock wait.
  const isDirectory = deps.isDirectory || ((path: string) => {
    try { return statSync(path).isDirectory() } catch { return false }
  })
  const setTimer = deps.setTimeout || setTimeout
  const clearTimer = deps.clearTimeout || clearTimeout
  const killGraceMs = deps.killGraceMs ?? 2000

  return {
    name: AGENT_TOOL_NAME,
    label: 'Agent',
    description: 'Spawn a read-only scout subagent from the crew capability register and return its schema-validated findings.',
    parameters: AGENT_PARAMS,
    // One child at a time — the honest reading of blocking semantics. One
    // sequential call makes the whole batch sequential (agent-loop.js:289).
    executionMode: 'sequential',
    async execute(_toolCallId: string, params: any, signal: any, _onUpdate: any, ctx: any) {
      const role = String(env.CREW_ROLE || 'unknown')
      const taskDir = String(env.CREW_TASK_DIR || '')
      const spawnId = randomId()
      const agentArg = params?.agent
      const agentName = typeof agentArg === 'string' ? boundAgentName(agentArg) : ''

      // THE result constructor. ONE of them, for success and for every refusal
      // class alike, which is what makes the bound a bound: b33 had two, and the
      // second was unbounded — 52,287 model-visible bytes with the model's own
      // marker echoed back (evidence/repro-early-refusal-before.out). A bound
      // that depends on each future constructor remembering to apply it is not a
      // bound; this one covers every class that exists now and every one added
      // later, for `content` and for `details` alike. The success path is
      // deliberately NOT truncated: findings over the cap are REFUSED below,
      // because handing the model silently shortened findings would be a lie.
      const finish = ({ findings, refused, usage, piUsage }: any) => {
        const bounded = findings ? null : boundRefusalText(String(refused))
        const text = findings ? renderFindings(findings) : bounded
        const details: any = { agent: agentName, spawn_id: spawnId, usage: usage ?? null }
        if (findings) details.findings = findings
        else details.refused = bounded
        // Complete or absent — never partial, never a fabricated zero.
        return piUsage
          ? { content: [{ type: 'text', text }], details, usage: piUsage }
          : { content: [{ type: 'text', text }], details }
      }
      // Pre-spawn refusals: nothing was spent, so they carry no usage and write
      // no journal row. Same constructor, same bound.
      const refuseEarly = (reason: string) => finish({ refused: reason })

      // Depth is OURS to enforce. pi sets PI_CODING_AGENT=true on every child
      // (dist/cli.js:12, dist/rpc-entry.js:6) and reads it NOWHERE in dist — it
      // is a marker for outside observers, not a guard — so nothing downstream
      // stops a second fan-out. --no-extensions is the structural half (the
      // child cannot load this file again) and DEPTH_ENV is the belt.
      const depth = env[DEPTH_ENV]
      if (depth !== undefined && depth !== null && String(depth) !== '' && Number(depth) >= 1) {
        // The raw value is deliberately absent: it is environment-derived and
        // arbitrarily long, and naming the rule IS the whole diagnosis.
        return refuseEarly(`refused: spawn depth is already 1 — a subagent may not fan out again (${DEPTH_ENV} is set)`)
      }
      const allowlist = parseAgentAllowlist(env[AGENTS_ENV])
      if (!allowlist.length) {
        return refuseEarly(`refused: no spawnable agents are granted to this seat; the allowlist comes from the crew capability register (crew/capabilities.json), transported as ${AGENTS_ENV}`)
      }
      // Register-derived, and clamped per name: the only non-literal string any
      // pre-spawn refusal carries.
      const allowedNames = allowlist.map((one) => boundAgentName(String(one.name))).join(', ')
      // The constraints the parameters schema deliberately does not impose (see
      // AGENT_PARAMS). Neither value is ever echoed: both are model-supplied.
      if (!agentName) {
        return refuseEarly(`refused: the "agent" argument must be a non-empty string naming a granted agent; allowed: ${allowedNames}`)
      }
      if (typeof params?.task !== 'string' || !params.task.trim()) {
        return refuseEarly('refused: the "task" argument must be a non-empty string')
      }
      const grant = allowlist.find((one) => one.name === agentName)
      if (!grant) {
        // The REQUESTED name is deliberately absent. Naming what IS allowed is
        // the requirement; echoing what was asked is exactly how a model-supplied
        // 52KB name reached the parent's context in b33.
        return refuseEarly(`refused: that agent is not granted to this seat; allowed: ${allowedNames}`)
      }
      const loaded = loadAgentDefinition(grant, { readFile })
      if (loaded.error) return refuseEarly(`refused: ${loaded.error}`)
      const def = loaded.definition

      // pi hands the session cwd on the fifth argument. A child spawned into a
      // missing or relative directory fails with an errno that reads like a
      // missing binary, so it is validated HERE, where the diagnosis is exact.
      const cwd = typeof ctx?.cwd === 'string' ? ctx.cwd : ''
      if (!cwd.startsWith('/') || !isDirectory(cwd)) {
        return refuseEarly(`refused: the session cwd is not an existing absolute directory, at ${cwd}`)
      }
      const binary = resolvePiBinary(deps)
      if (binary.error) return refuseEarly(`refused: ${binary.error}`)

      // pi hands the session's authoritative model, thinking level and cwd on the
      // FIFTH argument (dist/core/extensions/types.d.ts:217, :223, :230). There is
      // no process-wide inheritance: without this, a definition that omits `model`
      // runs under pi's unrelated configured default, in the wrong directory.
      const parentModel = ctx?.model?.provider && ctx?.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : undefined
      const model = def.model ?? parentModel
      // The parent's thinking level belongs to the parent's model; it does not
      // ride along onto a model the definition pinned itself. A definition may carry
      // its OWN thinking level, which rides along with its own model pin; with no
      // `thinking` key the pin still suppresses the parent's level.
      const thinking = def.thinking ?? (def.model ? undefined : ctx?.thinkingLevel)

      let dir: string | undefined
      let promptFile = ''
      let usage: any = null
      let piUsage: any = null
      let outcome = 'refused'
      let refused: string | null = null
      let findings: any = null

      try {
        dir = mkTempDir()
        promptFile = join(dir as string, 'agent-prompt.md')
        writeFile(promptFile, def.prompt, { mode: 0o600 })

        const childEnv = { ...env }
        childEnv[DEPTH_ENV] = '1'
        // Guard two, independent of --no-extensions: even if the child somehow
        // loaded this file, it would find no allowlist.
        delete childEnv[AGENTS_ENV]

        const args = [...binary.args, ...childArgs({ def, task: String(params?.task || ''), promptFile, model, thinking })]

        const outcomeOfRun = await new Promise<any>((resolve) => {
          // Only the reducer, the residual of the CURRENT line and a bounded
          // stderr tail are retained. The transcript itself is never held. It is
          // built BEFORE the spawn so that EVERY resolve below returns the same
          // shape: the classifier folds usage unconditionally, and a resolve that
          // omitted the reducer made that fold throw a TypeError which then
          // replaced the real cause in the refusal text.
          const reducer = createStreamReducer()
          let child: any
          try {
            child = spawn(binary.command, args, {
              cwd: ctx?.cwd,
              shell: false,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: childEnv,
            })
          } catch (err: any) {
            resolve({
              code: null, reducer, oversize: false, stderrText: '', aborted: false, timedOut: false,
              childError: `the child could not be spawned (${err.message})`,
            })
            return
          }

          // Node hands us BYTES, and a data event can end in the MIDDLE of a
          // multibyte UTF-8 sequence. A per-chunk String(chunk) decodes each half
          // on its own and substitutes U+FFFD for the torn character — silently,
          // because the corrupted line still parses as JSON. StringDecoder holds
          // the partial sequence back until the next chunk completes it, and
          // end() flushes whatever is left. Still zero-dep: node:string_decoder.
          const outDecoder = new StringDecoder('utf8')
          const errDecoder = new StringDecoder('utf8')
          const asBuffer = (chunk: any) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'))
          let residual = ''
          let streamBytes = 0
          let oversize = false
          let stderrText = ''

          const consume = (raw: string) => {
            if (oversize) return
            const trimmed = raw.trim()
            if (!trimmed) return
            let frame
            try { frame = JSON.parse(trimmed) } catch { return /* unknown frames are ignored */ }
            reducer.push(frame)
          }

          // Node streams do not preserve line boundaries: a per-chunk split('\n')
          // drops a torn line. Only the accumulator and the latest text are
          // retained, so the memory bound is one line, not the transcript.
          child.stdout.on('data', (chunk: any) => {
            const bytes = asBuffer(chunk)
            // The cap counts RAW BYTES, never decoded characters: it bounds what
            // the child wrote, and a half-decoded chunk measures the wrong thing.
            streamBytes += bytes.length
            if (streamBytes > STREAM_CAP_BYTES) oversize = true
            if (oversize) return
            residual += outDecoder.write(bytes)
            let index = residual.indexOf('\n')
            while (index >= 0) {
              consume(residual.slice(0, index))
              residual = residual.slice(index + 1)
              index = residual.indexOf('\n')
            }
          })
          child.stderr.on('data', (chunk: any) => {
            if (stderrText.length < 4096) stderrText += errDecoder.write(asBuffer(chunk)).slice(0, 4096)
          })

          let closed = false
          let killTimer: any = null
          let deadline: any = null

          const killChild = () => {
            try { child.kill('SIGTERM') } catch { /* already gone */ }
            if (closed) return
            // SIGKILL is scheduled only while the child is still running, and is
            // cancelled the moment it closes — a timer that outlives the child
            // would fire into a reused pid.
            killTimer = setTimer(() => {
              killTimer = null
              if (closed) return
              try { child.kill('SIGKILL') } catch { /* already gone */ }
            }, killGraceMs)
            killTimer?.unref?.()
          }

          const detach = () => {
            closed = true
            if (killTimer !== null) { clearTimer(killTimer); killTimer = null }
            if (deadline !== null) { clearTimer(deadline); deadline = null }
            if (signal) signal.removeEventListener?.('abort', killChild)
          }

          // The deadline. It reuses the kill escalation on purpose — SIGTERM,
          // then SIGKILL after killGraceMs, cancelled at close — so a child that
          // ignores the first signal cannot hold the seat open forever, which is
          // what node's own spawn `timeout` option would allow.
          let timedOut = false
          deadline = setTimer(() => {
            deadline = null
            timedOut = true
            killChild()
          }, CHILD_TIMEOUT_MS)
          deadline?.unref?.()

          if (signal) {
            // Adding a listener to an ALREADY-aborted signal never replays the
            // event, so that child would run to completion unsupervised. The
            // pre-aborted case takes the same path, immediately.
            if (signal.aborted) killChild()
            else signal.addEventListener?.('abort', killChild, { once: true })
          }

          // A ChildProcess `error` is NOT a terminal event: it can arrive after
          // output has already been received, and node emits it BEFORE `close`
          // on every spawn-failure class (ENOENT, EACCES, EISDIR — measured on
          // node 24.15.0 and 26.5.1, evidence/spawn-error-ordering.out). So the
          // error is STORED, never resolved on: resolving here would settle the
          // promise before the child closed, discard the reducer with usage
          // already measured in it, and run cleanup and the journal row ahead of
          // the child and its stdio. `close` is the single settle point.
          let childError: string | null = null
          child.on('error', (err: any) => {
            childError = childError ?? `the child failed (${err?.message || err})`
          })
          child.on('close', (code: number) => {
            detach()
            // Flush any byte held back mid-sequence before the last line is read.
            if (!oversize) residual += outDecoder.end()
            stderrText += errDecoder.end()
            if (residual.trim()) consume(residual)
            resolve({ code, reducer, oversize, stderrText, childError, timedOut, aborted: Boolean(signal?.aborted) })
          })
        })

        {
          // Fold BEFORE classifying: the spend happened either way, and a child
          // that errored after its first message_end still cost what it cost.
          usage = outcomeOfRun.reducer.usage()
          piUsage = outcomeOfRun.reducer.piUsage()
          if (outcomeOfRun.childError) {
            // First among the refusal classes: on a spawn failure `code` is a
            // negative errno, so the exit-code branch would report "exited -2"
            // instead of the actual reason.
            refused = `refused: ${outcomeOfRun.childError}`
          } else if (outcomeOfRun.oversize) {
            refused = `refused: the child's event stream exceeded the ${STREAM_CAP_BYTES}-byte stream cap`
          } else if (outcomeOfRun.aborted) {
            refused = 'refused: the call was aborted'
          } else if (outcomeOfRun.timedOut) {
            // Before the exit-code branch: a terminated child closes with a null
            // code, which that branch would report as "exited null".
            refused = `refused: the child did not finish inside the ${CHILD_TIMEOUT_MS}ms deadline and was terminated`
          } else if (outcomeOfRun.code !== 0) {
            refused = `refused: the child exited ${outcomeOfRun.code}${outcomeOfRun.stderrText ? ` (${outcomeOfRun.stderrText.slice(0, 400)})` : ''}`
          } else {
            const extracted = extractFindings(outcomeOfRun.reducer.text())
            if (extracted.error) {
              refused = `refused: ${extracted.error}`
            } else {
              const errors = [...new Set(validateFindings(extracted.value))]
              if (errors.length) {
                // Deduped closed codes only. Never the validator's view of the
                // payload, and never the payload: both are child-controlled and
                // unbounded, and joining them let a schema-invalid child exceed
                // the result cap and echo itself into the parent's context.
                refused = `refused: the child's findings violated the contract (${errors.length} of ${FINDINGS_ERROR_CODES.length} checks: ${errors.join(', ')})`
              } else {
                const rendered = renderFindings(extracted.value)
                if (Buffer.byteLength(rendered) > OUTPUT_CAP_BYTES) {
                  refused = `refused: the findings payload is ${Buffer.byteLength(rendered)} bytes, over the ${OUTPUT_CAP_BYTES}-byte result cap`
                } else if (rendered.split('\n').length > OUTPUT_CAP_LINES) {
                  refused = `refused: the findings payload is ${rendered.split('\n').length} lines, over the ${OUTPUT_CAP_LINES}-line result cap`
                } else {
                  findings = extracted.value
                  outcome = 'ok'
                }
              }
            }
          }
        }
      } catch (err: any) {
        refused = `refused: the spawn failed (${err?.message || err})`
      } finally {
        // Cleanup and instrumentation are never load-bearing, and the row is
        // written BEFORE the refusal is returned so failure signalling can never
        // erase the spend record.
        try { if (dir) removeDir(dir) } catch { /* nothing to do */ }
        try {
          if (taskDir) {
            appendFile(journalPathFrom(taskDir), `${JSON.stringify(usageRow({
              at: now(), role, agent: agentName, spawnId, model, usage, outcome: findings ? 'ok' : 'refused',
            }))}\n`)
          }
        } catch { /* nothing to do */ }
      }

      // The nested LLM call happened whether or not it produced findings, so
      // whenever it was measured pi is told what it cost (docs/extensions.md:1986;
      // pi-agent-core/dist/types.d.ts:316-322). Attaching usage only on success
      // makes every failed spawn free in pi's own footer, /session and RPC totals.
      return finish({ findings, refused, usage, piUsage })
    },
  }
}

// pi calls the default export with its api object: jiti.import at
// dist/core/extensions/loader.js:368, then `await factory(api)` at :409 after
// refusing anything that is not a function (:404-406, :370-372). Exactly
// one tool and exactly one handler: pi splits the mechanisms — a returned value
// never sets the error flag, the tool_result patch does.
export default function subagentExtension(pi: any) {
  pi.registerTool(createAgentTool())
  pi.on('tool_result', (event: any) => toolResultPatch(event))
}
