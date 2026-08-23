// A command is a thin entry point: it names the skill that owns the procedure
// and passes its argument through. This file pins BOTH directions — every
// command names its skill, and no command body carries the procedure content.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('./', import.meta.url))
const REPO = fileURLToPath(new URL('../', import.meta.url))
const SKILLS = join(REPO, 'skills')

// command file -> the skills whose procedure it dispatches to
const DISPATCHES_TO = {
  'dispatch.md': ['crew-dispatch'],
  'close-out.md': ['crew-recovery'],
  'status.md': ['devops', 'crew-recovery'],
}
const TAKES_ARGUMENT = ['dispatch.md', 'close-out.md']

// Procedure content the skills own. A command repeating any of these has
// stopped being thin, and a single edit no longer keeps both surfaces true.
const PROCEDURE_TOKENS = [
  '--fences',
  '--tier',
  '--validation-lane',
  'KNOWN_FLAGS',
  'crew.mjs teardown',
  'cp -a',
  '.archive-',
  'git worktree remove',
  '--body-file',
]

// Reporting is safe at any moment only while the status command authorizes no
// mutation.
const MUTATING_TOKENS = ['teardown', 'push', 'commit', 'boot', 'kill', 'delete']

function parts(name) {
  const path = join(HERE, name)
  assert.ok(existsSync(path), `${name} must exist`)
  const text = readFileSync(path, 'utf8')
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  assert.ok(match, `${name} must open with a frontmatter block`)
  return { front: match[1], body: match[2] }
}

function frontValue(front, key) {
  const line = front.split(/\r?\n/).find((l) => l.startsWith(`${key}:`))
  return line ? line.slice(key.length + 1).trim() : null
}

function citedSkills(body) {
  return new Set([...body.matchAll(/`([a-z][a-z0-9-]*)`\s+skill/g)].map(([, name]) => name))
}

test('every command carries the frontmatter Claude Code reads', () => {
  for (const name of Object.keys(DISPATCHES_TO)) {
    const { front, body } = parts(name)
    assert.ok(frontValue(front, 'description'), `${name} must declare a description`)
    assert.ok(body.trim().length > 0, `${name} must have a body`)
  }
})

test('argument-taking commands declare a hint and pass the argument through', () => {
  for (const name of TAKES_ARGUMENT) {
    const { front, body } = parts(name)
    assert.ok(frontValue(front, 'argument-hint'), `${name} must declare an argument-hint`)
    assert.ok(body.includes('$ARGUMENTS'), `${name} must pass $ARGUMENTS through`)
  }
})

test('the status command takes no argument', () => {
  const { front, body } = parts('status.md')
  assert.equal(frontValue(front, 'argument-hint'), null, 'status.md must declare no argument-hint')
  for (const placeholder of ['$ARGUMENTS', '$1', '$2']) {
    assert.ok(!body.includes(placeholder), `status.md must not reference ${placeholder}`)
  }
})

test('each command names the skill it dispatches to', () => {
  for (const [name, wanted] of Object.entries(DISPATCHES_TO)) {
    const cited = citedSkills(parts(name).body)
    for (const skill of wanted) assert.ok(cited.has(skill), `${name} must name the ${skill} skill`)
  }
})

test('every skill a command names exists and declares that name', () => {
  for (const name of Object.keys(DISPATCHES_TO)) {
    for (const skill of citedSkills(parts(name).body)) {
      const path = join(SKILLS, skill, 'SKILL.md')
      assert.ok(existsSync(path), `${name} names ${skill}, which has no SKILL.md`)
      const front = readFileSync(path, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
      assert.equal(frontValue(front, 'name'), skill, `${path} must declare name: ${skill}`)
    }
  }
})

test('no command body restates procedure content the skills own', () => {
  for (const name of Object.keys(DISPATCHES_TO)) {
    const { front, body } = parts(name)
    for (const token of PROCEDURE_TOKENS) {
      assert.ok(!body.includes(token), `${name} must not restate ${token}`)
      assert.ok(!front.includes(token), `${name} frontmatter must not restate ${token}`)
    }
  }
})

test('the procedure tokens are content the skills actually own', () => {
  const corpus = ['crew-dispatch', 'crew-recovery', 'devops']
    .flatMap((skill) => [join(SKILLS, skill, 'SKILL.md')])
    .map((path) => readFileSync(path, 'utf8'))
    .concat(
      ['crew-dispatch/references/flags.md', 'crew-recovery/references/closeout.md', 'devops/references/worktrees.md', 'devops/references/gh.md']
        .map((rel) => readFileSync(join(SKILLS, rel), 'utf8')),
    )
    .join('\n')
  for (const token of PROCEDURE_TOKENS) {
    assert.ok(corpus.includes(token), `${token} must be skill-owned content, or it is a vacuous ban`)
  }
})

test('the status command authorizes no mutation', () => {
  const { front, body } = parts('status.md')
  const text = `${front}\n${body}`.toLowerCase()
  for (const token of MUTATING_TOKENS) {
    // Whole words only: "skills" contains "kill".
    assert.doesNotMatch(text, new RegExp(`\\b${token}\\b`), `status.md must not authorize ${token}`)
  }
  assert.match(text, /read-only/, 'status.md must say it is read-only')
})
