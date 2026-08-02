#!/usr/bin/env node
// Record/replay fake for the real `claude` agent CLI. Mirrors
// test/fixtures/fake-cmux.mjs's shape exactly: driven entirely by env
// switches, no test-specific branches, one JSON line appended to
// $FAKE_CLAUDE_LOG per invocation (including failures), and exits 0
// immediately when $FAKE_CLAUDE_LOG is unset — node --test's default file
// discovery sweeps every .mjs under test/ (including this fixture) and
// imports it with no env set up; that is not a real invocation (every real
// one sets FAKE_CLAUDE_LOG), so exit clean rather than fail the suite
// (fake-cmux.mjs:28-37 explains this exact trap).
//
// Env switches:
//   FAKE_CLAUDE_LOG              required; one JSON line { ts, argv }
//                                appended per invocation.
//   FAKE_CLAUDE_EXIT_CODE        overrides the exit code of a normal run
//                                invocation (default 0).
//   FAKE_CLAUDE_SLEEP_MS         blocking sleep (ms) before a normal run
//                                invocation exits — controls how long the
//                                adapter's own spawnSync stays blocked.
//   FAKE_CLAUDE_WRITE_RETURN     path to bytes to drop at the return_path
//                                embedded in the kickoff positional (the
//                                argv element right after a bare '--'),
//                                simulating a well-behaved worker.
//   FAKE_CLAUDE_HELP             path to a frozen `claude --help` capture
//                                (test/fixtures/claude-help.txt), echoed
//                                verbatim on `--help`.
//   FAKE_CLAUDE_UNKNOWN_OPTION   comma list of flags this fake rejects with
//                                an "unknown option" style stderr line —
//                                drives the adapter's system_prompt_file
//                                probe classification.
import {
  appendFileSync, readFileSync, writeFileSync, existsSync, renameSync, mkdirSync,
} from 'node:fs'
import { dirname } from 'node:path'

const argv = process.argv.slice(2)

const logPath = process.env.FAKE_CLAUDE_LOG
if (!logPath) {
  process.exit(0)
}

function logInvocation() {
  appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), argv })}\n`)
}

function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

// --version / --help short-circuit BEFORE any other flag is inspected —
// exactly the shape the adapter's system_prompt_file probe must never rely
// on (conventions.md 2026-08-01: "--version/--help short-circuit and prove
// nothing").
if (argv[0] === '--version') {
  logInvocation()
  process.stdout.write('claude 1.2.3 (fake)\n')
  process.exit(0)
}

if (argv[0] === '--help') {
  logInvocation()
  const helpPath = process.env.FAKE_CLAUDE_HELP
  const text = helpPath && existsSync(helpPath) ? readFileSync(helpPath, 'utf8') : ''
  process.stdout.write(text)
  process.exit(0)
}

// The system_prompt_file probe (capabilities-only): a call shaped exactly
// like --append-system-prompt-file <path> with nothing else. Classified by
// FAKE_CLAUDE_UNKNOWN_OPTION; otherwise falls through to a file-not-found
// error, mirroring a real build that recognizes the flag but fails trying
// to read the given (deliberately nonexistent) path.
const promptFileIdx = argv.indexOf('--append-system-prompt-file')
if (promptFileIdx >= 0 && argv.length <= promptFileIdx + 2) {
  logInvocation()
  const unknown = new Set((process.env.FAKE_CLAUDE_UNKNOWN_OPTION || '').split(',').map((s) => s.trim()).filter(Boolean))
  if (unknown.has('--append-system-prompt-file')) {
    process.stderr.write("error: unknown option '--append-system-prompt-file'\n")
  } else {
    const target = argv[promptFileIdx + 1]
    process.stderr.write(`Error: ENOENT: no such file or directory, open '${target}'\n`)
  }
  process.exit(1)
}

// The real run: log the invocation, optionally sleep (FAKE_CLAUDE_SLEEP_MS —
// a blocking sleep, so the invoking adapter's own spawnSync stays blocked
// for a controllable window, e.g. to exercise pane-teardown signal safety),
// optionally drop a return file at the return_path embedded in the kickoff
// positional, then exit with FAKE_CLAUDE_EXIT_CODE (default 0).
logInvocation()

const sleepMs = Number(process.env.FAKE_CLAUDE_SLEEP_MS || 0)
if (sleepMs > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs)
}

const dashIdx = argv.indexOf('--')
const kickoff = dashIdx >= 0 ? argv[dashIdx + 1] : undefined
const writeReturnFrom = process.env.FAKE_CLAUDE_WRITE_RETURN
if (writeReturnFrom && kickoff) {
  const m = kickoff.match(/return_path=(\S+)/)
  if (m && existsSync(writeReturnFrom)) {
    writeAtomic(m[1], readFileSync(writeReturnFrom))
  }
}

process.exit(Number(process.env.FAKE_CLAUDE_EXIT_CODE || 0))
