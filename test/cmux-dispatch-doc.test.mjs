import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'

const doc = readFileSync(join(ROOT, 'references/cmux-dispatch.md'), 'utf8')
const dispatchSrc = readFileSync(join(ROOT, 'scripts/cmux/dispatch.mjs'), 'utf8')

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
