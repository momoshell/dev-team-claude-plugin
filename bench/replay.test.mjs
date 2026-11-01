import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ARMS, CHECKOUT, CORPUS_DIR, createOutDir, parseCli, validateArms, writeDiff } from './replay-common.mjs'
import { openMemory, renderSection } from '../crew/memory.mjs'
import { parseAgent } from '../crew/protocols.mjs'
import { runBuilder } from './replay-builder.mjs'
import { runPlanner } from './replay-planner.mjs'

const LANES = { b1380: '1d282ec7', b1381: '1d282ec7', b1402: '2966b484', b1408: 'fbc9ad2a', b1416: 'abe2d073', b1417: 'abe2d073', b1457: '0d08adff4f5ccc8c2f0b94327b4a9e47ed5ff598', b1458: '0d08adff4f5ccc8c2f0b94327b4a9e47ed5ff598', b1459: '0d08adff4f5ccc8c2f0b94327b4a9e47ed5ff598' }
const NEW_LANES = { b1440: 'b1440-acp-client-error-message', b1441: 'b1441-pi-provider-failure-kind', b1442: 'b1442-finish-insufficient-build', b1444: 'b1444-claude-reads-use-read-tool', b1448: 'b1448-lean-memory-injection', b1450: 'b1450-start-log-never-throws', b1451: 'b1451-pi-websocket-error-retry', b1454: 'b1454-waterfall-polish' }
Object.assign(LANES, { b1440: 'b593d34d0ac93f85854ba38ecfd31e6e613980ac', b1441: '88f70c51c78ebd1931728bb7ded08727b34cff3c', b1442: '88f70c51c78ebd1931728bb7ded08727b34cff3c', b1444: '1d2fc7cdd8864e24e9d0b714641597d74b901660', b1448: 'ccac8537ad7f0231a181e47e5e81828648d2a4b7', b1450: '0634116878372be6e56ce51bf752c305d34adf2c', b1451: '0634116878372be6e56ce51bf752c305d34adf2c', b1454: '4fbffc0c4b1695ec131167ecec0ef63792e6b4b1' })
const REVIEWER_METADATA = {
  "b1440": {
    "builtHead": null,
    "promptSource": null,
    "reason": "no archived reviewer prompt or reproducible built head"
  },
  "b1441": {
    "builtHead": "f1ceef3db170c050ad6f977b8d0a368a01014feb",
    "promptSource": "/Users/momoshell/.crew-journal-archive/dt-b1441-pi-provider-failure-kind/b1441-pi-provider-failure-kind/task/lean/reviewer/b1441-pi-provider-failure-kind.reviewer.3.jsonl"
  },
  "b1442": {
    "builtHead": "982f75fd42a4f7dd36989f9dc67d593a597fc962",
    "promptSource": "/Users/momoshell/.crew-journal-archive/dt-b1442-finish-insufficient-build/b1442-finish-insufficient-build/task/lean/reviewer/b1442-finish-insufficient-build.reviewer.3.jsonl"
  },
  "b1444": {
    "builtHead": null,
    "promptSource": "/Users/momoshell/.crew-journal-archive/dt-b1444-claude-reads-use-read-tool/b1444-claude-reads-use-read-tool/task/lean/reviewer/b1444-claude-reads-use-read-tool.reviewer.7.jsonl",
    "reason": "no archived reproducible built head"
  },
  "b1448": {
    "builtHead": "7c7c9e71d3d9e59a5b78357899213e645624de82",
    "promptSource": "/Users/momoshell/.crew-journal-archive/dt-b1448-lean-memory-injection/b1448-lean-memory-injection/task/lean/reviewer/b1448-lean-memory-injection.reviewer.3.jsonl"
  },
  "b1450": {
    "builtHead": "bef547bc2772a26ef13837dca0f90506a6c76d5a",
    "promptSource": "/Users/momoshell/.crew-journal-archive/dt-b1450-start-log-never-throws/b1450-start-log-never-throws/task/lean/reviewer/b1450-start-log-never-throws.reviewer.5.jsonl"
  },
  "b1451": {
    "builtHead": "4ad976f60cd1048129613297eedff674db44dffd",
    "promptSource": "/Users/momoshell/.crew-journal-archive/dt-b1451-pi-websocket-error-retry/b1451-pi-websocket-error-retry/task/lean/reviewer/b1451-pi-websocket-error-retry.reviewer.3.jsonl"
  },
  "b1454": {
    "builtHead": "c43edcff0d1a0b710b958a814424063056637ae0",
    "promptSource": "/Users/momoshell/.crew-journal-archive/dt-b1454-waterfall-polish/b1454-waterfall-polish/task/lean/reviewer/b1454-waterfall-polish.reviewer.4.jsonl"
  }
}
// SHA256 of the seven inputs, computed from the archives at freeze time.
const ARCHIVE_HASHES = {
  "b1440": {
    "plan.md": "60ddd14b29f5204f3783e806460d9f4f763cfe028e9bcafd402e37742ecb5181",
    "gate.mjs": "90dbd1d619c812de3d3a8fde0af7b7a2f0394b19bc13e6f9f3d63ef5f3de7838",
    "planner-1.json": "45c59a2499f70cde459e44f796a284561109ccc170fac28364789636aaf78ad0",
    "lean.json": "425e9fafd545020eedf0e774516a062a40e895f54d906cd7f6529ce01658b5e1",
    "brief.md": "573b1b42688e6bdeb8440587eebe6d4a16f14767fc40670a14f798de731e54c4",
    "planner-prompt.txt": "33ce3e3b6e054ea8f992502ab6dfa57042c266cf8ca53758f13147a7ca92940e",
    "builder-prompt.txt": "d572b570f43827e478d50f305cfad348cacfffa7fa372bc725ea76cd29f5cbbb"
  },
  "b1441": {
    "plan.md": "b78cb4494a52e60dc007478cfc36fd453973a2f40581582258f062b1ca9afe1a",
    "gate.mjs": "a03dd87ae13e835793f2111d288276db846a1a27f69fae90ddff4d13be9892b8",
    "planner-1.json": "e431e8e5d2b888c81e599281cc02f7f4b14a46c74a7b23b1981ffc460229d6fd",
    "lean.json": "a90743f9a003f206702ad5f7f7c168fbf011c5740be759cb78a3f0f6b0092c46",
    "brief.md": "48fb5d23a4d2da5bfb535a27d330133bc8b77331bc90bb0fc66d8e58fabf8066",
    "planner-prompt.txt": "5329cbd57d9e30f453ff9b14d3861fa0d5ab909ddd5df7736e6e5145c615d608",
    "builder-prompt.txt": "0505595a69c1531ab752178c478f2cdacda7c60d2baadf203f7ef7df2b7f4346"
  },
  "b1442": {
    "plan.md": "c91808233ac7ed79ed76f933b646e3381c9408ced206c3025eb6157c66c0f1d1",
    "gate.mjs": "a118eedb463f06b29992cada8287d72fea27d5211a9fc68bdceb90f5b010207c",
    "planner-1.json": "4c808955c51267efca3dd1c597f53b3612c400181ba2d37c12adc0798435ca9b",
    "lean.json": "19d1f04c2b0334ab9cbcbf91a5dd3aa05042fcd6a02b0e220c96680736d2c7ec",
    "brief.md": "26665bc6d7dc8f9a74595c8e3752c898acf7ebd73ca09f67da8c546939eedc13",
    "planner-prompt.txt": "254d1424200244e73aae26e6cbbe73dd749f49522221417a0ef0947c77ad316f",
    "builder-prompt.txt": "a48ee4a79f380ec687b9ad3bff76d735bc0b88ef00e9da66586b9307a563cbaf"
  },
  "b1444": {
    "plan.md": "ff48fb278b8706eb03badf54a68f34660a8835800f8d3bf4909c56b91f66c5eb",
    "gate.mjs": "76dab367f73efd933b9bf8cf8ac461b341b23f9b1cfd9b792567a25ef1e2cf0e",
    "planner-1.json": "380473ce87e6e93ef8530895df76fd3e68a9c475505f44f6f2d22a7cf5ca3fd8",
    "lean.json": "100d55699b1c4ba801c2c90725df5dc649815bd00330401ad440abcf2660a59e",
    "brief.md": "d2be062bc402838ca8a42860e7f3163fb968e95cda3f5c3e7b34388e2b83f952",
    "planner-prompt.txt": "5e4cea999e8c396d24790daba8508ddd6cf8b18a35cd2ae4db743980c9c965a6",
    "builder-prompt.txt": "7d7ecb34cf5b671b90fc438ea73b53901720147e6d8831bdcfd1137b263519e0"
  },
  "b1448": {
    "plan.md": "87e51f2121ab3d9b102596864ef5ef9418e55bcbd821519ee5474f6c5576bc98",
    "gate.mjs": "f4f6f3d6e2daf55ef6373b1958d3020bb1f35f4f73ef97f60ccea000d15f7ce1",
    "planner-1.json": "2ef3c22876aa4d3f4774a0118f02ec2771dd2c6093792aa83fb696d1db54ac5b",
    "lean.json": "75d40e3ecd7904474c9357f189a58ebfa8123935a4c061f36541058113f1636e",
    "brief.md": "fca6904e9901bab114823e301e52d3c9b116c9a0a4153402ff7ccf2d38d06be2",
    "planner-prompt.txt": "ed0f4cdda373822dd34eb4910ca046cd4ee04c026e3b5c321d243be813dd299d",
    "builder-prompt.txt": "a7e43980e5e64f70e1e59f9d7a07e760fc60f6c20daf2b424a4cba1d691ff9be"
  },
  "b1450": {
    "plan.md": "a7ba6c58c09f10116b4f657118b3893b6e12f7b09fbbbc0d9fc1df97dcb728dc",
    "gate.mjs": "fe8421e948e4d3f2b92590dc1c54ade882c76b636a603e76dd49343464adc7e5",
    "planner-1.json": "b15300c56d58ecdec205cc6d6f8eaaa184e3bb0d207712c8b0679e23241d3f45",
    "lean.json": "7697bfc3c9936d89d13bb2cb0c7e9e9c5f0be026cf65bce2432670bed060a6d0",
    "brief.md": "d1793087c88a40c8335cc19781a5eb7f462d62d847294afedb224dfd4728a584",
    "planner-prompt.txt": "39d18effe36d77b01a5f9de6d31dd654c673456f028095d240ef337afb828a07",
    "builder-prompt.txt": "d3afbf849f1e934fbb27d7ad576d6a63742ebba27ad07b47dd656d3258212f23"
  },
  "b1451": {
    "plan.md": "8e98650be2a6c6c6d644fc1dab60d7af8b0f183b71068a1e56755fc41250c5d0",
    "gate.mjs": "47e30992de0db42001aae4ee45388105ec4dd177c4f3e5f3c9625620211026b1",
    "planner-1.json": "6acef31064c0ff0727560f5e28efcea13e098d41fe5f2b9101acf2deec73fc8b",
    "lean.json": "845b57991cc65e266a1348054af6839825a6addf9cec0e90c3f68c8d498458dd",
    "brief.md": "00fa1609bbec2566e7980541a1f08ccd8b7069ac844f0d9482df50eae2416166",
    "planner-prompt.txt": "9d92d20e07b09ecaec43dcb634894d361ec0e53ab5e98050e6362a62fada9e71",
    "builder-prompt.txt": "553fcb38c4cb5f023b4729d646cee44b648a0a463c69612ad49e7d12b4ab2192"
  },
  "b1454": {
    "plan.md": "ec715514e4c253c6766cc90695643eb6e2ac37f06b910c144816a99336f2a03d",
    "gate.mjs": "fa762a5d45ca864f4fad81c3318c2b572462be6250f6e326731121f9e4093c86",
    "planner-1.json": "3f2c8b0e3881d3aca5a44330a2b5d52562ff52b9ee90711dfd3227e30d448bb7",
    "lean.json": "f5b991e2f09aa9a605f94686d24ee6b0ed5215206b9b01184c9cdd1652614700",
    "brief.md": "6c7d40e8cb23232a0a73504617d7f8c9f83a86cc9f228a5e25b63e37c56f5c76",
    "planner-prompt.txt": "acd9031a939a232527f7c35dda4ad25c7a21d1f5e1233d30c4af0dbf04068113",
    "builder-prompt.txt": "545220767931ce60d37749e85eb41715bb49c96d1205d85b5507d9a5b4691175"
  }
}
const CELL = { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high' }
const json = (p) => JSON.parse(readFileSync(p, 'utf8'))
const scratch = mkdtempSync(join(tmpdir(), 'seat-bench-test-'))
test.after(() => rmSync(scratch, { recursive: true, force: true }))
let n = 0
const fresh = (label = 'run') => join(scratch, `${label}-${n++}`)
const sh = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }

test('the corpus carries every replay input for the seventeen lanes', () => {
  for (const [lane, base] of Object.entries(LANES)) {
    const dir = join(CORPUS_DIR, lane)
    for (const name of ['plan.md', 'gate.mjs', 'planner-1.json', 'lean.json', 'brief.md', 'planner-prompt.txt', 'builder-prompt.txt', 'manifest.json']) {
      assert(existsSync(join(dir, name)), `${lane}/${name}`)
      assert(readFileSync(join(dir, name), 'utf8').trim().length > 0, `${lane}/${name} empty`)
    }
    const manifest = json(join(dir, 'manifest.json'))
    const lean = json(join(dir, 'lean.json'))
    assert.equal(manifest.lane, lane)
    assert.equal(manifest.base, base)
    assert.equal(manifest.originalTask, lean.taskDir)
    assert.equal(manifest.originalTree, lean.cwd)
    if (['b1457', 'b1458', 'b1459', ...Object.keys(NEW_LANES)].includes(lane)) {
      assert.equal(readFileSync(join(dir, 'brief.md'), 'utf8'), lean.brief)
      assert(manifest.source.includes(`dt-${lane}-`))
      assert.equal(manifest.id, lean.id)
    }
    for (const role of ['planner', 'builder']) {
      const prompt = readFileSync(join(dir, `${role}-prompt.txt`), 'utf8')
      assert(prompt.startsWith(`You are the lean ${role}.`))
      assert(prompt.includes(manifest.originalTask))
      assert(/Return path: .*(planner|builder)-\d+\.json/.test(prompt))
    }
  }
})

// MUTATION: CL1 corrupts b1440 manifest lane.
test('CL1 archived code lanes retain their exact inputs and provenance', () => {
  for (const [lane, id] of Object.entries(NEW_LANES)) {
    const dir = join(CORPUS_DIR, lane)
    const lean = json(join(dir, 'lean.json'))
    assert.deepEqual(json(join(dir, 'manifest.json')), {
      lane, id, base: LANES[lane], originalTask: lean.taskDir, originalTree: lean.cwd,
      source: `/Users/momoshell/.crew-journal-archive/dt-${id}/${id}/task`, reviewer: REVIEWER_METADATA[lane],
      ...(lane === 'b1441' ? { knownDefect: { fixingCommits: ['4ad976f60cd1048129613297eedff674db44dffd'], files: ['crew/acp/provider.mjs'], description: 'Exact WebSocket error was not retryable.' } } : {}),
    })
    for (const [name, expected] of Object.entries(ARCHIVE_HASHES[lane])) {
      assert.equal(createHash('sha256').update(readFileSync(join(dir, name))).digest('hex'), expected, `${lane}/${name}`)
    }
  }
})

// MUTATION: CL2 changes b1440 planner Task directory citation.
test('CL2 archived code lanes prepare planner replays', async () => {
  for (const lane of Object.keys(NEW_LANES)) {
    const fx = fixture(lane)
    const dir = join(fx.corpusDir, lane)
    cpSync(join(CORPUS_DIR, lane), dir, { recursive: true })
    const manifestPath = join(dir, 'manifest.json')
    const manifest = json(manifestPath)
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, base: fx.base }))
    const out = fresh()
    let seen = false
    const result = await runPlanner({ lane, cell: CELL, arms: [], out }, { ...fx.deps, runAcpSeat(call) {
      seen = true
      assert(call.prompt.includes(`Task directory: ${join(out, 'task')}`))
      assert(call.prompt.includes(`Return path: ${join(out, 'task', 'planner-1.json')}`))
      assert(!call.prompt.includes(manifest.originalTask))
      assert(!call.prompt.includes(manifest.originalTree))
      writeFileSync(join(call.taskDir, 'plan.md'), '# plan\n')
      writeFileSync(join(call.taskDir, 'gate.mjs'), 'x\n')
      writeFileSync(join(call.taskDir, 'planner-1.json'), JSON.stringify({ status: 'done', summary: 'planned', details: {} }))
      return { stopReason: 'end_turn' }
    }, runGate: async () => ({ status: 'red', failingIds: [] }) })
    assert(seen)
    assert.equal(result.error, null)
    assert(!existsSync(join(out, 'tree')))
    assert.equal(worktrees(fx.repo), 1)
  }
})

// MUTATION: CC1 forces codemode false in the definition.
test('CC1 forwards codemode independently of skills and arms', async () => {
  const fx = fixture()
  for (const run of [runBuilder, runPlanner]) for (const value of [true, false, undefined]) {
    const cell = { ...CELL, skills: ['code-less'], ...(value === undefined ? {} : { codemode: value }) }
    let definition
    await run({ lane: 'b1380', cell, arms: ['fff'], out: fresh() }, { ...fx.deps,
      runAcpSeat: (call) => { definition = call.definition; return { stopReason: 'end_turn' } },
      runGate: async () => ({ status: 'red' }), proveMutations: async () => ({}),
    })
    assert.equal(definition.codemode, value ?? false)
    assert.deepEqual(definition.skills, ['code-less'])
    assert.deepEqual(definition.extensions, ['fff'])
  }
  for (const run of [runBuilder, runPlanner]) for (const throws of [true, false]) {
    const out = fresh()
    const result = await run({ lane: 'b1380', cell: { ...CELL, agent: 'claude', codemode: true }, arms: [], out }, { ...fx.deps,
      runAcpSeat: ({ definition }) => {
        assert.equal(definition.codemode, true)
        if (throws) throw Object.assign(new Error('unsupported'), { code: 'grant-unsupported' })
        return { refusal: { code: 'grant-unsupported', message: 'unsupported' } }
      }, runGate: async () => ({ status: 'red' }), proveMutations: async () => ({}),
    })
    assert.match(result.error, /grant-unsupported/)
    assert.equal(result.status, null)
    assert.equal(result.status_reason, 'missing-return')
    assert.equal(json(join(out, 'result.json')).error, result.error)
  }
})

// MUTATION: CC2 removes codemode type validation.
test('CC2 rejects non-boolean codemode before preparation', async () => {
  for (const run of [runBuilder, runPlanner]) for (const codemode of [null, undefined, 'true', 1, [], {}]) {
    let calls = 0
    const out = fresh()
    const result = await run({ lane: 'b1380', cell: { ...CELL, codemode }, arms: [], out }, { prepareRun: () => { calls++ }, runAcpSeat: () => { calls++ } })
    assert.equal(calls, 0)
    assert.match(result.error, /cell\.codemode/)
    assert.equal(json(join(out, 'result.json')).error, result.error)
    assert.equal(result.status_reason, 'not-run')
  }
})

// MUTATION: CC3 replaces the first-return status extraction with null.
test('CC3 persists first-return status and reasons for both roles', async () => {
  const fx = fixture()
  const cases = [
    ['done', JSON.stringify({ status: 'done', summary: 'ok' }), 'done', null],
    ['insufficient', JSON.stringify({ status: 'insufficient', summary: 'ok' }), 'insufficient', null],
    ['escalate', JSON.stringify({ status: 'escalate', summary: 'ok' }), 'escalate', null],
    ['no summary', JSON.stringify({ status: 'insufficient' }), 'insufficient', null],
    ['missing', null, null, 'missing-return'],
    ['unreadable', 'directory', null, 'unreadable-return'],
    ['malformed', '{', null, 'invalid-json'],
    ['non-object', '[]', null, 'invalid-envelope'],
    ['no status', JSON.stringify({ summary: 'ok' }), null, 'invalid-status'],
    ['unknown', JSON.stringify({ status: 'other', summary: 'ok' }), null, 'invalid-status'],
  ]
  for (const [role, run] of [['builder', runBuilder], ['planner', runPlanner]]) for (const [label, content, status, reason] of cases) {
    const out = fresh()
    const result = await run({ lane: 'b1380', cell: CELL, arms: [], out }, { ...fx.deps,
      runAcpSeat: (call) => {
        const file = join(call.taskDir, role === 'builder' ? 'builder-2.json' : 'planner-1.json')
        if (content === 'directory') mkdirSync(file)
        else if (content !== null) writeFileSync(file, content)
        if (role === 'planner') { writeFileSync(join(call.taskDir, 'plan.md'), 'plan'); writeFileSync(join(call.taskDir, 'gate.mjs'), 'gate') }
        return { stopReason: 'end_turn' }
      }, runGate: async () => { throw new Error('gate failed') }, proveMutations: async () => ({}),
    })
    assert.equal(result.status, status, label)
    assert.equal(result.status_reason, reason, label)
    assert.match(result.error, /gate failed/)
    const saved = json(join(out, 'result.json'))
    assert.equal(saved.status, status, label)
    assert.equal(saved.status_reason, reason, label)
  }
  for (const run of [runBuilder, runPlanner]) {
    const out = fresh()
    const result = await run({ lane: 'b1380', cell: CELL, arms: [], out }, { prepareRun: () => { throw new Error('setup failed') } })
    assert.equal(result.status, null)
    assert.equal(result.status_reason, 'not-run')
    assert.equal(json(join(out, 'result.json')).status_reason, 'not-run')
  }
})

// MUTATION: SK1 drops the cell skills from the seat definition.
test('SK1 forwards explicit skills to both seats unchanged', async () => {
  for (const run of [runBuilder, runPlanner]) for (const skills of [['zeta', 'alpha', 'zeta'], []]) {
    const fx = fixture()
    let seen
    await run({ lane: 'b1380', cell: { ...CELL, skills }, arms: [], out: fresh() }, {
      ...fx.deps, runAcpSeat: (call) => { seen = call.definition.skills; return { stopReason: 'end_turn' } },
      runGate: async () => ({ status: 'red' }), proveMutations: async () => ({}),
    })
    assert.deepEqual(seen, skills)
  }
})

// MUTATION: SK2 removes skill shape validation.
test('SK2 rejects malformed skills before preparation in both replays', async () => {
  for (const run of [runBuilder, runPlanner]) for (const skills of [null, 'x', {}, [1], ['x', null], [''], ['  ']]) {
    let calls = 0
    const out = fresh()
    const result = await run({ lane: 'b1380', cell: { ...CELL, skills }, arms: [], out }, { prepareRun: () => { calls++ }, runAcpSeat: () => { calls++ } })
    assert.equal(calls, 0)
    assert.match(result.error, /cell\.skills/)
    assert.equal(json(join(out, 'result.json')).error, result.error)
  }
})

// MUTATION: SK3 injects an unrequested default skill.
test('SK3 omitted skills grants nothing in both replays', async () => {
  for (const run of [runBuilder, runPlanner]) {
    const fx = fixture()
    let seen
    await run({ lane: 'b1380', cell: CELL, arms: [], out: fresh() }, { ...fx.deps, runAcpSeat: (call) => { seen = call.definition.skills; return { stopReason: 'end_turn' } }, runGate: async () => ({ status: 'red' }), proveMutations: async () => ({}) })
    assert.deepEqual(seen, [])
  }
})

// MUTATION: SK4 prevents the new lanes from loading for builders.
test('SK4 new corpus prepares builder replays and cleans up', async () => {
  for (const lane of ['b1457', 'b1458', 'b1459']) {
    const fx = fixture(lane)
    const dir = join(fx.corpusDir, lane)
    cpSync(join(CORPUS_DIR, lane), dir, { recursive: true })
    const manifestPath = join(dir, 'manifest.json')
    const manifest = json(manifestPath)
    assert.equal(manifest.base, LANES[lane])
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, base: fx.base }))
    const out = fresh()
    let seen = false
    const result = await runBuilder({ lane, cell: CELL, arms: [], out }, { ...fx.deps, runAcpSeat: (call) => {
      seen = true
      assert(call.prompt.includes(join(out, 'task')))
      assert(!call.prompt.includes(manifest.originalTask))
      assert(existsSync(join(call.taskDir, 'plan.md')) && existsSync(join(call.taskDir, 'gate.mjs')) && existsSync(join(call.taskDir, 'planner-1.json')))
      writeFileSync(join(call.taskDir, 'builder-2.json'), JSON.stringify({ status: 'done', summary: 'ok' }))
      return { stopReason: 'end_turn' }
    }, runGate: async () => ({ status: 'red' }), proveMutations: async () => ({}) })
    assert(seen)
    assert.equal(result.error, null)
    assert(!existsSync(join(out, 'tree')))
    assert.equal(worktrees(fx.repo), 1)
  }
})

test('missing planner prompts refuse early without blocking builders', async () => {
  for (const reason of ['archive has no session', null]) {
    const fx = fixture()
    const dir = join(fx.corpusDir, 'b1380')
    if (reason) writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...json(join(dir, 'manifest.json')), plannerPromptMissing: reason }))
    else rmSync(join(dir, 'planner-prompt.txt'))
    let calls = 0
    const out = fresh()
    const result = await runPlanner({ lane: 'b1380', cell: CELL, arms: [], out }, { ...fx.deps, runAcpSeat: () => { calls++ } })
    assert.match(result.error, reason ? /archive has no session/ : /missing first planner prompt/)
    assert.equal(calls, 0)
    assert(!existsSync(join(out, 'tree')))
    const builder = await runBuilder({ lane: 'b1380', cell: CELL, arms: [], out: fresh() }, { ...fx.deps, runAcpSeat: (call) => { calls++; writeFileSync(join(call.taskDir, 'builder-2.json'), JSON.stringify({ status: 'done', summary: 'ok' })); return { stopReason: 'end_turn' } }, runGate: async () => ({ status: 'red' }), proveMutations: async () => ({}) })
    assert.equal(builder.error, null)
    assert.equal(calls, 1)
    assert.equal(worktrees(fx.repo), 1)
  }
})

test('validateArms accepts the closed vocabulary and the empty list, and refuses everything else', () => {
  assert.deepEqual(validateArms([]), [])
  assert.deepEqual(validateArms([...ARMS]), [...ARMS])
  for (const bad of ['nope', 'constructor', '__proto__', 'toString', 'FFF', '']) {
    assert.throws(() => validateArms(['fff', bad]), (e) => e.message.startsWith('unknown arm: ') && e.message.includes(bad === '' ? 'unknown arm: ' : bad))
  }
  assert.throws(() => validateArms([42]), /unknown arm/)
  assert.throws(() => validateArms('fff'), /list/)
})

for (const [name, run] of [['builder', runBuilder], ['planner', runPlanner]]) {
  test(`${name} replay refuses an unknown arm before preparing or starting a seat`, async () => {
    for (const arms of [['nope'], ['fff', 'nope'], ['constructor'], ['__proto__']]) {
      let prepared = 0, seats = 0
      const out = fresh(name)
      const result = await run({ lane: 'b1380', cell: CELL, arms, out }, { prepareRun: () => { prepared++; throw new Error('prepared') }, runAcpSeat: () => { seats++ } })
      assert.equal(prepared + seats, 0)
      assert.match(result.error, /unknown arm: /)
      assert.equal(json(join(out, 'result.json')).error, result.error)
      assert(existsSync(join(out, 'session.jsonl')) && existsSync(join(out, 'diff.patch')))
      assert(!existsSync(join(out, 'tree')))
    }
  })
  test(`${name} replay: a failing preparation is recorded and never reaches the seat`, async () => {
    for (const arms of [[], ['fff', 'readgate']]) {
      let seats = 0
      const out = fresh(name)
      const result = await run({ lane: 'b1380', cell: CELL, arms, out }, { prepareRun: () => { throw new Error('boom') }, runAcpSeat: () => { seats++ } })
      assert.equal(seats, 0)
      assert.match(result.error, /boom/)
      assert.match(json(join(out, 'result.json')).error, /boom/)
    }
  })
  test(`${name} replay records a bad cell`, async () => {
    const result = await run({ lane: 'b1380', cell: { agent: 'pi' }, arms: [], out: fresh(name) }, { prepareRun: () => { throw new Error('unreachable') } })
    assert.match(result.error, /cell\.model/)
  })
}

test('the CLIs record failures and exit nonzero', () => {
  const cell = join(scratch, 'cell.json')
  writeFileSync(cell, JSON.stringify(CELL))
  for (const script of ['replay-builder.mjs', 'replay-planner.mjs']) {
    const out = fresh('cli')
    const r = spawnSync(process.execPath, [join(CHECKOUT, 'bench', script), '--lane', 'b1380', '--cell', cell, '--arms', 'fff,bogus', '--out', out], { encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.match(json(join(out, 'result.json')).error, /unknown arm: bogus/)
    const missing = spawnSync(process.execPath, [join(CHECKOUT, 'bench', script), '--lane', 'b1380'], { encoding: 'utf8' })
    assert.equal(missing.status, 2)
    const inside = join(CORPUS_DIR, 'b1380', 'run-here')
    const refused = spawnSync(process.execPath, [join(CHECKOUT, 'bench', script), '--lane', 'b1380', '--cell', cell, '--arms', '', '--out', inside], { encoding: 'utf8' })
    assert.equal(refused.status, 2)
    assert(!existsSync(inside))
  }
})

test('output destinations are confined', () => {
  const home = fresh('home')
  mkdirSync(join(home, '.crew'), { recursive: true })
  const opts = { home }
  assert.throws(() => createOutDir('relative/out', opts), /absolute/)
  assert.throws(() => createOutDir(join(CORPUS_DIR, 'x'), opts), /corpus/)
  assert.throws(() => createOutDir(join(CHECKOUT, 'bench', 'x'), opts), /checkout/)
  assert.throws(() => createOutDir(join(home, '.crew', 'x'), opts), /\.crew/)
  const link = fresh('link')
  symlinkSync(CHECKOUT, link)
  assert.throws(() => createOutDir(join(link, 'x'), opts), /checkout/)
  const existing = fresh('existing')
  mkdirSync(existing)
  assert.throws(() => createOutDir(existing, opts), /exists/)
  const ok = createOutDir(fresh('ok'), opts)
  assert(existsSync(join(ok, 'session.jsonl')))
})

// A throwaway repo and corpus so the default preparation runs for real without the crew checkout.
function fixture(lane = 'b1380') {
  const repo = fresh('repo')
  mkdirSync(repo)
  sh(repo, 'init', '-q')
  writeFileSync(join(repo, 'a.mjs'), 'export const a = 1\n')
  sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'add', '.')
  sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'base')
  const base = sh(repo, 'rev-parse', 'HEAD')
  const corpusDir = fresh('corpus')
  const dir = join(corpusDir, lane)
  mkdirSync(dir, { recursive: true })
  const originalTask = `/orig/crew/${lane}/task`, originalTree = `/orig/dev/${lane}`
  const put = (name, value) => writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  put('manifest.json', { lane, base, originalTask, originalTree })
  put('plan.md', `plan at ${originalTask} for ${originalTree}\n`)
  put('gate.mjs', `// gate in ${originalTask}\nprocess.exitCode = 1\n`)
  put('lean.json', { taskDir: originalTask, cwd: originalTree })
  put('planner-1.json', { role: 'planner', status: 'done', details: { acceptance: ['X1'], mutations: [{ check: 'X1' }], plan_path: `${originalTask}/plan.md:1-2` } })
  put('brief.md', '# brief\n')
  put('builder-prompt.txt', `You are the lean builder. Task directory: ${originalTask}\nCheckout: ${originalTree}\nReturn path: ${originalTask}/builder-2.json\n`)
  put('planner-prompt.txt', `You are the lean planner. Task directory: ${originalTask}\nCheckout: ${originalTree}\nReturn path: ${originalTask}/planner-1.json\n`)
  return { repo, corpusDir, base, deps: { corpusDir, repoDir: repo, home: fresh('home'), sleepMs: () => {} } }
}
const worktrees = (repo) => sh(repo, 'worktree', 'list').split('\n').length

test('builder replay: prompt rewrite, backfills, checks, diff with additions and cleanup', async () => {
  const fx = fixture()
  writeFileSync(join(fx.repo, 'old.test.mjs'), '// tracked test to delete\n')
  sh(fx.repo, 'add', 'old.test.mjs')
  sh(fx.repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'tracked test')
  const manifestPath = join(fx.corpusDir, 'b1380', 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify({ ...json(manifestPath), base: sh(fx.repo, 'rev-parse', 'HEAD') }, null, 2))
  const before = readdirSync(join(fx.corpusDir, 'b1380')).map((f) => [f, readFileSync(join(fx.corpusDir, 'b1380', f), 'utf8')])
  const seen = {}
  const out = fresh('build')
  const result = await runBuilder({ lane: 'b1380', cell: { ...CELL, advisor: { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'medium' }, wait_s: 60, settle_s: 0 }, arms: ['fff', 'readgate'], out }, {
    ...fx.deps,
    runAcpSeat(call) {
      Object.assign(seen, call)
      writeFileSync(join(call.cwd, 'a.mjs'), 'export const a = 2\n')
      writeFileSync(join(call.cwd, 'new.test.mjs'), "import test from 'node:test'\ntest('ok', () => {})\n")
      rmSync(join(call.cwd, 'old.test.mjs'))
      writeFileSync(join(call.taskDir, 'builder-2.json'), JSON.stringify({ status: 'done', summary: 'built' }))
      return { stopReason: 'end_turn', usage: { in: 1 } }
    },
    runGate: async ({ cwd, gatePath }) => { assert(existsSync(join(cwd, 'a.mjs'))); assert(gatePath.startsWith(out)); return { status: 'green', failingIds: [] } },
    proveMutations: async ({ checks, mutations }) => { assert.deepEqual(checks, ['X1']); assert.equal(mutations.length, 1); return { status: 'ok', rows: [{ check: 'X1', outcome: 'killed' }] } },
  })
  assert.equal(result.error, null)
  assert.deepEqual(seen.definition, { role: 'builder', ...CELL, writes: 'repo', wait_s: 60, advisor: { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'medium' }, skills: [], codemode: false, extensions: ['fff', 'readgate'] })
  assert(!seen.prompt.includes('/orig/'))
  assert(seen.prompt.includes(join(out, 'task', 'builder-2.json')) && seen.prompt.includes(join(out, 'tree')))
  const ret = json(join(out, 'task', 'planner-1.json'))
  assert.deepEqual(ret.details.files_in_scope, ['crew/loop.mjs', 'crew/loop.test.mjs'])
  assert.equal(ret.details.validation_lane, 'node --test crew/loop.test.mjs')
  assert.equal(ret.details.gate_cmd, `node ${join(out, 'task', 'gate.mjs')}`)
  assert(!readFileSync(join(out, 'task', 'plan.md'), 'utf8').includes('/orig/'))
  assert.equal(result.mutations.killed, 1)
  assert.deepEqual(result.changed.sort(), ['a.mjs', 'new.test.mjs', 'old.test.mjs'])
  // MUTATION: omit added totals from gate-variant results.
  assert.deepEqual(json(join(out, 'result.json')).added, { source: 1, test: 2, binary: 0 })
  assert.deepEqual(result.targeted, { files: 1, pass: 1, fail: 0, status: 0 })
  assert.equal(result.envelope.summary, 'built')
  const diff = readFileSync(join(out, 'diff.patch'), 'utf8')
  assert(diff.includes('+export const a = 2') && diff.includes('new.test.mjs'))
  assert.match(diff, /diff --git a\/old\.test\.mjs b\/old\.test\.mjs\ndeleted file mode/)
  assert(!existsSync(join(out, 'tree')))
  assert.equal(worktrees(fx.repo), 1)
  assert.deepEqual(readdirSync(join(fx.corpusDir, 'b1380')).map((f) => [f, readFileSync(join(fx.corpusDir, 'b1380', f), 'utf8')]), before)
  assert.deepEqual(json(join(out, 'result.json')).arms, ['fff', 'readgate'])
})

test('builder replay: seat, check and cleanup failures are recorded and the worktree goes', async () => {
  const fx = fixture('b1402')
  const out = fresh('fail')
  const result = await runBuilder({ lane: 'b1402', cell: CELL, arms: [], out }, {
    ...fx.deps,
    runAcpSeat: () => { throw Object.assign(new Error('seat down'), { code: 'ACP_X' }) },
    runGate: async () => { throw new Error('gate exploded') },
    proveMutations: async () => { throw new Error('unreachable') },
  })
  assert.match(result.error, /seat: ACP_X seat down/)
  assert.match(result.error, /gate: gate exploded/)
  assert.equal(result.gate, null)
  assert.match(json(join(out, 'result.json')).error, /seat down/)
  assert(existsSync(join(out, 'session.jsonl')) && existsSync(join(out, 'diff.patch')))
  assert.equal(worktrees(fx.repo), 1)
  const ret = json(join(out, 'task', 'planner-1.json'))
  assert.equal(ret.details.files_in_scope, undefined)
})

test('unmeasured check results returned by the crew APIs are recorded as errors with their diagnostics', async () => {
  const { runGate, proveMutations } = await import('../crew/checks.mjs')
  const unmeasuredGate = await runGate({ cwd: '', gatePath: '' }) // the real API's returned shape, not a throw
  assert.equal(unmeasuredGate.status, 'unmeasured')
  const unmeasuredProof = await proveMutations({ cwd: '' })
  assert.equal(unmeasuredProof.status, 'unmeasured')
  const copyFailed = { status: 'unmeasured', reason: 'copy-failed', rows: [], error: { code: 'ENOSPC', message: 'disk full' } }
  const seat = (call) => { writeFileSync(join(call.taskDir, 'builder-2.json'), JSON.stringify({ status: 'done', summary: 'x' })); return { stopReason: 'end_turn' } }

  let fx = fixture()
  let result = await runBuilder({ lane: 'b1380', cell: CELL, arms: [], out: fresh('un') }, { ...fx.deps, runAcpSeat: seat, runGate: async () => ({ ...unmeasuredGate, reason: 'timeout' }), proveMutations: async () => { throw new Error('must not run') } })
  assert.match(result.error, /gate: unmeasured timeout/)
  assert.equal(result.gate.status, 'unmeasured')

  fx = fixture()
  const out = fresh('un')
  result = await runBuilder({ lane: 'b1380', cell: CELL, arms: [], out }, { ...fx.deps, runAcpSeat: seat, runGate: async () => ({ status: 'green', reason: null, failingIds: [] }), proveMutations: async () => copyFailed })
  assert.match(result.error, /mutations: unmeasured copy-failed \(ENOSPC disk full\)/)
  assert.match(json(join(out, 'result.json')).error, /ENOSPC disk full/)
  assert.equal(result.mutations.diagnostics.error, 'ENOSPC disk full')

  fx = fixture()
  result = await runBuilder({ lane: 'b1380', cell: CELL, arms: [], out: fresh('un') }, { ...fx.deps, runAcpSeat: seat, runGate: async () => ({ status: 'green', reason: null, failingIds: [] }), proveMutations: async () => ({ status: 'unmeasured', reason: 'mutation-unmeasured', rows: [{ check: 'X1', outcome: 'unmeasured', reason: 'bind-fail' }] }) })
  assert.match(result.error, /X1:bind-fail/)

  // ordinary measured red results are not harness errors
  fx = fixture()
  result = await runBuilder({ lane: 'b1380', cell: CELL, arms: [], out: fresh('un') }, { ...fx.deps, runAcpSeat: seat, runGate: async () => ({ status: 'red', reason: 'exit-nonzero', failingIds: ['X1'] }), proveMutations: async () => { throw new Error('must not run') } })
  assert.equal(result.error, null)
  fx = fixture()
  result = await runBuilder({ lane: 'b1380', cell: CELL, arms: [], out: fresh('un') }, { ...fx.deps, runAcpSeat: seat, runGate: async () => ({ status: 'green', reason: null, failingIds: [] }), proveMutations: async () => ({ status: 'red', reason: 'mutations-survived', rows: [{ check: 'X1', outcome: 'survived' }] }) })
  assert.equal(result.error, null)

  fx = fixture()
  const pout = fresh('un')
  result = await runPlanner({ lane: 'b1380', cell: CELL, arms: [], out: pout }, {
    ...fx.deps,
    runAcpSeat(call) {
      writeFileSync(join(call.taskDir, 'plan.md'), '# plan\n')
      writeFileSync(join(call.taskDir, 'gate.mjs'), 'x\n')
      writeFileSync(join(call.taskDir, 'planner-1.json'), JSON.stringify({ status: 'done', summary: 'p', details: {} }))
      return { stopReason: 'end_turn' }
    },
    runGate: async () => ({ ...unmeasuredGate, reason: 'spawn-error', error: { code: 'ENOENT', message: 'no node' } }),
  })
  assert.match(result.error, /gate: unmeasured spawn-error \(ENOENT no node\)/)
  assert.equal(result.gate.baseline, 'unmeasured')
  assert.equal(result.gate.reason, 'spawn-error')
  assert.equal(result.gate.error, 'ENOENT no node')
})

test('a returned refusal or a turn with no stop reason is a recorded failure', async () => {
  for (const [turn, expect] of [[{ refusal: { code: 'auth', message: 'not logged in' }, stopReason: null }, /seat refused auth: not logged in/], [{}, /no stop reason/], [null, /no stop reason/]]) {
    for (const [name, run] of [['builder', runBuilder], ['planner', runPlanner]]) {
      const fx = fixture()
      const out = fresh(name)
      const result = await run({ lane: 'b1380', cell: CELL, arms: [], out }, { ...fx.deps, runAcpSeat: () => turn, runGate: async () => ({ status: 'red', failingIds: [] }) })
      assert.match(result.error, expect)
      assert.match(json(join(out, 'result.json')).error, expect)
      assert.equal(worktrees(fx.repo), 1)
    }
  }
})

test('a missing or malformed cell file is recorded in result.json by both CLIs', () => {
  const bad = join(scratch, 'bad-cell.json')
  writeFileSync(bad, '{not json')
  for (const script of ['replay-builder.mjs', 'replay-planner.mjs']) {
    for (const cellFile of [bad, join(scratch, 'no-such-cell.json')]) {
      const out = fresh('cli-cell')
      const r = spawnSync(process.execPath, [join(CHECKOUT, 'bench', script), '--lane', 'b1380', '--cell', cellFile, '--arms', '', '--out', out], { encoding: 'utf8' })
      assert.equal(r.status, 1, r.stderr)
      assert.match(json(join(out, 'result.json')).error, /cell file/)
      assert(existsSync(join(out, 'session.jsonl')) && existsSync(join(out, 'diff.patch')))
      assert(!existsSync(join(out, 'tree')))
    }
  }
})

test('a red gate skips the mutation proof', async () => {
  const fx = fixture()
  const result = await runBuilder({ lane: 'b1380', cell: CELL, arms: [], out: fresh('red') }, {
    ...fx.deps, runAcpSeat: (c) => { writeFileSync(join(c.taskDir, 'builder-2.json'), JSON.stringify({ status: 'done', summary: 'x' })); return { stopReason: 'end_turn' } }, runGate: async () => ({ status: 'red', failingIds: ['X1'] }),
    proveMutations: async () => { throw new Error('must not run') },
  })
  assert.equal(result.error, null)
  assert.deepEqual(result.gate.failing, ['X1'])
  assert.equal(result.mutations, null)
})

test('a failure after the worktree exists still removes it', async () => {
  const fx = fixture()
  writeFileSync(join(fx.corpusDir, 'b1380', 'builder-prompt.txt'), 'You are the lean builder. no return file named here\n')
  const out = fresh('late')
  let seats = 0
  const result = await runBuilder({ lane: 'b1380', cell: CELL, arms: [], out }, { ...fx.deps, runAcpSeat: () => { seats++ } })
  assert.match(result.error, /names no return file/)
  assert.equal(seats, 0)
  assert(!existsSync(join(out, 'tree')))
  assert.equal(worktrees(fx.repo), 1)
})

test('planner replay: fresh task dir, baseline gate, repo writes, gate path confined', async () => {
  const fx = fixture('b1381')
  const out = fresh('plan')
  let seen
  const gates = []
  const result = await runPlanner({ lane: 'b1381', cell: CELL, arms: ['subagent'], out }, {
    ...fx.deps,
    runAcpSeat(call) {
      seen = call
      writeFileSync(join(call.taskDir, 'plan.md'), '# plan\n')
      writeFileSync(join(call.taskDir, 'gate.mjs'), 'process.exitCode = 1\n')
      writeFileSync(join(call.cwd, 'stray.txt'), 'x')
      writeFileSync(join(call.taskDir, 'planner-1.json'), JSON.stringify({ status: 'done', summary: 'planned', details: { acceptance: ['X1'], mutations: [1, 2], gate_path: '/etc/hosts' } }))
      return { stopReason: 'end_turn' }
    },
    runGate: async ({ gatePath }) => { gates.push(gatePath); return { status: 'red', failingIds: ['X1'] } },
  })
  assert.equal(result.error, null)
  assert.equal(seen.definition.writes, 'task-dir')
  assert.deepEqual(seen.definition.extensions, ['subagent'])
  assert(!seen.prompt.includes('/orig/'))
  assert.equal(readFileSync(join(out, 'task', 'plan.md'), 'utf8'), '# plan\n', 'planner must not get the recorded solution')
  assert.deepEqual(gates, [join(out, 'task', 'gate.mjs')])
  assert.equal(result.repo_writes, 1)
  assert.equal(result.gate.baseline, 'red')
  assert.deepEqual(result.gate.failing, ['X1'])
  assert.equal(result.envelope.mutations, 2)
  assert(!existsSync(join(out, 'tree')))
  assert.equal(worktrees(fx.repo), 1)
})

test('planner memory appends the rendered section and persists accounting; empty stores refuse the seat', async () => {
  const fx = fixture()
  const memory = fresh('memory')
  mkdirSync(memory)
  writeFileSync(join(memory, 'MEMORY.md'), '- [alpha](alpha.md)\n- [missing](missing.md)\n')
  writeFileSync(join(memory, 'alpha.md'), 'Team judgment\n')
  const extract = openMemory({ dir: memory }).context({ task: '# brief\n', role: 'planner' })
  assert.deepEqual(extract.included.map((entry) => entry.path), ['MEMORY.md', 'alpha.md'])
  assert.deepEqual(extract.dropped.map((entry) => entry.path), ['missing.md'])
  for (const dir of [undefined, memory]) {
    const out = fresh('memory-plan')
    let prompt
    const result = await runPlanner({ lane: 'b1380', cell: CELL, arms: [], out, ...(dir ? { memory: dir } : {}) }, {
      ...fx.deps,
      runAcpSeat(call) {
        prompt = call.prompt
        writeFileSync(join(call.taskDir, 'plan.md'), '# plan\n')
        writeFileSync(join(call.taskDir, 'gate.mjs'), 'x\n')
        writeFileSync(join(call.taskDir, 'planner-1.json'), JSON.stringify({ status: 'done', summary: 'planned' }))
        return { stopReason: 'end_turn' }
      },
      runGate: async () => ({ status: 'red', failingIds: [] }),
    })
    const original = `You are the lean planner. Task directory: ${join(out, 'task')}\nCheckout: ${join(out, 'tree')}\nReturn path: ${join(out, 'task', 'planner-1.json')}\n`
    assert.equal(prompt, original + (dir ? `\n\n${renderSection(extract)}` : ''))
    assert.equal(result.error, null)
    assert.deepEqual(json(join(out, 'result.json')).memory, dir ? { dir, included: extract.included, dropped: extract.dropped, bytes: extract.bytes, reason: extract.reason } : undefined)
    assert.equal(worktrees(fx.repo), 1)
  }
  const empty = fresh('empty-memory')
  mkdirSync(empty)
  const out = fresh('empty-plan')
  let seats = 0
  const result = await runPlanner({ lane: 'b1380', cell: CELL, arms: [], out, memory: empty }, { ...fx.deps, runAcpSeat: () => { seats++ } })
  assert.match(result.error, /memory.*no-index/)
  assert.equal(json(join(out, 'result.json')).error, result.error)
  assert.equal(seats, 0)
  assert(!existsSync(join(out, 'tree')))
  assert.equal(worktrees(fx.repo), 1)
})

const charterDefinition = '---\nname: test-planner\ndescription: fixture\nrole: planner\nagent: claude\nmodel: example/model\neffort: low\n---\n\nReplacement Ω\n  \n'
const recordedSuffix = 'Definition source: /old/planner.md\r\n\r\n## Brief\nLane Ω\nDefinition source: later\nReturn path: /orig/crew/b1380/task/planner-1.json\nCheckout: /orig/dev/b1380\n  \n'

function charterFixture() {
  const fx = fixture()
  const charter = fresh('charter')
  writeFileSync(charter, charterDefinition)
  writeFileSync(join(fx.corpusDir, 'b1380', 'planner-prompt.txt'), 'Old charter\n\n' + recordedSuffix)
  return { ...fx, charter }
}

async function captureCharter(fx, options = {}) {
  const out = fresh('charter-run')
  let call
  const result = await runPlanner({ lane: 'b1380', cell: CELL, arms: [], out, ...options }, {
    ...fx.deps,
    runAcpSeat(c) {
      call = c
      writeFileSync(join(c.taskDir, 'plan.md'), '# plan\n')
      writeFileSync(join(c.taskDir, 'gate.mjs'), 'x\n')
      writeFileSync(join(c.taskDir, 'planner-1.json'), JSON.stringify({ status: 'done', summary: 'ok' }))
      return { stopReason: 'end_turn' }
    },
    runGate: async () => ({ status: 'red' }),
  })
  return { out, result, call }
}

// MUTATION: CS1 replaces the charter body with a wrong charter.
test('CS1 planner charter body, CLI, validation and memory', async () => {
  const fx = charterFixture()
  const args = ['--lane', 'b1380', '--cell', 'cell.json', '--arms', '', '--out', '/tmp/out']
  assert.equal(parseCli([...args, '--charter', fx.charter], { allowCharter: true }).charter, fx.charter)
  for (const value of [[], ['--lane'], ['-x'], ['']]) assert.throws(() => parseCli([...args, '--charter', ...value], { allowCharter: true }), /needs a value/)
  assert.throws(() => parseCli([...args, '--charter', fx.charter]), /unknown argument/)
  const cellFile = fresh('cell'); writeFileSync(cellFile, JSON.stringify(CELL))
  const cliOut = fresh('cli-charter')
  const cli = spawnSync(process.execPath, [join(CHECKOUT, 'bench/replay-planner.mjs'), '--lane', 'b1380', '--cell', cellFile, '--arms', 'bad', '--out', cliOut, '--charter', fx.charter], { encoding: 'utf8' })
  assert.equal(cli.status, 1)
  assert.equal(json(join(cliOut, 'result.json')).charter, fx.charter)
  const builderOut = fresh('builder-charter')
  const builder = spawnSync(process.execPath, [join(CHECKOUT, 'bench/replay-builder.mjs'), '--lane', 'b1380', '--cell', cellFile, '--arms', 'bad', '--out', builderOut, '--charter', fx.charter], { encoding: 'utf8' })
  assert.equal(builder.status, 1)
  assert.equal(json(join(builderOut, 'result.json')).charter, fx.charter)
  assert.throws(() => parseCli([...args, '--build-first'], { allowCharter: true }), /unknown argument/)
  const memory = fresh('charter-memory'); mkdirSync(memory)
  writeFileSync(join(memory, 'MEMORY.md'), '- [alpha](alpha.md)\n')
  writeFileSync(join(memory, 'alpha.md'), 'Team judgment\n')
  const { out, result, call } = await captureCharter(fx, { charter: fx.charter, memory })
  assert.equal(result.error, null)
  assert.equal(json(join(out, 'result.json')).charter, fx.charter)
  assert(call.prompt.startsWith(parseAgent(charterDefinition).body + '\n\nDefinition source:'))
  assert(!call.prompt.includes('Old charter') && !call.prompt.includes('name: test-planner'))
  assert.equal(call.definition.model, CELL.model)
  assert.equal(call.definition.agent, CELL.agent)
  assert(call.prompt.endsWith('\n\n' + renderSection(openMemory({ dir: memory }).context({ task: '# brief\n', role: 'planner' }))))
  const ordinary = await captureCharter(fx)
  assert.equal(ordinary.result.error, null)
  assert.equal(json(join(ordinary.out, 'result.json')).charter, null)
  assert(ordinary.call.prompt.startsWith('Old charter\n\n'))
  for (const content of [null, 'bad definition', charterDefinition.replace('effort: low', 'effort: impossible')]) {
    const file = fresh('invalid-charter')
    if (content !== null) writeFileSync(file, content)
    const rejected = await runPlanner({ lane: 'b1380', cell: CELL, arms: [], out: fresh(), charter: file }, { ...fx.deps, repoDir: '/no/such/repo', runAcpSeat: () => assert.fail('seat called') })
    assert.match(rejected.error, content === null ? /ENOENT/ : /invalid charter/)
  }
})

// MUTATION: CS2 trims the recorded suffix.
test('CS2 preserves the complete recorded suffix apart from path rebasing', async () => {
  const fx = charterFixture()
  const { out, result, call } = await captureCharter(fx, { charter: fx.charter })
  assert.equal(result.error, null)
  const prefix = parseAgent(charterDefinition).body + '\n\n'
  assert(call.prompt.startsWith(prefix))
  assert.equal(call.prompt.slice(prefix.length), recordedSuffix.replaceAll('/orig/crew/b1380/task', join(out, 'task')).replaceAll('/orig/dev/b1380', join(out, 'tree')))
})

// MUTATION: CS3 disables the missing-marker refusal.
test('CS3 refuses a missing source line before worktree creation', async () => {
  const fx = charterFixture()
  writeFileSync(join(fx.corpusDir, 'b1380', 'planner-prompt.txt'), 'No marker\nReturn path: planner-1.json\n')
  const out = fresh()
  let seats = 0
  const result = await runPlanner({ lane: 'b1380', cell: CELL, arms: [], out, charter: fx.charter }, { ...fx.deps, repoDir: '/no/such/repo', runAcpSeat: () => { seats++ } })
  assert.match(result.error, /no Definition source: line/)
  assert.equal(seats, 0)
  assert(!existsSync(join(out, 'task')))
})

test('memory CLI option is planner-only and requires a value', () => {
  const args = ['--lane', 'b1380', '--cell', 'cell.json', '--arms', '', '--out', '/tmp/out']
  assert.equal(parseCli([...args, '--memory', '/tmp/store'], { allowMemory: true }).memory, '/tmp/store')
  assert.throws(() => parseCli([...args, '--memory'], { allowMemory: true }), /needs a value/)
  assert.throws(() => parseCli(['--memory', '--lane', ...args], { allowMemory: true }), /needs a value/)
  assert.throws(() => parseCli([...args, '--memory', '/tmp/store']), /unknown argument/)
  const builder = spawnSync(process.execPath, [join(CHECKOUT, 'bench/replay-builder.mjs'), ...args, '--memory', '/tmp/store'], { encoding: 'utf8' })
  assert.equal(builder.status, 2)
  assert.match(builder.stderr, /unknown argument --memory/)
})

test('a turn that ends without its required artifacts is a recorded failure', async () => {
  const good = { status: 'done', summary: 'ok' }
  const builderCases = [
    ['missing envelope', () => {}, /envelope: builder-2\.json not written/],
    ['malformed envelope', (c) => writeFileSync(join(c.taskDir, 'builder-2.json'), '{nope'), /builder-2\.json is not valid JSON/],
    ['non-object envelope', (c) => writeFileSync(join(c.taskDir, 'builder-2.json'), '[1]'), /not a JSON object/],
    ['envelope without summary', (c) => writeFileSync(join(c.taskDir, 'builder-2.json'), JSON.stringify({ status: 'done' })), /lacks a status and summary/],
  ]
  for (const [label, write, expect] of builderCases) {
    const fx = fixture()
    const out = fresh('art')
    const result = await runBuilder({ lane: 'b1380', cell: CELL, arms: [], out }, { ...fx.deps, runAcpSeat: (c) => { write(c); return { stopReason: 'end_turn' } }, runGate: async () => ({ status: 'red', failingIds: [] }) })
    assert.match(result.error, expect, label)
    assert.match(json(join(out, 'result.json')).error, expect, label)
    assert.equal(result.envelope, null)
  }
  const plannerCases = [
    ['missing envelope', (c) => { writeFileSync(join(c.taskDir, 'plan.md'), '# p\n'); writeFileSync(join(c.taskDir, 'gate.mjs'), 'x\n') }, /envelope: planner-1\.json not written/],
    ['malformed envelope', (c) => { writeFileSync(join(c.taskDir, 'plan.md'), '# p\n'); writeFileSync(join(c.taskDir, 'gate.mjs'), 'x\n'); writeFileSync(join(c.taskDir, 'planner-1.json'), 'oops') }, /not valid JSON/],
    ['missing plan', (c) => { writeFileSync(join(c.taskDir, 'gate.mjs'), 'x\n'); writeFileSync(join(c.taskDir, 'planner-1.json'), JSON.stringify(good)) }, /planner: plan\.md not written/],
    ['missing gate', (c) => { writeFileSync(join(c.taskDir, 'plan.md'), '# p\n'); writeFileSync(join(c.taskDir, 'planner-1.json'), JSON.stringify(good)) }, /planner: gate\.mjs not written/],
  ]
  for (const [label, write, expect] of plannerCases) {
    const fx = fixture()
    const out = fresh('art')
    const result = await runPlanner({ lane: 'b1380', cell: CELL, arms: [], out }, { ...fx.deps, runAcpSeat: (c) => { write(c); return { stopReason: 'end_turn' } }, runGate: async () => ({ status: 'red', failingIds: [] }) })
    assert.match(result.error, expect, label)
    assert.match(json(join(out, 'result.json')).error, expect, label)
    assert.equal(worktrees(fx.repo), 1)
  }
})

test('importing the replay modules starts nothing', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./replay-builder.mjs', import.meta.url).href)}); await import(${JSON.stringify(new URL('./replay-planner.mjs', import.meta.url).href)})`], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '')
  assert.equal(realpathSync(CHECKOUT), realpathSync(join(CORPUS_DIR, '..', '..')))
})

test('writeDiff captures staged edits, staged additions and unstaged edits, and fails loudly outside a repo', () => {
  const repo = fresh('diffrepo')
  mkdirSync(repo, { recursive: true })
  sh(repo, 'init', '-q')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  writeFileSync(join(repo, 'b.txt'), 'b\n')
  sh(repo, 'add', '.')
  sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init')
  writeFileSync(join(repo, 'a.txt'), 'a-staged\n')
  sh(repo, 'add', 'a.txt')
  writeFileSync(join(repo, 'new-staged.txt'), 'staged-new\n')
  sh(repo, 'add', 'new-staged.txt')
  writeFileSync(join(repo, 'b.txt'), 'b-unstaged\n')
  writeFileSync(join(repo, 'untracked.txt'), 'untracked\n')
  const file = join(scratch, 'diff-out.patch')
  writeDiff(repo, file)
  const patch = readFileSync(file, 'utf8')
  for (const needle of ['a-staged', 'staged-new', 'b-unstaged', 'untracked']) assert(patch.includes(needle), needle)
  assert.throws(() => writeDiff(scratch, join(scratch, 'never.patch')), /git .* failed/)
})
