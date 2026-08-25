import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scratchDir } from './helpers.mjs'
import { absenceFailure, gitGrepHits } from '../scripts/factory/absence.mjs'

const BAD_PATHSPEC_STATUS = 128
const IMPOSSIBLE_NEEDLE = 'b212-absence-impossible-needle-4d1e'

// Mutation killed: treating status 1 as fatal makes a successful absence check throw again.
test('zero matches reads as absent, not as a failure', () => {
  const options = { needle: IMPOSSIBLE_NEEDLE, paths: ['scripts/'] }
  assert.deepEqual(gitGrepHits(options), { count: 0, lines: [] })
  assert.equal(absenceFailure(options), null)
})

// Mutation killed: swallowing every status makes a search that never ran read as clean.
test('a bad pathspec magic is rethrown, never read as absent', () => {
  assert.throws(
    () => gitGrepHits({ needle: 'planner', paths: [':(nosuchmagic).'] }),
    (err) => {
      assert.equal(err.status, BAD_PATHSPEC_STATUS)
      assert.match(String(err.stderr), /Invalid pathspec magic/)
      return true
    },
  )
})

// Mutation killed: ignoring cwd answers "absent" for a tree the search never opened.
test('a non-repo cwd is rethrown, never read as absent', () => {
  const cwd = scratchDir('b212-absence-')
  assert.throws(
    () => gitGrepHits({ needle: 'planner', paths: ['.'], cwd }),
    (err) => {
      assert.equal(err.status, BAD_PATHSPEC_STATUS)
      assert.match(String(err.stderr), /not a git repository/)
      return true
    },
  )
})

// Mutation killed: changing the failure prefix or count lets a gate hide what it found.
test('a present needle reports the count and searched paths', () => {
  const needle = 'PROTECTED_PATHS_FIELD'
  const paths = ['scripts/factory/probe-repo.mjs']
  const failure = absenceFailure({ needle, paths })
  assert.match(failure, /^expected no reference to PROTECTED_PATHS_FIELD, found [1-9]\d* in scripts\/factory\/probe-repo\.mjs$/)
})

// Mutation killed: accepting an empty search would turn an invalid criterion into a clean result.
test('an empty needle is rejected before git runs', () => {
  assert.throws(() => gitGrepHits({ needle: '', paths: ['scripts/'] }), TypeError)
  assert.throws(() => gitGrepHits({ needle: 42, paths: ['scripts/'] }), TypeError)
  assert.throws(() => gitGrepHits({ needle: 'planner', paths: [] }), TypeError)
})
