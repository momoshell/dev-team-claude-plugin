// A10: attacks the compiler SURVIVES -- recorded as negative results.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyWhere, discoverTripwires, gatherFences, gatherProtectedPaths, BROAD_KEY_HIT_LIMIT } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/scripts/factory/make-brief.mjs'
const NUL = String.fromCharCode(0)
const root = mkdtempSync(join(tmpdir(), 'a10-'))
const repo = join(root, 'repo')
mkdirSync(join(repo, 'lib'), { recursive: true })
writeFileSync(join(repo, 'lib', 'widget.mjs'), [
  "const a = '-e.js'", "const b = '--.js'", "const c = 'a|b-c'", "const d = 'a.b-c'",
  "export function metaChar$Symbol() {}", "export { metaChar$Symbol as $alias$ }",
].join('\n') + '\n')
symlinkSync('/nonexistent/target', join(repo, 'lib', 'dangling.mjs'))
try { execFileSync('mkfifo', [join(repo, 'lib', 'fifo.mjs')]) } catch {}
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('add', '-A'); g('commit', '-qm', 'b')

const probes = [
  ['dangling symlink', 'lib/dangling.mjs'],
  ['FIFO', 'lib/fifo.mjs'],
  ['trailing space', 'lib/widget.mjs '],
  ['leading space', ' lib/widget.mjs'],
  ['glob', 'lib/*.mjs'],
  ['dotdot inside', 'lib/../lib/widget.mjs'],
  ['dotdot escape x3', '../../../etc/passwd'],
  ['absolute', '/etc/passwd'],
  ['NUL byte', 'lib/wid' + NUL + 'get.mjs'],
  ['empty string', ''],
  ['dot (repo root)', '.'],
  ['does not exist', 'lib/nope.mjs'],
  ['directory', 'lib'],
  ['/dev/zero', '/dev/zero'],
]
for (const [label, entry] of probes) {
  try { console.log(`ACCEPTED ${label.padEnd(20)} -> ${JSON.stringify(verifyWhere({ checkout: repo, where: [entry] }))}`) }
  catch (err) { console.log(`refused  ${label.padEnd(20)} -> ${err.reason || err.constructor.name + ': ' + String(err.message).slice(0, 60)}`) }
}
console.log('--- metacharacter keys survive git grep -F ---')
const where = verifyWhere({ checkout: repo, where: ['lib/widget.mjs'] })
const d = discoverTripwires({ checkout: repo, files: where })
console.log('keys:', JSON.stringify(d.keys))
console.log('BROAD_KEY_HIT_LIMIT =', BROAD_KEY_HIT_LIMIT, '(filters the REPORT after each grep already ran)')
console.log('--- fences / protected files ---')
for (const [label, body] of [['not json', 'nope'], ['extra key', '{"lanes":[],"x":1}'], ['lane not object', '{"lanes":[1]}'], ['dup reads', '{"lanes":[{"lane":"a","files":["f"],"reads":[{"file":"x","why":"y"},{"file":"x","why":"y"}]}]}'], ['proto key', '{"lanes":[{"lane":"a","files":["f"],"__proto__":{"z":1}}]}']]) {
  const p = join(root, 'f.json'); writeFileSync(p, body)
  try { gatherFences({ fencesPath: p }); console.log(`ACCEPTED fences ${label}`) } catch (e) { console.log(`refused  fences ${label} -> ${e.reason}`) }
}
for (const [label, body] of [['not json', 'nope'], ['extra key', '{"paths":[],"x":1}'], ['non-string', '{"paths":[1]}']]) {
  const p = join(root, 'p.json'); writeFileSync(p, body)
  try { gatherProtectedPaths({ protectedPathsFile: p }); console.log(`ACCEPTED protected ${label}`) } catch (e) { console.log(`refused  protected ${label} -> ${e.reason}`) }
}
rmSync(root, { recursive: true, force: true })
