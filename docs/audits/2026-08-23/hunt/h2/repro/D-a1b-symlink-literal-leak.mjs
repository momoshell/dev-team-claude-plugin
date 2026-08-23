// A1b: the same symlink escape leaks a QUOTED LITERAL from outside the checkout
// straight into the rendered brief's key register + generated grep line.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { verifyWhere, discoverTripwires, renderBrief } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/scripts/factory/make-brief.mjs'

const root = mkdtempSync(join(tmpdir(), 'a1b-'))
const secretDir = mkdtempSync(join(tmpdir(), 'a1b-secret-'))
writeFileSync(join(secretDir, 'creds.mjs'), "const t = 'ghp-9f2c1a-live-token'\nexport const readToken = () => t\n")
const repo = join(root, 'repo')
mkdirSync(join(repo, 'lib'), { recursive: true })
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't')
symlinkSync(join(secretDir, 'creds.mjs'), join(repo, 'lib', 'outside.mjs'))
writeFileSync(join(repo, 'README.md'), 'x\n')
g('add', '-A'); g('commit', '-qm', 'base')

const where = verifyWhere({ checkout: repo, where: ['lib/outside.mjs'] })
const discovery = discoverTripwires({ checkout: repo, files: where })
const brief = renderBrief({
  request: { ask: 'tidy the widget module', where: ['lib/outside.mjs'], done_means: 'done', out_of_scope: 'nothing' },
  where, discovery,
})
console.log(brief.split('\n').filter((l) => /ghp-|declare every hit|candidates:/.test(l)).join('\n'))
rmSync(root, { recursive: true, force: true }); rmSync(secretDir, { recursive: true, force: true })
