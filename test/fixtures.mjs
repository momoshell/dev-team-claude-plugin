import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { slug } from '../crew/slug.mjs'

// Root cause this guards: a test that PREDICTS a path the code DERIVES.
// Here: `pathsFor` slugs the checkout basename and `slug()` lowercases
// (crew/crew.mjs:85,92), so a mkdtemp name — whose random suffix is mixed
// case — resolves back to the state dir only on a case-INSENSITIVE
// filesystem. Green on macOS, ENOENT on Linux CI (shipped in PR #190, fixed
// in 24a3941). The rule is imported, never re-implemented: a second copy of
// the lowercasing is exactly the copy that goes stale.
//
// Same root cause, opposite direction — not guarded here: macOS's `tmpdir()`
// is a symlink (`/var` -> `/private/var`), so a test comparing a
// realpath-resolved path against a raw `tmpdir()` join fails on macOS and
// passes on Linux. If you hit that, the fix is the same shape: derive, do not
// predict.
export function assertSlugStable(pathOrName) {
  const name = basename(pathOrName)
  const normalized = slug(name)
  if (name !== normalized) {
    throw new Error(`fixture basename ${JSON.stringify(name)} is not slug-stable: slug = ${JSON.stringify(normalized)}`)
  }
}

export function testCheckout(prefix, parent = tmpdir()) {
  const root = mkdtempSync(join(parent, prefix))
  const checkout = join(root, 'checkout')   // lowercase, so slug() is identity
  mkdirSync(checkout)
  assertSlugStable(checkout)
  return { root, checkout }
}

// #551 duplication audit of this module — null result, 2026-08-25.

// #603 removed the D1-D6 clusters from four carriers and fenced only
// test/helpers.mjs, so this module was never audited for the same duplication.
// It was, here, and it duplicates nothing:

// - Export names. This module exports assertSlugStable and testCheckout.
//   test/helpers.mjs exports ROOT, scratchDir, rawRequest, startFileWriter,
//   writeTornFile, sqliteAvailable, git, gitResult, treeDigest and
//   makeSeedLane. The intersection is empty, and ./fixtures.test.mjs pins that
//   so a future copy arrives red rather than quietly.
// - D1-D6 bodies. This module is already inside the helper-duplication
//   tripwire's scan surface (test/helpers.test.mjs) and is not exempt there, so
//   it provably carries no sqliteAvailable, git/gitResult, treeDigest,
//   scratchDir, rawRequest, startFileWriter, writeTornFile or makeSeedLane
//   declaration and no repo-root derivation — today, and on every future run.
// - The one real overlap, named rather than silently picked: testCheckout mints
//   its root with the raw mkdtempSync primitive that scratchDir owns. Routing it
//   through scratchDir would also register the directory for draining, which is
//   a behaviour change this lane is not scoped to make; and this module's single
//   raw temp call site is an AUDITED, FROZEN exemption of the temp-sandbox
//   tripwire in test/factory-env.test.mjs, whose warranty for this file is an
//   EXACT count and whose exemption total is pinned. Converting it here would
//   redden a tripwire that lives outside this lane's write fence. The surviving
//   behaviour is the raw mint, unchanged, and the conversion belongs to whichever
//   lane owns test/factory-env.test.mjs.
