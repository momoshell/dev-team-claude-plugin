import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { delimiter, dirname, join, basename } from 'node:path'
import { acpLaunch, piActivatedTools, validatePiExtensionTools, PI_BUILTIN_TOOLS, PI_BUILTIN_EXTENSION_TOOLS, PI_MCP_SERVER_TOOLS, PI_ADVISOR_EXTENSION } from './adapters/adapter-pi.mjs'
import * as pi from './adapters/adapter-pi.mjs'
import { ROOT } from '../test/helpers.mjs'

const piSeatParts = (...args) => pi.piSeatParts(...args)

test('K7 and K8 MCP tools are pinned and unknown servers refuse', () => {
  // MUTATION: skip MCP table activation or its own-property guard.
  const expected = ['mcp__fff__find_files', 'mcp__fff__grep', 'mcp__fff__multi_grep']
  assert.deepEqual(piActivatedTools({ extensions: ['builtin:mcp'], mcpServers: [{ name: 'fff' }] }).filter((tool) => tool.startsWith('mcp__')), expected)
  assert.throws(() => piActivatedTools({ extensions: ['builtin:mcp'], mcpServers: [{ name: 'toString' }] }), (error) => error.reason === 'grant-unsupported' && error.message.includes('toString'))
  assert.deepEqual(PI_MCP_SERVER_TOOLS.fff, expected)
  assert.ok(Object.isFrozen(PI_MCP_SERVER_TOOLS) && Object.isFrozen(PI_MCP_SERVER_TOOLS.fff))
})
test('ADR47-L2 G1 null-cell advisor grant loads extension in rpc', () => {
  const grants = { advisor: true }
  const rpc = piSeatParts({ model: 'sonnet', promptFile: 'p', grants, advisorCell: null, env: {} })
  assert.ok(rpc.args.includes(PI_ADVISOR_EXTENSION))
})

function piOnPath() {
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    const candidate = join(directory || '.', 'pi')
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return null
}

test('ACP launch matrix, grants, all-denied policy, and refusal paths', () => {
  const bridge = join(ROOT, 'crew/pi/acp-bridge.mjs')
  const toolSet = 'read,bash,edit,write,grep,find,ls'
  const roles = [
    ['builder', 'Task,Agent,Workflow', [], ['bash', 'edit', 'write', 'powershell']],
    ['planner', 'Edit,NotebookEdit', ['edit'], ['bash', 'write', 'powershell']],
    ['tech-lead', 'Edit,NotebookEdit,Task,Agent,Workflow', ['edit'], ['bash', 'write', 'powershell']],
  ]
  for (const [role, deny, autoDeny, escalate] of roles) {
    const spec = { bin: '/opt/pi/dist/cli.js', model: 'openai-codex/x', promptFile: '/tmp/prompt.md', role, deny, cwd: '/tmp', env: { SENTINEL: 'yes' } }
    const launch = acpLaunch(spec)
    assert.deepEqual(launch, {
      bin: process.execPath,
      args: [bridge, '--model', spec.model, '--append-system-prompt', spec.promptFile, '--tools', toolSet,
        ...(autoDeny.length ? ['--exclude-tools', autoDeny.join(',')] : []), '--no-context-files', '--no-extensions', '--no-skills'],
      env: { SENTINEL: 'yes', CREW_FFF: '0', CREW_PI_BIN: spec.bin, CREW_ACP_GATED_TOOLS: escalate.join(',') },
      sessionParams: { cwd: '/tmp', mcpServers: [] },
    }, role)
  }

  const bare = acpLaunch({ bin: '/opt/pi/dist/cli.js', model: 'openai-codex/x', promptFile: '/tmp/prompt.md', cwd: '/tmp', env: {} })
  assert.equal(bare.args.includes('-e'), false)
  assert.equal(Object.hasOwn(bare.env, 'CREW_ADVISOR_ENDPOINT'), false)
  const extension = join(ROOT, 'crew/pi/extensions/subagent.ts')
  const grants = { tools: [], extensions: [extension], agents: [{ name: 'scout', def: '/scout.json' }], skills: ['/skill.md'], advisor: true }
  const granted = acpLaunch({ bin: '/opt/pi/dist/cli.js', model: 'openai-codex/x', promptFile: '/tmp/prompt.md', deny: 'Task', cwd: '/tmp', env: { SENTINEL: 'yes' }, grants, advisorCell: { endpoint: 'http://127.0.0.1:4567', model: 'openai-codex/advisor' } })
  const advisorExtension = join(ROOT, 'crew/pi/extensions/advisor.ts')
  assert.deepEqual(granted.args, [bridge, '--model', 'openai-codex/x', '--append-system-prompt', '/tmp/prompt.md', '--tools', `${toolSet},agent`, '--no-context-files', '--no-extensions', '-e', extension, '-e', advisorExtension, '--no-skills', '--skill', '/skill.md'])
  assert.deepEqual(granted.env, { SENTINEL: 'yes', CREW_FFF: '0', CREW_ADVISOR: '1', CREW_PI_AGENTS: JSON.stringify([{ name: 'scout', def: '/scout.json' }]), CREW_PI_BIN: '/opt/pi/dist/cli.js', CREW_ACP_GATED_TOOLS: 'bash,edit,write,powershell' })
  const unseatedAdvisor = acpLaunch({ bin: '/opt/pi/dist/cli.js', model: 'x', promptFile: '/p', cwd: '/tmp', env: {}, grants: { ...grants, advisor: true } })
  assert.deepEqual(Object.keys(unseatedAdvisor.env).filter((key) => key.startsWith('CREW_ADVISOR')), ['CREW_ADVISOR'])
  assert.equal(unseatedAdvisor.args.includes(advisorExtension), true)

  // No Claude deny name maps to pi's ACP-only powershell gate; it remains gated.
  const allDenied = acpLaunch({ bin: '/opt/pi/dist/cli.js', model: 'x', promptFile: '/p', cwd: '/tmp', env: {}, deny: 'Bash,Edit,Write' })
  assert.equal(allDenied.env.CREW_ACP_GATED_TOOLS, 'powershell')
  assert.deepEqual(allDenied.args.slice(allDenied.args.indexOf('--exclude-tools'), allDenied.args.indexOf('--exclude-tools') + 2), ['--exclude-tools', 'bash,edit,write'])
  for (const name of ['Task', 'Agent', 'Workflow']) assert.doesNotThrow(() => acpLaunch({ bin: '/opt/pi/dist/cli.js', model: 'x', promptFile: '/p', cwd: '/tmp', env: {}, deny: name }))
  for (const bin of ['pi', './pi']) assert.throws(() => acpLaunch({ bin }), /absolute/)
  assert.throws(() => acpLaunch({ bin: '/opt/pi/dist/cli.js', deny: 'Read,NoSuchTool' }), /NoSuchTool/)
})

test('pi extension activation declares tools, preserves passive entries, and refuses unknown or malformed grants', () => {
  assert.deepEqual(
    piActivatedTools({
      extensions: ['/checkout/crew/pi/extensions/custom.ts'],
      table: { 'crew/pi/extensions/custom.ts': ['custom'] },
    }),
    [...PI_BUILTIN_TOOLS, 'custom'],
  )
  assert.deepEqual(piActivatedTools({ extensions: ['/repo/crew/pi/extensions/readgate.ts'] }), PI_BUILTIN_TOOLS)

  assert.throws(
    () => piSeatParts({
      role: 'planner', model: 'sonnet', promptFile: '/tmp/prompt.md', tools: '', deny: '', taskDir: '/tmp', bootBrief: 'boot',
      grants: { tools: [], extensions: ['/repo/crew/pi/extensions/unknown-registering-extension.ts'], agents: [], skills: [], advisor: false },
    }),
    (error) => error.reason === 'grant-unsupported' && error.message.includes('unknown-registering-extension'),
  )
  assert.throws(
    () => validatePiExtensionTools({ 'crew/pi/extensions/bad-array.ts': 'bad' }),
    (error) => error.reason === 'grant-unsupported' && error.message.includes('bad-array.ts') && error.message.includes('"bad"'),
  )
  assert.throws(
    () => validatePiExtensionTools({ 'crew/pi/extensions/bad-tool.ts': [42] }),
    (error) => error.reason === 'grant-unsupported' && error.message.includes('bad-tool.ts') && error.message.includes('42'),
  )
  // TL-G1 (must-fix at review, closed by hand at closeout). Before this, the only
  // two call sites in the repo passed 'bad' and [42], so `tool.trim() === ''` and
  // the non-object table guard were both VACUOUS: deleting either left the lane
  // and all 13 gate checks green while a whitespace tool name activated into
  // --tools, or a null table degraded into an incidental Object.entries TypeError
  // instead of a typed refusal. MUTATION: drop `|| tool.trim() === ''`, or the
  // table guard, and one half of this test goes red.
  for (const blank of ['', ' ', '\t', '\n  ']) {
    assert.throws(
      () => validatePiExtensionTools({ 'crew/pi/extensions/blank-tool.ts': [blank] }),
      (error) => error.reason === 'grant-unsupported' && error.diagnosis === 'malformed-extension-declaration' && error.message.includes('blank-tool.ts'),
      `blank tool name ${JSON.stringify(blank)} must refuse`,
    )
  }
  for (const table of [null, undefined, 42, 'table', ['crew/pi/extensions/subagent.ts'], true]) {
    assert.throws(
      () => validatePiExtensionTools(table),
      (error) => error.reason === 'grant-unsupported' && error.diagnosis === 'malformed-extension-declaration' && error.message.includes('<table>'),
      `non-object table ${JSON.stringify(table)} must refuse by name, not throw incidentally`,
    )
  }
  // RV1-2: the diagnosis names the actual cause. Only a genuinely unknown
  // extension may claim 'unknown-registering-extension'; a declared-but-malformed
  // one previously reported that same token, and every assertion checking for it
  // passed on text the interpolated fixture path supplied anyway.
  assert.throws(
    () => validatePiExtensionTools({ 'crew/pi/extensions/bad-array.ts': null }),
    (error) => error.diagnosis === 'malformed-extension-declaration',
  )
  assert.throws(
    () => piActivatedTools({ extensions: ['/repo/crew/pi/extensions/nope.ts'] }),
    (error) => error.diagnosis === 'unknown-registering-extension',
  )
})

test('PI_BUILTIN_TOOLS matches pi\'s bundle when pi is installed', (t) => {
  const command = piOnPath()
  if (!command) return t.skip('pi is not installed on PATH')

  let cliPath
  try { cliPath = realpathSync(command) } catch (error) {
    return t.skip(`could not realpath pi on PATH: ${error.message}`)
  }
  if (basename(cliPath) !== 'cli.js' || basename(dirname(cliPath)) !== 'dist') {
    return t.skip(`pi on PATH does not resolve to dist/cli.js: ${cliPath}`)
  }

  const toolsPath = join(dirname(cliPath), 'core', 'tools', 'index.js')
  let source
  try { source = readFileSync(toolsPath, 'utf8') } catch (error) {
    return t.skip(`could not read pi's built-in tool bundle at ${toolsPath}: ${error.message}`)
  }
  const declaration = source.match(/allToolNames\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/)
  if (!declaration) return t.skip(`pi's built-in tool declaration was not found in ${toolsPath}`)
  const parsed = [...declaration[1].matchAll(/(['"])([^'"]+)\1/g)].map((match) => match[2])
  assert.deepEqual(new Set(parsed), new Set(PI_BUILTIN_TOOLS))
})
