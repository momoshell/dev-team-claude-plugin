// Split from crew/drive.test.mjs (#918 follow-up): one subject per file so a
// lane fencing one driver concern no longer locks every driver test.
// Shared fixtures, and the ledger sandbox side effect, live in ./drive-fixtures.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FINDING_DISPOSITIONS, FINDING_SEVERITIES, GATE_CUSTODIAN, MAX_QUESTIONS, PROTECTED_PATHS, REPO_ROOT, RESIDUAL_TYPES, applyPrescriptionLines, checkAnchors, existsSync, join, laneFence, partitionShifts, protectedHits, readFileSync, readdirSync, scratchDir, spawnSync,
} from './drive-fixtures.mjs'

test('the turn-economy rule is stated once and still reaches every seat', () => {
  const roles = ['builder', 'lead', 'planner', 'reviewer', 'tech-lead']
  const rules = {
    builder: "Run the acceptance gate and the test files you are changing — never the full suite, which the driver's own suite stage owns and re-runs after you.",
    planner: 'Run your own acceptance gate at baseline, exactly once. Run nothing else — the driver owns the validation lane and the suite.',
    lead: 'Run no tests. The gate proof and the suite result are already journalled; read them from the task dir and the journal rather than re-buying them.',
    reviewer: 'Run no tests. The gate proof and the suite result are already journalled; read them from the task dir and the journal rather than re-buying them.',
    'tech-lead': 'Run no tests. The gate proof and the suite result are already journalled; read them from the task dir and the journal rather than re-buying them.',
  }
  const rolesDir = join(REPO_ROOT, 'crew', 'roles')
  const docs = readdirSync(rolesDir).filter((name) => name.endsWith('.md')).map((name) => readFileSync(join(rolesDir, name), 'utf8'))
  const shared = readFileSync(join(rolesDir, '_shared.md'), 'utf8')
  const U1 = 'Issue every independent read in ONE turn — a batch of greps, reads and file listings that do not depend on each other is one tool block, not one turn each.'
  const U2 = 'Read a file once and cite it from context — re-slicing a file you have already read buys nothing and every turn re-sends the whole context.'
  const occurrences = (text, needle) => text.split(needle).length - 1
  for (const universal of [U1, U2]) {
    assert.equal(docs.reduce((count, text) => count + occurrences(text, universal), 0), 1)
    assert.equal(occurrences(shared, universal), 1)
  }
  for (const role of roles) {
    const card = readFileSync(join(rolesDir, `${role}.md`), 'utf8')
    assert.equal(occurrences(card, U1), 0)
    assert.equal(occurrences(card, U2), 0)
    assert.doesNotMatch(card, /^## Turn economy\s*$/m)
    const compiled = `${shared}\n\n${card}`
    assert.equal(occurrences(compiled, U1), 1)
    assert.equal(occurrences(compiled, U2), 1)
    assert.equal(occurrences(compiled, rules[role]), 1)
  }
})

test('the shared charter and validator agree on the findings contract', () => {
  const charter = readFileSync(new URL('./roles/reviewer.md', import.meta.url), 'utf8')
  const start = charter.indexOf('## Envelope details fields')
  const end = charter.indexOf('## Perspective assignments', start)
  assert.ok(start >= 0 && end > start)
  const block = charter.slice(start, end)
  for (const token of ['"findings"', '"id"', '"severity"']) assert.ok(block.includes(token))
  // #457: this slice used to stop AT '## Gate triage', so the gate-repair
  // custody sentence under that heading was pinned by nothing and survived
  // custody moving to the lead (#334/PR #348). The slice now covers it.
  assert.ok(block.includes('## Gate triage'), 'the charter slice must cover the gate-triage section')
  assert.ok(block.includes(`grants the **${GATE_CUSTODIAN}**`), 'the gate verdict must grant the repair to the gate custodian')
  assert.doesNotMatch(block, /grants the (\*\*)?planner\b/)
  const severityField = block.match(/"severity":\s*([^\n]+)/)?.[1]
  assert.ok(severityField)
  const documented = [...severityField.matchAll(/"([^\"]+)"/g)].map((match) => match[1])
  assert.deepEqual(documented, [...FINDING_SEVERITIES])
  const dispositionField = block.match(/"disposition":\s*([^\n]+)/)?.[1]
  assert.ok(dispositionField)
  const dispositions = [...dispositionField.matchAll(/"([^\"]+)"/g)].map((match) => match[1])
  assert.deepEqual(dispositions, [...FINDING_DISPOSITIONS])
  assert.ok(block.includes('`disposition` is OPTIONAL in this release and REQUIRED from the next'))
})

test("the reviewer guidelines carry a defended 'Do not flag' list", () => {
  const guidelines = readFileSync(new URL('./guidelines/review-do-not-flag.md', import.meta.url), 'utf8')
  const charter = readFileSync(new URL('./roles/reviewer.md', import.meta.url), 'utf8')
  const start = guidelines.search(/^## Do not flag$/m)
  assert.ok(start >= 0, 'the reviewer charter must carry a "Do not flag" section')
  const rest = guidelines.slice(start + '## Do not flag'.length)
  const end = rest.indexOf('\n## ')
  const section = end < 0 ? rest : rest.slice(0, end)
  const entries = section.split('\n').reduce((acc, line) => {
    if (/^[-*]\s+\*\*/.test(line)) acc.push([line])
    else if (acc.length) acc[acc.length - 1].push(line)
    return acc
  }, []).map((block) => block.join('\n'))
  assert.ok(entries.length >= 4, `expected at least 4 entries, found ${entries.length}`)
  // Every entry names the defense that makes its class safe not to flag, and
  // that defense points at something that exists — an ignore rule without one
  // is how a real finding gets suppressed.
  for (const entry of entries) {
    assert.match(entry, /Defense:/)
    assert.match(entry.slice(entry.indexOf('Defense:')), /crew\/[\w.-]+|files_in_scope|\.crew\/|#\d{2,}/)
  }
  assert.doesNotMatch(charter, /^## Do not flag$/m)
  assert.ok(charter.includes('crew/guidelines/review-do-not-flag.md'))
})

test('the lead charter documents the typed exhaustion accept contract', () => {
  const charter = readFileSync(new URL('./roles/lead.md', import.meta.url), 'utf8')
  for (const token of ['residuals', 'refuted', ...RESIDUAL_TYPES]) assert.ok(charter.includes(token), token)
  assert.match(charter, /code-refused/)
  const collapsed = charter.replace(/\s+/g, ' ')
  assert.match(collapsed, /the plan is a contract/)
  assert.match(collapsed, /not amendable after acceptance/)
  assert.match(collapsed, /correctness-unverified[^.]*code-refused/)
  assert.match(collapsed, /not a statement about which stage/)
  assert.match(collapsed, /summary is REQUIRED there and is omitted from a keyed review-exhaustion claim/)
})

test('the planner charter documents how to discover files_in_scope', () => {
  const charter = readFileSync(new URL('./roles/planner.md', import.meta.url), 'utf8')
  for (const token of [
    'every test that pins it',
    'crew/daemon.test.mjs',
    'crew/factoryctl.test.mjs',
    'crew/adapter-*.test.mjs',
    '#193',
    '#199',
    'dispatched surface is a CEILING',
    '`details.questions` entry rather than a wider `files_in_scope`',
  ]) assert.ok(charter.includes(token), token)
  assert.match(charter, /grep/i)
})

test('the planner charter tells the planner to grep the changed file’s own path', () => {
  const charter = readFileSync(new URL('./roles/planner.md', import.meta.url), 'utf8')
  const discovery = charter.slice(charter.indexOf('Discover that list'), charter.indexOf('`gate_path` is required'))
  assert.ok(discovery.length > 0)
  assert.match(discovery, /own repo-relative path/)
  assert.match(discovery, /\.github\/workflows\/test\.yml/)
  assert.match(discovery, /test\/factory-ledger-floor\.test\.mjs/)
  assert.doesNotMatch(discovery, /production/)
})

// The file nobody pinned is the file that rotted: tech-lead.md carried the whole
// plan-check doctrine and no test read a byte of it (#698).
test('the tech-lead charter documents envelope custody and the residual it cannot type', () => {
  const charter = readFileSync(new URL('./roles/tech-lead.md', import.meta.url), 'utf8')
  for (const token of [
    'details.mutations', 'files_in_scope', 'details.residuals',
    'correctness-unverified', 'verdictOf', 'applyPrescriptionLines',
  ]) assert.ok(charter.includes(token), token)
  const collapsed = charter.replace(/\s+/g, ' ')
  assert.match(collapsed, /frozen at acceptance/)
  assert.match(collapsed, /not amendable after acceptance/)
  assert.match(collapsed, /VERDICT: revise[^.]*PRESCRIBES/)
  assert.match(collapsed, /correctness-unverified[^.]*code-refused/)
  assert.match(collapsed, /cannot type a residual/)
})

// Prose file:line citations are invisible to skills/*/anchors.json, so crew/roles/anchors.json
// pins the CONTENT each cited line of crew/drive.mjs must carry. A shape-only check could not
// tell a right line from a wrong one, and twice a build kept it green by deleting a blank line
// elsewhere to compensate for one it inserted (#743, #748, #747). The manifest and the prose are
// held to a bijection in both directions, so a citation added to one side alone fails here.
test('every crew/drive.mjs anchor the tech-lead charter cites resolves to the code it names', () => {
  const charterPath = join(REPO_ROOT, 'crew', 'roles', 'tech-lead.md')
  const charter = readFileSync(charterPath, 'utf8')
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'crew', 'roles', 'anchors.json'), 'utf8'))
  // Every charter in crew/roles, not only the tech-lead's: the manifest is directory-wide
  // and anchor-pin.mjs --repair crew/roles scans the same set, so a pin cited only by
  // planner.md or reviewer.md is a citation here, never an orphan.
  const rolesDir = join(REPO_ROOT, 'crew', 'roles')
  const docs = readdirSync(rolesDir).filter((name) => name.endsWith('.md')).sort().map((name) => join(rolesDir, name))
  const result = checkAnchors({ root: REPO_ROOT, docs, manifest })
  assert.ok(result.anchors >= 12, `expected at least 12 anchors, found ${result.anchors}`)
  assert.deepEqual(result.failures, [])
  const { inFence, outOfFence } = partitionShifts({ shifted: result.shifted, fence: laneFence({ root: REPO_ROOT }).paths, manifest: 'crew/roles/anchors.json' })
  for (const shift of outOfFence) console.warn(`shifted ${shift.key} -> line ${shift.to}; repair after this lane merges, on main with: node skills/qa-test-writing/anchor-pin.mjs --repair-all crew/roles`)
  assert.deepEqual(inFence, [], 'a shift this lane can repair here must be repaired, not tolerated')
  // Both citation forms of the four anchors #698 found stale: the qualified
  // `crew/drive.mjs:2299` and the bare `:2226` continuation the file also used.
  for (const retired of [':2299', ':2226', ':2319', ':2217']) {
    assert.equal(charter.includes(retired), false, `retired anchor ${retired}`)
  }
})

test('the codemod stages before it applies and fails loudly without ast-grep', () => {
  const script = join(REPO_ROOT, '.agents/skills/ast-grep-codemod/scripts/codemod.mjs')
  const fake = join(REPO_ROOT, '.agents/skills/ast-grep-codemod/test-fixtures/fake-ast-grep.mjs')
  const log = join(scratchDir('b19-drive-'), 'invocations.log')
  const stage = join(scratchDir('b19-stage-'), 'proposal.json')
  const run = (args, env) => spawnSync(process.execPath, [script, ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, ...env },
  })
  const invocations = () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0
  const refused = run(['apply'], { AST_GREP_BIN: fake, FAKE_AST_GREP_LOG: log, CODEMOD_STAGE: stage })
  assert.notEqual(refused.status, 0)
  assert.match(`${refused.stdout || ''}${refused.stderr || ''}`, /--resolve/)
  assert.equal(invocations(), 0)
  const proposed = run([
    'propose', '--pattern', 'driveProbe($A)', '--rewrite', 'driveProbed($A)', '--lang', 'js', 'crew/roles/planner.md',
  ], {
    AST_GREP_BIN: fake, FAKE_AST_GREP_LOG: log, CODEMOD_STAGE: stage,
    FAKE_AST_GREP_DIFF: '@@ -1 +1 @@\n-old\n+new\n',
  })
  assert.equal(proposed.status, 0)
  assert.ok(invocations() >= 1)
  const failedProbeStage = join(scratchDir('b19-probe-failure-'), 'proposal.json')
  const failedProbe = run([
    'propose', '--pattern', 'probeFailure($A)', '--rewrite', 'probeFailed($A)', '--lang', 'js', 'crew/roles/planner.md',
  ], {
    AST_GREP_BIN: fake, FAKE_AST_GREP_LOG: log, CODEMOD_STAGE: failedProbeStage,
    FAKE_AST_GREP_VERSION_EXIT: '7',
  })
  assert.equal(failedProbe.status, 3)
  assert.equal(existsSync(failedProbeStage), false)
  const failedProposeStage = join(scratchDir('b19-propose-failure-'), 'proposal.json')
  const failedPropose = run([
    'propose', '--pattern', 'runFailure($A)', '--rewrite', 'runFailed($A)', '--lang', 'js', 'crew/roles/planner.md',
  ], {
    AST_GREP_BIN: fake, FAKE_AST_GREP_LOG: log, CODEMOD_STAGE: failedProposeStage,
    FAKE_AST_GREP_DIFF: '@@ -1 +1 @@\n-old\n+new\n', FAKE_AST_GREP_RUN_EXIT: '7',
  })
  assert.equal(failedPropose.status, 3)
  assert.equal(existsSync(failedProposeStage), false)
  const applyLog = `${stage}.log`
  const failedCheck = run(['apply', '--resolve', 'the check must still match'], {
    AST_GREP_BIN: fake, FAKE_AST_GREP_LOG: log, CODEMOD_STAGE: stage,
    FAKE_AST_GREP_DIFF: '@@ -1 +1 @@\n-old\n+new\n', FAKE_AST_GREP_RUN_EXIT: '7',
  })
  assert.equal(failedCheck.status, 3)
  assert.equal(existsSync(applyLog), false)
  const failedUpdate = run(['apply', '--resolve', 'the update is approved'], {
    AST_GREP_BIN: fake, FAKE_AST_GREP_LOG: log, CODEMOD_STAGE: stage,
    FAKE_AST_GREP_DIFF: '@@ -1 +1 @@\n-old\n+new\n', FAKE_AST_GREP_UPDATE_EXIT: '7',
  })
  assert.equal(failedUpdate.status, 3)
  assert.equal(existsSync(applyLog), false)
  const missing = run([
    'propose', '--pattern', 'a($A)', '--rewrite', 'b($A)', '--lang', 'js', 'crew/roles/planner.md',
  ], { AST_GREP_BIN: '/nonexistent', CODEMOD_STAGE: join(scratchDir('b19-missing-'), 'proposal.json') })
  assert.equal(missing.status, 3)
  const missingOutput = `${missing.stdout || ''}${missing.stderr || ''}`
  assert.match(missingOutput, /ast-grep/)
  assert.match(missingOutput, /install/i)
})

test('implementation-file sections name existing files in both docs', () => {
  const docs = [
    ['docs/park-lease-protocol.md', ['crew/reclaim.mjs']],
    ['docs/conventions.md', ['crew/crew.mjs', 'crew/drive.mjs', 'crew/daemon.mjs']],
  ]
  for (const [rel, required] of docs) {
    const text = readFileSync(join(REPO_ROOT, rel), 'utf8')
    const start = text.indexOf('## Implementation files')
    assert.ok(start >= 0, `${rel} must have an Implementation files section`)
    const rest = text.slice(start + '## Implementation files'.length)
    const end = rest.indexOf('\n## ')
    const section = end < 0 ? rest : rest.slice(0, end)
    const paths = [...section.matchAll(/`([\w./-]+\.(?:mjs|js|json|md|yml))`/g)].map((match) => match[1])
    assert.ok(paths.length)
    for (const path of paths) assert.ok(existsSync(join(REPO_ROOT, path)), `${path} must exist`)
    for (const path of required) assert.ok(paths.includes(path), `${rel} must name ${path}`)
  }
})

test('conventions disambiguates agent and seat as runtime under crew, not the model', () => {
  const text = readFileSync(join(REPO_ROOT, 'docs/conventions.md'), 'utf8')
  const line = text.split('\n').find((entry) => /\bagent\b/.test(entry) && /\bseat\b/.test(entry) && /crew\//.test(entry) && /not the model/i.test(entry))
  assert.ok(line)
})

test('protectedHits matches the ratified protected paths in both directions', () => {
  assert.deepEqual([...PROTECTED_PATHS].sort(), [
    '.github/workflows/', 'crew/capabilities.json', 'crew/capabilities.schema.json', 'crew/drive.mjs', 'crew/escalation-policy.mjs', 'crew/model-ladder.json',
    'crew/protected-paths.mjs', 'crew/reclaim.mjs', 'crew/variants.mjs',
    'crew/roster.json', 'crew/roster.schema.json', 'docs/adr/',
  ].sort())
  assert.equal(PROTECTED_PATHS.includes('crew/roles/'), false)
  assert.deepEqual(protectedHits([
    'docs/adr/031.md', '.github/workflows/test.yml', 'crew/drive.mjs', 'docs/adr/',
    'crew/roles/planner.md', 'crew/crew.mjs', 'a.mjs', 'docs/adr/031.md',
    'crew/drive.mjs.bak', 'crew/roster.json.tmp',
    'crew/capabilities.json', 'crew/capabilities.schema.json', 'crew/model-ladder.json',
    'crew/model-ladder.json.bak',
  ]), ['docs/adr/031.md', '.github/workflows/test.yml', 'crew/drive.mjs', 'docs/adr/',
    'crew/capabilities.json', 'crew/capabilities.schema.json', 'crew/model-ladder.json'])
})

test('charters pin the batched question and keyed answer conventions', () => {
  const shared = readFileSync(new URL('./roles/_shared.md', import.meta.url), 'utf8')
  const lead = readFileSync(new URL('./roles/lead.md', import.meta.url), 'utf8')
  const planner = readFileSync(new URL('./roles/planner.md', import.meta.url), 'utf8')
  const builder = readFileSync(new URL('./roles/builder.md', import.meta.url), 'utf8')
  for (const token of ['"questions"', '"id"', '"question"']) assert.ok(shared.includes(token))
  assert.match(shared, /one round instead of one round per gap/i)
  const cap = shared.match(/at most ([0-9]+) questions/)
  assert.equal(Number(cap?.[1]), MAX_QUESTIONS)
  for (const token of ['"answers"', '"answer"', 'UNANSWERED']) assert.ok(lead.includes(token))
  assert.ok(planner.includes('status: insufficient') && planner.includes('details.questions'))
  assert.ok(builder.includes('insufficient') && builder.includes('details.questions'))
})

test('both charters state where the planner stops and the lead takes over', () => {
  const lead = readFileSync(new URL('./roles/lead.md', import.meta.url), 'utf8')
  const planner = readFileSync(new URL('./roles/planner.md', import.meta.url), 'utf8')
  assert.match(lead, /## Gate custody \(post-acceptance\)/)
  assert.match(lead, /gate_cmd/)
  assert.match(lead, /spends no budget/)
  assert.match(planner, /domain ends when your plan is accepted/)
  assert.match(planner.slice(planner.indexOf('domain ends when your plan is accepted')), /lead/)
  assert.doesNotMatch(planner, /## Perspective assignments/)
})

test('#800 §7b 34 — the shared charter pin includes disposition and its compatibility window', () => {
  const charter = readFileSync(new URL('./roles/reviewer.md', import.meta.url), 'utf8')
  const block = charter.slice(charter.indexOf('## Envelope details fields'), charter.indexOf('## Perspective assignments'))
  const line = block.match(/"disposition":\s*([^\n]+)/)?.[1]
  assert.ok(line)
  assert.deepEqual([...line.matchAll(/"([^\"]+)"/g)].map((match) => match[1]), [...FINDING_DISPOSITIONS])
  assert.ok(block.includes('`disposition` is OPTIONAL in this release and REQUIRED from the next'))
})
