// Common Markdown definition fields. Extra frontmatter stays opaque and round-trips.
export const AGENT_FILE_LIMIT = 262144
export function parseAgentFile(text = '') {
  const normalized = String(text).replace(/^\uFEFF/, '').replaceAll('\r\n', '\n')
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalized)
  if (!match) return { name:'', description:'', metadata:'', instructions:normalized, error:'Use a Markdown file with a --- frontmatter block containing name and description.' }
  const lines = match[1].split('\n'), fields = {}, extra = []
  for (let i = 0; i < lines.length; i++) {
    const core = /^(name|description):\s*(.*)$/.exec(lines[i])
    if (!core) { extra.push(lines[i]); continue }
    if (Object.hasOwn(fields, core[1])) return { error:`Frontmatter contains more than one ${core[1]} field.` }
    let value = core[2].trim()
    if (/^[>|][-+]?$/.test(value)) {
      const continuation = []
      while (i + 1 < lines.length && /^(?:\s+|$)/.test(lines[i + 1])) continuation.push(lines[++i].trim())
      value = continuation.join(' ').trim()
    } else if (value.startsWith('"')) {
      try { value = JSON.parse(value) } catch { return { error:`Use a valid quoted ${core[1]} value.` } }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1,-1).replaceAll("''", "'")
    fields[core[1]] = value
  }
  return { name:fields.name || '', description:fields.description || '', metadata:extra.join('\n'), instructions:match[2].replace(/^\n/, ''), error:null }
}
export function composeAgentFile({ name='', description='', metadata='', instructions='' } = {}) {
  return `---\nname: ${JSON.stringify(name.trim())}\ndescription: ${JSON.stringify(description.trim())}${metadata.trim() ? `\n${metadata}` : ''}\n---\n\n${instructions}${instructions.endsWith('\n') ? '' : '\n'}`
}
export function validateAgentFile(text) {
  if (typeof text !== 'string' || text.includes('\0') || new TextEncoder().encode(text).length > AGENT_FILE_LIMIT) return 'Use a text definition smaller than 256 KB without NUL characters.'
  const parsed = parseAgentFile(text)
  if (parsed.error) return parsed.error
  if (typeof parsed.name !== 'string' || !/^[a-z][a-z0-9._-]{0,79}$/.test(parsed.name)) return 'Name must start with a lowercase letter and use up to 80 letters, numbers, dots, underscores or hyphens.'
  if (typeof parsed.description !== 'string' || !parsed.description.trim()) return 'Add a description explaining when to use this agent.'
  if (!parsed.instructions.trim()) return 'Add instructions for the agent.'
  return null
}
