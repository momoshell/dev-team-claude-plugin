// A1: verifyWhere must refuse a `where` entry that leaves the checkout.
// It refuses `../x` and `/etc/passwd`, but a SYMLINK is followed by statSync
// and never realpath-checked, so it verifies and is then READ by discovery.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { verifyWhere, discoverTripwires, resolveWriteSurface } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/scripts/factory/make-brief.mjs'

const root = mkdtempSync(join(tmpdir(), 'a1-'))
const secretDir = mkdtempSync(join(tmpdir(), 'a1-secret-'))
writeFileSync(join(secretDir, 'creds.mjs'), 'export const apiToken = "sk-SECRET-VALUE-0123"\n')
const repo = join(root, 'repo')
mkdirSync(join(repo, 'lib'), { recursive: true })
writeFileSync(join(repo, 'lib', 'widget.mjs'), 'export function widget() { return 1 }\n')
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
g('init', '-q')
g('config', 'user.email', 't@t'); g('config', 'user.name', 't')
// the symlink is a TRACKED file in the repo, exactly as a hostile PR could add
symlinkSync(join(secretDir, 'creds.mjs'), join(repo, 'lib', 'outside.mjs'))
symlinkSync('/etc/passwd', join(repo, 'lib', 'passwd.mjs'))
g('add', '-A'); g('commit', '-qm', 'base')

for (const entry of ['../escape.txt', '/etc/passwd', 'lib/outside.mjs', 'lib/passwd.mjs']) {
  try {
    const v = verifyWhere({ checkout: repo, where: [entry] })
    console.log(`ACCEPTED  ${JSON.stringify(entry)} ->`, JSON.stringify(v))
  } catch (err) {
    console.log(`refused   ${JSON.stringify(entry)} -> reason=${err.reason}`)
  }
}

// and the accepted symlink is then READ by discovery + declared writable
const where = verifyWhere({ checkout: repo, where: ['lib/outside.mjs'] })
const d = discoverTripwires({ checkout: repo, files: where })
console.log('discovery keys from OUTSIDE file:', JSON.stringify(d.keys))
console.log('files_in_scope:', JSON.stringify(resolveWriteSurface({ fences: null, lane: null, where }).files))
rmSync(root, { recursive: true, force: true }); rmSync(secretDir, { recursive: true, force: true })
