import { readFileSync as fsReadFileSync, readdirSync as fsReaddirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

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

function validName(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value)
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

export function createAgentsSource({ checkout = process.cwd(), pluginRoot = checkout, readFileSync = fsReadFileSync, readdirSync = fsReaddirSync } = {}) {
  const resourcesRoot = resolve(pluginRoot)
  const read = readFileSync
  const readdir = readdirSync
  return {
    read() {
      const skillResult = listSkills({ read, readdir, checkout: resourcesRoot })
      const reasons = skillResult.reasons
      return {
        schema: 2,
        degraded: reasons.length > 0,
        reasons: [...new Set(reasons.filter(nonBlank))],
        error: null,
        skills: skillResult.skills,
      }
    },
  }
}
