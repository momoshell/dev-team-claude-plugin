// Check command frontmatter and that cited skills exist and declare their names.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from '../test/helpers.mjs'

const HERE = fileURLToPath(new URL('./', import.meta.url))
const SKILLS = join(ROOT, 'skills')

// command file -> the skills whose procedure it dispatches to
const DISPATCHES_TO = {
  'dispatch.md': ['lane-brief'],
  'close-out.md': ['crew-recovery'],
  'status.md': ['devops', 'crew-recovery'],
  'onboard.md': ['crew-onboard'],
  'review.md': ['pr-review'],
}

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
