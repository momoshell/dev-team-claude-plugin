import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { scratchDir } from './helpers.mjs'
import {
  extractSuiteCorpus,
  main,
  parseArgs,
  redactCorpusText,
  serializeCorpus,
  validateCorpusRows,
  verifyCorpus,
} from '../scripts/factory/extract-suite-corpus.mjs'

const DECISION_KEYS = ['lead', 'planner', 'builder', 'builder_spent']
const ROW_KEYS = ['id', 'role', 'source_stream', 'command', 'kind', 'decisions', 'selected_by']
const SAMPLE_PREFIXES = ['00', '01', '02', '03']

function bashFrame(command) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 'tool-test', name: 'Bash', input: { command } }],
    },
  })
}

function streamBody(...commands) {
  return commands.map((command) => bashFrame(command)).join('\n') + '\n'
}

function putStream(root, relativePath, body) {
  const path = join(root, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  return path
}

function putRoleRecord(root, relativeDirectory, role) {
  const path = join(root, relativeDirectory, 'cmd.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ return_file: `returns/d1.${role}.json` }))
  return path
}

function testSource(root) {
  const home = join(root, 'home')
  const sourceRoot = join(home, '.crew')
  mkdirSync(sourceRoot, { recursive: true })
  return { home, sourceRoot }
}

function digest(command) {
  return createHash('sha256').update(command, 'utf8').digest('hex')
}

function commandForPrefix(prefix, label = 'sample') {
  for (let index = 0; ; index += 1) {
    const command = `echo ${label}-${index}`
    if (digest(command).startsWith(prefix)) return command
  }
}

function commandOutsidePrefixes(label = 'nonsample') {
  for (let index = 0; ; index += 1) {
    const command = `echo ${label}-${index}`
    if (!SAMPLE_PREFIXES.some((prefix) => digest(command).startsWith(prefix))) return command
  }
}

function realIo() {
  return {
    readdir: (path, options) => readdirSync(path, options),
    readFile: (path, encoding) => readFileSync(path, encoding),
    exists: (path) => existsSync(path),
    writeFile: (path, text) => writeFileSync(path, text),
  }
}

function oneRecognised(root) {
  const { home, sourceRoot } = testSource(root)
  putStream(sourceRoot, 'headless-rpc/lead/stream.jsonl', streamBody('npm test'))
  return { home, sourceRoot, extraction: extractSuiteCorpus({ sourceRoot, home, extractedAt: '2026-09-08' }) }
}

test('A1 selection keeps recognised, sampled, duplicate, nonsampled, and unattributable evidence stable', () => {
  const root = scratchDir('corpus-a1-')
  const { home, sourceRoot } = testSource(root)
  const sampledCommand = commandForPrefix('00')
  const nonsampledCommand = commandOutsidePrefixes()
  putStream(sourceRoot, 'headless-rpc/builder/stream.jsonl', streamBody('npm test'))
  putStream(sourceRoot, 'lane/task/headless/d1/stream.jsonl', streamBody('npm test'))
  putRoleRecord(sourceRoot, 'lane/task/headless/d1', 'planner')
  putStream(sourceRoot, 'headless-rpc/reviewer/stream.jsonl', streamBody(sampledCommand))
  putStream(sourceRoot, 'headless-rpc/tech-lead/stream.jsonl', streamBody(nonsampledCommand))
  putStream(sourceRoot, 'unattributed/task/headless/d1/stream.jsonl', streamBody('echo unattributable'))

  const extraction = extractSuiteCorpus({ sourceRoot, home, extractedAt: '2026-09-08' })
  const expectedRecognised = {
    id: digest('npm test').slice(0, 12),
    role: 'builder',
    source_stream: '~/.crew/headless-rpc/builder/stream.jsonl',
    command: 'npm test',
    kind: 'suite',
    decisions: { lead: 'refuse', planner: 'admit', builder: 'admit', builder_spent: 'refuse' },
    selected_by: 'recognised',
  }
  const expectedSampled = {
    id: digest(sampledCommand).slice(0, 12),
    role: 'reviewer',
    source_stream: '~/.crew/headless-rpc/reviewer/stream.jsonl',
    command: sampledCommand,
    kind: null,
    decisions: { lead: 'unrecognised', planner: 'unrecognised', builder: 'unrecognised', builder_spent: 'unrecognised' },
    selected_by: 'sample',
  }
  assert.deepEqual(extraction.rows, [expectedRecognised, expectedSampled].sort((a, b) => (a.id < b.id ? -1 : 1)))
  assert.equal(extraction.header.streams_scanned, 5)
  assert.equal(extraction.header.streams_with_bash, 5)
  assert.equal(extraction.header.distinct_commands_recorded, 4)
  assert.equal(extraction.header.distinct_commands_redacted, 4)
  assert.equal(extraction.header.distinct_commands_with_role, 3)
  assert.equal(extraction.header.recognised_population, 1)
  assert.equal(extraction.header.unrecognised_population, 2)
  assert.equal(extraction.header.sample_count, 1)
  assert.equal(extraction.header.entries, 2)
  assert.deepEqual(extraction.header.stream_outcomes, {
    unreadable: { value: 0, drawn_from: 5 },
    unparseable: { value: 0, drawn_from: 5 },
    'role-less': { value: 1, drawn_from: 5 },
  })
  assert.equal(serializeCorpus({ header: extraction.header, rows: extraction.rows }), extraction.text)
  assert.equal(extraction.text, `${JSON.stringify(extraction.header)}\n${extraction.rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
})

test('B1 verdict validation refuses omission and generated rows carry every named decision', () => {
  const missing = {
    id: '000000000000',
    role: 'lead',
    source_stream: 'x/stream.jsonl',
    command: 'echo x',
    kind: null,
    selected_by: 'sample',
  }
  assert.throws(() => validateCorpusRows([missing]), /verdict-missing/)
  const root = scratchDir('corpus-b1-')
  const { extraction } = oneRecognised(root)
  assert.ok(extraction.rows.length > 0)
  assert.deepEqual(Object.keys(extraction.rows[0]), ROW_KEYS)
  assert.deepEqual(Object.keys(extraction.rows[0].decisions), DECISION_KEYS)
  for (const key of DECISION_KEYS) assert.ok(['admit', 'refuse', 'unrecognised'].includes(extraction.rows[0].decisions[key]))
})

test('C1 redaction replaces home, private temp, boundary temp, and var-folders forms exactly', () => {
  const root = scratchDir('corpus-c1-')
  const { home, sourceRoot } = testSource(root)
  const command = `npm test ${home}/project /private/tmp/claude-123 /tmp/claude-456 /var/folders/aa/bb/T/result`
  putStream(sourceRoot, 'headless-rpc/lead/stream.jsonl', streamBody(command))
  const extraction = extractSuiteCorpus({ sourceRoot, home, extractedAt: '2026-09-08' })
  const expected = `npm test ~/project /private/tmp/claude-UID /tmp/claude-UID /var/folders/TMP/result`
  assert.equal(redactCorpusText(command, { home }), expected)
  assert.equal(extraction.rows[0].command, expected)
  assert.equal(extraction.rows[0].source_stream, '~/.crew/headless-rpc/lead/stream.jsonl')
  assert.equal(extraction.text.includes(home), false)
  assert.equal(extraction.text.includes('/private/tmp/claude-123'), false)
  assert.equal(extraction.text.includes('/tmp/claude-456'), false)
  assert.equal(extraction.text.includes('/var/folders/aa/bb/T/'), false)
})

test('D1 outcome report counts unreadable, unparseable, and role-less streams with denominators', () => {
  const root = scratchDir('corpus-d1-')
  const { home, sourceRoot } = testSource(root)
  const unreadable = putStream(sourceRoot, 'headless-rpc/builder/stream.jsonl', streamBody('npm test'))
  putStream(sourceRoot, 'headless-rpc/lead/stream.jsonl', `${bashFrame('npm test')}\nnot-json\n`)
  putStream(sourceRoot, 'unattributed/task/headless/d1/stream.jsonl', streamBody('echo no-role'))
  const base = realIo()
  const io = {
    ...base,
    readFile: (path, encoding) => {
      if (path === unreadable) throw new Error('EPERM')
      return base.readFile(path, encoding)
    },
  }
  const extraction = extractSuiteCorpus({ sourceRoot, home, extractedAt: '2026-09-08', io })
  const expected = {
    unreadable: { value: 1, drawn_from: 3 },
    unparseable: { value: 1, drawn_from: 3 },
    'role-less': { value: 1, drawn_from: 3 },
  }
  assert.deepEqual(extraction.report.stream_outcomes, expected)
  assert.deepEqual(extraction.header.stream_outcomes, expected)
  assert.equal(extraction.header.streams_with_bash, 2)
})

test('E1 verification compares reachable rows without changing the scratch reference', () => {
  const root = scratchDir('corpus-e1-')
  const { home, sourceRoot, extraction } = oneRecognised(root)
  const referencePath = join(root, 'reference.jsonl')
  writeFileSync(referencePath, extraction.text)
  const before = createHash('sha256').update(readFileSync(referencePath)).digest('hex')
  let output = ''
  const sink = { write: (chunk) => { output += chunk } }
  const status = main(['--source-root', sourceRoot, '--reference', referencePath], {
    home,
    io: realIo(),
    stdout: sink,
    stderr: sink,
  })
  const after = createHash('sha256').update(readFileSync(referencePath)).digest('hex')
  assert.equal(status, 0)
  assert.equal(after, before)
  assert.match(output, /\"matched\":\{\"value\":1,\"drawn_from\":1\}/)
  assert.match(output, /\"divergent\":\{\"value\":0,\"drawn_from\":1\}/)
  assert.match(output, /\"invalid\":\{\"value\":0,\"drawn_from\":1\}/)
  assert.match(output, /\"unavailable\":\{\"value\":0,\"drawn_from\":1\}/)
})

test('F1 unavailable references are absent with a reason and retain their denominator', () => {
  const root = scratchDir('corpus-f1-')
  const { home, sourceRoot, extraction } = oneRecognised(root)
  const referencePath = join(root, 'reference.jsonl')
  const missingRow = { ...extraction.rows[0], source_stream: '~/.crew/missing/deep/stream.jsonl' }
  writeFileSync(referencePath, serializeCorpus({ header: extraction.header, rows: [missingRow] }))
  const verification = verifyCorpus({ referencePath, extraction })
  assert.equal(verification.report.unavailable.value, null)
  assert.match(verification.report.unavailable.absent_reason, /unavailable/)
  assert.equal(verification.report.unavailable.drawn_from, 1)
  assert.deepEqual(verification.report.unavailable_count, { value: 1, drawn_from: 1 })
  assert.equal(verification.report.unavailable_rows[0].population.value, null)
  assert.equal(verification.report.unavailable_rows[0].population.drawn_from, 1)
  assert.ok(extraction.report.entries.drawn_from > 0)
})

test('argument parsing refuses unknown flags without performing discovery', () => {
  assert.throws(() => parseArgs(['--unknown']), /argument-invalid/)
  assert.deepEqual(parseArgs(['--source-root', '/tmp/source', '--reference', '/tmp/ref', '--out', '/tmp/out', '--date', '2026-09-08']), {
    sourceRoot: '/tmp/source',
    referencePath: '/tmp/ref',
    outPath: '/tmp/out',
    date: '2026-09-08',
  })
})
