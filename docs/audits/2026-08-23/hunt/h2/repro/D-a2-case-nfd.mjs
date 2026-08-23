// A2: verifyWhere says "verified" for a spelling that is NOT the repo's spelling.
// Two ways in on APFS: (a) wrong CASE, (b) NFC vs NFD. Both stat() fine, and
// verifyWhere deliberately "keeps the author's spelling for rendering"
// (make-brief.mjs:412), so files_in_scope carries a string the driver's
// byte-exact scopeMatcher (crew/drive.mjs:1388) can never match.
// All non-ASCII is written with \u escapes so this file is byte-stable.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { verifyWhere, resolveWriteSurface, discoverTripwires } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/scripts/factory/make-brief.mjs'
import { scopeMatcher } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/drive.mjs'

const NFC = 'lib/café.mjs'      // single codepoint e-acute
const NFD = 'lib/café.mjs'     // e + combining acute
const root = mkdtempSync(join(tmpdir(), 'a2-'))
const repo = join(root, 'repo')
mkdirSync(join(repo, 'lib'), { recursive: true })
writeFileSync(join(repo, 'lib', 'widget.mjs'), 'export function widgetName() { return 1 }\n')
writeFileSync(join(repo, NFC), 'export function cafeThing() { return 1 }\n')  // created NFC
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('add', '-A'); g('commit', '-qm', 'b')
console.log('git ls-files (ground truth):', g('ls-files').trim().replace(/\n/g, ' | '))

for (const [label, entry, truth] of [
  ['wrong case ', 'Lib/Widget.MJS', 'lib/widget.mjs'],
  ['NFD for NFC', NFD, NFC],
]) {
  try {
    const where = verifyWhere({ checkout: repo, where: [entry] })
    const surface = resolveWriteSurface({ fences: null, lane: null, where })
    const match = scopeMatcher(surface.files)
    console.log(`${label}: ACCEPTED ${JSON.stringify(entry)}  files_in_scope=${JSON.stringify(surface.files)}`)
    console.log(`             scopeMatcher(files_in_scope)(${JSON.stringify(truth)}) = ${match(truth)}  <- the path the lane actually changes`)
    console.log(`             discovery candidates=${JSON.stringify(discoverTripwires({ checkout: repo, files: where }).candidates)}`)
  } catch (err) { console.log(`${label}: refused ${JSON.stringify(entry)} -> ${err.reason}`) }
}
rmSync(root, { recursive: true, force: true })
