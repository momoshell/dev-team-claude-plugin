// A6c: worst-case key density, and `where: ["."]` over this whole checkout.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { extractKeys } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/scripts/factory/make-brief.mjs'
const repo = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo'
// densest legal key: a 4-char error code in quotes = 7 bytes per key
let src = ''
for (let i = 0; i < 150_000; i += 1) src += `'${i.toString(36).padStart(4, 'a')}-z'\n`
const dense = extractKeys(src, 'lib/dense.mjs')
console.log(`1 MiB-class source (${(src.length / 1048576).toFixed(2)} MiB) -> ${dense.length} keys -> ${dense.length} git grep spawns`)
console.log(`  at the measured 10.6 ms/grep: ${(dense.length * 10.6 / 60000).toFixed(0)} minutes; at the 30 s per-grep timeout ceiling: ${(dense.length * 30 / 3600).toFixed(0)} hours`)
const files = execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' }).trim().split('\n')
const all = new Set()
for (const f of files) { try { for (const k of extractKeys(readFileSync(`${repo}/${f}`, 'utf8'), f)) all.add(k) } catch {} }
console.log(`where: ["."] over this checkout -> ${files.length} files, ${all.size} keys => ${all.size + files.length * 2} spawns => ~${((all.size + files.length * 2) * 10.6 / 1000).toFixed(0)} s`)
console.log('there is no overall timeout on make-brief; only a 30 s timeout on each individual git grep')
