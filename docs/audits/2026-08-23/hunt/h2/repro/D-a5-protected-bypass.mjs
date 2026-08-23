// A5: proposeTier's protected-path test is a byte-exact string compare against
// the AUTHOR'S spelling of `where` (make-brief.mjs:1172-1176), while
// verifyWhere accepts any spelling the OS resolves. On a case-insensitive
// volume "Crew/Drive.mjs" verifies, is read, is written to files_in_scope --
// and scores ZERO protected hits, so the ratified judge-tier raise and
// intake.mjs's 'protected-path' refusal (intake.mjs:995) both go silent.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { verifyWhere, discoverTripwires, proposeTier } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/scripts/factory/make-brief.mjs'

const root = mkdtempSync(join(tmpdir(), 'a5-'))
const repo = join(root, 'repo')
mkdirSync(join(repo, 'crew'), { recursive: true })
mkdirSync(join(repo, 'docs', 'adr'), { recursive: true })
writeFileSync(join(repo, 'crew', 'drive.mjs'), 'export function scopeMatcher() { return 1 }\n')
writeFileSync(join(repo, 'docs', 'adr', '0001-shape.md'), '# adr\n')
writeFileSync(join(repo, 'crew', 'roster.json'), '{}\n')
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('add', '-A'); g('commit', '-qm', 'b')

for (const entry of ['crew/drive.mjs', 'Crew/Drive.mjs', 'CREW/DRIVE.MJS', 'docs/adr/0001-shape.md', 'Docs/ADR/0001-shape.md', 'crew/roster.json', 'Crew/Roster.JSON']) {
  let where
  try { where = verifyWhere({ checkout: repo, where: [entry] }) }
  catch (err) { console.log(`refused  ${entry.padEnd(26)} ${err.reason}`); continue }
  const discovery = discoverTripwires({ checkout: repo, files: where })
  const p = proposeTier({ where, discovery })
  console.log(`${entry.padEnd(26)} protectedHits=${JSON.stringify(p.signals.protectedHits).padEnd(28)} tier=${String(p.tier).padEnd(11)} shape=${p.shape}`)
}
rmSync(root, { recursive: true, force: true })
