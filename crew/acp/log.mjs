// crew/acp/log.mjs — append one JSON line to a crew log file; never throws.

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function logLine(file, obj) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(obj)}\n`)
  } catch { /* logging never throws */ }
}
