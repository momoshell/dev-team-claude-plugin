import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'

const cmds = readdirSync(join(ROOT, 'commands')).filter((f) => f.endsWith('.md'))

test('there is at least one command', () => assert.ok(cmds.length > 0))

for (const f of cmds) {
  test(`command ${f}: has a frontmatter description`, () => {
    const md = readFileSync(join(ROOT, 'commands', f), 'utf8')
    const m = md.match(/^---\n([\s\S]*?)\n---/)
    assert.ok(m, 'has a frontmatter block')
    assert.match(m[1], /description:\s*\S/, 'has a non-empty description')
  })
}

test('command team.md: documents the mode verb', () => {
  const md = readFileSync(join(ROOT, 'commands', 'team.md'), 'utf8')
  assert.match(md, /mode cmux\|agent-tool/)
})

test('command team.md: frontmatter description lists mode', () => {
  const md = readFileSync(join(ROOT, 'commands', 'team.md'), 'utf8')
  const m = md.match(/^---\n([\s\S]*?)\n---/)
  assert.ok(m, 'has a frontmatter block')
  assert.match(m[1], /description:.*\bmode\b/)
})

test('command team.md: documents the roster verb', () => {
  const md = readFileSync(join(ROOT, 'commands', 'team.md'), 'utf8')
  assert.match(md, /roster <role>=<agent>:<model>/)
  assert.match(md, /--config/)
})

test('command team.md: frontmatter description lists roster', () => {
  const md = readFileSync(join(ROOT, 'commands', 'team.md'), 'utf8')
  const m = md.match(/^---\n([\s\S]*?)\n---/)
  assert.ok(m, 'has a frontmatter block')
  assert.match(m[1], /description:.*\broster\b/)
})

test('command team.md: workflow carve-out states cmux panes are conversational-only', () => {
  const md = readFileSync(join(ROOT, 'commands', 'team.md'), 'utf8')
  const m = md.match(/workflow <goal>[\s\S]*?(?=\n- \*\*|$)/)
  assert.ok(m, 'has a workflow bullet')
  assert.match(m[0], /agent\(\)/)
  assert.match(m[0], /conversational/)
})

test('command ship.md: teardown step is ordered between task-source update and report', () => {
  const md = readFileSync(join(ROOT, 'commands', 'ship.md'), 'utf8')
  const iTask = md.indexOf('Update the task source')
  const iTeardown = md.indexOf('dispatch.mjs" teardown')
  const iReport = md.indexOf('**Report**')
  assert.notEqual(iTask, -1, 'task-source step anchor missing')
  assert.notEqual(iTeardown, -1, 'teardown invocation anchor missing')
  assert.notEqual(iReport, -1, 'report step anchor missing')
  assert.ok(iTask < iTeardown, 'teardown must follow the task-source step')
  assert.ok(iTeardown < iReport, 'teardown must precede the report step')
})

function teardownStep(md) {
  const iTeardown = md.indexOf('Tear down the cmux session')
  const iReport = md.indexOf('**Report**')
  assert.notEqual(iTeardown, -1, 'teardown step anchor missing')
  assert.notEqual(iReport, -1, 'report step anchor missing')
  return md.slice(iTeardown, iReport)
}

test('command ship.md: teardown is gated on cmux mode', () => {
  const md = readFileSync(join(ROOT, 'commands', 'ship.md'), 'utf8')
  const step = teardownStep(md)
  assert.match(step, /skip/i)
  assert.match(step, /agent-tool/)
  assert.match(step, /absent/)
})

test('command ship.md: documents keep_task_artifacts -> --keep-artifacts and always-archive-on-failure', () => {
  const md = readFileSync(join(ROOT, 'commands', 'ship.md'), 'utf8')
  const step = teardownStep(md)
  assert.match(step, /keep_task_artifacts/)
  assert.match(step, /--keep-artifacts/)
  assert.match(step, /archiv/i)
})

test('command ship.md: reports leftover_worktrees and never force-removes', () => {
  const md = readFileSync(join(ROOT, 'commands', 'ship.md'), 'utf8')
  const step = teardownStep(md)
  assert.match(step, /leftover_worktrees/)
  assert.match(step, /never\s+`?--force/i)
})

test('command ship.md: refuses to guess a task slug for teardown', () => {
  const md = readFileSync(join(ROOT, 'commands', 'ship.md'), 'utf8')
  const step = teardownStep(md)
  assert.match(step, /never guess/i)
})

test('command onboard.md: checks cmux as a prerequisite and sets execution_mode', () => {
  const md = readFileSync(join(ROOT, 'commands', 'onboard.md'), 'utf8')
  assert.match(md, /command -v cmux/)
  assert.match(md, /cmux ping/)
  assert.match(md, /execution_mode: cmux/)
  assert.match(md, /execution_mode: agent-tool/)
  assert.equal(/execution_mode:\s*subagent/.test(md), false)
})

test('command onboard.md: step 5 lists the four new config keys', () => {
  const md = readFileSync(join(ROOT, 'commands', 'onboard.md'), 'utf8')
  assert.match(md, /execution_mode:/)
  assert.match(md, /keep_task_artifacts:/)
  assert.match(md, /noise_globs:/)
  assert.match(md, /cmux_preview_url/)
})

test('command pr-review.md: respond mode treats a wont-fix/disagreed-shaped disposition reply as settled, but a fixed-shaped reply still needs light verification', () => {
  const md = readFileSync(join(ROOT, 'commands', 'pr-review.md'), 'utf8')
  assert.match(md, /closed 5-shape enum/)
  assert.match(md, /wont-fix`\/`disagreed`-shaped reply, from the PR author, settles the thread — skip it/)
  assert.match(md, /reviewer replied again \*after\* that reply/)
  assert.match(md, /genuinely new evidence.*reopen it and say what's new/)
  assert.match(md, /fixed \(<hash>\)`-shaped reply from the PR author is NOT settled the same way/)
  assert.match(md, /never simply skipped on sight/)
})

test('command pr-review.md: a disposition reply must also be FROM THE PR AUTHOR, not just shape-matched', () => {
  const md = readFileSync(join(ROOT, 'commands', 'pr-review.md'), 'utf8')
  assert.match(md, /Shape alone is never enough — the reply must also be FROM THE PR AUTHOR/)
  assert.match(md, /compare the comment's `author\.login` against the PR author fetched in step 1/)
  assert.match(md, /posted by anyone else \(a bot, a third party, even the reviewer replying to their own thread\) is not a disposition reply and does not settle the thread/)
})

test('command pr-review.md: open never settles a thread; deferred requires the same authorship check and is not permanently settled', () => {
  const md = readFileSync(join(ROOT, 'commands', 'pr-review.md'), 'utf8')
  assert.match(md, /`open` never settles a thread — it's the opposite of settled/)
  assert.match(md, /triage the thread normally, the same as if no disposition reply existed at all/)
  assert.match(md, /`deferred \(issue #N\)`, on a thread flagging what would be a `\[blocking\]`-severity concern, requires the same PR-author-authorship check as any other disposition above/)
  assert.match(md, /don't treat it as permanently settled the way `wont-fix`\/`disagreed` are/)
})

test('command pr-review.md: the 5-shape enum is stated as the same five dispositions as qa-gate.md, without the (user) marker, and why', () => {
  const md = readFileSync(join(ROOT, 'commands', 'pr-review.md'), 'utf8')
  assert.match(md, /the same five dispositions as `references\/qa-gate\.md`'s carry-forward table, spelled without the `\(user\)` marker because GitHub's own comment authorship supplies that verification here/)
})

test('command pr-review.md: the speculative-drop rule states it runs second, not first, on the panel path', () => {
  const md = readFileSync(join(ROOT, 'commands', 'pr-review.md'), 'utf8')
  assert.match(md, /this drop rule runs second, not first/)
  assert.match(md, /independently-scoped for different situations/)
})

test('command pr-review.md: the reviewThreads query fetches the NEWEST comments', () => {
  const md = readFileSync(join(ROOT, 'commands', 'pr-review.md'), 'utf8')
  assert.match(md, /comments\(last:/)
  assert.equal(/comments\(first:/.test(md), false)
})

test('command onboard.md: seeds the project roster', () => {
  const md = readFileSync(join(ROOT, 'commands', 'onboard.md'), 'utf8')
  assert.match(md, /roster\.default\.json/)
  assert.match(md, /\.claude\/dev-team\/roster\.json/)
})
