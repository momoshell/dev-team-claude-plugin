// A7: SCOPE_DIRECTORY_UNSLASHED (make-brief.mjs:865-880) is the ratified refusal
// for #145 attempt 3 -- "a scope entry that resolves to a directory can ONLY be
// satisfied by the trailing slash scopeMatcher requires". compile() only calls
// it when the write surface came from a FENCE register (make-brief.mjs:1553).
// The authored-`where` basis -- the one intake.mjs uses for every issue it
// auto-dispatches (compileIntakeBrief passes fences: null, lane: null) -- is
// never validated, so a `where: ["crew"]` ships a files_in_scope that matches
// nothing.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { verifyWhere, resolveWriteSurface, validateScopeEntries } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/scripts/factory/make-brief.mjs'
import { scopeMatcher } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/drive.mjs'

const root = mkdtempSync(join(tmpdir(), 'a7-'))
const repo = join(root, 'repo')
mkdirSync(join(repo, 'lib'), { recursive: true })
writeFileSync(join(repo, 'lib', 'widget.mjs'), 'export function widgetName() { return 1 }\n')
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('add', '-A'); g('commit', '-qm', 'b')

const where = verifyWhere({ checkout: repo, where: ['lib'] })     // a DIRECTORY, no trailing slash
console.log('verifyWhere        ->', JSON.stringify(where))
const surface = resolveWriteSurface({ fences: null, lane: null, where })
console.log('resolveWriteSurface ->', JSON.stringify(surface.files), 'basis =', surface.basis)
console.log('scopeMatcher(files_in_scope)("lib/widget.mjs") =', scopeMatcher(surface.files)('lib/widget.mjs'), '  <- every file in the where is OUT of scope')
try { validateScopeEntries({ checkout: repo, files: surface.files }); console.log('validateScopeEntries -> accepted (?)') }
catch (err) { console.log('validateScopeEntries -> REFUSES:', err.reason, '|', err.message) }
console.log('...but compile() only runs it when writeSurface.basis === "fences" (make-brief.mjs:1553).')
rmSync(root, { recursive: true, force: true })
