// The canonical slug rule, in a LEAF module: it imports nothing, so every
// consumer can take it without dragging a dependency along. That is the whole
// reason it lives here rather than in crew.mjs — `daemon.mjs`'s server surface
// may not import crew.mjs (which imports drive.mjs, and the import firewall in
// daemon.test.mjs enforces it), so before this module existed the daemon kept
// its own copy of the rule. Two copies of a lowercasing rule is exactly the
// drift #192 was filed about, one layer down.
//
// Consumers: crew.mjs (state paths), daemon.mjs (tier-run identity), and
// test/fixtures.mjs (the fixture guard). Keep this file import-free —
// daemon.test.mjs asserts that, because an allowlisted import here would be a
// hole in the firewall rather than an exception to it.
export function slug(s) {
  const out = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!out) throw new Error(`slug: empty/degenerate input ${JSON.stringify(s)}`)
  return out
}

// The same rule for callers that treat a degenerate input as "no identity"
// rather than an error — `slug` throws so a bad --task fails loudly at boot,
// while the daemon's identity key wants a null it can fall through on.
export function slugOrNull(s) {
  try { return slug(s) } catch { return null }
}
