// test/version-agreement.test.mjs — the plugin's two version files may never
// disagree (#137).
//
// The repo's original convention was a version bump on every feature commit.
// It was enforced by nothing and was missed five times in two days (#137's
// table), from both crew-authored commits and hand-written squashes — so it
// is relaxed deliberately: bump on RELEASE, not per commit. What is NOT
// relaxed is the pair agreeing, because that is the failure that actually
// shipped wrong metadata twice (#118 left marketplace.json a minor behind;
// #124's subject claimed a bump that touched no file at all).
//
// A convention nobody checks decays at the rate #137 measured. This is the
// check, and it is a test rather than CI-only config so it fails in the same
// `node --test` a crew already runs before it commits.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'))

const PLUGIN = '.claude-plugin/plugin.json'
const MARKETPLACE = '.claude-plugin/marketplace.json'
const SEMVER = /^\d+\.\d+\.\d+$/

test('plugin.json and marketplace.json carry the same version', () => {
  const plugin = read(PLUGIN)
  const marketplace = read(MARKETPLACE)
  assert.equal(
    marketplace.metadata?.version, plugin.version,
    `${MARKETPLACE} metadata.version (${marketplace.metadata?.version}) must equal ${PLUGIN} version (${plugin.version}) — bump both or neither`,
  )
})

test('the plugin version is plain semver', () => {
  const { version } = read(PLUGIN)
  assert.match(String(version), SEMVER, `${PLUGIN} version must be MAJOR.MINOR.PATCH, got ${JSON.stringify(version)}`)
})

test('the marketplace entry describes the same plugin as plugin.json', () => {
  // The pair drifting is not only a version problem: the marketplace entry
  // also duplicates the plugin's name and description, and a rename that
  // updates one file is the same class of miss.
  const plugin = read(PLUGIN)
  const marketplace = read(MARKETPLACE)
  const entry = (marketplace.plugins || []).find((p) => p.name === plugin.name)
  assert.ok(entry, `${MARKETPLACE} lists no plugin named ${JSON.stringify(plugin.name)} — the two files describe different plugins`)
  assert.equal(entry.description, plugin.description, `the ${plugin.name} entry's description has drifted from ${PLUGIN}`)
})

test('no marketplace plugin entry carries its own competing version', () => {
  // Only metadata.version is the version. An entry-level `version` key would
  // be a third source of truth that nothing above would catch.
  const marketplace = read(MARKETPLACE)
  for (const entry of marketplace.plugins || []) {
    assert.equal(
      entry.version, undefined,
      `plugin entry ${entry.name} carries its own version — the single source is ${MARKETPLACE} metadata.version`,
    )
  }
})
