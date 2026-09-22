import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from '../../test/helpers.mjs'
import { checkSkillAnchors, pinnedKey } from '../qa-test-writing/anchor-pin.mjs'

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
  ["visualizer/web/src/App.svelte", 26, "let themeValue = 'ink'"],
  ["visualizer/web/src/App.svelte", 27, "localStorage.getItem('dt-theme')"],
  ["visualizer/web/src/App.svelte", 72, "document.documentElement.dataset.theme = theme"],
  ["visualizer/web/src/App.svelte", 73, "delete document.documentElement.dataset.theme"],
  ["visualizer/web/src/App.svelte", 74, "localStorage.setItem('dt-theme', theme)"],
  ["visualizer/web/src/App.svelte", 173, "Dropdown bind:value={theme}"],
  ["visualizer/web/src/App.svelte", 233, ":global(*) { box-sizing:border-box; }"],
  ["visualizer/web/src/App.svelte", 246, ".rail-status.fail { color:var(--status-fail); }"],
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
  ["visualizer/web/src/lib/PhasePanel.svelte", 100, ".chip.unproven { color:#92400e; background:#fef3c7; }"],
  ["visualizer/web/src/lib/RoleTag.svelte", 4, "--role-color: var(--role-${role})"],
  ["visualizer/web/src/lib/RoleTag.svelte", 9, ".swatch { width:.65rem; height:.65rem; background:var(--role-color);"],
  ["visualizer/web/src/lib/RosterPanel.svelte", 693, ".notice strong { color:var(--status-fail); }"],
  ["visualizer/web/src/lib/RosterPanel.svelte", 708, ".source-setup input { min-width:0; border:1px solid var(--line);"],
  ["visualizer/web/src/lib/RosterPanel.svelte", 721, ".pick-evidence pre { max-height:12rem;"],
  ["visualizer/web/src/lib/RunCard.svelte", 53, "status ${status.tone}"],
  ["visualizer/web/src/lib/RunCard.svelte", 65, ".status-dot { width:.55rem; height:.55rem; background:currentColor;"],
  ["visualizer/web/src/lib/RunCard.svelte", 66, ".status.ok { color:var(--status-ok); }"],
  ["visualizer/web/src/lib/RunCard.svelte", 69, ".status.serious { color:var(--status-escalated); }"],
  ["visualizer/web/src/lib/RunCard.svelte", 71, ".events { white-space:nowrap; padding:.5rem; border-top:1px solid var(--line); }"],
  ["visualizer/web/src/lib/RunDetail.svelte", 294, ".error-banner { margin:0; border:1px solid color-mix(in srgb,var(--status-fail) 45%,var(--line));"],
  ["visualizer/web/src/lib/TeardownPanel.svelte", 63, ".chip.unproven { color:var(--status-running); }"],
  ["visualizer/web/src/lib/theme.css", 2, "--ink-ground: #090d12;"],
  ["visualizer/web/src/lib/theme.css", 3, "--ink-panel: #0f151d;"],
  ["visualizer/web/src/lib/theme.css", 4, "--ink-panel-raised: #151d27;"],
  ["visualizer/web/src/lib/theme.css", 5, "--ink-hairline: #25303d;"],
  ["visualizer/web/src/lib/theme.css", 6, "--ink-text: #f3f5f7;"],
  ["visualizer/web/src/lib/theme.css", 7, "--ink-muted: #8f9baa;"],
  ["visualizer/web/src/lib/theme.css", 8, "--paper-ground: #f3f1eb;"],
  ["visualizer/web/src/lib/theme.css", 9, "--paper-panel: #fffdf8;"],
  ["visualizer/web/src/lib/theme.css", 10, "--paper-panel-raised: #ffffff;"],
  ["visualizer/web/src/lib/theme.css", 11, "--paper-hairline: #d9d5cc;"],
  ["visualizer/web/src/lib/theme.css", 12, "--paper-text: #15181c;"],
  ["visualizer/web/src/lib/theme.css", 13, "--paper-muted: #626970;"],
  ["visualizer/web/src/lib/theme.css", 14, "--spot-light: #6750d8;"],
  ["visualizer/web/src/lib/theme.css", 15, "--spot-dark: #a898ff;"],
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
  ["visualizer/web/src/lib/theme.css", 48, "--bg: var(--paper-ground);"],
  ["visualizer/web/src/lib/theme.css", 49, "--panel: var(--paper-panel);"],
  ["visualizer/web/src/lib/theme.css", 51, "--line: var(--paper-hairline);"],
  ["visualizer/web/src/lib/theme.css", 52, "--muted: var(--paper-muted);"],
  ["visualizer/web/src/lib/theme.css", 53, "--accent: var(--spot-light);"],
  ["visualizer/web/src/lib/theme.css", 55, "--neutral: var(--paper-muted);"],
  ["visualizer/web/src/lib/theme.css", 56, "--status-ok: #16864f;"],
  ["visualizer/web/src/lib/theme.css", 57, "--status-fail: #c83f49;"],
  ["visualizer/web/src/lib/theme.css", 58, "--status-running: #a66900;"],
  ["visualizer/web/src/lib/theme.css", 60, "--status-escalated: #d04f3a;"],
  ["visualizer/web/src/lib/theme.css", 61, "--role-planner: var(--role-planner-light);"],
  ["visualizer/web/src/lib/theme.css", 62, "--role-builder: var(--role-builder-light);"],
  ["visualizer/web/src/lib/theme.css", 63, "--role-reviewer: var(--role-reviewer-light);"],
  ["visualizer/web/src/lib/theme.css", 64, "--role-tech-lead: var(--role-tech-lead-light);"],
  ["visualizer/web/src/lib/theme.css", 65, "--role-lead: var(--role-lead-light);"],
  ["visualizer/web/src/lib/theme.css", 66, "--role-driver: var(--role-driver-light);"],
  ["visualizer/web/src/lib/theme.css", 69, ":root[data-theme='ink'] {"],
  ["visualizer/web/src/lib/theme.css", 94, "@media (prefers-color-scheme: dark) {"],
  ["visualizer/web/src/lib/theme.css", 95, ":root:not([data-theme='paper']) {"],
  ["visualizer/web/src/lib/theme.css", 122, "--lane-0: var(--role-planner);"],
  ["visualizer/web/src/lib/theme.css", 123, "--lane-1: var(--role-builder);"],
  ["visualizer/web/src/lib/theme.css", 124, "--lane-2: var(--role-reviewer);"],
  ["visualizer/web/src/lib/theme.css", 125, "--lane-3: var(--role-tech-lead);"],
  ["visualizer/web/src/lib/theme.css", 126, "--lane-4: var(--role-lead);"],
  ["visualizer/web/src/lib/theme.css", 127, "--lane-5: var(--role-driver);"],
  ["visualizer/web/src/lib/theme.css", 128, "--lane-6: var(--neutral);"],
  ["visualizer/web/src/lib/theme.css", 129, "--lane-7: var(--muted);"],
  ["visualizer/web/src/lib/theme.css", 141, "*, *::before, *::after { box-sizing: border-box; }"]
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
  '--bg': { paper: '#f3f1eb', ink: '#090d12' },
  '--panel': { paper: '#fffdf8', ink: '#0f151d' },
  '--panel-raised': { paper: '#ffffff', ink: '#151d27' },
  '--line': { paper: '#d9d5cc', ink: '#25303d' },
  '--muted': { paper: '#626970', ink: '#8f9baa' },
  '--neutral': { paper: '#626970', ink: '#8f9baa' },
  '--accent': { paper: '#6750d8', ink: '#a898ff' },
  '--status-ok': { paper: '#16864f', ink: '#4dcc87' },
  '--status-fail': { paper: '#c83f49', ink: '#ff6b6b' },
  '--status-running': { paper: '#a66900', ink: '#f2bf62' },
  '--status-escalated': { paper: '#d04f3a', ink: '#ff806f' },
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
  assert.equal(componentCount, 33)
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
  assert.deepEqual([...derived.keys()].sort(), ['AgentsPage.svelte', 'EventStory.svelte', 'FleetTable.svelte', 'RunCard.svelte', 'WorkflowsPage.svelte'])
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
  assert.ok(section.includes('5/5 compliant, 0/5 non-compliant'), 'the register concludes 5/5 compliant')
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
  assert.equal(hoverRes.paper, '5.65')
  assert.equal(hoverRes.ink, '6.95')
  const rows = registerRows()
  assert.equal(rows.length, 25)
  assert.equal(new Set(rows.map((row) => row.file)).size, 12)
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
  assert.equal(contrastFor(records[0], records[0].verdict), 'paper 5.56 → 5.65; ink 6.01 → 6.95')
  assert.ok(contrastFor(records[1], records[1].verdict).startsWith('Unmeasured —'))
  const roster = registerRows().filter((row) => row.file === 'RosterPanel.svelte')
  assert.equal(roster.length, 7, 'a mixed component keeps one row per hover rule')
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
  const out = execFileSync(process.execPath, [join(ROOT, 'skills/qa-test-writing/anchor-pin.mjs'), '--check', 'skills'], { cwd: ROOT, encoding: 'utf8' })
  const finalLine = out.trim().split('\n').pop().trim()
  assert.ok(finalLine.endsWith('rot 0, ambiguous 0, moved 0, unverified 0'), `anchor check must stay clean, got: ${finalLine}`)
})

// Guard for RV1-1: editing the register's denominator sentence reddens this test.
test('K1', () => {
  const { rows, measured } = assertHoverDenominators()
  assert.equal(rows.length, 25)
  assert.equal(new Set(rows.map((row) => row.file)).size, 12)
  assert.equal(measured, 3)
})
