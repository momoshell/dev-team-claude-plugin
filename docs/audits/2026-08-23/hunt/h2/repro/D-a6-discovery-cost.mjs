// A6: discoverTripwires spawns ONE `git grep` per discovered key. The number of
// keys is a function of the TARGET FILE's contents and is bounded by nothing.
// BROAD_KEY_LIMIT (make-brief.mjs:60, exported as BROAD_KEY_HIT_LIMIT) filters a
// key AFTER its grep already ran, so it bounds the REPORT, never the WORK.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { extractKeys, verifyWhere, discoverTripwires } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/scripts/factory/make-brief.mjs'

const n = Number(process.argv[2] || 400)
const root = mkdtempSync(join(tmpdir(), 'a6-'))
const repo = join(root, 'repo')
mkdirSync(join(repo, 'lib'), { recursive: true })
// A source file that is entirely ORDINARY: n distinct error-code string literals.
const body = Array.from({ length: n }, (_, i) => `  if (x) throw new Error('bad-input-code${i}')`).join('\n')
writeFileSync(join(repo, 'lib', 'widget.mjs'), `export function widget(x) {\n${body}\n}\n`)
for (let i = 0; i < 200; i += 1) writeFileSync(join(repo, 'lib', `filler${i}.mjs`), 'export const k = 1\n'.repeat(50))
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('add', '-A'); g('commit', '-qm', 'b')

const keys = extractKeys(`export function widget(x) {\n${body}\n}\n`, 'lib/widget.mjs')
console.log(`file is ${(body.length / 1024).toFixed(1)} KiB, extractKeys -> ${keys.length} keys`)
const where = verifyWhere({ checkout: repo, where: ['lib/widget.mjs'] })
const t0 = Date.now()
const d = discoverTripwires({ checkout: repo, files: where })
console.log(`discoverTripwires: ${Date.now() - t0} ms for ${keys.length} keys (= that many git grep spawns)`)
console.log(`report size: tripwires=${d.tripwires.length} broadKeys=${d.broadKeys.length}`)
rmSync(root, { recursive: true, force: true })
