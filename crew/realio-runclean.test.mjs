import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realIo } from './realio.mjs'

const CONTENT = Object.freeze({
  committed: 'committed tracked content\n',
  dirty: 'dirty tracked content\n',
  untracked: 'untracked content\n',
  ignored: 'ignored secret content\n',
  node: 'node package content\n',
})

function git(repoDir, ...args) {
  return execFileSync('git', [
    '-c', 'user.email=crew@example.invalid',
    '-c', 'user.name=Crew Test',
    '-C', repoDir, ...args,
  ], { encoding: 'utf8' })
}

function makeRepo({ dirty = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'crew-run-clean-'))
  const repoDir = join(root, 'repo')
  mkdirSync(repoDir)
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir)
  mkdirSync(paths.returnsDir)

  git(repoDir, 'init')
  writeFileSync(join(repoDir, '.gitignore'), 'ignored/\nnode_modules/\n')
  writeFileSync(join(repoDir, 'tracked.txt'), CONTENT.committed)
  git(repoDir, 'add', '.gitignore', 'tracked.txt')
  git(repoDir, 'commit', '-m', 'initial')

  if (dirty) {
    writeFileSync(join(repoDir, 'tracked.txt'), CONTENT.dirty)
    writeFileSync(join(repoDir, 'untracked.txt'), CONTENT.untracked)
    mkdirSync(join(repoDir, 'ignored'))
    writeFileSync(join(repoDir, 'ignored', 'secret.txt'), CONTENT.ignored)
    mkdirSync(join(repoDir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(repoDir, 'node_modules', 'pkg', 'index.js'), CONTENT.node)
  }

  return { root, repoDir, paths }
}

function makeIo({ repoDir, paths }) {
  return realIo({ members: {} }, paths, repoDir, null, null, {}, {})
}

function restored(fixture) {
  const { repoDir } = fixture
  assert.equal(readFileSync(join(repoDir, 'tracked.txt'), 'utf8'), CONTENT.dirty)
  assert.equal(readFileSync(join(repoDir, 'untracked.txt'), 'utf8'), CONTENT.untracked)
  assert.equal(readFileSync(join(repoDir, 'ignored', 'secret.txt'), 'utf8'), CONTENT.ignored)
  assert.equal(readFileSync(join(repoDir, 'node_modules', 'pkg', 'index.js'), 'utf8'), CONTENT.node)
  assert.equal(git(repoDir, 'stash', 'list').trim(), '')
}

function withRepo(options, fn) {
  const fixture = makeRepo(options)
  try {
    return fn(fixture)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
}

const treeCommand = [
  'git status --porcelain -uall',
  "printf 'TRACKED\\n'; cat tracked.txt",
  "printf 'UNTRACKED\\n'; if [ -e untracked.txt ]; then cat untracked.txt; else printf '<absent>\\n'; fi",
  "printf 'IGNORED\\n'; cat ignored/secret.txt",
  "printf 'NODE_MODULE\\n'; cat node_modules/pkg/index.js",
].join('; ')

test('runClean shows committed tracked work while ignored paths stay visible', () => {
  withRepo({}, (fixture) => {
    const io = makeIo(fixture)
    const result = io.runClean(treeCommand)
    assert.equal(result.ok, true)
    assert.match(result.output, /TRACKED\ncommitted tracked content\n/)
    assert.match(result.output, /UNTRACKED\n<absent>/)
    assert.match(result.output, /IGNORED\nignored secret content\n/)
    assert.match(result.output, /NODE_MODULE\nnode package content\n/)
    assert.doesNotMatch(result.output, /untracked content/)
  })
})

test('runClean restores tracked, untracked, ignored, and node_modules work with no stash left', () => {
  withRepo({}, (fixture) => {
    makeIo(fixture).runClean('printf clean')
    restored(fixture)
    assert.equal(existsSync(join(fixture.repoDir, 'untracked.txt')), true)
  })
})

test('runClean on a clean tree runs without creating a stash entry', () => {
  withRepo({ dirty: false }, (fixture) => {
    const io = makeIo(fixture)
    const result = io.runClean('printf clean-tree')
    assert.deepEqual(result, { ok: true, output: 'clean-tree' })
    assert.equal(git(fixture.repoDir, 'stash', 'list').trim(), '')
  })
})

test('runClean restores the tree when the command throws', () => {
  withRepo({}, (fixture) => {
    const io = makeIo(fixture)
    io.run = () => { throw new Error('command failed') }
    assert.throws(() => io.runClean('boom'), /command failed/)
    restored(fixture)
  })
})

test('runClean preserves a non-zero command result and still restores the tree', () => {
  withRepo({}, (fixture) => {
    const result = makeIo(fixture).runClean("printf 'command output'; exit 7")
    assert.equal(result.ok, false)
    assert.equal(result.output, 'command output')
    restored(fixture)
  })
})

test('run keeps a nested node test summary parseable under FORCE_COLOR', () => {
  const saved = process.env.FORCE_COLOR
  process.env.FORCE_COLOR = '3'
  try {
    withRepo({ dirty: false }, (fixture) => {
      writeFileSync(join(fixture.repoDir, 'sample.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('sample', () => { assert.equal(1, 1) })\n")
      const io = makeIo(fixture)
      const result = io.run(`env -u NODE_TEST_CONTEXT ${process.execPath} --test sample.test.mjs`)
      assert.equal(result.output.includes('\x1b'), false)
      const match = /^\s*(?:ℹ|#)?\s*pass (\d+)/m.exec(result.output)
      assert.equal(match?.[1], '1')
      assert.equal(result.ok, true)
    })
  } finally {
    if (saved === undefined) delete process.env.FORCE_COLOR
    else process.env.FORCE_COLOR = saved
  }
})
