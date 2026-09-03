#!/usr/bin/env node
// Prints the reviewer guidelines. The skill is the procedure; this file is the
// loader; the bytes it prints are the repo's data.
//
// Resolution order: a copy in the repository under review OVERRIDES the plugin's
// own bundled copy, so an in-repo run is byte-identical to what this loader has
// always printed and a foreign run still finds the plugin's data (#876). With
// neither reachable the loader states an EMPTY list and exits 0 — a review run
// outside this checkout is not a broken checkout.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REL = 'crew/guidelines/review-do-not-flag.md'
const EMPTY_STATEMENT = `no reviewer guidelines were loaded: ${REL} was not found in the repository under review or beside this loader. Treat the do-not-flag list as EMPTY and state that blind spot in the review; it is never a clear.\n`

// The repo under review, found the way this loader has always found it: the
// nearest ancestor of the working directory holding BOTH a package.json and the
// guidelines. Unchanged behaviour, demoted to an override.
function walkUp(from) {
  let dir = resolve(from)
  for (;;) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, REL))) return join(dir, REL)
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const bundledPath = join(pluginRoot, REL)
const bundled = existsSync(bundledPath) ? bundledPath : null
const override = walkUp(process.cwd())
const source = override || bundled

if (source) process.stdout.write(readFileSync(source, 'utf8'))
else process.stdout.write(EMPTY_STATEMENT)
