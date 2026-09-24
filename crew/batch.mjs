// Standalone Claude batch executor: warm one JSON session, then run each
// independent item as a bounded fork of that session. This module owns its
// own argv shape (--output-format json with --resume/--fork-session) and its
// own ledger (<out>/batch.jsonl plus one <id>.txt per success); it never
// touches pi, the roster, lane loops, or ingestion.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawn as childSpawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { modelString } from './adapters/adapter-claude.mjs'
import { modelString as piModelString } from './adapters/adapter-pi.mjs'
import { foldRpcUsage } from './headless-rpc.mjs'

// Bounded capture so one chatty call cannot grow memory without a ceiling.
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const ID_PATTERN = /^[A-Za-z0-9_-]+$/
const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
const MISSING_USAGE_REASON = 'cli-not-reported'

function fail(why) {
  throw new Error(`crew/batch: ${why}`)
}

function checkOut(out) {
  if (typeof out !== 'string' || out.length === 0) fail('out must be a nonempty path')
}

function checkModel(model) {
  if (typeof model !== 'string' || model.length === 0) fail('model must be a nonempty model id')
}

function checkEffort(effort) {
  if (effort !== undefined && (typeof effort !== 'string' || effort.length === 0)) fail('effort must be a nonempty string when given')
}

function checkConcurrency(concurrency) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) fail(`concurrency must be an integer 1..16, got ${JSON.stringify(concurrency)}`)
}

// Neutral per-batch cwd: outside the caller cwd and every git work tree.
// existsSync never throws, so a denied ancestor read reports absent; the
// tmp-root rejection below is the backstop for that blind spot.
function insideCallerCwdOrWorkTree(dir) {
  const resolved = resolvePath(dir)
  const cwd = resolvePath(process.cwd())
  if (resolved === cwd || resolved.startsWith(cwd + sep)) return true
  let current = resolved
  while (true) {
    if (existsSync(join(current, '.git'))) return true
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

function makeBatchCwd() {
  let root
  try {
    root = realpathSync(tmpdir())
  } catch (error) {
    fail(`cannot resolve a neutral batch cwd: ${error?.code ?? error?.message ?? String(error)}`)
  }
  if (insideCallerCwdOrWorkTree(root)) {
    fail(`cannot create a neutral batch cwd: temp root ${JSON.stringify(root)} is inside the caller cwd or a git work tree`)
  }
  let fresh
  try {
    fresh = mkdtempSync(join(root, 'crew-batch-'))
  } catch (error) {
    fail(`cannot create a neutral batch cwd under ${JSON.stringify(root)}: ${error?.code ?? error?.message ?? String(error)}`)
  }
  let batchCwd
  try {
    batchCwd = realpathSync(fresh)
  } catch (error) {
    fail(`cannot resolve the neutral batch cwd: ${error?.code ?? error?.message ?? String(error)}`)
  }
  // lean: backstop, unwitnessed (reachable only via a symlink swap between mkdtemp and realpath); witness with an injected realpath if this path ever matters.
  if (insideCallerCwdOrWorkTree(batchCwd)) {
    fail(`cannot create a neutral batch cwd: ${JSON.stringify(batchCwd)} is inside the caller cwd or a git work tree`)
  }
  return batchCwd
}

function readItems(itemsPath) {
  let raw
  try {
    raw = readFileSync(itemsPath, 'utf8')
  } catch (error) {
    fail(`cannot read items file ${JSON.stringify(itemsPath)}: ${error?.code ?? error?.message ?? String(error)}`)
  }
  const lines = String(raw).split('\n').filter((line) => line.trim().length > 0)
  if (lines.length === 0) fail(`items file ${JSON.stringify(itemsPath)} holds no items`)
  const seen = new Set()
  return lines.map((line, index) => {
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      fail(`items line ${index + 1} is not JSON`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`items line ${index + 1} must be an object`)
    if (typeof parsed.id !== 'string' || !ID_PATTERN.test(parsed.id)) {
      fail(`items line ${index + 1} carries an unsafe id ${JSON.stringify(parsed.id)}`)
    }
    if (seen.has(parsed.id)) fail(`duplicate item id ${JSON.stringify(parsed.id)}`)
    seen.add(parsed.id)
    if (typeof parsed.prompt !== 'string' || parsed.prompt.length === 0) fail(`item ${JSON.stringify(parsed.id)} carries an empty prompt`)
    return { id: parsed.id, prompt: parsed.prompt }
  })
}

// Keep only honest counts: a field that is not a finite nonnegative number is
// absent (undefined), never coerced, so the row records null with a reason.
function cleanUsage(value) {
  const source = value && typeof value === 'object' ? value : {}
  const usage = {}
  for (const field of TOKEN_FIELDS) {
    const candidate = source[field]
    if (Number.isFinite(candidate) && candidate >= 0) usage[field] = candidate
  }
  return usage
}

function absentReasons(usage, cost) {
  const reasons = {}
  for (const field of TOKEN_FIELDS) {
    if (usage[field] === undefined) reasons[field] = MISSING_USAGE_REASON
  }
  if (cost === null) reasons.total_cost_usd = MISSING_USAGE_REASON
  return Object.keys(reasons).length > 0 ? reasons : null
}

function finishRow({ batchId, role, itemId, parentSessionId, sessionId, strategy, usage, totalCost, status, why, startedAt, endedAt }) {
  const cost = Number.isFinite(totalCost) && totalCost >= 0 ? totalCost : null
  return {
    batch_id: batchId,
    role,
    item_id: itemId,
    parent_session_id: parentSessionId,
    session_id: sessionId,
    strategy,
    input_tokens: usage.input_tokens ?? null,
    output_tokens: usage.output_tokens ?? null,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? null,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? null,
    total_cost_usd: cost,
    status,
    why,
    started_at: startedAt,
    ended_at: endedAt,
    usage_absent_reasons: absentReasons(usage, cost),
  }
}

async function collectText(stream) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return { text: '', truncated: false }
  if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8')
  let text = ''
  try {
    for await (const chunk of stream) {
      text += chunk
      if (text.length > MAX_OUTPUT_BYTES) return { text, truncated: true }
    }
  } catch {
    return { text, truncated: false }
  }
  return { text, truncated: false }
}

function waitClose(child) {
  return new Promise((resolve) => {
    child.on('error', (error) => resolve({ error }))
    child.on('close', (code) => resolve({ code }))
  })
}

// One bounded call: resolves a cold record, never throws for child behaviour.
async function invoke(bin, args, spawn, cwd, opts = {}) {
  let child
  try {
    child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd, ...(opts.env !== undefined ? { env: opts.env } : {}) })
  } catch (error) {
    return { ok: false, stdout: '', why: `spawn-error: ${error?.message ?? String(error)}` }
  }
  if (!child || typeof child.on !== 'function') return { ok: false, stdout: '', why: 'spawn-error: spawn returned no child' }
  const [out, err, closed] = await Promise.all([collectText(child.stdout), collectText(child.stderr), waitClose(child)])
  if (closed.error) return { ok: false, stdout: '', why: `spawn-error: ${closed.error?.message ?? String(closed.error)}` }
  if (out.truncated || err.truncated) {
    try {
      if (typeof child.kill === 'function') child.kill()
    } catch {}
    return { ok: false, stdout: '', why: 'output-too-large: call exceeded the capture bound' }
  }
  if (closed.code !== 0) {
    const tail = String(err.text).trim().slice(-200)
    return { ok: false, stdout: out.text, why: `exit-code-${closed.code}${tail ? `: ${tail}` : ''}` }
  }
  return { ok: true, stdout: out.text, why: null }
}

function parseCall(text) {
  if (text.trim().length === 0) return { ok: false, why: 'empty-stdout: the CLI printed nothing' }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, why: `invalid-json: ${error?.message ?? String(error)}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, why: 'invalid-json: top level is not an object' }
  return { ok: true, parsed }
}

// Pi JSON-mode output is one frame per line. Only assistant message_end
// frames carry billable spend; session, turn_end, replay, and tool frames
// are inert for usage, and absent spend stays absent, never zero.
function parsePiFrames(text) {
  if (text.trim().length === 0) return { ok: false, why: 'empty-stdout: the CLI printed nothing' }
  const lines = String(text).split('\n').filter((line) => line.trim().length > 0)
  if (lines.length === 0) return { ok: false, why: 'empty-stdout: the CLI printed nothing' }
  const frames = []
  for (const line of lines) {
    try {
      frames.push(JSON.parse(line))
    } catch (error) {
      return { ok: false, why: `invalid-json: ${error?.message ?? String(error)}` }
    }
  }
  const folded = foldRpcUsage(frames)
  let sessionId = null
  for (const frame of frames) {
    if (!frame || typeof frame !== 'object') continue
    const nested = frame.session && typeof frame.session === 'object' ? frame.session.id : undefined
    if (typeof nested === 'string' && nested.length > 0) {
      sessionId = nested
      break
    }
    if (frame.type === 'session' && typeof frame.id === 'string' && frame.id.length > 0) {
      sessionId = frame.id
      break
    }
    if (typeof frame.session_id === 'string' && frame.session_id.length > 0) {
      sessionId = frame.session_id
      break
    }
  }
  const parts = []
  for (const frame of frames) {
    if (!frame || frame.type !== 'message_end') continue
    const message = frame.message
    if (!message || message.role !== 'assistant') continue
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
      }
    } else if (typeof message.content === 'string') {
      parts.push(message.content)
    }
  }
  let cost = null
  let costSum = 0
  let sawCost = false
  for (const frame of frames) {
    if (!frame || frame.type !== 'message_end') continue
    const message = frame.message
    if (!message || message.role !== 'assistant') continue
    const total = message.usage?.cost?.total
    if (Number.isFinite(total) && total >= 0) {
      costSum += total
      sawCost = true
    }
  }
  if (sawCost) cost = costSum
  const usage = {
    input_tokens: folded?.billed_input_tokens,
    output_tokens: folded?.billed_output_tokens,
    cache_read_input_tokens: folded?.billed_cache_read_tokens,
    cache_creation_input_tokens: folded?.billed_cache_write_tokens,
  }
  return { ok: true, frames, sessionId, result: parts.length > 0 ? parts.join('') : null, usage, totalCost: cost }
}

export async function runBatch({ context, items, model, effort, concurrency = 4, out, spawn = childSpawn, agent = 'claude' }) {
  if (!['claude', 'pi'].includes(agent)) fail(`unsupported agent ${JSON.stringify(agent)}`)
  checkConcurrency(concurrency)
  checkModel(model)
  checkEffort(effort)
  checkOut(out)
  if (typeof context !== 'string' || context.length === 0) fail('context must be a nonempty path')
  if (typeof items !== 'string' || items.length === 0) fail('items must be a nonempty path')
  let modelId = null
  let piModel = null
  if (agent === 'pi') {
    const full = piModelString({ provider: 'openai', id: model })
    const marker = 'openai-codex/'
    if (typeof full !== 'string' || !full.startsWith(marker)) fail(`unsupported pi model ${JSON.stringify(model)}`)
    piModel = full.slice(marker.length)
    if (piModel.length === 0) fail(`unsupported pi model ${JSON.stringify(model)}`)
  } else {
    modelId = modelString({ provider: 'anthropic', id: model })
  }
  let contextText
  try {
    contextText = readFileSync(context, 'utf8')
  } catch (error) {
    fail(`cannot read context file ${JSON.stringify(context)}: ${error?.code ?? error?.message ?? String(error)}`)
  }
  const entries = readItems(items)
  try {
    mkdirSync(out, { recursive: true })
  } catch (error) {
    fail(`cannot create out dir ${JSON.stringify(out)}: ${error?.code ?? error?.message ?? String(error)}`)
  }
  const batchId = randomUUID()
  const bin = agent === 'pi' ? 'pi' : (process.env.CREW_CLAUDE_BIN ?? 'claude')
  const batchCwd = makeBatchCwd()
  const sessionDir = join(batchCwd, 'sessions')
  const spawnOpts = { env: agent === 'pi' ? { ...process.env, PI_CACHE_RETENTION: 'long' } : undefined }
  const basePrompt = `${contextText}\n\nReply only ready.`
  let baseArgs
  if (agent === 'pi') {
    try {
      mkdirSync(sessionDir, { recursive: true })
    } catch (error) {
      fail(`cannot create pi session dir ${JSON.stringify(sessionDir)}: ${error?.code ?? error?.message ?? String(error)}`)
    }
    baseArgs = ['-p', basePrompt, '--mode', 'json', '--provider', 'openai-codex', '--model', piModel, ...(effort ? ['--thinking', effort] : []), '--no-tools', '--no-context-files', '--no-extensions', '--no-skills', '--no-prompt-templates', '--session-dir', sessionDir]
  } else {
    baseArgs = ['-p', basePrompt, '--output-format', 'json', '--model', modelId, ...(effort ? ['--effort', effort] : []), '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--tools', '', '--max-turns', '1']
  }
  const baseStarted = new Date().toISOString()
  const baseCall = agent === 'pi' ? await invoke(bin, baseArgs, spawn, batchCwd, spawnOpts) : await invoke(bin, baseArgs, spawn, batchCwd)
  const baseEnded = new Date().toISOString()
  const writeBaseFailure = (why, usage, totalCost) => {
    const failedBase = finishRow({
      batchId,
      role: 'base',
      itemId: null,
      parentSessionId: null,
      sessionId: null,
      strategy: agent === 'pi' ? 'pi-session-copy' : 'claude-fork',
      usage: cleanUsage(usage),
      totalCost,
      status: 'failed',
      why,
      startedAt: baseStarted,
      endedAt: baseEnded,
    })
    try {
      writeFileSync(join(out, 'batch.jsonl'), `${JSON.stringify(failedBase)}\n`, 'utf8')
    } catch (error) {
      fail(`cannot write batch ledger: ${error?.code ?? error?.message ?? String(error)}`)
    }
    return { batch_id: batchId, ok: false, rows: [failedBase], baseSessionId: null, out }
  }
  let baseSessionId = null
  let baseUsage = undefined
  let baseCost = undefined
  let baseSessionFile = null
  if (agent === 'pi') {
    if (!baseCall.ok) return writeBaseFailure(baseCall.why, undefined, undefined)
    const parsed = parsePiFrames(baseCall.stdout)
    if (!parsed.ok) return writeBaseFailure(parsed.why, undefined, undefined)
    baseUsage = parsed.usage
    baseCost = parsed.totalCost
    if (parsed.sessionId === null) return writeBaseFailure('missing-session-id: the warm pi call returned no session id', parsed.usage, parsed.totalCost)
    let names
    try {
      names = readdirSync(sessionDir).filter((name) => name.endsWith('.jsonl'))
    } catch (error) {
      return writeBaseFailure(`missing-session-file: cannot read the pi session dir: ${error?.code ?? error?.message ?? String(error)}`, parsed.usage, parsed.totalCost)
    }
    if (names.length !== 1) return writeBaseFailure(`missing-session-file: expected exactly one warm .jsonl in the pi session dir, found ${names.length}`, parsed.usage, parsed.totalCost)
    baseSessionFile = join(sessionDir, names[0])
    baseSessionId = parsed.sessionId
  } else {
    const baseBody = baseCall.ok ? parseCall(baseCall.stdout) : { ok: false, why: baseCall.why }
    if (!baseBody.ok) return writeBaseFailure(baseBody.why, undefined, undefined)
    if (typeof baseBody.parsed.session_id !== 'string' || baseBody.parsed.session_id.length === 0) {
      return writeBaseFailure('missing-session-id: the warm call returned no session_id', baseBody.parsed.usage, baseBody.parsed.total_cost_usd)
    }
    baseUsage = baseBody.parsed.usage
    baseCost = baseBody.parsed.total_cost_usd
    baseSessionId = baseBody.parsed.session_id
  }
  const baseRow = finishRow({
    batchId,
    role: 'base',
    itemId: null,
    parentSessionId: null,
    sessionId: baseSessionId,
    strategy: agent === 'pi' ? 'pi-session-copy' : 'claude-fork',
    usage: cleanUsage(baseUsage),
    totalCost: baseCost,
    status: 'ok',
    why: null,
    startedAt: baseStarted,
    endedAt: baseEnded,
  })

  async function runItem(item) {
    const startedAt = new Date().toISOString()
    if (agent === 'pi') {
      const sessionFile = join(sessionDir, `${item.id}.jsonl`)
      try {
        copyFileSync(baseSessionFile, sessionFile)
      } catch (error) {
        const copyEndedAt = new Date().toISOString()
        return { status: 'failed', row: finishRow({ batchId, role: 'item', itemId: item.id, parentSessionId: baseSessionId, sessionId: null, strategy: agent === 'pi' ? 'pi-session-copy' : 'claude-fork', usage: cleanUsage(undefined), totalCost: undefined, status: 'failed', why: `session-copy-failed: ${error?.code ?? error?.message ?? String(error)}`, startedAt, endedAt: copyEndedAt }) }
      }
      const piArgs = ['-p', item.prompt, ...baseArgs.slice(2), '--session', sessionFile]
      const piCall = await invoke(bin, piArgs, spawn, batchCwd, spawnOpts)
      const piEndedAt = new Date().toISOString()
      const piSettled = (fields) => finishRow({
        batchId,
        role: 'item',
        itemId: item.id,
        parentSessionId: baseSessionId,
        sessionId: null,
        strategy: agent === 'pi' ? 'pi-session-copy' : 'claude-fork',
        startedAt,
        endedAt: piEndedAt,
        ...fields,
      })
      if (!piCall.ok) {
        return { status: 'failed', row: piSettled({ sessionId: null, usage: cleanUsage(undefined), totalCost: undefined, status: 'failed', why: piCall.why }) }
      }
      const piBody = parsePiFrames(piCall.stdout)
      if (!piBody.ok) {
        return { status: 'failed', row: piSettled({ sessionId: null, usage: cleanUsage(undefined), totalCost: undefined, status: 'failed', why: piBody.why }) }
      }
      if (piBody.sessionId === null) {
        return { status: 'failed', row: piSettled({ sessionId: null, usage: cleanUsage(piBody.usage), totalCost: piBody.totalCost, status: 'failed', why: 'missing-session-id: the pi call returned no session id' }) }
      }
      if (typeof piBody.result !== 'string') {
        return { status: 'failed', row: piSettled({ sessionId: piBody.sessionId, usage: cleanUsage(piBody.usage), totalCost: piBody.totalCost, status: 'failed', why: 'missing-result: the pi call returned no string result' }) }
      }
      return {
        status: 'ok',
        text: piBody.result,
        row: piSettled({ sessionId: piBody.sessionId, usage: cleanUsage(piBody.usage), totalCost: piBody.totalCost, status: 'ok', why: null }),
      }
    }
    const itemArgs = ['-p', item.prompt, '--output-format', 'json', '--model', modelId, ...(effort ? ['--effort', effort] : []), '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--tools', '', '--max-turns', '1', '--resume', baseSessionId, '--fork-session']
    const call = await invoke(bin, itemArgs, spawn, batchCwd)
    const endedAt = new Date().toISOString()
    const settled = (fields) => finishRow({
      batchId,
      role: 'item',
      itemId: item.id,
      parentSessionId: baseSessionId,
      strategy: agent === 'pi' ? 'pi-session-copy' : 'claude-fork',
      startedAt,
      endedAt,
      ...fields,
    })
    if (!call.ok) {
      return { status: 'failed', row: settled({ sessionId: null, usage: cleanUsage(undefined), totalCost: undefined, status: 'failed', why: call.why }) }
    }
    const body = parseCall(call.stdout)
    if (!body.ok) {
      return { status: 'failed', row: settled({ sessionId: null, usage: cleanUsage(undefined), totalCost: undefined, status: 'failed', why: body.why }) }
    }
    if (typeof body.parsed.session_id !== 'string' || body.parsed.session_id.length === 0) {
      return { status: 'failed', row: settled({ sessionId: null, usage: cleanUsage(body.parsed.usage), totalCost: body.parsed.total_cost_usd, status: 'failed', why: 'missing-session-id: the fork returned no session_id' }) }
    }
    if (typeof body.parsed.result !== 'string') {
      return { status: 'failed', row: settled({ sessionId: body.parsed.session_id, usage: cleanUsage(body.parsed.usage), totalCost: body.parsed.total_cost_usd, status: 'failed', why: 'missing-result: the fork returned no string result' }) }
    }
    return {
      status: 'ok',
      text: body.parsed.result,
      row: settled({ sessionId: body.parsed.session_id, usage: cleanUsage(body.parsed.usage), totalCost: body.parsed.total_cost_usd, status: 'ok', why: null }),
    }
  }

  const slots = new Array(entries.length)
  let next = 0
  let started = 0
  async function worker() {
    if (started++ >= Math.min(concurrency, entries.length)) return
    while (true) {
      const index = next++
      if (index >= entries.length) return
      const outcome = await runItem(entries[index])
      slots[index] = outcome.row
      if (outcome.status === 'failed') continue
      try {
        writeFileSync(join(out, `${entries[index].id}.txt`), outcome.text, 'utf8')
      } catch (error) {
        outcome.row.status = 'failed'
        outcome.row.why = `result-write-failed: ${error?.code ?? error?.message ?? String(error)}`
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  const rows = [baseRow, ...slots]
  try {
    writeFileSync(join(out, 'batch.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
  } catch (error) {
    fail(`cannot write batch ledger: ${error?.code ?? error?.message ?? String(error)}`)
  }
  return { batch_id: batchId, ok: true, rows, baseSessionId, out }
}

function parseCliArgs(argv) {
  const known = new Set(['--context', '--items', '--model', '--out', '--effort', '--concurrency', '--agent'])
  const values = {}
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (!known.has(flag)) fail(`unknown option ${JSON.stringify(flag)}`)
    if (values[flag] !== undefined) fail(`duplicate option ${JSON.stringify(flag)}`)
    const value = argv[index + 1]
    if (value === undefined || value.length === 0) fail(`option ${flag} needs a value`)
    values[flag] = value
    index++
  }
  for (const required of ['--context', '--items', '--model', '--out']) {
    if (values[required] === undefined) fail(`missing required option ${required}`)
  }
  let concurrency = 4
  if (values['--concurrency'] !== undefined) {
    concurrency = Number(values['--concurrency'])
    checkConcurrency(concurrency)
  }
  return {
    context: values['--context'],
    items: values['--items'],
    model: values['--model'],
    out: values['--out'],
    effort: values['--effort'],
    concurrency,
    agent: values['--agent'] ?? 'claude',
  }
}

async function main(argv) {
  let options
  try {
    options = parseCliArgs(argv)
  } catch (error) {
    process.stderr.write(`${error?.message ?? String(error)}\n`)
    process.exitCode = 2
    return
  }
  try {
    const outcome = await runBatch(options)
    if (!outcome.ok) {
      process.stderr.write('crew/batch: the warm call failed; no item ran\n')
      process.exitCode = 1
    }
  } catch (error) {
    process.stderr.write(`${error?.message ?? String(error)}\n`)
    process.exitCode = 1
  }
}

const invoked = typeof process.argv[1] === 'string' && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  main(process.argv.slice(2))
}
