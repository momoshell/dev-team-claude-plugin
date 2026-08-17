// test/factory-probe-repo.test.mjs — filesystem-only coverage for the
// read-only repo profile proposer. Fixtures are disposable git directories;
// no live profile roots, home directories, or network calls are used.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { ROOT } from './helpers.mjs'
import {
  FIELD_KIND_NAMES, FIELD_KINDS, INTAKE_BOARD_FIELD, INTAKE_BOARD_REFUSALS,
  INTAKE_COLUMN_ROLES, LOAD_BEARING, PROFILE_VERSION,
  PROTECTED_PATH_PATTERNS, ProfileRefusal, UNKNOWN_REASONS, assertRunnable,
  checkoutIntakeBoard, checkoutProtectedPaths, defaultProfilePath, fieldKind, isRatifiable, main,
  probeRepo, profileBody, profileDigest, profileIntakeBoard, profileProtectedPaths, readProfile,
  requireField, writeProfile,
} from '../scripts/factory/probe-repo.mjs'

const SCRIPT = join(ROOT, 'scripts', 'factory', 'probe-repo.mjs')
const fixtureRoot = mkdtempSync(join(tmpdir(), 'factory-probe-repo-'))
after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

let fixtureNumber = 0
function nextRoot(label) {
  fixtureNumber += 1
  const root = join(fixtureRoot, `${String(fixtureNumber).padStart(2, '0')}-${label}`)
  mkdirSync(root, { recursive: true })
  return root
}

function put(root, file, body) {
  const target = join(root, file)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, body)
  return target
}

function fakeGh(label, body) {
  const target = join(fixtureRoot, `gh-${label}.mjs`)
  writeFileSync(target, `#!/usr/bin/env node\n${body}\n`)
  chmodSync(target, 0o755)
  return target
}

function withGhBin(bin, fn) {
  const previous = process.env.GH_BIN
  process.env.GH_BIN = bin
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.GH_BIN
    else process.env.GH_BIN = previous
  }
}

function git(root, ...args) {
  return execFileSync('git', [
    '-c', 'user.email=probe@example.invalid',
    '-c', 'user.name=Probe Test',
    '-c', 'protocol.file.allow=always',
    '-C', root, ...args,
  ], { encoding: 'utf8' })
}

function initGit(root, { commit = false } = {}) {
  git(root, 'init', '-q', '-b', 'main')
  if (commit) {
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'test: fixture')
  }
}

function nodePackage(root, script = 'node --test') {
  put(root, 'package.json', `${JSON.stringify({
    name: basename(root), private: true, type: 'module', scripts: { test: script },
  }, null, 2)}\n`)
}

function coldFixture(label = 'cold') {
  const root = nextRoot(label)
  put(root, 'README.md', '# fixture\n')
  initGit(root)
  return root
}

function nodeFixture(label = 'node', script = 'node --test') {
  const root = nextRoot(label)
  nodePackage(root, script)
  put(root, 'test/one.test.mjs', [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "test('one', () => assert.ok(true))",
    "test('two', () => assert.equal(1 + 1, 2))",
    '',
  ].join('\n'))
  initGit(root)
  return root
}

function snapshot(root) {
  const out = {}
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      const full = join(directory, entry.name)
      const rel = relative(root, full)
      if (entry.isDirectory()) {
        out[`${rel}/`] = 'dir'
        visit(full)
      } else {
        const stat = statSync(full)
        out[rel] = rel.startsWith('.git') ? String(stat.size) : `${stat.size}:${stat.mtimeMs}`
      }
    }
  }
  visit(root)
  return out
}

function captureMain(args) {
  let stdout = ''
  let stderr = ''
  const oldOut = process.stdout.write
  const oldErr = process.stderr.write
  process.stdout.write = (chunk) => { stdout += String(chunk); return true }
  process.stderr.write = (chunk) => { stderr += String(chunk); return true }
  try {
    return { code: main(args), get stdout() { return stdout }, get stderr() { return stderr } }
  } finally {
    process.stdout.write = oldOut
    process.stderr.write = oldErr
  }
}

function everyCell(profile) {
  assert.deepEqual(Object.keys(profile.fields).sort(), [
    'baseline', 'ci', 'conventions', 'default_branch', 'intake_board', 'pr_conventions',
    'protected_paths_candidates', 'test_command', 'toolchain',
  ].sort())
  for (const cell of Object.values(profile.fields)) {
    assert.ok(['proposed', 'unknown'].includes(cell.status))
    assert.equal(cell.status === 'unknown', cell.value === null)
    if (cell.status === 'unknown') assert.ok(UNKNOWN_REASONS.includes(cell.reason))
  }
}

test('self-hosting proposes the local lane, CI shape, conventions, and remote identity', () => {
  const profile = probeRepo({ checkout: ROOT })
  assert.equal(profile.schema, PROFILE_VERSION)
  assert.equal(profile.profile_version, PROFILE_VERSION)
  assert.equal(profile.repo_key, 'momoshell__dev-team-claude-plugin')
  // repo_key is remote-derived and stable; repo_slug is the checkout DIRECTORY's
  // name, which differs per worktree, on CI, and on main. Deriving it is the
  // point — a hardcoded value passes only in the worktree it was written in.
  assert.equal(profile.repo_slug, basename(ROOT))
  assert.deepEqual(profile.fields.test_command.value, 'npm test')
  assert.equal(profile.fields.test_command.status, 'proposed')
  assert.match(profile.fields.test_command.source, /package\.json/)
  assert.ok(profile.fields.test_command.candidates.some((candidate) => candidate.sources.includes('package.json')))
  assert.ok(profile.fields.test_command.candidates.some((candidate) => candidate.sources.includes('.github/workflows/test.yml')))
  assert.equal(profile.fields.ci.status, 'proposed')
  const workflow = profile.fields.ci.value.workflows[0]
  assert.equal(workflow.file, '.github/workflows/test.yml')
  assert.deepEqual(workflow.triggers, ['push', 'pull_request'])
  assert.equal(workflow.jobs[0].id, 'test')
  assert.equal(workflow.jobs[0].check_name, 'test (node 24)')
  assert.ok(profile.fields.conventions.value.files.includes('docs/conventions.md'))
  assert.ok(!profile.fields.conventions.value.files.includes('CLAUDE.md'))
  // The default branch is read from refs/remotes/origin/HEAD, which a local
  // clone has and a CI checkout does NOT (actions/checkout never sets it).
  // Both outcomes are correct probe behaviour, so this pins the CONTRACT —
  // propose 'main' when the ref exists, admit no_remote_head when it does not —
  // rather than a fact about the machine the test happens to run on.
  if (profile.fields.default_branch.status === 'proposed') {
    assert.equal(profile.fields.default_branch.value, 'main')
  } else {
    assert.equal(profile.fields.default_branch.status, 'unknown')
    assert.equal(profile.fields.default_branch.value, null)
    assert.equal(profile.fields.default_branch.reason, 'no_remote_head')
  }
  assert.equal(profile.meta.gh_consulted, false)
  assert.equal(profile.meta.body_digest, profileDigest(profile))
})

function fieldRejectingGh(label) {
  return fakeGh(label, `
const argv = process.argv.slice(2)
const index = argv.indexOf('--json')
const fields = String(argv[index + 1] || '').split(',').filter(Boolean)
const known = {
  nameWithOwner: 'owner/repo',
  squashMergeAllowed: true,
  mergeCommitAllowed: false,
  rebaseMergeAllowed: false,
  deleteBranchOnMerge: true,
}
const unknown = fields.find((field) => !Object.hasOwn(known, field))
if (unknown) {
  process.stderr.write('Unknown JSON field: "' + unknown + '"')
  process.exit(1)
}
const output = {}
for (const field of fields) output[field] = known[field]
process.stdout.write(JSON.stringify(output))
`)
}

function boardGh(label, { nodes, fields = [], title = 'Board' }) {
  return fakeGh(label, `
const argv = process.argv.slice(2)
const projects = ${JSON.stringify({ Nodes: nodes })}
const boardFields = ${JSON.stringify(fields)}
const projectTitle = ${JSON.stringify(title)}
if (argv[0] === 'repo' && argv.includes('--json')) {
  const requested = String(argv[argv.indexOf('--json') + 1] || '').split(',').filter(Boolean)
  const known = {
    projectsV2: projects,
    defaultBranchRef: { name: 'main' },
    nameWithOwner: 'owner/repo',
    squashMergeAllowed: true,
    mergeCommitAllowed: false,
    rebaseMergeAllowed: false,
    deleteBranchOnMerge: true,
    allowAutoMerge: false,
  }
  const unknown = requested.find((field) => !Object.hasOwn(known, field))
  if (unknown) { process.stderr.write('Unknown JSON field: "' + unknown + '"'); process.exit(1) }
  const output = {}
  for (const field of requested) output[field] = known[field]
  process.stdout.write(JSON.stringify(output))
  process.exit(0)
}
if (argv[0] === 'api' && argv[1] === 'graphql') {
  const queryArg = argv.find((arg) => arg.startsWith('query=')) || ''
  const query = queryArg.slice('query='.length)
  const roots = [query.includes('user(login:'), query.includes('organization(login:')].filter(Boolean).length
  if (roots !== 1) { process.stderr.write('query must select one owner root'); process.exit(1) }
  const root = query.includes('organization(login:') ? 'organization' : 'user'
  process.stdout.write(JSON.stringify({ data: { [root]: { projectV2: { title: projectTitle, fields: { nodes: boardFields } } } } }))
  process.exit(0)
}
process.stderr.write('unexpected gh invocation')
process.exit(1)
`)
}

test('a gh that rejects one field still proposes the fields it can answer', () => {
  const root = coldFixture('gh-partial')
  git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  const profile = withGhBin(fieldRejectingGh('partial'), () => probeRepo({ checkout: root, gh: true }))
  const cell = profile.fields.pr_conventions
  assert.equal(cell.status, 'proposed')
  assert.deepEqual(Object.keys(cell.value).sort(), [
    'nameWithOwner', 'squashMergeAllowed', 'mergeCommitAllowed',
    'rebaseMergeAllowed', 'deleteBranchOnMerge',
  ].sort())
  assert.equal(cell.value.allowAutoMerge, undefined)
  assert.deepEqual(cell.detail.unanswered, [
    { field: 'allowAutoMerge', reason: 'gh_request_rejected' },
  ])
  assert.equal(profile.fields.default_branch.status, 'proposed')
  assert.equal(profile.fields.default_branch.value, 'main')
  assert.equal(profile.fields.default_branch.source, 'git symbolic-ref refs/remotes/origin/HEAD')
})

test('an absent gh is unavailable, not a rejected request', () => {
  const root = coldFixture('gh-absent')
  const missing = join(fixtureRoot, 'gh-does-not-exist')
  const cell = withGhBin(missing, () => probeRepo({ checkout: root, gh: true })).fields.pr_conventions
  assert.equal(cell.status, 'unknown')
  assert.equal(cell.value, null)
  assert.equal(cell.reason, 'gh_unavailable')
})

test('an unauthenticated gh is not a rejected request', () => {
  const root = coldFixture('gh-unauthenticated')
  const gh = fakeGh('unauthenticated', `
process.stderr.write('gh auth login')
process.exit(1)
`)
  const cell = withGhBin(gh, () => probeRepo({ checkout: root, gh: true })).fields.pr_conventions
  assert.equal(cell.status, 'unknown')
  assert.equal(cell.value, null)
  assert.equal(cell.reason, 'gh_unauthenticated')
})

test('a missing token scope is its own reason', () => {
  const root = coldFixture('gh-scope-missing')
  const gh = fakeGh('scope-missing', `
process.stderr.write("Your token has not been granted the required scopes ... ['read:project']")
process.exit(1)
`)
  const cell = withGhBin(gh, () => probeRepo({ checkout: root, gh: true })).fields.pr_conventions
  assert.equal(cell.status, 'unknown')
  assert.equal(cell.value, null)
  assert.equal(cell.reason, 'gh_scope_missing')
})

test('the gh failure classes are pairwise distinct', () => {
  const absentRoot = coldFixture('gh-classes-absent')
  const absent = withGhBin(join(fixtureRoot, 'gh-classes-does-not-exist'), () => (
    probeRepo({ checkout: absentRoot, gh: true }).fields.pr_conventions
  ))

  const unauthenticatedRoot = coldFixture('gh-classes-unauthenticated')
  const unauthenticatedGh = fakeGh('classes-unauthenticated', `
process.stderr.write('gh auth login')
process.exit(1)
`)
  const unauthenticated = withGhBin(unauthenticatedGh, () => (
    probeRepo({ checkout: unauthenticatedRoot, gh: true }).fields.pr_conventions
  ))

  const scopeRoot = coldFixture('gh-classes-scope')
  const scopeGh = fakeGh('classes-scope', `
process.stderr.write("Your token has not been granted the required scopes ... ['read:project']")
process.exit(1)
`)
  const scope = withGhBin(scopeGh, () => (
    probeRepo({ checkout: scopeRoot, gh: true }).fields.pr_conventions
  ))

  const partialRoot = coldFixture('gh-classes-partial')
  git(partialRoot, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  const partial = withGhBin(fieldRejectingGh('classes-partial'), () => (
    probeRepo({ checkout: partialRoot, gh: true })
  ))

  const reasons = [absent.reason, unauthenticated.reason, scope.reason]
  assert.equal(new Set(reasons).size, 3)
  assert.ok(reasons.every((reason) => reason !== 'gh_request_rejected'))
  assert.deepEqual(partial.fields.pr_conventions.detail.unanswered.map((entry) => entry.reason), [
    'gh_request_rejected',
  ])
  assert.equal(partial.fields.default_branch.source, 'git symbolic-ref refs/remotes/origin/HEAD')
  for (const reason of [...reasons, 'gh_request_rejected']) {
    assert.ok(UNKNOWN_REASONS.includes(reason))
  }
})

test('the board is not consulted without --gh', () => {
  const root = coldFixture('board-offline')
  const marker = join(fixtureRoot, 'board-offline-gh-called')
  const gh = fakeGh('board-offline-no-spawn', `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(marker)}, 'called')
`)
  const cell = withGhBin(gh, () => probeRepo({ checkout: root }).fields.intake_board)
  assert.deepEqual(cell, { status: 'unknown', value: null, reason: 'gh_not_consulted' })
  assert.equal(existsSync(marker), false)
})

test('a missing project scope names the scope rather than reporting no board', () => {
  const root = coldFixture('board-scope')
  const gh = fakeGh('board-scope-missing', `
process.stderr.write("Your token has not been granted the required scopes ... ['read:project']")
process.exit(1)
`)
  const cell = withGhBin(gh, () => probeRepo({ checkout: root, gh: true }).fields.intake_board)
  assert.equal(cell.status, 'unknown')
  assert.equal(cell.value, null)
  assert.equal(cell.reason, 'gh_scope_missing')
})

test('a repository with no linked project is an honest none_found', () => {
  const root = coldFixture('board-none')
  const gh = boardGh('board-none', { nodes: [] })
  const cell = withGhBin(gh, () => probeRepo({ checkout: root, gh: true }).fields.intake_board)
  assert.equal(cell.status, 'unknown')
  assert.equal(cell.value, null)
  assert.equal(cell.reason, 'none_found')
})

test('two linked projects refuse with the candidates named', () => {
  const root = coldFixture('board-multiple')
  const nodes = [
    { number: 3, title: 'First', closed: false, resourcePath: '/users/acme/projects/3', url: 'https://example.test/projects/3' },
    { number: 4, title: 'Second', closed: false, resourcePath: '/users/acme/projects/4', url: 'https://example.test/projects/4' },
  ]
  const cell = withGhBin(boardGh('board-multiple', { nodes }), () => (
    probeRepo({ checkout: root, gh: true }).fields.intake_board
  ))
  assert.equal(cell.reason, 'multiple_candidates')
  assert.deepEqual(cell.candidates, nodes.map(({ number, title, url }) => ({ number, title, url })))
})

test('a closed linked project is not a candidate', () => {
  const root = coldFixture('board-closed')
  const cell = withGhBin(boardGh('board-closed', {
    nodes: [{ number: 3, title: 'Closed', closed: true, resourcePath: '/users/acme/projects/3', url: 'https://example.test/projects/3' }],
  }), () => probeRepo({ checkout: root, gh: true }).fields.intake_board)
  assert.equal(cell.reason, 'none_found')
})

test('one linked project proposes the board, its ready column and its write-back columns', () => {
  const root = coldFixture('board-one')
  const node = { number: 3, title: 'Intake', closed: false, resourcePath: '/users/acme/projects/3', url: 'https://example.test/projects/3' }
  const fields = [
    { name: 'Status', options: [
      { name: 'Backlog' }, { name: ' Ready ' }, { name: 'In progress' }, { name: 'In review' }, { name: 'Done' },
    ] },
    { name: 'Priority', options: [{ name: 'P0' }, { name: 'P1' }] },
  ]
  const cell = withGhBin(boardGh('board-one', { nodes: [node], fields, title: 'Intake' }), () => (
    probeRepo({ checkout: root, gh: true }).fields.intake_board
  ))
  assert.equal(cell.status, 'proposed')
  assert.notEqual(cell.status, 'ratified')
  assert.deepEqual(cell.value, {
    owner: 'acme', project_number: 3, status_field: 'Status',
    ready_column: ' Ready ', work_column: 'In progress', review_column: 'In review',
  })
  assert.deepEqual(cell.detail.status_options, fields[0].options.map(({ name }) => name))
  assert.equal(cell.detail.columns_validated_at, 'probe')
  assert.deepEqual(cell.candidates, [{ number: 3, title: 'Intake', url: node.url }])
  assert.equal(cell.detail.owner_type, 'user')
})

test('a board with no ready/work/review triple is none_found, not a partial board', () => {
  const root = coldFixture('board-partial')
  const fields = [{ name: 'Status', options: [{ name: 'Todo' }, { name: 'Done' }] }]
  const cell = withGhBin(boardGh('board-partial', {
    nodes: [{ number: 3, title: 'Partial', closed: false, resourcePath: '/users/acme/projects/3', url: 'https://example.test/projects/3' }],
    fields,
  }), () => probeRepo({ checkout: root, gh: true }).fields.intake_board)
  assert.equal(cell.reason, 'none_found')
  assert.deepEqual(cell.candidates, ['Status'])
})

test('probing the same board twice proposes the same body', () => {
  const root = coldFixture('board-idempotent')
  const gh = boardGh('board-idempotent', {
    nodes: [{ number: 3, title: 'Stable', closed: false, resourcePath: '/users/acme/projects/3', url: 'https://example.test/projects/3' }],
    fields: [{ name: 'Status', options: [{ name: 'Ready' }, { name: 'In progress' }, { name: 'In review' }] }],
  })
  const first = withGhBin(gh, () => probeRepo({ checkout: root, gh: true }))
  const second = withGhBin(gh, () => probeRepo({ checkout: root, gh: true }))
  assert.equal(first.fields.intake_board.status, 'proposed')
  assert.equal(first.meta.body_digest, second.meta.body_digest)
  assert.equal(profileDigest(first), profileDigest(second))
})

test('the resolver refuses an absent field, an unratified field and a missing profile by distinct reasons', () => {
  const path = '/tmp/intake-board-profile.json'
  const absent = { schema: 1, repo_key: 'acme__repo', fields: {} }
  assert.throws(() => profileIntakeBoard(absent, { path }), (error) => (
    error instanceof ProfileRefusal && error.reason === 'profile-field-unknown'
  ))
  const proposed = {
    ...absent,
    fields: { [INTAKE_BOARD_FIELD]: { status: 'proposed', value: {} } },
  }
  assert.throws(() => profileIntakeBoard(proposed, { path }), (error) => (
    error instanceof ProfileRefusal && error.reason === 'profile-unratified'
  ))
  const factoryRoot = join(fixtureRoot, 'empty-intake-factory')
  mkdirSync(factoryRoot, { recursive: true })
  assert.throws(() => checkoutIntakeBoard({ checkout: ROOT, factoryRoot }), (error) => (
    error instanceof ProfileRefusal && error.reason === 'profile-unreadable'
  ))
  const reasons = ['profile-field-unknown', 'profile-unratified', 'profile-unreadable']
  assert.equal(new Set(reasons).size, reasons.length)
  for (const reason of reasons) assert.ok(INTAKE_BOARD_REFUSALS.includes(reason))
})

test('a ratified board resolves to intake\'s board and config', () => {
  const value = {
    owner: 'acme', project_number: 7, status_field: 'Status',
    ready_column: 'Ready', work_column: 'In progress', review_column: 'In review',
  }
  const profile = {
    schema: 1, repo_key: 'acme__repo', fields: {
      [INTAKE_BOARD_FIELD]: {
        status: 'ratified', value, source: 'human', ratified_by: 'test',
        ratified_at: '2026-08-17T00:00:00.000Z',
      },
    },
  }
  const resolved = profileIntakeBoard(profile, { path: '/tmp/profile.json' })
  assert.deepEqual(resolved.board, { owner: 'acme', projectNumber: 7 })
  assert.deepEqual(resolved.config, {
    statusField: 'Status', readyColumn: 'Ready', workColumn: 'In progress', reviewColumn: 'In review',
  })
  assert.deepEqual(Object.keys(resolved.config).sort(), [
    'statusField', 'readyColumn', 'workColumn', 'reviewColumn',
  ].sort())
  assert.equal(resolved.basis, 'ratified profile field intake_board · /tmp/profile.json')
})

test('a ratified board that cannot drive the loop is refused', () => {
  const base = {
    owner: 'acme', project_number: 7, status_field: 'Status',
    ready_column: 'Ready', work_column: 'In progress', review_column: 'In review',
  }
  const cases = [
    ['missing review_column', (value) => { delete value.review_column }],
    ['project_number: 0', (value) => { value.project_number = 0 }],
    ['owner: empty', (value) => { value.owner = '' }],
    ['ready/work collision', (value) => { value.work_column = value.ready_column }],
    ['value not object', () => null],
  ]
  for (const [label, mutate] of cases) {
    const value = { ...base }
    const mutated = mutate(value)
    const profile = {
      schema: 1, repo_key: 'acme__repo', fields: {
        [INTAKE_BOARD_FIELD]: {
          status: 'ratified', value: mutated === null ? null : value,
          source: 'human', ratified_by: 'test', ratified_at: '2026-08-17T00:00:00.000Z',
        },
      },
    }
    assert.throws(() => profileIntakeBoard(profile, { path: `/tmp/${label}.json` }), (error) => (
      error instanceof ProfileRefusal && error.reason === 'intake-board-invalid'
    ), label)
  }
})

test('self-hosting: the board is proposed from this repository or honestly refused', () => {
  const cell = probeRepo({ checkout: ROOT, gh: true }).fields.intake_board
  const unknownReasons = [
    'gh_unavailable', 'gh_unauthenticated', 'gh_scope_missing', 'gh_request_rejected',
    'none_found', 'multiple_candidates',
  ]
  if (cell.status === 'unknown') {
    assert.ok(unknownReasons.includes(cell.reason), cell.reason)
    return
  }
  assert.equal(cell.status, 'proposed')
  assert.equal(typeof cell.value.owner, 'string')
  assert.ok(Number.isInteger(cell.value.project_number) && cell.value.project_number > 0)
  for (const key of ['ready_column', 'work_column', 'review_column']) {
    assert.equal(typeof cell.value[key], 'string')
    assert.ok(cell.value[key].trim())
    assert.ok(cell.detail.status_options.includes(cell.value[key]))
  }
  assert.equal(new Set([
    cell.value.ready_column, cell.value.work_column, cell.value.review_column,
  ]).size, 3)
})

test('a cold checkout has only proposed or honest unknown cells', () => {
  const root = coldFixture()
  const profile = probeRepo({ checkout: root })
  everyCell(profile)
  assert.equal(profile.fields.test_command.status, 'unknown')
  assert.equal(profile.fields.test_command.value, null)
  assert.equal(profile.fields.test_command.reason, 'no_test_command')
  assert.equal(profile.fields.default_branch.reason, 'no_remote_head')
  assert.equal(Object.values(profile.fields).some((field) => field.status === 'ratified'), false)
})

test('disagreeing package and workflow candidates are not silently selected', () => {
  const root = nextRoot('disagreement')
  nodePackage(root)
  put(root, '.github/workflows/check.yml', [
    'name: check',
    'on: push',
    'jobs:',
    '  check:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: make check',
    '',
  ].join('\n'))
  initGit(root)
  const cell = probeRepo({ checkout: root }).fields.test_command
  assert.equal(cell.status, 'unknown')
  assert.equal(cell.value, null)
  assert.equal(cell.reason, 'multiple_candidates')
  assert.deepEqual(cell.candidates.map((candidate) => candidate.command), ['make check', 'npm test'])
})

test('toolchain markers refuse to choose between languages', () => {
  const root = nextRoot('toolchains')
  put(root, 'package.json', '{}\n')
  put(root, 'Cargo.toml', '[package]\nname = "fixture"\n')
  initGit(root)
  const cell = probeRepo({ checkout: root }).fields.toolchain
  assert.equal(cell.status, 'unknown')
  assert.equal(cell.value, null)
  assert.equal(cell.reason, 'multiple_candidates')
  assert.deepEqual(cell.candidates, ['node', 'rust'])
})

test('baseline reports parsed counts only after a green command', () => {
  const root = nodeFixture('green')
  const profile = probeRepo({ checkout: root, baseline: true })
  assert.deepEqual(profile.fields.baseline, {
    status: 'proposed',
    value: { tests: 2, passed: 2, failed: 0 },
    source: 'baseline command',
  })
  assert.equal(profile.meta.baseline_command, 'npm test')
  assert.equal(typeof profile.meta.baseline_duration_ms, 'number')
})

test('baseline failure, parse failure, and disabled measurement stay unknown/null', () => {
  const red = nodeFixture('red', 'node -e "console.error(\'fail\'); process.exit(3)"')
  const redCell = probeRepo({ checkout: red, baseline: true }).fields.baseline
  assert.equal(redCell.status, 'unknown')
  assert.equal(redCell.value, null)
  assert.equal(redCell.reason, 'suite_failed')

  const unparsed = nodeFixture('unparsed', 'node -e "console.log(\'no summary\')"')
  const unparsedCell = probeRepo({ checkout: unparsed, baseline: true }).fields.baseline
  assert.equal(unparsedCell.status, 'unknown')
  assert.equal(unparsedCell.value, null)
  assert.equal(unparsedCell.reason, 'suite_unparsed')

  const disabled = nodeFixture('disabled')
  const disabledCell = probeRepo({ checkout: disabled }).fields.baseline
  assert.equal(disabledCell.status, 'unknown')
  assert.equal(disabledCell.value, null)
  assert.equal(disabledCell.reason, 'not_measured')
})

test('baseline and ordinary probing do not mutate a checkout', () => {
  const cold = coldFixture('snapshot-cold')
  const beforeCold = snapshot(cold)
  probeRepo({ checkout: cold })
  assert.deepEqual(snapshot(cold), beforeCold)

  const node = nodeFixture('snapshot-node')
  const beforeNode = snapshot(node)
  probeRepo({ checkout: node, baseline: true })
  assert.deepEqual(snapshot(node), beforeNode)
})

test('profile body and digest are idempotent while metadata may vary', () => {
  const root = nodeFixture('idempotent')
  const first = probeRepo({ checkout: root })
  const second = probeRepo({ checkout: root })
  assert.deepEqual(profileBody(first), profileBody(second))
  assert.equal(first.meta.body_digest, second.meta.body_digest)
  const bodyText = JSON.stringify(profileBody(first))
  assert.equal(bodyText.includes(root), false)
  assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(bodyText), false)
})

test('protected-path candidates are proposed, source-labelled, and sorted', () => {
  const root = nextRoot('protected')
  nodePackage(root)
  put(root, '.github/workflows/test.yml', 'name: test\n')
  put(root, 'infra/main.tf', 'resource "x" "y" {}\n')
  put(root, 'src/auth/session-token.js', 'export {}\n')
  put(root, 'package-lock.json', '{}\n')
  initGit(root)
  const cell = probeRepo({ checkout: root }).fields.protected_paths_candidates
  assert.equal(cell.status, 'proposed')
  assert.equal(cell.source, 'heuristic')
  assert.ok(cell.value.includes('.github/workflows/'))
  assert.ok(cell.value.includes('infra/'))
  assert.ok(cell.value.includes('package-lock.json'))
  assert.ok(cell.value.includes('src/auth/session-token.js'))
  assert.deepEqual(cell.value, [...cell.value].sort())
  assert.ok(Object.isFrozen(PROTECTED_PATH_PATTERNS))
})

test('requireField refuses proposed, unknown, and absent cells but passes ratification', () => {
  const root = coldFixture('refusal')
  const profile = probeRepo({ checkout: root })
  assert.throws(() => requireField(profile, 'default_branch'), (error) => {
    assert.ok(error instanceof ProfileRefusal)
    assert.match(error.message, /default_branch/)
    assert.match(error.message, /unknown/)
    assert.equal(error.reason, 'no_remote_head')
    return true
  })
  assert.throws(() => requireField(profile, 'test_command'), (error) => {
    assert.ok(error instanceof ProfileRefusal)
    assert.match(error.message, /test_command/)
    assert.equal(error.reason, 'no_test_command')
    return true
  })
  assert.throws(() => requireField(profile, 'missing'), (error) => {
    assert.ok(error instanceof ProfileRefusal)
    assert.match(error.message, /missing/)
    assert.equal(error.reason, 'profile-field-unknown')
    return true
  })
  const ratified = {
    ...profile,
    fields: {
      ...profile.fields,
      test_command: {
        status: 'ratified', value: 'npm test', source: 'human',
        ratified_by: 'test', ratified_at: '2026-08-16T00:00:00.000Z',
      },
    },
  }
  assert.equal(requireField(ratified, 'test_command'), 'npm test')
  assert.ok(Object.isFrozen(LOAD_BEARING))
})

test('assertRunnable refuses the first unratified load-bearing cell and passes after both edits', () => {
  const root = nodeFixture('runnable')
  const profile = probeRepo({ checkout: root })
  assert.throws(() => assertRunnable(profile), (error) => {
    assert.match(error.message, /test_command/)
    return true
  })
  const ratified = {
    ...profile,
    fields: {
      ...profile.fields,
      test_command: {
        status: 'ratified', value: 'npm test', source: 'human',
        ratified_by: 'test', ratified_at: '2026-08-16T00:00:00.000Z',
      },
      default_branch: {
        status: 'ratified', value: 'main', source: 'human',
        ratified_by: 'test', ratified_at: '2026-08-16T00:00:00.000Z',
      },
    },
  }
  assert.deepEqual(assertRunnable(ratified), { test_command: 'npm test', default_branch: 'main' })
})

test('malformed human ratification is refused and never survives a re-probe merge', () => {
  const root = coldFixture('malformed-ratification')
  const profile = probeRepo({ checkout: root })
  const malformed = {
    ...profile,
    fields: {
      ...profile.fields,
      test_command: {
        ...profile.fields.test_command,
        status: 'ratified',
        source: 'human',
        ratified_by: 'human',
        ratified_at: '2026-08-16T00:00:00.000Z',
      },
    },
  }
  assert.throws(() => requireField(malformed, 'test_command'), (error) => {
    assert.ok(error instanceof ProfileRefusal)
    assert.equal(error.reason, 'profile-ratification-invalid')
    assert.match(error.message, /test_command.*ratified.*invalid/)
    return true
  })

  const out = join(fixtureRoot, 'profiles', 'malformed-ratification.json')
  writeProfile({ profile, out, checkout: root })
  const persisted = readProfile(out)
  persisted.fields.test_command = malformed.fields.test_command
  writeFileSync(out, `${JSON.stringify(persisted, null, 2)}\n`)
  writeProfile({ profile: probeRepo({ checkout: root }), out, checkout: root })
  const repaired = readProfile(out).fields.test_command
  assert.equal(repaired.status, 'unknown')
  assert.equal(repaired.value, null)
  assert.equal(repaired.reason, 'no_test_command')
  assert.throws(() => requireField(readProfile(out), 'test_command'), (error) => {
    assert.equal(error.reason, 'no_test_command')
    return true
  })
})

test('writer refuses every output path inside the checkout before creating it', () => {
  const root = coldFixture('writer-boundary')
  const profile = probeRepo({ checkout: root })
  const inside = join(root, 'nested', 'profile.json')
  assert.throws(() => writeProfile({ profile, out: inside, checkout: root }), (error) => {
    assert.ok(error instanceof ProfileRefusal)
    assert.equal(error.reason, 'writes-into-checkout')
    return true
  })
  assert.equal(existsSync(inside), false)

  const omittedCheckout = join(fixtureRoot, 'omitted-checkout-profile.json')
  assert.throws(() => writeProfile({ profile, out: omittedCheckout }), (error) => {
    assert.equal(error.reason, 'missing-checkout')
    return true
  })
  assert.equal(existsSync(omittedCheckout), false)
})

test('writer preserves an unchanged ratification and supersedes a changed one', () => {
  const root = nodeFixture('ratification')
  const out = join(fixtureRoot, 'profiles', 'ratification.json')
  const first = probeRepo({ checkout: root })
  writeProfile({ profile: first, out, checkout: root })
  const handEdited = readProfile(out)
  handEdited.fields.test_command = {
    ...handEdited.fields.test_command,
    status: 'ratified',
    ratified_by: 'human',
    ratified_at: '2026-08-16T00:00:00.000Z',
  }
  writeFileSync(out, `${JSON.stringify(handEdited, null, 2)}\n`)
  writeProfile({ profile: probeRepo({ checkout: root }), out, checkout: root })
  assert.equal(readProfile(out).fields.test_command.status, 'ratified')
  assert.equal(readProfile(out).fields.test_command.ratified_by, 'human')

  rmSync(join(root, 'package.json'))
  put(root, 'Cargo.toml', '[package]\nname = "changed"\n')
  const changed = probeRepo({ checkout: root })
  writeProfile({ profile: changed, out, checkout: root })
  const final = readProfile(out).fields.test_command
  assert.equal(final.status, 'proposed')
  assert.equal(final.value, 'cargo test')
  assert.deepEqual(final.superseded_ratification, 'npm test')
})

test('default profile path uses the factory root and remote key', () => {
  assert.equal(
    defaultProfilePath({ repoKey: 'owner__repo', factoryRoot: '/tmp/factory' }),
    '/tmp/factory/profiles/owner__repo.json',
  )
})

test('CLI usage, output, syntax, and a no-test-command profile are honest', () => {
  const root = coldFixture('cli')
  const good = captureMain(['--checkout', root])
  assert.equal(good.code, 0)
  assert.equal(JSON.parse(good.stdout).fields.test_command.reason, 'no_test_command')
  assert.equal(good.stderr, '')
  assert.equal(captureMain([]).code, 2)
  assert.match(captureMain(['--checkout', root, '--bogus']).stderr, /\[reason:/)
  assert.equal(captureMain(['--checkout', root, '--baseline', '--baseline']).code, 2)
  assert.equal(captureMain(['--checkout', root, 'extra']).code, 2)
  assert.equal(captureMain(['--checkout', join(root, 'missing')]).code, 2)

  const syntax = spawnSync(process.execPath, ['--check', SCRIPT], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
  const subprocess = spawnSync(process.execPath, [SCRIPT, '--checkout', root], { encoding: 'utf8' })
  assert.equal(subprocess.status, 0, subprocess.stderr)
  assert.equal(JSON.parse(subprocess.stdout).repo_key, `local__${basename(root)}`)
})

test('CLI --out and --save write outside the checkout only', () => {
  const root = coldFixture('cli-write')
  const out = join(fixtureRoot, 'cli-output', 'profile.json')
  const result = captureMain(['--checkout', root, '--out', out])
  assert.equal(result.code, 0)
  assert.equal(result.stdout, '')
  assert.equal(readProfile(out).schema, PROFILE_VERSION)
  assert.equal(captureMain(['--checkout', root, '--out', '']).code, 2)
  assert.equal(captureMain(['--checkout', root, '--out', '', '--save']).code, 2)

  const factoryRoot = join(fixtureRoot, 'save-factory-root')
  const previousFactoryRoot = process.env.DEVTEAM_FACTORY_DIR
  process.env.DEVTEAM_FACTORY_DIR = factoryRoot
  try {
    const saved = captureMain(['--checkout', root, '--save'])
    assert.equal(saved.code, 0)
    assert.equal(saved.stdout, '')
    const savedPath = defaultProfilePath({
      repoKey: probeRepo({ checkout: root }).repo_key,
      factoryRoot,
    })
    assert.equal(readProfile(savedPath).schema, PROFILE_VERSION)
  } finally {
    if (previousFactoryRoot === undefined) delete process.env.DEVTEAM_FACTORY_DIR
    else process.env.DEVTEAM_FACTORY_DIR = previousFactoryRoot
  }

  assert.equal(captureMain(['--checkout', root, '--out', out, '--save']).code, 2)
})

test('field kinds are declared in one place and cover every profile field', () => {
  const root = coldFixture('field-kinds')
  const fields = probeRepo({ checkout: root }).fields
  assert.ok(Object.isFrozen(FIELD_KINDS))
  assert.deepEqual(Object.keys(FIELD_KINDS).sort(), Object.keys(fields).sort())
  assert.ok(Object.values(FIELD_KINDS).every((kind) => FIELD_KIND_NAMES.includes(kind)))
  assert.equal(FIELD_KINDS.baseline, 'commit_scoped')
  assert.equal(FIELD_KINDS.protected_paths_candidates, 'authored_superset')
  for (const name of [
    'toolchain', 'test_command', 'ci', 'conventions', 'default_branch', 'pr_conventions', 'intake_board',
  ]) assert.equal(FIELD_KINDS[name], 'stable')
  assert.equal(LOAD_BEARING.includes('intake_board'), false)
  assert.equal(fieldKind('a_field_that_does_not_exist'), 'stable')
  assert.equal(isRatifiable('baseline'), false)
})

test('a commit-scoped baseline ratification is refused and never carried forward', () => {
  const root = nextRoot('commit-scoped-baseline')
  put(root, '.github/workflows/test.yml', [
    'name: test',
    'on: push',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: node --test',
    '',
  ].join('\n'))
  put(root, 'test/one.test.mjs', [
    "import { test } from 'node:test'",
    "test('one', () => {})",
    '',
  ].join('\n'))
  initGit(root)
  const first = probeRepo({ checkout: root, baseline: true })
  assert.equal(first.fields.test_command.value, 'node --test')
  assert.equal(first.fields.baseline.status, 'proposed')
  const handValue = first.fields.baseline.value
  const out = join(fixtureRoot, 'profiles', 'commit-scoped-baseline.json')
  writeProfile({ profile: first, out, checkout: root })
  const handEdited = readProfile(out)
  handEdited.fields.baseline = {
    ...handEdited.fields.baseline,
    status: 'ratified',
    source: 'human',
    ratified_by: 'human',
    ratified_at: '2026-08-16T00:00:00.000Z',
  }
  writeFileSync(out, `${JSON.stringify(handEdited, null, 2)}\n`)
  assert.throws(() => requireField(handEdited, 'baseline'), (err) => (
    err instanceof ProfileRefusal && err.reason === 'profile-ratification-refused'
  ))

  writeProfile({ profile: probeRepo({ checkout: root, baseline: true }), out, checkout: root })
  const merged = readProfile(out).fields.baseline
  assert.notEqual(merged.status, 'ratified')
  assert.deepEqual(merged.refused_ratification, handValue)
})

test('the read boundary refuses a ratified commit-scoped cell and still serves stable ones', () => {
  const profile = {
    schema: 1,
    profile_version: 1,
    repo_key: 'owner__repo',
    fields: {
      baseline: {
        status: 'ratified', value: { passed: 1173 }, source: 'human',
        ratified_by: 'human', ratified_at: '2026-08-16T00:00:00.000Z',
      },
      test_command: {
        status: 'ratified', value: 'node --test', source: 'human',
        ratified_by: 'human', ratified_at: '2026-08-16T00:00:00.000Z',
      },
    },
    meta: {},
  }
  assert.throws(() => requireField(profile, 'baseline'), (err) => (
    err instanceof ProfileRefusal
      && err.reason === 'profile-ratification-refused'
      && err.message.includes('commit_scoped')
      && err.message.includes('evidence only')
  ))
  assert.equal(requireField(profile, 'test_command'), 'node --test')
  assert.deepEqual(assertRunnable({ ...profile, fields: {
    ...profile.fields,
    default_branch: {
      status: 'ratified', value: 'main', source: 'human',
      ratified_by: 'human', ratified_at: '2026-08-16T00:00:00.000Z',
    },
  } }), { test_command: 'node --test', default_branch: 'main' })
})

test('the shared protected-path rule adds, falls back, and refuses every broken ratified cell by name', () => {
  const makeRatified = (value) => ({
    status: 'ratified', value, source: 'human',
    ratified_by: 'human', ratified_at: '2026-08-16T00:00:00.000Z',
  })
  const floor = profileProtectedPaths(null, { path: '/tmp/missing-profile.json' })
  assert.equal(floor.used, false)
  assert.ok(floor.paths.length > 0)
  assert.match(floor.basis, /authored floor.*missing-profile/)

  const used = profileProtectedPaths({
    repo_key: 'owner__repo',
    fields: {
      protected_paths_candidates: {
        status: 'ratified', value: ['db/migrations/'], source: 'human',
        ratified_by: 'human', ratified_at: '2026-08-16T00:00:00.000Z',
      },
    },
  }, { path: '/tmp/profile.json' })
  assert.equal(used.used, true)
  assert.ok(used.paths.includes('db/migrations/'))
  assert.match(used.basis, /protected_paths_candidates.*profile\.json/)

  for (const profile of [
    { fields: {} },
    { fields: { protected_paths_candidates: { status: 'proposed', value: ['db/migrations/'], source: 'heuristic' } } },
  ]) {
    const result = profileProtectedPaths(profile, { path: '/tmp/profile.json' })
    assert.equal(result.used, false)
    assert.equal(result.paths.includes('db/migrations/'), false)
  }
  for (const value of ['db/migrations/', ['db/migrations/', '  '], ['db/migrations/', 7]]) {
    assert.throws(() => profileProtectedPaths({
      repo_key: 'owner__repo',
      fields: { protected_paths_candidates: makeRatified(value) },
    }, { path: '/tmp/profile.json' }), (err) => (
      err instanceof ProfileRefusal
        && err.reason === 'protected-paths-invalid'
        && err.message.includes('protected-paths-invalid')
    ))
  }
  const brokenMetadata = makeRatified(['db/migrations/'])
  delete brokenMetadata.ratified_by
  assert.throws(() => profileProtectedPaths({ repo_key: 'owner__repo', fields: { protected_paths_candidates: brokenMetadata } }, { path: '/tmp/profile.json' }), (err) => err.reason === 'protected-paths-invalid')

  const checkout = coldFixture('protected-paths-wrapper')
  const path = join(fixtureRoot, 'profiles', 'protected-paths-wrapper.json')
  writeFileSync(path, `${JSON.stringify({ repo_key: 'owner__repo', fields: { protected_paths_candidates: makeRatified(['db/migrations/']) } }, null, 2)}\n`)
  const viaWrapper = checkoutProtectedPaths({ checkout, profilePath: path })
  const viaRule = profileProtectedPaths(readProfile(path), { path })
  assert.deepEqual(viaWrapper.paths, viaRule.paths)
  assert.equal(viaWrapper.used, viaRule.used)
})

test('an authored-superset ratification survives a narrower probe and surfaces additions', () => {
  const root = nextRoot('authored-superset')
  nodePackage(root)
  put(root, '.github/workflows/test.yml', 'name: test\n')
  put(root, 'package-lock.json', '{}\n')
  put(root, 'src/auth/session-token.js', 'export {}\n')
  put(root, 'crew/drive.mjs', 'export {}\n')
  put(root, 'crew/breaker.mjs', 'export {}\n')
  initGit(root)

  const first = probeRepo({ checkout: root })
  const probeValue = first.fields.protected_paths_candidates.value
  const authored = [...probeValue, 'crew/drive.mjs', 'crew/breaker.mjs'].sort()
  assert.ok(authored.length > probeValue.length)
  const out = join(fixtureRoot, 'profiles', 'authored-superset.json')
  writeProfile({ profile: first, out, checkout: root })
  const handEdited = readProfile(out)
  handEdited.fields.protected_paths_candidates = {
    ...handEdited.fields.protected_paths_candidates,
    status: 'ratified',
    value: authored,
    source: 'human',
    ratified_by: 'human',
    ratified_at: '2026-08-16T00:00:00.000Z',
  }
  writeFileSync(out, `${JSON.stringify(handEdited, null, 2)}\n`)

  writeProfile({ profile: probeRepo({ checkout: root }), out, checkout: root })
  const preserved = readProfile(out).fields.protected_paths_candidates
  assert.equal(preserved.status, 'ratified')
  assert.deepEqual(preserved.value, authored)
  assert.equal(preserved.superseded_ratification, undefined)
  assert.equal(preserved.probe_additions, undefined)

  const omittedEntry = probeValue[probeValue.length - 1]
  const narrowed = [...probeValue.slice(0, -1), 'crew/drive.mjs', 'crew/breaker.mjs'].sort()
  const narrowedProfile = readProfile(out)
  narrowedProfile.fields.protected_paths_candidates = {
    ...narrowedProfile.fields.protected_paths_candidates,
    status: 'ratified',
    value: narrowed,
    source: 'human',
    ratified_by: 'human',
    ratified_at: '2026-08-16T00:00:00.000Z',
  }
  writeFileSync(out, `${JSON.stringify(narrowedProfile, null, 2)}\n`)
  writeProfile({ profile: probeRepo({ checkout: root }), out, checkout: root })
  const additions = readProfile(out).fields.protected_paths_candidates
  assert.equal(additions.status, 'ratified')
  assert.deepEqual(additions.value, narrowed)
  assert.deepEqual(additions.probe_additions, [omittedEntry])
})

test('stable fields keep today\'s merge behaviour', () => {
  const root = nodeFixture('stable-merge')
  const first = probeRepo({ checkout: root })
  const out = join(fixtureRoot, 'profiles', 'stable-merge.json')
  writeProfile({ profile: first, out, checkout: root })
  const handEdited = readProfile(out)
  handEdited.fields.toolchain = {
    ...handEdited.fields.toolchain,
    status: 'ratified',
    source: 'human',
    ratified_by: 'human',
    ratified_at: '2026-08-16T00:00:00.000Z',
  }
  writeFileSync(out, `${JSON.stringify(handEdited, null, 2)}\n`)

  writeProfile({ profile: probeRepo({ checkout: root }), out, checkout: root })
  const preserved = readProfile(out).fields.toolchain
  assert.equal(preserved.status, 'ratified')
  assert.equal(preserved.ratified_by, 'human')
  assert.equal(preserved.ratified_at, '2026-08-16T00:00:00.000Z')

  rmSync(join(root, 'package.json'))
  put(root, 'Cargo.toml', '[package]\nname = "changed"\n')
  writeProfile({ profile: probeRepo({ checkout: root }), out, checkout: root })
  const changed = readProfile(out).fields.toolchain
  assert.equal(changed.status, 'proposed')
  assert.equal(changed.value, 'rust')
  assert.equal(changed.superseded_ratification, 'node')
  assert.equal(changed.probe_additions, undefined)
  assert.equal(changed.refused_ratification, undefined)
})
