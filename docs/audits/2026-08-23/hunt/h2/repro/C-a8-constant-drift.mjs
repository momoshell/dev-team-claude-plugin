// A8: SCOPE_DIR_MIN_SEGMENTS is duplicated as a literal `2` in crew/daemon.mjs:65.
// The tripwire (crew/daemon.test.mjs:298) pins the two implementations against a
// table with NO 2-segment directory entry, so a change to the constant diverges
// the two surfaces without reddening the pin. Mutate the scratch copy and show it.
import { readFileSync, writeFileSync, cpSync, rmSync, mkdirSync } from 'node:fs'
const ROOT = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2'
const M = `${ROOT}/lensC/mut`
rmSync(M, { recursive: true, force: true }); mkdirSync(M, { recursive: true })
cpSync(`${ROOT}/repo/crew`, `${M}/crew`, { recursive: true })
cpSync(`${ROOT}/repo/scripts`, `${M}/scripts`, { recursive: true })

// MUTATION: raise the constant in drive.mjs only (as a maintainer widening the floor would).
const p = `${M}/crew/drive.mjs`
writeFileSync(p, readFileSync(p, 'utf8').replace('export const SCOPE_DIR_MIN_SEGMENTS = 2', 'export const SCOPE_DIR_MIN_SEGMENTS = 3'))

const { validateScopeEntries, SCOPE_DIR_MIN_SEGMENTS } = await import(`${M}/crew/drive.mjs`)
const { scopeEntryDefects } = await import(`${M}/crew/daemon.mjs`)
console.log('mutated drive SCOPE_DIR_MIN_SEGMENTS =', SCOPE_DIR_MIN_SEGMENTS)
const PIN_TABLE = ['crew/crew.mjs', 'tasks/x/captures/', 'lib/*.mjs', '/abs/path.mjs', '../up.mjs', 'crew/', '', 42, 'a{b}.mjs']
let pinRed = false
for (const e of PIN_TABLE) {
  const a = JSON.stringify(validateScopeEntries([e])); const b = JSON.stringify(scopeEntryDefects([e]))
  if (a !== b) { pinRed = true; console.log('  PIN WOULD CATCH at', JSON.stringify(e)) }
}
console.log('daemon.test.mjs:298 pin table detects the drift?', pinRed ? 'YES' : 'NO  <<< silent divergence')
for (const e of ['a/b/', 'crew/roles/', 'docs/adr/']) {
  console.log('  ' + JSON.stringify(e).padEnd(16),
    'drive=' + (validateScopeEntries([e]).length ? 'REJECT' : 'ACCEPT'),
    'daemon=' + (scopeEntryDefects([e]).length ? 'REJECT' : 'ACCEPT'),
    validateScopeEntries([e]).length !== scopeEntryDefects([e]).length ? '  <<< DIVERGED' : '')
}
