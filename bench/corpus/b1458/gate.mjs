import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

// Never resolve the checkout from this artifact's location or lean.json.
const root = process.cwd()
const skills = ['frontend-svelte', 'ui-design', 'ux'].map(name => `skills/${name}`)
function walk(relative) {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const path = `${relative}/${entry.name}`
    return entry.isDirectory() ? walk(path) : [path]
  })
}
const read = path => readFileSync(join(root, path), 'utf8')
function inventory() {
  return {
    docs: skills.flatMap(walk).map(file => ({ file, text: read(file) })),
    source: walk('visualizer/web/src'),
  }
}
function checkPaths({ docs, source }) {
  const errors = []
  const names = new Set(source.map(file => basename(file)))
  for (const { file, text } of docs) {
    // Full paths: includes citations outside src (e.g. web/index.html).
    for (const match of text.matchAll(/\bvisualizer\/[A-Za-z0-9_./*?{}-]+\.(?:svelte|[cm]?js|css|html|json|md)\b/g)) {
      const cited = match[0]
      if (/[*?{}]/.test(cited)) continue
      if (!existsSync(join(root, cited)) || !statSync(join(root, cited)).isFile()) errors.push(`${file}: missing ${cited}`)
    }
    for (const match of text.matchAll(/(?<![\w/])(?:(?:web\/)?src\/)?lib\/[A-Za-z0-9_./*?-]+\.(?:svelte|js|css)\b/g)) {
      if (/[*?]/.test(match[0])) continue
      const cited = `visualizer/web/src/${match[0].replace(/^(?:web\/)?src\//, '')}`
      if (!existsSync(join(root, cited)) || !statSync(join(root, cited)).isFile()) errors.push(`${file}: missing ${cited}`)
    }
    // Bare filenames in prose, lists, and tables count too. Do not reinterpret
    // qualified paths, URLs, wildcard *.js/.svelte, or third-party rule sources.
    const bareText = text.replace(/https?:\/\/\S+/g, '').replace(/\bvisualizer\/[A-Za-z0-9_./*?{}-]+/g, '')
    for (const match of bareText.matchAll(/(?<![\w/.*?-])([A-Za-z][\w-]*\.(?:svelte|js|css))\b/g)) {
      const name = match[1]
      if (!names.has(name)) errors.push(`${file}: missing visualizer filename ${name}`)
    }
  }
  return errors
}
function checkCounts({ docs, source }) {
  const total = source.filter(file => file.endsWith('.svelte')).length
  const errors = []
  if (!total) return ['no source components found']
  for (const dir of skills) {
    const doc = docs.find(doc => doc.file === `${dir}/SKILL.md`)
    const match = doc?.text.match(/Measured boundary:\s*(\d+)\s+`\.svelte` files under `visualizer\/web\/src`\./)
    if (!match) errors.push(`${dir}/SKILL.md: missing explicit measured component boundary`)
    else if (Number(match[1]) !== total) errors.push(`${doc.file}: boundary ${match[1]} != ${total}`)
  }
  for (const { file, text } of docs) {
    const plain = text.replace(/https?:\/\/\S+/g, '').replace(/[`*_]/g, '')
    const found = []
    // A standalone N components is a total. Subset claims must have an
    // explicit denominator (X of N or X/N), so they are never confused with it.
    for (const match of plain.matchAll(/\b(\d+)\s+(?:(?:\.svelte|Svelte|visualizer|animated)\s+)*components?\b/gi)) found.push([match[1], match[0]])
    // Census headers also describe totals as files, rather than components.
    for (const match of plain.matchAll(/\b(\d+)\s+(?:(?:visualizer|Svelte)\s+)*\.svelte\s+(?:files|components)\b/gi)) found.push([match[1], match[0]])
    // Legacy rune-census form: '(measured over .../**/*.svelte, 28 files)'.
    for (const sentence of plain.split(/[\n;]/)) {
      if (/visualizer\/web\/src|\.svelte|component[- ]only census|component suite/i.test(sentence)) {
        for (const match of sentence.matchAll(/[,;(]\s*(\d+)\s+files\b/g)) found.push([match[1], match[0]])
      }
    }
    // Fractions near the component predicate can have words between the
    // denominator and 'components', such as 'animated components'.
    for (const match of plain.matchAll(/\b\d+\s*\/\s*(\d+)(?=\s+(?:[A-Za-z-]+\s+){0,3}components?\b)/gi)) found.push([match[1], match[0]])
    for (const [value, exhibit] of found) {
      if (Number(value) !== total) errors.push(`${file}: ${exhibit} uses ${value}, live total is ${total}`)
    }
  }
  return [...new Set(errors)]
}
function checkMotion({ docs }) {
  const errors = []
  const motion = docs.find(doc => doc.file === 'skills/ux/references/motion.md')?.text || ''
  const ux = docs.find(doc => doc.file === 'skills/ux/SKILL.md')?.text || ''
  // Bind this check to the published live-state paragraph, so another mention
  // of the preference elsewhere cannot mask a corrupted description.
  const live = motion.match(/^Live reduced-motion handling:.*$/m)?.[0] || ''
  const plain = live.replace(/[`*_]/g, '')
  const css = read('visualizer/web/src/lib/theme.css')
  const app = read('visualizer/web/src/App.svelte')
  if (!/visualizer\/web\/src\/lib\/theme\.css/.test(live)) errors.push('motion rule must cite the live shared theme.css in its live-state paragraph')
  if (!/@media\s*\(prefers-reduced-motion\s*:\s*reduce\)/.test(plain)) errors.push('motion rule must describe the actual reduced-motion media query')
  if (!/disable\s+animations\s+and\s+transitions/i.test(plain)) errors.push('motion rule must explain that animations and transitions are disabled')
  if (!/scroll-behavior\s*:\s*auto/i.test(plain)) errors.push('motion rule must describe automatic scroll behavior')
  if (!/all elements/i.test(plain) || !/pseudo-elements/i.test(plain)) errors.push('motion rule must describe global and pseudo-element scope')
  if (!/!important/.test(motion)) errors.push('motion rule must describe the important override')
  if (/PhaseDots|\bpulse\b/.test(motion)) errors.push('remove deleted animation findings')
  if (/do not yet|does not yet|counted gap|shared query now covers the 1\/27/i.test(`${ux}\n${motion}`)) errors.push('remove the stale reduced-motion gap assertion')
  const query = css.match(/@media\s*\(prefers-reduced-motion\s*:\s*reduce\)\s*\{\s*([^{}]+)\{([^{}]+)\}/)
  if (!query || !/\*/.test(query[1]) || !/::before/.test(query[1]) || !/::after/.test(query[1]) ||
      !/animation\s*:\s*none\s*!important/.test(query[2]) || !/transition\s*:\s*none\s*!important/.test(query[2]) ||
      !/scroll-behavior\s*:\s*auto\s*!important/.test(query[2])) errors.push('live CSS does not provide the documented global override')
  if (!/focusActivity/.test(app) || !/matchMedia\('\(prefers-reduced-motion:\s*reduce\)'\)\.matches\s*\?\s*'auto'\s*:\s*'smooth'/.test(app)) errors.push('App must retain reduced-motion-aware focus scrolling')
  return errors
}

let data
try { data = inventory() } catch (error) {
  // Infrastructure problems remain explicit, not exceptions disguised as proof.
  for (const id of ['VS1', 'VS2', 'VS3']) console.log(`FAIL ${id}: cannot inspect cwd checkout: ${error.message}`)
  process.exit(1)
}
let failed = false
for (const [id, check] of [['VS1', checkPaths], ['VS2', checkCounts], ['VS3', checkMotion]]) {
  let errors
  try { errors = check(data) } catch (error) { errors = [`inspection error: ${error.message}`] }
  if (errors.length) {
    failed = true
    console.log(`FAIL ${id}: ${errors.slice(0, 8).join('; ')}${errors.length > 8 ? `; and ${errors.length - 8} more` : ''}`)
  }
}
process.exitCode = failed ? 1 : 0
