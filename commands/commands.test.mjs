// A command is a thin entry point: it names the skill that owns the procedure
// and passes its argument through. This file pins BOTH directions — every
// command names its skill, and no command body carries the procedure content.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from '../test/helpers.mjs'

const HERE = fileURLToPath(new URL('./', import.meta.url))
const SKILLS = join(ROOT, 'skills')

// command file -> the skills whose procedure it dispatches to
const DISPATCHES_TO = {
  'dispatch.md': ['crew-dispatch'],
  'close-out.md': ['crew-recovery'],
  'status.md': ['devops', 'crew-recovery'],
  'onboard.md': ['crew-onboard'],
  'review.md': ['pr-review'],
}
const TAKES_ARGUMENT = ['dispatch.md', 'close-out.md', 'onboard.md', 'review.md']

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

// Without this, a new command file escapes every assertion below: the suites
// iterate DISPATCHES_TO, so an unlisted command is not thin-checked, not
// argument-checked, and not skill-checked. The map must cover the directory.
test('every command on disk is covered by this file', () => {
  const onDisk = readdirSync(HERE).filter((name) => name.endsWith('.md')).sort()
  assert.deepEqual(onDisk, Object.keys(DISPATCHES_TO).sort(), 'add the command to DISPATCHES_TO, or it is tested by nothing')
})

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

// MUTATION RC1: point the review command back at the deleted pr-review module.
test('RC1', () => {
  const { front, body } = parts('review.md')
  assert.ok(frontValue(front, 'argument-hint')?.includes('<pull request number>'))
  assert.ok(frontValue(front, 'argument-hint')?.includes('--local'))
  assert.ok(body.includes('Use `/review 123`'))
  assert.ok(body.includes('`/review --local`'))
  assert.equal(body.includes('CLAUDE_PLUGIN_ROOT'), false, 'review.md runs no plugin script')
  assert.equal(body.includes('pr-review.mjs'), false)
  assert.match(body, /never post an approval/)
  // The review action itself: what is read, from which base, including uncommitted work.
  for (const phrase of ['.agents/skills/review-procedure/SKILL.md', '`gh pr diff <number>`', 'never from the local checkout', '`git show <head>:<path>`', '`git fetch origin pull/<number>/head <base>`', 'a file the PR deletes is read at its base', 'the first of `origin/main` and `main` that resolves', 'stop and ask for `--base`', 'if it prints no commit, stop and say the base is unrelated', '`git diff <merge base>`', 'every untracked file `git status --short --untracked-files=all` lists', 'Read each changed file in full']) assert.ok(body.includes(phrase), phrase)
  assert.equal(/do not read|report no findings/i.test(body), false)
})

test('the status command takes no argument', () => {
  const { front, body } = parts('status.md')
  assert.equal(frontValue(front, 'argument-hint'), null, 'status.md must declare no argument-hint')
  for (const placeholder of ['$ARGUMENTS', '$1', '$2']) {
    assert.ok(!body.includes(placeholder), `status.md must not reference ${placeholder}`)
  }
})

test('each command names exactly the skills it dispatches to', () => {
  for (const [name, wanted] of Object.entries(DISPATCHES_TO)) {
    const cited = [...citedSkills(parts(name).body)].sort()
    assert.deepEqual(cited, [...wanted].sort(), `${name} must name exactly ${wanted.join(', ')}`)
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
