import { readFileSync as fsReadFileSync, readdirSync as fsReaddirSync, statSync as fsStatSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { AGENT_ROLES } from '../../crew/protocols.mjs'

export const DELIVERY_STORES = Object.freeze(['headless', 'headless-json', 'headless-rpc', 'pane'])

const DEFAULT_REASONS = Object.freeze({
  register: 'capability register is unavailable',
  skills: 'skill inventory is unavailable',
  command: 'last-seat delivery has no readable command evidence',
})

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textValue(value) {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return null
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function reasonText(prefix, error) {
  const detail = error?.message || error?.code || (error ? String(error) : '')
  return detail ? `${prefix}: ${detail}` : prefix
}

function marked(value, reason) {
  if (value === undefined || value === null || value === '') return { value: 'unmeasured', measured: false, reason: reason || 'measurement is unavailable' }
  return { value, measured: true, reason: null }
}

function safeRead(read, path, label) {
  try {
    const value = textValue(read(path, 'utf8'))
    if (value === null) return { text: null, reason: reasonText(`${label} returned an unknown value`) }
    if (value === '') return { text: null, reason: reasonText(`${label} is empty`) }
    return { text: value, reason: null }
  } catch (error) {
    return { text: null, reason: reasonText(`${label} could not be read`, error) }
  }
}

function safeEntries(readdir, path) {
  try {
    const entries = readdir(path, { withFileTypes: true })
    if (!Array.isArray(entries)) return []
    return entries.map((entry) => {
      if (typeof entry === 'string') return { name: entry, directory: null }
      return { name: entry?.name, directory: typeof entry?.isDirectory === 'function' ? entry.isDirectory() : null }
    }).filter((entry) => typeof entry.name === 'string' && entry.name !== '')
  } catch {
    return []
  }
}

function refusal(code, message) {
  return { code, message }
}

function validName(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value)
}

function parseJson(read, path, label) {
  const source = safeRead(read, path, label)
  if (!source.text) return { value: null, text: null, refusals: [refusal('read-unavailable', source.reason || `${label} is unavailable`)] }
  try {
    const value = JSON.parse(source.text)
    if (!record(value)) return { value: null, text: source.text, refusals: [refusal('json-shape', `${label} must contain a JSON object`)] }
    return { value, text: source.text, refusals: [] }
  } catch (error) {
    return { value: null, text: source.text, refusals: [refusal('json-malformed', `${label} is malformed JSON: ${error?.message || String(error)}`)] }
  }
}

function readRegister(read, checkout) {
  const path = join(checkout, 'crew', 'capabilities.json')
  const parsed = parseJson(read, path, path)
  return { ...parsed, path }
}

function readFrontmatter(text) {
  if (typeof text !== 'string' || !text.startsWith('---\n')) return { value: null, reason: 'skill frontmatter is missing' }
  const end = text.indexOf('\n---', 4)
  if (end < 0) return { value: null, reason: 'skill frontmatter is unterminated' }
  const block = text.slice(4, end).split(/\r?\n/)
  const fields = {}
  let current = null
  for (const line of block) {
    const match = line.match(/^(name|description):\s*(.*)$/)
    if (match) {
      current = match[1]
      let value = match[2].trim()
      if (value === '>-' || value === '>' || value === '|-' || value === '|') value = ''
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
      fields[current] = value
      continue
    }
    if (current === 'description' && /^\s+/.test(line) && line.trim()) fields.description = `${fields.description || ''}${fields.description ? ' ' : ''}${line.trim()}`
  }
  if (!nonBlank(fields.name) || !nonBlank(fields.description)) return { value: null, reason: 'skill frontmatter needs non-empty name and description' }
  return { value: { name: fields.name.trim(), description: fields.description.trim() }, reason: null }
}

function listSkills({ read, readdir, checkout }) {
  const root = join(checkout, 'skills')
  const entries = safeEntries(readdir, root)
  const skills = []
  const reasons = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.directory === false || !validName(entry.name)) continue
    const path = join(root, entry.name, 'SKILL.md')
    const source = safeRead(read, path, path)
    if (!source.text) {
      reasons.push(source.reason || `${path} is unavailable`)
      skills.push({ name: entry.name, description: null, content: marked(null, source.reason || 'skill content is unavailable'), path: relative(checkout, path).replaceAll('\\', '/'), frontmatter: marked(null, source.reason || 'skill frontmatter is unavailable') })
      continue
    }
    const frontmatter = readFrontmatter(source.text)
    if (!frontmatter.value) {
      reasons.push(`${path}: ${frontmatter.reason}`)
      skills.push({ name: entry.name, description: null, content: marked(null, `${path}: ${frontmatter.reason}`), path: relative(checkout, path).replaceAll('\\', '/'), frontmatter: marked(null, `${path}: ${frontmatter.reason}`) })
      continue
    }
    skills.push({ name: frontmatter.value.name, description: frontmatter.value.description, content: source.text, path: relative(checkout, path).replaceAll('\\', '/'), frontmatter: frontmatter.value })
  }
  return { skills, reasons }
}

function commandTokens(value) {
  if (!Array.isArray(value)) return null
  return value.map((token) => String(token)).map((token) => {
    const trimmed = token.trim()
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1)
    return trimmed
  })
}

function shellTokens(value) {
  if (typeof value !== 'string' || value === '') return null
  const tokens = []
  let token = '', quote = null, escaped = false
  for (const character of value) {
    if (escaped) { token += character; escaped = false; continue }
    if (character === '\\' && quote !== "'") { escaped = true; continue }
    if (quote) {
      if (character === quote) quote = null
      else token += character
      continue
    }
    if (character === '"' || character === "'") { quote = character; continue }
    if (/\s/.test(character)) {
      if (token !== '') { tokens.push(token); token = '' }
    } else token += character
  }
  if (escaped || quote) return null
  if (token !== '') tokens.push(token)
  return tokens
}

function deliveredNames(command) {
  if (!record(command)) return { names: null, reason: 'command evidence is not a JSON object' }
  let tokens = null
  if (Array.isArray(command.args)) tokens = commandTokens(command.args)
  else {
    const text = typeof command.command === 'string' ? command.command : typeof command.shell === 'string' ? command.shell : typeof command.cmd === 'string' ? command.cmd : null
    tokens = shellTokens(text)
  }
  if (!tokens) return { names: null, reason: 'command evidence has an unknown or interrupted token shape' }
  const names = []
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== '--skill') continue
    const operand = tokens[index + 1]
    if (!operand || operand.startsWith('--')) return { names: null, reason: 'command evidence has an empty --skill operand' }
    const normalized = operand.replaceAll('\\', '/')
    const match = normalized.match(/(?:^|\/)skills\/([^/]+)\/SKILL\.md$/)
    const name = match ? match[1] : normalized.endsWith('/SKILL.md') ? normalized.split('/').at(-2) : normalized
    if (nonBlank(name) && !names.includes(name)) names.push(name)
  }
  return { names, reason: null }
}

function candidatePaths({ readdir, crewRoot, role }) {
  const candidates = []
  for (const laneName of safeEntries(readdir, crewRoot).map((entry) => entry.name).filter((name) => name.startsWith('dt-')).sort()) {
    const laneRoot = join(crewRoot, laneName)
    for (const taskName of safeEntries(readdir, laneRoot).map((entry) => entry.name).sort()) {
      const taskRoot = join(laneRoot, taskName, 'task')
      for (const store of DELIVERY_STORES) candidates.push(join(taskRoot, store, role, 'cmd.json'))
    }
  }
  return candidates
}

function newestCommand({ read, readdir, stat, crewRoot, role }) {
  const found = []
  const failures = []
  for (const path of candidatePaths({ readdir, crewRoot, role })) {
    let info
    try {
      info = stat(path)
      if (!Number.isFinite(Number(info?.mtimeMs))) throw new Error('mtime is unavailable')
    } catch (error) {
      failures.push(reasonText(`${path} could not be statted`, error))
      continue
    }
    const source = safeRead(read, path, path)
    if (!source.text) { failures.push(source.reason || `${path} is unavailable`); continue }
    try {
      const parsed = JSON.parse(source.text)
      found.push({ path, mtimeMs: Number(info.mtimeMs), command: parsed })
    } catch (error) { failures.push(`${path} is malformed JSON: ${error?.message || String(error)}`) }
  }
  found.sort((left, right) => right.mtimeMs - left.mtimeMs || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const latest = found[0]
  if (!latest) return { command: null, path: null, mtimeMs: null, names: null, reason: failures[0] || DEFAULT_REASONS.command }
  const parsed = deliveredNames(latest.command)
  return { ...latest, ...parsed, reason: parsed.reason }
}

function roleDelivery({ read, readdir, stat, crewRoot, role }) {
  const command = newestCommand({ read, readdir, stat, crewRoot, role })
  if (!command.names) return {
    skills: [], measured: false, reason: command.reason || DEFAULT_REASONS.command,
    source_path: command.path, mtime_ms: command.mtimeMs,
  }
  return { skills: command.names, measured: true, reason: null, source_path: command.path, mtime_ms: command.mtimeMs }
}

function matrixRows({ skills, register, deliveries }) {
  const configured = record(register?.roles) ? register.roles : null
  return AGENT_ROLES.map((role) => {
    const roleConfig = configured && record(configured[role]) ? configured[role] : null
    const grants = Array.isArray(roleConfig?.skills) ? roleConfig.skills : null
    const delivery = deliveries[role]
    const cells = Object.fromEntries(skills.map((skill) => {
      const name = skill.name
      const registerGrant = grants ? grants.includes(name) : marked(null, DEFAULT_REASONS.register)
      const lastSeatDelivery = delivery.measured ? delivery.skills.includes(name) : marked(null, delivery.reason || DEFAULT_REASONS.command)
      return [name, { register_grant: registerGrant, last_seat_delivery: lastSeatDelivery }]
    }))
    return { role, cells }
  })
}

export function createAgentsSource({ checkout = process.cwd(), pluginRoot = checkout, crewRoot = process.env.HOME ? join(process.env.HOME, '.crew') : process.cwd(), readFileSync = fsReadFileSync, readdirSync = fsReaddirSync, statSync = fsStatSync } = {}) {
  const resourcesRoot = resolve(pluginRoot)
  const runtimeRoot = resolve(crewRoot)
  const read = readFileSync
  const readdir = readdirSync
  const stat = statSync
  return {
    read() {
      const register = readRegister(read, resourcesRoot)
      const registerReasons = [...(register.refusals || []).map((item) => item.message)]
      const skillResult = listSkills({ read, readdir, checkout: resourcesRoot })
      const deliveries = Object.fromEntries(AGENT_ROLES.map((role) => [role, roleDelivery({ read, readdir, stat, crewRoot: runtimeRoot, role })]))
      const matrix = matrixRows({ skills: skillResult.skills, register: register.value, deliveries })
      const reasons = [...registerReasons, ...skillResult.reasons]
      for (const role of AGENT_ROLES) {
        const delivery = deliveries[role]
        if (!delivery.measured) reasons.push(`${role}: ${delivery.reason || DEFAULT_REASONS.command}`)
      }
      const roleEvidence = Object.fromEntries(AGENT_ROLES.map((role) => [role, deliveries[role]]))
      return {
        schema: 2,
        degraded: reasons.length > 0,
        reasons: [...new Set(reasons.filter(nonBlank))],
        error: register.value ? null : (registerReasons[0] || DEFAULT_REASONS.register),
        skills: skillResult.skills,
        matrix,
        role_evidence: roleEvidence,
      }
    },
  }
}
