import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const KEY_NAME = 'ARTIFICIAL_ANALYSIS_API_KEY'

function assignment(value) {
  const secret = typeof value === 'string' ? value.trim() : ''
  if (secret.length < 8 || secret.length > 512 || /[\r\n\0]/.test(secret)) throw new Error('api_key must be a single line between 8 and 512 characters')
  return `${KEY_NAME}=${JSON.stringify(secret)}`
}

export function saveArtificialAnalysisKey(path, value) {
  let source = ''
  try { source = readFileSync(path, 'utf8') } catch (err) { if (err?.code !== 'ENOENT') throw err }
  const nextAssignment = assignment(value)
  const lines = source ? source.replace(/\r?\n$/, '').split(/\r?\n/) : []
  const matcher = /^\s*(?:export\s+)?ARTIFICIAL_ANALYSIS_API_KEY\s*=/
  let wrote = false
  const output = []
  for (const line of lines) {
    if (!matcher.test(line)) { output.push(line); continue }
    if (!wrote) { output.push(nextAssignment); wrote = true }
  }
  if (!wrote) output.push(nextAssignment)

  mkdirSync(dirname(path), { recursive:true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${output.join('\n')}\n`, { encoding:'utf8', mode:0o600, flag:'wx' })
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  } catch (err) {
    rmSync(temporary, { force:true })
    throw err
  }
  return { saved:true, variable:KEY_NAME }
}
