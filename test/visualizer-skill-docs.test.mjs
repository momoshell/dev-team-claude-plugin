import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ROOT } from './helpers.mjs'

const dirs = ['frontend-svelte', 'ui-design', 'ux'].map(name => `skills/${name}`)
const read = path => readFileSync(join(ROOT, path), 'utf8')
function walk(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`
    return entry.isDirectory() ? walk(path) : [path]
  })
}
const source = walk('visualizer/web/src')
const docs = dirs.flatMap(walk).map(file => ({ file, text: read(file) }))

function missingPaths(text) {
  const errors = []
  const names = new Set(source.map(path => basename(path)))
  const exists = path => existsSync(join(ROOT, path)) && statSync(join(ROOT, path)).isFile()
  const noUrls = text.replace(/https?:\/\/\S+/g, '')
  for (const match of noUrls.matchAll(/\bvisualizer\/[\w./*?{}-]+\.(?:svelte|[cm]?js|css|html|json|md)\b/g)) {
    if (!/[*?{}]/.test(match[0]) && !exists(match[0])) errors.push(match[0])
  }
  const withoutFull = noUrls.replace(/\bvisualizer\/[\w./*?{}-]+/g, '')
  for (const match of withoutFull.matchAll(/(?<![\w/])(?:(?:web\/)?src\/)?lib\/[\w./*?{}-]+\.(?:svelte|js|css)\b/g)) {
    const path = `visualizer/web/src/${match[0].replace(/^(?:web\/)?src\//, '')}`
    if (!/[*?{}]/.test(path) && !exists(path)) errors.push(path)
  }
  for (const match of withoutFull.matchAll(/(?<![\w/.*?{}-])([A-Za-z][\w-]*\.(?:svelte|js|css))\b/g)) {
    if (!names.has(match[1])) errors.push(match[1])
  }
  return errors
}

function countErrors(text, total, requireBoundary = false) {
  const errors = []
  const boundary = text.match(/Measured boundary:\s*(\d+)\s+`\.svelte` files under `visualizer\/web\/src`\./)
  if (requireBoundary && (!boundary || Number(boundary[1]) !== total)) errors.push('boundary')
  const plain = text.replace(/https?:\/\/\S+/g, '').replace(/[`*_]/g, '')
  const checks = [
    /\b\d+\s+of\s+(\d+)\s+(?:(?:\.svelte|Svelte|visualizer|animated)\s+)*components?\b/gi,
    /\b\d+\s*\/\s*(\d+)(?=\s+(?:[A-Za-z-]+\s+){0,3}components?\b)/gi,
    /\b(\d+)\s+(?:(?:\.svelte|Svelte|visualizer|animated)\s+)*components?\b/gi,
    /\b(\d+)\s+(?:(?:visualizer|Svelte)\s+)*\.svelte\s+(?:files|components)\b/gi,
  ]
  for (const regex of checks) for (const match of plain.matchAll(regex)) {
    if (Number(match[1]) !== total) errors.push(match[0])
  }
  for (const line of plain.split(/[\n;]/)) if (/visualizer\/web\/src|\.svelte|component[- ]only census|component suite/i.test(line)) {
    for (const match of line.matchAll(/[,;(]\s*(\d+)\s+files\b/g)) if (Number(match[1]) !== total) errors.push(match[0])
  }
  return errors
}

function motionErrors(motion, ux, css, app) {
  const errors = []
  const live = motion.match(/^Live reduced-motion handling:.*$/m)?.[0] || ''
  for (const pattern of [/visualizer\/web\/src\/lib\/theme\.css/, /@media\s*\(prefers-reduced-motion\s*:\s*reduce\)/, /disable animations and transitions/i, /scroll-behavior\s*:\s*auto/i, /all elements/i, /pseudo-elements/i]) {
    if (!pattern.test(live)) errors.push(String(pattern))
  }
  if (!/!important/.test(motion) || /PhaseDots|\bpulse\b|do not yet|does not yet|counted gap|shared query now covers the 1\/27/i.test(motion + '\n' + ux)) errors.push('stale or incomplete motion description')
  const query = css.match(/@media\s*\(prefers-reduced-motion\s*:\s*reduce\)\s*\{\s*([^{}]+)\{([^{}]+)\}/)
  if (!query || !/\*/.test(query[1]) || !/::before/.test(query[1]) || !/::after/.test(query[1]) || !/animation\s*:\s*none\s*!important/.test(query[2]) || !/transition\s*:\s*none\s*!important/.test(query[2]) || !/scroll-behavior\s*:\s*auto\s*!important/.test(query[2])) errors.push('CSS override')
  if (!/focusActivity/.test(app) || !/matchMedia\('\(prefers-reduced-motion:\s*reduce\)'\)\.matches\s*\?\s*'auto'\s*:\s*'smooth'/.test(app)) errors.push('App scrolling')
  return errors
}

test('VS1 all skill citations resolve to live visualizer files', () => {
  // MUTATION: VS1 — the TaskList prop exhibit must resolve.
  for (const doc of docs) assert.deepEqual(missingPaths(doc.text), [], doc.file)
  assert.ok(missingPaths('visualizer/web/src/lib/DefinitelyMissing.svelte:12').length)
  assert.ok(missingPaths('DefinitelyMissing.js:3').length)
  assert.deepEqual(missingPaths('visualizer/web/src/lib/*.js'), [])
})

test('VS2 component totals and census denominators match recursive source inventory', () => {
  // MUTATION: VS2 — the UX boundary must match the source census.
  const total = source.filter(path => path.endsWith('.svelte')).length
  assert.ok(total > 0)
  for (const doc of docs) assert.deepEqual(countErrors(doc.text, total, dirs.some(dir => doc.file === `${dir}/SKILL.md`)), [], doc.file)
  assert.ok(countErrors('999 visualizer components', total).length)
  assert.ok(countErrors('3 of 999 components', total).length)
  assert.ok(countErrors('3/999 components', total).length)
  assert.ok(countErrors('(visualizer/web/src/**/*.svelte, 999 files)', total).length)
})

test('VS3 motion documentation matches shared CSS and App source', () => {
  // MUTATION: VS3 — the live media query description is required.
  const motion = read('skills/ux/references/motion.md')
  const ux = read('skills/ux/SKILL.md')
  const css = read('visualizer/web/src/lib/theme.css')
  const app = read('visualizer/web/src/App.svelte')
  assert.deepEqual(motionErrors(motion, ux, css, app), [])
  assert.ok(motionErrors(motion.replace('prefers-reduced-motion:reduce', 'prefers-no-motion:reduce'), ux, css, app).length)
})
