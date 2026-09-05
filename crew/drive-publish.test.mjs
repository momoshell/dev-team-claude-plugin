// Split from crew/drive.test.mjs (#918 follow-up): one subject per file so a
// lane fencing one driver concern no longer locks every driver test.
// Shared fixtures, and the ledger sandbox side effect, live in ./drive-fixtures.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMMIT_TRAILER, HONEST_NARRATION, NARRATION_HEADING, NARRATION_RECORD, NARRATION_REFUSALS, NARRATION_REFUSAL_NAMES, NARRATION_STAGE_VOCABULARY, NARRATOR_REGISTER, PUBLISH_REFUSAL_NAMES, RUN_START_EVENT, TD, VARIANTS, applyNarration, bounceDetail, bounceSeatOf, commitIntent, composeCommitMessage, composePrBody, convergeRun, issueTrailers, join, journalRowsSinceRunStart, narrateRecord, narrationDefect, narrationIsRawJson, narrationPrompt, narrationStageDefect, narratorApiRoot, narratorIo, narratorModelId, narratorModelsCommand, planEnv, prAnomalies, readFileSync, refsFromCommitMessage, runPublished, shellArg,
} from './drive-fixtures.mjs'

test('RV1-1 the observe-and-end residual reaches the commit and PR intent verbatim', () => {
  const residual = "The lane observes and ends a forbidden suite invocation only after it starts; it does not return a tool result to the seat, so #904's tool-result contract remains correctness-unverified."
  const body = `Account JSON policy calls flushed during termination grace without losing the first refusal\n\n${residual}`
  const message = composeCommitMessage({
    task: 'rpcpolicy',
    planEnv: { summary: 'ignored', details: { commit_subject: 'fix(crew): account suite policy calls', issues: [904] } },
    builderEnv: { summary: 'ignored', details: { commit_message: body } },
  })
  assert.equal(message, `fix(crew): account suite policy calls\n\n${body}\n\nRefs: #904`)
  assert.equal(commitIntent(message), body)
  const pr = composePrBody({ intent: commitIntent(message), issues: ['#904'] })
  assert.equal(pr.slice(0, `${body}\n\nRefs #904`.length), `${body}\n\nRefs #904`)
})

test('converge happy path files must-fix residuals, commits once, and opens one draft PR', () => {
  const { io, result } = convergeRun()
  assert.equal(result.status, 'converge')
  assert.equal(io.calls.gh.filter((call) => call.method === 'createDraftPr').length, 1)
  assert.equal(io.calls.gh.filter((call) => call.method === 'createIssue').length, 1)
  assert.equal(io.calls.commits.length, 1)
  assert.equal(result.details.converge.draft, true)
  assert.equal(result.details.converge.issues.length, 1)
  assert.ok(io.calls.gh.find((call) => call.method === 'createDraftPr').args.body.includes(String(result.details.converge.issues[0].number)))
})

test('converge PR title and body are byte-stable through two identical seams', () => {
  const first = convergeRun()
  const second = convergeRun()
  const pr1 = first.io.calls.gh.find((call) => call.method === 'createDraftPr').args
  const pr2 = second.io.calls.gh.find((call) => call.method === 'createDraftPr').args
  assert.equal(pr1.title, pr2.title)
  assert.equal(pr1.body, pr2.body)
})

test('a red suite parks before any issue, PR, or commit side effect', () => {
  const { io, result } = convergeRun({ suite: { ok: false, output: 'suite red' } })
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.gh.length, 0)
  assert.equal(io.calls.commits.length, 0)
})

test('PR creation failure escalates while retaining the commit hash', () => {
  const { io, result } = convergeRun({ prThrows: 'draft PR failed' })
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.commits.length, 1)
  assert.equal(result.details.commit, 'abc1234')
  assert.match(result.details.escalation.why, /abc1234/)
  assert.deepEqual(result.details.converge.pr, null)
})

test('the converge seam exposes only issue creation and draft PR creation', () => {
  const { io } = convergeRun()
  assert.deepEqual(io.calls.gh.map((call) => call.method).sort(), ['createDraftPr', 'createIssue'])
  const source = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8')
  for (const banned of [/ready-for-review/, /ready_for_review/, /['\"]gh (pr|issue)/, /node:child_process/, /\bexecSync\s*\(/, /\bspawnSync\s*\(/]) {
    assert.equal(banned.test(source), false, `unexpected direct seam path ${banned}`)
  }
})

test('armed happy path records commit, rebase, warm/cold suites, publish, and done in order', () => {
  const { result, io } = runPublished({})
  assert.equal(result.status, 'done')
  const at = result.details.stages.indexOf('commit')
  assert.deepEqual(result.details.stages.slice(at), ['commit', 'rebase', 'suite', 'suite:cold', 'publish', 'done'])
  assert.equal(io.calls.suiteHead, io.state.post)
  assert.equal(io.calls.coldHead, io.state.post)
  assert.equal(result.details.commit, io.state.post)
  assert.deepEqual(result.details.pr, { url: 'https://github.com/o/r/pull/42', number: 42, head: 'feature/ship', base_sha: 'base1111' })
  const row = io.calls.logs.find((entry) => entry.published)
  assert.ok(row)
  for (const key of ['rebase', 'push', 'pr_create']) assert.equal(Number.isFinite(row.published.durations_ms[key]), true)
})

test('stateful moved and unmoved bases prove the exact rebase policy', () => {
  const moved = runPublished({})
  assert.equal(moved.result.status, 'done')
  assert.equal(moved.io.calls.run.includes('git rebase origin/main'), true)
  assert.equal(moved.io.calls.suiteHead, moved.io.state.post)
  const unmoved = runPublished({
    commands: {
      'git rev-parse origin/main': { ok: true, output: 'same1111\n' },
      'git merge-base HEAD origin/main': { ok: true, output: 'same1111\n' },
    },
  })
  assert.equal(unmoved.result.status, 'done')
  assert.equal(unmoved.io.calls.run.includes('git rebase origin/main'), false)
  assert.equal(unmoved.io.calls.logs.find((entry) => entry.published).published.rebased, false)
  assert.equal(unmoved.result.details.commit, unmoved.io.state.pre)
})

test('post-commit fetch, push, and warm-suite failures are deliberate escalations with the real commit', () => {
  const failedFetch = runPublished({ commands: { 'git fetch origin main': { ok: false, output: 'network down' } } })
  assert.equal(failedFetch.result.status, 'escalation')
  assert.equal(failedFetch.result.details.escalation.where, 'rebase')
  assert.equal(failedFetch.result.details.commit, failedFetch.io.state.pre)
  const failedPush = runPublished({ commands: { 'git push -u origin': { ok: false, output: 'rejected' } } })
  assert.equal(failedPush.result.status, 'escalation')
  assert.equal(failedPush.result.details.escalation.where, 'publish')
  assert.equal(failedPush.result.details.commit, failedPush.io.state.post)
  const redWarm = runPublished({ commands: { 'suite-cmd': { ok: false, output: 'boom' } } })
  assert.equal(redWarm.result.status, 'escalation')
  assert.equal(redWarm.result.details.escalation.where, 'suite')
  assert.equal(redWarm.result.details.commit, redWarm.io.state.post)
  for (const run of [failedFetch, failedPush, redWarm]) assert.notEqual(run.result.details.escalation.where, 'driver')
})

test('failed and blank rebase probes, post-head probes, empty conflicts, and restoration failures fail closed', () => {
  const probes = [
    { commands: { 'git rev-parse origin/main': { ok: false, output: 'missing' } } },
    { commands: { 'git rev-parse origin/main': { ok: true, output: '' } } },
    { commands: { 'git merge-base HEAD origin/main': { ok: false, output: 'missing' } } },
    { commands: { 'git merge-base HEAD origin/main': { ok: true, output: '' } } },
    { commands: { 'git rev-parse HEAD': { ok: false, output: 'missing' } } },
    { commands: { 'git rev-parse HEAD': { ok: true, output: '' } } },
  ]
  for (const options of probes) {
    const run = runPublished(options)
    assert.equal(run.result.status, 'escalation')
    assert.equal(run.result.details.escalation.where, 'rebase')
    assert.equal(run.io.calls.run.some((command) => command.startsWith('git push')), false)
  }
  const emptyConflict = runPublished({ commands: {
    'git rebase origin/main': (state) => { state.head = 'mid3333'; return { ok: false, output: 'rebase failed' } },
    'git diff --name-only --diff-filter=U': { ok: true, output: '' },
    'git rebase --abort': (state) => { state.head = state.pre; return { ok: true, output: '' } },
  } })
  assert.equal(emptyConflict.result.status, 'escalation')
  assert.doesNotMatch(emptyConflict.result.details.escalation.why, /conflict/i)
  const failedAbort = runPublished({ commands: {
    'git rebase origin/main': (state) => { state.head = 'mid3333'; return { ok: false, output: 'rebase failed' } },
    'git diff --name-only --diff-filter=U': { ok: true, output: 'a.mjs\n' },
    'git rebase --abort': { ok: false, output: 'abort failed' },
    'git rev-parse HEAD': (state) => ({ ok: true, output: `${state.head}\n` }),
  } })
  assert.equal(failedAbort.result.status, 'escalation')
  assert.match(failedAbort.result.details.escalation.why, /UNPROVEN/)
  assert.match(failedAbort.result.details.escalation.why, /mid3333/)
  const wrongHead = runPublished({ commands: {
    'git rebase origin/main': (state) => { state.head = 'mid3333'; return { ok: false, output: 'rebase failed' } },
    'git diff --name-only --diff-filter=U': { ok: true, output: 'a.mjs\n' },
    'git rebase --abort': { ok: true, output: '' },
    'git rev-parse HEAD': { ok: true, output: 'other4444\n' },
  } })
  assert.equal(wrongHead.result.status, 'escalation')
  assert.match(wrongHead.result.details.escalation.why, /UNPROVEN/)
  assert.match(wrongHead.result.details.escalation.why, /other4444/)
})

test('each closed publish refusal is named and never creates a pull request', () => {
  const cases = [
    ['branch-unresolved', { branch: '' }],
    ['branch-main', { branch: 'main' }],
    ['gh-missing', { commands: { 'command -v gh': { ok: false, output: '' } } }],
    ['gh-auth', { commands: { 'gh auth status': { ok: false, output: 'not logged in' } } }],
    ['pr-exists', { commands: { 'gh pr view': { ok: true, output: 'not json' } } }],
    ['pr-check', { commands: { 'gh pr view': { ok: false, output: 'permission denied' } } }],
    ['push-rejected', { commands: { 'git push -u origin': { ok: false, output: 'rejected' } } }],
    ['pr-create', { commands: { 'gh pr create': { ok: true, output: 'created but URL omitted' } } }],
  ]
  assert.deepEqual(new Set(cases.map(([reason]) => reason)), new Set(PUBLISH_REFUSAL_NAMES))
  for (const [reason, options] of cases) {
    const run = runPublished(options)
    assert.equal(run.result.status, 'escalation', reason)
    assert.equal(run.result.details.escalation.where, 'publish', reason)
    assert.match(run.result.details.escalation.why, new RegExp(reason), reason)
    assert.equal(run.result.details.publish.refused, reason)
    assert.equal(run.result.details.pr, undefined, reason)
    if (reason !== 'pr-create') assert.equal(run.io.calls.run.some((command) => command.startsWith('gh pr create')), false, reason)
  }
})

test('all branch and task paths are shellArg quoted in publication commands', () => {
  const branch = "feat/'$HOME; echo pwn `x` with spaces"
  const taskDir = "/tmp/task/'$HOME; echo pwn with spaces"
  const run = runPublished({ branch, taskDir })
  assert.equal(run.result.status, 'done')
  const commands = run.io.calls.run
  const quotedBranch = shellArg(branch)
  assert.ok(commands.some((command) => command.includes(`git push -u origin ${quotedBranch}`)))
  assert.ok(commands.some((command) => command.includes(`gh pr view ${quotedBranch}`)))
  const body = shellArg(`${taskDir}/pr-body.md`)
  assert.ok(commands.some((command) => command.includes(`--body-file ${body}`)))
})

test('an exit-zero malformed PR probe, indeterminate probe, and throwing journal read all fail or publish safely', () => {
  const malformed = runPublished({ commands: { 'gh pr view': { ok: true, output: '{not-json}' } } })
  assert.equal(malformed.result.details.publish.refused, 'pr-exists')
  const indeterminate = runPublished({ commands: { 'gh pr view': { ok: false, output: 'gh service unavailable' } } })
  assert.equal(indeterminate.result.details.publish.refused, 'pr-check')
  const throwingRead = runPublished({ readFileThrows: true })
  assert.equal(throwingRead.result.status, 'done')
  assert.ok(throwingRead.io.calls.writes[`${TD}/pr-body.md`])
})

test('composePrBody is pure and renders every populated section with its own values', () => {
  const record = {
    issues: ['#679', '#758'], stages: ['commit', 'rebase', 'suite', 'publish', 'done'],
    cursor: { plan_round: 4, build_round: 5, review_round: 6 },
    gate: { cmd: 'gate-cmd', summary: { total: 2, failed: 0, errored: 0 }, discrimination: 'proven', repairs: 1 },
    review: { verdict: 'changes-needed', residuals: [{ id: 'R1', type: 'cosmetic', summary: 'leave this note' }] },
    suite: { warm: { pass: 11, fail: 2, skipped: 3 }, cold: { pass: 13, fail: 4, skipped: 5 }, cold_verified: true },
    intent: 'why the lane existed', closes: ['#806'], files: ['crew/drive.mjs'],
    anomalies: [{ kind: 'bounce', detail: 'retry' }],
  }
  const first = composePrBody(record)
  const second = composePrBody(JSON.parse(JSON.stringify(record)))
  assert.equal(first, second)
  assert.equal(first, [
    'why the lane existed',
    'Closes #806\nRefs #679, #758',
    '**2 gate checks, 0 failed, 0 errored, discrimination proven** (gate-cmd), repaired 1 time.',
    'Suite warm 11 pass / 2 fail / 3 skip; cold 13 pass / 4 fail / 5 skip, cold-verified from a fresh checkout.',
    'Review: changes-needed, 1 residual:\n- R1 (cosmetic): leave this note',
    'Changed: crew/drive.mjs',
    'Shape: commit → rebase → suite → publish',
    '- bounce: retry',
  ].join('\n\n'))
  assert.doesNotMatch(first, /\n{3,}/)
  const sparse = composePrBody({ closes: ['#806'] })
  assert.equal(sparse, [
    'Closes #806',
    'No acceptance gate ran.',
    'Suite counts: not measured.',
    'Review: not recorded, no residuals',
  ].join('\n\n'))
  for (const token of ['why the lane existed', 'Closes #806', 'Refs #679, #758',
    '2 gate checks, 0 failed, 0 errored, discrimination proven', '(gate-cmd)', 'repaired 1 time',
    'warm 11 pass / 2 fail / 3 skip', 'cold 13 pass / 4 fail / 5 skip', 'cold-verified from a fresh checkout',
    'Review: changes-needed, 1 residual:', 'R1 (cosmetic): leave this note', 'Changed: crew/drive.mjs',
    'Shape: commit → rebase → suite → publish', '- bounce: retry']) assert.ok(first.includes(token), token)
  assert.equal(first.split('\n')[0], 'why the lane existed')
  assert.ok(!/\{\s*"/.test(first))
})

test('commitIntent removes only the final trailer block and keeps an internal one verbatim', () => {
  const internal = 'fix(crew): subject\n\nRefs: are explained below\nand here they are.\n\nCloses: #806\nRefs: #799'
  assert.equal(commitIntent(internal), 'Refs: are explained below\nand here they are.')
  assert.equal(commitIntent('subject\n\nbody text\n\nCloses: #806\nRefs: #799'), 'body text')
  assert.equal(commitIntent('subject\n\nbody text'), 'body text')
  assert.equal(commitIntent('subject\n\nCloses: #1'), '')
  assert.equal(commitIntent('subject'), '')
  assert.equal(commitIntent(undefined), '')
  // the blank separator between two trailers is crossed; the paragraph above is not
  assert.equal(commitIntent('s\n\nfirst\n\nsecond\n\nCloses: #1\n\nRefs: #2'), 'first\n\nsecond')
  // "verbatim" covers the body's LAST line: trailer-shaped PROSE is not a trailer, and
  // COMMIT_TRAILER recognises only what the driver itself composes.
  for (const tail of ['Refs: are explained below', 'Fixes: are explained below', 'Closes: see the issue']) {
    assert.equal(commitIntent('subject\n\nbody\n' + tail), 'body\n' + tail, tail)
    assert.doesNotMatch(tail, COMMIT_TRAILER)
  }
  for (const trailer of ['Refs: #799', 'Closes: #806', 'Refs: #799, #806', 'Fixes: #12']) {
    assert.equal(commitIntent('subject\n\nbody\n' + trailer), 'body', trailer)
    assert.match(trailer, COMMIT_TRAILER)
  }
})

test('issueTrailers separates closing keywords from references and an undeclared closes changes no commit message', () => {
  assert.deepEqual(issueTrailers('subject\n\nbody\n\nCloses: #806\nRefs: #806, #799'), { closes: ['#806'], refs: ['#799'] })
  assert.deepEqual(issueTrailers('subject\n\nbody\n\nFixes #12\n\nRefs: #13'), { closes: ['#12'], refs: ['#13'] })
  assert.deepEqual(issueTrailers('subject\n\nbody'), { closes: [], refs: [] })
  const today = composeCommitMessage({
    task: 'x', planEnv: { summary: 'plan', details: { commit_subject: 'fix(crew): subject', issues: [679, '#758', 679] } },
    builderEnv: { details: { commit_message: 'body text' } },
  })
  assert.equal(today, 'fix(crew): subject\n\nbody text\n\nRefs: #679, #758')
  const closing = composeCommitMessage({
    task: 'x', planEnv: { summary: 'plan', details: { commit_subject: 'fix(crew): subject', issues: [679, 806], closes: [806] } },
    builderEnv: { details: { commit_message: 'body text' } },
  })
  assert.equal(closing, 'fix(crew): subject\n\nbody text\n\nCloses: #806\n\nRefs: #679')
})

test('narratorApiRoot normalises every base_url spelling to exactly one API root', () => {
  assert.equal(narratorApiRoot('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1')
  assert.equal(narratorApiRoot('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434/v1')
  assert.equal(narratorApiRoot('http://desk.lan:1234'), 'http://desk.lan:1234/v1')
  assert.equal(narratorApiRoot('http://desk.lan:1234/'), 'http://desk.lan:1234/v1')
  for (const spelling of ['http://127.0.0.1:11434/v1', 'http://desk.lan:1234']) {
    const collect = []
    narrateRecord({ record: NARRATION_RECORD, registerText: NARRATOR_REGISTER(spelling), io: narratorIo({ collect }) })
    assert.equal(collect.length, 2, spelling)
    assert.equal(collect.some((command) => command.includes('/v1/v1')), false, spelling)
    assert.equal(collect.filter((command) => /\/v1\/models/.test(command)).length, 1, spelling)
    assert.equal(collect.filter((command) => /\/v1\/chat\/completions/.test(command)).length, 1, spelling)
  }
  assert.ok(narratorModelsCommand('http://desk.lan:1234/v1').includes('http://desk.lan:1234/v1/models'))
})

test('narratorModelId accepts exactly one id and names zero and several differently', () => {
  assert.deepEqual(narratorModelId(JSON.stringify({ data: [{ id: 'qwen3-coder' }] })), { id: 'qwen3-coder' })
  assert.deepEqual(narratorModelId(JSON.stringify({ data: [{ id: 'q' }, { id: 'q' }] })), { id: 'q' })
  assert.equal(narratorModelId(JSON.stringify({ data: [] })).refused, NARRATION_REFUSALS.modelAbsent)
  assert.equal(narratorModelId(JSON.stringify({ data: [{ id: '  ' }] })).refused, NARRATION_REFUSALS.modelAbsent)
  assert.equal(narratorModelId(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] })).refused, NARRATION_REFUSALS.modelAmbiguous)
  assert.equal(narratorModelId('not json').refused, NARRATION_REFUSALS.modelsUnreadable)
  assert.equal(narratorModelId(JSON.stringify({ data: 'nope' })).refused, NARRATION_REFUSALS.modelsUnreadable)
  assert.notEqual(NARRATION_REFUSALS.modelAbsent, NARRATION_REFUSALS.modelAmbiguous)
  for (const name of Object.values(NARRATION_REFUSALS)) assert.ok(NARRATION_REFUSAL_NAMES.includes(name), name)
})

test('narrateRecord narrates from an honest endpoint and never sends pi_provider as the model', () => {
  const collect = []
  const accepted = narrateRecord({ record: NARRATION_RECORD, registerText: NARRATOR_REGISTER('http://127.0.0.1:11434/v1'), io: narratorIo({ collect }) })
  assert.equal(accepted.refused, undefined)
  assert.equal(accepted.text, HONEST_NARRATION)
  assert.equal(accepted.model, 'qwen3-coder')
  const chat = collect.find((command) => command.includes('/chat/completions'))
  assert.ok(chat.includes('qwen3-coder'))
  assert.equal(/"model":"local-pi"/.test(chat), false)
  assert.ok(chat.startsWith('curl -sS --max-time 30 -X POST'))
  // the prompt is the record and nothing else
  const prompt = narrationPrompt(NARRATION_RECORD)
  assert.ok(prompt.includes(JSON.stringify(NARRATION_RECORD)))
  assert.ok(prompt.includes('you have not seen the diff or the checkout'))
})

test('every narration failure is a named refusal and never a throw', () => {
  const ask = (options) => narrateRecord({ record: NARRATION_RECORD, registerText: NARRATOR_REGISTER('http://desk.lan:1234'), io: narratorIo(options) })
  const cases = [
    [{ models: { ok: false, output: 'connection refused' } }, NARRATION_REFUSALS.unreachable],
    [{ models: { ok: true, output: 'not json' } }, NARRATION_REFUSALS.modelsUnreadable],
    [{ models: { ok: true, output: JSON.stringify({ data: [] }) } }, NARRATION_REFUSALS.modelAbsent],
    [{ models: { ok: true, output: JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }) } }, NARRATION_REFUSALS.modelAmbiguous],
    [{ chat: { ok: false, output: 'gone' } }, NARRATION_REFUSALS.unreachable],
    [{ chat: { ok: true, output: '{}' } }, NARRATION_REFUSALS.unreadable],
    [{ chat: { ok: true, output: JSON.stringify({ choices: [{ message: { content: '{"total":11}' } }] }) } }, NARRATION_REFUSALS.rawJson],
    [{ chat: { ok: true, output: JSON.stringify({ choices: [{ message: { content: 'It rewrote src/vendor/blob.' } }] }) } }, NARRATION_REFUSALS.unknownFact],
  ]
  for (const [options, reason] of cases) {
    let out
    assert.doesNotThrow(() => { out = ask(options) }, JSON.stringify(options))
    assert.equal(out.text, undefined, reason)
    assert.equal(out.refused, reason)
  }
  let threw
  assert.doesNotThrow(() => { threw = narrateRecord({ record: NARRATION_RECORD, registerText: NARRATOR_REGISTER('http://desk.lan:1234'), io: { run: () => { throw new Error('EPERM') } } }) })
  assert.equal(threw.refused, NARRATION_REFUSALS.unreachable)
  assert.equal(narrateRecord({ record: NARRATION_RECORD, registerText: '{"local_providers":{}}', io: narratorIo() }).refused, NARRATION_REFUSALS.unconfigured)
  assert.equal(narrateRecord({ record: NARRATION_RECORD, registerText: 'not json', io: narratorIo() }).refused, NARRATION_REFUSALS.unconfigured)
  assert.equal(narrateRecord({ record: NARRATION_RECORD, registerText: NARRATOR_REGISTER('file:///etc/passwd'), io: narratorIo() }).refused, NARRATION_REFUSALS.endpointUnsafe)
  assert.equal(narrateRecord({ record: NARRATION_RECORD, registerText: NARRATOR_REGISTER('http://u:p@desk.lan:1234'), io: narratorIo() }).refused, NARRATION_REFUSALS.endpointUnsafe)
})

test('the narration stage guard refuses an unknown token and an absent plain stage head', () => {
  const record = { stages: ['plan:r1', 'build:r1', 'lane:r1', 'review:r1', 'commit', 'publish'] }
  // (a) an unknown colon-shaped token
  assert.equal(narrationStageDefect('The lane ran audit:r2 before commit.', record), NARRATION_REFUSALS.unknownFact)
  assert.equal(narrationStageDefect('The lane ran review:r2 before commit.', record), NARRATION_REFUSALS.unknownFact)
  assert.equal(narrationStageDefect('The lane ran review:r1 before commit.', record), null)
  // (b) a KNOWN plain stage head the record never ran — the hole a colon-only scan left
  for (const absent of ['converge', 'rebase', 'suite', 'scope-gate', 'gate-proof', 'check', 'done']) {
    assert.equal(narrationStageDefect('The lane ran ' + absent + '.', record), NARRATION_REFUSALS.unknownFact, absent)
    assert.ok(NARRATION_STAGE_VOCABULARY.includes(absent), absent)
  }
  for (const present of ['plan', 'build', 'review', 'commit', 'publish', 'lane']) {
    assert.equal(narrationStageDefect('The lane ran ' + present + '.', record), null, present)
  }
  // The vocabulary is the driver's, not English: `lane` IS a stage head, so a narration
  // saying "the lane" against a record that never journaled one is refused. Strictness
  // costs nothing — a refusal drops the narration and publishes the code-composed body.
  assert.equal(narrationStageDefect('The lane did well.', { stages: ['plan:r1'] }), NARRATION_REFUSALS.unknownFact)
  assert.equal(narrationStageDefect('It went well.', { stages: ['plan:r1'] }), null)
  // a head embedded in a longer word is not a stage name
  assert.equal(narrationStageDefect('It ran 11 gate checks and rebased cleanly.', { stages: ['plan:r1', 'gate:r1'] }), null)
  // the vocabulary is the driver's own declarations, closed and sorted
  assert.equal(Object.isFrozen(NARRATION_STAGE_VOCABULARY), true)
  for (const head of VARIANTS.full.stages) assert.ok(NARRATION_STAGE_VOCABULARY.includes(head), head)
  assert.ok(NARRATION_STAGE_VOCABULARY.includes('done'))
  assert.ok(NARRATION_STAGE_VOCABULARY.includes('escalate'))
  // narrationDefect routes through the one shared predicate
  assert.equal(narrationDefect('The lane ran converge.', record), NARRATION_REFUSALS.unknownFact)
  assert.equal(narrationDefect('The lane ran publish.', record), null)
})

test('raw-JSON narration is refused by its own name even when every number is a record fact', () => {
  assert.equal(narrationIsRawJson('{"gate":{"total":11},"build_round":2}'), true)
  assert.equal(narrationIsRawJson('The lane took 2 build rounds.'), false)
  const refused = narrationDefect('{"gate":{"total":11},"build_round":2}', NARRATION_RECORD)
  assert.equal(refused, NARRATION_REFUSALS.rawJson)
  assert.notEqual(refused, NARRATION_REFUSALS.unknownFact)
  assert.equal(narrationDefect(HONEST_NARRATION, NARRATION_RECORD), null)
})

test('applyNarration transfers accepted narration only, and never mutates its input', () => {
  const record = { ...NARRATION_RECORD }
  assert.equal(applyNarration(record, { text: HONEST_NARRATION }).narrative, HONEST_NARRATION)
  assert.equal('narrative' in record, false)
  for (const narrated of [undefined, null, {}, { refused: NARRATION_REFUSALS.unreachable }, { text: '' }, { text: '   ' }]) {
    assert.equal('narrative' in applyNarration(record, narrated), false, JSON.stringify(narrated))
  }
  assert.equal(applyNarration(record, { text: '  ' + HONEST_NARRATION + '  ' }).narrative, HONEST_NARRATION)
})

test('a published run prepends the local narrative and leaves the code-composed facts byte-identical', () => {
  const narratorCommands = {
    'curl -sS --max-time 15': { ok: true, output: JSON.stringify({ data: [{ id: 'qwen3-coder' }] }) },
    'curl -sS --max-time 30 -X POST': { ok: true, output: JSON.stringify({ choices: [{ message: { content: 'The lane ran 2 build rounds.' } }] }) },
  }
  const register = NARRATOR_REGISTER('http://127.0.0.1:11434/v1')
  const narrated = runPublished({ capabilities: register, commands: narratorCommands })
  assert.equal(narrated.result.status, 'done')
  const narratedBody = narrated.io.calls.writes[TD + '/pr-body.md']
  assert.ok(narratedBody.startsWith(NARRATION_HEADING + '\nThe lane ran 2 build rounds.\n\n'), JSON.stringify(narratedBody.slice(0, 140)))
  const row = narrated.io.calls.logs.find((entry) => entry.narration)
  assert.deepEqual(row.narration, { outcome: 'accepted', chars: 'The lane ran 2 build rounds.'.length, model: 'qwen3-coder' })

  // a dead endpoint publishes exactly the no-narrator body — byte for byte
  const dead = runPublished({ capabilities: register, commands: { 'curl -sS --max-time 15': { ok: false, output: 'connection refused' } } })
  const none = runPublished({})
  const deadBody = dead.io.calls.writes[TD + '/pr-body.md']
  const noneBody = none.io.calls.writes[TD + '/pr-body.md']
  assert.equal(deadBody, noneBody)
  assert.ok(narratedBody.endsWith(deadBody))
  assert.equal(dead.result.status, 'done')
  assert.equal(dead.io.calls.logs.find((entry) => entry.narration).narration.outcome, 'refused')
  assert.equal(noneBody.includes(NARRATION_HEADING), false)
  assert.equal(none.io.calls.logs.find((entry) => entry.narration).narration.reason, NARRATION_REFUSALS.unconfigured)
})

test('journal boundaries and anomaly extraction are deterministic and tolerate malformed arrays', () => {
  const text = [
    JSON.stringify({ event: RUN_START_EVENT }), JSON.stringify({ event: 'wait-extended', id: 'old' }),
    JSON.stringify({ event: RUN_START_EVENT }), JSON.stringify({ event: 'wait-extended', role: 'builder', id: 'd7', idle_s: 2, extension_s: 3 }),
  ].join('\n')
  assert.deepEqual(journalRowsSinceRunStart(text).map((row) => row.id), ['d7'])
  const rows = [
    { event: 'wait-extended', role: 'builder', id: 'd7', idle_s: 2, extension_s: 3 },
    { stage: 'gate-repair:1' }, { decision: 'bounce-builder', reason: 'try again' },
    { event: 'tree-witness', outcome: 'modified', modified: ['a.mjs'], removed: [], added: [] },
    { event: 'tree-witness', outcome: 'unknown', modified: 'not-an-array', removed: null, added: {} },
  ]
  const anomalies = prAnomalies(rows)
  assert.equal(anomalies.length, 5)
  assert.match(anomalies[0].detail, /builder d7 idle 2s, extended 3s/)
  assert.equal(anomalies[1].detail, 'gate-repair:1')
  assert.match(anomalies[2].detail, /^builder — try again$/)
  // the BARE `bounce` a consult offering ['bounce','escalate'] records names no seat,
  // so the row must carry no dangling separator either
  assert.equal(bounceSeatOf('bounce'), '')
  assert.equal(bounceSeatOf('bounce-reviewer'), 'reviewer')
  assert.equal(bounceDetail('bounce', 'try again'), 'try again')
  assert.equal(bounceDetail('bounce-builder', 'try again'), 'builder — try again')
  assert.equal(bounceDetail('bounce', ''), '')
  assert.equal(prAnomalies([{ decision: 'bounce', reason: 'try again' }])[0].detail, 'try again')
  const bare = composePrBody({ anomalies: prAnomalies([{ decision: 'bounce', reason: 'try again' }]) })
  assert.equal(bare.split('\n').find((line) => line.startsWith('- bounce')), '- bounce: try again')
  assert.match(anomalies[3].detail, /modified a.mjs/)
  assert.doesNotThrow(() => prAnomalies(rows))
  assert.deepEqual(prAnomalies({}), [])
})

test('an armed run refuses green suites whose publication counts are unmeasured', () => {
  const warm = runPublished({ warm: '' })
  assert.equal(warm.result.status, 'escalation')
  assert.equal(warm.result.details.escalation.where, 'suite')
  const cold = runPublished({ coldOutput: '' })
  assert.equal(cold.result.status, 'escalation')
  assert.equal(cold.result.details.escalation.where, 'cold-suite')
  assert.equal(cold.result.details.commit, cold.io.state.post)
})

test('refsFromCommitMessage reads the trailer in order, de-duplicates, and stays empty without one', () => {
  assert.deepEqual(refsFromCommitMessage('subject\n\nbody\n\nRefs: #679, #758, #679'), ['#679', '#758'])
  assert.deepEqual(refsFromCommitMessage('subject\n\nbody'), [])
})
