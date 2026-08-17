#!/usr/bin/env node
// Offline stand-in for the ast-grep binary. Logs every invocation as one JSON
// line to $FAKE_AST_GREP_LOG and varies only by env switches — no
// test-specific conditionals (the repo's frozen fake-binary fixture shape).
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const log = process.env.FAKE_AST_GREP_LOG
if (log) {
  mkdirSync(dirname(log), { recursive: true })
  appendFileSync(log, `${JSON.stringify(process.argv.slice(2))}\n`)
}

function exitCode(name) {
  const value = Number.parseInt(process.env[name] || '', 10)
  return Number.isInteger(value) && value >= 0 ? value : 0
}

if (process.argv.includes('--version')) {
  console.log('fake-ast-grep 0.0.0')
  process.exit(exitCode('FAKE_AST_GREP_VERSION_EXIT'))
}

const runExit = process.argv.includes('--update-all')
  ? exitCode('FAKE_AST_GREP_UPDATE_EXIT')
  : exitCode('FAKE_AST_GREP_RUN_EXIT')
if (runExit) process.exit(runExit)

process.stdout.write(process.env.FAKE_AST_GREP_DIFF || '')
process.exit(0)
