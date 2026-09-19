import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from '../../test/helpers.mjs'
import { assertAnchorsPinned, pinnedKey } from '../qa-test-writing/anchor-pin.mjs'

const HERE = fileURLToPath(new URL('./', import.meta.url))
const MANIFEST = join(HERE, 'anchors.json')
const OWNER = 'skills/ui-design/anchors.json'
const MIN_ANCHORS = 5;

// The shipped helper cannot see svelte, css, or html citations, so this table
// covers every such citation endpoint in the repaired docs. Each row is a
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
];

// Mutation killed: move any cited source line, or delete a docs citation,
// and this test reddens - each pin carries content, not just shape.
test('every ui-design path:line anchor carries what the prose claims', () => {
  assert.equal(assertAnchorsPinned({ root: ROOT, skillDir: HERE, manifestPath: MANIFEST, minAnchors: MIN_ANCHORS }), MIN_ANCHORS)
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
