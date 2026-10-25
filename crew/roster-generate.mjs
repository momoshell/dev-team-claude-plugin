// crew roster generate [--check]
//
// The seat files are the roster source (ADR-052 D11). This writes crew/roster.json from
// crew/agents/*.md, so the old path boots what the new path boots. The committed
// roster.json supplies what the definitions do not carry: the schema version,
// updated_at, models, policy and which roles each tier lists. --check writes nothing and
// exits 1 when the committed file differs from what the definitions generate.
//
// Until plan 4.4 the visualizer's roster editor writes roster.json directly; the next
// generate overwrites that edit.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TIERS } from './protocols.mjs'
import { resolveAgents } from './agents.mjs'
import { normalizeRoster, serializeRosterV1, serializeRosterV2 } from './roster.mjs'

export const ROSTER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'roster.json')

const cellOrder = ({ provider, id, agent, effort, fallback }) => ({ provider, id, agent, effort, ...(fallback ? { fallback: fallback.map(cellOrder) } : {}) })

// Each tier keeps the roles the template lists, in its order, with the advisor first: a
// role the definitions unseat at that tier stays as null, so the file reads as before.
export function generateRoster(templateText, resolve = resolveAgents) {
  const template = normalizeRoster(JSON.parse(templateText))
  const tiers = Object.fromEntries(TIERS.map((tier) => {
    const { seats, advisor } = resolve(tier)
    const listed = Object.keys(template.tiers[tier]).filter((role) => role !== 'advisor')
    const roles = [...listed, ...Object.keys(seats).filter((role) => !listed.includes(role))]
    const cells = Object.fromEntries(roles.map((role) => [role, seats[role] ? cellOrder(seats[role]) : null]))
    return [tier, { advisor: advisor ? cellOrder(advisor) : null, ...cells }]
  }))
  const serialize = template.schema_version === 2 ? serializeRosterV2 : serializeRosterV1
  return serialize({ updated_at: template.updated_at, models: template.models, policy: template.policy, tiers })
}

export function main(argv = process.argv.slice(2), { path = ROSTER_PATH, resolve = resolveAgents, log = (line) => process.stdout.write(line + '\n') } = {}) {
  const check = argv.includes('--check')
  if (argv[0] !== 'generate' || argv.some((arg, index) => index > 0 && arg !== '--check')) {
    process.stderr.write('usage: crew roster generate [--check]\n')
    return 2
  }
  const current = readFileSync(path, 'utf8')
  const generated = generateRoster(current, resolve)
  if (generated === current) { log(`crew roster: ${path} matches the agent definitions`); return 0 }
  if (check) { log(`crew roster: ${path} differs from the agent definitions; run crew roster generate`); return 1 }
  writeFileSync(path, generated)
  log(`crew roster: wrote ${path} from the agent definitions`)
  return 0
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
