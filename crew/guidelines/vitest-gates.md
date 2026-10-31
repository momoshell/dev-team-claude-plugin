# Portable vitest gates

Operator reference for vitest repositories; not automatically delivered to seats.

Vitest's `-t` option is a regular expression, not a literal title. Always pass titles through `vitestTitlePattern(title)`; it escapes regex metacharacters, anchors the end, and starts at the beginning or a whitespace boundary so suite-prefixed full names can match. Do not interpolate an unescaped title or depend on a specific separator.

The reporter's final summary is a `Tests` line. Both modern output such as `Tests  1 passed (1)` and legacy output such as `Tests  1 passed` are accepted. `vitestSummaryPassed(output, count)` preserves these unfiltered rules. With the optional `{ filtered: true }` option, it requires a safe requested count of at least one and an exact passed count; skipped tests are permitted only in filtered mode, no other statuses are accepted, and a printed total must equal passed plus skipped. A filtered summary with zero passed tests is always red. It does not infer success from the process exit status or a Test Files line.

Never observe a check through console output from a passing test; reporters may drop it, so read the test result instead.

When choosing this reference, the operator supplies its absolute guideline path. Resolve `gate-kit.mjs` as a sibling of that guideline: use the absolute file URL and the same directory as `dirname(guidelinePath)`. The target repository remains `process.cwd()`; do not derive the plugin path from that target cwd. Build the kit URL with `pathToFileURL(join(dirname(guidelinePath), 'gate-kit.mjs')).href`, then dynamically import both helpers from that URL.

A minimal executable gate-check body returns a finding string when red:

```js
const result = spawnSync('npx', [
  'vitest', 'run', testFile, '-t', vitestTitlePattern(title),
], { cwd: process.cwd(), encoding: 'utf8' })
if (result.error) throw result.error
if (result.status !== 0 || !vitestSummaryPassed(result.stdout + '\n' + result.stderr, 1, { filtered: true })) {
  return `vitest gate failed for ${testFile}: ${result.stderr}`
}
return null
```
