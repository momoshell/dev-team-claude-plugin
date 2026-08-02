import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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
} from '../scripts/cmux/resolve.mjs'

const dispatchRecordSchema = JSON.parse(readFileSync(join(ROOT, 'scripts/cmux/dispatch-record.schema.json'), 'utf8'))
const rosterDefault = JSON.parse(readFileSync(join(ROOT, 'scripts/cmux/roster.default.json'), 'utf8'))
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

test('sidecarPaths returns the four flat, dispatch_id-keyed sidecar files under stateDir', () => {
  const roots = resolveRoots({ taskArtifactsRoot: '/abs/root' })
  const paths = taskPaths({ roots, repoSlug: 'repo', taskSlug: 'task' })
  const sidecars = sidecarPaths(paths, '11111111-1111-1111-1111-111111111111')
  assert.deepEqual(sidecars, {
    exit: '/abs/root/state/repo/task/11111111-1111-1111-1111-111111111111.exit',
    gate: '/abs/root/state/repo/task/11111111-1111-1111-1111-111111111111.gate',
    nonce: '/abs/root/state/repo/task/11111111-1111-1111-1111-111111111111.nonce',
    signalLog: '/abs/root/state/repo/task/11111111-1111-1111-1111-111111111111.signal-log',
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
