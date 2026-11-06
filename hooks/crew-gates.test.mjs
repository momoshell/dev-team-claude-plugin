import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT, scratchDir } from '../test/helpers.mjs'
import { projectHash } from '../crew/onboard.mjs'

function fixture() {
  const home = scratchDir('crew-gates-home-'), checkout = scratchDir('crew-gates-repo-'), outside = scratchDir('crew-gates-outside-')
  mkdirSync(join(checkout, '.git'))
  const env = { ...process.env, HOME: home }
  delete env.CREW_ROLE; delete env.CREW_TASK_DIR; delete env.CREW_HOME
  return { home, checkout, outside, env }
}
function run(event, input, env) {
  const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks/hooks.json'), 'utf8')).hooks[event]
  assert.ok(hooks?.length, `${event} is registered`)
  const entry = event === 'PreToolUse' ? hooks.find(hook => hook.matcher === 'Bash|Write|Edit') : hooks[0]
  assert.ok(entry?.hooks[0]?.command, `${event} command is registered`)
  const command = entry.hooks[0].command.replaceAll('${CLAUDE_PLUGIN_ROOT}', ROOT)
  const result = spawnSync('sh', ['-c', command], { input: JSON.stringify(input), env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  return result.stdout
}
function denied(output) {
  assert.equal(JSON.parse(output).hookSpecificOutput.permissionDecision, 'deny')
}

test('SessionStart notes an unonboarded checkout and stays silent for seats, onboarded checkouts and non-git folders', () => {
  assert.ok(JSON.parse(readFileSync(join(ROOT, 'hooks/hooks.json'), 'utf8')).hooks.SessionStart?.[0]?.hooks[0]?.command)
  const { checkout, outside, env } = fixture()
  let output = run('SessionStart', { cwd: checkout }, env)
  assert.match(output, /not-onboarded/); assert.match(output, /\/onboard/)
  assert.equal(run('SessionStart', { cwd: checkout }, { ...env, CREW_ROLE: 'builder' }), '')
  mkdirSync(join(checkout, '.crew'))
  const project = { suite: 'npm test', proof: [] }
  writeFileSync(join(checkout, '.crew/project.json'), JSON.stringify({ ...project, onboarded: { hash: 'wrong' } }))
  output = run('SessionStart', { cwd: checkout }, env)
  assert.match(output, /onboarding-stale/); assert.match(output, /\/onboard/)
  writeFileSync(join(checkout, '.crew/project.json'), JSON.stringify({ ...project, onboarded: { hash: projectHash(project) } }))
  assert.equal(run('SessionStart', { cwd: checkout }, env), '')
  assert.equal(run('SessionStart', { cwd: outside }, env), '')
})

test('PreToolUse denies crew start and finish that resolve to a crew without the onboarding and provenance checks', () => {
  assert.ok(JSON.parse(readFileSync(join(ROOT, 'hooks/hooks.json'), 'utf8')).hooks.PreToolUse?.[0]?.hooks[0]?.command)
  const { home, checkout, outside, env } = fixture()
  const stale = join(home, '.claude/plugins/cache/dev-team/0.1.0')
  mkdirSync(join(stale, 'bin'), { recursive: true }); mkdirSync(join(stale, 'crew'))
  writeFileSync(join(stale, 'bin/crew.mjs'), '')
  for (const verb of ['start', 'finish']) writeFileSync(join(stale, `crew/${verb}.mjs`), '// old')
  const path = join(home, 'path'); mkdirSync(path); symlinkSync(join(stale, 'bin/crew.mjs'), join(path, 'crew'))
  // PATH lookup requires an executable launcher.
  const shellEnv = { ...env, PATH: `${path}:${env.PATH}` }
  chmodSync(join(stale, 'bin/crew.mjs'), 0o755)
  const runBash = (command, cwd = checkout, e = shellEnv) => run('PreToolUse', { cwd, tool_name: 'Bash', tool_input: { command } }, e)
  for (const command of [
    `cd ${checkout} && node ~/.claude/plugins/cache/dev-team/0.1.0/bin/crew.mjs start ~/.crew/briefs/x.md`,
    `node ${stale}/crew/finish.mjs lane --accept`,
    'crew start x.md',
    `CREW_HOME=${stale} crew finish lane`,
  ]) { const output = runBash(command); denied(output); assert.ok(output.includes(stale), command) }
  for (const command of [
    `cd ${checkout} && node ${ROOT}/bin/crew.mjs start x.md`,
    `node ${stale}/bin/crew.mjs lanes`,
    `node ${home}/missing/bin/crew.mjs start x.md`,
  ]) assert.equal(runBash(command), '', command)
  assert.equal(runBash(`node ${stale}/bin/crew.mjs start x.md`, checkout, { ...shellEnv, CREW_ROLE: 'builder' }), '')
  assert.equal(runBash(`node ${stale}/bin/crew.mjs start x.md`, outside), '')
})

test('PreToolUse denies writes to transcripts and started brief snapshots and allows reads', () => {
  assert.ok(JSON.parse(readFileSync(join(ROOT, 'hooks/hooks.json'), 'utf8')).hooks.PreToolUse?.[0]?.hooks[0]?.command)
  const { home, checkout, env } = fixture()
  const invoke = (tool_name, tool_input, e = env) => run('PreToolUse', { cwd: checkout, tool_name, tool_input }, e)
  const transcript = join(home, '.claude/projects/p/s.jsonl'), snapshot = join(home, '.crew/briefs/started/lane.md')
  for (const [tool, input, root] of [
    ['Write', { file_path: transcript }, join(home, '.claude/projects')],
    ['Edit', { file_path: snapshot }, join(home, '.crew/briefs/started')],
    ['Bash', { command: 'cd /repo && echo x >> ~/.claude/projects/p/s.jsonl' }, join(home, '.claude/projects')],
    ['Bash', { command: 'rm -f ~/.crew/briefs/started/lane.md' }, join(home, '.crew/briefs/started')],
    ['Bash', { command: 'cp /tmp/input ~/.crew/briefs/started/lane.md 2>/tmp/copy.log' }, join(home, '.crew/briefs/started')],
    ['Bash', { command: 'cd /tmp > ~/.crew/briefs/started/lane.md' }, join(home, '.crew/briefs/started')],
    ['Bash', { command: "cd ~/.crew/briefs/started && sed -i '' s/a/b/ lane.md" }, join(home, '.crew/briefs/started')],
    ...['echo x>','tee ', 'touch ', 'truncate ', 'unlink ', 'mv /tmp/x ', 'cp /tmp/x ', 'ln /tmp/x '].map(prefix => ['Bash', { command: `${prefix}~/.claude/projects/p/s.jsonl` }, join(home, '.claude/projects')]),
  ]) { const output = invoke(tool, input); denied(output); assert.ok(output.includes(root)) }
  for (const [tool, input] of [
    ['Bash', { command: 'cat ~/.claude/projects/p/s.jsonl | head -5' }],
    ['Bash', { command: 'cp ~/.claude/projects/p/s.jsonl /tmp/s.jsonl' }],
    ['Bash', { command: 'tee /tmp/transcript-copy < ~/.claude/projects/p/s.jsonl' }],
    ['Write', { file_path: join(home, '.crew/briefs/new-lane.md') }],
  ]) assert.equal(invoke(tool, input), '')
  assert.equal(invoke('Write', { file_path: transcript }, { ...env, CREW_ROLE: 'builder' }), '')
})

// MUTATION: drop the memory exception and every Claude Code auto-memory write in every project is denied.
test('PreToolUse allows Claude Code auto-memory writes beside the transcripts and still denies the transcripts', () => {
  const { home, checkout, env } = fixture()
  const invoke = (tool_name, tool_input) => run('PreToolUse', { cwd: checkout, tool_name, tool_input }, env)
  const memory = join(home, '.claude/projects/p/memory')
  for (const [tool, input] of [
    ['Write', { file_path: join(memory, 'note.md') }],
    ['Edit', { file_path: join(memory, 'MEMORY.md') }],
    ['Bash', { command: "sed -i '' s/a/b/ ~/.claude/projects/p/memory/MEMORY.md" }],
  ]) assert.equal(invoke(tool, input), '')
  for (const path of [join(home, '.claude/projects/p/s.jsonl'), join(home, '.claude/projects/memory/s.jsonl'), join(home, '.claude/projects/p/s/subagents/memory.jsonl')]) denied(invoke('Write', { file_path: path }))
  // A link inside memory/ that resolves to a transcript, or to another project, is not a memory write.
  mkdirSync(memory, { recursive: true })
  writeFileSync(join(home, '.claude/projects/p/s.jsonl'), '')
  symlinkSync(join(home, '.claude/projects/p/s.jsonl'), join(memory, 'pointer.jsonl'))
  symlinkSync(join(home, '.claude/projects/p'), join(memory, 'up'))
  mkdirSync(join(home, '.claude/projects/q/memory'), { recursive: true })
  symlinkSync(join(home, '.claude/projects/q/memory'), join(memory, 'other'))
  for (const command of ['echo x > ~/.claude/projects/p/memory/pointer.jsonl', 'echo x > ~/.claude/projects/p/memory/up/s.jsonl', 'echo x > ~/.claude/projects/p/memory/other/note.md']) denied(invoke('Bash', { command }))
  // A dangling link would create the transcript it names.
  symlinkSync(join(home, '.claude/projects/p/new.jsonl'), join(memory, 'ghost.jsonl'))
  symlinkSync(join(home, '.claude/projects/p/gone'), join(memory, 'ghostdir'))
  for (const name of ['pointer.jsonl', 'up/s.jsonl', 'ghost.jsonl', 'ghostdir/s.jsonl']) denied(invoke('Write', { file_path: join(memory, name) }))
  assert.equal(invoke('Write', { file_path: join(memory, 'new-note.md') }), '')
})

test('PreToolUse denies writes landing in protected roots through symlinked dirs and dotdot segments', () => {
  const { home, checkout, env } = fixture()
  const projects = join(home, '.claude/projects'), memory = join(projects, 'p/memory')
  const elsewhere = join(home, 'elsewhere')
  mkdirSync(memory, { recursive: true }); mkdirSync(elsewhere)
  symlinkSync(join(projects, 'p'), join(memory, 'up'))
  symlinkSync(join(projects, 'p/gone'), join(memory, 'ghostdir'))
  mkdirSync(join(projects, 'q/a/b/c'), { recursive: true }); mkdirSync(join(projects, 'q/memory'))
  symlinkSync(join(projects, 'q/a/b/c'), join(memory, 'link'))
  symlinkSync(join(projects, 'q/a/b'), join(memory, 'link2'))
  symlinkSync(elsewhere, join(memory, 'via'))
  symlinkSync('../.claude/projects/p/evil2.jsonl', join(elsewhere, 'relghost2'))
  symlinkSync(join(projects, 'p/other.jsonl'), join(elsewhere, 'transcript'))
  symlinkSync(join(home, '.crew/briefs/started/lane.md'), join(elsewhere, 'snapshot'))
  writeFileSync(join(elsewhere, 'outside-file'), 'x')
  writeFileSync(join(projects, 'p/logical.jsonl'), 'x')
  symlinkSync(join(elsewhere, 'outside-file'), join(projects, 'p/s.jsonl'))
  const cases = [
    ...['Write', 'Edit'].flatMap(tool => [
      [tool, { file_path: `${memory}/up/../s.jsonl` }],
      [tool, { file_path: `${memory}/ghostdir/../new.jsonl` }],
      [tool, { file_path: `${memory}/via/relghost2` }],
      [tool, { file_path: `${memory}/link/../../../memory/note.md` }],
      [tool, { file_path: `${memory}/link2/../../../q/memory/note.md` }],
      [tool, { file_path: `${projects}/p/./memory/link/../../../memory/note.md` }],
    ]),
    ['Write', { file_path: join(elsewhere, 'transcript') }],
    ['Edit', { file_path: join(elsewhere, 'snapshot') }],
    ...['rm -f', 'unlink'].map(command => ['Bash', { command: `${command} ${projects}/p/s.jsonl` }]),
    ['Bash', { command: `echo x > ${memory}/up/../s.jsonl` }],
    ['Bash', { command: `echo x > ${memory}/ghostdir/../new.jsonl` }],
    ['Bash', { command: `echo x > ${memory}/link/../../../memory/note.md` }],
    ['Bash', { command: `echo x > ${memory}/link2/../../../q/memory/note.md` }],
    ['Bash', { command: `cd ${memory}/link && echo x > ../../../memory/note.md` }],
    ['Bash', { command: `cd ${memory}/up && echo x > ../memory/evil.md` }],
    ['Bash', { command: `cd ${memory}/up/.. && echo x > ../logical.jsonl` }],
    ['Bash', { command: `cd ${memory} && cd up && echo x > ../memory/evil.md` }],
  ]
  for (const [tool_name, tool_input] of cases) {
    const output = run('PreToolUse', { cwd: checkout, tool_name, tool_input }, env)
    assert.notEqual(output, '', JSON.stringify([tool_name, tool_input]))
    denied(output)
  }
})

test('PreToolUse allows writes landing in the same project memory through a dangling dir and dotdot segment', () => {
  const { home, checkout, env } = fixture()
  const projects = join(home, '.claude/projects'), memory = join(projects, 'p/memory')
  mkdirSync(memory, { recursive: true })
  symlinkSync(join(projects, 'p/gone'), join(projects, 'ghostp'))
  mkdirSync(join(projects, 'q/memory'), { recursive: true })
  symlinkSync(join(projects, 'q/memory/back'), join(memory, 'roundtrip'))
  symlinkSync(memory, join(projects, 'q/memory/back'))
  writeFileSync(join(home, 'outside-file'), 'x')
  symlinkSync(join(home, 'outside-file'), join(memory, 'outside-link'))
  for (const [tool_name, tool_input] of [
    ['Write', { file_path: `${projects}/ghostp/../memory/note.md` }],
    ['Edit', { file_path: `${projects}/ghostp/../memory/note.md` }],
    ['Bash', { command: `echo x > ${projects}/ghostp/../memory/note.md` }],
    ['Write', { file_path: `${memory}/roundtrip/note.md` }],
    ['Write', { file_path: `${projects}/q/memory/../../p/memory/note.md` }],
    ['Write', { file_path: `${memory}/new-note.md` }],
    ['Bash', { command: `unlink ${memory}/outside-link` }],
  ]) assert.equal(run('PreToolUse', { cwd: checkout, tool_name, tool_input }, env), '', JSON.stringify([tool_name, tool_input]))
})
