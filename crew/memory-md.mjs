import {
  appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs'
import {
  isAbsolute, join, relative, resolve as resolvePath, sep,
} from 'node:path'

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/
const TYPE_RE = /^(user|feedback|project|reference)$/

function parseEntry(text) {
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(text)
  if (!match) return { body: text }

  let name
  let description
  let type
  for (const line of match[1].split('\n')) {
    if (line.startsWith('name: ')) name = line.slice('name: '.length)
    else if (line.startsWith('description: ')) description = line.slice('description: '.length)
    else if (line.startsWith('  type: ')) type = line.slice('  type: '.length)
  }
  return { name, description, type, body: match[2] }
}

function renderEntry({ name, description, type, body }) {
  return [
    '---',
    `name: ${name}`,
    `description: ${description ?? ''}`,
    'metadata:',
    `  type: ${type}`,
    '---',
    '',
    `${body ?? ''}`,
  ].join('\n')
}

function indexLine(title, link, description) {
  return `- [${title}](${link}) — ${description ?? ''}\n`
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

function pathLabel(root, path) {
  const value = relative(root, path)
  return value ? value.split(sep).join('/') : 'MEMORY.md'
}

function renderedPiece(path, text) {
  return `### ${path}\n\n${text}`
}

function budgetValue(value) {
  if (value === Infinity) return Infinity
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : Infinity
}

function dropped(path, bytes, reason) {
  return { path, bytes, reason }
}

function renderedFileBytes(path, label) {
  try {
    const fileStat = statSync(path)
    return fileStat.isFile() ? byteLength(`### ${label}\n\n`) + fileStat.size : 0
  } catch { return 0 }
}

export function openMarkdownMemory({ dir, budgetBytes = Infinity } = {}) {
  const root = resolvePath(String(dir))
  const budget = budgetValue(budgetBytes)

  function context(input = {}) {
    // task and role are accepted by the contract; this backend deliberately
    // does not branch on either one.
    void input
    const included = []
    const droppedFiles = []
    const pieces = []
    let reason = null

    try {
      let directory
      try { directory = statSync(root) } catch { return { text: '', bytes: 0, included, dropped: droppedFiles, reason: 'no-dir' } }
      if (!directory.isDirectory()) return { text: '', bytes: 0, included, dropped: droppedFiles, reason: 'no-dir' }

      const indexPath = join(root, 'MEMORY.md')
      let indexText
      try {
        const indexStat = statSync(indexPath)
        if (!indexStat.isFile()) throw new Error('index is not a regular file')
        indexText = readFileSync(indexPath, 'utf8')
      } catch (err) {
        reason = err?.code === 'ENOENT' ? 'no-index' : 'unreadable-index'
        return { text: '', bytes: 0, included, dropped: droppedFiles, reason }
      }

      const targets = [{ path: indexPath, label: 'MEMORY.md' }]
      const seen = new Set([indexPath])
      let match
      let sawLink = false
      LINK_RE.lastIndex = 0
      while ((match = LINK_RE.exec(indexText)) !== null) {
        sawLink = true
        const target = match[1]
        const resolved = resolvePath(root, target)
        const label = pathLabel(root, resolved)
        if (seen.has(resolved)) continue
        seen.add(resolved)
        const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`
        if (isAbsolute(target) || resolved === root || !resolved.startsWith(rootPrefix)) {
          droppedFiles.push(dropped(label, 0, 'outside-dir'))
          continue
        }
        targets.push({ path: resolved, label })
      }
      if (!sawLink) reason = 'empty-index'

      for (const target of targets) {
        let text
        try {
          const fileStat = statSync(target.path)
          if (!fileStat.isFile()) throw new Error('memory target is not a regular file')
          text = target.path === indexPath ? indexText : readFileSync(target.path, 'utf8')
        } catch {
          // MEMORY.md was already read above; this branch handles linked files
          // individually so one stale or unreadable entry never hides the rest.
          if (target.path !== indexPath) droppedFiles.push(dropped(target.label, 0, 'unreadable'))
          continue
        }

        const piece = renderedPiece(target.label, text)
        const prior = pieces.length ? `${pieces.join('\n\n')}\n\n` : ''
        const candidateBytes = byteLength(`${prior}${piece}`)
        if (candidateBytes > budget) {
          const index = targets.indexOf(target)
          for (const remaining of targets.slice(index)) {
            if (remaining.path === target.path) {
              droppedFiles.push(dropped(remaining.label, byteLength(renderedPiece(remaining.label, text)), 'over-budget'))
            } else {
              droppedFiles.push(dropped(remaining.label, renderedFileBytes(remaining.path, remaining.label), 'over-budget'))
            }
          }
          break
        }
        pieces.push(piece)
        included.push({ path: target.label, bytes: byteLength(piece) })
      }

      const text = pieces.join('\n\n')
      return { text, bytes: byteLength(text), included, dropped: droppedFiles, reason }
    } catch {
      return { text: '', bytes: 0, included: [], dropped: [], reason: 'unreadable-index' }
    }
  }

  function propose(delta = {}) {
    const { name, description, type, body, title } = delta
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error(`invalid memory name "${name}"`)
    if (typeof type !== 'string' || !TYPE_RE.test(type)) throw new Error(`invalid memory type "${type}"`)

    mkdirSync(root, { recursive: true })
    const path = join(root, `${name}.md`)
    const indexPath = join(root, 'MEMORY.md')
    writeFileSync(path, renderEntry({ name, description, type, body }))

    let index = ''
    try { index = readFileSync(indexPath, 'utf8') } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }
    const link = `${name}.md`
    const indexed = index.split(/\r?\n/).some((line) => line.includes(`](${link})`))
    if (!indexed) {
      const prefix = index.length > 0 && !index.endsWith('\n') ? '\n' : ''
      appendFileSync(indexPath, `${prefix}${indexLine(title || name, link, description)}`)
    }
    return { ok: true, path, indexPath, indexed }
  }

  function reconcile(delta = {}) {
    const { name, description, type, body, title } = delta
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error(`invalid memory name "${name}"`)

    mkdirSync(root, { recursive: true })
    const path = join(root, `${name}.md`)
    const indexPath = join(root, 'MEMORY.md')
    let existingText
    let existing = {}
    let created = false
    try {
      existingText = readFileSync(path, 'utf8')
      existing = parseEntry(existingText)
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
      created = true
    }

    const next = {
      name,
      description: description ?? existing.description,
      type: type ?? existing.type,
      body: body ?? existing.body,
    }
    if (typeof next.type !== 'string' || !TYPE_RE.test(next.type)) throw new Error(`invalid memory type "${next.type}"`)

    const content = renderEntry(next)
    const updated = existingText !== content
    writeFileSync(path, content)

    let index = ''
    try { index = readFileSync(indexPath, 'utf8') } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }
    const link = `${name}.md`
    const desiredLine = indexLine(title || name, link, next.description)
    const lines = index.split('\n')
    const indexAt = lines.findIndex((line) => line.includes(`](${link})`))
    let indexUpdated = false
    if (indexAt === -1) {
      const prefix = index.length > 0 && !index.endsWith('\n') ? '\n' : ''
      writeFileSync(indexPath, `${index}${prefix}${desiredLine}`)
      indexUpdated = true
    } else {
      const currentLine = lines[indexAt]
      const currentText = currentLine.endsWith('\r') ? currentLine.slice(0, -1) : currentLine
      const desiredText = desiredLine.slice(0, -1)
      if (currentText !== desiredText) {
        lines[indexAt] = `${desiredText}${currentLine.endsWith('\r') ? '\r' : ''}`
        writeFileSync(indexPath, lines.join('\n'))
        indexUpdated = true
      }
    }
    return { ok: true, path, indexPath, created, updated, indexUpdated }
  }

  function gc({ dryRun = false } = {}) {
    const emptyReport = () => ({ ok: true, dryRun, pruned: [], kept: 0, unlinked: [], overBudget: [] })
    let directory
    try { directory = statSync(root) } catch { return emptyReport() }
    if (!directory.isDirectory()) return emptyReport()

    const indexPath = join(root, 'MEMORY.md')
    let index
    try {
      const indexStat = statSync(indexPath)
      if (!indexStat.isFile()) throw new Error('index is not a regular file')
      index = readFileSync(indexPath, 'utf8')
    } catch (err) {
      if (err?.code === 'ENOENT') return emptyReport()
      throw err
    }

    const trailingNewline = index.endsWith('\n')
    const lines = index.split('\n')
    if (trailingNewline) lines.pop()
    const keptLines = []
    const pruned = []
    const liveTargets = new Set()
    const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`

    for (const line of lines) {
      const links = []
      let match
      LINK_RE.lastIndex = 0
      while ((match = LINK_RE.exec(line)) !== null) links.push(match[1])
      if (!links.length) {
        keptLines.push(line)
        continue
      }

      const stale = []
      for (const target of links) {
        const resolved = resolvePath(root, target)
        let reason = null
        if (isAbsolute(target) || resolved === root || !resolved.startsWith(rootPrefix)) {
          reason = 'escaping'
        } else {
          try {
            const targetStat = statSync(resolved)
            if (!targetStat.isFile()) throw new Error('memory target is not a regular file')
            liveTargets.add(resolved)
          } catch {
            reason = 'orphaned'
          }
        }
        if (reason) stale.push({ path: target, reason })
      }

      if (stale.length === links.length) {
        pruned.push(...stale)
      } else {
        keptLines.push(line)
      }
    }

    const unlinked = readdirSync(root)
      .filter((name) => name.endsWith('.md') && name !== 'MEMORY.md')
      .filter((name) => {
        const path = join(root, name)
        try { return statSync(path).isFile() && !liveTargets.has(path) } catch { return false }
      })
      .sort()

    const overBudget = context({}).dropped
      .filter((entry) => entry.reason === 'over-budget')
      .map((entry) => ({ path: entry.path, bytes: entry.bytes }))

    if (!dryRun && pruned.length) {
      const rewritten = keptLines.join('\n') + (trailingNewline ? '\n' : '')
      writeFileSync(indexPath, rewritten)
    }

    return { ok: true, dryRun, pruned, kept: keptLines.length, unlinked, overBudget }
  }

  return { name: 'markdown', dir, budgetBytes: budget, context, propose, reconcile, gc }
}
