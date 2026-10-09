// test/factory-probe-repo.test.mjs — filesystem-only coverage for the
// read-only repo profile proposer. Fixtures are disposable git directories;
// no live profile roots, home directories, or network calls are used.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { ROOT, scratchDir } from './helpers.mjs'
import { slug } from '../crew/slug.mjs'
import {
  FIELD_KIND_NAMES, FIELD_KINDS, IDIOM_CLASSES, IDIOM_UNMEASURED_REASONS, INTAKE_BOARD_FIELD, INTAKE_BOARD_REFUSALS,
  INTAKE_COLUMN_ROLES, LOAD_BEARING, PROFILE_VERSION,
  PROTECTED_PATH_PATTERNS, ProfileRefusal, UNKNOWN_REASONS, assertRunnable,
  checkoutIntakeBoard, checkoutProtectedPaths, checkoutTestRunner, classifyTestRunner, defaultProfilePath, fieldKind, isRatifiable, main,
  probeRepo, profileBody, profileDigest, profileIntakeBoard, profileProtectedPaths, readProfile,
  requireField, writeProfile, checkoutBaseBranch, isPlainBranchName, BASE_BRANCH_REFUSALS,
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

test('NR4', () => {
  const root = scratchDir('probe-test-runner-')
  const checkout = join(root, 'checkout')
  mkdirSync(checkout)
  const profilePath = join(root, 'profile.json')
  const ratified = (value) => ({ status: 'ratified', value, source: 'fixture', ratified_by: 'operator', ratified_at: 'now' })
  const write = (field) => writeFileSync(profilePath, JSON.stringify({ repo_key: 'fixture', fields: { test_command: field } }))
  const options = { checkout, profilePath }
  const classifications = [
    ['  cargo test --workspace  ', 'cargo'], ['npm test', 'node'],
    ['make test', 'unparsed'], ['', 'unparsed'], ['   ', 'unparsed'], [null, 'unparsed'],
    ['mystery -- cargo test', 'unparsed'], ['env cargo test', 'unparsed'],
    ['/usr/bin/node --test', 'node'],
  ]
  for (const executable of ['node', 'npm', 'npx', 'yarn', 'pnpm']) classifications.push([`${executable} test`, 'node'])
  for (const [command, expected] of classifications) assert.equal(classifyTestRunner(command), expected, String(command))

  for (const [command, runner] of [['cargo test', 'cargo'], ['npm test', 'node'], ['make test', 'unparsed']]) {
    write(ratified(command))
    const result = checkoutTestRunner(options)
    assert.equal(result.runner, runner)
    assert.match(result.basis, /ratified profile field test_command/)
    assert.ok(result.basis.includes(profilePath))
  }
  const missingPath = join(root, 'missing.json')
  const missing = checkoutTestRunner({ checkout, profilePath: missingPath })
  assert.equal(missing.runner, 'node')
  assert.ok(missing.basis.includes(missingPath))
  for (const body of ['{', '']) {
    writeFileSync(profilePath, body)
    const result = checkoutTestRunner(options)
    assert.equal(result.runner, 'node')
    assert.ok(result.basis.includes(profilePath))
  }
  for (const field of [ratified('cargo test') && { ...ratified('cargo test'), status: 'proposed' }, { status: 'unknown' }, undefined]) {
    write(field)
    const result = checkoutTestRunner(options)
    assert.equal(result.runner, 'node')
    assert.match(result.basis, /test_command.*(?:proposed|unknown)/)
    assert.ok(result.basis.includes(profilePath))
  }
  write({ status: 'ratified', value: 'cargo test', source: 'fixture' })
  assert.throws(() => checkoutTestRunner(options), (error) => error instanceof ProfileRefusal && error.reason === 'profile-ratification-invalid')
})

test('checkoutTestRunner classifies an explicit --suite that differs from the ratified test_command', () => {
  const root = scratchDir('probe-test-runner-suite-')
  const profilePath = join(root, 'profile.json')
  writeFileSync(profilePath, JSON.stringify({ repo_key: 'fixture', fields: { test_command: { status: 'ratified', value: 'npm test', source: 'fixture', ratified_by: 'operator', ratified_at: 'now' } } }))
  const options = { checkout: root, profilePath }
  const overridden = checkoutTestRunner({ ...options, suite: ' cargo test --workspace ' })
  assert.equal(overridden.runner, 'cargo')
  assert.match(overridden.basis, /^run --suite "cargo test --workspace" · overrides ratified profile field test_command/)
  for (const suite of [undefined, null, '', '  ', ' npm test ']) {
    assert.deepEqual(checkoutTestRunner({ ...options, suite }), checkoutTestRunner(options), String(suite))
  }
  assert.equal(checkoutTestRunner({ checkout: root, profilePath: join(root, 'missing.json'), suite: 'cargo test' }).runner, 'cargo')
})

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
  // The DERIVED value is what to compare against: probeRepo runs the name through
  // slug(), so the raw basename matches only while the directory name happens to
  // be its own slug. dt-b231-helperdedupB was the worktree where it did not.
  assert.equal(profile.repo_slug, slug(basename(ROOT)))
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
  assert.equal(workflow.jobs[0].check_name, 'test (node 26)')
  assert.ok(profile.fields.conventions.value.files.includes('docs/conventions.md'))
  // CLAUDE.md is the FIRST name gatherConventions looks for, and this repo now
  // ships one. The previous assertion pinned its ABSENCE, which was a fact
  // about the repo rather than a contract, and it went stale the moment the
  // file landed. Pinning the presence keeps the detector honest instead.
  assert.ok(profile.fields.conventions.value.files.includes('CLAUDE.md'))
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

// The ROOT assertion above cannot prove the derivation on its own: in a worktree
// whose directory name is already its own slug, basename(ROOT) and
// slug(basename(ROOT)) agree, so the raw-basename spelling passed for as long as
// every lane name happened to be lowercase. This pins the rule against a path
// that is NOT its own slug. coldFixture reuses the file's single fixtureRoot on
// purpose: test/factory-env.test.mjs freezes this file at exactly one mkdtemp
// call site, by equality, so a fixture root of its own would turn that red.
test('repo_slug is slugified, so an uppercase checkout directory still probes', () => {
  const root = coldFixture('Upper-Case')
  assert.notEqual(basename(root), slug(basename(root)))
  const profile = probeRepo({ checkout: root })
  assert.equal(profile.repo_slug, slug(basename(root)))
  assert.match(profile.repo_slug, /^[a-z0-9-]+$/)
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

test('R1 ratified checkout base resolves the profile branch', () => {
  const root = nextRoot('R1'), path = put(root, 'profile.json', JSON.stringify({ repo_key: 'fixture', fields: { default_branch: { status: 'ratified', value: 'dispute', source: 'test', ratified_by: 'operator', ratified_at: 'now' } } }))
  const result = checkoutBaseBranch({ checkout: root, profilePath: path })
  assert.equal(result.branch, 'dispute'); assert.ok(result.basis.includes(path))
})
test('R2 absent profile alone selects main', () => {
  const root = nextRoot('R2'), path = join(root, 'absent.json')
  assert.match(checkoutBaseBranch({ checkout: root, profilePath: path }).basis, /default base branch main/)
})
test('R3 proposed base field refuses', () => {
  const root = nextRoot('R3'), path = put(root, 'profile.json', JSON.stringify({ fields: { default_branch: { status: 'proposed', value: 'dispute', source: 'test' } } }))
  assert.throws(() => checkoutBaseBranch({ checkout: root, profilePath: path }), e => e.reason === 'profile-unratified')
})
test('R4 branch grammar and frozen refusal vocabulary', () => {
  for (const value of ['-x', 'a b', '', 'a..b', 'a\0b', 'a\nb', 'a\x7fb', 'bad..name']) assert.equal(isPlainBranchName(value), false)
  assert.equal(isPlainBranchName('feature/dispute'), true)
  assert.deepEqual(BASE_BRANCH_REFUSALS, ['profile-unreadable','profile-field-unknown','profile-unratified','profile-ratification-invalid','profile-ratification-refused','base-branch-invalid'])
  assert.equal(Object.isFrozen(BASE_BRANCH_REFUSALS), true)
})
test('R5 present malformed profile refuses unreadable', () => {
  const root = nextRoot('R5'), path = put(root, 'profile.json', '{')
  assert.throws(() => checkoutBaseBranch({ checkout: root, profilePath: path }), e => e.reason === 'profile-unreadable')
  // MUTATION: treat every stat error as absent; ENOTDIR must refuse, never default to main.
  assert.throws(() => checkoutBaseBranch({ checkout: root, profilePath: join(path, 'nested.json') }), e => e.reason === 'profile-unreadable')
  // MUTATION R6: probe presence with statSync again; a dangling profile symlink must refuse, never default to main.
  const dangling = join(root, 'dangling-profile.json')
  symlinkSync(join(root, 'missing-target.json'), dangling)
  assert.throws(() => checkoutBaseBranch({ checkout: root, profilePath: dangling }), e => e.reason === 'profile-unreadable')
})
test('idiom density measures comment lines per 100 code lines', () => {
  const root = nextRoot('idiom-density')
  const lines = ['function density() {']
  for (let i = 0; i < 10; i += 1) lines.push('// note ' + i)
  for (let i = 0; i < 97; i += 1) lines.push('  const item' + i + ' = ' + i)
  lines.push('  return item0', '}')
  for (let i = 0; i < 27; i += 1) lines.splice(8, 0, '')
  put(root, 'density.mjs', lines.join('\n') + '\n')
  initGit(root, { commit: true })
  const value = probeRepo({ checkout: root }).fields.conventions.value
  assert.deepEqual(value.idiom_scan, { files_scanned: 1, files_skipped_by_extension: 0, extensions: ['.mjs'] })
  const entry = value.idioms.find((idiom) => idiom.class === 'comment_density')
  assert.equal(entry.sample_size, 1)
  assert.equal(entry.value, 10)
  assert.ok(entry.rule.includes('10 comment lines per 100 code lines'))
  assert.ok(entry.rule.includes('sample_size 1'))
  assert.equal(entry.basis, 'line comment/code density')
  assert.deepEqual(entry.exemplars.map((ex) => ex.name), ['density'])
  const span = entry.exemplars[0]
  const body = readFileSync(join(root, span.path), 'utf8').split('\n')
  assert.ok(body.slice(span.start - 1, span.end).join('\n').includes('function density('))
})

test('idiom readme-only checkout is honestly unmeasured', () => {
  const root = coldFixture('idiom-readme')
  git(root, 'add', 'README.md')
  const value = probeRepo({ checkout: root }).fields.conventions.value
  assert.deepEqual(value.idiom_scan, { files_scanned: 0, files_skipped_by_extension: 1, extensions: [] })
  assert.deepEqual(IDIOM_CLASSES, ['dependency_injection', 'boolean_helpers', 'logging_placement', 'error_retry_shape', 'comment_density'])
  assert.equal(Object.isFrozen(IDIOM_CLASSES), true)
  assert.equal(Object.isFrozen(IDIOM_UNMEASURED_REASONS), true)
  assert.deepEqual([...IDIOM_UNMEASURED_REASONS].sort(), ['insufficient_sample', 'ls_files_failed', 'ls_files_oversized', 'no_exemplar', 'no_majority', 'no_sample', 'no_sources', 'source_path_invalid', 'source_read_failed'])
  assert.deepEqual(value.idioms.map((idiom) => idiom.class), ['dependency_injection', 'boolean_helpers', 'logging_placement', 'error_retry_shape', 'comment_density'])
  for (const entry of value.idioms) {
    assert.equal(entry.rule, null)
    assert.deepEqual(entry.exemplars, [])
    assert.equal(entry.basis, null)
    assert.equal(entry.sample_size, null)
    assert.equal(entry.reason, 'no_sources')
    assert.equal(Object.hasOwn(entry, 'value'), false)
  }
})

test('idiom scan accounts tracked extensions and ignores markup', () => {
  const root = nextRoot('idiom-extensions')
  put(root, 'one.mjs', 'function one() {\n  return 1\n}\n')
  put(root, 'two.ts', 'function two(): number {\n  return 2\n}\n')
  put(root, 'three.svelte', '<script>\nfunction three() {\n  return 3\n}\n</script>\n<p>function decoy() { return 4 }</p>\n')
  put(root, 'four.py', 'def not_javascript():\n  return True\n')
  initGit(root, { commit: true })
  const first = probeRepo({ checkout: root })
  const value = first.fields.conventions.value
  assert.deepEqual(value.idiom_scan, { files_scanned: 3, files_skipped_by_extension: 1, extensions: ['.mjs', '.svelte', '.ts'] })
  const density = value.idioms.find((idiom) => idiom.class === 'comment_density')
  assert.equal(density.sample_size, 3)
  assert.equal(density.value, 0)
  assert.ok(density.rule.includes('0 comment lines per 100 code lines'))
  assert.ok(density.rule.includes('sample_size 3'))
  assert.deepEqual(density.exemplars.map((ex) => ex.name), ['one', 'three', 'two'])
  const second = probeRepo({ checkout: root })
  assert.deepEqual(profileBody(first), profileBody(second))
  assert.equal(first.meta.body_digest, second.meta.body_digest)
  assert.equal(JSON.stringify(profileBody(first)).includes(root), false)
})

test('idiom masking states its regex literal ceiling', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  const lines = source.split('\n')
  const ceiling = '// lean: regex literals are not masked; use a JS parser if regex-heavy sources distort measured samples.'
  assert.ok(lines.some((line) => line.trim() === ceiling))
})

test('idiom comments strings and templates cannot contribute functions', () => {
  const root = nextRoot('idiom-decoys')
  put(root, 'decoy.mjs', [
    '// function decoyOne() {',
    '//   return true',
    '// }',
    'function real() {',
    '  return "function decoyTwo() { return true }"',
    '}',
    'const tpl = `function decoyThree() { return true }`',
    '',
  ].join('\n'))
  initGit(root, { commit: true })
  const density = probeRepo({ checkout: root }).fields.conventions.value.idioms
    .find((idiom) => idiom.class === 'comment_density')
  assert.equal(density.sample_size, 1)
  assert.equal(density.value, 75)
  assert.deepEqual(density.exemplars.map((ex) => ex.name), ['real'])
})

test('idiom escaping symlinks invalidate the scan instead of counting zero', () => {
  const root = nextRoot('idiom-symlink')
  put(root, 'real.mjs', 'function real() {\n  return 1\n}\n')
  const outside = join(fixtureRoot, 'idiom-outside.txt')
  writeFileSync(outside, 'outside\n')
  symlinkSync(outside, join(root, 'evil.mjs'))
  initGit(root, { commit: true })
  const value = probeRepo({ checkout: root }).fields.conventions.value
  assert.deepEqual(value.idiom_scan, { files_scanned: null, files_skipped_by_extension: null, extensions: [] })
  for (const entry of value.idioms) {
    assert.equal(entry.rule, null)
    assert.equal(entry.reason, 'source_path_invalid')
    assert.equal(entry.sample_size, null)
  }
})
function idiomSpan(root, exemplar) {
  assert.ok(typeof exemplar.path === 'string' && exemplar.path.length > 0)
  assert.equal(exemplar.path.startsWith('/'), false)
  assert.equal(exemplar.path.split('/').includes('..'), false)
  const lines = readFileSync(join(root, exemplar.path), 'utf8').split('\n')
  assert.ok(Number.isInteger(exemplar.start) && Number.isInteger(exemplar.end))
  assert.ok(exemplar.start >= 1 && exemplar.start <= exemplar.end && exemplar.end <= lines.length)
  return lines.slice(exemplar.start - 1, exemplar.end).join('\n')
}

function idiomEntry(root, kind) {
  return probeRepo({ checkout: root }).fields.conventions.value.idioms.find((idiom) => idiom.class === kind)
}

test('IP1', () => {
  const profile = probeRepo({ checkout: ROOT })
  everyCell(profile)
  const idioms = profile.fields.conventions.value?.idioms
  assert.deepEqual(idioms?.map((entry) => entry.class), ['dependency_injection', 'boolean_helpers', 'logging_placement', 'error_retry_shape', 'comment_density'])
  assert.deepEqual(IDIOM_CLASSES, ['dependency_injection', 'boolean_helpers', 'logging_placement', 'error_retry_shape', 'comment_density'])
  assert.equal(Object.isFrozen(IDIOM_CLASSES), true)
  assert.equal(Object.isFrozen(IDIOM_UNMEASURED_REASONS), true)
  for (const entry of idioms) {
    if (entry.rule === null) {
      assert.deepEqual(entry.exemplars, [])
      assert.equal(entry.basis, null)
      assert.ok(IDIOM_UNMEASURED_REASONS.includes(entry.reason))
      assert.ok(entry.sample_size === null || (Number.isInteger(entry.sample_size) && entry.sample_size >= 0))
      assert.equal(Object.hasOwn(entry, 'value'), false)
    } else {
      assert.ok(Number.isInteger(entry.sample_size) && entry.sample_size > 0)
      assert.ok(typeof entry.rule === 'string' && entry.rule.includes('sample_size ' + entry.sample_size))
      assert.ok((entry.rule.match(/[.!?](?:\s|$)/g) || []).length <= 1)
      assert.ok(typeof entry.basis === 'string' && entry.basis.length > 0)
      assert.ok(Array.isArray(entry.exemplars) && entry.exemplars.length >= 1 && entry.exemplars.length <= 3)
      for (const exemplar of entry.exemplars) idiomSpan(ROOT, exemplar)
    }
  }
})

test('IP2', () => {
  const entry = probeRepo({ checkout: ROOT }).fields.conventions.value.idioms.find((idiom) => idiom.class === 'comment_density')
  assert.ok(typeof entry.value === 'number' && Number.isFinite(entry.value) && entry.value > 0)
  assert.ok(typeof entry.rule === 'string' && entry.rule.includes('sample_size ' + entry.sample_size))
  assert.ok(entry.exemplars.length >= 1 && entry.exemplars.length <= 3)
  for (const exemplar of entry.exemplars) idiomSpan(ROOT, exemplar)
})

test('IP3', () => {
  const root = nextRoot('ip3-injection')
  put(root, 'di.mjs', [
    'function alpha({ io }) {',
    '  return io.read()',
    '}',
    'function beta({ io }) {',
    '  return io.read()',
    '}',
    'function gamma({ io }) {',
    '  return io.read()',
    '}',
    'function delta(io) {',
    '  return io.read()',
    '}',
    '',
  ].join('\n'))
  initGit(root, { commit: true })
  const before = snapshot(root)
  const entry = idiomEntry(root, 'dependency_injection')
  assert.deepEqual(snapshot(root), before)
  assert.equal(entry.sample_size, 4)
  assert.ok(entry.rule.includes('3 of 4'))
  assert.ok(entry.rule.includes('destructured'))
  assert.ok(entry.rule.includes('sample_size 4'))
  assert.deepEqual(entry.exemplars.map((ex) => ex.name), ['alpha', 'beta', 'gamma'])
  for (const exemplar of entry.exemplars) {
    assert.ok(idiomSpan(root, exemplar).includes('function ' + exemplar.name + '('))
  }
})

test('IP4', () => {
  const root = nextRoot('ip4-boolean')
  put(root, 'bool.mjs', [
    'function isReady(state) {',
    '  return true',
    '}',
    'function hasToken(token) {',
    '  return !!token',
    '}',
    'function canRetry(n) {',
    '  return n < 3',
    '}',
    'function ready(state) {',
    "  return state === 'ready'",
    '}',
    '',
  ].join('\n'))
  initGit(root, { commit: true })
  const entry = idiomEntry(root, 'boolean_helpers')
  assert.equal(entry.sample_size, 4)
  assert.ok(entry.rule.startsWith('3 of 4'))
  assert.ok(entry.rule.includes('is*/has*/can*/should*'))
  assert.equal(entry.rule.includes('1 of 4'), false)
  assert.ok(entry.rule.includes('sample_size 4'))
  assert.deepEqual(entry.exemplars.map((ex) => ex.name), ['isReady', 'hasToken', 'canRetry'])
  for (const exemplar of entry.exemplars) {
    assert.ok(idiomSpan(root, exemplar).includes('function ' + exemplar.name + '('))
  }
})

test('IP5', () => {
  const caller = nextRoot('ip5-caller')
  put(caller, 'cli.mjs', 'function main() {\n  console.error("one")\n  console.error("two")\n}\nmain()\n')
  initGit(caller, { commit: true })
  const callerEntry = idiomEntry(caller, 'logging_placement')
  assert.equal(callerEntry.sample_size, 2)
  assert.ok(callerEntry.rule.includes('2 of 2'))
  assert.ok(callerEntry.rule.includes('caller'))
  assert.ok(callerEntry.rule.includes('sample_size 2'))
  assert.deepEqual(callerEntry.exemplars.map((ex) => ex.name), ['main'])
  assert.ok(idiomSpan(caller, callerEntry.exemplars[0]).includes('function main('))

  const helper = nextRoot('ip5-helper')
  put(helper, 'helper.mjs', 'function read() {\n  console.error("one")\n  console.error("two")\n  return 1\n}\n')
  initGit(helper, { commit: true })
  const helperEntry = idiomEntry(helper, 'logging_placement')
  assert.equal(helperEntry.sample_size, 2)
  assert.ok(helperEntry.rule.includes('2 of 2'))
  assert.ok(helperEntry.rule.includes('helper'))
  assert.ok(helperEntry.rule.includes('sample_size 2'))
  assert.deepEqual(helperEntry.exemplars.map((ex) => ex.name), ['read'])
  assert.ok(idiomSpan(helper, helperEntry.exemplars[0]).includes('function read('))
})

test('IP6', () => {
  const root = nextRoot('ip6-catch')
  const rows = ['a', 'b', 'c'].map((name) => 'function ' + name + '() {\n  try { work() } catch (error) { return null }\n}\n')
  rows.push('function d() {\n  try { work() } catch (error) { throw error }\n}\n')
  put(root, 'catch.mjs', rows.join(''))
  initGit(root, { commit: true })
  const entry = idiomEntry(root, 'error_retry_shape')
  assert.equal(entry.sample_size, 4)
  assert.ok(entry.rule.includes('3 of 4'))
  assert.ok(entry.rule.includes('swallow-and-return-null'))
  assert.ok(entry.rule.includes('sample_size 4'))
  assert.deepEqual(entry.exemplars.map((ex) => ex.name), ['a', 'b', 'c'])

  const loops = nextRoot('ip6-loops')
  put(loops, 'loops.mjs', [
    'function poll() {',
    '  for (let i = 0; i < 3; i += 1) {',
    '    try { work() } catch (error) { continue }',
    '  }',
    '}',
    'function unrelated() {',
    '  for (let i = 0; i < 3; i += 1) { compute(i) }',
    '  try { work() } catch (error) { console.error(error) }',
    '}',
    '',
  ].join('\n'))
  initGit(loops, { commit: true })
  const loopEntry = idiomEntry(loops, 'error_retry_shape')
  assert.equal(loopEntry.sample_size, 2)
  assert.equal(loopEntry.rule, null)
  assert.equal(loopEntry.reason, 'no_majority')
})

test('IP7', () => {
  const lines = ['function density() {', ...Array.from({ length: 10 }, (_, i) => '// note ' + i), ...Array.from({ length: 97 }, (_, i) => '  const item' + i + ' = ' + i), '  return item0', '}']
  lines.splice(8, 0, ...Array(27).fill(''))
  const root = nextRoot('ip7-density')
  put(root, 'density.mjs', lines.join('\n') + '\n')
  initGit(root, { commit: true })
  const entry = idiomEntry(root, 'comment_density')
  assert.equal(entry.sample_size, 1)
  assert.equal(entry.value, 10)
  assert.ok(entry.rule.includes('10 comment lines per 100 code lines'))
  assert.ok(entry.rule.includes('sample_size 1'))
  assert.equal(entry.basis, 'line comment/code density')
  assert.deepEqual(entry.exemplars.map((ex) => ex.name), ['density'])
})

test('IP8', () => {
  const root = coldFixture('ip8-readme')
  git(root, 'add', 'README.md')
  const value = probeRepo({ checkout: root }).fields.conventions.value
  assert.deepEqual(value.idioms.map((idiom) => idiom.class), ['dependency_injection', 'boolean_helpers', 'logging_placement', 'error_retry_shape', 'comment_density'])
  assert.deepEqual(value.idiom_scan, { files_scanned: 0, files_skipped_by_extension: 1, extensions: [] })
  for (const entry of value.idioms) {
    assert.equal(entry.rule, null)
    assert.deepEqual(entry.exemplars, [])
    assert.equal(entry.basis, null)
    assert.equal(entry.sample_size, null)
    assert.equal(entry.reason, 'no_sources')
    assert.equal(Object.hasOwn(entry, 'value'), false)
  }
})

test('IP9', () => {
  const root = nextRoot('ip9-extensions')
  put(root, 'one.mjs', 'function isOne() {\n  return true\n}\n')
  put(root, 'two.ts', 'function hasTwo(): boolean {\n  return false\n}\n')
  put(root, 'three.svelte', '<script>\nfunction canThree() {\n  return true\n}\n</script>\n<p>function ready() { return true }</p>\n')
  put(root, 'four.py', 'def not_javascript():\n  return True\n')
  initGit(root, { commit: true })
  const value = probeRepo({ checkout: root }).fields.conventions.value
  assert.deepEqual(value.idiom_scan, { files_scanned: 3, files_skipped_by_extension: 1, extensions: ['.mjs', '.svelte', '.ts'] })
  const entry = value.idioms.find((idiom) => idiom.class === 'boolean_helpers')
  assert.equal(entry.sample_size, 3)
  assert.ok(entry.rule.includes('3 of 3'))
  assert.ok(entry.rule.includes('is*/has*/can*/should*'))
  assert.ok(entry.rule.includes('sample_size 3'))
  for (const exemplar of entry.exemplars) idiomSpan(root, exemplar)
  const first = probeRepo({ checkout: root })
  const second = probeRepo({ checkout: root })
  assert.deepEqual(profileBody(first), profileBody(second))
  assert.equal(first.meta.body_digest, second.meta.body_digest)
  assert.equal(JSON.stringify(profileBody(first)).includes(root), false)
})

test('IP10', () => {
  const path = join(ROOT, 'skills', 'crew-onboard', 'references', 'foreign-checkout.md')
  const text = readFileSync(path, 'utf8')
  for (const word of ['conventions.value.idioms', 'dependency_injection', 'boolean_helpers', 'logging_placement', 'error_retry_shape', 'comment_density']) {
    assert.equal(text.split(word).length - 1, 1, word)
  }
  assert.ok(text.includes('An unmeasured idiom has rule: null and a closed reason, never a guessed rule or numeric zero.'))
  assert.ok(text.includes('A human ratifies idioms by promoting the conventions cell as a whole; the probe never ratifies them.'))
})

test('IP11', () => {
  const blocks = ['return null', 'return null', 'throw error', 'throw error', 'console.error(error)', 'console.error(error)']
  const root = nextRoot('ip11-tie')
  put(root, 'mixed.mjs', blocks.map((body, i) => 'function mixed' + i + '() {\n  try { work() } catch (error) { ' + body + ' }\n}\n').join(''))
  initGit(root, { commit: true })
  const entry = idiomEntry(root, 'error_retry_shape')
  assert.equal(entry.sample_size, 6)
  assert.equal(entry.rule, null)
  assert.deepEqual(entry.exemplars, [])
  assert.equal(entry.basis, null)
  assert.equal(entry.reason, 'no_majority')
})

test('idiom arrow bindings require an arrow RHS', () => {
  const root = nextRoot('idiom-arrows')
  put(root, 'arrows.mjs', [
    'const isArrow = (x) => x > 0',
    'const hasArrow = async (y) => {',
    '  return !!y',
    '}',
    'const ident = isArrow',
    "const req = require('x')",
    'const waited = await done()',
    'const built = new Maker()',
    'const called = make()',
    '',
  ].join('\n'))
  initGit(root, { commit: true })
  const entry = idiomEntry(root, 'boolean_helpers')
  assert.equal(entry.sample_size, 2)
  assert.ok(entry.rule.includes('2 of 2'))
  assert.ok(entry.rule.includes('is*/has*/can*/should*'))
  assert.deepEqual(entry.exemplars.map((ex) => ex.name), ['isArrow', 'hasArrow'])
})

test('idiom boolean sampling excludes comparison-containing nonpredicates', () => {
  const root = nextRoot('idiom-nonpredicates')
  put(root, 'shapes.mjs', [
    'function isReady(state) {',
    "  return state === 'ready'",
    '}',
    'function hasToken(token) {',
    '  return !!token',
    '}',
    'function ordinary(config) {',
    "  if (config.mode === 'fast') { return { mode: config.mode } }",
    '  return config.items.filter((item) => item.score > 0)',
    '}',
    'function filtered(xs) {',
    '  return xs.filter((x) => x > 0)',
    '}',
    'function mixed(value) {',
    '  if (value) return value > 0',
    '  return { value }',
    '}',
    '',
  ].join('\n'))
  initGit(root, { commit: true })
  const entry = idiomEntry(root, 'boolean_helpers')
  assert.equal(entry.sample_size, 2)
  assert.ok(entry.rule.includes('2 of 2'))
  assert.deepEqual(entry.exemplars.map((ex) => ex.name), ['isReady', 'hasToken'])
  // MUTATION returns.every -> returns.some must admit mixed(); dropping idiomDepthZero must admit filtered().
})

test('idiom boolean sampling excludes ternary and generic returns', () => {
  const root = nextRoot('idiom-ternary-generic')
  put(root, 'shapes.mjs', [
    'function isReady(state) { return state === "ready" }',
    'function hasToken(token) { return !!token }',
    'function pick(xs) { return xs.length > 0 ? xs[0] : null }',
    'const byPath = (a, b) => a.path < b.path ? -1 : 1',
    '',
  ].join('\n'))
  put(root, 'generic.ts', 'function make() { return new Map<string, number>() }\n')
  initGit(root, { commit: true })
  const entry = idiomEntry(root, 'boolean_helpers')
  assert.equal(entry.sample_size, 2)
  assert.ok(entry.rule.includes('2 of 2'))
  assert.deepEqual(entry.exemplars.map((ex) => ex.name), ['isReady', 'hasToken'])
  // MUTATION delete the conditional-'?' rejection; pick and byPath must re-enter the boolean sample.
})

test('idiom callbacks own returns and logging calls without entering samples', () => {
  const root = nextRoot('idiom-callback-owners')
  put(root, 'callbacks.mjs', [
    'function run(items) {',
    '  const out = items.map((x) => {',
    '    console.log(x)',
    '    return x.score > 0',
    '  })',
    '  console.log(out)',
    '}',
    'function runAgain(items) {',
    '  return items.map(function (x) {',
    '    return x.score > 0',
    '  })',
    '}',
    '',
  ].join('\n'))
  initGit(root, { commit: true })
  const predicates = idiomEntry(root, 'boolean_helpers')
  assert.equal(predicates.rule, null)
  assert.equal(predicates.reason, 'no_sample')
  const logs = idiomEntry(root, 'logging_placement')
  assert.equal(logs.rule, null)
  assert.equal(logs.reason, 'no_majority')
})

test('idiom named block arrows retain predicate, log, and catch ownership', () => {
  const root = nextRoot('idiom-named-arrow-ownership')
  put(root, 'named.mjs', [
    "const ready = (s) => { console.log(s); try { work() } catch (error) { throw error }; return s === 'ready' }",
    "const done = (s) => { console.log(s); try { work() } catch (error) { throw error }; return s === 'done' }",
    '',
  ].join('\n'))
  initGit(root, { commit: true })
  const predicates = idiomEntry(root, 'boolean_helpers')
  assert.equal(predicates.sample_size, 2)
  assert.ok(predicates.rule.startsWith('0 of 2'))
  assert.ok(predicates.rule.includes('with non-prefix naming dominant'))
  assert.deepEqual(predicates.exemplars.map((ex) => ex.name), ['ready', 'done'])
  const logs = idiomEntry(root, 'logging_placement')
  assert.equal(logs.sample_size, 2)
  assert.ok(logs.rule.includes('in helper functions'))
  assert.deepEqual(logs.exemplars.map((ex) => ex.name), ['ready', 'done'])
  const catches = idiomEntry(root, 'error_retry_shape')
  assert.equal(catches.sample_size, 2)
  assert.ok(catches.rule.includes('2 of 2'))
  assert.ok(catches.rule.includes('rethrow'))
  assert.deepEqual(catches.exemplars.map((ex) => ex.name), ['ready', 'done'])
})

test('idiom tracked files under an escaping parent symlink invalidate the scan', () => {
  const root = nextRoot('idiom-parent-symlink')
  put(root, 'lib/a.js', 'function safe() { return true }\n')
  initGit(root, { commit: true })
  const outside = join(fixtureRoot, 'idiom-outside-parent')
  mkdirSync(outside, { recursive: true })
  put(outside, 'a.js', 'function outside() { return true }\n')
  rmSync(join(root, 'lib'), { recursive: true, force: true })
  symlinkSync(outside, join(root, 'lib'), 'dir')
  const value = probeRepo({ checkout: root }).fields.conventions.value
  assert.deepEqual(value.idiom_scan, { files_scanned: null, files_skipped_by_extension: null, extensions: [] })
  assert.ok(value.idioms.every((entry) => entry.reason === 'source_path_invalid'))
})

test('idiom catches retain same-offset observations in distinct files', () => {
  const root = nextRoot('idiom-offsets')
  const body = (name) => 'function ' + name + '() {\n  try { work() } catch (error) { return null }\n}\n'
  put(root, 'a.mjs', body('sameA'))
  put(root, 'b.mjs', body('sameB'))
  initGit(root, { commit: true })
  const entry = idiomEntry(root, 'error_retry_shape')
  assert.equal(entry.sample_size, 2)
  assert.ok(entry.rule.includes('2 of 2'))
  assert.ok(entry.rule.includes('swallow-and-return-null'))
  assert.deepEqual(entry.exemplars.map((ex) => ex.name), ['sameA', 'sameB'])
})

test('idiom enumeration failure has null counts and no untracked fallback', () => {
  const plain = nextRoot('idiom-nongit')
  put(plain, 'README.md', '# fixture\n')
  put(plain, 'code.mjs', 'function untracked() {\n  return 1\n}\n')
  const plainValue = probeRepo({ checkout: plain }).fields.conventions.value
  assert.deepEqual(plainValue.idiom_scan, { files_scanned: null, files_skipped_by_extension: null, extensions: [] })
  for (const entry of plainValue.idioms) {
    assert.equal(entry.rule, null)
    assert.equal(entry.reason, 'ls_files_failed')
    assert.equal(entry.sample_size, null)
  }

  const removed = nextRoot('idiom-removed')
  put(removed, 'gone.mjs', 'function gone() {\n  return 1\n}\n')
  initGit(removed, { commit: true })
  rmSync(join(removed, 'gone.mjs'))
  const removedValue = probeRepo({ checkout: removed }).fields.conventions.value
  assert.deepEqual(removedValue.idiom_scan, { files_scanned: null, files_skipped_by_extension: null, extensions: [] })
  for (const entry of removedValue.idioms) {
    assert.equal(entry.rule, null)
    assert.equal(entry.reason, 'source_read_failed')
    assert.equal(entry.sample_size, null)
  }

  const staged = nextRoot('idiom-staged-only')
  put(staged, 'README.md', '# fixture\n')
  initGit(staged)
  git(staged, 'add', 'README.md')
  put(staged, 'sneaky.mjs', 'function isSneaky() {\n  return true\n}\n')
  const stagedValue = probeRepo({ checkout: staged }).fields.conventions.value
  assert.deepEqual(stagedValue.idiom_scan, { files_scanned: 0, files_skipped_by_extension: 1, extensions: [] })
  for (const entry of stagedValue.idioms) {
    assert.equal(entry.rule, null)
    assert.equal(entry.reason, 'no_sources')
    assert.equal(entry.sample_size, null)
  }
})

test('idiom oversized tracked listing is unmeasured', () => {
  const root = nextRoot('idiom-oversized')
  put(root, 'README.md', '# fixture\n')
  initGit(root)
  const hash = git(root, 'hash-object', '-w', 'README.md').trim()
  const rows = []
  let size = 0
  let counter = 0
  while (size <= 1024 * 1024 && counter < 20000) {
    const name = 'oversized/padded-name-' + String(counter).padStart(6, '0') + '-' + 'x'.repeat(180) + '.mjs'
    rows.push('100644 ' + hash + '\t' + name + '\n')
    size += name.length + 1
    counter += 1
  }
  assert.ok(size > 1024 * 1024)
  execFileSync('git', ['-C', root, 'update-index', '--index-info'], { input: rows.join(''), encoding: 'utf8' })
  const value = probeRepo({ checkout: root }).fields.conventions.value
  assert.deepEqual(value.idiom_scan, { files_scanned: null, files_skipped_by_extension: null, extensions: [] })
  for (const entry of value.idioms) {
    assert.equal(entry.rule, null)
    assert.equal(entry.reason, 'ls_files_oversized')
    assert.equal(entry.sample_size, null)
  }
})

test('idiom typescript annotations keep function spans', () => {
  const root = nextRoot('idiom-ts')
  put(root, 'typed.ts', [
    'function isTyped(input: string): boolean {',
    '  return !!input',
    '}',
    'function hasOther(input?: string): boolean {',
    '  return input !== undefined',
    '}',
    '',
  ].join('\n'))
  initGit(root, { commit: true })
  const entry = idiomEntry(root, 'boolean_helpers')
  assert.equal(entry.sample_size, 2)
  assert.ok(entry.rule.includes('2 of 2'))
  assert.deepEqual(entry.exemplars.map((ex) => ex.name), ['isTyped', 'hasOther'])
  for (const exemplar of entry.exemplars) {
    assert.ok(idiomSpan(root, exemplar).includes('function ' + exemplar.name + '('))
  }
})

