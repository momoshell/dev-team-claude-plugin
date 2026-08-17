#!/usr/bin/env node
// Prints the repo-owned reviewer guidelines. The skill is the procedure; this
// file is the loader; the bytes it prints are the repo's data.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const REL = 'crew/guidelines/review-do-not-flag.md'

let dir = resolve(process.cwd())
for (;;) {
  if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, REL))) break
  const up = dirname(dir)
  if (up === dir) {
    console.error(`expected ${REL}, found nothing, at ${process.cwd()}`)
    process.exit(1)
  }
  dir = up
}

process.stdout.write(readFileSync(join(dir, REL), 'utf8'))
