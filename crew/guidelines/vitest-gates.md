# Portable vitest gates

Vitest's `-t` option is a regular expression, not a literal title. Always pass titles through `vitestTitlePattern(title)`; it escapes regex metacharacters and anchors the complete title. Do not interpolate an unescaped title.

The reporter's final summary is a `Tests` line. Both modern output such as `Tests  1 passed (1)` and legacy output such as `Tests  1 passed` are accepted. `vitestSummaryPassed(output, count)` strips ANSI control sequences, checks the final Tests summary, and rejects failed, skipped, mixed, or count-mismatched summaries. It does not infer success from the process exit status or a Test Files line.

The planner receives this document as an absolute plugin path. Resolve `gate-kit.mjs` as a sibling of that guideline: use the absolute file URL and the same directory as `dirname(guidelinePath)`. The target repository remains `process.cwd()`; do not derive the plugin path from that target cwd. Build the kit URL with `pathToFileURL(join(dirname(guidelinePath), 'gate-kit.mjs')).href`, then dynamically import both helpers from that URL.

A minimal executable gate-check body returns a finding string when red:

```js
const result = spawnSync('npx', [
  'vitest', 'run', testFile, '-t', vitestTitlePattern(title),
], { cwd: process.cwd(), encoding: 'utf8' })
if (result.error) throw result.error
if (result.status !== 0 || !vitestSummaryPassed(result.stdout + '\n' + result.stderr, 1)) {
  return `vitest gate failed for ${testFile}: ${result.stderr}`
}
return null
```
