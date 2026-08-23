// A6: filesystem-level aliasing on macOS (APFS, case-insensitive) vs the
// string-equality scope gate. Uses a REAL throwaway git repo in the scratchpad.
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
const ROOT = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2'
const { scopeMatcher, validateScopeEntries, protectedHits, outOfScopeFiles } = await import(`${ROOT}/repo/crew/drive.mjs`)

const R = `${ROOT}/lensC/gitfx`
rmSync(R, { recursive: true, force: true })
mkdirSync(`${R}/crew`, { recursive: true })
mkdirSync(`${R}/docs`, { recursive: true })
const git = (...a) => execFileSync('git', ['-C', R, ...a], { encoding: 'utf8' })
git('init', '-q')
git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't')
writeFileSync(`${R}/crew/drive.mjs`, 'original\n')
const NFC = 'docs/café.md'          // é as U+00E9
const NFD = 'docs/café.md'         // e + U+0301
writeFileSync(`${R}/${NFC}`, 'nfc\n')
git('add', '-A'); git('commit', '-qm', 'init')
console.log('git config core.precomposeunicode =', git('config', '--get', 'core.precomposeunicode').trim() || '(unset)')

// exactly crew/seat-io.mjs:2093-2107
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

console.log('\n=== CASE: plan declares "crew/Drive.mjs"; builder writes via that exact path ===')
writeFileSync(`${R}/crew/Drive.mjs`, 'builder edit\n')     // APFS resolves to crew/drive.mjs
const ch1 = changedFiles()
const declared1 = 'crew/Drive.mjs'
console.log('  validateScopeEntries      :', validateScopeEntries([declared1]).length ? 'REJECT' : 'ACCEPT')
console.log('  protectedHits([declared]) :', JSON.stringify(protectedHits([declared1])), '  <- crew/drive.mjs IS on the floor')
console.log('  git changedFiles()        :', JSON.stringify(ch1))
console.log('  outOfScopeFiles           :', JSON.stringify(outOfScopeFiles(ch1, scopeMatcher([declared1]))))
console.log('  content of crew/drive.mjs :', JSON.stringify(execSync(`cat '${R}/crew/drive.mjs'`, { encoding: 'utf8' })))
git('checkout', '--', '.')

console.log('\n=== UNICODE: file committed as NFC, plan declares NFD (and vice versa) ===')
writeFileSync(`${R}/${NFC}`, 'edited\n')
const ch2 = changedFiles()
console.log('  git prints                :', JSON.stringify(ch2), ' bytes=', Buffer.from(ch2[0]).toString('hex'))
for (const [label, decl] of [['declared NFC', NFC], ['declared NFD', NFD]]) {
  console.log('  ' + label.padEnd(24), 'valid=' + (validateScopeEntries([decl]).length ? 'n' : 'Y'),
    'outOfScope=' + JSON.stringify(outOfScopeFiles(ch2, scopeMatcher([decl]))))
}
git('checkout', '--', '.')

console.log('\n=== UNICODE 2: the file is CREATED with an NFD name (what a builder does with the declared string) ===')
writeFileSync(`${R}/${NFD}`, 'new\n')
const ch3 = changedFiles()
console.log('  git prints                :', JSON.stringify(ch3))
for (const f of ch3) console.log('    bytes                   :', Buffer.from(f).toString('hex'), 'NFC?', f === f.normalize('NFC'), 'NFD?', f === f.normalize('NFD'))
for (const [label, decl] of [['declared NFC', NFC], ['declared NFD', NFD]]) {
  console.log('  ' + label.padEnd(24), 'outOfScope=' + JSON.stringify(outOfScopeFiles(ch3, scopeMatcher([decl]))))
}

console.log('\n=== CASE 2: scope declares dir "docs/sub/"; builder mkdirs "docs/Sub/" ===')
mkdirSync(`${R}/docs/Sub`, { recursive: true })
writeFileSync(`${R}/docs/Sub/x.md`, 'x\n')
const ch4 = changedFiles().filter((f) => f.toLowerCase().includes('sub'))
console.log('  git prints                :', JSON.stringify(ch4))
console.log('  scope "docs/sub/" ->      :', 'outOfScope=' + JSON.stringify(outOfScopeFiles(ch4, scopeMatcher(['docs/sub/']))))
console.log('  scope "docs/Sub/" ->      :', 'outOfScope=' + JSON.stringify(outOfScopeFiles(ch4, scopeMatcher(['docs/Sub/']))))
