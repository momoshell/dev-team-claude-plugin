import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT, scratchDir } from '../../test/helpers.mjs'
import { checkAnchorManifests, checkSkillAnchors, pinnedKey } from '../qa-test-writing/anchor-pin.mjs'

const HERE = fileURLToPath(new URL('./', import.meta.url))
const MANIFEST = join(HERE, 'anchors.json')
const OWNER = 'skills/ui-design/anchors.json'
const MIN_ANCHORS = 46;

// The shipped helper cannot see css or html citations, so this table covers
// every such citation endpoint in the repaired docs, alongside an independent
// Svelte content census of the manifest-backed source pins. Each row is a
// JSON-compatible triple naming the line the prose claims.
const UNPINNABLE_PINS = [
  ["visualizer/web/index.html", 2, "<meta charset=\"UTF-8\">"],
  ["visualizer/web/src/App.svelte", 27, "let themeValue = 'os'"],
  ["visualizer/web/src/App.svelte", 28, "try { themeValue = localStorage.getItem('dt-theme') || 'os' } catch {}"],
  ["visualizer/web/src/App.svelte", 70, "document.documentElement.dataset.theme = theme"],
  ["visualizer/web/src/App.svelte", 71, "delete document.documentElement.dataset.theme"],
  ["visualizer/web/src/App.svelte", 72, "localStorage.setItem('dt-theme', theme)"],
  ["visualizer/web/src/App.svelte", 181, "<Dropdown bind:value={theme}"],
  ["visualizer/web/src/App.svelte", 248, ".workspace { margin-inline-start:13.5rem;"],
  ["visualizer/web/src/App.svelte", 251, ".error-banner { margin:1rem; border:1px solid var(--status-fail);"],
  ["visualizer/web/src/lib/AcceptPanel.svelte", 23, ".chip.held { color:#166534; background:#dcfce7; }"],
  ["visualizer/web/src/lib/EnvelopeInspector.svelte", 85, ".error { border:1px solid color-mix(in srgb,var(--status-fail) 40%,var(--line));"],
  ["visualizer/web/src/lib/FleetTable.svelte", 14, "status ${row.status.tone}"],
  ["visualizer/web/src/lib/FleetTable.svelte", 15, "{@render mark(row.tier)}"],
  ["visualizer/web/src/lib/FleetTable.svelte", 21, "{@render mark(row.heartbeat)}"],
  ["visualizer/web/src/lib/FleetTable.svelte", 32, "th, td { border-top:1px solid var(--line);"],
  ["visualizer/web/src/lib/FleetTable.svelte", 36, ".status-dot { width:.55rem; height:.55rem; background:var(--neutral);"],
  ["visualizer/web/src/lib/FleetTable.svelte", 37, ".status.ok { color:var(--status-ok); }"],
  ["visualizer/web/src/lib/FleetTable.svelte", 41, ".stale { color:var(--status-escalated); }"],
  ["visualizer/web/src/lib/FleetTable.svelte", 42, ".status-dot { background:currentColor; }"],
  ["visualizer/web/src/lib/GateChips.svelte", 13, ".chip.proven { color:#166534; background:#dcfce7; }"],
  ["visualizer/web/src/lib/IntakePanel.svelte", 90, ".loop-state { display:flex; gap:.7rem;"],
  ["visualizer/web/src/lib/IntakePanel.svelte", 91, ".actor input { min-width:0; width:100%;"],
  ["visualizer/web/src/lib/PhaseDots.svelte", 5, "--lane-color: var(--lane-${phase.lane})"],
  ["visualizer/web/src/lib/PhaseDots.svelte", 8, ".lane-dot { background:var(--lane-color); }"],
  ["visualizer/web/src/lib/PhaseGantt.svelte", 143, "--role-color:var(--lane-${block.lane ?? 6})"],
  ["visualizer/web/src/lib/PhaseGantt.svelte", 146, "--bar-color:var(--lane-${block.lane ?? 6})"],
  ["visualizer/web/src/lib/PhaseGantt.svelte", 254, "--identity-column:17rem; --lane-gap:.6rem"],
  ["visualizer/web/src/lib/PhaseGantt.svelte", 257, ".bar.failed { background:var(--status-fail); color:#fff; }"],
  ["visualizer/web/src/lib/PhasePanel.svelte", 99, ".chip.unproven { color:#92400e; background:#fef3c7; }"],
  ["visualizer/web/src/lib/RoleTag.svelte", 4, "--role-color: var(--role-${role})"],
  ["visualizer/web/src/lib/RoleTag.svelte", 9, ".swatch { width:.65rem; height:.65rem; background:var(--role-color);"],
  ["visualizer/web/src/lib/RosterPanel.svelte", 729, ".notice strong { color:var(--status-fail); }"],
  ["visualizer/web/src/lib/RosterPanel.svelte", 744, ".source-setup input { min-width:0; border:1px solid var(--line);"],
  ["visualizer/web/src/lib/RosterPanel.svelte", 759, ".pick-evidence pre { max-height:12rem;"],
  ["visualizer/web/src/lib/RunCard.svelte", 53, "status ${status.tone}"],
  ["visualizer/web/src/lib/RunCard.svelte", 65, ".status-dot { width:.55rem; height:.55rem; background:currentColor;"],
  ["visualizer/web/src/lib/RunCard.svelte", 66, ".status.ok { color:var(--status-ok); }"],
  ["visualizer/web/src/lib/RunCard.svelte", 69, ".status.serious { color:var(--status-escalated); }"],
  ["visualizer/web/src/lib/RunCard.svelte", 71, ".events { white-space:nowrap; padding:.5rem; border-top:1px solid var(--line); }"],
  ["visualizer/web/src/lib/RunDetail.svelte", 352, ".error-banner { border-left-color:var(--status-fail); }"],
  ["visualizer/web/src/lib/TeardownPanel.svelte", 63, ".chip.unproven { color:var(--status-running); }"],
  ["visualizer/web/src/lib/theme.css", 2, "--ink-ground: #111214;"],
  ["visualizer/web/src/lib/theme.css", 3, "--ink-panel: #191a1d;"],
  ["visualizer/web/src/lib/theme.css", 4, "--ink-panel-raised: #242529;"],
  ["visualizer/web/src/lib/theme.css", 5, "--ink-hairline: #34363b;"],
  ["visualizer/web/src/lib/theme.css", 6, "--ink-text: #f3f5f7;"],
  ["visualizer/web/src/lib/theme.css", 7, "--ink-muted: #a1a5ae;"],
  ["visualizer/web/src/lib/theme.css", 8, "--paper-ground: #fafafa;"],
  ["visualizer/web/src/lib/theme.css", 9, "--paper-panel: #ffffff;"],
  ["visualizer/web/src/lib/theme.css", 10, "--paper-panel-raised: #f2f3f5;"],
  ["visualizer/web/src/lib/theme.css", 11, "--paper-hairline: #e6e7eb;"],
  ["visualizer/web/src/lib/theme.css", 12, "--paper-text: #15181c;"],
  ["visualizer/web/src/lib/theme.css", 13, "--paper-muted: #626671;"],
  ["visualizer/web/src/lib/theme.css", 14, "--spot-light: #5c63bd;"],
  ["visualizer/web/src/lib/theme.css", 15, "--spot-dark: #a5acfa;"],
  ["visualizer/web/src/lib/theme.css", 16, "--role-planner-dark: #9c8cff;"],
  ["visualizer/web/src/lib/theme.css", 17, "--role-builder-dark: #52ced8;"],
  ["visualizer/web/src/lib/theme.css", 18, "--role-reviewer-dark: #6fdda0;"],
  ["visualizer/web/src/lib/theme.css", 19, "--role-tech-lead-dark: #f0b85c;"],
  ["visualizer/web/src/lib/theme.css", 20, "--role-lead-dark: #ef7ca9;"],
  ["visualizer/web/src/lib/theme.css", 21, "--role-driver-dark: #7da7ff;"],
  ["visualizer/web/src/lib/theme.css", 22, "--role-planner-light: #6652db;"],
  ["visualizer/web/src/lib/theme.css", 23, "--role-builder-light: #087f89;"],
  ["visualizer/web/src/lib/theme.css", 24, "--role-reviewer-light: #198a54;"],
  ["visualizer/web/src/lib/theme.css", 25, "--role-tech-lead-light: #a16500;"],
  ["visualizer/web/src/lib/theme.css", 26, "--role-lead-light: #b43f71;"],
  ["visualizer/web/src/lib/theme.css", 27, "--role-driver-light: #315eae;"],
  ["visualizer/web/src/lib/theme.css", 28, "--serious: #ff806f;"],
  ["visualizer/web/src/lib/theme.css", 29, "--status-ok-raw: #4dcc87;"],
  ["visualizer/web/src/lib/theme.css", 30, "--status-fail-raw: #ff6b6b;"],
  ["visualizer/web/src/lib/theme.css", 31, "--status-running-raw: #f2bf62;"],
  ["visualizer/web/src/lib/theme.css", 32, "--status-skipped-raw: #7e8996;"],
  ["visualizer/web/src/lib/theme.css", 44, ":root[data-theme='paper'] {"],
  ["visualizer/web/src/lib/theme.css", 49, "--bg: var(--paper-ground);"],
  ["visualizer/web/src/lib/theme.css", 50, "--panel: var(--paper-panel);"],
  ["visualizer/web/src/lib/theme.css", 52, "--line: var(--paper-hairline);"],
  ["visualizer/web/src/lib/theme.css", 53, "--muted: var(--paper-muted);"],
  ["visualizer/web/src/lib/theme.css", 54, "--accent: var(--spot-light);"],
  ["visualizer/web/src/lib/theme.css", 57, "--neutral: var(--paper-muted);"],
  ["visualizer/web/src/lib/theme.css", 58, "--status-ok: #167346;"],
  ["visualizer/web/src/lib/theme.css", 59, "--status-fail: #c83f49;"],
  ["visualizer/web/src/lib/theme.css", 60, "--status-running: #875600;"],
  ["visualizer/web/src/lib/theme.css", 62, "--status-escalated: #b44432;"],
  ["visualizer/web/src/lib/theme.css", 63, "--role-planner: var(--role-planner-light);"],
  ["visualizer/web/src/lib/theme.css", 64, "--role-builder: var(--role-builder-light);"],
  ["visualizer/web/src/lib/theme.css", 65, "--role-reviewer: var(--role-reviewer-light);"],
  ["visualizer/web/src/lib/theme.css", 66, "--role-tech-lead: var(--role-tech-lead-light);"],
  ["visualizer/web/src/lib/theme.css", 67, "--role-lead: var(--role-lead-light);"],
  ["visualizer/web/src/lib/theme.css", 68, "--role-driver: var(--role-driver-light);"],
  ["visualizer/web/src/lib/theme.css", 71, ":root[data-theme='ink'] {"],
  ["visualizer/web/src/lib/theme.css", 98, "@media (prefers-color-scheme: dark) {"],
  ["visualizer/web/src/lib/theme.css", 99, ":root:not([data-theme='paper']) {"],
  ["visualizer/web/src/lib/theme.css", 133, "--lane-0: var(--role-planner);"],
  ["visualizer/web/src/lib/theme.css", 134, "--lane-1: var(--role-builder);"],
  ["visualizer/web/src/lib/theme.css", 135, "--lane-2: var(--role-reviewer);"],
  ["visualizer/web/src/lib/theme.css", 136, "--lane-3: var(--role-tech-lead);"],
  ["visualizer/web/src/lib/theme.css", 137, "--lane-4: var(--role-lead);"],
  ["visualizer/web/src/lib/theme.css", 138, "--lane-5: var(--role-driver);"],
  ["visualizer/web/src/lib/theme.css", 139, "--lane-6: var(--neutral);"],
  ["visualizer/web/src/lib/theme.css", 140, "--lane-7: var(--muted);"],
  ["visualizer/web/src/lib/theme.css", 152, "*, *::before, *::after { box-sizing: border-box; }"]
  ,["visualizer/web/src/lib/theme.css", 165, ".mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }"],
];

// Mutation killed: move any cited source line, or delete a docs citation,
// and this test reddens - each pin carries content, not just shape.
test('every ui-design path:line anchor carries what the prose claims', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  assert.equal(Object.keys(manifest).length, MIN_ANCHORS)
  const result = checkSkillAnchors({ root: ROOT, skillDir: HERE, manifestPath: MANIFEST })
  assert.deepEqual(result.shifted, [], 'a drifted manifest pin must be repaired, not tolerated')
  assert.deepEqual(result.failures, [], `manifest-backed pins must check clean: ${result.failures.join('\n')}`)
})

// Mutation killed: move any svelte, css, or html exhibit line, or corrupt its
// expected substring, and this test reddens.
test('every ui-design svelte/css/html exhibit carries what the prose claims', () => {
  assert.equal(relative(ROOT, MANIFEST), OWNER)
  for (const [rel, line, expected] of UNPINNABLE_PINS) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n')
    assert.ok(line >= 1 && line <= lines.length, `${rel}:${line} is past the end`)
    assert.ok(expected.trim().length >= 12, `${rel}:${line} expected substring is too short`)
    assert.equal(lines.filter((candidate) => candidate.includes(expected)).length, 1, `${rel}:${line} expected text must occur exactly once`)
    assert.ok(lines[line - 1].includes(expected), `${rel}:${line} does not carry the claimed content`)
  }
})

// The manifest values below are read through indirection, never restated as
// line literals, so a shift moves the key without touching this file.
test('ui-design manifest values resolve through indirection', () => {
  assert.ok(pinnedKey({ manifestPath: MANIFEST, expected: "ROLE_ORDER = Object.freeze(['planner', 'builder'" }).length > 0)
  assert.ok(pinnedKey({ manifestPath: MANIFEST, expected: 'export function deriveStatus(run = {}, taskEnvelope = null)' }).length > 0)
  assert.ok(pinnedKey({ manifestPath: MANIFEST, expected: 'if (run?.running && !run?.phases?.length)' }).length > 0)
  assert.ok(pinnedKey({ manifestPath: MANIFEST, expected: "word: 'status not recorded'" }).length > 0)
  assert.ok(pinnedKey({ manifestPath: MANIFEST, expected: "A human watches the run's existing durable record" }).length > 0)
})

const LIB = join(ROOT, 'visualizer/web/src/lib')
const REF_DIR = join(HERE, 'references')
const SKILL_DOC = join(HERE, 'SKILL.md')
const COLOR_LITERAL_RE = /(?:#[\da-f]{3,8}\b|\b(?:white|black)\b|(?:rgb|rgba|hsl)\()/i
const COLOR_PROP_RE = /(color|background|border|shadow|fill|stroke|outline)/i
const TOKEN_HEX = {
  '--text': { paper: '#15181c', ink: '#f3f5f7' },
  '--bg': { paper: '#fafafa', ink: '#111214' },
  '--panel': { paper: '#ffffff', ink: '#191a1d' },
  '--panel-raised': { paper: '#f2f3f5', ink: '#242529' },
  '--line': { paper: '#e6e7eb', ink: '#34363b' },
  '--muted': { paper: '#626671', ink: '#a1a5ae' },
  '--neutral': { paper: '#626671', ink: '#a1a5ae' },
  '--accent': { paper: '#5c63bd', ink: '#a5acfa' },
  '--status-ok': { paper: '#167346', ink: '#4dcc87' },
  '--status-fail': { paper: '#c83f49', ink: '#ff6b6b' },
  '--status-running': { paper: '#875600', ink: '#f2bf62' },
  '--status-escalated': { paper: '#b44432', ink: '#ff806f' },
  '--status-skipped': { paper: '#7e8996', ink: '#7e8996' },
}

function libFiles() {
  return readdirSync(LIB).filter((name) => name.endsWith('.svelte')).sort()
}

function normSpace(value) {
  return value.trim().replace(/\s+/g, ' ')
}

function cssRules(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((block) => ({ selector: normSpace(block[1]), body: normSpace(block[2]) }))
}

function componentParts(file) {
  const text = readFileSync(join(LIB, file), 'utf8')
  const parts = text.split('<style>')
  if (parts.length < 2) return { markup: text, rules: [] }
  return { markup: parts[0], rules: cssRules(parts.slice(1).join('<style>').split('</style>')[0]) }
}

function declsOf(body) {
  return body.split(';').map((decl) => decl.trim()).filter(Boolean).map((decl) => {
    const at = decl.indexOf(':')
    return { prop: decl.slice(0, at).trim(), value: decl.slice(at + 1).trim() }
  })
}

function lastProp(decls, names) {
  const hit = decls.filter((decl) => names.includes(decl.prop)).map((decl) => normSpace(decl.value))
  return hit.length ? hit[hit.length - 1] : null
}

function stripHoverPseudos(part) {
  return normSpace(part.replace(/:hover(\([^)]*\))?/g, '').replace(/:not\([^)]*\)/g, ''))
}

function restCandidates(hoverSelector) {
  const out = []
  for (const part of hoverSelector.split(',')) {
    const piece = normSpace(part)
    if (!piece.includes(':hover')) continue
    const base = stripHoverPseudos(piece)
    if (base && base !== piece) out.push(base)
    const before = piece.split(':')[0].trim()
    if (before) out.push(before)
    const segs = piece.split(/[\s>+~]+/).filter(Boolean)
    const last = (segs[segs.length - 1] || '').split(':')[0]
    if (last) out.push(last)
  }
  return [...new Set(out.filter(Boolean))]
}

function findRestRule(rules, hoverSelector) {
  for (const cand of restCandidates(hoverSelector)) {
    const hits = rules.filter((rule) => !rule.selector.includes(':hover') && rule.selector.split(',').map((s) => normSpace(s)).includes(cand))
    if (hits.length) return { selector: cand, decls: hits.flatMap((hit) => declsOf(hit.body)) }
  }
  return null
}

function resolveColorValue(value) {
  if (value === null || value === undefined) return { kind: 'absent' }
  const v = normSpace(value)
  if (/color-mix\(/i.test(v)) return { kind: 'colormix', raw: v }
  if (/(linear|radial)-gradient\(/i.test(v)) return { kind: 'gradient', raw: v }
  if (/\btransparent\b/i.test(v)) return { kind: 'transparent', raw: v }
  const single = v.match(/^var\(\s*(--[\w-]+)\s*\)$/)
  if (single) {
    const hex = TOKEN_HEX[single[1]]
    if (hex) return { kind: 'resolved', raw: v, hex }
    return { kind: 'unresolved-token', raw: v, token: single[1] }
  }
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) {
    const h = v.toLowerCase()
    return { kind: 'resolved', raw: v, hex: { paper: h, ink: h } }
  }
  if (/^(inherit|initial|unset|currentColor)$/i.test(v)) return { kind: 'keyword', raw: v }
  if (/var\(/.test(v)) return { kind: 'compound', raw: v }
  return { kind: 'unknown', raw: v }
}

function luminance(hex) {
  let c = hex.replace('#', '')
  if (c.length === 3) c = c.split('').map((x) => x + x).join('')
  const channel = (i) => {
    const v = parseInt(c.substr(i, 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

function contrastRatio(a, b) {
  const x = luminance(a)
  const y = luminance(b)
  return ((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2)
}

function stateResult(fgValue, groundValue, label) {
  const g = resolveColorValue(groundValue)
  const f = resolveColorValue(fgValue)
  if (g.kind === 'transparent') return { reason: `${label} ground is transparent` }
  if (g.kind === 'absent') return { reason: `no source-declared ${label} background` }
  if (g.kind === 'colormix') return { reason: `${label} background is a color-mix, not a flat token value` }
  if (g.kind === 'gradient') return { reason: `${label} background is a gradient, not a flat token value` }
  if (g.kind === 'unresolved-token') return { reason: `${label} ground token ${g.token} has no source-declared value` }
  if (g.kind !== 'resolved') return { reason: `${label} ground is not a resolvable flat value` }
  if (f.kind === 'absent' || f.kind === 'keyword') return { reason: `${label} foreground is inherited, not source-declared` }
  if (f.kind === 'unresolved-token') return { reason: `foreground token ${f.token} has no source-declared value` }
  if (f.kind !== 'resolved') return { reason: `${label} foreground is not a resolvable flat value` }
  return { paper: contrastRatio(f.hex.paper, g.hex.paper), ink: contrastRatio(f.hex.ink, g.hex.ink) }
}

// One record per hover CSS block, not one per component: mixed components keep every rule.
// lean: O(n^2) scan over one-line style blocks; fine at 33 components.
function extractHoverRules(cssText) {
  const rules = cssRules(cssText)
  const hoverRules = rules.filter((rule) => rule.selector.includes(':hover'))
  const records = []
  for (const rule of hoverRules) {
    const hoverDecls = declsOf(rule.body)
    const rest = findRestRule(rules, rule.selector)
    const restDecls = rest ? rest.decls : []
    const restBackground = rest ? lastProp(restDecls, ['background', 'background-color']) : null
    const restForeground = rest ? lastProp(restDecls, ['color']) : null
    const colored = hoverDecls.filter((decl) => COLOR_PROP_RE.test(decl.prop))
    let verdict = 'none'
    if (colored.some((decl) => COLOR_LITERAL_RE.test(decl.value))) verdict = 'literal'
    else if (colored.some((decl) => /var\(|color-mix\(/.test(decl.value))) verdict = 'token'
    records.push({
      selector: rule.selector,
      declarations: colored.map((decl) => `${decl.prop}: ${normSpace(decl.value)}`).join('; '),
      verdict,
      rest: { background: restBackground, foreground: restForeground },
      hover: {
        background: lastProp(hoverDecls, ['background', 'background-color']) ?? restBackground,
        foreground: lastProp(hoverDecls, ['color']) ?? restForeground,
      },
    })
  }
  return records
}

function contrastFor(rule, verdict) {
  if (verdict === 'none') return 'Unmeasured — rule declares no color-affecting declaration'
  const restGround = rule.rest.background;
  const hoverGround = rule.hover.background;
  const restRes = stateResult(rule.rest.foreground, restGround, 'rest')
  const hoverRes = stateResult(rule.hover.foreground, hoverGround, 'hover')
  if (restRes.paper !== undefined && hoverRes.paper !== undefined) {
    return `paper ${restRes.paper} → ${hoverRes.paper}; ink ${restRes.ink} → ${hoverRes.ink}`
  }
  return `Unmeasured — ${restRes.reason ?? hoverRes.reason}`
}

function styleTextOf(file) {
  const text = readFileSync(join(LIB, file), 'utf8')
  return text.split('<style>').slice(1).join('<style>').split('</style>')[0] ?? ''
}

function registerRows() {
  const body = readFileSync(join(REF_DIR, 'limits.md'), 'utf8')
  return [...body.matchAll(/\| `([A-Za-z0-9_-]+\.svelte)` \| `([^`]*)` \| `([^`]*)` \| (token|literal|none) \| `([^`]*)` \| `([^`]*)` \| ([^|]*) \|/g)]
    .map((m) => ({ file: m[1], selector: m[2], declarations: m[3], verdict: m[4], restGround: m[5], hoverGround: m[6], contrast: m[7].trim() }))
}

// Guard for RV1-1: the register's own denominator line is read by a test, not prose.
function assertHoverDenominators() {
  const rows = registerRows()
  const body = readFileSync(join(REF_DIR, 'limits.md'), 'utf8')
  const match = body.match(/(\d+) rules in (\d+)\/(\d+) components/)
  assert.ok(match, 'limits.md must publish the hover-register denominator line')
  assert.equal(Number(match[1]), rows.length, 'published rule count must equal the register rows')
  assert.equal(Number(match[2]), new Set(rows.map((row) => row.file)).size, 'published file count must equal the register files')
  const componentCount = libFiles().length
  assert.equal(Number(match[3]), componentCount, 'published component denominator must equal the live census')
  const measured = rows.filter((row) => !row.contrast.startsWith('Unmeasured')).length
  const WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six']
  assert.ok(body.includes(`${WORDS[measured]} rules carry measured`), 'published measured-rule count must equal the register')
  return { rows, measured }
}

// Mutation killed: hard-coding the denominator instead of counting the component tree.
test('D1', () => {
  const componentCount = libFiles().length
  assert.equal(componentCount, 38)
  const docs = [SKILL_DOC, join(REF_DIR, 'contract.md'), join(REF_DIR, 'state-colour.md')]
  let seen = 0
  for (const doc of docs) {
    for (const match of readFileSync(doc, 'utf8').matchAll(/4 of (\d+) components/g)) {
      seen += 1
      assert.equal(Number(match[1]), componentCount, `${doc} carries a stale T2 denominator`)
    }
  }
  assert.ok(seen >= 3, 'expected a T2 denominator in every repaired doc')
})

// Mutation killed: dropping a leaking component from the published inventory.
test('E1', () => {
  const derived = new Map()
  for (const file of libFiles()) {
    const style = styleTextOf(file)
    const hexes = (style.match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((h) => h.toLowerCase()).sort()
    if (hexes.length) derived.set(file, hexes)
  }
  const body = readFileSync(join(REF_DIR, 'state-colour.md'), 'utf8')
  const rows = [...body.matchAll(/\| `visualizer\/web\/src\/lib\/([^`]+?):(\d+)` \| (.*?) \| (\d+) \|/g)]
  assert.equal(rows.length, 4)
  const published = new Map()
  for (const row of rows) {
    published.set(row[1], (row[3].match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((h) => h.toLowerCase()).sort())
    assert.equal(Number(row[4]), published.get(row[1]).length, `${row[1]} count must equal its listed literals`)
  }
  assert.deepEqual([...published.keys()].sort(), [...derived.keys()].sort(), 'the inventory names exactly the leaking components')
  for (const [file, hexes] of derived) assert.deepEqual(published.get(file), hexes, `${file} literals must match the style-block census`)
  const total = [...derived.values()].reduce((n, hexes) => n + hexes.length, 0)
  assert.equal(total, 22)
  assert.ok(body.includes('| **Total** | **22 hex** | **22** |'), 'the inventory totals 22 hex literals')
})

// Mutation killed: flipping one tabular-nums verdict in the published register.
test('F1', () => {
  // Resolve the local tabular rule through the manifest by content, never by restated line literal.
  const localKey = pinnedKey({ manifestPath: MANIFEST, expected: '.mono { font-family:var(--mono); font-variant-numeric:tabular-nums; }' })
  const derived = new Map()
  for (const file of libFiles()) {
    const { markup, rules } = componentParts(file)
    const markupMono = /class:mono\b/.test(markup) || /class=["'][^"']*\bmono\b/.test(markup)
    const localTabular = rules.some((rule) => /\.mono[^{]*\{[^}]*font-variant-numeric\s*:\s*tabular-nums/.test(`${rule.selector}{${rule.body}}`))
    if (!markupMono && !localTabular) continue
    derived.set(file, {
      verdict: 'compliant',
      source: localTabular ? localKey : 'visualizer/web/src/lib/theme.css:165',
    })
  }
  assert.deepEqual([...derived.keys()].sort(), ['AgentsPage.svelte', 'EventStory.svelte', 'FleetTable.svelte', 'RunCard.svelte', 'SkillsPage.svelte'])
  const body = readFileSync(join(REF_DIR, 'contract.md'), 'utf8')
  const section = body.split('## Tabular numerals')[1].split('## ')[0]
  const rows = [...section.matchAll(/\| `([A-Za-z0-9_-]+\.svelte)` \| (compliant|non-compliant) \| ([^|]*) \|/g)]
  assert.equal(rows.length, 5)
  for (const row of rows) {
    const expected = derived.get(row[1])
    assert.ok(expected, `${row[1]} is not in the source census`)
    assert.equal(row[2], expected.verdict, `${row[1]} verdict must re-derive`)
    assert.ok(row[3].includes(expected.source), `${row[1]} must cite ${expected.source}`)
  }
  assert.ok(section.includes('6/6 compliant, 0/6 non-compliant'), 'the register concludes 6/6 compliant')
})

// Mutation killed: borrowing the hover ground for the rest state.
test('G1', () => {
  const fixture = '.fx { background:transparent; color:var(--muted); }\n.fx:hover { background:var(--panel-raised); color:var(--accent); }'
  const records = extractHoverRules(fixture)
  assert.equal(records.length, 1)
  const [record] = records
  assert.equal(record.verdict, 'token')
  assert.equal(contrastFor(record, record.verdict), 'Unmeasured — rest ground is transparent')
  const hoverRes = stateResult(record.hover.foreground, record.hover.background, 'hover')
  assert.equal(hoverRes.paper, '4.76')
  assert.equal(hoverRes.ink, '7.20')
  const rows = registerRows()
  assert.equal(rows.length, 24)
  assert.equal(new Set(rows.map((row) => row.file)).size, 11)
  for (const file of libFiles()) {
    const expected = extractHoverRules(styleTextOf(file))
    for (const rule of expected) {
      const found = rows.find((row) => row.file === file && row.selector === rule.selector)
      assert.ok(found, `register must carry ${file} ${rule.selector}`)
      assert.equal(found.declarations, rule.declarations || '(none)')
      assert.equal(found.verdict, rule.verdict)
      assert.equal(found.restGround, rule.rest.background ?? 'none declared')
      assert.equal(found.hoverGround, rule.hover.background ?? 'none declared')
      assert.equal(found.contrast, contrastFor(rule, rule.verdict))
    }
  }
  const scope = rows.find((row) => row.file === 'RosterPanel.svelte' && row.selector === '.scope button:hover')
  assert.ok(scope, 'the register carries the RosterPanel scope-button hover rule')
  assert.equal(scope.contrast, 'Unmeasured — rest ground is transparent')
  assertHoverDenominators()
})

// Mutation killed: collapsing rule-level hover rows to one component verdict.
test('H1', () => {
  const fixture = '.mix-a { background:var(--panel-raised); color:var(--muted); }\n.mix-a:hover { color:var(--accent); }\n.mix-b { background:transparent; color:var(--muted); }\n.mix-b:hover { background:color-mix(in srgb,var(--accent) 5%,transparent); }'
  const records = extractHoverRules(fixture)
  assert.equal(records.length, 2)
  assert.equal(contrastFor(records[0], records[0].verdict), 'paper 5.17 → 4.76; ink 6.20 → 7.20')
  assert.ok(contrastFor(records[1], records[1].verdict).startsWith('Unmeasured —'))
  const roster = registerRows().filter((row) => row.file === 'RosterPanel.svelte')
  assert.equal(roster.length, 6, 'a mixed component keeps one row per hover rule')
})

// Mutation killed: recognizing only #hex as a colour literal.
test('I1', () => {
  const cases = ['white', 'black', 'rgb(10, 20, 30)', 'rgba(10, 20, 30, .5)', 'hsl(210, 50%, 40%)', '#fff']
  for (const value of cases) {
    const records = extractHoverRules(`.fx { background:var(--panel-raised); color:var(--muted); }\n.fx:hover { border-color:var(--accent); color:${value}; }`)
    assert.equal(records.length, 1)
    assert.equal(records[0].verdict, 'literal', `${value} beside var() is still a literal`)
  }
  const tokenOnly = extractHoverRules('.fx { background:var(--panel-raised); color:var(--muted); }\n.fx:hover { border-color:var(--accent); color:var(--accent); }')
  assert.equal(tokenOnly[0].verdict, 'token')
})

// Mutation killed: drifting the tabular-nums CSS pin.
test('J1', () => {
  const pin = ["visualizer/web/src/lib/theme.css", 165, ".mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }"]
  assert.ok(UNPINNABLE_PINS.some((row) => row[0] === pin[0] && row[1] === pin[1] && row[2] === pin[2]), 'UNPINNABLE_PINS must pin theme.css:165')
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  assert.ok(!Object.keys(manifest).some((key) => key.startsWith('visualizer/web/src/lib/theme.css:')), 'CSS citations stay out of anchors.json')
  for (const [rel, line, expected] of UNPINNABLE_PINS) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n')
    assert.ok(line >= 1 && line <= lines.length, `${rel}:${line} is past the end`)
    assert.ok(expected.trim().length >= 12, `${rel}:${line} expected substring is too short`)
    assert.equal(lines.filter((candidate) => candidate.includes(expected)).length, 1, `${rel}:${line} expected text must occur exactly once`)
    assert.ok(lines[line - 1].includes(expected), `${rel}:${line} does not carry the claimed content`)
  }
})

// The repository root sweep carries ten manifests at HEAD: nine under skills/
// plus one outside it. The floor stays a lower bound so an eleventh manifest
// remains green while a regression to the skills-only nine goes red.
const MANIFEST_FLOOR = 10
const CLEAN_SUMMARY_SUFFIX = 'rot 0, ambiguous 0, moved 0, unverified 0'

function isCleanSummary(summary) {
  return summary.endsWith(CLEAN_SUMMARY_SUFFIX)
}

function parseManifestCount(summary) {
  const match = /across (\d+) manifests/.exec(summary)
  assert.ok(match, `summary must name a manifest count, got: ${summary}`)
  return Number(match[1])
}

function assertManifestFloor(summary) {
  assert.equal(isCleanSummary(summary), true, `anchor check must stay clean, got: ${summary}`)
  const manifestCount = parseManifestCount(summary)
  assert.ok(manifestCount >= MANIFEST_FLOOR, `anchor sweep must cover at least ${MANIFEST_FLOOR} manifests, got: ${summary}`)
}

// A pinned directory is a notes.md citing one anchor plus its anchors.json.
// The target file carries the cited line so the pin resolves as clean.
function writePinFixture(root, { dir, targetRel, targetContent, cite, manifest }) {
  const fixtureDir = join(root, dir)
  mkdirSync(fixtureDir, { recursive: true })
  if (targetRel) {
    mkdirSync(join(root, targetRel.split('/').slice(0, -1).join('/')), { recursive: true })
    writeFileSync(join(root, targetRel), targetContent)
  }
  writeFileSync(join(fixtureDir, 'notes.md'), `# fixture\n\nExhibit: \`${cite}\`.\n`)
  writeFileSync(join(fixtureDir, 'anchors.json'), JSON.stringify(manifest, null, 2))
}

function captureLog() {
  const lines = []
  const log = (line) => { lines.push(String(line)) }
  return { lines, log }
}

// Mutation killed: narrowing the sweep back to skills drops the count to nine.
test('pin-sweep A1', () => {
  const checkArgs = ['--check', '.']
  const out = execFileSync(process.execPath, [join(ROOT, 'skills/qa-test-writing/anchor-pin.mjs'), ...checkArgs], { cwd: ROOT, encoding: 'utf8' })
  const summary = out.trim().split('\n').pop().trim()
  assertManifestFloor(summary)
})

// Mutation killed: an equality floor rejects the eleventh manifest.
test('pin-sweep B1', () => {
  const root = scratchDir('b904-pin-sweep-b1-')
  for (let index = 0; index < MANIFEST_FLOOR + 1; index += 1) {
    writePinFixture(root, { dir: `manifest-${index}`, cite: 'no citations here', manifest: {} })
  }
  const { lines, log } = captureLog()
  const status = checkAnchorManifests({ root, scanRoot: root, log })
  assert.equal(status, 0)
  assertManifestFloor(lines.at(-1).trim())
})

// Mutation killed: scanning only scratch skills/ hides the outside rot.
test('pin-sweep C1', () => {
  const fxRoot = scratchDir('b904-pin-sweep-c1-')
  const cleanExpected = `const CLEAN = 'clean-distinctive-sentinel-value'`
  writePinFixture(fxRoot, {
    dir: 'skills/clean',
    targetRel: 'skills/clean/target.mjs',
    targetContent: `fixture header line\n${cleanExpected}\nexport default CLEAN\n`,
    cite: 'skills/clean/target.mjs:2',
    manifest: { 'skills/clean/target.mjs:2': cleanExpected },
  })
  const rottedExpected = `const ROTTED = 'rotted-distinctive-sentinel-value'`
  writePinFixture(fxRoot, {
    dir: 'docs/rotten',
    targetRel: 'docs/rotten/target.mjs',
    targetContent: `fixture header line\nconst OTHER = 'entirely-different-target-content'\nexport default OTHER\n`,
    cite: 'docs/rotten/target.mjs:2',
    manifest: { 'docs/rotten/target.mjs:2': rottedExpected },
  })
  const fx = { root: fxRoot }
  const { lines, log } = captureLog()
  const status = checkAnchorManifests({ root: fx.root, scanRoot: fx.root, log })
  assert.equal(status, 1)
  assert.match(lines.at(-1), /rot [1-9]/)
})

// Mutation killed: accepting unverified 1 as clean hides unclassifiable pins.
test('pin-sweep D1', () => {
  assert.equal(isCleanSummary('checked 259 pins across 10 manifests: rot 0, ambiguous 0, moved 0, unverified 0'), true)
  assert.equal(isCleanSummary('checked 259 pins across 10 manifests: rot 0, ambiguous 0, moved 0, unverified 1'), false)
})

// Guard for RV1-1: editing the register's denominator sentence reddens this test.
test('K1', () => {
  const { rows, measured } = assertHoverDenominators()
  assert.equal(rows.length, 24)
  assert.equal(new Set(rows.map((row) => row.file)).size, 11)
  assert.equal(measured, 3)
})

function parseChecklist(body) {
  const lines = body.split('\n')
  const header = lines.findIndex((line) => line.trim() === '| Pattern | Here | Fix |')
  const droppedAt = lines.findIndex((line) => line.trim() === '## Dropped rows')
  const rows = []
  if (header >= 0) {
    for (let i = header + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (!line.startsWith('|')) break
      if (/^\|[\s|:-]+\|$/.test(line)) continue
      rows.push(line)
    }
  }
  const dropped = droppedAt >= 0 ? lines.slice(droppedAt + 1).filter((line) => line.startsWith('- ')) : []
  return { rows, dropped }
}

// Mutation killed: removing the colour route from the Routing table breaks the routed set.
test('CL1', () => {
  const rel = 'skills/ui-design/references/colour-checklist.md'
  assert.ok(existsSync(join(ROOT, rel)), `expected colour checklist, found missing at ${rel}`)
  const skill = readFileSync(SKILL_DOC, 'utf8')
  const routing = skill.split('## Routing')[1].split('## ')[0]
  assert.ok(routing.includes('`references/colour-checklist.md`'), 'expected backticked references/colour-checklist.md route in the Routing table, found absent at skills/ui-design/SKILL.md')
})

// Mutation killed: renaming the Dropped rows heading breaks the row accounting.
test('CL2', () => {
  const rel = 'skills/ui-design/references/colour-checklist.md'
  const body = readFileSync(join(ROOT, rel), 'utf8')
  assert.equal(/visualizer\/[^\s`|]+:\d+/.test(body), false, `expected bare paths only, found a path:line citation at ${rel}`)
  const { rows, dropped } = parseChecklist(body)
  assert.ok(rows.length > 0, `expected checklist data rows, found none at ${rel}`)
  for (const row of rows) {
    const paths = [...row.matchAll(/visualizer\/[^\s`|)]+/g)].map((match) => match[0])
    assert.ok(paths.length > 0, `expected every data row to name a visualizer/ path, found a row without one at ${rel}: ${row.slice(0, 80)}`)
    for (const found of paths) assert.ok(existsSync(join(ROOT, found)), `expected row path to exist, found missing ${found} at ${rel}`)
  }
  assert.equal(rows.length + dropped.length, 17, `expected rows plus dropped to equal 17, found ${rows.length} rows plus ${dropped.length} dropped at ${rel}`)
})

// Mutation killed: altering the pinned revision in the checklist head breaks provenance.
test('CL3', () => {
  const rel = 'skills/ui-design/references/colour-checklist.md'
  const head = readFileSync(join(ROOT, rel), 'utf8').slice(0, 2500)
  for (const needle of ['https://github.com/jakubkrehel/skills', '4c66b1fa86e9ab70187b43d7da9b6fdb29f2ef63', 'MIT', 'THIRD-PARTY-NOTICES.md']) {
    assert.ok(head.includes(needle), `expected checklist head to name ${needle}, found absent at ${rel}`)
  }
})
