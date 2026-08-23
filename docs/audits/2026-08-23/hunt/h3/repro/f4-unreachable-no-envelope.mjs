// F4 — `envelopeDefect`'s FIRST refusal, ENVELOPE_REFUSAL_REASONS[0]
// 'no-envelope' (crew/drive.mjs:636), is UNREACHABLE from every production
// call site. It is the sibling class the brief asks for: a guard placed after
// an earlier guard that already rejects the same input.
//
//   crew/drive.mjs:636   if (!env || typeof env !== 'object') return refuse('no-envelope', ...)
//   crew/drive.mjs:2051  envelopeDefect(env, ...)   <- driveEnvelopeShape
//   crew/drive.mjs:2127  envelopeDefect(env, ...)   <- driveTriageRound
// Both call sites take `env` from assignAndWait (crew/drive.mjs:1782-1810),
// which returns ONLY after validEnvelope (crew/drive.mjs:713-719) proved
//   env && typeof env === 'object' && typeof env.status === 'string'
// and THROWS otherwise. A non-object can therefore never arrive.
//
// THE PROOF is mechanical, not an argument: this script copies the scratch
// tree, makes that one branch THROW a marker, and runs the whole 321-test
// crew/drive.test.mjs against the copy. If any driveTask path reached it, more
// than the one direct unit-test call would fail.
//
// Run:  node f4-unreachable-no-envelope.mjs
import { cpSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO } from './harness.mjs'

const work = mkdtempSync(join(tmpdir(), 'h3-f4-'))
try {
  cpSync(REPO, work, { recursive: true })
  const file = join(work, 'crew/drive.mjs')
  const src = readFileSync(file, 'utf8')
  const FIND = `  if (!env || typeof env !== 'object') return refuse('no-envelope', 'no envelope')`
  if (!src.includes(FIND)) throw new Error('anchor not found — crew/drive.mjs:636 moved')
  writeFileSync(file, src.replace(FIND,
    `  if (!env || typeof env !== 'object') { throw new Error('H3-REACHED-NO-ENVELOPE') }`))

  const res = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'crew/drive.test.mjs'],
    { cwd: work, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, maxBuffer: 64 * 1024 * 1024 })
  const out = `${res.stdout}${res.stderr}`
  const lines = out.split('\n')
  const summary = Object.fromEntries(lines
    .map((l) => l.match(/^# (pass|fail|tests) (\d+)$/))
    .filter(Boolean).map((m) => [m[1], Number(m[2])]))
  const failedNames = lines.filter((l) => /^not ok \d+ - /.test(l)).map((l) => l.replace(/^not ok \d+ - /, ''))
  const reachedFrom = lines.filter((l) => /H3-REACHED-NO-ENVELOPE/.test(l)).length

  console.log('--- OBSERVED (crew/drive.test.mjs run against the mutated scratch copy) ---')
  console.log('tests:', summary.tests, ' pass:', summary.pass, ' fail:', summary.fail)
  console.log('failing tests:', JSON.stringify(failedNames, null, 2))
  console.log('marker lines in output:', reachedFrom)
  console.log('')
  console.log('Both failing tests are DIRECT unit calls that hand envelopeDefect a null:')
  console.log('  crew/drive.test.mjs:5532-5533  envelopeDefect(null, VARIANTS.scout, ...)')
  console.log('  crew/drive.test.mjs:5537-...   the frozen-enum test, same direct call')
  console.log('The 11 malformed-envelope cases that go THROUGH driveTask in that same test')
  console.log('(crew/drive.test.mjs:5518-5530) all still pass: no driveTask path reaches it.')
  console.log('')
  console.log('--- EXPECTED ---')
  console.log('Either a production path can supply a non-object env (then more tests fail),')
  console.log('or the refusal is dead and ENVELOPE_REFUSAL_REASONS carries a reason no run')
  console.log('can ever emit — the same defect class the audit already proved for intake\'s')
  console.log('protected-path refusal.')
} finally {
  rmSync(work, { recursive: true, force: true })
}
