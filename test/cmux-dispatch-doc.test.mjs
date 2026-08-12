import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'
import { readCmuxPreviewUrl } from '../scripts/cmux/dispatch.mjs'

const doc = readFileSync(join(ROOT, 'references/cmux-dispatch.md'), 'utf8')
const dispatchSrc = readFileSync(join(ROOT, 'scripts/cmux/dispatch.mjs'), 'utf8')
const qaGateDoc = readFileSync(join(ROOT, 'references/qa-gate.md'), 'utf8')
const teamDoc = readFileSync(join(ROOT, 'commands/team.md'), 'utf8')

// ---------------------------------------------------------------------------
// doc-78-03 (issue #78, ADR-028) — the PreToolUse dispatch-guard doc pins.
// Every NEW normative sentence added to references/cmux-dispatch.md and
// commands/team.md for this slice gets a pinned assertion here.
// ---------------------------------------------------------------------------

test('cmux-dispatch.md §1 names the mechanical backstop (hooks/dispatch-guard.mjs) adjacent to the HARD STOP passage', () => {
  const hardStopIdx = doc.indexOf('**Preflight failure is a HARD STOP.**')
  assert.ok(hardStopIdx > -1, 'expected to find the HARD STOP passage')
  const backstopIdx = doc.indexOf('**Mechanical backstop (be-78-02):**')
  assert.ok(backstopIdx > -1, 'expected to find the mechanical-backstop paragraph')
  assert.ok(backstopIdx > hardStopIdx, 'the backstop paragraph must come after the HARD STOP passage')
  assert.ok(backstopIdx - hardStopIdx < 800, 'the backstop paragraph must sit adjacent to the HARD STOP passage, not elsewhere in the doc')
  assert.match(doc, /a PreToolUse hook \(`hooks\/dispatch-guard\.mjs`\) now DENIES an Agent-tool dispatch of a `pane: true` role while `execution_mode` resolves `cmux`/)
})

test('cmux-dispatch.md names the kill switch and the fail-open posture, without restating the ADR', () => {
  assert.match(doc, /Kill switch: `\/dev-team:team mode agent-tool`/)
  assert.match(doc, /a broken config never blocks Agent-tool use; it degrades to unenforced with a logged reason/)
  assert.match(doc, /~\/\.dev-team\/guard\/dispatch-guard\.jsonl/)
  assert.doesNotMatch(doc, /six conjuncts|six-conjunct/i, 'the backstop paragraph must point at the ADR, not restate its conjunct list')
})

test("commands/team.md's mode bullet names the PreToolUse guard and the mode agent-tool kill switch", () => {
  const modeBulletIdx = teamDoc.indexOf("- **`mode cmux|agent-tool`**")
  assert.ok(modeBulletIdx > -1, 'expected to find the mode bullet')
  const nextBulletIdx = teamDoc.indexOf('\n- **`', modeBulletIdx + 1)
  const modeBullet = nextBulletIdx > -1 ? teamDoc.slice(modeBulletIdx, nextBulletIdx) : teamDoc.slice(modeBulletIdx)
  assert.match(modeBullet, /a PreToolUse guard \(`hooks\/dispatch-guard\.mjs`\) mechanically blocks an Agent-tool dispatch of a pane role/)
  assert.match(modeBullet, /`mode agent-tool` is the sanctioned way to turn that off/)
  assert.match(modeBullet, /makes the session's substrate truthful rather than overriding a guard/)
})

test('cmux-dispatch.md recommends --max-block-s 570 on the await join', () => {
  assert.ok(doc.includes('--max-block-s 570'))
})

test('cmux-dispatch.md instructs an explicit timeout: 600000 on the wrapping Bash call', () => {
  assert.ok(doc.includes('timeout: 600000'))
})

test('cmux-dispatch.md states the await-lock stale-threshold consequence', () => {
  assert.ok(doc.includes('await-lock stale threshold'))
})

test('the recommended 570 stays strictly under dispatch.mjs\'s own AWAIT_CAP_MAX_S clamp', () => {
  const m = dispatchSrc.match(/const AWAIT_CAP_MAX_S = (\d+)/)
  assert.ok(m, 'AWAIT_CAP_MAX_S not found in dispatch.mjs — source shape changed')
  const capMax = Number(m[1])
  assert.ok(570 < capMax, `recommended 570 must stay under AWAIT_CAP_MAX_S (${capMax})`)
})

// ---------------------------------------------------------------------------
// be-11-02 — the four hand-typed attention moments, notify/trigger-flash
// prose-only, jump-to-unread, and list-notifications.
// ---------------------------------------------------------------------------

test('cmux-dispatch.md names the four hand-typed attention moments exactly once each', () => {
  for (const moment of ['tier confirmation', 'plan approval', 'insufficiency escalation', 'gate verdict']) {
    const count = doc.split(moment).length - 1
    assert.equal(count, 1, `expected "${moment}" to appear exactly once, got ${count}`)
  }
})

test('cmux-dispatch.md states dispatch.mjs never calls notify or trigger-flash', () => {
  assert.ok(doc.includes('`dispatch.mjs` never calls `notify` or `trigger-flash`'))
})

test('cmux-dispatch.md names jump-to-unread as the user\'s hop-to-it key', () => {
  assert.ok(doc.includes("`cmux jump-to-unread` is the user's hop-to-it key"))
})

test('cmux-dispatch.md names list-notifications as the sanctioned diagnostics-only way to read notification bodies', () => {
  assert.ok(doc.includes('`cmux list-notifications`** is the sanctioned way to read notification bodies'))
})

test('cmux-dispatch.md\'s §2 verb table has rows for notify, trigger-flash, jump-to-unread, list-notifications, workspace-action set-color, set-progress, clear-progress and log', () => {
  assert.match(doc, /\| `notify --title/)
  assert.match(doc, /\| `trigger-flash/)
  assert.match(doc, /\| `jump-to-unread/)
  assert.match(doc, /\| `list-notifications`/)
  assert.match(doc, /\| `workspace-action --action set-color/)
  assert.match(doc, /\| `set-progress/)
  assert.match(doc, /\| `clear-progress/)
  assert.match(doc, /\| `log </)
})

test('cmux-dispatch.md\'s hand-typed set sentence includes notify/trigger-flash/list-notifications with the stated reason', () => {
  assert.match(doc, /hand-types only `top`, `read-screen`, `tree`, `notify`, `trigger-flash`, `list-notifications`/)
  assert.match(doc, /`notify`\/`trigger-flash`\/`list-notifications` are hand-typed for a structural reason/)
})

test('cmux-dispatch.md corrects `top`: headerless hierarchical rollup, positional refs, no --id-format, orchestrator-manual triage only', () => {
  assert.ok(doc.includes('headerless hierarchical rollup (total/window/workspace/tag/pane/surface)'))
  assert.ok(doc.includes('positional refs'))
  assert.ok(doc.includes('no `--id-format` flag') || doc.includes('no --id-format flag'))
  assert.ok(!doc.includes('per-surface CPU'), 'the stale "per-surface CPU" description must be fully removed')
})

// ---------------------------------------------------------------------------
// be-11-03 — automated stall triage doc-consistency (qa gate fix #8): the
// doc previously described read-screen as "orchestrator-manual triage
// only" and never mentioned the `attention` key or collapse-on-close at
// all, while a stale test PINNED the "hand-types only ... read-screen ..."
// sentence verbatim, passing while actively contradicting the code it
// guards. Fixed: the doc now says read-screen is ALSO auto-fired, and this
// suite asserts that correction plus the new attention-key/collapse-on-
// close passages, rather than merely pinning old prose.
// ---------------------------------------------------------------------------

test('cmux-dispatch.md corrects read-screen: no longer "hand-typed only" — dispatch.mjs also auto-fires it on the transition into attention', () => {
  assert.doesNotMatch(doc, /`read-screen` — diagnostics only, orchestrator-manual, never a result channel\./, 'the stale "orchestrator-manual, never a result channel" read-screen description must be corrected')
  assert.match(doc, /dispatch\.mjs` ALSO invokes itself/)
  assert.match(doc, /it auto-fires once per transition into attention/)
})

test('cmux-dispatch.md documents the `attention` key on both await return shapes and on status', () => {
  assert.match(doc, /attention: \[\{dispatch_id, since, reason: 'quiet_after_turn_end'\}\]/)
  assert.match(doc, /a dispatch listed there is STILL in `remaining` and NEVER in `resolved`/)
  assert.match(doc, /`status` reports the same `attention` array from its own independent events read/)
})

test('cmux-dispatch.md documents collapse-on-close and its accepted cost, no longer claiming the terminal surface is unconditionally kept', () => {
  assert.match(doc, /\*\*Collapse-on-close \(be-11-03\):\*\*/)
  assert.match(doc, /re-verifies .* that a sibling doc-tab surface actually exists/)
  assert.match(doc, /Accepted cost:\*\* once collapsed, the doc tab can never be re-mounted/)
})

// ---------------------------------------------------------------------------
// be-12-03 (issue #12/D5, ADR-019) — browser-verify doc footprint. Every
// assertion below is a NEW doc-pin, observed red before its corresponding
// doc edit landed (backend-notes.md RED-FIRST doctrine).
// ---------------------------------------------------------------------------

test('cmux-dispatch.md §1 documents the browser preview singleton, browser-verify as a separate read-only consumer, and the state save|load non-goal', () => {
  assert.match(doc, /browser preview singleton/i)
  assert.match(doc, /is a SEPARATE, orchestrator-invoked, read-only consumer/)
  assert.match(doc, /`browser state save`\/`state load`, `snapshot`, and any interaction\/eval sub-verb are named non-goals/)
})

// fix-round-2 (F1, live-pass-findings.md): the real grammar is surface-FIRST
// (`browser <surface> goto|wait|errors clear|errors list|screenshot ...`);
// `browser open ...` is the sole surface-less form. The old sub-verb-first
// pin (`browser open\|goto\|wait\|errors clear\|list\|screenshot <surface>`)
// documented a live-falsified grammar and must not survive anywhere.
test('cmux-dispatch.md §2 has a `browser <sub>` verb-table row naming the `complete` literal and the js_error/navigation_timeout shapes', () => {
  assert.match(doc, /\| `browser <surface> goto\\?\|wait\\?\|errors clear\\?\|errors list\\?\|screenshot/)
  assert.match(doc, /`browser open \.\.\.` is the sole surface-less form/)
  assert.match(doc, /--load-state complete/)
  assert.match(doc, /`js_error`/)
  assert.match(doc, /`navigation_timeout`/)
})

// fix-round-2 re-confirmation Consider: the positive row pin above cannot
// catch a stale second row or prose that reintroduces the live-falsified
// sub-verb-first order somewhere else in the doc — pin its absence.
test('the live-falsified sub-verb-first grammar (`browser goto|wait|errors|screenshot <surface>`) survives nowhere in cmux-dispatch.md', () => {
  assert.doesNotMatch(doc, /browser (goto|wait|errors clear|errors list|screenshot) <surface>/)
})

// fix-round-2 re-confirmation Consider (F2): the close-surface row must warn
// that browser surfaces refuse it and name the working command.
// be-76-02: Ambiguity trap becomes per-file (project vs home config.md),
// not a single-file rule. Pin the new wording and assert the old
// single-file phrasing survives nowhere in the doc.
test('cmux-dispatch.md\'s Ambiguity trap is per-file: each layer (project/home) evaluated separately, one line in each is not ambiguous', () => {
  assert.match(doc, /\*\*Ambiguity trap \(per file, be-76\):\*\*/)
  assert.match(doc, /evaluated SEPARATELY, never across the pair/)
  assert.match(doc, /is NOT ambiguous: the project line governs and the home file is not even read/)
  assert.match(doc, /makes THAT file ambiguous/)
})

test('the old single-file Ambiguity trap phrasing ("must contain exactly one execution_mode: line") survives nowhere in cmux-dispatch.md', () => {
  assert.doesNotMatch(doc, /must contain exactly one `execution_mode:` line/)
})

test('cmux-dispatch.md close-surface row carries the browser-surface caveat naming `browser <id> tab close`', () => {
  const row = doc.slice(doc.indexOf('| `close-surface --surface <id> --window <id>`'))
  const rowText = row.slice(0, row.indexOf('\n'))
  assert.match(rowText, /refuses a BROWSER surface/)
  assert.match(rowText, /`browser <id> tab close`/)
})

// S14 (panel-3 #10, fix-round): the assertions above are doc-wide, so a
// mutation moving these literals into an unrelated part of the doc would
// still pass. Slice the `browser <sub>` §2 row itself first (model: the
// qa-gate doc-test's section slicing, :141-160 above) and assert within it.
function browserRowText() {
  const rowStart = doc.indexOf('| `browser <surface>')
  assert.ok(rowStart > -1, 'expected to find the browser <sub> §2 row')
  const rowEnd = doc.indexOf('\n', rowStart)
  return doc.slice(rowStart, rowEnd === -1 ? doc.length : rowEnd)
}

test('S14: the `browser <sub>` §2 row, SLICED to just that row, contains --load-state complete, js_error and navigation_timeout', () => {
  const row = browserRowText()
  assert.match(row, /--load-state complete/)
  assert.match(row, /`js_error`/)
  assert.match(row, /`navigation_timeout`/)
})

// S16 (panel-3 #12): navigation_timeout must attribute to `goto` specifically
// within that same sliced row — not to `wait`/`errors` (both of which only
// ever degrade with js_error).
test('S16: within the sliced browser row, navigation_timeout is attributed to `goto`, not `wait`/`errors`', () => {
  const row = browserRowText()
  assert.match(row, /`goto`.*degrades with `navigation_timeout`/)
  assert.doesNotMatch(row, /both `wait`\/`errors` degrade with cmux-authored codes `js_error`.*or `navigation_timeout`/, 'the old ambiguous phrasing (implying wait/errors can also produce navigation_timeout) must not survive')
})

function browserSingletonParagraph() {
  const start = doc.indexOf('**Browser preview singleton')
  assert.ok(start > -1, 'expected to find the §1 browser preview singleton paragraph')
  const end = doc.indexOf('\n\n', start)
  return end > -1 ? doc.slice(start, end) : doc.slice(start)
}

// S14 (continued) + S16 (panel-3 #13): the §1 'browser preview singleton'
// paragraph, section-scoped, must name all THREE preview outcomes.
test('S14/S16: the §1 browser-preview-singleton paragraph, SLICED to just that paragraph, names all three outcomes: reuse, create, fail-closed skip', () => {
  const para = browserSingletonParagraph()
  assert.match(para, /\breuses\b/)
  assert.match(para, /\bcreates\b/)
  assert.match(para, /fail-closed skip/)
})

test('cmux-dispatch.md §2 footer states why the browser family is not capabilities-gated, mirroring the new-surface row\'s own wording', () => {
  assert.match(doc, /\*\*The `browser` family is NOT capabilities-gated\*\*/)
  assert.match(doc, /unverifiable-by-capabilities/)
})

test('cmux-dispatch.md documents rename-tab as terminal-surfaces-only', () => {
  assert.match(doc, /rename-tab --surface <surface> -- <title>` \| sets the `\{agent type\} \(\{model\}\)` tab title; terminal surfaces only/)
})

test('cmux-dispatch.md never adds browser-verify to the lifecycle-order line', () => {
  const lifecycleLine = doc.split('\n').find((l) => l.includes('Lifecycle order, per the CLI header block'))
  assert.ok(lifecycleLine, 'expected to find the lifecycle-order line')
  assert.doesNotMatch(lifecycleLine, /browser-verify/)
})

test('cmux-dispatch.md teardown-order line names --outcome, its default, and the --keep-artifacts override', () => {
  const teardownOrderLine = doc.split('\n').find((l) => l.includes('Teardown order at ship'))
  assert.ok(teardownOrderLine, 'expected to find the teardown-order line')
  assert.match(teardownOrderLine, /--outcome <ok\|refused>/)
  assert.match(teardownOrderLine, /defaults to `ok`/)
  assert.match(teardownOrderLine, /`refused` archives instead of deleting/)
  assert.match(teardownOrderLine, /--keep-artifacts` forces archival regardless of `--outcome`/)
})

test('qa-gate.md: the browser-verify gate-adjunct section states "screenshot captured", the <= 90s budget, origin-only, dev/staging-only credentials, the white-PNG/clean-on-never-loaded caveat, that this is evidence never a verdict input, and the preview.reason cross-read rule', () => {
  const start = qaGateDoc.indexOf('## An optional gate adjunct: browser-verify evidence')
  assert.ok(start > -1, 'expected to find the browser-verify gate-adjunct section heading')
  const nextHeading = qaGateDoc.indexOf('\n## ', start + 1)
  const section = nextHeading > -1 ? qaGateDoc.slice(start, nextHeading) : qaGateDoc.slice(start)

  assert.ok(section.includes('screenshot captured'))
  assert.doesNotMatch(section, /renders correctly/)
  assert.doesNotMatch(section, /the app works/)
  assert.doesNotMatch(section, /\bverified\b/)
  assert.match(section, /<= ?90 ?0?0?0? ?ms|<= ?90s/)
  assert.match(section, /origin-only|scheme:\/\/host/)
  assert.match(section, /dev\/staging accounts only, never production or admin credentials/)
  assert.match(section, /blank\/white PNG is a REACHABLE outcome/)
  assert.match(section, /clean:true, count:0.*never-loaded page is equally reachable|never-loaded page is equally reachable/)
  assert.match(section, /This is evidence, never a verdict input/)
  assert.match(section, /parsed `\{verdict, findings\}` enum alone/)
  assert.match(section, /preview\.reason/)
  assert.match(section, /preview_lock_contended.*preview_surface_ambiguous.*preview_topology_unverifiable.*preview_double_create_detected.*preview_landed_in_worker_pane/)
})

test('qa-gate.md: the browser-verify section never introduces a `:!` pathspec token and never quotes a glob-looking example (noise-globs.test.mjs pins the noise section as the only home for both)', () => {
  const start = qaGateDoc.indexOf('## An optional gate adjunct: browser-verify evidence')
  const nextHeading = qaGateDoc.indexOf('\n## ', start + 1)
  const section = nextHeading > -1 ? qaGateDoc.slice(start, nextHeading) : qaGateDoc.slice(start)
  assert.doesNotMatch(section, /:!/)
  assert.doesNotMatch(section, /\*\.[a-z]+/)
})

test('commands/onboard.md and .claude/dev-team/config.md document cmux_preview_url (bare top-level line for consumers; unset in this repo) plus the dev/staging-credentials line', () => {
  const onboardDoc = readFileSync(join(ROOT, 'commands', 'onboard.md'), 'utf8')
  const configDoc = readFileSync(join(ROOT, '.claude', 'dev-team', 'config.md'), 'utf8')
  assert.match(onboardDoc, /cmux_preview_url/)
  assert.match(configDoc, /cmux_preview_url/)
  // S15 (panel-3 #11, fix-round): the dev/staging-credentials line is a D6
  // requirement on BOTH docs, not just config.md.
  assert.match(onboardDoc, /dev\/staging accounts only, never production or admin credentials/)
  assert.match(configDoc, /dev\/staging accounts only, never production or admin credentials/)
  // THIS REPO'S KEY STAYS UNSET: never a bare top-level `cmux_preview_url:` line.
  assert.doesNotMatch(onboardDoc, /^cmux_preview_url:/m)
  assert.doesNotMatch(configDoc, /^cmux_preview_url:/m)
})

// M4 (panel-3 #1, fix-round): onboard.md's cmux_preview_url bullet must not
// tell the onboarding agent to keep the key fenced/bulleted in the CONSUMER
// project's own config — a real project enabling the preview writes
// cmux_preview_url as its own bare top-level line (same shape as
// execution_mode: above), and it is only THIS PLUGIN REPO's own config.md
// that deliberately leaves the key unset.
test('M4: commands/onboard.md instructs a CONSUMER project to write cmux_preview_url as its own bare top-level line, same shape as execution_mode:, and names this repo\'s own unset choice as a separate case', () => {
  const onboardDoc = readFileSync(join(ROOT, 'commands', 'onboard.md'), 'utf8')
  assert.match(onboardDoc, /writes `cmux_preview_url:` as its own bare top-level line/)
  assert.match(onboardDoc, /exactly the same shape as `execution_mode:`/)
  assert.match(onboardDoc, /This plugin repo's own `\.claude\/dev-team\/config\.md` .* deliberately leaves the key unset/)
})

// test-engineer (be-12-03 adversarial pass, AC "NO BARE KEY LEAKS INTO THIS
// REPO'S OWN CONFIG"): the two assertions above only pin the regex the doc
// text must avoid — they never run this repo's own config.md through the
// REAL parser, so a doc edit that satisfies the regex by accident (or a
// future regex/parser drift between PREVIEW_URL_LINE_RE and this test) would
// go undetected. Call the actual function the AC names.
test('readCmuxPreviewUrl(config.md) is null for this repo\'s own, deliberately-unset config — the real parser, not just a regex pin', () => {
  const configDoc = readFileSync(join(ROOT, '.claude', 'dev-team', 'config.md'), 'utf8')
  assert.equal(readCmuxPreviewUrl(configDoc), null)
})

// S3 (panel-3 #8, fix-round): `preview_capability_missing` is not a real
// enum member anywhere (the capability gate was removed entirely, be-12-02
// fix-round item 1) — pin its absence so a future edit never reintroduces
// it in code OR in either doc that documents the dispatch-time enum.
test('S3: preview_capability_missing appears in NEITHER dispatch.mjs, qa-gate.md, NOR cmux-dispatch.md', () => {
  assert.doesNotMatch(dispatchSrc, /preview_capability_missing/)
  assert.doesNotMatch(qaGateDoc, /preview_capability_missing/)
  assert.doesNotMatch(doc, /preview_capability_missing/)
})

// S1 (panel-3 #5, fix-round): qa-gate.md names the three gate-time enum
// members beside the five dispatch-time members, each with a one-clause
// meaning.
test('S1: qa-gate.md names all three gate-time enum members (preview_disabled | no_preview_recorded | preview_surface_gone) with one-clause meanings', () => {
  assert.match(qaGateDoc, /gate-time enum is closed at three members/)
  for (const member of ['preview_disabled', 'no_preview_recorded', 'preview_surface_gone']) {
    assert.match(qaGateDoc, new RegExp('`' + member + '`\\s*\\('), `expected a one-clause meaning for ${member}`)
  }
})

// M6 (panel-3 #3, fix-round): the duplicate-key behavior SPLIT — browser
// -verify refuses loudly (exit 1) while dispatch degrades to no-preview —
// and the fenced-duplicate parenthetical corrected (a fenced line is
// stripped before matching, so it can never contribute to ambiguity).
test('M6: config.md states the duplicate-key split (browser-verify refuses, dispatch degrades) and that a fenced line is stripped before matching', () => {
  const configDoc = readFileSync(join(ROOT, '.claude', 'dev-team', 'config.md'), 'utf8')
  assert.match(configDoc, /browser-verify` refuses loudly \(exit 1/)
  assert.match(configDoc, /dispatch`'s preview trigger reads it inside a try\/catch and DEGRADES to no-preview/)
  assert.match(configDoc, /a fenced line is STRIPPED before matching/)
})

// M7 (panel-3 #4, fix-round): the exposure sentence counts THREE full-URL
// sites (config line, browser open's argv, browser goto's argv) — no
// surviving "exactly two places" claim anywhere in the diff set.
test('M7: config.md\'s exposure sentence names THREE full-URL sites, and no "exactly two places" claim survives in config.md, cmux-dispatch.md, qa-gate.md, or dispatch.mjs itself', () => {
  const configDoc = readFileSync(join(ROOT, '.claude', 'dev-team', 'config.md'), 'utf8')
  assert.match(configDoc, /exactly THREE places/)
  assert.match(configDoc, /`browser open`'s argv \(dispatch-time, `dispatch\.mjs:1125`/)
  assert.match(configDoc, /`browser goto`'s argv \(gate-time/)
  for (const text of [configDoc, doc, qaGateDoc, dispatchSrc]) {
    assert.doesNotMatch(text, /exactly two places/)
  }
})
