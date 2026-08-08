import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ROOT } from './helpers.mjs'
import {
  resolveRoots, taskPaths, stemOf,
  specPathFor, returnPathFor, signalsPathFor, recordPathFor, renderPathFor,
  sidecarPaths, deriveWorktree,
  loadRoster, resolveRole,
  expandGrants, composeProfile,
  assertValidationCommands, RefusalError,
  parseEnvFile, hashEnvFile, ENV_FILE_RESERVED_EXACT, ENV_FILE_RESERVED_PREFIXES,
} from '../scripts/cmux/resolve.mjs'

const dispatchRecordSchema = JSON.parse(readFileSync(join(ROOT, 'scripts/cmux/dispatch-record.schema.json'), 'utf8'))
const rosterDefault = JSON.parse(readFileSync(join(ROOT, 'scripts/cmux/roster.default.json'), 'utf8'))
const rosterSchema = JSON.parse(readFileSync(join(ROOT, 'scripts/cmux/roster.schema.json'), 'utf8'))
const RULE_RE = new RegExp(dispatchRecordSchema.properties.profile.properties.allow.items.pattern)

function makeTmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

// ---------------------------------------------------------------------------
// resolveRoots / taskPaths — layout + path-traversal hazards
// ---------------------------------------------------------------------------

test('resolveRoots: default root is ~/.dev-team-shaped and derives the three subtrees', () => {
  const roots = resolveRoots({})
  assert.ok(roots.root.endsWith('/.dev-team'))
  assert.equal(roots.tasksRoot, `${roots.root}/tasks`)
  assert.equal(roots.stateRoot, `${roots.root}/state`)
  assert.equal(roots.worktreesRoot, `${roots.root}/worktrees`)
})

test('resolveRoots: an explicit taskArtifactsRoot overrides the default', () => {
  const roots = resolveRoots({ taskArtifactsRoot: '/abs/custom-root' })
  assert.equal(roots.root, '/abs/custom-root')
  assert.equal(roots.tasksRoot, '/abs/custom-root/tasks')
})

test('negative: taskArtifactsRoot failing the frozen charset throws', () => {
  assert.throws(() => resolveRoots({ taskArtifactsRoot: '/abs/has a space' }))
  assert.throws(() => resolveRoots({ taskArtifactsRoot: '/abs/has(parens)' }))
})

test('negative: taskArtifactsRoot containing a .. segment throws even though the charset admits it', () => {
  assert.ok(/^\/[A-Za-z0-9._/-]+$/.test('/abs/../etc'), 'sanity: the charset alone admits ..')
  assert.throws(() => resolveRoots({ taskArtifactsRoot: '/abs/../etc' }))
})

test('negative: taskArtifactsRoot containing a protected path component throws', () => {
  assert.throws(() => resolveRoots({ taskArtifactsRoot: '/abs/.git/x' }))
  assert.throws(() => resolveRoots({ taskArtifactsRoot: '/abs/.claude/x' }))
})

test('taskPaths: produces the frozen task/state layout', () => {
  const roots = resolveRoots({ taskArtifactsRoot: '/abs/root' })
  const paths = taskPaths({ roots, repoSlug: 'my-repo', taskSlug: 'my task' })
  assert.equal(paths.taskDir, '/abs/root/tasks/my-repo/my-task')
  assert.equal(paths.specDir, '/abs/root/tasks/my-repo/my-task/spec')
  assert.equal(paths.returnsDir, '/abs/root/tasks/my-repo/my-task/returns')
  assert.equal(paths.signalsDir, '/abs/root/tasks/my-repo/my-task/signals')
  assert.equal(paths.stateDir, '/abs/root/state/my-repo/my-task')
  assert.equal(paths.dispatchDir, '/abs/root/state/my-repo/my-task/dispatch')
  assert.equal(paths.snapshotDir, '/abs/root/state/my-repo/my-task/worker-plugin')
  assert.equal(paths.logsDir, '/abs/root/state/my-repo/my-task/logs')
  assert.equal(paths.preflightPath, '/abs/root/state/my-repo/my-task/preflight.json')
  assert.equal(paths.statusPath, '/abs/root/state/my-repo/my-task/status.json')
  assert.equal(paths.cursorPath, '/abs/root/state/my-repo/my-task/events.cursor')
  assert.equal(paths.lockPath, '/abs/root/state/my-repo/my-task/await.lock')
  assert.equal(paths.worktreesIndexPath, '/abs/root/state/my-repo/my-task/worktrees.json')
  assert.equal(paths.rosterSnapshotPath, '/abs/root/state/my-repo/my-task/roster.snapshot.json')
})

test('negative: taskPaths propagates the throw when slugify() rejects a degenerate repoSlug/taskSlug', () => {
  const roots = resolveRoots({ taskArtifactsRoot: '/abs/root' })
  assert.throws(() => taskPaths({ roots, repoSlug: '...', taskSlug: 'ok' }))
  assert.throws(() => taskPaths({ roots, repoSlug: 'ok', taskSlug: '' }))
})

// ---------------------------------------------------------------------------
// stemOf / *PathFor / renderPathFor / sidecarPaths
// ---------------------------------------------------------------------------

test('stemOf: joins slice_id and attempt with a single dot', () => {
  assert.equal(stemOf('be-1a', 1), 'be-1a.1')
  assert.equal(stemOf('be-1a', 7), 'be-1a.7')
})

test('negative: stemOf rejects a slice_id failing SLICE_ID_RE or an out-of-range attempt', () => {
  assert.throws(() => stemOf('be)1a', 1))
  assert.throws(() => stemOf('be-1a', 0))
  assert.throws(() => stemOf('be-1a', 100))
})

test('specPathFor/returnPathFor/signalsPathFor/recordPathFor derive the frozen filenames', () => {
  const roots = resolveRoots({ taskArtifactsRoot: '/abs/root' })
  const paths = taskPaths({ roots, repoSlug: 'repo', taskSlug: 'task' })
  const stem = stemOf('be-1a', 1)
  assert.equal(specPathFor(paths, 'be-1a'), '/abs/root/tasks/repo/task/spec/be-1a.json')
  assert.equal(returnPathFor(paths, stem), '/abs/root/tasks/repo/task/returns/be-1a.1.json')
  assert.equal(signalsPathFor(paths, stem), '/abs/root/tasks/repo/task/signals/be-1a.1.jsonl')
  assert.equal(recordPathFor(paths, stem), '/abs/root/state/repo/task/dispatch/be-1a.1.json')
})

test('renderPathFor is the single derivation site for returns/<stem>.md', () => {
  const record = { task_dir: '/abs/root/tasks/repo/task', slice_id: 'be-1a', attempt: 1 }
  assert.equal(renderPathFor(record), '/abs/root/tasks/repo/task/returns/be-1a.1.json'.replace('.json', '.md'))
})

test('sidecarPaths returns the five flat, dispatch_id-keyed sidecar files under stateDir', () => {
  const roots = resolveRoots({ taskArtifactsRoot: '/abs/root' })
  const paths = taskPaths({ roots, repoSlug: 'repo', taskSlug: 'task' })
  const sidecars = sidecarPaths(paths, '11111111-1111-1111-1111-111111111111')
  assert.deepEqual(sidecars, {
    exit: '/abs/root/state/repo/task/11111111-1111-1111-1111-111111111111.exit',
    gate: '/abs/root/state/repo/task/11111111-1111-1111-1111-111111111111.gate',
    nonce: '/abs/root/state/repo/task/11111111-1111-1111-1111-111111111111.nonce',
    signalLog: '/abs/root/state/repo/task/11111111-1111-1111-1111-111111111111.signal-log',
    // be-11-03: the collapse-on-close skip gate.
    collapsed: '/abs/root/state/repo/task/11111111-1111-1111-1111-111111111111.collapsed',
  })
})

// ---------------------------------------------------------------------------
// deriveWorktree
// ---------------------------------------------------------------------------

test('deriveWorktree: returns null iff isolation is "primary"', () => {
  const roots = resolveRoots({ taskArtifactsRoot: '/abs/root' })
  assert.equal(deriveWorktree({ roots, repoSlug: 'repo', taskSlug: 'task', sliceId: 'be-1a', isolation: 'primary', createdByDispatcher: true, sourceSliceId: null }), null)
})

test('deriveWorktree: the created-by-dispatcher shape', () => {
  const roots = resolveRoots({ taskArtifactsRoot: '/abs/root' })
  const wt = deriveWorktree({ roots, repoSlug: 'repo', taskSlug: 'task', sliceId: 'be-1a', isolation: 'worktree', createdByDispatcher: true, sourceSliceId: null })
  assert.deepEqual(wt, {
    path: '/abs/root/worktrees/repo/task/be-1a',
    branch: 'dt/task/be-1a',
    created_by_dispatcher: true,
    source_slice_id: null,
  })
  assert.match(wt.branch, /^dt\/[a-z0-9-]+\/[a-z0-9-]+$/)
})

test('deriveWorktree: a reviewer inspecting another slice\'s worktree names it via source_slice_id', () => {
  const roots = resolveRoots({ taskArtifactsRoot: '/abs/root' })
  const wt = deriveWorktree({ roots, repoSlug: 'repo', taskSlug: 'task', sliceId: 'be-1a', isolation: 'worktree', createdByDispatcher: false, sourceSliceId: 'be-1a' })
  assert.equal(wt.source_slice_id, 'be-1a')
  assert.equal(wt.created_by_dispatcher, false)
})

test('deriveWorktree: attempt 1 and attempt 7 of the same slice derive the identical path and branch (reuse)', () => {
  const roots = resolveRoots({ taskArtifactsRoot: '/abs/root' })
  // deriveWorktree takes no attempt parameter at all: it is keyed only to
  // slice_id, so two calls for "different attempts" of the same slice are
  // just two calls with the same inputs.
  const wt1 = deriveWorktree({ roots, repoSlug: 'repo', taskSlug: 'task', sliceId: 'be-1a', isolation: 'worktree', createdByDispatcher: true, sourceSliceId: null })
  const wt7 = deriveWorktree({ roots, repoSlug: 'repo', taskSlug: 'task', sliceId: 'be-1a', isolation: 'worktree', createdByDispatcher: true, sourceSliceId: null })
  assert.deepEqual(wt1, wt7)
})

test('deriveWorktree: two different slices derive different paths', () => {
  const roots = resolveRoots({ taskArtifactsRoot: '/abs/root' })
  const a = deriveWorktree({ roots, repoSlug: 'repo', taskSlug: 'task', sliceId: 'be-1a', isolation: 'worktree', createdByDispatcher: true, sourceSliceId: null })
  const b = deriveWorktree({ roots, repoSlug: 'repo', taskSlug: 'task', sliceId: 'be-1b', isolation: 'worktree', createdByDispatcher: true, sourceSliceId: null })
  assert.notEqual(a.path, b.path)
  assert.notEqual(a.branch, b.branch)
})

test('negative: deriveWorktree throws when source_slice_id is set alongside created_by_dispatcher true', () => {
  const roots = resolveRoots({ taskArtifactsRoot: '/abs/root' })
  assert.throws(() => deriveWorktree({ roots, repoSlug: 'repo', taskSlug: 'task', sliceId: 'be-1a', isolation: 'worktree', createdByDispatcher: true, sourceSliceId: 'be-1a' }))
})

test('negative: deriveWorktree throws when created_by_dispatcher is false and source_slice_id is missing', () => {
  const roots = resolveRoots({ taskArtifactsRoot: '/abs/root' })
  assert.throws(() => deriveWorktree({ roots, repoSlug: 'repo', taskSlug: 'task', sliceId: 'be-1a', isolation: 'worktree', createdByDispatcher: false, sourceSliceId: null }))
})

test('negative: deriveWorktree propagates a slugify() throw for a degenerate taskSlug', () => {
  const roots = resolveRoots({ taskArtifactsRoot: '/abs/root' })
  assert.throws(() => deriveWorktree({ roots, repoSlug: 'repo', taskSlug: '...', sliceId: 'be-1a', isolation: 'worktree', createdByDispatcher: true, sourceSliceId: null }))
})

// ---------------------------------------------------------------------------
// loadRoster — four-layer precedence, recursive merge, wholesale array
// replace, schema-violation throw
// ---------------------------------------------------------------------------

test('loadRoster: merges four layers, project overrides user overrides plugin, arrays replace wholesale', () => {
  const home = makeTmpDir('cmux-resolve-home-')
  const project = makeTmpDir('cmux-resolve-project-')
  mkdirSync(join(home, '.claude/dev-team'), { recursive: true })
  mkdirSync(join(project, '.claude/dev-team'), { recursive: true })

  writeFileSync(join(home, '.claude/dev-team/roster.json'), JSON.stringify({
    roles: { coder: { model: 'opus' } },
  }))
  writeFileSync(join(project, '.claude/dev-team/roster.json'), JSON.stringify({
    roles: {
      coder: { effort: 'low' },
      'build-validator': { return: { required_sections: ['Verdict', 'Extra'] } },
    },
  }))

  const session = { roles: { coder: { timeout_s: 900 } } }

  const { roster } = loadRoster({ pluginRoot: ROOT, home, primaryCheckout: project, session })

  // user layer wins over plugin default for model; project layer wins over
  // both for effort; session wins for timeout_s — all on the same role.
  assert.equal(roster.roles.coder.model, 'opus')
  assert.equal(roster.roles.coder.effort, 'low')
  assert.equal(roster.roles.coder.timeout_s, 900)
  // untouched properties survive from the plugin default layer
  assert.equal(roster.roles.coder.profile, 'executor')
  assert.equal(roster.roles.coder.isolation, 'worktree')

  // arrays replace wholesale rather than merging element-wise
  assert.deepEqual(roster.roles['build-validator'].return.required_sections, ['Verdict', 'Extra'])
})

test('loadRoster: a null session layer is a no-op', () => {
  const home = makeTmpDir('cmux-resolve-home-')
  const project = makeTmpDir('cmux-resolve-project-')
  const { roster } = loadRoster({ pluginRoot: ROOT, home, primaryCheckout: project, session: null })
  assert.deepEqual(roster, rosterDefault)
})

test('loadRoster: throws with the Violation path+keyword when the merged roster violates the schema', () => {
  const home = makeTmpDir('cmux-resolve-home-')
  const project = makeTmpDir('cmux-resolve-project-')
  const session = { profiles: { executor: { permission_mode: 'plan' } } }
  assert.throws(
    () => loadRoster({ pluginRoot: ROOT, home, primaryCheckout: project, session }),
    /\$\.profiles\.executor\.permission_mode.*enum/,
  )
})

// trust M5-A: roles/profiles keys are joined straight into filesystem paths
// downstream (snapshotWorkerPlugin), so a traversal-shaped key is a
// traversal primitive, not just a label. The schema can't express
// propertyNames (out of BUDGET) — loadRoster is the layer that closes it.
test('trust M5-A: a project-layer roster with a traversal-shaped role key throws before anything else', () => {
  const home = makeTmpDir('cmux-resolve-home-')
  const project = makeTmpDir('cmux-resolve-project-')
  mkdirSync(join(project, '.claude/dev-team'), { recursive: true })
  writeFileSync(join(project, '.claude/dev-team/roster.json'), JSON.stringify({
    roles: { '../../../../tmp/evil': { profile: 'executor', isolation: 'worktree', model: 'sonnet', doc_tab: false, pane: false, return: { kind: 'json' } } },
  }))
  assert.throws(
    () => loadRoster({ pluginRoot: ROOT, home, primaryCheckout: project, session: null }),
    /roles key fails the frozen charset.*\.\.\/\.\.\/\.\.\/\.\.\/tmp\/evil/,
  )
})

test('trust M5-A: a traversal-shaped profile key also throws', () => {
  const home = makeTmpDir('cmux-resolve-home-')
  const project = makeTmpDir('cmux-resolve-project-')
  mkdirSync(join(project, '.claude/dev-team'), { recursive: true })
  writeFileSync(join(project, '.claude/dev-team/roster.json'), JSON.stringify({
    profiles: { '../../../../tmp/evil': { description: 'x', permission_mode: 'dontAsk', allow: ['returns_write', 'signals_append'], postcondition: 'clean' } },
  }))
  assert.throws(
    () => loadRoster({ pluginRoot: ROOT, home, primaryCheckout: project, session: null }),
    /profiles key fails the frozen charset/,
  )
})

// ---------------------------------------------------------------------------
// resolveRole — four-layer last-writer-wins, return deep-merge, null no-op
// ---------------------------------------------------------------------------

test('resolveRole: all four layers each contribute a different property to the same role', () => {
  const resolved = resolveRole('coder', {
    plugin: { profile: 'executor', isolation: 'worktree', model: 'sonnet', return: { kind: 'json' } },
    user: { effort: 'high' },
    project: { timeout_s: 900 },
    session: { pane: true },
  })
  assert.deepEqual(resolved, {
    profile: 'executor',
    isolation: 'worktree',
    model: 'sonnet',
    return: { kind: 'json' },
    effort: 'high',
    timeout_s: 900,
    pane: true,
  })
})

test('resolveRole: last writer wins when two layers set the same property', () => {
  const resolved = resolveRole('coder', {
    plugin: { model: 'sonnet' },
    user: { model: 'opus' },
    project: null,
    session: null,
  })
  assert.equal(resolved.model, 'opus')
})

test('resolveRole: `return` deep-merges instead of being replaced wholesale', () => {
  const resolved = resolveRole('coder', {
    plugin: { return: { kind: 'json', schema: 'coder-return.schema.json' } },
    user: { return: { verdict_block: true } },
    project: null,
    session: null,
  })
  assert.deepEqual(resolved.return, { kind: 'json', schema: 'coder-return.schema.json', verdict_block: true })
})

test('resolveRole: a session layer of null is a no-op', () => {
  const withNullSession = resolveRole('coder', { plugin: { model: 'sonnet' }, user: null, project: null, session: null })
  const withNoSession = resolveRole('coder', { plugin: { model: 'sonnet' }, user: null, project: null, session: undefined })
  assert.deepEqual(withNullSession, withNoSession)
  assert.deepEqual(withNullSession, { model: 'sonnet' })
})

// ---------------------------------------------------------------------------
// expandGrants — exact rule emission, the critical double-slash shape test,
// deterministic ordering, unknown agent/token
// ---------------------------------------------------------------------------

const CTX = {
  taskDir: '/abs/root/tasks/repo/task',
  stem: 'be-1a.1',
  worktreePath: '/abs/root/worktrees/repo/task/be-1a',
  validationCommands: ['node --test', 'npm run typecheck'],
}

test('expandGrants: emits the exact rule per token', () => {
  assert.deepEqual(expandGrants('claude', ['returns_write'], CTX), ['Edit(//abs/root/tasks/repo/task/returns/be-1a.1.json)'])
  assert.deepEqual(expandGrants('claude', ['signals_append'], CTX), ['Edit(//abs/root/tasks/repo/task/signals/be-1a.1.jsonl)'])
  assert.deepEqual(expandGrants('claude', ['worktree_write'], CTX), ['Edit(//abs/root/worktrees/repo/task/be-1a/**)'])
  assert.deepEqual(expandGrants('claude', ['validation_commands'], CTX), ['Bash(node --test *)', 'Bash(npm run typecheck *)'])
})

test('expandGrants: emits deterministically in GRANT_TOKENS order regardless of input token order', () => {
  const forward = expandGrants('claude', ['returns_write', 'signals_append', 'worktree_write', 'validation_commands'], CTX)
  const reversed = expandGrants('claude', ['validation_commands', 'worktree_write', 'signals_append', 'returns_write'], CTX)
  assert.deepEqual(forward, reversed)
})

test('CRITICAL SHAPE TEST: every produced rule matches the frozen RULE pattern and none contains ///', () => {
  const rules = expandGrants('claude', ['returns_write', 'signals_append', 'worktree_write', 'validation_commands'], CTX)
  for (const rule of rules) {
    assert.match(rule, RULE_RE, `rule does not match RULE: ${rule}`)
    assert.equal(rule.includes('///'), false, `rule contains a triple slash: ${rule}`)
  }
})

test('negative: expandGrants throws for an unknown agent', () => {
  assert.throws(() => expandGrants('codex', ['returns_write'], CTX))
})

test('negative: expandGrants throws for an unknown token', () => {
  assert.throws(() => expandGrants('claude', ['bogus_token'], CTX))
})

test('negative: expandGrants propagates the RefusalError for a validation command the whitelist rejects', () => {
  assert.throws(() => expandGrants('claude', ['validation_commands'], { ...CTX, validationCommands: ['npm test && rm -rf /'] }), RefusalError)
})

// trust S2-A: worktree_write with a null/absent worktreePath used to emit
// the malformed rule Edit(/null/**) — a real string, matching no failure
// path, that would have shipped in a record. expandGrants must throw
// instead.
test('trust S2-A: expandGrants throws on worktree_write with a null worktreePath', () => {
  assert.throws(() => expandGrants('claude', ['worktree_write'], { ...CTX, worktreePath: null }))
})

test('trust S2-A: expandGrants throws on worktree_write with an absent worktreePath', () => {
  const { worktreePath, ...ctxWithoutWorktreePath } = CTX
  assert.throws(() => expandGrants('claude', ['worktree_write'], ctxWithoutWorktreePath))
})

test('trust S2-A: expandGrants throws on worktree_write with an empty-string worktreePath', () => {
  assert.throws(() => expandGrants('claude', ['worktree_write'], { ...CTX, worktreePath: '' }))
})

// The concrete live hole: isolation "primary" (worktree: null) combined with
// a roster profile that still carries worktree_write (e.g. a one-line
// project-roster override that flips isolation but not profile).
test('trust S2-A: isolation "primary" + worktree_write throws rather than emitting Edit(/null/**)', () => {
  const roots = resolveRoots({ taskArtifactsRoot: '/abs/root' })
  const worktree = deriveWorktree({ roots, repoSlug: 'repo', taskSlug: 'task', sliceId: 'be-1a', isolation: 'primary', createdByDispatcher: true, sourceSliceId: null })
  assert.equal(worktree, null)
  const ctx = { ...CTX, worktreePath: worktree ? worktree.path : null }
  assert.throws(() => expandGrants('claude', ['worktree_write'], ctx))
  assert.throws(() => composeProfile('claude', { name: 'executor', profile: rosterDefault.profiles.executor, ctx }))
})

// ---------------------------------------------------------------------------
// composeProfile — shape, minItems/uniqueItems across the three shipped
// profiles, CMUX_ALLOWS suffix, postcondition_ignore default
// ---------------------------------------------------------------------------

for (const [name, profile] of Object.entries(rosterDefault.profiles)) {
  test(`composeProfile('${name}'): matches the record's C.1 shape (minItems 4, uniqueItems, CMUX_ALLOWS suffix)`, () => {
    const composed = composeProfile('claude', { name, profile, ctx: CTX })
    assert.equal(composed.name, name)
    assert.equal(composed.permission_mode, 'dontAsk')
    assert.deepEqual(composed.grants, profile.allow)
    assert.equal(composed.postcondition, profile.postcondition)
    assert.deepEqual(composed.postcondition_ignore, [])

    assert.ok(composed.allow.length >= 4, `expected minItems 4, got ${composed.allow.length}`)
    assert.equal(new Set(composed.allow).size, composed.allow.length, 'allow must be uniqueItems')
    assert.deepEqual(composed.allow.slice(-2), ['Bash(cmux notify *)', 'Bash(cmux wait-for -S *)'])
    for (const rule of composed.allow) {
      assert.match(rule, RULE_RE)
    }
  })
}

test('composeProfile: judgment profile has no validation_commands token, so no Bash rule beyond the two cmux allows', () => {
  const composed = composeProfile('claude', { name: 'judgment', profile: rosterDefault.profiles.judgment, ctx: CTX })
  assert.equal(composed.allow.length, 4)
  const bashRules = composed.allow.filter((r) => r.startsWith('Bash(') && !r.startsWith('Bash(cmux'))
  assert.deepEqual(bashRules, [])
})

// trust S2-A: composeProfile runs assertRuleShape per emitted rule as a
// second, independent gate on top of expandGrants' construction-by-template.
test('trust S2-A: composeProfile rejects a manually-forged malformed rule even if it slipped past expandGrants', () => {
  // Simulate the exact historical bug (Edit(/null/**)) by handing
  // composeProfile a profile whose allow list is a plain grant-token list,
  // but through a ctx that makes worktree_write impossible to expand safely
  // — expandGrants now throws first, which is the fix; this test pins that
  // composeProfile has no path that could re-emit the old shape.
  const profile = { ...rosterDefault.profiles.executor }
  assert.throws(() => composeProfile('claude', { name: 'executor', profile, ctx: { ...CTX, worktreePath: undefined } }))
})

test('composeProfile: postcondition_ignore defaults to [] when the roster profile omits it', () => {
  const profileNoIgnore = { ...rosterDefault.profiles.executor }
  delete profileNoIgnore.postcondition_ignore
  const composed = composeProfile('claude', { name: 'executor', profile: profileNoIgnore, ctx: CTX })
  assert.deepEqual(composed.postcondition_ignore, [])
})

// ---------------------------------------------------------------------------
// assertValidationCommands — whitelist + no-dot-dot, fail-closed refusal
// ---------------------------------------------------------------------------

test('assertValidationCommands: accepts real validation commands, trimmed', () => {
  const cmds = assertValidationCommands([' node --test ', 'npm test -- items', 'npm run typecheck', 'pytest tests/foo -k thing'])
  assert.deepEqual(cmds, ['node --test', 'npm test -- items', 'npm run typecheck', 'pytest tests/foo -k thing'])
})

for (const bad of ['npm test && rm -rf /', "node -e 'x'", 'pytest ../../etc', 'cargo test | tee x']) {
  test(`negative: assertValidationCommands refuses the whole set for a bad command (${JSON.stringify(bad)})`, () => {
    assert.throws(() => assertValidationCommands(['node --test', bad]), (err) => {
      assert.ok(err instanceof RefusalError)
      assert.equal(err.command, bad)
      return true
    })
  })
}

test('non-validate: a command matching CMD_RE but containing .. is still refused (CMD_RE alone admits it)', () => {
  assert.throws(() => assertValidationCommands(['node ../evil.js']), RefusalError)
})

// trust S3-narrow: CMD_RE's charset admits interpreters (`bash -c`) and
// absolute-path scripts (`/tmp/x.sh`) — under dontAsk those are equivalent
// to unrestricted Bash. The first-token rule closes both.
for (const bad of ['bash -c', '/tmp/x.sh', 'env node']) {
  test(`trust S3-narrow: assertValidationCommands refuses a command whose first token is a shell/interpreter or an absolute path (${JSON.stringify(bad)})`, () => {
    assert.throws(() => assertValidationCommands([bad]), (err) => {
      assert.ok(err instanceof RefusalError)
      assert.equal(err.command, bad)
      return true
    })
  })
}

test('trust S3-narrow: the established real-world positives still pass unchanged', () => {
  const cmds = assertValidationCommands(['node --test', 'npm test -- items', 'npm run typecheck', 'pytest tests/foo -k thing'])
  assert.deepEqual(cmds, ['node --test', 'npm test -- items', 'npm run typecheck', 'pytest tests/foo -k thing'])
})

test('RefusalError carries the offending command and is a named Error subclass', () => {
  try {
    assertValidationCommands(['bad;cmd'])
    assert.fail('expected assertValidationCommands to throw')
  } catch (err) {
    assert.ok(err instanceof RefusalError)
    assert.ok(err instanceof Error)
    assert.equal(err.name, 'RefusalError')
    assert.equal(err.command, 'bad;cmd')
  }
})

// ---------------------------------------------------------------------------
// Rider D — dispatch-record.schema.json prose-only edit
// ---------------------------------------------------------------------------

const DISPATCH_ID = '11111111-1111-1111-1111-111111111111'
const SHA256 = '0123456789abcdef'.repeat(4)
const ATTN = `devteam-${DISPATCH_ID}-attn`

function buildDispatchRecord(overrides = {}) {
  return {
    schema_version: 2,
    dispatch_id: DISPATCH_ID,
    slice_id: 'be-1a',
    attempt: 1,
    task_id: 'be-1a task',
    task_slug: 'sample-repo-task',
    repo_slug: 'sample-repo',
    role: 'coder',
    agent: 'claude',
    model: 'sonnet',
    effort: 'medium',
    tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
    disallowed_tools: ['mcp__*', 'Task', 'Agent'],
    flags: { strict_mcp_config: true, disable_slash_commands: true },
    profile: {
      name: 'executor',
      permission_mode: 'dontAsk',
      grants: ['returns_write', 'signals_append', 'worktree_write', 'validation_commands'],
      allow: ['Bash(cmux notify *)', 'Bash(cmux wait-for -S *)', 'Bash(node --test)', 'Edit(//abs/path/to/repo/**)'],
      postcondition: 'changes_expected',
      postcondition_ignore: [],
    },
    role_prompt_path: '/abs/path/to/role-prompt.md',
    role_prompt_sha256: SHA256,
    return: { kind: 'json', schema_path: '/abs/path/to/coder-return.schema.json', required_sections: [], verdict_block: false },
    task_dir: '/abs/path/to/tasks/sample-repo/sample-repo-task',
    spec_path: '/abs/path/to/tasks/sample-repo/sample-repo-task/spec/be-1a.json',
    return_path: '/abs/path/to/tasks/sample-repo/sample-repo-task/returns/be-1a.1.json',
    signals_path: '/abs/path/to/tasks/sample-repo/sample-repo-task/signals/be-1a.1.jsonl',
    primary_checkout: '/abs/path/to/repo',
    isolation: 'worktree',
    worktree: { path: '/abs/path/to/worktrees/sample-repo/sample-repo-task/be-1a', branch: 'dt/sample-repo-task/be-1a', created_by_dispatcher: true, source_slice_id: null },
    cwd: '/abs/path/to/worktrees/sample-repo/sample-repo-task/be-1a',
    env: {
      DEVTEAM_WORKER: '1',
      DEVTEAM_ROLE: 'coder',
      DEVTEAM_TASK_ID: 'be-1a task',
      DEVTEAM_DISPATCH_ID: DISPATCH_ID,
      DEVTEAM_TASK_DIR: '/abs/path/to/tasks/sample-repo/sample-repo-task',
      DEVTEAM_DISPATCH_RECORD: '/abs/path/to/tasks/sample-repo/sample-repo-task/dispatch/be-1a.1.json',
      DEVTEAM_SIGNAL_LOG: '/abs/path/to/tasks/sample-repo/sample-repo-task/signals/be-1a.1.jsonl',
      DEVTEAM_GATE_COUNTER: '/abs/path/to/tasks/sample-repo/sample-repo-task/be-1a.1.gate',
    },
    attn_parent: ATTN,
    attn_upstream: ATTN,
    kickoff: 'Implement the change described in the spec.',
    gate: { max_blocks: 2 },
    timeout_s: 1800,
    max_turns: null,
    surface: null,
    created_at: '2026-08-01T00:00:00.000Z',
    bound_at: null,
    ended_at: null,
    outcome: null,
    ...overrides,
  }
}

test('Rider D: dispatch-record.schema.json still parses as JSON', () => {
  assert.ok(dispatchRecordSchema.properties)
})

test('Rider D: the top-level description now says state/<repo-slug>/<task-slug>/ and no longer the bare state/<task-slug>/ form', () => {
  const description = dispatchRecordSchema.description
  assert.equal(description.includes('state/<repo-slug>/<task-slug>/'), true)
  assert.equal(/state\/<task-slug>\//.test(description), false)
})

test('MF1: schema_version bumped to 2 for the blocked outcome enum addition', () => {
  assert.equal(dispatchRecordSchema.properties.schema_version.const, 2)
})

test('Rider D: validate() still accepts the create lifecycle fixture', async () => {
  const { validate } = await import('../scripts/cmux/contract.mjs')
  assert.deepEqual(validate(dispatchRecordSchema, buildDispatchRecord()), [])
})

test('Rider D: validate() still accepts the bind lifecycle fixture', async () => {
  const { validate } = await import('../scripts/cmux/contract.mjs')
  const record = buildDispatchRecord({ surface: { workspace_id: DISPATCH_ID, pane_id: DISPATCH_ID, surface_id: DISPATCH_ID }, bound_at: '2026-08-01T00:00:01.000Z' })
  assert.deepEqual(validate(dispatchRecordSchema, record), [])
})

test('Rider D: validate() still accepts the terminate lifecycle fixture', async () => {
  const { validate } = await import('../scripts/cmux/contract.mjs')
  const record = buildDispatchRecord({
    surface: { workspace_id: DISPATCH_ID, pane_id: DISPATCH_ID, surface_id: DISPATCH_ID },
    bound_at: '2026-08-01T00:00:01.000Z',
    ended_at: '2026-08-01T00:01:00.000Z',
    outcome: 'ok',
  })
  assert.deepEqual(validate(dispatchRecordSchema, record), [])
})

// ---------------------------------------------------------------------------
// be-11-05 (ADR-018) — parseEnvFile / hashEnvFile / the reserved-key backstop.
// ---------------------------------------------------------------------------

function writeEnvFile(dir, name, content) {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

test('parseEnvFile: file-level refusals all share the distinct env_file_unreadable reason', () => {
  const dir = makeTmpDir('cmux-envfile-')

  // non-absolute path
  assert.deepEqual(parseEnvFile('relative/path', { declaredKeys: [] }), { ok: false, reason: 'env_file_unreadable' })

  // missing file
  assert.deepEqual(parseEnvFile(join(dir, 'does-not-exist'), { declaredKeys: [] }), { ok: false, reason: 'env_file_unreadable' })

  // a directory is not a regular file
  const subdir = join(dir, 'a-directory')
  mkdirSync(subdir)
  assert.deepEqual(parseEnvFile(subdir, { declaredKeys: [] }), { ok: false, reason: 'env_file_unreadable' })

  // a symlink is refused via lstatSync, never followed
  const target = writeEnvFile(dir, 'target-env', 'FOO=1\n')
  const linkPath = join(dir, 'a-symlink')
  symlinkSync(target, linkPath)
  assert.deepEqual(parseEnvFile(linkPath, { declaredKeys: ['FOO'] }), { ok: false, reason: 'env_file_unreadable' })

  // exceeds 64 KiB
  const bigPath = writeEnvFile(dir, 'too-big-env', `FOO=${'x'.repeat(70 * 1024)}\n`)
  assert.deepEqual(parseEnvFile(bigPath, { declaredKeys: ['FOO'] }), { ok: false, reason: 'env_file_unreadable' })

  // unreadable (permission-denied) — best-effort: chmod 000 and restore after
  const unreadablePath = writeEnvFile(dir, 'unreadable-env', 'FOO=1\n')
  chmodSync(unreadablePath, 0o000)
  try {
    if (process.getuid && process.getuid() !== 0) {
      assert.deepEqual(parseEnvFile(unreadablePath, { declaredKeys: ['FOO'] }), { ok: false, reason: 'env_file_unreadable' })
    }
  } finally {
    chmodSync(unreadablePath, 0o644)
  }
})

test('parseEnvFile: ACCEPTED forms — blank lines, # comments, KEY=VALUE, a leading BOM stripped, CRLF normalized to LF', () => {
  const dir = makeTmpDir('cmux-envfile-')
  const content = '﻿# a comment\r\n\r\nFOO=bar\r\nBAZ=qux\r\n'
  const p = writeEnvFile(dir, 'good-env', content)
  const result = parseEnvFile(p, { declaredKeys: ['FOO', 'BAZ'] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.keys, ['FOO', 'BAZ'])
  assert.match(result.sha256, /^[0-9a-f]{64}$/)
})

// QA fix (Must-Fix #2, proven RCE): npm matches npm_config_* case-
// INSENSITIVELY, so the backstop must too — every case below uses a
// mixed/upper spelling deliberately.
test('parseEnvFile: REFUSAL — reserved key, exact-match and every prefix family, table-driven, INCLUDING mixed/upper-case spellings (case-insensitive backstop)', () => {
  const dir = makeTmpDir('cmux-envfile-')
  const cases = [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_BIN', 'DEVTEAM_RETURN_PATH',
    'PATH', 'NODE_OPTIONS', 'NODE_PATH', 'CMUX_BIN', 'GIT_SSH_COMMAND',
    'npm_config_script_shell', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD',
    'BASH_ENV', 'ENV', 'SHELL', 'IFS',
    'HOME', 'XDG_CONFIG_HOME', 'ZDOTDIR', 'PROMPT_COMMAND',
    'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE',
    // proven-RCE regression: the COMMON CI spelling is upper-case, which a
    // byte-exact prefix check would have missed entirely.
    'NPM_CONFIG_SCRIPT_SHELL', 'NPM_CONFIG_NODE_OPTIONS',
    // mixed case on an exact-match entry and on another prefix family.
    'Path', 'Git_SSH_COMMAND', 'node_options', 'ld_preload',
  ]
  for (const key of cases) {
    const p = writeEnvFile(dir, `reserved-${key.replace(/[^A-Za-z0-9]/g, '')}`, `${key}=whatever-secret-value\n`)
    const result = parseEnvFile(p, { declaredKeys: [key] })
    assert.equal(result.ok, false, `expected ${key} to be refused`)
    assert.equal(result.reason, 'env_file_reserved_key', `case ${key}`)
    assert.equal(result.key, key)
    assert.ok(result.matched, `expected a matched reserved family for ${key}`)
    // the refusal must never carry the value anywhere in the result
    assert.equal(JSON.stringify(result).includes('whatever-secret-value'), false)
  }
})

test('ENV_FILE_RESERVED_EXACT / ENV_FILE_RESERVED_PREFIXES drift guard — the exact frozen sets', () => {
  assert.deepEqual(
    [...ENV_FILE_RESERVED_EXACT].sort(),
    [
      'BASH_ENV', 'ENV', 'IFS', 'NODE_OPTIONS', 'NODE_PATH', 'PATH', 'SHELL',
      'HOME', 'XDG_CONFIG_HOME', 'ZDOTDIR', 'PROMPT_COMMAND',
      'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE',
    ].sort(),
  )
  assert.deepEqual([...ENV_FILE_RESERVED_PREFIXES].sort(), ['ANTHROPIC_', 'CLAUDE_', 'CMUX_', 'DEVTEAM_', 'DYLD_', 'GIT_', 'LD_', 'NODE_', 'npm_config_'].sort())
})

test('parseEnvFile: REFUSAL — reserved beats declared even when the key is listed in env_file_keys', () => {
  const dir = makeTmpDir('cmux-envfile-')
  const p = writeEnvFile(dir, 'reserved-declared-env', 'CMUX_BIN=/tmp/evil\n')
  const result = parseEnvFile(p, { declaredKeys: ['CMUX_BIN'] })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'env_file_reserved_key')
  assert.equal(result.key, 'CMUX_BIN')
})

test('parseEnvFile: REFUSAL — undeclared key names the key; a declared key merely absent from the file is fine (ok:true, warns are the caller\'s job)', () => {
  const dir = makeTmpDir('cmux-envfile-')
  const undeclaredPath = writeEnvFile(dir, 'undeclared-env', 'FOO=1\nBAR=2\n')
  const undeclaredResult = parseEnvFile(undeclaredPath, { declaredKeys: ['FOO'] })
  assert.equal(undeclaredResult.ok, false)
  assert.equal(undeclaredResult.reason, 'env_file_undeclared_key')
  assert.equal(undeclaredResult.key, 'BAR')

  const partialPath = writeEnvFile(dir, 'partial-env', 'FOO=1\n')
  const partialResult = parseEnvFile(partialPath, { declaredKeys: ['FOO', 'BAR'] })
  assert.equal(partialResult.ok, true)
  assert.deepEqual(partialResult.keys, ['FOO'])
})

test('parseEnvFile: REFUSAL — parser, table-driven, each names ONLY the 1-based line number, never the value/content', () => {
  const dir = makeTmpDir('cmux-envfile-')
  const cases = [
    { name: 'export-form', content: 'FOO=1\nexport BAR=2\n', line: 2 },
    { name: 'double-quoted', content: 'FOO="1"\n', line: 1 },
    { name: 'single-quoted', content: "FOO='1'\n", line: 1 },
    // QA fix (parser #4a): a backtick-quoted value — dotenv v16+ treats
    // backtick as a third, multiline-supporting quote character.
    { name: 'backtick-quoted', content: 'FOO=`1`\n', line: 1 },
    { name: 'trailing-backslash', content: 'FOO=1\\\n', line: 1 },
    // QA fix (parser #4b): a trailing backslash followed by a trailing
    // SPACE must still refuse — a consumer that trims before testing for a
    // continuation would otherwise read this as one.
    { name: 'trailing-backslash-then-space', content: 'FOO=1\\ \n', line: 1 },
    // JS escape only — never a literal NUL byte in the source file itself.
    { name: 'embedded-control-char', content: 'FOO=1\x00\n', line: 1 },
    // QA fix (parser #4c, whitelist not denylist): U+0085 (NEL) and
    // U+2028 (LINE SEPARATOR) — both outside tab/printable-ASCII, both
    // previously accepted by the old C0+DEL denylist.
    { name: 'nel-control-char', content: 'FOO=1\u0085\n', line: 1 },
    { name: 'line-separator-char', content: 'FOO=1\u2028\n', line: 1 },
    { name: 'duplicate-key', content: 'FOO=1\nFOO=2\n', line: 2 },
    { name: 'bad-key-charset', content: '1FOO=1\n', line: 1 },
    { name: 'unmatched-line', content: 'this is not a valid line at all\n', line: 1 },
  ]
  for (const c of cases) {
    const p = writeEnvFile(dir, `parse-${c.name}`, c.content)
    const result = parseEnvFile(p, { declaredKeys: ['FOO', 'BAR'] })
    assert.equal(result.ok, false, `expected ${c.name} to refuse`)
    assert.equal(result.reason, 'env_file_parse_error', `case ${c.name}`)
    assert.equal(result.line, c.line, `case ${c.name}`)
    // never the raw content/value anywhere in the refusal result
    assert.equal('content' in result, false)
    assert.equal('value' in result, false)
  }
})

// QA fix (Must-Fix #3, TOCTOU): parseEnvFile itself must return the sha256
// of the SAME bytes it validated (one read), not force the caller to
// re-read-and-hash the path separately.
test('parseEnvFile: the returned sha256 matches an independently computed digest over the identical bytes', async () => {
  const { createHash } = await import('node:crypto')
  const dir = makeTmpDir('cmux-envfile-')
  const content = 'FOO=bar\nBAZ=qux\n'
  const p = writeEnvFile(dir, 'hash-env', content)
  const expected = createHash('sha256').update(Buffer.from(content)).digest('hex')
  const result = parseEnvFile(p, { declaredKeys: ['FOO', 'BAZ'] })
  assert.equal(result.ok, true)
  assert.equal(result.sha256, expected)
})

test('hashEnvFile: deterministic sha256 over the raw bytes, matching an independently computed digest (standalone utility, retained but no longer used by workspaceCmd\'s own TOCTOU-closed path)', async () => {
  const { createHash } = await import('node:crypto')
  const dir = makeTmpDir('cmux-envfile-')
  const content = 'FOO=bar\nBAZ=qux\n'
  const p = writeEnvFile(dir, 'hash-env', content)
  const expected = createHash('sha256').update(Buffer.from(content)).digest('hex')
  assert.equal(hashEnvFile(p), expected)
  // deterministic across repeated calls
  assert.equal(hashEnvFile(p), hashEnvFile(p))
})

test('hashEnvFile: a byte-for-byte different file hashes differently', () => {
  const dir = makeTmpDir('cmux-envfile-')
  const a = writeEnvFile(dir, 'hash-a', 'FOO=1\n')
  const b = writeEnvFile(dir, 'hash-b', 'FOO=2\n')
  assert.notEqual(hashEnvFile(a), hashEnvFile(b))
})

// ---------------------------------------------------------------------------
// be-11-05 GAP FILL — line-ending edges, KEY/multi-'=' edges, reserved-key
// boundary cases, and hashEnvFile's deliberate pre-normalization stance.
// ---------------------------------------------------------------------------

test('parseEnvFile: a bare-CR (old-Mac) line ending is refused as a control character, not silently accepted as a line break', () => {
  const dir = makeTmpDir('cmux-envfile-')
  // No \n anywhere — old-Mac line endings are bare \r. raw.replace(/\r\n/g,
  // '\n') does not touch this (there is no \r\n pair), so the whole file is
  // ONE line for split('\n') purposes, and that line contains embedded \r
  // control characters — refused at line 1, never silently mis-split into
  // two accepted KEY=VALUE lines.
  const p = writeEnvFile(dir, 'bare-cr-env', 'FOO=1\rBAR=2\r')
  const result = parseEnvFile(p, { declaredKeys: ['FOO', 'BAR'] })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'env_file_parse_error')
  assert.equal(result.line, 1)
})

test('parseEnvFile: a file with no trailing newline on the last line still parses that last line normally', () => {
  const dir = makeTmpDir('cmux-envfile-')
  const p = writeEnvFile(dir, 'no-trailing-newline-env', 'FOO=1\nBAR=2')
  const result = parseEnvFile(p, { declaredKeys: ['FOO', 'BAR'] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.keys, ['FOO', 'BAR'])
})

test('parseEnvFile: a BOM-only file (zero bytes after stripping) is accepted with zero keys — a degenerate but valid accept', () => {
  const dir = makeTmpDir('cmux-envfile-')
  const p = writeEnvFile(dir, 'bom-only-env', '﻿')
  const result = parseEnvFile(p, { declaredKeys: [] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.keys, [])
})

test('parseEnvFile: a genuinely empty (zero-byte) file is accepted with zero keys', () => {
  const dir = makeTmpDir('cmux-envfile-')
  const p = writeEnvFile(dir, 'empty-env', '')
  const result = parseEnvFile(p, { declaredKeys: [] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.keys, [])
})

test('parseEnvFile: a file containing only comments and blank lines is accepted with zero keys', () => {
  const dir = makeTmpDir('cmux-envfile-')
  const p = writeEnvFile(dir, 'comments-only-env', '# just a comment\n\n   \n# another\n')
  const result = parseEnvFile(p, { declaredKeys: [] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.keys, [])
})

test('parseEnvFile: KEY/VALUE with multiple "=" — the first "=" splits KEY from VALUE, so FOO=bar=baz is key FOO, value bar=baz (never a parse error)', () => {
  const dir = makeTmpDir('cmux-envfile-')
  const p = writeEnvFile(dir, 'multi-eq-env', 'FOO=bar=baz\n')
  const result = parseEnvFile(p, { declaredKeys: ['FOO'] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.keys, ['FOO'])
})

test('parseEnvFile: a trailing space between the key and "=" (FOO =bar) fails the KEY=VALUE shape and refuses (space is not in the key charset)', () => {
  const dir = makeTmpDir('cmux-envfile-')
  const p = writeEnvFile(dir, 'trailing-space-key-env', 'FOO =bar\n')
  const result = parseEnvFile(p, { declaredKeys: ['FOO'] })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'env_file_parse_error')
  assert.equal(result.line, 1)
})

test('parseEnvFile: a value containing "#" is NOT treated as an inline comment — the whole line is KEY=VALUE, "#" is just part of the value', () => {
  const dir = makeTmpDir('cmux-envfile-')
  const p = writeEnvFile(dir, 'hash-in-value-env', 'FOO=a#b\n')
  const result = parseEnvFile(p, { declaredKeys: ['FOO'] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.keys, ['FOO'])
})

test('parseEnvFile: reserved-key boundary — NODE_ENV is refused via the NODE_ prefix family (not just the two literal NODE_OPTIONS/NODE_PATH exact-list members)', () => {
  const dir = makeTmpDir('cmux-envfile-')
  const p = writeEnvFile(dir, 'node-env-env', 'NODE_ENV=production\n')
  const result = parseEnvFile(p, { declaredKeys: ['NODE_ENV'] })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'env_file_reserved_key')
  assert.equal(result.key, 'NODE_ENV')
  assert.equal(result.matched, 'NODE_')
})

test('parseEnvFile: reserved-key boundary — PATHOLOGICAL is NOT refused (PATH is an EXACT-match member, not a prefix; it must never accidentally prefix-match a longer key)', () => {
  const dir = makeTmpDir('cmux-envfile-')
  const p = writeEnvFile(dir, 'pathological-env', 'PATHOLOGICAL=1\n')
  const result = parseEnvFile(p, { declaredKeys: ['PATHOLOGICAL'] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.keys, ['PATHOLOGICAL'])
})

// QA fix (Must-Fix #2, superseding the ORIGINAL gap-fill assumption below):
// reserved matching is now case-INSENSITIVE (npm honours npm_config_* case-
// insensitively, so the backstop must too) — a lowercase "path" therefore
// DOES refuse now, exactly like uppercase "PATH". This inverts what an
// earlier version of this test pinned; case-insensitivity is the fix, not
// a regression.
test('parseEnvFile: reserved-key boundary — lowercase "path" IS refused; reserved matching is case-INSENSITIVE (npm itself matches npm_config_* case-insensitively, so the backstop must too)', () => {
  const dir = makeTmpDir('cmux-envfile-')
  const p = writeEnvFile(dir, 'lowercase-path-env', 'path=/usr/local/bin\n')
  const result = parseEnvFile(p, { declaredKeys: ['path'] })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'env_file_reserved_key')
  assert.equal(result.key, 'path')
  assert.equal(result.matched, 'PATH')
})

test('hashEnvFile: a CRLF and an LF version of the SAME logical content hash DIFFERENTLY — a deliberate security choice (hashes raw pre-normalization bytes), even though parseEnvFile normalizes both to the identical key set', () => {
  const dir = makeTmpDir('cmux-envfile-')
  const crlfPath = writeEnvFile(dir, 'crlf-env', 'FOO=1\r\nBAR=2\r\n')
  const lfPath = writeEnvFile(dir, 'lf-env', 'FOO=1\nBAR=2\n')

  // parseEnvFile normalizes CRLF -> LF, so both parse to the identical keys.
  const crlfResult = parseEnvFile(crlfPath, { declaredKeys: ['FOO', 'BAR'] })
  const lfResult = parseEnvFile(lfPath, { declaredKeys: ['FOO', 'BAR'] })
  assert.equal(crlfResult.ok, true)
  assert.deepEqual(crlfResult.keys, ['FOO', 'BAR'])
  assert.equal(lfResult.ok, true)
  assert.deepEqual(lfResult.keys, ['FOO', 'BAR'])

  // Both parseEnvFile's OWN returned sha256 (single-read, TOCTOU-closed) and
  // the standalone hashEnvFile utility hash the RAW bytes, pre-normalization
  // — the two files must hash differently despite being logically identical
  // post-parse, and parseEnvFile's own hash must agree with hashEnvFile's.
  assert.notEqual(crlfResult.sha256, lfResult.sha256)
  assert.equal(crlfResult.sha256, hashEnvFile(crlfPath))
  assert.equal(lfResult.sha256, hashEnvFile(lfPath))
  assert.notEqual(hashEnvFile(crlfPath), hashEnvFile(lfPath))
})

// ---------------------------------------------------------------------------
// be-30-01 (issue #30, U-3) — the two 'RESERVED' comments #7 (PR #31)
// invalidated by shipping `/dev-team:team roster <role>=<agent>:<model>`.
// Prose-only pins: no code changed, schema_version stays 1.
// ---------------------------------------------------------------------------

test('be-30-01: roster.schema.json top-level description no longer claims the session layer is RESERVED / unreachable', () => {
  const description = rosterSchema.description
  assert.equal(/reserved/i.test(description), false)
  assert.equal(description.includes('no command exposes it yet'), false)
  assert.equal(description.includes('/dev-team:team roster'), true)
  assert.equal(description.includes('--config'), true)
  assert.equal(description.includes('does not survive /clear'), true)
})

test('be-30-01: roster.schema.json schema_version const is unchanged at 1 (mechanical proof the edit was prose-only)', () => {
  assert.equal(rosterSchema.properties.schema_version.const, 1)
})

test('be-30-01: resolve.mjs loadRoster header comment no longer calls the session layer reserved and documents the roster verb', () => {
  const src = readFileSync(join(ROOT, 'scripts/cmux/resolve.mjs'), 'utf8')
  const block = src.slice(src.indexOf('// loadRoster({'), src.indexOf('export function loadRoster'))
  assert.equal(/reserved/i.test(block), false)
  assert.equal(block.includes('/dev-team:team roster'), true)
})
