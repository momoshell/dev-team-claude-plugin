// A6b: the same unbounded-work shape measured on THIS repo.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { extractKeys } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/scripts/factory/make-brief.mjs'
const repo = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo'
const files = execFileSync('git', ['-C', repo, 'ls-files', '--', 'crew/'], { encoding: 'utf8' }).trim().split('\n')
const all = new Set()
for (const f of files) {
  try { for (const k of extractKeys(readFileSync(`${repo}/${f}`, 'utf8'), f)) all.add(k) } catch {}
}
console.log(`where: ["crew/"] -> ${files.length} files, ${all.size} distinct keys => ${all.size + files.length * 2} git grep spawns`)
const t0 = Date.now()
for (let i = 0; i < 20; i += 1) {
  execFileSync('git', ['-C', repo, 'grep', '-l', '-F', '-e', [...all][i], '--', '.'], { encoding: 'utf8' }).length
}
const per = (Date.now() - t0) / 20
console.log(`measured ${per.toFixed(1)} ms per git grep on this checkout`)
console.log(`projected discoverTripwires wall time: ${((all.size + files.length * 2) * per / 1000).toFixed(0)} s`)
