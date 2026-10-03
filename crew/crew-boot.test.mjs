import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, renameSync, chmodSync, statSync, symlinkSync, lstatSync, readlinkSync } from 'node:fs'
import { execSync, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openLedger } from '../scripts/factory/ledger.mjs'
import { writeRosterSnapshot, writePiSeatAgentDirs, writeMcpConfigs, loadLadder, assertBandFloors, BAND_FLOOR_REFUSALS, advisorManifest, bootCmd, BOOT_WORKSPACE_DEADLINE_MS, BOOT_WORKSPACE_POLL_MS, PANE_LAUNCH_MAX_BYTES, runCmd, stopCmd, resolveAdapters, RUN_START_EVENT, BATCH_DIR_EVENT, BATCH_DIR_NOT_BATCHED, batchDirFromBrief, RUN_CONFIG_DECLARATIONS, resolveFilesInScope, resolveLaneFence, resolveValidationLane, VALIDATION_LANE_REFUSAL, assertCtxSources, awaitSeatsReady, writeTerminalLine, UsageError, memoryConfig, CHARTER_BASELINE_BYTES, CHARTER_SOURCE_BUDGET, CHARTER_SOURCE_TOTAL_BUDGET, CHARTER_CEILINGS, CHARTER_BUDGET_REFUSAL, CHARTER_UNMEASURED_CAUSES, charterFileBytes, compiledCharterBytes, charterBudgetRefusals, charterSourceRefusals, assertCharterBudgets, charterBytesRecord, composeRolePrompt, persistedAdapters, ACP_TURN_CEILING_UNMEASURED, renderSeatSkills, SKILLS_BYTE_BUDGET, SKILL_DELIVERY_STATUSES, fenceSkillFiles, loadDeliveryMap, SKILL_PATHS_UNMEASURED, SKILL_BLOCK_CEILINGS, ROLE_PROMPT_CEILINGS, ROLE_PROMPT_UNMEASURED_CAUSES, rolePromptBytes, rolePromptRefusals, ROLE_PROMPT_REFUSAL, omitInlinedPiSkills } from './crew.mjs'
import { runChild, resolveValidationLane as resolveChildValidationLane } from './child.mjs'
import { daemon, RUN_CONFIG_DECLARATIONS as DAEMON_RUN_CONFIG_DECLARATIONS } from './daemon.mjs'
import { RUN_CONFIG_DECLARATIONS as FACTORY_RUN_CONFIG_DECLARATIONS, completionLogPath } from './factoryctl.mjs'
import { TASK_PROFILES } from './task-profiles.mjs'
import { ASSURANCES, ASSURANCE_ALIASES } from './assurances.mjs'
import { driveTask, LIMITS, VARIANTS, VARIANT_NAMES, DEFAULT_VARIANT, PROTECTED_PATHS, validateScopeEntries } from './drive.mjs'
import { LIMIT_REFUSALS, PLAN_ROUNDS_MAX, BUILD_ROUNDS_MAX, REVIEW_ROUNDS_MAX, limitsCtx, limitsRecord, resolveBuildRounds, resolveLimits, resolvePlanRounds, resolveReviewRounds } from './limits.mjs'
import { modelString as piModelString, seatCommand as piSeatCommand } from './adapters/adapter-pi.mjs'
import { seatIo } from './seat-io.mjs'
import { acpIo } from './acp-io.mjs'
import { testCheckout } from '../test/fixtures.mjs'
import { ROOT, scratchDir, git } from '../test/helpers.mjs'
import { loadMap, resolveSeatSkills, reachableSeatSkills, requiredSkills } from '../hooks/skill-gate.mjs'
import { probeRepo, ProfileRefusal, checkoutBaseBranch } from '../scripts/factory/probe-repo.mjs'
import { roster, nodeMeetsLedgerFloor, withHome, testCrewDir, callCounter, capabilityRegister } from './crew-test-helpers.mjs'

// Keep tests hermetic against the operator's router switch; adapter commands inherit process.env.
delete process.env.CREW_ROUTER_ATTEMPT_URL

// Keep lexical import reach visible before byte-pinned regex test bodies.
void [test, after, assert, createHash, readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, renameSync, readlinkSync, execSync, spawn, tmpdir, join, dirname, writePiSeatAgentDirs, writeMcpConfigs, openLedger, writeRosterSnapshot, loadLadder, assertBandFloors, BAND_FLOOR_REFUSALS, bootCmd, BOOT_WORKSPACE_DEADLINE_MS, BOOT_WORKSPACE_POLL_MS, runCmd, stopCmd, RUN_START_EVENT, BATCH_DIR_EVENT, BATCH_DIR_NOT_BATCHED, batchDirFromBrief, RUN_CONFIG_DECLARATIONS, resolveFilesInScope, resolveLaneFence, resolveValidationLane, VALIDATION_LANE_REFUSAL, assertCtxSources, awaitSeatsReady, writeTerminalLine, UsageError, memoryConfig, CHARTER_BASELINE_BYTES, CHARTER_SOURCE_BUDGET, CHARTER_SOURCE_TOTAL_BUDGET, CHARTER_CEILINGS, CHARTER_BUDGET_REFUSAL, CHARTER_UNMEASURED_CAUSES, charterFileBytes, compiledCharterBytes, charterBudgetRefusals, charterSourceRefusals, assertCharterBudgets, charterBytesRecord, composeRolePrompt, renderSeatSkills, SKILLS_BYTE_BUDGET, SKILL_DELIVERY_STATUSES, runChild, resolveChildValidationLane, daemon, DAEMON_RUN_CONFIG_DECLARATIONS, FACTORY_RUN_CONFIG_DECLARATIONS, completionLogPath, TASK_PROFILES, ASSURANCES, ASSURANCE_ALIASES, driveTask, LIMITS, VARIANTS, VARIANT_NAMES, DEFAULT_VARIANT, PROTECTED_PATHS, validateScopeEntries, LIMIT_REFUSALS, PLAN_ROUNDS_MAX, BUILD_ROUNDS_MAX, REVIEW_ROUNDS_MAX, limitsCtx, limitsRecord, resolveBuildRounds, resolveLimits, resolvePlanRounds, resolveReviewRounds, piModelString, seatIo, acpIo, testCheckout, ROOT, scratchDir, probeRepo, roster, nodeMeetsLedgerFloor, withHome, testCrewDir, callCounter, capabilityRegister, globalThis.realWrite]

test('K2 invalid CREW_PI_CODEMODE refuses before boot work', async () => {
  // MUTATION: remove the closed switch guard.
  await assert.rejects(resolveAdapters(['builder'], { 'agent-builder': 'pi' }, null, { register: capabilityRegister(), env: { CREW_PI_CODEMODE: 'maybe' } }), /CREW_PI_CODEMODE.*off, on/)
})
test('K11 K12 K13 K14 materialises a settings-only codemode profile and granted MCP JSON', () => {
  // MUTATION: change only-mode, omit base settings spread, empty MCP serialization, or skip auth link.
  const root = scratchDir('pi-agent-materialise-')
  const taskDir = join(root, 'task'); const base = join(root, 'base')
  mkdirSync(taskDir); mkdirSync(base)
  writeFileSync(join(base, 'settings.json'), JSON.stringify({ theme: 'dark', codemode: { timeout: 7, mode: 'off' } }))
  writeFileSync(join(base, 'auth.json'), 'secret')
  writeFileSync(join(base, 'mcp.json'), JSON.stringify({ mcpServers: { ambient: {} } }))
  const adapter = { mcpConfigPath: ({ taskDir: dir, role }) => join(dir, 'pi-agent', role, 'mcp.json'), capabilitiesFor: ({ grants }) => ({ ...(grants.extensions.includes('builtin:mcp') ? { mcp_servers: true } : {}) }) }
  const grants = { extensions: ['builtin:codemode', 'builtin:mcp'], mcp_servers: [{ name: 'fff', command: { bin: '/opt/fff-mcp', args: [] }, url: null }] }
  const adapters = { builder: { name: 'pi', adapter, transport: 'pane', grants } }
  writePiSeatAgentDirs({ taskDir, checkout: root, roles: ['builder'], adapters, env: { PI_CODING_AGENT_DIR: base } })
  const dir = join(taskDir, 'pi-agent', 'builder')
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')), { theme: 'dark', codemode: { timeout: 7, mode: 'only' } })
  assert.equal(readlinkSync(join(dir, 'auth.json')), join(base, 'auth.json'))
  writeMcpConfigs({ taskDir, roles: ['builder'], adapters })
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')), { mcpServers: { fff: { command: '/opt/fff-mcp', args: [], exposure: 'direct' } } })
})
test('a pi MCP seat refuses while the checkout carries a project .pi/mcp.json; a codemode-only seat does not', () => {
  // MUTATION: `if (false)` for the project-MCP refusal — pi would load that file after the seat's and let it win by name.
  const root = scratchDir('pi-agent-project-mcp-')
  const taskDir = join(root, 'task'); const base = join(root, 'base'); const checkout = join(root, 'checkout')
  mkdirSync(taskDir); mkdirSync(base); mkdirSync(join(checkout, '.pi'), { recursive: true })
  writeFileSync(join(checkout, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { fff: { command: '/hostile' } } }))
  const mcp = { name: 'pi', grants: { extensions: ['builtin:codemode', 'builtin:mcp'], mcp_servers: [{ name: 'fff', command: { bin: '/opt/fff-mcp', args: [] }, url: null }] } }
  assert.throws(() => writePiSeatAgentDirs({ taskDir, checkout, roles: ['builder'], adapters: { builder: mcp }, env: { PI_CODING_AGENT_DIR: base } }),
    (error) => error.reason === 'grant-unsupported' && error.message.includes(join(checkout, '.pi', 'mcp.json')))
  assert.equal(existsSync(join(taskDir, 'pi-agent', 'builder')), false)
  writePiSeatAgentDirs({ taskDir, checkout, roles: ['builder'], adapters: { builder: { name: 'pi', grants: { extensions: ['builtin:codemode'] } } }, env: { PI_CODING_AGENT_DIR: base } })
  assert.equal(existsSync(join(taskDir, 'pi-agent', 'builder', 'settings.json')), true)
})
test('boot hands its checkout to the project-MCP refusal', async () => {
  // MUTATION: pass writePiSeatAgentDirs any checkout but the booted one — the hostile .pi/mcp.json goes unseen.
  const home = scratchDir('pi-project-mcp-boot-')
  const { checkout } = testCheckout('pi-project-mcp-checkout-', home)
  mkdirSync(join(checkout, '.pi')); writeFileSync(join(checkout, '.pi', 'mcp.json'), '{"mcpServers":{}}')
  const register = capabilityRegister({ coding_agents: { pi: { ...capabilityRegister().coding_agents.pi, refuses: [] } } })
  register.roles.builder.mcp_servers = [{ name: 'fff', command: { bin: '/opt/fff-mcp', args: [] }, url: null }]
  const quiet = process.stdout.write; process.stdout.write = () => true
  try {
    await withHome(home, () => assert.rejects(bootCmd({ task: 'project-mcp', checkout, roles: 'builder', 'agent-lead': 'pi', 'agent-builder': 'pi', 'headless-all': true }, {
      env: { CREW_PI_CODEMODE: 'on', PI_CODING_AGENT_DIR: join(home, 'base') }, register, homedir: () => home, awaitSeatsReady: async () => {},
      cmux() { throw new Error('unexpected cmux') }, openRun: () => ({ recordSeats() {} }),
    }), (error) => error.reason === 'grant-unsupported' && error.message.includes(join(checkout, '.pi', 'mcp.json'))))
  } finally { process.stdout.write = quiet }
  // The boot's crew state lands in the scratch home, never the operator's ~/.crew.
  assert.equal(existsSync(testCrewDir(home, checkout, 'project-mcp')), true)
})
test('pi agent materialisation refuses before its recursive rm can reach the base dir or a redirected parent', () => {
  // MUTATION: `if (false)` for the base-within-seat guard (the seat rm deletes base auth.json), or drop the
  // symlinked pi-agent parent refusal (the rm and writes land in the link target).
  const root = scratchDir('pi-agent-guards-')
  const grants = { extensions: ['builtin:codemode'] }
  const adapters = { builder: { name: 'pi', grants } }
  const refused = (error) => error.reason === 'grant-unsupported' && /pi agent directory materialisation failed/.test(error.message)
  const nested = join(root, 'nested'); const seat = join(nested, 'pi-agent', 'builder')
  mkdirSync(seat, { recursive: true }); writeFileSync(join(seat, 'auth.json'), 'secret')
  assert.throws(() => writePiSeatAgentDirs({ taskDir: nested, checkout: root, roles: ['builder'], adapters, env: { PI_CODING_AGENT_DIR: seat } }), refused)
  assert.equal(readFileSync(join(seat, 'auth.json'), 'utf8'), 'secret')
  const linked = join(root, 'linked'); const elsewhere = join(root, 'elsewhere'); const base = join(root, 'base')
  mkdirSync(linked); mkdirSync(join(elsewhere, 'builder'), { recursive: true }); mkdirSync(base)
  writeFileSync(join(elsewhere, 'builder', 'keep'), 'kept')
  symlinkSync(elsewhere, join(linked, 'pi-agent'))
  assert.throws(() => writePiSeatAgentDirs({ taskDir: linked, checkout: root, roles: ['builder'], adapters, env: { PI_CODING_AGENT_DIR: base } }), refused)
  assert.equal(readFileSync(join(elsewhere, 'builder', 'keep'), 'utf8'), 'kept')
})

const SKILL_ROLES = ['lead', 'planner', 'builder', 'reviewer', 'tech-lead']
let skillBootHome
let skillBootCheckoutRoot
let skillBootCheckout
let skillBootBase
let skillBootFenced
async function skillBoot(fenced = false) {
  if (!skillBootHome) {
    skillBootHome = scratchDir('crew-skill-delivery-home-')
    const checkout = testCheckout('crew-skill-delivery-checkout-')
    skillBootCheckoutRoot = checkout.root
    skillBootCheckout = checkout.checkout
    execSync('git init -q', { cwd: skillBootCheckout })
    await withHome(skillBootHome, () => bootCmd(
      { task: 'skill-delivery-base', checkout: skillBootCheckout, roles: SKILL_ROLES.join(','), 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
    ))
    skillBootBase = testCrewDir(skillBootHome, skillBootCheckout, 'skill-delivery-base')
  }
  if (fenced && !skillBootFenced) {
    mkdirSync(join(skillBootCheckout, 'crew'), { recursive: true })
    writeFileSync(join(skillBootCheckout, 'crew', 'x.mjs'), 'export {}\n')
    execSync('git add crew/x.mjs && git -c user.email=test@example.com -c user.name=test commit -qm fence-fixture', { cwd: skillBootCheckout })
    const register = join(skillBootHome, 'fences.json')
    writeFileSync(register, JSON.stringify({ lanes: [{ lane: 'own', files: ['crew/x.mjs'] }, { lane: 'other', files: ['other.mjs'] }] }))
    await withHome(skillBootHome, () => bootCmd(
      { task: 'skill-delivery-fenced', checkout: skillBootCheckout, roles: SKILL_ROLES.join(','), 'headless-all': true, 'claude-bin': process.execPath, fences: register, lane: 'own' },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
    ))
    skillBootFenced = testCrewDir(skillBootHome, skillBootCheckout, 'skill-delivery-fenced')
  }
  const dir = fenced ? skillBootFenced : skillBootBase
  const row = readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((entry) => entry.event === 'boot').at(-1)
  return { dir, row }
}
after(async () => {
  if (skillBootHome) rmSync(skillBootHome, { recursive: true, force: true })
  if (skillBootCheckoutRoot) rmSync(skillBootCheckoutRoot, { recursive: true, force: true })
})
const skillBody = (name) => readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')

test('skill-delivery M1 role and path rules resolve in ordered deduplicated paths', () => {
  assert.deepEqual(resolveSeatSkills({ map: loadMap(ROOT).map, role: 'builder', files: ['crew/x.mjs', 'crew/x.test.mjs'] }).skills, ['skills/lean-build/SKILL.md', 'skills/backend-node/SKILL.md', 'skills/qa-test-writing/SKILL.md'])
})
test('skill-delivery M2 reviewer role rules resolve two skills', () => {
  assert.deepEqual(resolveSeatSkills({ map: loadMap(ROOT).map, role: 'reviewer', files: [] }).skills, ['skills/lean-build/SKILL.md', 'skills/pr-review/SKILL.md'])
})
test('skill-delivery M3 reviewer null fence preserves absence while [] is measured', () => {
  const map = loadMap(ROOT).map
  assert.deepEqual(resolveSeatSkills({ map, role: 'reviewer', files: null }).skills, ['skills/lean-build/SKILL.md', 'skills/pr-review/SKILL.md'])
  assert.equal(resolveSeatSkills({ map, role: 'reviewer', files: null }).paths_unmeasured, 'no-fence-register')
  assert.equal(resolveSeatSkills({ map, role: 'reviewer', files: [] }).paths_unmeasured, null)
})
test('skill-delivery M4 boot journals mapped skills and closed map failures', async () => {
  const { row } = await skillBoot()
  for (const role of SKILL_ROLES) {
    const expected = renderSeatSkills({ root: ROOT, mapResult: loadMap(ROOT), role, files: null }).skills
    assert.deepEqual(row.seat_skills[role].skills, expected)
    assert.ok(expected.length > 0)
    assert.equal(Object.hasOwn(row.seat_skills[role], 'reason'), false)
  }
  for (const [reason, content] of [['map-unreadable', null], ['map-unparseable', '{'], ['map-schema', '{}']]) {
    const root = scratchDir(`skill-${reason}-`)
    mkdirSync(join(root, 'skills'), { recursive: true })
    if (content !== null) writeFileSync(join(root, 'skills', 'skill-map.json'), content)
    try {
      const result = loadMap(root)
      assert.equal(result.reason, reason)
      for (const role of SKILL_ROLES) {
        const rendered = renderSeatSkills({ root, mapResult: result, role, files: null })
        assert.match(rendered.section, new RegExp(`Reason: ${reason}`)); assert.deepEqual(rendered.skills, []); assert.equal(rendered.reason, reason)
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})
test('skill-delivery D1 own fence delivers backend-node body in the builder prompt', async () => {
  const { dir } = await skillBoot(true)
  const prompt = readFileSync(join(dir, 'task', 'role-builder.md'), 'utf8')
  assert.ok(prompt.includes('## Plugin skills'))
  assert.ok(prompt.includes(skillBody('backend-node')))
  assert.ok(prompt.indexOf('## Plugin skills') > prompt.indexOf('# Role'))
  assert.equal(prompt.includes('---\nname: backend-node'), false)
})
test('skill-delivery D2 every booted role receives the exact lean-build body', async () => {
  const { dir } = await skillBoot()
  for (const role of SKILL_ROLES) assert.ok(readFileSync(join(dir, 'task', `role-${role}.md`), 'utf8').includes(skillBody('lean-build')))
})
test('skill-delivery D3 over-budget status includes absolute path and exact bytes without body', () => {
  const result = renderSeatSkills({ root: ROOT, mapResult: loadMap(ROOT), role: 'builder', files: [], budget: 300 })
  const body = skillBody('lean-build'); const path = join(ROOT, 'skills/lean-build/SKILL.md'); const bytes = Buffer.byteLength(body, 'utf8')
  assert.ok(result.section.includes(`over-budget: ${bytes} bytes — ${path}`)); assert.equal(result.section.includes(body), false)
})
test('skill-delivery D4 unreadable status includes absolute path', () => {
  const result = renderSeatSkills({ root: ROOT, mapResult: loadMap(ROOT), role: 'builder', files: [], read: () => { throw new Error('EPERM') } })
  // Kills: an unreadable skill recorded as a measured zero (bytes 0, "0 bytes") instead of absent.
  assert.ok(result.section.includes(`unreadable: unmeasured — ${join(ROOT, 'skills/lean-build/SKILL.md')}`))
  const record = result.skills.find((skill) => skill.path === join(ROOT, 'skills/lean-build/SKILL.md'))
  assert.equal(record.status, 'unreadable')
  assert.equal(record.bytes, null)
})
// Kills: raw span entries matched as paths (the span yields no backend-node), and directory
// entries not expanded (the directory yields no backend-node). The tracked list is a literal.
test('skill-delivery F1 span and directory fence entries resolve to the files the map matches', () => {
  const listed = []
  const listTracked = (_checkout, paths) => { listed.push(...paths); return paths.includes('crew') ? ['crew/a.mjs'] : [] }
  const map = loadDeliveryMap(ROOT)
  for (const entries of [['crew/crew.mjs:1-2'], ['crew/']]) {
    const { files, reason } = fenceSkillFiles(entries, { checkout: ROOT, listTracked })
    assert.equal(reason, null)
    const skills = renderSeatSkills({ root: ROOT, mapResult: map, role: 'builder', files }).skills.map((skill) => skill.path)
    assert.ok(skills.includes(join(ROOT, 'skills/backend-node/SKILL.md')), `${entries}: ${skills}`)
  }
  assert.deepEqual(listed, ['crew/crew.mjs', 'crew'])
})
// Kills: a failed listing treated as an empty fence (files [] and no reason) instead of unmeasured.
test('skill-delivery F2 a fence whose files cannot be listed is unmeasured with a closed reason', () => {
  const { files, reason } = fenceSkillFiles(['crew/'], { checkout: ROOT, listTracked: () => { throw new Error('not a git checkout') } })
  assert.equal(files, null)
  assert.equal(reason, 'fence-files-unlisted')
  assert.ok(SKILL_PATHS_UNMEASURED.includes(reason) && Object.isFrozen(SKILL_PATHS_UNMEASURED))
  const result = renderSeatSkills({ root: ROOT, mapResult: loadDeliveryMap(ROOT), role: 'builder', files, filesReason: reason })
  assert.equal(result.paths_unmeasured, 'fence-files-unlisted')
})

function gitFenceFixture() {
  const checkout = scratchDir('skill-delivery-git-fence-')
  mkdirSync(join(checkout, 'committed'), { recursive: true })
  writeFileSync(join(checkout, 'committed', 'keep.txt'), 'tracked\n')
  execSync('git init -q', { cwd: checkout, stdio: 'ignore' })
  execSync('git add -- committed/keep.txt', { cwd: checkout, stdio: 'ignore' })
  execSync('git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm fixture', { cwd: checkout, stdio: 'ignore' })
  const panel = 'visualizer/src/lib/newpanel/Panel.svelte'
  const ignored = 'visualizer/src/lib/newpanel/ignored.svelte'
  mkdirSync(join(checkout, 'visualizer/src/lib/newpanel'), { recursive: true })
  writeFileSync(join(checkout, panel), '<script>export let value</script>')
  writeFileSync(join(checkout, ignored), 'ignored')
  writeFileSync(join(checkout, '.gitignore'), `${ignored}\n`)
  return { checkout, panel, ignored }
}

// Kills: omit --others, which leaves the untracked component out of the directory fence.
test('U1', () => {
  const { checkout, panel } = gitFenceFixture()
  const directory = 'visualizer/src/lib/newpanel'
  const fenced = fenceSkillFiles([directory], { checkout })
  assert.equal(fenced.reason, null)
  assert.ok(fenced.files.includes(panel))
  const render = (files) => renderSeatSkills({ root: ROOT, mapResult: loadDeliveryMap(ROOT), role: 'builder', files })
  const skillPaths = ['skills/frontend-svelte/SKILL.md', 'skills/ui-design/SKILL.md', 'skills/ux/SKILL.md'].map((path) => join(ROOT, path))
  const delivered = render(fenced.files).skills.filter((skill) => skillPaths.includes(skill.path) && skill.status === 'delivered')
  assert.deepEqual(delivered.map((skill) => skill.path), skillPaths)
  assert.deepEqual(delivered, render([panel]).skills.filter((skill) => skillPaths.includes(skill.path) && skill.status === 'delivered'))
})

// Kills: omit --exclude-standard, which admits this existing ignored component.
test('U2', () => {
  const { checkout, ignored } = gitFenceFixture()
  const { files, reason } = fenceSkillFiles(['visualizer/src/lib/newpanel'], { checkout })
  assert.equal(reason, null)
  assert.ok(Array.isArray(files))
  assert.ok(!files.includes(ignored))
})

// Kills: omit --cached, which loses committed files from the directory fence.
test('U3', () => {
  const { checkout } = gitFenceFixture()
  const { files, reason } = fenceSkillFiles(['committed'], { checkout })
  assert.equal(reason, null)
  assert.ok(files.includes('committed/keep.txt'))
})

// Kills: delivery loading the map with the edit gate's strict file check (one missing skill
// withholds every skill as map-schema). The strict hook default is pinned in the same test.
test('skill-delivery L1 one missing skill file is reported alone and every other skill is delivered', () => {
  const root = scratchDir('skill-delivery-l1-')
  mkdirSync(join(root, 'skills', 'present'), { recursive: true })
  writeFileSync(join(root, 'skills', 'present', 'SKILL.md'), '---\nname: present\n---\npresent body\n')
  writeFileSync(join(root, 'skills', 'skill-map.json'), JSON.stringify({ version: 1, exempt: ['docs/**'], rules: [{ when: { roles: ['builder'] }, skills: ['dev-team:present', 'dev-team:absent'] }] }))
  assert.equal(loadMap(root).reason, 'map-schema')
  const result = renderSeatSkills({ root, mapResult: loadDeliveryMap(root), role: 'builder', files: null })
  assert.deepEqual(result.skills.map((skill) => [skill.path.slice(root.length + 1), skill.status]), [
    ['skills/absent/SKILL.md', 'unreadable'],
    ['skills/present/SKILL.md', 'delivered'],
  ])
  assert.ok(result.section.includes('present body'))
})
test('skill-delivery B1 boot journal byte accounting subtracts the skills section and separators', async () => {
  const { dir, row } = await skillBoot()
  for (const role of SKILL_ROLES) {
    const skills = renderSeatSkills({ root: ROOT, mapResult: loadMap(ROOT), role, files: null }).section
    assert.equal(row.charter_skills_bytes[role], Buffer.byteLength(skills, 'utf8') + 2)
    assert.equal(row.charter_base_bytes[role], row.charter_bytes[role] - row.charter_memory_bytes[role] - row.charter_skills_bytes[role])
    assert.ok(row.charter_base_bytes[role] <= CHARTER_CEILINGS[role])
    assert.ok(readFileSync(join(dir, 'task', `role-${role}.md`), 'utf8').includes(skills))
  }
})
test('skill-delivery B2 boot journal skill records have closed statuses, paths and byte counts', async () => {
  const { row } = await skillBoot()
  for (const role of SKILL_ROLES) {
    const skills = row.seat_skills[role].skills
    assert.ok(skills.length > 0)
    for (const skill of skills) assert.ok(SKILL_DELIVERY_STATUSES.includes(skill.status) && isAbsolute(skill.path) && Number.isInteger(skill.bytes))
  }
})
test('skill-delivery W1 maximum union of shipped path rules is delivered within budget', () => {
  const files = ['crew/x.mjs', 'crew/x.test.mjs', 'visualizer/x.svelte', 'visualizer/x.css']
  for (const role of SKILL_ROLES) {
    const result = renderSeatSkills({ root: ROOT, mapResult: loadMap(ROOT), role, files })
    assert.ok(result.skills.every((skill) => skill.status === 'delivered'))
    assert.ok(Buffer.byteLength(result.section, 'utf8') <= SKILLS_BYTE_BUDGET)
  }
})
test('skill-delivery R1 reviewer documentation names ladder sources', () => {
  const skill = readFileSync(join(ROOT, 'skills/pr-review/SKILL.md'), 'utf8')
  const rubric = readFileSync(join(ROOT, 'skills/pr-review/references/rubric.md'), 'utf8')
  assert.ok(skill.includes("- A hand-rolled shape where crew/roles/_shared.md's ladder or skills/lean-build/SKILL.md names an accepted one is a finding."))
  assert.match(rubric, /## Ladder/)
})

test('ADR047 J1 manifest records empty tripwires and resolved advisor cell', () => {
  const manifest = advisorManifest({ briefText: '- unrelated · item', task: 'task', runStartedAt: 1, cell: { provider: 'anthropic', id: 'claude-sonnet-5', agent: 'pi', effort: 'medium', model: 'anthropic/claude-sonnet-5' } })
  assert.deepEqual(manifest.tripwires, [])
  assert.equal(manifest.cell.id, 'claude-sonnet-5')
})

const SIGNAL_BLOCK_MS = 3000

function protectedProfile(factoryRoot, checkout, cell) {
  const repoKey = probeRepo({ checkout }).repo_key
  const path = join(factoryRoot, 'profiles', `${repoKey}.json`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({
    schema: 1, profile_version: 1, repo_key: repoKey, fields: { protected_paths_candidates: cell, default_branch: { status: 'ratified', value: 'main', source: 'human', ratified_by: 'human', ratified_at: '2026-08-16T00:00:00.000Z' } }, meta: {},
  }))
  return path
}


function childSignalFixture() {
  const root = mkdtempSync(join(tmpdir(), 'crew-child-signal-'))
  const crewDir = join(root, 'crew')
  const returnsDir = join(crewDir, 'returns')
  mkdirSync(join(crewDir, 'task'), { recursive: true })
  mkdirSync(returnsDir, { recursive: true })
  const taskReturn = join(returnsDir, 'task.json')
  const brief = join(crewDir, 'brief.md')
  writeFileSync(brief, '# child signal brief\n')
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: 'child-signal', checkout: root,
    roles: ['planner', 'builder', 'reviewer'],
    members: Object.fromEntries(['planner', 'builder', 'reviewer'].map((role) => [role, {
      surface_id: null, pane_id: null, transport: 'headless-json', model: 'sonnet', agent: 'claude',
    }])),
    task_return: taskReturn,
  }))
  writeFileSync(join(crewDir, 'journal.jsonl'), '')
  return { root, crewDir, taskReturn, brief, ledger: join(root, 'ledger.db') }
}

// A real signal to a real child is the only proof that survives the 2026-08-11
// convention: send SIGTERM while the child is blocked inside one named stretch of
// runChild and read how it died. Default disposition is `signal: 'SIGTERM'`; a
// handler armed across a turn-free stretch can never dispatch but still
// suppresses that disposition, so an armed child instead runs the block out and
// exits 0. Measured on this checkout: unarmed windows die in 1-2ms.

const SIGNAL_KILL_BOUND_MS = 1000

async function sigtermWhileBlocked(f, body) {
  const harness = join(f.root, 'signal-harness.mjs')
  writeFileSync(harness, `import { runChild } from ${JSON.stringify(new URL('./child.mjs', import.meta.url).href)}
import { writeFileSync as realWrite } from 'node:fs'
const taskReturn = ${JSON.stringify(f.taskReturn)}
const spec = { crew_dir: ${JSON.stringify(f.crewDir)}, task: 'child-signal',
  brief_file: ${JSON.stringify(f.brief)}, checkout: ${JSON.stringify(f.root)},
  ledger_db: ${JSON.stringify(f.ledger)} }
const env = { DEVTEAM_LEDGER_DB: ${JSON.stringify(f.ledger)} }
const block = () => { process.stdout.write('mark\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${SIGNAL_BLOCK_MS}) }
${body}
`)
  let child
  try {
    child = spawn(process.execPath, [harness], { stdio: ['ignore', 'pipe', 'pipe'] })
    return await new Promise((resolve, reject) => {
      let marked = false
      let sentAt = null
      let settled = false
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, 15000)
      const finish = (value, failed = false) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (failed) reject(value)
        else resolve(value)
      }
      child.once('error', (err) => finish(err, true))
      child.stdout.on('data', (chunk) => {
        if (marked || !String(chunk).includes('mark')) return
        marked = true
        sentAt = Date.now()
        child.kill('SIGTERM')
      })
      child.stderr.on('data', () => {})
      child.once('exit', (code, signal) => finish({ marked, code, signal, elapsed: sentAt == null ? null : Date.now() - sentAt }))
    })
  } finally {
    if (child && child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
  }
}


function assertKilledBySigterm(outcome, where) {
  assert.equal(outcome.marked, true, `the child never reached ${where}`)
  assert.equal(outcome.signal, 'SIGTERM', `${where}: expected death by SIGTERM, got exit code ${outcome.code}`)
  assert.ok(outcome.elapsed < SIGNAL_KILL_BOUND_MS, `${where}: expected death within ${SIGNAL_KILL_BOUND_MS}ms, took ${outcome.elapsed}ms`)
}


function stopUnitFixture({ sidecar = { adw_id: 'unit-run', db_path: '/tmp/unit-ledger.db' }, command = '/checkout/crew/crew.mjs run --task unit-stop', sessions = [{ status: 'running' }], alive = [false], processKill = null, psCommand = null, deathGraceMs = 0 } = {}) {
  const calls = { opened: 0, closed: 0, gets: 0, kills: [], ends: [], output: '' }
  let index = 0
  const ledger = {
    getSession: () => sessions[Math.min(index++, sessions.length - 1)],
    endSession: (payload) => { calls.ends.push(payload) },
    close: () => { calls.closed += 1 },
  }
  const deps = {
    pathsFor: () => ({ dir: '/state' }),
    loadCrew: () => ({ checkout: '/checkout' }),
    existsSync: () => true,
    readFileSync: () => JSON.stringify(sidecar),
    openLedger: () => { calls.opened += 1; return ledger },
    psCommand: () => (typeof psCommand === 'function' ? psCommand() : command),
    isAlive: () => alive.length ? alive.shift() : true,
    processKill: (pid, signal) => {
      calls.kills.push([pid, signal])
      if (processKill) return processKill(pid, signal)
    },
    delay: async () => {},
    deathGraceMs,
    stdout: { write: (text) => { calls.output += String(text) } },
  }
  return { calls, ledger, deps }
}


test('run configuration declarations stay identical across every entry point', () => {
  const declarations = [RUN_CONFIG_DECLARATIONS, DAEMON_RUN_CONFIG_DECLARATIONS, FACTORY_RUN_CONFIG_DECLARATIONS]
  for (const value of declarations) {
    assert.deepEqual(Object.keys(value).sort(), ['assuranceAliases', 'assurances', 'profiles', 'variantNames'])
    assert.equal(value.profiles, TASK_PROFILES)
    assert.equal(value.assurances, ASSURANCES)
    assert.equal(value.assuranceAliases, ASSURANCE_ALIASES)
    assert.deepEqual(value.variantNames, VARIANT_NAMES)
  }
})

test('resolveFilesInScope parses a comma list, handles neutral shapes, and refuses a valueless flag', () => {
  const inherited = VARIANT_NAMES.find((name) => VARIANTS[name]?.sources?.scope === 'inherited')
  const plain = VARIANT_NAMES.find((name) => VARIANTS[name]?.sources?.scope !== 'inherited')
  assert.deepEqual(resolveFilesInScope({ 'files-in-scope': ' a.mjs, , b.mjs ' }, inherited, '/missing/task.json'), ['a.mjs', 'b.mjs'])
  assert.equal(resolveFilesInScope({}, plain, '/missing/task.json'), null)
  assert.throws(() => resolveFilesInScope({ 'files-in-scope': true }, plain, '/missing/task.json'), /needs a comma-separated list/)
})

test('resolveFilesInScope inherits the preferred or fallback list and names every unreadable envelope', () => {
  const inherited = VARIANT_NAMES.find((name) => VARIANTS[name]?.sources?.scope === 'inherited')
  const dir = mkdtempSync(join(tmpdir(), 'crew-scope-envelope-'))
  const preferred = join(dir, 'preferred.json')
  const fallback = join(dir, 'fallback.json')
  const malformed = join(dir, 'malformed.json')
  try {
    writeFileSync(preferred, JSON.stringify({ details: { files_in_scope: ['lib/a.mjs'], files_committed: ['lib/b.mjs'] } }))
    writeFileSync(fallback, JSON.stringify({ details: { files_committed: ['lib/b.mjs'] } }))
    writeFileSync(malformed, '{not-json')
    assert.deepEqual(resolveFilesInScope({}, inherited, preferred), ['lib/a.mjs'])
    assert.deepEqual(resolveFilesInScope({}, inherited, fallback), ['lib/b.mjs'])
    for (const [path, deps] of [
      [join(dir, 'missing.json'), {}],
      [preferred, { existsSync: () => true, readFileSync: () => { throw new Error('denied') } }],
      [malformed, {}],
    ]) {
      assert.throws(() => resolveFilesInScope({}, inherited, path, deps), (err) => err.message.includes(path))
    }
    for (const [index, details] of [{ files_in_scope: 'lib/a.mjs' }, { files_in_scope: [] }, {}].entries()) {
      const path = join(dir, `bad-${index}.json`)
      writeFileSync(path, JSON.stringify({ details }))
      assert.throws(() => resolveFilesInScope({}, inherited, path), (err) => err.message.includes(path))
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('resolveFilesInScope refuses every entry the gate rejects', () => {
  const plain = VARIANT_NAMES.find((name) => VARIANTS[name]?.sources?.scope !== 'inherited')
  for (const entry of ['lib/*.mjs', '/abs/path.mjs', '../up.mjs', 'crew/', '']) {
    const defects = validateScopeEntries([entry])
    assert.equal(defects.length, 1)
    assert.throws(() => resolveFilesInScope({ 'files-in-scope': entry }, plain, '/missing/task.json'), (err) => err.message.includes(JSON.stringify(entry)))
  }
})

test('resolveLaneFence takes both flags or neither', () => {
  assert.equal(resolveLaneFence({}), null)
  assert.throws(() => resolveLaneFence({ lane: 'a' }), /given together or not at all/)
  assert.throws(() => resolveLaneFence({ fences: '/missing/fences.json' }), /given together or not at all/)
  const dir = mkdtempSync(join(tmpdir(), 'crew-fence-resolver-'))
  const register = join(dir, 'fences.json')
  execSync('git init -q', { cwd: dir })
  try {
    writeFileSync(register, JSON.stringify({ lanes: [
      { lane: 'b', files: ['z.mjs', 'y.mjs'] },
      { lane: 'a', files: ['x.mjs'] },
    ] }))
    assert.deepEqual(resolveLaneFence({ fences: register, lane: 'a', checkout: dir }), {
      lane: 'a', fence: [{ lane: 'b', files: ['y.mjs', 'z.mjs'] }],
    })
    mkdirSync(join(dir, 'config'))
    writeFileSync(register, JSON.stringify({ lanes: [
      { lane: 'b', files: ['config'] },
      { lane: 'a', files: ['x.mjs'] },
    ] }))
    assert.throws(
      () => resolveLaneFence({ fences: register, lane: 'a', checkout: dir }),
      (err) => err.reason === 'scope-directory-unslashed',
    )
    writeFileSync(register, JSON.stringify({ lanes: [
      { lane: 'b', files: ['config/'] },
      { lane: 'a', files: ['x.mjs'] },
    ] }))
    assert.deepEqual(resolveLaneFence({ fences: register, lane: 'a', checkout: dir }), {
      lane: 'a', fence: [{ lane: 'b', files: ['config/'] }],
    })
    assert.throws(() => resolveLaneFence({ fences: register, lane: 'unknown', checkout: dir }), (err) => err.reason === 'unknown-lane')
    writeFileSync(register, '{not json')
    assert.throws(() => resolveLaneFence({ fences: register, lane: 'a' }), (err) => err.reason === 'bad-fences')
    const source = readFileSync(new URL('./crew.mjs', import.meta.url), 'utf8')
    assert.match(source, /--fences/)
    assert.match(source, /--lane/)
    assert.match(source, /paired: both or neither/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('attended and child entrypoints resolve validation lanes identically', () => {
  const table = [
    [{}, { lane: null, source: 'none' }],
    [{ lane: null }, { lane: null, source: 'none' }],
    [{ validationLane: null }, { lane: null, source: 'none' }],
    [{ validationLane: '  node --test  ' }, { lane: 'node --test', source: 'validation-lane' }],
    [{ lane: '  npm test  ' }, { lane: 'npm test', source: 'lane' }],
    [{ lane: 'fence-register-name', fences: 'register.json' }, { lane: null, source: 'none' }],
    [{ validationLane: '  validation-command  ', lane: 'fence-register-name', fences: 'register.json' }, { lane: 'validation-command', source: 'validation-lane' }],
  ]
  for (const resolver of [resolveValidationLane, resolveChildValidationLane]) {
    for (const [args, expected] of table) assert.deepEqual(resolver(args), expected)
    for (const raw of [true, '   ', 42]) {
      assert.throws(() => resolver({ validationLane: raw }), (err) => {
        assert.equal(err.reason, 'invalid-validation-lane')
        assert.match(err.message, /--validation-lane/)
        assert.match(err.message, /\[invalid-validation-lane\]/)
        return true
      })
      assert.throws(() => resolver({ lane: raw }), (err) => err.reason === 'invalid-validation-lane')
    }
  }
})

test('daemon enqueue without a lane forwards null and the child resolves it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-daemon-null-lane-'))
  const crewDir = join(dir, 'crew')
  const returnsDir = join(crewDir, 'returns')
  mkdirSync(join(crewDir, 'task'), { recursive: true })
  mkdirSync(returnsDir, { recursive: true })
  const roles = ['planner', 'builder', 'reviewer']
  const brief = join(dir, 'brief.md')
  writeFileSync(brief, '# daemon null lane brief\n')
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: 'daemon-null-lane', checkout: dir, roles,
    members: Object.fromEntries(roles.map((role) => [role, {
      surface_id: null, pane_id: null, transport: 'headless-json', model: 'sonnet', agent: 'claude',
    }])),
    task_return: join(returnsDir, 'task.json'),
  }))
  writeFileSync(join(crewDir, 'journal.jsonl'), '')
  const forks = []
  let clock = 1
  const d = daemon({
    root: join(dir, 'daemon'),
    deps: {
      pid: 700, now: () => clock++, uuid: (() => { let n = 0; return () => `run-${++n}` })(),
      fork(...args) { forks.push(args); return { pid: 900, on() {}, kill() {}, unref() {}, disconnect() {} } },
      kill: () => true, setInterval: () => null, clearInterval: () => {},
    },
  })
  try {
    d.enqueue({ crew_dir: crewDir, task: 'daemon-null-lane', checkout: dir, brief_file: brief })
    assert.equal(forks.length, 1)
    const spec = JSON.parse(forks[0][1][1])
    assert.equal(spec.lane, null, 'the daemon normalises an absent lane to null')
    let seen = null
    let drove = 0
    const rows = []
    runChild(spec, {
      preflight: false,
      seatIo: () => ({ log: (row) => rows.push(row) }),
      driveTask: (ctx) => { drove += 1; seen = ctx; return { status: 'done', summary: '', artifacts: [], details: {} } },
      env: { DEVTEAM_LEDGER_DB: join(dir, 'ledger.db') },
    })
    assert.equal(drove, 1)
    assert.equal(seen.lane, null)
    const row = rows.find((entry) => entry.event === 'validation-lane')
    assert.deepEqual(row, { at: row.at, event: 'validation-lane', lane: null, source: 'none' })
  } finally {
    await d.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolvePlanRounds resolves absent and valid values and refuses invalid budgets closed', () => {
  assert.equal(resolvePlanRounds(undefined), null)
  assert.equal(resolvePlanRounds(null), null)
  assert.equal(resolvePlanRounds(''), null)
  assert.equal(resolvePlanRounds('6'), 6)
  assert.equal(resolvePlanRounds(6), 6)
  assert.equal(resolvePlanRounds(' 3 '), 3)
  for (const raw of [true, 'abc', '2.5', 2.5, 0, -1, '0x4', [], PLAN_ROUNDS_MAX + 1]) {
    assert.throws(() => resolvePlanRounds(raw), (err) => {
      assert.equal(err.reason, 'invalid-plan-rounds')
      assert.ok(LIMIT_REFUSALS.includes(err.reason))
      return true
    })
  }
})

test('resolveBuildRounds and resolveReviewRounds resolve absent and valid values and refuse invalid budgets closed', () => {
  for (const [resolve, reason, max] of [
    [resolveBuildRounds, 'invalid-build-rounds', BUILD_ROUNDS_MAX],
    [resolveReviewRounds, 'invalid-review-rounds', REVIEW_ROUNDS_MAX],
  ]) {
    assert.equal(resolve(undefined), null)
    assert.equal(resolve(null), null)
    assert.equal(resolve(''), null)
    assert.equal(resolve('3'), 3)
    assert.equal(resolve(3), 3)
    assert.equal(resolve(' 3 '), 3)
    for (const raw of [true, 'abc', '2.5', 2.5, 0, -1, '0x4', [], max + 1]) {
      assert.throws(() => resolve(raw), (err) => {
        assert.equal(err.reason, reason)
        assert.ok(LIMIT_REFUSALS.includes(err.reason))
        return true
      })
    }
  }
})

test('resolveLimits and limitsCtx overlay only the flagged keys', () => {
  const none = resolveLimits({})
  assert.deepEqual(none, { plan_rounds: null, build_rounds: null, review_rounds: null })
  assert.equal(limitsCtx(none), null)
  assert.deepEqual(limitsCtx(resolveLimits({ build_rounds: 4 })), { build_rounds: 4 })
})

test('limitsRecord records all effective round budgets with per-key sources', () => {
  assert.deepEqual(limitsRecord(resolveLimits({}), LIMITS), {
    plan_rounds: LIMITS.plan_rounds, build_rounds: LIMITS.build_rounds, review_rounds: LIMITS.review_rounds,
    source: { plan_rounds: 'default', build_rounds: 'default', review_rounds: 'default' },
  })
  assert.deepEqual(limitsRecord(resolveLimits({ build_rounds: 6, review_rounds: 1 }), LIMITS), {
    plan_rounds: LIMITS.plan_rounds, build_rounds: 6, review_rounds: 1,
    source: { plan_rounds: 'default', build_rounds: 'flag', review_rounds: 'flag' },
  })
})

test('run refuses an invalid round budget before reading crew state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-rounds-refusal-home-'))
  let drove = 0
  try {
    await withHome(home, () => {
      for (const [flag, reason] of [
        ['plan-rounds', 'invalid-plan-rounds'],
        ['build-rounds', 'invalid-build-rounds'],
        ['review-rounds', 'invalid-review-rounds'],
      ]) {
        assert.throws(
          () => runCmd({ task: 'invalid-rounds-run', checkout: process.cwd(), 'brief-file': join(home, 'missing.md'), [flag]: '2.5' }, { drive: () => { drove += 1 } }),
          (err) => err.reason === reason,
        )
      }
      assert.equal(existsSync(join(home, '.crew')), false)
    })
    assert.equal(drove, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('run plumbs flagged budgets, records defaults when absent, and preserves driver overrides', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-rounds-run-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-rounds-run-home-'))
  const task = 'rounds-run'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# rounds brief\n')
  const previousLedger = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = join(home, 'ledger.db')
  const seen = []
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      const capture = (ctx) => { seen.push(ctx); return done }
      runCmd({ task, checkout, 'brief-file': brief, 'plan-rounds': '4', keep: true }, { drive: capture })
      runCmd({ task, checkout, 'brief-file': brief, 'build-rounds': '5', 'review-rounds': '1', keep: true }, { drive: capture })
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: capture })

      assert.equal(RUN_START_EVENT, 'run-start')
      assert.ok(seen.every((ctx) => ctx.publish && typeof ctx.publish.branch === 'string'))
      assert.deepEqual(seen[0].limits, { plan_rounds: 4 })
      assert.deepEqual(seen[1].limits, { build_rounds: 5, review_rounds: 1 })
      assert.equal(Object.prototype.hasOwnProperty.call(seen[2], 'limits'), false)
      const rows = readFileSync(seen[0].journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
        .filter((row) => row.event === 'limits')
      assert.equal(rows.length, 3)
      assert.deepEqual(rows[0], {
        at: rows[0].at, event: 'limits', plan_rounds: 4, build_rounds: LIMITS.build_rounds, review_rounds: LIMITS.review_rounds,
        source: { plan_rounds: 'flag', build_rounds: 'default', review_rounds: 'default' },
      })
      assert.deepEqual(rows[1], {
        at: rows[1].at, event: 'limits', plan_rounds: LIMITS.plan_rounds, build_rounds: 5, review_rounds: 1,
        source: { plan_rounds: 'default', build_rounds: 'flag', review_rounds: 'flag' },
      })
      assert.deepEqual(rows[2], {
        at: rows[2].at, event: 'limits', plan_rounds: LIMITS.plan_rounds, build_rounds: LIMITS.build_rounds, review_rounds: LIMITS.review_rounds,
        source: { plan_rounds: 'default', build_rounds: 'default', review_rounds: 'default' },
      })

      const stages = []
      const io = {
        assign: ({ role }) => ({ id: role, returnPath: role }),
        wait: (returnPath) => returnPath === 'planner'
          ? { status: 'insufficient', role: 'planner', summary: 'the brief leaves a gap', artifacts: [], details: {} }
          : { status: 'done', role: 'lead', summary: '', artifacts: [], details: { decision: 'bounce', reason: 'because', guidance: 'close the gap' } },
        writeFile: () => {}, readFile: () => [
          JSON.stringify({ seat_turn_census: { dispatch_id: 'planner', role: 'planner', transport: 'headless-json', turns: 1 }, headless_outcome: 'ok' }),
          JSON.stringify({ seat_turn_census: { dispatch_id: 'lead', role: 'lead', transport: 'headless-json', turns: 1 }, headless_outcome: 'ok' }),
        ].join('\n'), run: () => ({ ok: true, output: '' }),
        changedFiles: () => [], commit: () => 'abc1234',
        log: (row) => { if (row && typeof row.stage === 'string') stages.push(row.stage) }, now: () => 0,
      }
      const result = driveTask(seen[0], io)
      assert.equal(stages.filter((stage) => stage.startsWith('plan:r')).length, 4)
      assert.match(result.details.escalation.why, /within 4 rounds/)
    })
  } finally {
    if (previousLedger === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousLedger
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('batchDirFromBrief derives only compiled briefs under an out directory', () => {
  const batch = '/tmp/batch-2026-09-05-r32'
  const compiled = `${batch}/out/lane.brief.md`
  assert.deepEqual(batchDirFromBrief(compiled), { batch_dir: batch, brief: compiled, reason: null })
  for (const value of ['/tmp/hand-written.brief.md', '', 42]) {
    const result = batchDirFromBrief(value)
    assert.equal(result.batch_dir, null)
    assert.equal(result.reason, BATCH_DIR_NOT_BATCHED)
    assert.equal(result.brief, typeof value === 'string' && value.trim() ? value : null)
  }
})

test('run journals one batch-dir row per invocation with a closed non-batch reason', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-batch-dir-run-checkout-')
  const home = scratchDir('crew-batch-dir-run-home-')
  const batchBrief = join(home, 'batch-2026-09-05-r32', 'out', 'batch-dir-run.brief.md')
  const looseBrief = join(home, 'hand-written.brief.md')
  mkdirSync(dirname(batchBrief), { recursive: true })
  writeFileSync(batchBrief, '# compiled brief\n')
  writeFileSync(looseBrief, '# loose brief\n')
  const task = 'batch-dir-run'
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    execSync('git init -q', { cwd: checkout })
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd({ task, checkout, 'brief-file': batchBrief, keep: true }, { drive: () => done })
      runCmd({ task, checkout, 'brief-file': looseBrief, keep: true }, { drive: () => done })
    })
    const journal = join(testCrewDir(home, checkout, task), 'journal.jsonl')
    const rows = readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((row) => row.event === BATCH_DIR_EVENT)
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map(({ batch_dir, reason }) => ({ batch_dir, reason })), [
      { batch_dir: join(home, 'batch-2026-09-05-r32'), reason: null },
      { batch_dir: null, reason: BATCH_DIR_NOT_BATCHED },
    ])
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run resolves, threads, and journals validation lanes without overloading fence names', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-validation-lane-run-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-validation-lane-run-home-'))
  const register = join(home, 'fences.json')
  const brief = join(home, 'brief.md')
  const task = 'validation-lane-run'
  writeFileSync(register, JSON.stringify({ lanes: [{ lane: 'fence-name', files: ['crew/crew.mjs'] }] }))
  writeFileSync(brief, '# validation lane brief\n')
  execSync('git init -q', { cwd: checkout })
  const seen = []
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      const capture = (ctx) => { seen.push(ctx); return done }
      runCmd({ task, checkout, 'brief-file': brief, 'validation-lane': '  npm test  ', keep: true }, { drive: capture })
      runCmd({ task, checkout, 'brief-file': brief, fences: register, lane: 'fence-name', keep: true }, { drive: capture })
      runCmd({ task, checkout, 'brief-file': brief, lane: '  ci-repair lane  ', keep: true }, { drive: capture })
    })
    assert.deepEqual(seen.map((ctx) => ctx.lane), ['npm test', null, 'ci-repair lane'])
    const rows = readFileSync(seen[0].journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((row) => row.event === 'validation-lane')
    assert.deepEqual(rows.map(({ lane, source }) => ({ lane, source })), [
      { lane: 'npm test', source: 'validation-lane' },
      { lane: null, source: 'none' },
      { lane: 'ci-repair lane', source: 'lane' },
    ])
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('completion log path accepts an override and otherwise defaults to the crew root', () => {
  const root = scratchDir('crew-completion-path-')
  const override = join(root, 'x.jsonl')
  assert.equal(completionLogPath({ env: { CREW_COMPLETION_LOG: `  ${override}  ` } }), override)
  assert.equal(completionLogPath({ root: join(root, 'root'), env: {} }), join(root, 'root', 'completions.jsonl'))
})

test('run keeps a blockless brief unmeasured and distinguishable from a compiler proposal', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-proposal-blockless-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-proposal-blockless-home-'))
  const task = 'proposal-blockless'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# blockless brief\nno compiler proposal here\n')
  const dbPath = join(home, 'ledger.db')
  const previousLedger = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = dbPath
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: () => done })
    })
    if (!nodeMeetsLedgerFloor) return
    const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
    try {
      const row = ledger.dumpTable('sessions').find((candidate) => candidate.task_slug === task)
      assert.ok(row)
      assert.equal(row.proposed_shape, null)
      assert.equal(row.proposed_strength, null)
      assert.notDeepEqual(
        { shape: row.proposed_shape, strength: row.proposed_strength },
        { shape: 'mechanical', strength: 'workhorse' },
      )
    } finally { ledger.close() }
  } finally {
    if (previousLedger === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousLedger
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('daemon path records the brief proposal with or without the crew.json brief_file', () => {
  const proposal = '# proposal brief\n```proposal\n{"shape":"mechanical","strength":"workhorse"}\n```\n'
  const daemonRun = (task, includeBriefFile) => {
    const root = mkdtempSync(join(tmpdir(), `crew-proposal-daemon-${task}-`))
    const crewDir = join(root, 'crew')
    const checkout = join(root, 'checkout')
    mkdirSync(crewDir, { recursive: true })
    mkdirSync(checkout, { recursive: true })
    mkdirSync(join(crewDir, 'returns'), { recursive: true })
    const brief = join(crewDir, 'brief.md')
    writeFileSync(brief, proposal)
    writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
      schema_version: 3, task, checkout,
      roles: ['lead', 'planner', 'builder', 'reviewer'],
      members: Object.fromEntries(['lead', 'planner', 'builder', 'reviewer'].map((role) => [role, {
        surface_id: null, pane_id: null, transport: 'headless-json', model: 'sonnet', agent: 'claude',
      }])),
      task_return: join('returns', 'task.json'),
      ...(includeBriefFile ? { brief_file: brief } : {}),
    }))
    const dbPath = join(crewDir, 'ledger.db')
    try {
      runChild({ crew_dir: crewDir, task, brief_file: brief, checkout }, {
        preflight: false,
        seatIo: () => ({
          log: () => {}, assign: () => ({ id: 'x', returnPath: 'x' }), wait: () => null,
          writeFile: () => {}, readFile: () => null, run: () => ({ ok: true, output: '' }),
          changedFiles: () => [], commit: () => 'abc1234', now: () => 0,
        }),
        driveTask: () => ({ status: 'done', summary: '', artifacts: [], details: {} }),
        env: { DEVTEAM_LEDGER_DB: dbPath },
      })
      if (!nodeMeetsLedgerFloor) return null
      const ledger = openLedger({ dbPath, stderr: { write: () => {} } })
      try { return ledger.dumpTable('sessions').find((row) => row.task_slug === task) } finally { ledger.close() }
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
  if (!nodeMeetsLedgerFloor) {
    daemonRun('proposal-daemon-key', true)
    daemonRun('proposal-daemon-nokey', false)
    return
  }
  const withKey = daemonRun('proposal-daemon-key', true)
  const withoutKey = daemonRun('proposal-daemon-nokey', false)
  assert.ok(withKey)
  assert.equal(withKey.proposed_shape, 'mechanical')
  assert.equal(withKey.proposed_strength, 'workhorse')
  assert.ok(withoutKey)
  assert.equal(withoutKey.proposed_shape, 'mechanical')
  assert.equal(withoutKey.proposed_strength, 'workhorse')
})

test('the settle path writes the envelope before its teardown and only once', () => {
  const f = childSignalFixture()
  const order = []
  try {
    const result = runChild({ crew_dir: f.crewDir, task: 'child-signal', brief_file: f.brief, checkout: f.root, ledger_db: f.ledger }, {
      preflight: false,
      env: { DEVTEAM_LEDGER_DB: f.ledger },
      writeFileSync: (path, data, options) => writeFileSync(path, data, options),
      renameSync: (from, to) => {
        if (String(to) === f.taskReturn) order.push('envelope')
        renameSync(from, to)
      },
      seatIo: () => ({ teardown: () => { order.push('teardown'); return [] } }),
      driveTask: () => ({ status: 'done', summary: 'done', artifacts: [], details: {} }),
    })
    assert.equal(result.status, 'done')
    assert.deepEqual(order, ['envelope', 'teardown'])
    assert.equal(JSON.parse(readFileSync(f.taskReturn, 'utf8')).status, 'done')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('the child arms no teardown signal handler at any point in a run', () => {
  const f = childSignalFixture()
  // The 2026-08-11 convention's own prescription: INSTRUMENT the OS-level
  // listener count through the code path rather than reading that a
  // registration happened. Every stretch a daemon reap can land in is sampled.
  const counts = () => ['SIGTERM', 'SIGINT'].map((signal) => process.listenerCount(signal))
  const before = counts()
  const seen = {}
  try {
    runChild({ crew_dir: f.crewDir, task: 'child-signal', brief_file: f.brief, checkout: f.root, ledger_db: f.ledger }, {
      preflight: false,
      env: { DEVTEAM_LEDGER_DB: f.ledger },
      // The FIRST call after seatIo and the FIRST call inside settle are both
      // sampled: a listener armed only across one of them would be invisible to
      // a probe that watched just the later log and teardown callbacks.
      checkoutProtectedPaths: () => {
        seen['protected-paths checkout'] = counts()
        return { paths: [], used: false, reason: 'test-double', basis: 'test double' }
      },
      writeFileSync: (path, data, options) => {
        if (String(path) === `${f.taskReturn}.tmp`) seen['settlement envelope write'] ??= counts()
        writeFileSync(path, data, options)
      },
      seatIo: () => ({
        log: () => { seen['post-seatIo preflight'] ??= counts() },
        teardown: () => { seen['settlement teardown'] = counts(); return [] },
      }),
      driveTask: () => { seen.drive = counts(); return { status: 'done', summary: 'done', artifacts: [], details: {} } },
    })
    seen.after = counts()
    for (const where of [
      'protected-paths checkout', 'post-seatIo preflight', 'drive',
      'settlement envelope write', 'settlement teardown', 'after',
    ]) {
      assert.deepEqual(seen[where], before, where)
    }
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a real SIGTERM still kills a child mid-drive without waiting for the drive', async () => {
  const f = childSignalFixture()
  try {
    const outcome = await sigtermWhileBlocked(f, `runChild(spec, { preflight: false, env,
  seatIo: () => ({ teardown: () => [] }),
  driveTask: () => { block(); return { status: 'done', summary: 'late', artifacts: [], details: {} } },
})`)
    assertKilledBySigterm(outcome, 'the drive')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a real SIGTERM during synchronous preflight keeps the default disposition', async () => {
  const f = childSignalFixture()
  try {
    const outcome = await sigtermWhileBlocked(f, `runChild(spec, { env,
  execSync: () => { block(); return '' },
  seatIo: () => ({ teardown: () => [] }),
  driveTask: () => ({ status: 'done', summary: 'late', artifacts: [], details: {} }),
})`)
    assertKilledBySigterm(outcome, 'preflight')
    // A reap before settle() leaves no envelope. That residual is covered by the
    // daemon's settleSignalled, never by the child (crew/daemon.mjs).
    assert.equal(existsSync(f.taskReturn), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a real SIGTERM in the post-seatIo preflight window keeps the default disposition', async () => {
  const f = childSignalFixture()
  try {
    const outcome = await sigtermWhileBlocked(f, `runChild(spec, { preflight: false, env,
  checkoutProtectedPaths: () => { block(); return { paths: [], used: false, reason: 'test-double', basis: 'test double' } },
  seatIo: () => ({ log: () => {}, teardown: () => [] }),
  driveTask: () => ({ status: 'done', summary: 'late', artifacts: [], details: {} }),
})`)
    assertKilledBySigterm(outcome, 'the post-seatIo preflight window')
    assert.equal(existsSync(f.taskReturn), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a real SIGTERM during settlement keeps the default disposition', async () => {
  const f = childSignalFixture()
  try {
    const outcome = await sigtermWhileBlocked(f, `runChild(spec, { preflight: false, env,
  writeFileSync: (path, data, options) => { realWrite(path, data, options); if (String(path) === taskReturn + '.tmp') block() },
  seatIo: () => ({ log: () => {}, teardown: () => [] }),
  driveTask: () => ({ status: 'done', summary: 'ok', artifacts: [], details: {} }),
})`)
    assertKilledBySigterm(outcome, 'the settlement window')
    // The signal lands inside settle's OWN temporary publish write, before the
    // rename, so the final path is empty and the daemon's settleSignalled records
    // the run when the reap lands inside this window.
    assert.equal(existsSync(f.taskReturn), false)
    assert.equal(existsSync(`${f.taskReturn}.tmp`), true)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('stopCmd closes its ledger and refuses unsafe identities without terminal writes', async () => {
  const args = { task: 'unit-stop', pid: '42', checkout: '/checkout' }
  const malformed = stopUnitFixture()
  malformed.deps.readFileSync = () => '{'
  malformed.deps.openLedger = () => { throw new Error('must not open malformed sidecar') }
  await assert.rejects(() => stopCmd(args, malformed.deps), (err) => err instanceof UsageError && /^crew\.mjs stop: refused/.test(err.message))
  assert.equal(malformed.calls.opened, 0)
  assert.equal(malformed.calls.closed, 0)

  for (const [label, fixture] of [
    ['invalid pid', stopUnitFixture()],
    ['command mismatch', stopUnitFixture({ command: '/other/crew.mjs run --task unit-stop' })],
    ['TERM EPERM', stopUnitFixture({ processKill: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) } })],
    ['unknown liveness', stopUnitFixture({ alive: [null, null, null] })],
    ['PID reuse', stopUnitFixture({ alive: [true], psCommand: (() => { let n = 0; return () => n++ === 0 ? '/checkout/crew/crew.mjs run --task unit-stop' : '/checkout/crew/crew.mjs run --task other' })() })],
  ]) {
    const localArgs = { ...args, pid: label === 'invalid pid' ? 'not-an-integer' : '42' }
    await assert.rejects(() => stopCmd(localArgs, fixture.deps), (err) => err instanceof UsageError && /^crew\.mjs stop: refused/.test(err.message), label)
    assert.equal(fixture.calls.ends.length, 0, label)
    assert.equal(fixture.calls.closed, 1, label)
  }

  const terminal = stopUnitFixture({ sessions: [{ status: 'running' }, { status: 'ok', outcome: 'success' }] })
  const result = await stopCmd(args, terminal.deps)
  assert.equal(result.status, 'ok')
  assert.equal(terminal.calls.ends.length, 0)
  assert.equal(terminal.calls.closed, 1)
})

test('RV1-1 stopCmd anchors dispatch-batch relative entry to declared checkout', async () => {
  const args = { task: 'unit-stop', pid: '42', checkout: '/checkout' }
  const matching = stopUnitFixture({
    command: 'node crew/crew.mjs run --task unit-stop --checkout /checkout --brief-file /tmp/unit-stop.md --keep',
    sessions: [
      { status: 'running' },
      { status: 'running' },
      { status: 'aborted', outcome: 'aborted', terminal_reason: 'operator-stop', terminal_actor: 'operator' },
    ],
  })
  const result = await stopCmd(args, matching.deps)
  assert.equal(result.status, 'aborted')
  assert.deepEqual(matching.calls.kills, [[42, 'SIGTERM']])
  assert.deepEqual(matching.calls.ends, [{ adw_id: 'unit-run', status: 'aborted', outcome: 'aborted', terminal_reason: 'operator-stop', terminal_actor: 'operator' }])

  const foreign = stopUnitFixture({
    command: 'node crew/crew.mjs run --task unit-stop --checkout /other-checkout --brief-file /tmp/unit-stop.md --keep',
  })
  await assert.rejects(() => stopCmd(args, foreign.deps), (err) => err instanceof UsageError && /^crew\.mjs stop: refused/.test(err.message))
  assert.deepEqual(foreign.calls.kills, [])
  assert.deepEqual(foreign.calls.ends, [])
  assert.equal(foreign.calls.closed, 1)
})

test('stop recognizes the running crew module and refuses a foreign entry', async () => {
  const checkout = '/checkout'
  const args = { task: 'unit-stop', pid: '42', checkout }
  const running = fileURLToPath(new URL('./crew.mjs', import.meta.url))
  const accepted = stopUnitFixture({ command: `${running} run --task unit-stop --checkout ${checkout}`, sessions: [{ status: 'running' }, { status: 'running' }, { status: 'aborted', outcome: 'aborted' }] })
  accepted.deps.loadCrew = () => ({ checkout })
  await stopCmd(args, accepted.deps)
  assert.deepEqual(accepted.calls.kills, [[42, 'SIGTERM']])
  const foreign = stopUnitFixture({ command: `/elsewhere/crew/crew.mjs run --task unit-stop --checkout ${checkout}` })
  foreign.deps.loadCrew = () => ({ checkout })
  await assert.rejects(() => stopCmd(args, foreign.deps), (err) => err instanceof UsageError && /refused/.test(err.message))
  assert.deepEqual(foreign.calls.kills, [])
})

test('D1b only the finalizer row this stop CAUSED is superseded', async () => {
  const args = { task: 'unit-stop', pid: '42', checkout: '/checkout' }
  const finalizerRow = (reason, actor = 'finalizer') => ({ status: 'fail', outcome: 'failed', terminal_reason: reason, terminal_actor: actor })

  // the row this stop caused: superseded
  const caused = stopUnitFixture({ sessions: [{ status: 'running' }, finalizerRow('SIGTERM'), { status: 'aborted', outcome: 'aborted' }] })
  await stopCmd(args, caused.deps)
  assert.equal(caused.calls.ends.length, 1)
  assert.equal(caused.calls.ends[0].terminal_reason, 'operator-stop')
  assert.equal(caused.calls.ends[0].terminal_actor, 'operator')

  // rows this stop did NOT cause: preserved, no terminal write at all
  for (const row of [finalizerRow('SIGINT'), finalizerRow('SIGHUP'), finalizerRow('SIGTERM', 'driver'), { status: 'ok', outcome: 'success', terminal_reason: 'natural-completion', terminal_actor: 'driver' }]) {
    const untouched = stopUnitFixture({ sessions: [{ status: 'running' }, row] })
    await stopCmd(args, untouched.deps)
    assert.deepEqual(untouched.calls.ends, [], `${row.terminal_reason}/${row.terminal_actor} must be preserved`)
  }
})

test('run derives its process exit code from the envelope status', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-exit-code-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-exit-code-home-'))
  const task = 'exit-code-run'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# exit code brief\n')
  const envelopes = [
    [{ status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }, 0],
    [{ status: 'escalation', summary: 'needs a human', artifacts: [], details: { escalation: { why: 'review' } } }, 3],
    [{ status: 'blocked', summary: 'blocked', artifacts: [], details: {} }, 1],
  ]
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      for (const [envelope, expected] of envelopes) {
        const previous = process.exitCode
        try {
          process.exitCode = undefined
          runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: () => envelope })
          assert.equal(process.exitCode, expected)
        } finally { process.exitCode = previous }
      }
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('child entrypoint plumbs, journals, and refuses round budgets', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-rounds-child-'))
  const crewDir = join(root, 'crew')
  const checkout = join(root, 'checkout')
  mkdirSync(crewDir, { recursive: true })
  mkdirSync(checkout, { recursive: true })
  mkdirSync(join(crewDir, 'returns'), { recursive: true })
  const brief = join(crewDir, 'brief.md')
  writeFileSync(brief, '# child rounds brief\n')
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: 'child-rounds', checkout,
    roles: ['lead', 'planner', 'builder', 'reviewer'],
    members: Object.fromEntries(['lead', 'planner', 'builder', 'reviewer'].map((role) => [role, {
      surface_id: null, pane_id: null, transport: 'headless-json', model: 'sonnet', agent: 'claude',
    }])),
    task_return: join('returns', 'task.json'),
  }))
  const makeRun = (budget = {}) => {
    const rows = []
    let seen = null
    let drove = 0
    const io = {
      log: (row) => rows.push(row), assign: () => ({ id: 'x', returnPath: 'x' }), wait: () => null,
      writeFile: () => {}, readFile: () => null, run: () => ({ ok: true, output: '' }),
      changedFiles: () => [], commit: () => 'abc1234', now: () => 0,
    }
    const spec = { crew_dir: crewDir, task: 'child-rounds', brief_file: brief, checkout, ...budget }
    runChild(spec, {
      preflight: false, seatIo: () => io,
      driveTask: (ctx) => { drove += 1; seen = ctx; return { status: 'done', summary: '', artifacts: [], details: {} } },
      env: { DEVTEAM_LEDGER_DB: join(crewDir, 'ledger.db') },
    })
    return { rows, seen, drove }
  }
  try {
    const flagged = makeRun({ build_rounds: 4, review_rounds: 1 })
    assert.deepEqual(flagged.seen.limits, { build_rounds: 4, review_rounds: 1 })
    assert.deepEqual(flagged.rows.find((row) => row.event === 'limits'), {
      at: flagged.rows.find((row) => row.event === 'limits').at, event: 'limits',
      plan_rounds: LIMITS.plan_rounds, build_rounds: 4, review_rounds: 1,
      source: { plan_rounds: 'default', build_rounds: 'flag', review_rounds: 'flag' },
    })
    const plain = makeRun()
    assert.equal(Object.prototype.hasOwnProperty.call(plain.seen, 'limits'), false)
    const plainRow = plain.rows.find((row) => row.event === 'limits')
    assert.deepEqual(plainRow, {
      at: plainRow.at, event: 'limits',
      plan_rounds: LIMITS.plan_rounds, build_rounds: LIMITS.build_rounds, review_rounds: LIMITS.review_rounds,
      source: { plan_rounds: 'default', build_rounds: 'default', review_rounds: 'default' },
    })
    for (const [budget, reason] of [
      [{ build_rounds: '2.5' }, 'invalid-build-rounds'],
      [{ review_rounds: 0 }, 'invalid-review-rounds'],
    ]) {
      let drove = 0
      assert.throws(() => runChild(
        { crew_dir: crewDir, task: 'child-rounds', brief_file: brief, checkout, ...budget },
        { preflight: false, seatIo: () => ({ log: () => {} }), driveTask: () => { drove += 1 }, env: { DEVTEAM_LEDGER_DB: join(crewDir, 'ledger.db') } },
      ), (err) => err.reason === reason)
      assert.equal(drove, 0)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('child entrypoint resolves both validation lane spellings, journals them, and refuses malformed specs', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-validation-lane-child-'))
  const crewDir = join(root, 'crew')
  const checkout = join(root, 'checkout')
  mkdirSync(crewDir, { recursive: true })
  mkdirSync(checkout, { recursive: true })
  mkdirSync(join(crewDir, 'returns'), { recursive: true })
  const brief = join(crewDir, 'brief.md')
  writeFileSync(brief, '# child validation lane brief\n')
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: 'child-validation-lane', checkout,
    roles: ['lead', 'planner', 'builder', 'reviewer'],
    members: Object.fromEntries(['lead', 'planner', 'builder', 'reviewer'].map((role) => [role, {
      surface_id: null, pane_id: null, transport: 'headless-json', model: 'sonnet', agent: 'claude',
    }])),
    task_return: join('returns', 'task.json'),
  }))
  const base = { crew_dir: crewDir, task: 'child-validation-lane', brief_file: brief, checkout }
  const makeRun = (laneSpec) => {
    const rows = []
    let seen = null
    let drove = 0
    const io = {
      log: (row) => rows.push(row), assign: () => ({ id: 'x', returnPath: 'x' }), wait: () => null,
      writeFile: () => {}, readFile: () => null, run: () => ({ ok: true, output: '' }),
      changedFiles: () => [], commit: () => 'abc1234', now: () => 0,
    }
    runChild({ ...base, ...laneSpec }, {
      preflight: false, seatIo: () => io,
      driveTask: (ctx) => { drove += 1; seen = ctx; return { status: 'done', summary: '', artifacts: [], details: {} } },
      env: { DEVTEAM_LEDGER_DB: join(crewDir, 'ledger.db') },
    })
    return { rows, seen, drove }
  }
  try {
    for (const [laneSpec, expected] of [
      [{ validation_lane: '  node --test  ' }, { lane: 'node --test', source: 'validation-lane' }],
      [{ lane: '  daemon repair lane  ' }, { lane: 'daemon repair lane', source: 'lane' }],
    ]) {
      const result = makeRun(laneSpec)
      assert.equal(result.seen.lane, expected.lane)
      assert.deepEqual(result.rows.find((row) => row.event === 'validation-lane'), {
        at: result.rows.find((row) => row.event === 'validation-lane').at, event: 'validation-lane', ...expected,
      })
    }
    let drove = 0
    assert.throws(() => runChild(
      { ...base, validation_lane: true },
      { preflight: false, seatIo: () => ({ log: () => {} }), driveTask: () => { drove += 1 }, env: { DEVTEAM_LEDGER_DB: join(crewDir, 'ledger.db') } },
    ), (err) => err.reason === 'invalid-validation-lane')
    assert.equal(drove, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('child preflight uses the scout shape seats and keeps the default tier guard', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-scout-child-'))
  const crewDir = join(root, 'crew')
  const checkout = join(root, 'checkout')
  mkdirSync(crewDir, { recursive: true })
  mkdirSync(checkout, { recursive: true })
  mkdirSync(join(crewDir, 'returns'), { recursive: true })
  const brief = join(crewDir, 'brief.md')
  writeFileSync(brief, '# scout brief\n')
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
    schema_version: 3, task: 'scout-child', checkout,
    roles: ['planner'],
    members: { planner: { surface_id: null, pane_id: null, transport: 'headless-json', model: 'sonnet', agent: 'claude' } },
    task_return: join('returns', 'task.json'),
  }))
  execSync('git init -q', { cwd: checkout })
  const base = { crew_dir: crewDir, task: 'scout-child', brief_file: brief, checkout }
  let drove = 0
  let seen = null
  const io = { log: () => {} }
  try {
    runChild({ ...base, variant: 'scout' }, {
      seatIo: () => io,
      driveTask: (ctx) => { drove += 1; seen = ctx; return { status: 'done', summary: '', artifacts: [], details: {} } },
      env: { DEVTEAM_LEDGER_DB: join(crewDir, 'ledger.db') },
    })
    assert.deepEqual(seen.roles, ['planner'])
    assert.equal(drove, 1)
    assert.throws(() => runChild(base, {
      seatIo: () => io,
      driveTask: () => { drove += 1 },
      env: { DEVTEAM_LEDGER_DB: join(crewDir, 'ledger.db') },
    }), /requires a builder seat/)
    assert.equal(drove, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('repair lane absence remains the current triage refusal', () => {
  const result = driveTask({
    task: 'repair-lane-refusal', briefFile: '/tmp/brief.md', taskDir: '/tmp/repair-lane-refusal',
    checkout: '/tmp/repo', journal: '/tmp/repair-lane-refusal/journal.jsonl',
    files_in_scope: ['crew/crew.mjs'], lane: null, variant: 'repair',
  }, { log: () => {}, now: () => 0 })
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'triage')
  assert.match(result.details.escalation.why, /takes its validation lane from the failing run \(--lane\) and ctx carries none/)
})

test('run refuses an inherited shape with no declared scope before driving', async () => {
  const inherited = VARIANT_NAMES.find((name) => VARIANTS[name]?.sources?.scope === 'inherited')
  const { root: checkoutRoot, checkout } = testCheckout('crew-scope-refusal-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-scope-refusal-home-'))
  const task = 'scope-refusal'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# scope brief\n')
  let drove = 0
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      assert.throws(() => runCmd({ task, checkout, 'brief-file': brief, variant: inherited, lane: 'lane-cmd', keep: true }, { drive: () => { drove += 1 } }), (err) => err.message.includes('task.json'))
    })
    assert.equal(drove, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run places explicit scope on ctx and omits it for a neutral shape', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-scope-ctx-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-scope-ctx-home-'))
  const task = 'scope-ctx'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# scope brief\n')
  const previousLedger = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = join(home, 'ledger.db')
  const seen = []
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  const inherited = VARIANT_NAMES.find((name) => VARIANTS[name]?.sources?.scope === 'inherited')
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      const capture = (ctx) => { seen.push(ctx); return done }
      runCmd({ task, checkout, 'brief-file': brief, variant: inherited, lane: 'lane-cmd', 'files-in-scope': 'a.mjs, a.test.mjs', keep: true }, { drive: capture })
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: capture })
      runCmd({ task, checkout, 'brief-file': brief, 'review-base-sha': 'a'.repeat(40), 'review-head-sha': 'b'.repeat(64), keep: true }, { drive: capture })
    })
    assert.deepEqual(seen[0].files_in_scope, ['a.mjs', 'a.test.mjs'])
    assert.equal(Object.prototype.hasOwnProperty.call(seen[1], 'files_in_scope'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(seen[1], 'review_identity'), false)
    assert.deepEqual(seen[2].review_identity, { base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(64) })
    assert.equal(Object.isFrozen(seen[2].review_identity), true)
  } finally {
    if (previousLedger === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousLedger
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run inheritance reaches the repair stage and planner assignment', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-scope-e2e-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-scope-e2e-home-'))
  const task = 'scope-e2e'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# scope brief\n')
  const inherited = VARIANT_NAMES.find((name) => VARIANTS[name]?.sources?.scope === 'inherited')
  const filesInScope = ['a.mjs', 'a.test.mjs']
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      const crewDir = testCrewDir(home, checkout, task)
      writeFileSync(join(crewDir, 'returns', 'task.json'), JSON.stringify({ status: 'escalation', details: { files_in_scope: filesInScope } }))
      let seen
      runCmd({ task, checkout, 'brief-file': brief, variant: inherited, lane: 'lane-cmd', keep: true }, {
        drive: (ctx) => { seen = ctx; return { status: 'done', summary: '', artifacts: [], details: {} } },
      })
      const assigned = []
      const stages = []
      const io = {
        assign: ({ role }) => { assigned.push(role); return { id: role, returnPath: `${role}:1` } },
        wait: () => null, writeFile: () => {}, readFile: () => null,
        run: () => ({ ok: true, output: '' }), changedFiles: () => [], commit: () => 'abc1234',
        log: (entry) => { if (entry && typeof entry.stage === 'string') stages.push(entry.stage) }, now: () => 0,
      }
      try { driveTask(seen, io) } catch { /* stage and assignment labels are the evidence */ }
      assert.equal(stages[0], `${inherited}:r1`)
      assert.equal(assigned[0], 'planner')
    })
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('directed dispatch without a validation lane refuses before crew state or seats', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-directed-lane-refusal-home-'))
  let drove = 0
  try {
    await withHome(home, () => {
      assert.throws(
        () => runCmd(
          { task: 'directed-never-booted', checkout: process.cwd(), 'brief-file': join(home, 'missing.md'), variant: 'directed' },
          { drive: () => { drove += 1 } },
        ),
        (err) => err.reason === VALIDATION_LANE_REFUSAL,
      )
      assert.equal(drove, 0)
      assert.equal(existsSync(join(home, '.crew')), false)
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('ctx source validation permits supplied lanes and neutral full dispatches', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-ctx-source-pass-home-'))
  try {
    await withHome(home, () => {
      assert.throws(
        () => runCmd({ task: 'directed-with-lane', checkout: process.cwd(), 'brief-file': join(home, 'missing.md'), variant: 'directed', 'validation-lane': 'node --test' }),
        /no crew booted/,
      )
      assert.throws(
        () => runCmd({ task: 'full-without-lane', checkout: process.cwd(), 'brief-file': join(home, 'missing.md'), variant: 'full' }),
        /no crew booted/,
      )
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('assertCtxSources follows every variant declaration without restating shape names', () => {
  for (const name of VARIANT_NAMES) {
    const needsLane = VARIANTS[name]?.sources?.lane === 'ctx'
    if (needsLane) {
      assert.throws(() => assertCtxSources(name), (err) => err.reason === VALIDATION_LANE_REFUSAL)
    } else {
      assert.doesNotThrow(() => assertCtxSources(name))
    }
  }
})

test('run refuses an unknown execution shape before reading or writing crew state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-variant-refusal-home-'))
  let drove = 0
  try {
    await withHome(home, () => {
      assert.throws(
        () => runCmd(
          { task: 'variant-never-booted', checkout: process.cwd(), 'brief-file': join(home, 'missing.md'), execution: 'no-such-shape' },
          { drive: () => { drove += 1 } },
        ),
        (err) => {
          assert.match(err.message, /unknown execution shape/)
          for (const name of VARIANT_NAMES) assert.match(err.message, new RegExp(name))
          return true
        },
      )
      assert.equal(drove, 0)
      assert.equal(existsSync(join(home, '.crew')), false)
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('run passes a selected driver variant through ctx', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-variant-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-variant-home-'))
  const task = 'variant-selected'
  const variant = VARIANT_NAMES.find((name) => name !== DEFAULT_VARIANT)
  assert.ok(variant)
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# variant brief\n')
  const previousLedger = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = join(home, 'ledger.db')
  let seen
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd(
        { task, checkout, 'brief-file': brief, variant, keep: true },
        { drive: (ctx) => { seen = ctx; return done } },
      )
    })
    const crew = JSON.parse(readFileSync(join(testCrewDir(home, checkout, task), 'crew.json'), 'utf8'))
    assert.equal(seen.variant, variant)
    assert.equal(seen.task, task)
    assert.equal(seen.checkout, checkout)
    assert.equal(seen.briefFile, brief)
    assert.deepEqual(seen.roles, crew.roles)
  } finally {
    if (previousLedger === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousLedger
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run without a variant captures the same ctx as an explicit default', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-variant-default-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-variant-default-home-'))
  const task = 'variant-default'
  execSync('git init -q', { cwd: checkout })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# variant brief\n')
  const previousLedger = process.env.DEVTEAM_LEDGER_DB
  process.env.DEVTEAM_LEDGER_DB = join(home, 'ledger.db')
  const seen = []
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      const capture = (ctx) => { seen.push(ctx); return done }
      runCmd({ task, checkout, 'brief-file': brief, variant: DEFAULT_VARIANT, keep: true }, { drive: capture })
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: capture })
    })
    assert.equal(seen.length, 2)
    assert.equal(seen[1].variant, DEFAULT_VARIANT)
    const { execution_source: firstSource, ...firstCtx } = seen[0]
    const { execution_source: secondSource, ...secondCtx } = seen[1]
    assert.deepEqual(secondCtx, firstCtx)
    assert.deepEqual([firstSource, secondSource], ['alias', 'migration_default'])
  } finally {
    if (previousLedger === undefined) delete process.env.DEVTEAM_LEDGER_DB
    else process.env.DEVTEAM_LEDGER_DB = previousLedger
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run resolves the repo protected paths and journals the basis', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-protected-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-protected-home-'))
  const factoryRoot = join(home, 'factory')
  const task = 'protected-run'
  const cell = {
    status: 'ratified', value: ['db/migrations/'], source: 'human',
    ratified_by: 'human', ratified_at: '2026-08-16T00:00:00.000Z',
  }
  execSync('git init -q', { cwd: checkout })
  protectedProfile(factoryRoot, checkout, cell)
  const previousFactory = process.env.DEVTEAM_FACTORY_DIR
  process.env.DEVTEAM_FACTORY_DIR = factoryRoot
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# brief\n')
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  let seen
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: (ctx) => { seen = ctx; return done } })
    })
    assert.ok(seen.protectedPaths.includes('db/migrations/'))
    for (const path of PROTECTED_PATHS) assert.ok(seen.protectedPaths.includes(path), `${path} missing from ctx`)
    const rows = readFileSync(seen.journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((row) => row.event === 'protected-paths')
    assert.equal(rows.length, 1)
    assert.match(rows[0].basis, /protected_paths_candidates/)
    assert.equal(rows[0].count, seen.protectedPaths.length)
  } finally {
    if (previousFactory === undefined) delete process.env.DEVTEAM_FACTORY_DIR
    else process.env.DEVTEAM_FACTORY_DIR = previousFactory
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

async function runnerRunCtx(runArgs = {}) {
  const { root: checkoutRoot, checkout } = testCheckout('crew-runner-checkout-')
  const home = scratchDir('crew-runner-home-')
  const factoryRoot = join(home, 'factory')
  const ledgerDir = join(home, 'ledger')
  const ledgerDb = join(ledgerDir, 'ledger.db')
  const task = 'runner-run'
  execSync('git init -q', { cwd: checkout })
  const profilePath = protectedProfile(factoryRoot, checkout, {
    status: 'ratified', value: [], source: 'human', ratified_by: 'human', ratified_at: '2026-08-16T00:00:00.000Z',
  })
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
  profile.fields.test_command = { status: 'ratified', value: 'cargo test --workspace', source: 'human', ratified_by: 'human', ratified_at: '2026-08-16T00:00:00.000Z' }
  writeFileSync(profilePath, JSON.stringify(profile))
  const saved = Object.fromEntries(['DEVTEAM_FACTORY_DIR', 'DEVTEAM_LEDGER_DIR', 'DEVTEAM_LEDGER_DB'].map((key) => [key, process.env[key]]))
  Object.assign(process.env, { DEVTEAM_FACTORY_DIR: factoryRoot, DEVTEAM_LEDGER_DIR: ledgerDir, DEVTEAM_LEDGER_DB: ledgerDb })
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# brief\n')
  const seen = []
  try {
    await withHome(home, async () => {
      await bootCmd({ task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() })
      runCmd({ task, checkout, 'brief-file': brief, keep: true, ...runArgs }, {
        drive: (ctx) => { seen.push(ctx); return { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } } },
      })
    })
    assert.equal(seen.length, 1)
    return seen[0]
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
}

test('NR7', async () => {
  const ctx = await runnerRunCtx()
  assert.equal(ctx.testRunner.runner, 'cargo')
  assert.match(ctx.testRunner.basis, /ratified profile field test_command/)
})

test('run classifies an explicit --suite that differs from the ratified test_command', async () => {
  const ctx = await runnerRunCtx({ suite: 'npm test' })
  assert.equal(ctx.testRunner.runner, 'node')
  assert.match(ctx.testRunner.basis, /^run --suite "npm test" · overrides ratified profile field test_command/)
})

test('boot persists the fence and run rides it into ctx beside the protected paths', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-fence-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-fence-home-'))
  const register = join(home, 'fences.json')
  const brief = join(home, 'brief.md')
  const task = 'fence-slice1'
  const fenceArgs = {
    fences: register, lane: 'fence-slice1',
  }
  writeFileSync(register, JSON.stringify({ lanes: [
    { lane: 'intake-loop', files: ['scripts/factory/intake.mjs'] },
    { lane: 'fence-slice1', files: ['crew/crew.mjs', 'crew/crew.test.mjs'] },
  ] }))
  writeFileSync(brief, '# brief\n')
  execSync('git init -q', { cwd: checkout })
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  const seen = []
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath, ...fenceArgs },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: (ctx) => { seen.push(ctx); return done } })
      await bootCmd(
        { task: 'fence-plain', checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      runCmd({ task: 'fence-plain', checkout, 'brief-file': brief, keep: true }, { drive: (ctx) => { seen.push(ctx); return done } })
    })
    const fencedDir = testCrewDir(home, checkout, task)
    const fencedCrew = JSON.parse(readFileSync(join(fencedDir, 'crew.json'), 'utf8'))
    assert.equal(fencedCrew.lane_name, 'fence-slice1')
    assert.deepEqual(fencedCrew.lane_fence, [{ lane: 'intake-loop', files: ['scripts/factory/intake.mjs'] }])
    assert.deepEqual(seen[0].laneFence, fencedCrew.lane_fence)
    assert.equal(seen[0].laneName, 'fence-slice1')
    for (const path of PROTECTED_PATHS) assert.ok(seen[0].protectedPaths.includes(path), `${path} missing from ctx`)
    const rows = readFileSync(seen[0].journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((row) => row.event === 'lane-fence')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].lane_name, 'fence-slice1')
    assert.equal(rows[0].lanes, 1)
    assert.equal(rows[0].files, 1)
    const plainCrew = JSON.parse(readFileSync(join(testCrewDir(home, checkout, 'fence-plain'), 'crew.json'), 'utf8'))
    assert.equal(Object.prototype.hasOwnProperty.call(plainCrew, 'lane_fence'), false)
    assert.equal(seen[1].laneFence, undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('run refuses an unusable ratified protected-path cell before driving', async () => {
  const { root: checkoutRoot, checkout } = testCheckout('crew-protected-refusal-checkout-')
  const home = mkdtempSync(join(tmpdir(), 'crew-protected-refusal-home-'))
  const factoryRoot = join(home, 'factory')
  const task = 'protected-refusal'
  execSync('git init -q', { cwd: checkout })
  protectedProfile(factoryRoot, checkout, { status: 'ratified', value: ['db/migrations/'], source: 'human' })
  const previousFactory = process.env.DEVTEAM_FACTORY_DIR
  process.env.DEVTEAM_FACTORY_DIR = factoryRoot
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# brief\n')
  let drove = 0
  try {
    await withHome(home, async () => {
      await bootCmd(
        { task, checkout, tier: 'build', 'headless-all': true, 'claude-bin': process.execPath },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
      )
      assert.throws(
        () => runCmd({ task, checkout, 'brief-file': brief, keep: true }, { drive: () => { drove += 1 } }),
        (err) => err.reason === 'protected-paths-invalid' && err.message.includes('protected-paths-invalid'),
      )
    })
    assert.equal(drove, 0)
  } finally {
    if (previousFactory === undefined) delete process.env.DEVTEAM_FACTORY_DIR
    else process.env.DEVTEAM_FACTORY_DIR = previousFactory
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

async function withBaseBranchFixture(fn) {
  const root = scratchDir('crew-base-branch-')
  const home = join(root, 'home'), checkout = join(root, 'checkout'), factoryRoot = join(home, 'factory')
  mkdirSync(home); mkdirSync(checkout)
  const saved = Object.fromEntries(['HOME', 'DEVTEAM_FACTORY_DIR', 'DEVTEAM_LEDGER_DIR', 'DEVTEAM_LEDGER_DB'].map((key) => [key, process.env[key]]))
  Object.assign(process.env, { HOME: home, DEVTEAM_FACTORY_DIR: factoryRoot, DEVTEAM_LEDGER_DIR: join(home, 'ledger'), DEVTEAM_LEDGER_DB: join(home, 'ledger.db') })
  git(checkout, 'init', '-q')
  git(checkout, 'config', 'user.email', 'crew@example.invalid'); git(checkout, 'config', 'user.name', 'crew')
  writeFileSync(join(checkout, 'a.mjs'), 'fixture\n'); git(checkout, 'add', 'a.mjs'); git(checkout, 'commit', '-qm', 'base')
  const repoKey = probeRepo({ checkout }).repo_key
  const profilePath = join(factoryRoot, 'profiles', `${repoKey}.json`)
  const task = 'base-branch-fixture', brief = join(home, 'brief.md')
  writeFileSync(brief, '# fixture\n')
  const crewPath = join(testCrewDir(home, checkout, task), 'crew.json')
  let calls = 0, effects = 0, ctx
  const profile = (branch, status = 'ratified') => {
    mkdirSync(dirname(profilePath), { recursive: true })
    writeFileSync(profilePath, JSON.stringify({ schema: 1, profile_version: 1, repo_key: repoKey, fields: { default_branch: { status, value: branch, source: 'fixture', ratified_by: 'operator', ratified_at: 'now' } }, meta: {} }))
  }
  const deps = {
    checkoutBaseBranch(options) { calls++; return checkoutBaseBranch(options) },
    cmux: () => { effects++; return {} }, tree: () => { effects++; return {} }, renameTab: () => { effects++ },
    awaitSeatsReady: async () => {}, openRun: () => ({ recordSeats() {}, startRun() {}, endRun() {} }),
  }
  const boot = () => bootCmd({ task, checkout, 'headless-all': true, 'claude-bin': process.execPath }, deps)
  const run = () => runCmd({ task, checkout, 'brief-file': brief, keep: true }, { ...deps, seatIo: () => ({}), drive: (value) => { ctx = value; return { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } } }, appendCompletion: () => {}, writeTerminalLine: () => {} })
  try { await fn({ root, home, checkout, task, profilePath, profile, crewPath, boot, run, deps, get calls() { return calls }, get effects() { return effects }, get ctx() { return ctx } }) }
  finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    rmSync(root, { recursive: true, force: true })
  }
}

test('B1 boot persists ratified base provenance exactly once', async () => withBaseBranchFixture(async (f) => {
  f.profile('dispute'); await f.boot()
  const crew = JSON.parse(readFileSync(f.crewPath, 'utf8'))
  const journal = readFileSync(join(dirname(f.crewPath), 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(crew.base_branch, { branch: 'dispute', basis: `ratified profile field default_branch · ${f.profilePath}` })
  assert.deepEqual(journal.find((row) => row.event === 'boot')?.base_branch, crew.base_branch)
  assert.equal(f.calls, 1)
}))

test('B2 proposed base refuses before boot side effects and preserves refusal reasons', async () => withBaseBranchFixture(async (f) => {
  f.profile('dispute', 'proposed')
  await assert.rejects(f.boot(), (error) => error.reason === 'profile-unratified' && error.message.includes('profile-unratified'))
  assert.equal(existsSync(f.crewPath), false)
  assert.equal(f.effects, 0)
  for (const reason of ['profile-unreadable', 'base-branch-invalid']) {
    const refusal = new ProfileRefusal('resolver detail', reason)
    await assert.rejects(bootCmd({ task: `${f.task}-${reason}`, checkout: f.checkout, 'headless-all': true }, { checkoutBaseBranch: () => { throw refusal } }), (error) => error === refusal && error.reason === reason && error.message === `${reason}: resolver detail`)
  }
}))

test('B3 run keeps the boot-frozen base after profile edits', async () => withBaseBranchFixture(async (f) => {
  f.profile('dispute'); await f.boot(); f.profile('trunk'); f.run()
  assert.equal(f.ctx.publish.base, 'dispute')
  assert.equal(f.calls, 1)
}))

test('B4 legacy run resolves and persists missing base once; proposed legacy profile refuses before driving', async () => withBaseBranchFixture(async (f) => {
  await f.boot()
  const crew = JSON.parse(readFileSync(f.crewPath, 'utf8')); delete crew.base_branch; writeFileSync(f.crewPath, JSON.stringify(crew))
  f.run()
  assert.equal(f.ctx.publish.base, 'main')
  const journalPath = join(dirname(f.crewPath), 'journal.jsonl')
  const rows = readFileSync(journalPath, 'utf8').trim().split('\n').map(JSON.parse).filter((row) => row.event === 'base-branch')
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].base_branch, { branch: 'main', basis: `default base branch main · no profile at ${f.profilePath}` })
  assert.deepEqual(JSON.parse(readFileSync(f.crewPath, 'utf8')).base_branch, rows[0].base_branch)
  f.run(); assert.equal(f.calls, 2)
  const legacy = JSON.parse(readFileSync(f.crewPath, 'utf8')); delete legacy.base_branch; writeFileSync(f.crewPath, JSON.stringify(legacy)); f.profile('dispute', 'proposed')
  let drove = 0
  assert.throws(() => checkoutBaseBranch({ checkout: f.checkout }), (error) => error.reason === 'profile-unratified')
  const proposed = new ProfileRefusal('proposed default branch', 'profile-unratified')
  assert.throws(() => runCmd({ task: f.task, checkout: f.checkout, 'brief-file': join(f.home, 'brief.md'), keep: true }, { checkoutBaseBranch: () => { throw proposed }, drive: () => { drove++ }, seatIo: () => { drove++ } }), (error) => error === proposed && error.message.includes('profile-unratified'))
  assert.equal(drove, 0)
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(f.crewPath, 'utf8')), 'base_branch'), false)
  const unexpected = new Error('unexpected resolver failure')
  await assert.rejects(bootCmd({ task: `${f.task}-unexpected`, checkout: f.checkout, 'headless-all': true }, { checkoutBaseBranch: () => { throw unexpected } }), (error) => error === unexpected)
}))

test('all-headless tier boot makes no cmux calls and records daemon-acceptable seats', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-headless-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-headless-checkout-')
  const rosterDir = scratchDir('crew-headless-roster-')
  const rosterPath = join(rosterDir, 'roster.json')
  writeFileSync(rosterPath, JSON.stringify(roster, null, 2))
  const task = 'all-headless'
  const cmux = callCounter(); const tree = callCounter(); const renameTab = callCounter()
  try {
    await withHome(home, () => bootCmd(
      { task, checkout, tier: 'build', roster: rosterPath, 'headless-all': true, 'claude-bin': process.execPath },
      { cmux, tree, renameTab },
    ))
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
    assert.equal(renameTab.calls.length, 0)
    const dir = testCrewDir(home, checkout, task)
    const crew = JSON.parse(readFileSync(join(dir, 'crew.json'), 'utf8'))
    assert.equal(crew.workspace_id, null)
    assert.equal(crew.window_id, null)
    const expected = { lead: 'headless-json', planner: 'headless-json', builder: 'headless-rpc', reviewer: 'headless-rpc' }
    assert.deepEqual(Object.fromEntries(crew.roles.map((role) => [role, crew.members[role].transport])), expected)
    for (const role of crew.roles) {
      assert.equal(crew.members[role].pane_id, null)
      assert.equal(crew.members[role].surface_id, null)
      assert.equal(existsSync(join(dir, 'task', `role-${role}.md`)), true)
      assert.ok(crew.members[role].transport && crew.members[role].transport !== 'pane')
    }
    const boot = readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).find((event) => event.event === 'boot')
    assert.deepEqual(Object.fromEntries(crew.roles.map((role) => [role, boot.allocation[role].transport])), expected)
    assert.equal(boot.allocation.lead.model, 'roster')

    // crew/daemon.mjs's paneSeat() is the consumer and must keep refusing pane transport.
    const daemonSource = readFileSync(new URL('./daemon.mjs', import.meta.url), 'utf8')
    assert.match(daemonSource, /daemon run refuses pane transport/)
    assert.match(daemonSource, /paneSeat/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('--headless-all with a per-seat transport flag still boots — no workspace, nothing to be invisible inside', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-mode-factory-seat-home-'))
  const { root: checkoutRoot, checkout } = testCheckout('crew-mode-factory-seat-checkout-')
  const task = 'mode-factory-seat'
  const cmux = callCounter()
  try {
    await withHome(home, () => bootCmd(
      { task, checkout, tier: 'build', 'headless-all': true, 'headless-rpc': 'builder', 'claude-bin': process.execPath },
      { cmux, tree: callCounter(), renameTab: callCounter() },
    ))
    const crew = JSON.parse(readFileSync(join(testCrewDir(home, checkout, task), 'crew.json'), 'utf8'))
    assert.equal(crew.workspace_id, null)
    assert.equal(crew.members.builder.transport, 'headless-rpc')
    for (const member of Object.values(crew.members)) assert.notEqual(member.transport, 'pane')
    assert.equal(cmux.calls.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('an explicit ACP builder persists to crew state and boot journal without changing headless fallbacks', async (t) => {
  const home = scratchDir('crew-acp-headless-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-acp-headless-checkout-')
  const task = 'acp-headless'
  const cmux = callCounter(); const tree = callCounter(); const renameTab = callCounter()
  try {
    await withHome(home, () => bootCmd(
      { task, checkout, tier: 'build', 'headless-all': true, acp: 'builder', 'claude-bin': process.execPath },
      { cmux, tree, renameTab },
    ))
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
    assert.equal(renameTab.calls.length, 0)
    const dir = testCrewDir(home, checkout, task)
    const crew = JSON.parse(readFileSync(join(dir, 'crew.json'), 'utf8'))
    assert.deepEqual(Object.fromEntries(crew.roles.map((role) => [role, crew.members[role].transport])), {
      lead: 'headless-json', planner: 'headless-rpc', builder: 'acp', reviewer: 'headless-json',
    })
    const boot = readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).find((event) => event.event === 'boot')
    assert.deepEqual(Object.fromEntries(crew.roles.map((role) => [role, boot.allocation[role].transport])), {
      lead: 'headless-json', planner: 'headless-rpc', builder: 'acp', reviewer: 'headless-json',
    })
    await t.test('R1 real-boot pi ACP builder launches bridge', () => {
      const taskDir = join(dir, 'task'); const returnsDir = join(dir, 'returns')
      mkdirSync(taskDir, { recursive: true }); mkdirSync(returnsDir, { recursive: true })
      const briefFile = join(taskDir, 'role-builder.md'); writeFileSync(briefFile, 'brief')
      let launch
      const io = acpIo({ crew, paths: { taskDir, returnsDir }, checkout, adapters: persistedAdapters(crew), bin: process.execPath,
        deps: { clientFactory(options) { launch = options.launch; return { start() {}, initialize() {}, newSession() {}, beginPrompt() { return 1 } } } } })
      io.assign({ role: 'builder', briefFile })
      assert.equal(launch.args[0].endsWith('crew/pi/acp-bridge.mjs'), true)
      assert.equal(launch.env.CREW_PI_BIN, process.execPath)
      assert.deepEqual(persistedAdapters(crew).builder, { grants: persistedAdapters(crew).builder.grants })
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

async function acpCeilingBoot(task, flags = {}) {
  const home = scratchDir('crew-acp-ceiling-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-acp-ceiling-checkout-')
  try {
    await withHome(home, () => bootCmd({ task, checkout, tier: 'build', 'headless-all': true, acp: 'builder', 'claude-bin': process.execPath, ...flags }, {}))
    return { home, checkoutRoot, checkout, dir: testCrewDir(home, checkout, task) }
  } catch (error) { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }); throw error }
}
test('A1', async () => {
  const f = await acpCeilingBoot('acp-ceiling-a1')
  try { const c = JSON.parse(readFileSync(join(f.dir, 'crew.json'), 'utf8')).turn_ceilings; assert.equal(c.builder, null); assert.equal(c.source.builder, 'absent') }
  finally { rmSync(f.home, { recursive: true, force: true }); rmSync(f.checkoutRoot, { recursive: true, force: true }) }
})
test('A2', async () => {
  const f = await acpCeilingBoot('acp-ceiling-a2')
  try { const c = JSON.parse(readFileSync(join(f.dir, 'crew.json'), 'utf8')).turn_ceilings; assert.deepEqual([c.planner, c.reviewer, c.lead], [64, 48, 32]); assert.deepEqual([c.source.planner, c.source.reviewer, c.source.lead], ['default', 'default', 'default']) }
  finally { rmSync(f.home, { recursive: true, force: true }); rmSync(f.checkoutRoot, { recursive: true, force: true }) }
})
test('A3', async () => {
  const home = scratchDir('crew-acp-ceiling-refuse-home-'); const { root: checkoutRoot, checkout } = testCheckout('crew-acp-ceiling-refuse-checkout-')
  const cmux = callCounter(); const tree = callCounter(); const renameTab = callCounter()
  try {
    await withHome(home, () => assert.rejects(() => bootCmd({ task: 'acp-ceiling-refuse', checkout, tier: 'build', 'headless-all': true, acp: 'builder', 'claude-bin': process.execPath, 'max-turns-builder': '40' }, { cmux, tree, renameTab }), (error) => error.code === ACP_TURN_CEILING_UNMEASURED && /builder.*40.*acp/i.test(error.message)))
    assert.equal(existsSync(testCrewDir(home, checkout, 'acp-ceiling-refuse')), false); assert.equal(cmux.calls.length + tree.calls.length + renameTab.calls.length, 0)
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})
test('A4', async () => {
  const home = scratchDir('crew-acp-ceiling-rpc-home-'); const { root: checkoutRoot, checkout } = testCheckout('crew-acp-ceiling-rpc-checkout-')
  try {
    await withHome(home, () => bootCmd({ task: 'acp-ceiling-rpc', checkout, tier: 'build', 'headless-all': true, 'headless-rpc': 'builder', 'claude-bin': process.execPath }, {}))
    const c = JSON.parse(readFileSync(join(testCrewDir(home, checkout, 'acp-ceiling-rpc'), 'crew.json'), 'utf8')).turn_ceilings
    assert.equal(c.builder, 200); assert.equal(c.source.builder, 'default')
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(checkoutRoot, { recursive: true, force: true }) }
})

test('ACP and headless-rpc for one role refuse before state or workspace creation', async () => {
  const home = scratchDir('crew-acp-rpc-conflict-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-acp-rpc-conflict-checkout-')
  const task = 'acp-rpc-conflict'
  const cmux = callCounter(); const tree = callCounter(); const renameTab = callCounter()
  try {
    await withHome(home, () => assert.rejects(
      () => bootCmd(
        { task, checkout, roles: 'lead,builder', acp: 'builder', 'headless-rpc': 'builder', 'claude-bin': process.execPath },
        { cmux, tree, renameTab },
      ),
      /role builder is named by both --acp and --headless-rpc/,
    ))
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
    assert.equal(renameTab.calls.length, 0)
    assert.equal(existsSync(testCrewDir(home, checkout, task)), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('a missing memory budget value falls back to the default and records invalid-budget', () => {
  const cfg = memoryConfig({ 'memory-dir': '/tmp/crew-memory-fixture', 'memory-budget-bytes': true })
  assert.equal(cfg.budgetBytes, 8000)
  assert.equal(cfg.reason, 'invalid-budget')
})

// Byte pins are incidental protection for this rule: they catch a charter that GREW, not one that
// reverted the branch. 19 sol planner d1 assignments answered `ready: planner` to a first message
// that already carried ASSIGNMENT, settled, and wrote no envelope. The rule is that the assignment
// test comes BEFORE the readiness reply, and it must be asserted as a rule.
// Mutation killed: reorder so `ready:` is the unconditional first imperative, or drop the
// ASSIGNMENT branch, and this test reddens while every byte pin stays green.
test('the shared charter tests for an assignment BEFORE it tells a seat to reply ready', () => {
  const shared = readFileSync(join(ROOT, 'crew', 'roles', '_shared.md'), 'utf8')
  const step = shared.split('\n').findIndex((line) => line.startsWith('1. '))
  assert.ok(step >= 0, 'the assignment loop has no step 1')
  const body = shared.split('\n').slice(step, step + 4).join('\n')
  const assignmentAt = body.indexOf('ASSIGNMENT')
  const readyAt = body.indexOf('`ready:')
  assert.ok(assignmentAt >= 0, 'step 1 never mentions ASSIGNMENT')
  assert.ok(readyAt >= 0, 'step 1 never mentions the readiness reply')
  assert.ok(assignmentAt < readyAt, 'step 1 must branch on ASSIGNMENT before instructing the ready reply')
  assert.match(body, /do\s*\n?\s*NOT reply `ready:`/i)
})

test('the charter ceilings and source budgets are the delivered bytes, below the 2026-09-05 baseline', () => {
  const roles = ['builder', 'lead', 'planner', 'reviewer', 'tech-lead']
  const guided = ['builder', 'planner', 'reviewer']
  const files = ['_shared', ...roles]
  assert.equal(Object.isFrozen(CHARTER_CEILINGS), true)
  assert.equal(Object.isFrozen(CHARTER_SOURCE_BUDGET), true)
  assert.equal(Object.isFrozen(CHARTER_BASELINE_BYTES), true)
  assert.deepEqual(CHARTER_BASELINE_BYTES, { _shared: 3432, builder: 5169, lead: 9378, planner: 16930, reviewer: 7697, 'tech-lead': 6529 })
  assert.deepEqual(CHARTER_SOURCE_BUDGET, { _shared: 4942, builder: 3963, lead: 9099, planner: 16928, reviewer: 7675, 'tech-lead': 6295 })
  for (const value of [...Object.values(CHARTER_BASELINE_BYTES), ...Object.values(CHARTER_SOURCE_BUDGET), ...Object.values(CHARTER_CEILINGS)]) assert.equal(Number.isInteger(value), true)
  const shared = readFileSync(join(ROOT, 'crew', 'roles', '_shared.md'), 'utf8')
  const cards = Object.fromEntries(roles.map((role) => [role, readFileSync(join(ROOT, 'crew', 'roles', `${role}.md`), 'utf8')]))
  const rawBytes = (card) => Buffer.byteLength(`${shared}\n\n${card}`, 'utf8')
  const delta = Buffer.byteLength(composeRolePrompt(shared, cards.builder), 'utf8') - rawBytes(cards.builder)
  assert.ok(delta > 0)
  for (const role of roles) {
    const base = CHARTER_SOURCE_BUDGET._shared + 2 + CHARTER_SOURCE_BUDGET[role]
    assert.equal(CHARTER_CEILINGS[role], guided.includes(role) ? base + delta : base)
    assert.ok(CHARTER_SOURCE_BUDGET[role] < CHARTER_BASELINE_BYTES[role])
  }
  assert.equal(CHARTER_SOURCE_TOTAL_BUDGET, 48902)
  assert.equal(CHARTER_SOURCE_TOTAL_BUDGET, Object.values(CHARTER_SOURCE_BUDGET).reduce((sum, value) => sum + value, 0))
  assert.ok(CHARTER_SOURCE_TOTAL_BUDGET < 49135)

  const source = charterFileBytes()
  assert.deepEqual(Object.fromEntries(Object.entries(source).map(([name, entry]) => [name, entry.bytes])), CHARTER_SOURCE_BUDGET)
  assert.equal(source.builder.bytes, CHARTER_SOURCE_BUDGET.builder, `builder source bytes: ${source.builder.bytes}`)
  for (const name of files) {
    assert.equal(source[name].reason, null)
    assert.equal(source[name].bytes, Buffer.byteLength(readFileSync(join(ROOT, 'crew', 'roles', `${name}.md`), 'utf8'), 'utf8'))
  }
  const compiled = compiledCharterBytes()
  for (const role of roles) {
    const expected = Buffer.byteLength(composeRolePrompt(shared, cards[role]), 'utf8')
    assert.deepEqual(compiled[role], { bytes: expected, reason: null })
    assert.equal(compiled[role].bytes, CHARTER_CEILINGS[role])
  }
})

test('composed charters resolve the three authored guideline references to absolute plugin paths', () => {
  // Built from parts so the census sees no new static path literal here.
  const checklistBase = 'seat-pre-return-checklist.md'
  const flagBase = 'review-do-not-flag.md'
  const checklistRel = join('crew', 'guidelines', checklistBase)
  const flagRel = join('crew', 'guidelines', flagBase)
  const names = ['_shared', 'builder', 'lead', 'planner', 'reviewer', 'tech-lead']
  const sources = Object.fromEntries(names.map((name) => [name, readFileSync(join(ROOT, 'crew', 'roles', `${name}.md`), 'utf8')]))
  const guidedRoles = ['builder', 'planner', 'reviewer']
  const countIn = (text, needle) => text.split(needle).length - 1
  let authored = 0
  for (const name of names) authored += countIn(sources[name], checklistRel) + countIn(sources[name], flagRel)
  assert.equal(authored, 3)
  assert.equal(countIn(sources.builder, checklistRel), 1)
  assert.equal(countIn(sources.planner, checklistRel), 1)
  assert.equal(countIn(sources.reviewer, flagRel), 1)
  const builderInstruction = `Read \`${checklistRel}\` and self-apply its builder items \`B1\`-\`B3\`.`
  const plannerInstruction = `\`${checklistRel}\` and self-apply its planner items\n\`P1\`-\`P3\` before you write the envelope.`
  const reviewerInstruction = `Before writing findings, load the do-not-flag guidelines\n(\`${flagRel}\`) with`
  assert.ok(sources.builder.includes(builderInstruction))
  assert.ok(sources.planner.includes(plannerInstruction))
  assert.ok(sources.reviewer.includes(reviewerInstruction))
  for (const role of guidedRoles) {
    const rel = role === 'reviewer' ? flagRel : checklistRel
    const expected = join(ROOT, rel)
    const composed = composeRolePrompt(sources._shared, sources[role])
    assert.equal(composed.includes(`\`${rel}\``), false)
    assert.ok(composed.includes(`\`${expected}\``))
    const escaped = rel.replaceAll('.', '\\.')
    const found = composed.match(new RegExp(`\`([^\`]*${escaped})\``))?.[1] ?? ''
    assert.equal(found, expected)
    assert.ok(existsSync(found))
    assert.equal(readFileSync(found, 'utf8'), readFileSync(join(ROOT, rel), 'utf8'))
    assert.ok(isAbsolute(found))
  }
  const prefix = join('crew', 'guidelines')
  for (const role of ['lead', 'tech-lead']) {
    assert.equal(composeRolePrompt(sources._shared, sources[role]).includes(prefix), false)
  }
})

test('BH1', () => {
  const source = charterFileBytes()
  const compiled = compiledCharterBytes()
  assert.deepEqual(charterSourceRefusals(), [])
  assert.deepEqual(charterBudgetRefusals(), [])
  assert.doesNotThrow(() => assertCharterBudgets(compiled, source))
  assert.deepEqual(Object.fromEntries(Object.entries(source).map(([name, entry]) => [name, entry.bytes])), CHARTER_SOURCE_BUDGET)
  for (const [role, entry] of Object.entries(compiled)) {
    assert.equal(entry.bytes, CHARTER_CEILINGS[role])
    assert.ok(CHARTER_SOURCE_BUDGET[role] < CHARTER_BASELINE_BYTES[role])
  }
})

test('a charter over its bound refuses by name, at either level', () => {
  const compiled = compiledCharterBytes()
  const files = charterFileBytes()
  assert.doesNotThrow(() => assertCharterBudgets(compiled, files))
  const atCeiling = Object.fromEntries(Object.entries(CHARTER_CEILINGS).map(([role, bytes]) => [role, { bytes, reason: null }]))
  const atSource = Object.fromEntries(Object.entries(CHARTER_SOURCE_BUDGET).map(([name, bytes]) => [name, { bytes, reason: null }]))
  assert.deepEqual(charterBudgetRefusals(atCeiling), [])
  assert.deepEqual(charterSourceRefusals(atSource), [])

  const overCompiled = { ...compiled, planner: { bytes: compiled.planner.bytes + 1, reason: null } }
  assert.throws(
    () => assertCharterBudgets(overCompiled, files),
    (error) => error.message.includes(CHARTER_BUDGET_REFUSAL) && error.message.includes('planner') && error.message.includes(String(CHARTER_CEILINGS.planner)),
  )
  const overSource = { ...files, planner: { bytes: files.planner.bytes + 1, reason: null } }
  assert.throws(
    () => assertCharterBudgets(compiled, overSource),
    (error) => error.message.includes(CHARTER_BUDGET_REFUSAL) && error.message.includes('planner.md') && error.message.includes(String(CHARTER_SOURCE_BUDGET.planner)),
  )
  const unmeasuredCompiled = { ...compiled, lead: { bytes: null, reason: CHARTER_UNMEASURED_CAUSES[0] } }
  assert.throws(() => assertCharterBudgets(unmeasuredCompiled, files), (error) => error.message.includes(CHARTER_BUDGET_REFUSAL) && error.message.includes('lead') && error.message.includes(CHARTER_UNMEASURED_CAUSES[0]))
  const unmeasuredSource = { ...files, lead: { bytes: null, reason: CHARTER_UNMEASURED_CAUSES[0] } }
  assert.throws(() => assertCharterBudgets(compiled, unmeasuredSource), (error) => error.message.includes(CHARTER_BUDGET_REFUSAL) && error.message.includes('lead.md') && error.message.includes(CHARTER_UNMEASURED_CAUSES[0]))
})

test('a memory addendum is measured outside the ceiling, and an unreadable charter is null with a closed cause', () => {
  const dir = scratchDir('crew-charter-memory-')
  const shared = readFileSync(join(ROOT, 'crew', 'roles', '_shared.md'), 'utf8')
  const card = readFileSync(join(ROOT, 'crew', 'roles', 'planner.md'), 'utf8')
  const section = '## Team memory\n\nA remembered thing.\n'
  writeFileSync(join(dir, 'role-planner.md'), composeRolePrompt(shared, card, section))
  const record = charterBytesRecord(dir, ['planner'], { planner: section })
  const memory = Buffer.byteLength(section, 'utf8') + 2
  assert.equal(record.memory_bytes.planner, memory)
  assert.equal(record.base.planner, CHARTER_CEILINGS.planner)
  assert.equal(record.bytes.planner, CHARTER_CEILINGS.planner + memory)

  const empty = scratchDir('crew-charter-empty-')
  const unreadable = charterBytesRecord(empty, ['planner'])
  assert.equal(unreadable.bytes.planner, null)
  assert.equal(unreadable.base.planner, null)
  assert.ok(CHARTER_UNMEASURED_CAUSES.includes(unreadable.unmeasured.planner))
  assert.notEqual(unreadable.bytes.planner, 0)
})

test('retired lean charter arm refuses at boot; unknown arms compose control, only terse-tail appends', async () => {
  // The lean tail was always '': unknown arms fall back to the control prompt (#1441),
  // while the --charter-arm enum no longer offers lean.
  const control = composeRolePrompt('shared charter', 'role card', 'measured section', 'control')
  const lean = composeRolePrompt('shared charter', 'role card', 'measured section', 'lean')
  const terse = composeRolePrompt('shared charter', 'role card', 'measured section', 'terse-tail')
  assert.equal(lean, control)
  assert.equal(terse.startsWith(control), true)
  assert.notEqual(terse, control)
  const home = scratchDir('crew-charter-lean-retired-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-charter-lean-retired-checkout-')
  const cmux = callCounter()
  const tree = callCounter()
  try {
    await assert.rejects(
      () => withHome(home, () => bootCmd(
        { task: 'charter-lean-retired', checkout, tier: 'build', 'headless-all': true, 'charter-arm': 'lean' },
        { cmux, tree, renameTab: callCounter(), register: capabilityRegister() },
      )),
      (error) => error?.message === `invalid --charter-arm "lean"; expected one of control|terse-tail`,
    )
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('D1 prototype-named charter arms compose control exactly', () => {
  const control = composeRolePrompt('shared', 'card', 'memory', 'control')
  for (const arm of ['constructor', 'toString']) {
    assert.equal(composeRolePrompt('shared', 'card', 'memory', arm), control)
  }
})

test('B1 an invalid charter arm still refuses by name', async () => {
  const home = scratchDir('crew-charter-invalid-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-charter-invalid-checkout-')
  const cmux = callCounter()
  const tree = callCounter()
  try {
    await assert.rejects(
      () => withHome(home, () => bootCmd(
        { task: 'charter-invalid', checkout, tier: 'build', 'headless-all': true, 'charter-arm': 'rogue-arm' },
        { cmux, tree, renameTab: callCounter(), register: capabilityRegister() },
      )),
      (error) => error?.message === `invalid --charter-arm "rogue-arm"; expected one of control|terse-tail`,
    )
    assert.equal(existsSync(testCrewDir(home, checkout, 'charter-invalid')), false)
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})


test('awaitSeatsReady returns immediately without probing an all-headless crew', () => {
  const cmux = callCounter()
  awaitSeatsReady({ members: { lead: { surface_id: null }, builder: { surface_id: null } } }, 'warm', null, { cmux })
  assert.equal(cmux.calls.length, 0)
})

test('awaitSeatsReady tags every seat still pending when readiness times out', () => {
  let clock = 0
  assert.throws(
    () => awaitSeatsReady({ members: { builder: { surface_id: 'surface-builder' }, reviewer: { surface_id: 'surface-reviewer' } } }, 'fresh', null, {
      cmux: () => ({ ok: false, stdout: '' }), now: () => { clock += 181_000; return clock }, sleep: () => {},
    }),
    (err) => {
      assert.deepEqual(err.roles, ['builder', 'reviewer'])
      assert.equal(err.mode, 'fresh')
      assert.deepEqual(err.signals, { builder: null, reviewer: null })
      assert.match(err.message, /mode: fresh/)
      assert.match(err.message, /builder \(last signal: none\)/)
      assert.match(err.message, /reviewer \(last signal: none\)/)
      return true
    },
  )
})

test('awaitSeatsReady fresh mode journals chrome once but refuses it', () => {
  const rows = []
  const times = [0, 1, 181_000]
  const crew = { members: { planner: { surface_id: 'surface-planner' } } }
  assert.throws(
    () => awaitSeatsReady(crew, 'fresh', '/journal.jsonl', {
      cmux: () => ({ ok: true, stdout: 'sub-agent ready\\n❯ ' }),
      logLine: (_path, row) => rows.push(row),
      now: () => times.shift() ?? 181_000,
      sleep: () => {},
    }),
    (err) => err.mode === 'fresh' && err.roles.join(',') === 'planner',
  )
  assert.equal(rows.length, 1)
  assert.deepEqual({ role: rows[0].role, signal: rows[0].signal, mode: rows[0].mode, accepted: rows[0].accepted }, {
    role: 'planner', signal: 'chrome', mode: 'fresh', accepted: false,
  })
})

test('awaitSeatsReady fresh mode clears on a role-anchored ready reply', () => {
  const rows = []
  awaitSeatsReady({ members: { planner: { surface_id: 'surface-planner' } } }, 'fresh', '/journal.jsonl', {
    cmux: () => ({ ok: true, stdout: 'ready: planner\\n' }),
    logLine: (_path, row) => rows.push(row),
  })
  assert.deepEqual({ role: rows[0].role, signal: rows[0].signal, mode: rows[0].mode, accepted: rows[0].accepted }, {
    role: 'planner', signal: 'ready-reply', mode: 'fresh', accepted: true,
  })
})

test('awaitSeatsReady fresh mode does not accept an echoed boot brief', () => {
  const rows = []
  assert.throws(
    () => awaitSeatsReady({ members: { planner: { surface_id: 'surface-planner' } } }, 'fresh', '/journal.jsonl', {
      cmux: () => ({ ok: true, stdout: 'Crew for task t. Task dir /x/task. Read your role in the system prompt, reply exactly ready: your-role, then wait.' }),
      logLine: (_path, row) => rows.push(row),
      now: (() => { const times = [0, 180_001]; return () => times.shift() ?? 180_001 })(),
      sleep: () => {},
    }),
    /planner \(last signal: none\)/,
  )
  assert.equal(rows.length, 0)
})

test('awaitSeatsReady recognizes a pi status line under a fresh ready reply', () => {
  const rows = []
  awaitSeatsReady({ members: { reviewer: { surface_id: 'surface-reviewer' } } }, 'fresh', '/journal.jsonl', {
    cmux: () => ({ ok: true, stdout: '$0.000 (sub) · openai-codex/gpt-5.6 • high\\nready: reviewer\\n' }),
    logLine: (_path, row) => rows.push(row),
  })
  assert.deepEqual({ role: rows[0].role, signal: rows[0].signal, mode: rows[0].mode, accepted: rows[0].accepted }, {
    role: 'reviewer', signal: 'ready-reply', mode: 'fresh', accepted: true,
  })
})

test('awaitSeatsReady warm mode accepts chrome when the ready reply has scrolled away', () => {
  const rows = []
  awaitSeatsReady({ members: { planner: { surface_id: 'surface-planner' } } }, 'warm', '/journal.jsonl', {
    cmux: () => ({ ok: true, stdout: 'sub-agent ready\\n❯ ' }),
    logLine: (_path, row) => rows.push(row),
  })
  assert.deepEqual({ role: rows[0].role, signal: rows[0].signal, mode: rows[0].mode, accepted: rows[0].accepted }, {
    role: 'planner', signal: 'chrome', mode: 'warm', accepted: true,
  })
})

test('awaitSeatsReady uses the named fresh and warm timeout budgets', () => {
  for (const [mode, timeout] of [['fresh', 180_000], ['warm', 120_000]]) {
    const times = [0, timeout + 1]
    assert.throws(
      () => awaitSeatsReady({ members: { planner: { surface_id: 'surface-planner' } } }, mode, null, {
        cmux: () => ({ ok: false, stdout: '' }), now: () => times.shift() ?? timeout + 1, sleep: () => {},
      }),
      (err) => err.mode === mode && err.message.includes(`within ${timeout / 1000}s`),
    )
  }
})

test('awaitSeatsReady refusal names each pending seat signal', () => {
  const times = [0, 60_000, 180_001]
  let polls = 0
  assert.throws(
    () => awaitSeatsReady({ members: {
      planner: { surface_id: 'surface-planner' }, reviewer: { surface_id: 'surface-reviewer' },
    } }, 'fresh', null, {
      cmux: (_cmd, args) => args.includes('surface-planner')
        ? { ok: true, stdout: 'sub-agent ready\\n❯ ' } : { ok: false, stdout: '' },
      now: () => times.shift() ?? 180_001,
      sleep: () => { polls += 1 },
    }),
    (err) => {
      assert.equal(err.mode, 'fresh')
      assert.deepEqual(err.roles, ['planner', 'reviewer'])
      assert.deepEqual(err.signals, { planner: 'chrome', reviewer: null })
      assert.match(err.message, /planner \(last signal: chrome\)/)
      assert.match(err.message, /reviewer \(last signal: none\)/)
      return polls === 1
    },
  )
})

test('awaitSeatsReady rejects unknown and absent modes explicitly', () => {
  const crew = { members: { planner: { surface_id: 'surface-planner' } } }
  for (const mode of ['bogus', undefined]) {
    assert.throws(() => awaitSeatsReady(crew, mode, null, { cmux: callCounter() }), /readiness mode/)
  }
})

test('Claude ACP reviewer boot persists alongside headless lead', async (t) => {
  const root = scratchDir('claude-acp-boot-test-')
  const home = join(root, 'home'); const checkout = join(root, 'checkout')
  mkdirSync(home); mkdirSync(checkout)
  let workspaceCalls = 0
  try {
    await withHome(home, () => bootCmd({ task: 'claude-acp-reviewer', checkout, roles: 'lead,reviewer', 'agent-reviewer': 'claude', acp: 'reviewer', 'headless-all': true, 'claude-bin': process.execPath }, {
      cmux() { workspaceCalls += 1; throw new Error('unexpected workspace call') }, tree() { return {} }, renameTab() {},
    }))
    const crewDir = testCrewDir(home, checkout, 'claude-acp-reviewer')
    const crew = JSON.parse(readFileSync(join(crewDir, 'crew.json'), 'utf8'))
    const journal = readFileSync(join(crewDir, 'journal.jsonl'), 'utf8')
    assert.equal(crew.members.reviewer.agent, 'claude')
    assert.equal(crew.members.reviewer.transport, 'acp')
    assert.equal(crew.members.lead.transport, 'headless-json')
    assert.match(journal, /"transport":"acp"/)
    assert.equal(workspaceCalls, 0)
    await t.test('R2 real-boot claude ACP reviewer launches agent', () => {
      const taskDir = join(crewDir, 'task'); const returnsDir = join(crewDir, 'returns'); const binDir = join(root, 'bin')
      mkdirSync(taskDir, { recursive: true }); mkdirSync(returnsDir, { recursive: true }); mkdirSync(binDir, { recursive: true })
      const stub = join(binDir, 'claude-agent-acp'); writeFileSync(stub, '#!/bin/sh\\nexit 0\\n'); chmodSync(stub, 0o755)
      const briefFile = join(taskDir, 'role-reviewer.md'); writeFileSync(briefFile, 'brief')
      let launch
      const io = acpIo({ crew, paths: { taskDir, returnsDir }, checkout, adapters: persistedAdapters(crew), deps: { env: { PATH: binDir }, clientFactory(options) { launch = options.launch; return { start() {}, initialize() {}, newSession() {}, setMode() {}, beginPrompt() { return 1 } } } } })
      io.assign({ role: 'reviewer', briefFile })
      assert.equal(launch.bin, stub)
      assert.equal(launch.env.CLAUDE_CODE_EXECUTABLE, crew.claude_bin)
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a tier boot records the handed roster and byte snapshot provenance', async () => {
  const home = scratchDir('crew-roster-boot-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-roster-boot-checkout-')
  const sourceDir = scratchDir('crew-roster-source-')
  const sourcePath = join(sourceDir, 'roster.json')
  const bytes = Buffer.from(JSON.stringify(roster, null, 2))
  writeFileSync(sourcePath, bytes)
  const task = 'roster-provenance'
  try {
    await withHome(home, () => bootCmd({ task, checkout, tier: 'build', roster: sourcePath, 'headless-all': true, 'claude-bin': process.execPath }, { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() }))
    const dir = testCrewDir(home, checkout, task)
    const crew = JSON.parse(readFileSync(join(dir, 'crew.json'), 'utf8'))
    assert.deepEqual(crew.roster, { path: sourcePath, origin: 'flag', sha256: createHash('sha256').update(bytes).digest('hex'), snapshot: join(dir, 'roster.snapshot.json') })
    assert.equal(readFileSync(crew.roster.snapshot).equals(bytes), true)
    assert.equal(crew.seats.planner.id, roster.tiers.build.planner.id)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('pane boot snapshots before cmux and leaves no crew record when snapshotting fails', async () => {
  const home = scratchDir('crew-roster-order-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-roster-order-checkout-')
  const sourceDir = scratchDir('crew-roster-order-source-')
  const sourcePath = join(sourceDir, 'roster.json')
  writeFileSync(sourcePath, JSON.stringify(roster, null, 2))
  const failedTask = 'roster-snapshot-fails'
  const controlTask = 'roster-snapshot-control'
  const failedCmux = callCounter()
  const controlCalls = []
  const controlCmux = (...args) => { controlCalls.push(args); return { ok: false, error: new Error('control stop') } }
  try {
    await withHome(home, () => assert.rejects(
      () => bootCmd({ task: failedTask, checkout, tier: 'build', roster: sourcePath, 'claude-bin': process.execPath }, {
        cmux: failedCmux, tree: callCounter(), renameTab: callCounter(), writeRosterSnapshot: () => { throw new Error('snapshot stop') },
      }), /snapshot stop/,
    ))
    assert.equal(failedCmux.calls.length, 0)
    assert.equal(existsSync(join(testCrewDir(home, checkout, failedTask), 'crew.json')), false)
    await withHome(home, () => assert.rejects(
      () => bootCmd({ task: controlTask, checkout, tier: 'build', roster: sourcePath, 'claude-bin': process.execPath }, {
        cmux: controlCmux, tree: callCounter(), renameTab: callCounter(),
      }), /control stop/,
    ))
    assert.ok(controlCalls.length > 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('model-not-in-catalog is closed for canonical cells while pure and raw band checks remain exempt', () => {
  const ladder = loadLadder()
  const canonical = { builder: { provider: 'openai', id: 'gpt-6.1-sol' } }
  assert.throws(
    () => assertBandFloors(canonical, 'build', ladder, { models: {} }),
    (err) => err.reason === 'model-not-in-catalog' && err.message.includes('openai/gpt-6.1-sol'),
  )
  assert.doesNotThrow(() => assertBandFloors(canonical, 'build', ladder))
  assert.ok(BAND_FLOOR_REFUSALS.includes('model-not-in-catalog'))
  const raw = { builder: { provider: null, id: null, model: 'openai-codex/gpt-6.1-sol' } }
  assert.doesNotThrow(() => assertBandFloors(raw, 'build', ladder, { models: {}, adapters: { builder: { adapter: { modelString: piModelString } } } }))
})

test('run-path seatIo receives a reader for the boot snapshot rather than the runtime roster', async () => {
  const home = scratchDir('crew-roster-run-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-roster-run-checkout-')
  const sourceDir = scratchDir('crew-roster-run-source-')
  const sourcePath = join(sourceDir, 'roster.json')
  const runtimePath = join(sourceDir, 'runtime.json')
  writeFileSync(sourcePath, JSON.stringify(roster, null, 2))
  const decoy = structuredClone(roster)
  decoy.tiers.judge.planner = { provider: 'anthropic', id: 'claude-sonnet-5', agent: 'claude', effort: 'high' }
  writeFileSync(runtimePath, JSON.stringify(decoy, null, 2))
  const task = 'roster-run-reader'
  const brief = join(home, 'brief.md')
  writeFileSync(brief, '# roster run reader\n')
  let captured = null
  const done = { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
  try {
    execSync('git init -q', { cwd: checkout })
    await withHome(home, () => bootCmd({ task, checkout, tier: 'build', roster: sourcePath, 'headless-all': true, 'claude-bin': process.execPath }, { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() }))
    writeFileSync(sourcePath, readFileSync(runtimePath))
    await withHome(home, () => runCmd({ task, checkout, 'brief-file': brief, keep: true }, {
      awaitSeatsReady: () => {},
      seatIo: (...args) => { captured = args; return { emit: () => {} } },
      drive: () => done,
      writeTerminalLine: () => {},
    }))
    assert.equal(typeof captured?.[6]?.readRoster, 'function')
    assert.equal(captured[6].readRoster().tiers.judge.planner.id, roster.tiers.judge.planner.id)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('runCmd refuses missing briefs despite injected seatIo and drive', async () => {
  const home = scratchDir('crew-run-brief-required-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-run-brief-required-checkout-')
  const rosterPath = join(home, 'roster.json')
  const task = 'run-brief-required'
  let seatIoCalls = 0
  let driveCalls = 0
  const seams = {
    awaitSeatsReady: () => {},
    seatIo: () => {
      seatIoCalls += 1
      throw new Error('seatIo reached before the brief guard')
    },
    drive: () => { driveCalls += 1; return { status: 'done', summary: '', artifacts: [], details: {} } },
  }
  try {
    writeFileSync(rosterPath, JSON.stringify(roster, null, 2))
    execSync('git init -q', { cwd: checkout })
    await withHome(home, () => bootCmd(
      { task, checkout, tier: 'build', roster: rosterPath, 'headless-all': true, 'claude-bin': process.execPath },
      { cmux: callCounter(), tree: callCounter(), renameTab: callCounter() },
    ))
    await withHome(home, () => {
      assert.throws(
        () => runCmd({ task, checkout, keep: true }, seams),
        /run requires --brief-file <path to the task brief>/,
      )
      assert.throws(
        () => runCmd({ task, checkout, 'brief-file': join(home, 'missing.md'), keep: true }, seams),
        /brief file not found/,
      )
    })
    assert.equal(seatIoCalls, 0)
    assert.equal(driveCalls, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test("a child run with no suite in its spec drives the owner's command", () => {
  const f = childSignalFixture()
  let seen = null
  try {
    runChild({ crew_dir: f.crewDir, task: 'child-signal', brief_file: f.brief, checkout: f.root, ledger_db: f.ledger }, {
      preflight: false,
      seatIo: () => ({ log: () => {} }),
      driveTask: (ctx) => { seen = ctx; return { status: 'done', summary: '', artifacts: [], details: {} } },
      env: { DEVTEAM_LEDGER_DB: f.ledger },
    })
    assert.equal(seen.suite, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).scripts.test)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('panel-distinct-agents refuses equal resolved agents before any workspace', async () => {
  const home = scratchDir('crew-panel-refusal-home-')
  const { root: checkoutRoot, checkout } = testCheckout('crew-panel-refusal-checkout-')
  const cmux = callCounter()
  const tree = callCounter()
  try {
    execSync('git init -q', { cwd: checkout })
    await assert.rejects(
      () => withHome(home, () => bootCmd(
        { task: 'panel-refusal', checkout, roles: 'reviewer,tech-lead', 'headless-all': true, 'claude-bin': process.execPath, 'panel-distinct-agents': true },
        { cmux, tree, renameTab: callCounter(), register: capabilityRegister() },
      )),
      (error) => /panel-same-agent/.test(error.message),
    )
    assert.equal(existsSync(testCrewDir(home, checkout, 'panel-refusal')), false)
    assert.equal(cmux.calls.length, 0)
    assert.equal(tree.calls.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
})

test('panel boots record both resolved agents with and without the flag', async () => {
  for (const [name, extra, expected] of [
    ['panel-distinct', { 'agent-reviewer': 'pi', 'agent-tech-lead': 'claude', 'panel-distinct-agents': true }, { reviewer: 'pi', 'tech-lead': 'claude' }],
    ['panel-same-allowed', {}, { reviewer: 'claude', 'tech-lead': 'claude' }],
  ]) {
    const home = scratchDir(`crew-${name}-home-`)
    const { root: checkoutRoot, checkout } = testCheckout(`crew-${name}-checkout-`)
    try {
      execSync('git init -q', { cwd: checkout })
      await withHome(home, () => bootCmd(
        { task: name, checkout, roles: 'reviewer,tech-lead', 'headless-all': true, 'claude-bin': process.execPath, ...extra },
        { cmux: callCounter(), tree: callCounter(), renameTab: callCounter(), register: capabilityRegister() },
      ))
      const crew = JSON.parse(readFileSync(join(testCrewDir(home, checkout, name), 'crew.json'), 'utf8'))
      assert.equal(crew.members.reviewer.agent, expected.reviewer)
      assert.equal(crew.members['tech-lead'].agent, expected['tech-lead'])
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(checkoutRoot, { recursive: true, force: true })
    }
  }
})

async function bootPoll(task, snapshots) {
  const home = scratchDir(`crew-${task}-home-`)
  const { root: checkoutRoot, checkout } = testCheckout(`crew-${task}-checkout-`)
  let t = 0
  let poll = 0
  const sleeps = []
  const tree = () => snapshots[Math.min(poll++, snapshots.length - 1)]
  const now = () => t
  const sleep = (ms) => {
    sleeps.push(ms)
    t += ms
    if (sleeps.length > 1000) throw new Error('sleep guard')
  }
  let error = null
  let crew = null
  try {
    writeFileSync(join(checkout, 'seed.txt'), 'seed\n')
    execSync('git init -q && git add -A && git -c user.email=fixture@test -c user.name=fixture commit -q -m seed', { cwd: checkout })
    await withHome(home, async () => {
      try {
        await bootCmd({ task, checkout, tier: 'build', 'claude-bin': process.execPath }, {
          cmux: () => ({ ok: true }), tree, renameTab: callCounter(), awaitSeatsReady: () => {}, now, sleep,
        })
        crew = JSON.parse(readFileSync(join(testCrewDir(home, checkout, task), 'crew.json'), 'utf8'))
      } catch (err) { error = err }
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
  return { error, crew, sleeps, t, tree }
}

const paneWorkspace = (id, task, titleKey = 'name', panes = ['lead', 'planner', 'builder', 'reviewer']) => ({
  id, [titleKey]: `crew-${task}`,
  panes: panes.map((role) => ({ id: `pane-${role}`, surfaces: [{ id: `surface-${role}`, name: role }] })),
})
const treeOf = (...workspaces) => ({ windows: [{ id: 'window-1', workspaces }] })
const assertCrewPanes = (crew, id) => {
  assert.equal(crew.workspace_id, id)
  for (const role of ['lead', 'planner', 'builder', 'reviewer']) assert.equal(crew.members[role].surface_id, `surface-${role}`)
}

async function bootPaneLaunchFixture(task, options = {}) {
  const scratch = scratchDir(`crew-${task}-`)
  const home = options.home || join(scratch, 'home')
  mkdirSync(home, { recursive: true })
  const { root: checkoutRoot, checkout } = testCheckout(`crew-${task}-checkout-`)
  writeFileSync(join(checkout, 'seed.txt'), 'seed\\n')
  execSync('git init -q && git add -A && git -c user.email=fixture@test -c user.name=fixture commit -q -m seed', { cwd: checkout })
  const calls = []
  const paneRoles = ['lead', 'planner', 'builder', 'reviewer']
  let trees = 0
  const tree = () => {
    trees += 1
    if (trees === 1) return { windows: [] }
    return treeOf({ id: 'workspace-test', title: `crew-${task}`, panes: paneRoles.map((role) => ({
      id: `pane-${role}`, surfaces: [{ id: `surface-${role}`, title: role }],
    })) })
  }
  let error = null
  try {
    options.before?.({ scratch, taskDir: join(testCrewDir(home, checkout, task), 'task') })
    await withHome(home, async () => {
      try {
        await bootCmd({ task, checkout, tier: 'build', 'claude-bin': process.execPath, ...options.args }, {
          cmux: (verb, args) => { calls.push([verb, args]); return { ok: true } },
          tree, renameTab: () => {}, awaitSeatsReady: () => {},
        })
      } catch (err) { error = err }
    })
    return { scratch, home, checkoutRoot, checkout, calls, error, taskDir: join(testCrewDir(home, checkout, task), 'task'), crewDir: testCrewDir(home, checkout, task) }
  } catch (err) {
    rmSync(scratch, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
    throw err
  }
}

function layoutFromCalls(calls) {
  const args = calls.find(([verb]) => verb === 'new-workspace')?.[1] || []
  return JSON.parse(args[args.indexOf('--layout') + 1])
}
function layoutCommands(node, commands = []) {
  if (node?.pane?.surfaces) for (const surface of node.pane.surfaces) if (surface.command) commands.push(surface.command)
  for (const child of node?.children || []) layoutCommands(child, commands)
  return commands
}

// Kills: writing the launcher in place (writeFileSync(launcher, …)) — boot would follow a planted
// launch-lead.sh symlink and overwrite its target. The target must keep its bytes, and the
// launcher path must end as a regular file boot wrote.
test('a planted launcher symlink is replaced, never written through', async () => {
  let target = null
  const f = await bootPaneLaunchFixture('l4-symlink', {
    before: ({ scratch, taskDir }) => {
      target = join(scratch, 'precious.txt')
      writeFileSync(target, 'precious\n')
      mkdirSync(taskDir, { recursive: true })
      symlinkSync(target, join(taskDir, 'launch-lead.sh'))
    },
  })
  try {
    assert.equal(f.error, null)
    assert.equal(readFileSync(target, 'utf8'), 'precious\n')
    const launcher = join(f.taskDir, 'launch-lead.sh')
    assert.equal(lstatSync(launcher).isSymbolicLink(), false)
    assert.match(readFileSync(launcher, 'utf8'), /^#!\/bin\/sh\nexec /)
  } finally { rmSync(f.scratch, { recursive: true, force: true }); rmSync(f.checkoutRoot, { recursive: true, force: true }) }
})

// Kills: the temporary's exclusive-create flag relaxed ('wx' → 'w') — boot would follow a planted
// launch-lead.sh.tmp-<pid> symlink and overwrite its target. Boot must refuse, target untouched.
test('a planted launcher temporary symlink refuses the boot, never written through', async () => {
  let target = null
  const f = await bootPaneLaunchFixture('l5-tmpsymlink', {
    before: ({ scratch, taskDir }) => {
      target = join(scratch, 'precious.txt')
      writeFileSync(target, 'precious\n')
      mkdirSync(taskDir, { recursive: true })
      symlinkSync(target, join(taskDir, `launch-lead.sh.tmp-${process.pid}`))
    },
  })
  try {
    assert.equal(f.error?.code, 'EEXIST')
    assert.equal(readFileSync(target, 'utf8'), 'precious\n')
  } finally { rmSync(f.scratch, { recursive: true, force: true }); rmSync(f.checkoutRoot, { recursive: true, force: true }) }
})

test('L1', async () => {
  const f = await bootPaneLaunchFixture('l1-launch')
  try {
    assert.equal(f.error, null)
    const commands = layoutCommands(layoutFromCalls(f.calls))
    assert.ok(commands.length >= 2)
    for (const command of commands) {
      assert.ok(Buffer.byteLength(command) <= PANE_LAUNCH_MAX_BYTES)
      const launcher = command.match(/^\/bin\/sh '(.+)'$/)?.[1]
      assert.ok(launcher?.startsWith(f.taskDir))
      assert.ok(statSync(launcher).mode & 0o100)
    }
  } finally { rmSync(f.scratch, { recursive: true, force: true }); rmSync(f.checkoutRoot, { recursive: true, force: true }) }
})

test('L2', async () => {
  const f = await bootPaneLaunchFixture('l2-launch', { args: { 'agent-planner': 'pi' } })
  try {
    assert.equal(f.error, null)
    const crew = JSON.parse(readFileSync(join(f.crewDir, 'crew.json'), 'utf8'))
    const command = layoutCommands(layoutFromCalls(f.calls)).find((item) => item.includes('launch-planner.sh'))
    const launcherPath = command.match(/^\/bin\/sh '(.+)'$/)?.[1]
    const actual = readFileSync(launcherPath, 'utf8')
    const bootBrief = `Crew for task l2-launch. Task dir ${f.taskDir}. Read your role in the system prompt, reply exactly ready: your-role, then wait.`
    const grants = persistedAdapters(crew).planner.grants
    const expected = piSeatCommand({
      role: 'planner', model: crew.members.planner.model, promptFile: join(f.taskDir, 'role-planner.md'),
      tools: crew.members.planner.tools, deny: crew.members.planner.deny, taskDir: f.taskDir,
      bootBrief, effort: crew.members.planner.effort, grants,
    })
    assert.equal(actual, `#!/bin/sh\nexec ${expected}\n`)
    assert.match(actual, /CREW_ROLE=planner/)
    for (const extension of grants.extensions) assert.ok(actual.includes(extension))
    assert.ok(actual.trimEnd().replace(/[\"']$/, '').endsWith(bootBrief))
  } finally { rmSync(f.scratch, { recursive: true, force: true }); rmSync(f.checkoutRoot, { recursive: true, force: true }) }
})

test('L3', async () => {
  const root = scratchDir('crew-l3-deep-')
  const home = join(root, ...Array.from({ length: 9 }, (_, i) => `${i}${'x'.repeat(58)}`))
  const f = await bootPaneLaunchFixture('l3-long', { home })
  try {
    const bytes = Buffer.byteLength(`/bin/sh '${join(f.taskDir, 'launch-lead.sh')}'`, 'utf8')
    assert.ok(bytes > PANE_LAUNCH_MAX_BYTES)
    assert.equal(f.error?.reason, 'pane-launch-too-long')
    assert.match(f.error.message, new RegExp(`lead: ${bytes} bytes`))
    assert.equal(f.calls.filter(([verb]) => verb === 'new-workspace').length, 0)
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(f.scratch, { recursive: true, force: true }); rmSync(f.checkoutRoot, { recursive: true, force: true }) }
})

test('R1', () => {
  const calls = []
  awaitSeatsReady({ members: { planner: { surface_id: 'surface-planner' } } }, 'fresh', null, {
    cmux: (command, args) => { calls.push([command, args]); return { ok: true, stdout: 'ready: planner\n' } },
  })
  assert.deepEqual(calls, [['read-screen', ['--surface', 'surface-planner']]])
})

test('R2', () => {
  const rows = []
  let clock = 0
  awaitSeatsReady({ members: { planner: { surface_id: 'surface-planner' } } }, 'fresh', '/journal.jsonl', {
    cmux: () => ({ ok: true, stdout: 'ready: planner\n' + '\n'.repeat(41) }),
    logLine: (_path, row) => rows.push(row), now: () => clock, sleep: () => { clock = 181_000 },
  })
  assert.deepEqual(rows.map(({ role, signal, mode, accepted }) => ({ role, signal, mode, accepted })), [
    { role: 'planner', signal: 'ready-reply', mode: 'fresh', accepted: true },
  ])
})

test('W1 delayed workspace boot', async () => {
  const task = 'w1-delayed'
  const result = await bootPoll(task, [treeOf(), treeOf(), treeOf(), treeOf(), treeOf(paneWorkspace('ours', task))])
  assert.equal(result.error, null)
  assertCrewPanes(result.crew, 'ours')
  assert.equal(result.sleeps.length, 3)
})

test('W2 missing workspace deadline', async () => {
  const task = 'w2-missing'
  const result = await bootPoll(task, [treeOf(), treeOf()])
  assert.match(result.error.message, new RegExp(`^boot: expected exactly one new crew-${task} workspace, found 0`))
  assert.match(result.error.message, /\(elapsed \d+ms\)$/)
  assert.ok(result.t >= BOOT_WORKSPACE_DEADLINE_MS)
  assert.ok(result.t <= BOOT_WORKSPACE_DEADLINE_MS + BOOT_WORKSPACE_POLL_MS)
})

test('W3 duplicate workspace refusal', async () => {
  const task = 'w3-duplicate'
  const result = await bootPoll(task, [treeOf(), treeOf(paneWorkspace('one', task), paneWorkspace('two', task))])
  assert.match(result.error.message, new RegExp(`^boot: expected exactly one new crew-${task} workspace, found 2`))
  assert.equal(result.sleeps.length, 0)
})

test('T1 foreign titled workspace ignored', async () => {
  const task = 't1-foreign'
  const foreign = { ...paneWorkspace('foreign', task), title: 'crew-other' }
  delete foreign.name
  const result = await bootPoll(task, [treeOf(), treeOf(foreign), treeOf(foreign, paneWorkspace('ours', task, 'title'))])
  assert.equal(result.error, null)
  assertCrewPanes(result.crew, 'ours')
})

test('T2 title-only workspace accepted', async () => {
  const task = 't2-title'
  const result = await bootPoll(task, [treeOf(), treeOf(paneWorkspace('ours', task, 'title'))])
  assert.equal(result.error, null)
  assertCrewPanes(result.crew, 'ours')
})

test('P1 panes arrive after workspace', async () => {
  const task = 'p1-panes'
  const result = await bootPoll(task, [treeOf(), treeOf(paneWorkspace('ours', task, 'name', [])), treeOf(paneWorkspace('ours', task))])
  assert.equal(result.error, null)
  assert.ok(result.sleeps.length > 0)
  assertCrewPanes(result.crew, 'ours')
})

test('P2 incomplete panes deadline', async () => {
  const task = 'p2-incomplete'
  const result = await bootPoll(task, [treeOf(), treeOf(paneWorkspace('ours', task, 'name', []))])
  assert.match(result.error.message, /^boot: expected 4 panes, found 0 \(elapsed \d+ms\)$/)
  assert.ok(result.t >= BOOT_WORKSPACE_DEADLINE_MS)
  assert.ok(result.t <= BOOT_WORKSPACE_DEADLINE_MS + BOOT_WORKSPACE_POLL_MS)
  assert.equal(result.crew, null)
})

const SR_MAP = { version: 1, exempt: ['docs/audits/**'], rules: [
  { when: { roles: ['builder'] }, skills: ['dev-team:base'] },
  { when: { paths: ['crew/**/*.mjs'], roles: ['builder'] }, skills: ['dev-team:alpha'] },
  { when: { paths: ['crew/**/*.mjs'], roles: ['builder'] }, skills: ['dev-team:alpha'] },
] }
test('SR1 lead cannot receive alpha from builder-only path rule', () => {
  // MUTATION: drop path-rule role restrictions during resolution.
  assert.equal(resolveSeatSkills({ map: SR_MAP, role: 'lead', files: ['crew/x.mjs'] }).skills.includes('skills/alpha/SKILL.md'), false)
})
test('SR2 builder cannot receive alpha outside matching path', () => {
  // MUTATION: include role-scoped path rules without checking the fence.
  assert.equal(resolveSeatSkills({ map: SR_MAP, role: 'builder', files: ['docs/x.md'] }).skills.includes('skills/alpha/SKILL.md'), false)
})
test('SR3 role-scoped path rule remains required and described', () => {
  // MUTATION: skip every rule that carries a roles condition at the edit gate.
  assert.deepEqual(requiredSkills(SR_MAP, 'crew/x.mjs'), ['dev-team:alpha'])
})
test('SR4 builder reachable union is ordered, deduplicated and unmeasured', () => {
  // MUTATION: reachableRules drops its role-matching path branch.
  assert.deepEqual(reachableSeatSkills({ map: SR_MAP, role: 'builder' }), { skills: ['skills/base/SKILL.md', 'skills/alpha/SKILL.md'], paths_unmeasured: null })
})
test('SR5 lead reachable union is exactly empty', () => {
  // MUTATION: reachableRules ignores role restrictions on path rules.
  assert.deepEqual(reachableSeatSkills({ map: SR_MAP, role: 'lead' }), { skills: [], paths_unmeasured: null })
})
test('SR6 shipped lead fence has only lean-build', () => {
  // MUTATION: grant backend-node to lead in the shipped role matrix.
  assert.deepEqual(resolveSeatSkills({ map: loadMap(ROOT).map, role: 'lead', files: ['crew/a.mjs', 'test/a.test.mjs'] }).skills, ['skills/lean-build/SKILL.md'])
})
test('SR7 shipped planner fence has lean-build and qa-test-writing', () => {
  // MUTATION: remove planner from the test-writing map rule.
  assert.deepEqual(resolveSeatSkills({ map: loadMap(ROOT).map, role: 'planner', files: ['crew/a.mjs', 'test/a.test.mjs'] }).skills, ['skills/lean-build/SKILL.md', 'skills/qa-test-writing/SKILL.md'])
})
test('SR8 shipped tech-lead fence has lean-build, pr-review and qa-test-writing', () => {
  // MUTATION: remove tech-lead from the test-writing map rule.
  assert.deepEqual(resolveSeatSkills({ map: loadMap(ROOT).map, role: 'tech-lead', files: ['crew/a.mjs', 'test/a.test.mjs'] }).skills, ['skills/lean-build/SKILL.md', 'skills/pr-review/SKILL.md', 'skills/qa-test-writing/SKILL.md'])
})
test('SR9 reachable compiled prompts fit pinned frozen ceilings', () => {
  // MUTATION: lower one reachable skill-block ceiling by one byte.
  const rootBytes = Buffer.byteLength(ROOT, 'utf8'), factors = { builder: 6, lead: 1, planner: 5, reviewer: 7, 'tech-lead': 3 }
  const base = { builder: 21659, lead: 1704, planner: 18102, reviewer: 26219, 'tech-lead': 12656 }
  const blocks = Object.fromEntries(Object.keys(base).map((role) => [role, base[role] + factors[role] * rootBytes]))
  assert.deepEqual(SKILL_BLOCK_CEILINGS, blocks); assert.equal(Object.isFrozen(SKILL_BLOCK_CEILINGS), true)
  const ceilings = Object.fromEntries(Object.entries(CHARTER_CEILINGS).map(([role, n]) => [role, n + 2 + blocks[role]]))
  assert.deepEqual(ROLE_PROMPT_CEILINGS, ceilings); assert.equal(Object.isFrozen(ROLE_PROMPT_CEILINGS), true)
  assert.deepEqual(ROLE_PROMPT_UNMEASURED_CAUSES, ['charter-unreadable', 'skill-map-unreadable', 'skill-unreadable']); assert.equal(Object.isFrozen(ROLE_PROMPT_UNMEASURED_CAUSES), true)
  const measured = rolePromptBytes()
  for (const role of Object.keys(ceilings)) {
    const shared = readFileSync(join(ROOT, 'crew/roles/_shared.md'), 'utf8')
    const card = readFileSync(join(ROOT, `crew/roles/${role}.md`), 'utf8')
    const rendered = renderSeatSkills({ root: ROOT, mapResult: loadDeliveryMap(ROOT), role, files: [], reachable: true, budget: Number.MAX_SAFE_INTEGER })
    const expected = Buffer.byteLength(composeRolePrompt(shared, card, '', 'control', rendered.section), 'utf8')
    assert.equal(measured[role].bytes, expected)
    assert.equal(measured[role].skills_bytes, Buffer.byteLength(rendered.section, 'utf8'))
    assert.ok(measured[role].bytes <= ceilings[role])
  }
  assert.deepEqual(rolePromptRefusals(measured), [])
})
test('SR10 equality passes and planner ceiling plus one refuses exactly', () => {
  // MUTATION: use greater-than-or-equal for role prompt ceilings.
  const at = Object.fromEntries(Object.entries(ROLE_PROMPT_CEILINGS).map(([role, bytes]) => [role, { bytes, reason: null }]))
  assert.deepEqual(rolePromptRefusals(at), [])
  const over = { ...at, planner: { bytes: ROLE_PROMPT_CEILINGS.planner + 1, reason: null } }
  assert.deepEqual(rolePromptRefusals(over), [`${ROLE_PROMPT_REFUSAL}: compiled role prompt planner is ${ROLE_PROMPT_CEILINGS.planner + 1} bytes, over its ${ROLE_PROMPT_CEILINGS.planner}-byte ceiling`])
})
test('SR11 unreadable skills, charters and maps remain null with closed causes', () => {
  // MUTATION: turn a failed reachable skill read into a measured numeric zero.
  const read = (path, encoding) => { if (path.endsWith('SKILL.md')) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return readFileSync(path, encoding) }
  const unavailable = rolePromptBytes(undefined, ROOT, { readFileSync: read })
  assert.ok(Object.values(unavailable).every((row) => row.bytes === null && row.reason === 'skill-unreadable'))
  assert.ok(rolePromptRefusals(unavailable).every((row) => row.includes('skill-unreadable')))
  assert.ok(Object.values(rolePromptBytes(join(ROOT, 'absent-charters'))).every((row) => row.bytes === null && row.reason === 'charter-unreadable'))
  const root = scratchDir('sr11-map-'); mkdirSync(join(root, 'skills'), { recursive: true })
  try { for (const text of ['', '{}']) { writeFileSync(join(root, 'skills/skill-map.json'), text); assert.ok(Object.values(rolePromptBytes(undefined, root)).every((row) => row.bytes === null && row.reason === 'skill-map-unreadable')) }
    rmSync(join(root, 'skills/skill-map.json')); assert.ok(Object.values(rolePromptBytes(undefined, root)).every((row) => row.bytes === null && row.reason === 'skill-map-unreadable'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('SR12 delivered inlined pi skills are omitted across installation roots', () => {
  // MUTATION: compare absolute delivery record paths rather than plugin-relative suffixes.
  // MUTATION: break after the first pi entry; drop the grants spread.
  const entry = { name: 'pi', grants: { skills: ['/reg/skills/x/SKILL.md', '/reg/skills/y/SKILL.md'], extensions: ['keep'] } }
  const adapters = { planner: entry, builder: { name: 'pi', grants: { skills: ['/reg/skills/x/SKILL.md', '/reg/skills/z/SKILL.md'], extensions: ['keep2'] } } }
  omitInlinedPiSkills(adapters, {
    planner: { skills: [{ path: '/plug/skills/x/SKILL.md', status: 'delivered' }, { path: '/plug/skills/y/SKILL.md', status: 'unreadable' }] },
    builder: { skills: [{ path: '/plug/skills/x/SKILL.md', status: 'delivered' }] },
  }, '/plug')
  assert.deepEqual(adapters.planner.grants.skills, ['/reg/skills/y/SKILL.md']); assert.deepEqual(entry.grants.skills, ['/reg/skills/x/SKILL.md', '/reg/skills/y/SKILL.md'])
  assert.deepEqual(adapters.builder.grants.skills, ['/reg/skills/z/SKILL.md'])
  assert.deepEqual(adapters.planner.grants.extensions, ['keep']); assert.deepEqual(adapters.builder.grants.extensions, ['keep2'])
  assert.notEqual(adapters.planner, entry)
})
test('SR13 over-budget inline pi skill stays granted', () => {
  // MUTATION: omit pi skills without checking the delivered status.
  const adapters = { planner: { name: 'pi', grants: { skills: ['/r/skills/x/SKILL.md'] } } }
  omitInlinedPiSkills(adapters, { planner: { skills: [{ path: '/p/skills/x/SKILL.md', status: 'over-budget' }] } }, '/p')
  assert.deepEqual(adapters.planner.grants.skills, ['/r/skills/x/SKILL.md'])
})
test('SR14 Claude grants remain untouched', () => {
  // MUTATION: apply omission to non-pi adapter grants.
  const claude = { name: 'claude', grants: { skills: ['/r/skills/x/SKILL.md'] } }, adapters = { planner: claude }
  omitInlinedPiSkills(adapters, { planner: { skills: [{ path: '/p/skills/x/SKILL.md', status: 'delivered' }] } }, '/p')
  assert.equal(adapters.planner, claude)
})
test('SR15 boot persists empty planner grants and emits no-skills', async () => {
  // MUTATION: remove the pre-persistence pi inline-skill omission call.
  const f = await bootPaneLaunchFixture('sr15-inline', { args: { 'agent-planner': 'pi' } })
  try { assert.equal(f.error, null); const crew = JSON.parse(readFileSync(join(f.crewDir, 'crew.json'), 'utf8')); const launcher = readFileSync(join(f.taskDir, 'launch-planner.sh'), 'utf8')
    assert.deepEqual(persistedAdapters(crew).planner.grants.skills, []); assert.match(launcher, /--no-skills/)
  } finally { rmSync(f.scratch, { recursive: true, force: true }); rmSync(f.checkoutRoot, { recursive: true, force: true }) }
})

// b1103 native pi delivery: NP3/NP5/NP6/NP9 pinned in the suite, not only in the lane's task gate.
const NP_FFF_BIN = '/opt/homebrew/bin/fff-mcp'
const NP_FFF_SERVER = { name: 'fff', command: { bin: NP_FFF_BIN, args: [] }, url: null }
const npShipped = () => JSON.parse(readFileSync(join(ROOT, 'crew/capabilities.json'), 'utf8'))
const npGranted = (extensions = ['builtin:mcp']) => ({ tools: [], extensions, agents: [], skills: [], advisor: false, mcp_servers: [NP_FFF_SERVER] })
const npSpec = (entry) => ({ taskDir: '/np/task', checkout: '/np/checkout', roles: ['builder'], adapters: { builder: entry }, env: { PI_CODING_AGENT_DIR: '/np/base' } })
function npFs(base = { theme: 'dark' }, project = false) {
  const writes = new Map()
  const noEntry = () => { throw Object.assign(new Error('fixture absent'), { code: 'ENOENT' }) }
  return { writes, deps: {
    lstatSync(path) { if (project && path === '/np/checkout/.pi/mcp.json') return { isDirectory: () => false }; return noEntry() },
    readFileSync: (path) => path === '/np/base/settings.json' ? JSON.stringify(base) : noEntry(),
    readdirSync: () => [], mkdirSync() {}, rmSync() {}, symlinkSync() {},
    writeFileSync: (path, text) => writes.set(path, JSON.parse(text)),
  } }
}

// Kills: writePiSeatAgentDirs materialising only codemode seats again.
test('NP3 codemode off still writes native mcp.json and exactly the base settings', async () => {
  const entry = (await resolveAdapters(['builder'], { 'agent-builder': 'pi' }, null, { register: npShipped(), env: { CREW_PI_CODEMODE: 'off' }, exists: (path) => path === NP_FFF_BIN || existsSync(path) })).builder
  assert.equal(entry.grants.extensions.includes('builtin:mcp'), true)
  assert.equal(entry.grants.extensions.includes('builtin:codemode'), false)
  const fs = npFs(); const spec = npSpec(entry)
  writePiSeatAgentDirs(spec, fs.deps); writeMcpConfigs(spec, fs.deps)
  assert.deepEqual(fs.writes.get('/np/task/pi-agent/builder/settings.json'), { theme: 'dark' })
  assert.deepEqual(fs.writes.get('/np/task/pi-agent/builder/mcp.json'), { mcpServers: { fff: { command: NP_FFF_BIN, args: [], exposure: 'direct' } } })
  const preserved = npFs({ codemode: { mode: 'on', timeout: 7 } })
  writePiSeatAgentDirs(spec, preserved.deps)
  assert.deepEqual(preserved.writes.get('/np/task/pi-agent/builder/settings.json'), { codemode: { mode: 'on', timeout: 7 } })
})

// Kills: pi MCP exposure serialised as anything but direct.
test('NP5 pi mcp.json carries exposure direct and claude MCP JSON carries none', async () => {
  const pi = await import('./adapters/adapter-pi.mjs'); const claude = await import('./adapters/adapter-claude.mjs')
  const fs = npFs()
  writeMcpConfigs(npSpec({ name: 'pi', adapter: pi, transport: 'pane', grants: npGranted() }), fs.deps)
  assert.deepEqual(fs.writes.get('/np/task/pi-agent/builder/mcp.json'), { mcpServers: { fff: { command: NP_FFF_BIN, args: [], exposure: 'direct' } } })
  writeMcpConfigs(npSpec({ name: 'claude', adapter: claude, transport: 'pane', grants: npGranted([]) }), fs.deps)
  assert.deepEqual(fs.writes.get(claude.mcpConfigPath({ taskDir: '/np/task', role: 'builder' })), { mcpServers: { fff: { command: NP_FFF_BIN, args: [] } } })
})

// Kills: the project .pi/mcp.json refusal disabled.
test('NP6 an MCP-only pi seat refuses a project .pi/mcp.json before any write', () => {
  const fs = npFs({}, true)
  let refusal = null
  try { writePiSeatAgentDirs(npSpec({ name: 'pi', grants: npGranted() }), fs.deps) } catch (error) { refusal = { reason: error.reason, message: error.message } }
  assert.equal(refusal?.reason, 'grant-unsupported')
  assert.equal(refusal?.message.includes('/np/checkout/.pi/mcp.json'), true)
  assert.equal(fs.writes.size, 0)
})

// Kills: the boot row's pi_codemode expression replaced with null.
test('NP9 the boot journal records pi_codemode on/default when unset and off/env when off', async () => {
  const root = scratchDir('np9-native-'); const home = join(root, 'home'); const checkout = join(root, 'checkout')
  mkdirSync(home); mkdirSync(checkout)
  const prior = process.env.HOME; const priorDb = process.env.DEVTEAM_LEDGER_DB
  process.env.HOME = home; process.env.DEVTEAM_LEDGER_DB = join(root, 'uncreated.db')
  try {
    const records = []
    for (const [task, env] of [['default', {}], ['off', { CREW_PI_CODEMODE: 'off' }]]) {
      const register = npShipped()
      for (const role of ['lead', 'builder']) { register.roles[role].advisor = false; register.roles[role].by_agent = {} }
      await bootCmd({ task, checkout, roles: 'lead,builder', 'agent-lead': 'pi', 'agent-builder': 'pi', 'headless-all': true }, {
        register, env: { ...env, PI_CODING_AGENT_DIR: join(root, 'base') }, checkoutBaseBranch: () => 'main',
        awaitSeatsReady: async () => {}, openRun: () => ({ recordSeats() {} }),
        cmux() { throw new Error('NP9 must not launch cmux') },
      })
      const rows = readFileSync(join(home, '.crew', 'checkout', task, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      records.push(rows.find((row) => row.event === 'boot')?.pi_codemode)
    }
    assert.deepEqual(records, [{ value: 'on', source: 'default' }, { value: 'off', source: 'env' }])
  } finally {
    if (prior === undefined) delete process.env.HOME; else process.env.HOME = prior
    if (priorDb === undefined) delete process.env.DEVTEAM_LEDGER_DB; else process.env.DEVTEAM_LEDGER_DB = priorDb
    rmSync(root, { recursive: true, force: true })
  }
})
