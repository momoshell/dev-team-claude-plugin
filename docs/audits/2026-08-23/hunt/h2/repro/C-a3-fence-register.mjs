// A3: END-TO-END fence register. Does `crew.mjs boot --fences --lane` accept a
// register whose entries name DIRECTORIES WITHOUT the trailing slash, and does the
// resulting runtime deny-list then protect nothing?
import { writeFileSync, mkdirSync } from 'node:fs'
const ROOT = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2'
const { resolveLaneFence } = await import(`${ROOT}/repo/crew/crew.mjs`)
const { laneFenceHits, validateScopeEntries } = await import(`${ROOT}/repo/crew/drive.mjs`)
const mb = await import(`${ROOT}/repo/scripts/factory/make-brief.mjs`)

mkdirSync(`${ROOT}/lensC/fx`, { recursive: true })

const CHANGED = ['crew/drive.mjs', 'scripts/factory/intake.mjs', 'docs/adr/ADR-1.md', 'crew/daemon.mjs']

for (const [label, lanes] of [
  ['CORRECT (trailing slash)', [{ lane: 'mine', files: ['crew/a.mjs'] }, { lane: 'sibling', files: ['scripts/factory/', 'crew/drive.mjs'] }]],
  ['UNSLASHED DIR', [{ lane: 'mine', files: ['crew/a.mjs'] }, { lane: 'sibling', files: ['scripts/factory', 'crew'] }]],
  ['DOT-SLASH whole repo', [{ lane: 'mine', files: ['crew/a.mjs'] }, { lane: 'sibling', files: ['./'] }]],
  ['DOT whole repo', [{ lane: 'mine', files: ['crew/a.mjs'] }, { lane: 'sibling', files: ['.'] }]],
  ['ABSOLUTE path', [{ lane: 'mine', files: ['crew/a.mjs'] }, { lane: 'sibling', files: ['/Users/x/Development/dt-s2-factory/crew/drive.mjs'] }]],
  ['GLOB', [{ lane: 'mine', files: ['crew/a.mjs'] }, { lane: 'sibling', files: ['scripts/factory/*.mjs'] }]],
  ['TRAVERSAL', [{ lane: 'mine', files: ['crew/a.mjs'] }, { lane: 'sibling', files: ['scripts/../crew/drive.mjs'] }]],
  ['TRAILING SPACE', [{ lane: 'mine', files: ['crew/a.mjs'] }, { lane: 'sibling', files: ['crew/drive.mjs '] }]],
  ['CASE VARIANT', [{ lane: 'mine', files: ['crew/a.mjs'] }, { lane: 'sibling', files: ['Crew/Drive.mjs'] }]],
]) {
  const p = `${ROOT}/lensC/fx/${label.replace(/[^a-z0-9]/gi, '_')}.json`
  writeFileSync(p, JSON.stringify({ lanes }, null, 2))
  let resolved, err = null
  try { resolved = resolveLaneFence({ fences: p, lane: 'mine' }) } catch (e) { err = e; }
  if (err) { console.log(label.padEnd(26), 'BOOT REFUSED:', err.message); continue }
  const hits = laneFenceHits(CHANGED, resolved.fence)
  const sibFiles = resolved.fence[0]?.files ?? []
  const driveDefects = validateScopeEntries(sibFiles)
  console.log(
    label.padEnd(26),
    'boot=ACCEPT',
    'stored=' + JSON.stringify(sibFiles).padEnd(52),
    'denies=' + JSON.stringify(hits.map((h) => h.entry)).padEnd(24),
    'drive-scope-gate-would-say=' + (driveDefects.length ? JSON.stringify(driveDefects[0].why.slice(0, 30)) : 'ok'),
  )
}

console.log('\n--- make-brief\'s OWN directory check (the guard that exists but is never applied to fences) ---')
for (const files of [['scripts/factory'], ['scripts/factory/'], ['crew'], ['crew/drive.mjs']]) {
  try {
    mb.validateScopeEntries({ checkout: `${ROOT}/repo`, files })
    console.log(JSON.stringify(files).padEnd(24), 'PASSES make-brief check')
  } catch (e) {
    console.log(JSON.stringify(files).padEnd(24), 'REFUSED by make-brief:', e.message, '[' + e.reason + ']')
  }
}
