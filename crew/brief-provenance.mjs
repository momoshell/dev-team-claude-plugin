// ADR-056: measure only typed or queued Claude Code messages, not seat prompts or pasted text.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function readOperatorMessages({ root, now = Date.now(), days = 30 }) {
  const messages = []
  let incomplete = false
  try {
    const projects = readdirSync(root, { withFileTypes: true })
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const dir = join(root, project.name)
      let files
      try { files = readdirSync(dir, { withFileTypes: true }) } catch { incomplete = true; continue }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
        try {
          const path = join(dir, file.name)
          if (statSync(path).mtimeMs < now - days * 86400000) continue
          for (const line of readFileSync(path, 'utf8').split('\n')) {
            if (!/"promptSource"\s*:\s*"(?:typed|queued)"/.test(line)) continue
            try {
              const row = JSON.parse(line)
              if (row.type === 'user' && row.origin?.kind === 'human' && (row.promptSource === 'typed' || row.promptSource === 'queued') && typeof row.message?.content === 'string') {
                messages.push(row.message.content.replace(/<pasted_content id="([^"]+)">[\s\S]*?<\/pasted_content id="\1">/g, ''))
              }
            } catch { incomplete = true }
          }
        } catch { incomplete = true }
      }
    }
  } catch (error) {
    return { messages: null, reason: error?.code === 'ENOENT' ? `no Claude Code transcript directory at ${root}` : `cannot read Claude Code transcript directory at ${root}: ${error?.code ?? 'unknown error'}` }
  }
  if (incomplete) return { messages: null, reason: `incomplete Claude Code transcript scan under ${root}` }
  return messages.length ? { messages } : { messages: null, reason: `no typed operator message under ${root} in the last ${days} days` }
}

export function askProvenance(ask, messages) {
  const normalise = (text) => text.replace(/\s+/g, ' ').trim()
  const typed = messages.map(normalise)
  return ask.filter(({ text }) => !typed.includes(normalise(text)))
    .map(({ line, text }) => `ask block at line ${line} is not one whole message the operator typed: ${JSON.stringify(text)}`)
}
