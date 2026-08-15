import {
  appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs'
import {
  isAbsolute, join, relative, resolve as resolvePath, sep,
} from 'node:path'

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/
const TYPE_RE = /^(user|feedback|project|reference)$/

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
    const content = [
      '---',
      `name: ${name}`,
      `description: ${description ?? ''}`,
      'metadata:',
      `  type: ${type}`,
      '---',
      '',
      `${body ?? ''}`,
    ].join('\n')
    writeFileSync(path, content)

    let index = ''
    try { index = readFileSync(indexPath, 'utf8') } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }
    const link = `${name}.md`
    const indexed = index.split(/\r?\n/).some((line) => line.includes(`](${link})`))
    if (!indexed) {
      const prefix = index.length > 0 && !index.endsWith('\n') ? '\n' : ''
      appendFileSync(indexPath, `${prefix}- [${title || name}](${link}) — ${description ?? ''}\n`)
    }
    return { ok: true, path, indexPath, indexed }
  }

  return { name: 'markdown', dir, budgetBytes: budget, context, propose }
}
