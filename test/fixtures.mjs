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
