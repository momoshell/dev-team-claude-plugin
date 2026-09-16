// " Gate-mask boundary sentinel: this exists only to close the string the lane
// acceptance-gate masker opens at the escaped quote in the regex literal at
// crew/crew-cli.test.mjs:4109. Without it, gate B1 source concatenation stays
// inside that string and blanks the following lines. It is inert to Node and
// safe to delete when nothing masks this file.
import { after } from 'node:test'
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { NODE_FLOOR } from '../scripts/factory/ledger.mjs'

// Ledger sandbox (#432): every ledger writer this split drives resolves its db
// through DEVTEAM_LEDGER_DIR, so the shared helper installs one process-local
// redirect before its importing test module registers tests.
const LEDGER_SANDBOX = mkdtempSync(join(tmpdir(), 'b117-ledger-sandbox-'))
const LEDGER_SANDBOX_PREVIOUS = process.env.DEVTEAM_LEDGER_DIR
process.env.DEVTEAM_LEDGER_DIR = LEDGER_SANDBOX
after(() => {
  if (LEDGER_SANDBOX_PREVIOUS === undefined) delete process.env.DEVTEAM_LEDGER_DIR
  else process.env.DEVTEAM_LEDGER_DIR = LEDGER_SANDBOX_PREVIOUS
  rmSync(LEDGER_SANDBOX, { recursive: true, force: true })
})

const rosterFixture = () => ({
  schema_version: 1,
  updated_at: '2026-08-30',
  tiers: {
    mechanical: {
      lead: null,
      planner: { provider: 'anthropic', id: 'claude-opus-5', agent: 'claude', effort: 'medium' },
      builder: { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' },
      reviewer: { provider: 'openai', id: 'gpt-5.6-sol', agent: 'pi', effort: 'medium' },
    },
    build: {
      lead: { provider: 'anthropic', id: 'claude-opus-5', agent: 'claude', effort: 'medium' },
      planner: { provider: 'anthropic', id: 'claude-opus-5', agent: 'claude', effort: 'medium' },
      builder: { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' },
      reviewer: { provider: 'openai', id: 'gpt-5.6-sol', agent: 'pi', effort: 'high' },
    },
    judge: {
      lead: { provider: 'anthropic', id: 'claude-opus-5', agent: 'claude', effort: 'high' },
      planner: { provider: 'anthropic', id: 'claude-opus-5', agent: 'claude', effort: 'high' },
      builder: { provider: 'openai', id: 'gpt-5.6-luna', agent: 'pi', effort: 'max' },
      reviewer: { provider: 'anthropic', id: 'claude-opus-5', agent: 'claude', effort: 'xhigh' },
      'tech-lead': {
        provider: 'openai', id: 'gpt-5.6-sol', agent: 'pi', effort: 'xhigh',
        fallback: [{ provider: 'anthropic', id: 'claude-opus-5', agent: 'pi', effort: 'xhigh' }],
      },
    },
  },
  models: {
    'anthropic/claude-opus-5': { cost_in_per_mtok: 5, cost_out_per_mtok: 25, context: 1000000, tags: ['reasoning', 'tool-call', 'judge'], source: 'models.dev', last_verified: '2026-08-13' },
    'anthropic/claude-sonnet-5': { cost_in_per_mtok: 2, cost_out_per_mtok: 10, context: 1000000, tags: ['reasoning', 'tool-call', 'workhorse'], source: 'models.dev', last_verified: '2026-08-13' },
    'anthropic/claude-haiku-4-5': { cost_in_per_mtok: 1, cost_out_per_mtok: 5, context: 200000, tags: ['reasoning', 'tool-call', 'cheap'], source: 'models.dev', last_verified: '2026-08-13' },
    'openai/gpt-5.6-sol': { cost_in_per_mtok: 4, cost_out_per_mtok: 20, context: 1050000, tags: ['reasoning', 'tool-call', 'vendor-diverse'], source: 'models.dev', last_verified: '2026-08-30' },
    'openai/gpt-5.6-terra': { cost_in_per_mtok: 2, cost_out_per_mtok: 12, context: 1050000, tags: ['reasoning', 'tool-call', 'first-pass-review'], source: 'models.dev', last_verified: '2026-08-13' },
    'openai/gpt-5.6-luna': { cost_in_per_mtok: 0.2, cost_out_per_mtok: 1.2, context: 1050000, tags: ['reasoning', 'tool-call', 'cheap', 'coding'], source: 'models.dev', last_verified: '2026-08-13' },
    'anthropic/claude-fable-5': { cost_in_per_mtok: 10, cost_out_per_mtok: 50, context: 1000000, tags: ['reasoning', 'tool-call', 'frontier', 'override-only'], source: 'models.dev', last_verified: '2026-08-13' },
  },
})

export const shippedRoster = () => JSON.parse(readFileSync(new URL('./roster.json', import.meta.url), 'utf8'))

export const roster = rosterFixture()

const floorMajor = Number.parseInt(NODE_FLOOR, 10)

export const nodeMeetsLedgerFloor = Number.parseInt(process.versions.node, 10) >= floorMajor


export async function withHome(home, fn) {
  const previous = process.env.HOME
  process.env.HOME = home
  try { return await fn() }
  finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous }
}


export function testCrewDir(home, checkout, task) { return join(home, '.crew', basename(checkout), task) }


export function callCounter() {
  const calls = []
  const fn = (...args) => { calls.push(args); return { ok: true, stdout: '' } }
  fn.calls = calls
  return fn
}


export function capabilityRegister(overrides = {}) {
  const grant = (extra = {}) => ({ tools: [], extensions: [], agents: [], skills: [], advisor: false, requires: [], mcp_servers: [], ...extra })
  const base = {
    schema_version: 1,
    updated_at: '2026-08-17',
    roles: {
      lead: grant(), planner: grant({ requires: ['subagents'] }), builder: grant(),
      reviewer: grant(), 'tech-lead': grant(),
    },
    local_providers: {},
    coding_agents: {
      pi: { providers: ['openai', 'anthropic', 'llama-swap'], transports: ['pane', 'headless-rpc'], adapter: 'crew/adapters/adapter-pi.mjs', refuses: ['mcp_servers'], display_name: 'Pi', binary: 'pi', install_hint: 'Install Pi and ensure the pi binary is on PATH.', availability: 'executable', availability_reason: 'executable' },
      claude: { providers: ['anthropic'], transports: ['pane', 'headless-json'], adapter: 'crew/adapters/adapter-claude.mjs', refuses: ['extensions', 'skills', 'local_provider'], display_name: 'Claude Code', binary: 'claude', install_hint: 'Install Claude Code and ensure the claude binary is on PATH.', availability: 'executable', availability_reason: 'executable' },
    },
  }
  const local_providers = { ...base.local_providers, ...(overrides.local_providers || {}) }
  const coding_agents = { ...base.coding_agents, ...(overrides.coding_agents || {}) }
  if (!overrides.coding_agents?.pi && Object.keys(local_providers).length) {
    coding_agents.pi = { ...coding_agents.pi, providers: [...new Set([...coding_agents.pi.providers, ...Object.keys(local_providers)])] }
  }
  return { ...base, ...overrides, local_providers, coding_agents, roles: { ...base.roles, ...(overrides.roles || {}) } }
}


export function capabilityFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'crew-capability-'))
  mkdirSync(join(root, 'crew', 'pi', 'skills'), { recursive: true })
  mkdirSync(join(root, 'crew', 'pi', 'extensions'), { recursive: true })
  writeFileSync(join(root, 'crew', 'pi', 'extensions', 'builderloop.ts'), '// extension\n')
  // RV1-1: an agents grant is only composable when the extension that REGISTERS
  // the agent tool is granted too, so the fixture root must carry it.
  writeFileSync(join(root, 'crew', 'pi', 'extensions', 'subagent.ts'), '// extension\n')
  writeFileSync(join(root, 'crew', 'pi', 'skills', 'scout.md'), '# skill\n')
  writeFileSync(join(root, 'crew', 'pi', 'explore.json'), JSON.stringify({ name: 'Explore', prompt: 'scout' }))
  return root
}
