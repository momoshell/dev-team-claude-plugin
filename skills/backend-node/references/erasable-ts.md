# TypeScript that both loaders can erase

Read the record first: docs/conventions.md:45 owns this decision; this file owns the checklist.

Keep `crew/pi/extensions/subagent.ts` erasable-syntax-only.
Exhibit: `crew/pi/extensions/subagent.ts:5-9`.

The header permits annotations, `interface`, `type`, `as`, and `satisfies`.
Exhibit: `crew/pi/extensions/subagent.ts:5-9`.

The header rejects `enum`, `namespace`, and `parameter properties`.
Exhibit: `crew/pi/extensions/subagent.ts:5-9`.

jiti loads the extension directly, with no project build step in between.
Exhibit: `crew/pi/extensions/subagent.ts:5`.

Node's unflagged TypeScript stripping is the other loader to satisfy.
Exhibit: `crew/pi/extensions/subagent.ts:5-9`.

The local extension test greps for `enum`.
Exhibit: `crew/pi/extensions/subagent.test.mjs:174`.

It also greps for `namespace`.
Exhibit: `crew/pi/extensions/subagent.test.mjs:175`.

That grep has a declared gap: `parameter properties` are not searched.
Exhibit: `crew/pi/extensions/subagent.test.mjs:174`.

Decorators have the same unsearched status; the import test catches failures
only when loading the module.
Exhibit: `crew/pi/extensions/subagent.test.mjs:8`.

Node reports unsupported runtime syntax as `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.
Exhibit: `docs/conventions.md:45`.

Do not add a construct merely because jiti accepts it in one path.
Exhibit: `crew/pi/extensions/subagent.ts:5-9`.

Do not claim the grep covers parameter properties or decorators; the gap is
part of this register's honest checklist.
Exhibit: `crew/pi/extensions/subagent.test.mjs:174` and `:175`.

An interrupted import is not a passing syntax check, and an empty source is not
proof that a construct is absent.
Status: these interrupted and empty-source edges are unbacked in this checkout;
see `evidence.md`.

Review the first fourteen lines when changing the header or loader assumptions.
Exhibit: `crew/pi/extensions/subagent.ts:5-9`.

The cost of a forbidden construct is a startup failure before the extension can
serve a request.
Exhibit: `crew/pi/extensions/subagent.ts:5-9`.

When the gap closes, update both this checklist and its co-located test.
Exhibit: `crew/pi/extensions/subagent.test.mjs:174` and `:175`.
