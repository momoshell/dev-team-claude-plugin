// A7: residual probes — existing-directory case aliasing, the commit filter under
// NFD, the comma-split write surface, and changedFiles() porcelain parsing.
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
const ROOT = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2'
const { scopeMatcher, outOfScopeFiles, validateScopeEntries } = await import(`${ROOT}/repo/crew/drive.mjs`)
const { resolveFilesInScope } = await import(`${ROOT}/repo/crew/crew.mjs`)

const R = `${ROOT}/lensC/gitfx2`
rmSync(R, { recursive: true, force: true })
mkdirSync(`${R}/.github/workflows`, { recursive: true })
const git = (...a) => execFileSync('git', ['-C', R, ...a], { encoding: 'utf8' })
git('init', '-q'); git('config', 'user.email', 't@e.invalid'); git('config', 'user.name', 't')
writeFileSync(`${R}/.github/workflows/ci.yml`, 'on: push\n')
writeFileSync(`${R}/a,b.mjs`, 'comma\n')
git('add', '-A'); git('commit', '-qm', 'init')
const changedFiles = () => {
  const out = execSync('git status --porcelain -uall -z', { cwd: R, encoding: 'utf8' })
  const parts = out.split('\0'); const files = []
  for (let i = 0; i < parts.length; i += 1) {
    const e = parts[i]; if (!e) continue
    files.push(e.slice(3))
    if (e[0] === 'R' || e[0] === 'C') { i += 1; if (parts[i]) files.push(parts[i]) }
  }
  return files
}

console.log('=== case-variant into an EXISTING protected dir (.github/Workflows/ vs .github/workflows/) ===')
writeFileSync(`${R}/.github/Workflows/evil.yml`, 'on: pull_request_target\n')
const ch = changedFiles()
console.log('  git prints            :', JSON.stringify(ch))
console.log('  scope ".github/Workflows/" outOfScope =', JSON.stringify(outOfScopeFiles(ch, scopeMatcher(['.github/Workflows/']))))
console.log('  scope ".github/workflows/" outOfScope =', JSON.stringify(outOfScopeFiles(ch, scopeMatcher(['.github/workflows/']))))
execSync(`rm -f '${R}/.github/workflows/evil.yml'`)

console.log('\n=== the --files-in-scope comma split vs a filename containing a comma ===')
writeFileSync(`${R}/a,b.mjs`, 'edited\n')
const ch2 = changedFiles()
console.log('  git prints            :', JSON.stringify(ch2))
const resolved = resolveFilesInScope({ 'files-in-scope': 'a,b.mjs' }, 'reviewed', '/missing/task.json')
console.log('  resolveFilesInScope   :', JSON.stringify(resolved), '  <- ONE file became TWO entries')
console.log('  validateScopeEntries  :', JSON.stringify(validateScopeEntries(resolved)))
console.log('  outOfScope            :', JSON.stringify(outOfScopeFiles(ch2, scopeMatcher(resolved))))
git('checkout', '--', '.')

console.log('\n=== resolveFilesInScope trims, plan envelopes do NOT (two entry points, one gate) ===')
console.log('  CLI  " a.mjs , b.mjs " ->', JSON.stringify(resolveFilesInScope({ 'files-in-scope': ' a.mjs , b.mjs ' }, 'reviewed', '/missing/task.json')))
console.log('  plan envelope [" a.mjs "] validateScopeEntries ->', JSON.stringify(validateScopeEntries([' a.mjs '])), '(ACCEPTED, matches nothing)')
console.log('  scopeMatcher([" a.mjs "])("a.mjs") =', scopeMatcher([' a.mjs '])('a.mjs'))

console.log('\n=== changedFiles() porcelain parsing: rename, space-leading name, deletion ===')
git('mv', '.github/workflows/ci.yml', '.github/workflows/ci2.yml')
writeFileSync(`${R}/ leading.txt`, 'x\n')
console.log('  changedFiles          :', JSON.stringify(changedFiles()))

console.log('\n=== outOfScopeFiles fails OPEN on a non-array changed list ===')
for (const v of [null, undefined, 'a.mjs', 42, { 0: 'a.mjs', length: 1 }]) {
  console.log('  changed=' + String(JSON.stringify(v)).padEnd(24), '->', JSON.stringify(outOfScopeFiles(v, scopeMatcher([]))), '(scope is the EMPTY set: everything should be out of scope)')
}
