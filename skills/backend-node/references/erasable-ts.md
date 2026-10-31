# TypeScript that both loaders can erase

Read `docs/conventions.md` for the decision. Keep `crew/pi/extensions/subagent.ts`
erasable-syntax-only: its source header permits annotations, `interface`,
`type`, `as`, and `satisfies`, but rejects `enum`, `namespace`, and parameter
properties. jiti loads the extension directly without a build; Node's unflagged
TypeScript stripping must also load it. Unsupported runtime syntax causes
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` (see the conventions).

The `the module is zero-dep, erasable, and carries the vendored MIT notice` test
in `crew/pi/extensions/subagent.test.mjs` greps for enum and namespace, but not
parameter properties or decorators. The module import catches unsupported syntax
only when it executes; interrupted imports and empty-source edges remain unbacked
(see `evidence.md`). Do not claim the grep covers those gaps or add syntax just
because jiti accepts it. Review the source header when loader assumptions change;
a forbidden construct can prevent startup. Update this checklist and its test
when the gap closes.
