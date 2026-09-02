---
name: backend-node
description: >-
  Use when writing a new module under `crew/`, adding a CLI verb or flag,
  touching a `.ts` extension, declaring a closed enum, choosing an import
  boundary, or emitting a usage or cost record. Use when a backend change must
  stay dependency-light, reject unknown command input, survive both TypeScript
  loaders, or distinguish an unmeasured value from a measured zero. Use when
  reviewing tests for import firewalls, frozen data contracts, flag windows,
  or complete-or-absent accounting.
---

Every rule here is an observed response to a backend failure. Read the exhibit
before relaxing the rule; the references carry the measured cost and the gap.

## Routing

| Doing… | Rule | Details |
|---|---|---|
| Importing from a backend module | Keep the dependency boundary explicit | `references/zero-dep.md` |
| Allowlisting a daemon import | Pin the allowlisted leaf separately | `references/import-firewall.md` |
| Declaring a finite data vocabulary | Freeze it and test both halves of drift | `references/closed-enums.md` |
| Adding a CLI option | Refuse every option the verb does not read | `references/cli-flags.md` |
| Editing a TypeScript extension | Use only syntax both loaders erase | `references/erasable-ts.md` |
| Returning usage or cost | Return a complete record or omit it | `references/usage-records.md` |
| Claiming a rule or enforcement exists | Keep the unbacked register visible | `references/evidence.md` |

## Critical rules

- Keep each module on `node:` builtins unless an explicit first-party allowlist admits an exception; enforce the boundary per module. Exhibit: `crew/pi/extensions/subagent.test.mjs:171` and `test/factory-intake.test.mjs:1115`. Cost: a repository-wide scan would miss a newly introduced dependency inside one file.
- Pin each daemon-admitted leaf exception (`crew/slug.mjs`, `crew/escalation-policy.mjs`, `crew/variants.mjs`, `crew/task-profiles.mjs`, `crew/assurances.mjs`, and `crew/run-configuration.mjs`) as import-free; intentional non-leaf helpers such as `crew/headless-rpc.mjs` are outside that leaf rule. Exhibit: `crew/daemon.test.mjs:255`, `crew/daemon.test.mjs:257`, and `crew/daemon.test.mjs:259`. Cost: an allowlist without a leaf assertion turns one safe edge into a transitive escape hatch.
- Model a closed enum as frozen data that the code consults, and assert both its values and its frozen state. Exhibit: `crew/drive.mjs:132` and `crew/drive.test.mjs:5130`. Cost: a value-only test survives a mutation that makes callers able to alter the vocabulary.
- Make every verb refuse a flag it does not read, with the refusal carrying the usage exit status. Exhibit: `scripts/factory/ledger.mjs:5208` and `test/factory-emit.test.mjs:1476`. Cost: the one-letter `--untill` defect silently removed a window bound (#443).
- Keep TypeScript extensions erasable-syntax-only across jiti and Node's loader, and pin the constructs the local grep does not cover. Exhibit: `crew/pi/extensions/subagent.ts:5-9` and `crew/pi/extensions/subagent.test.mjs:179`. Cost: there is no build step between either loader and the extension process.
- Emit usage as a complete record when measured and omit the usage key when it is absent; never manufacture a partial zero. Exhibit: `crew/pi/extensions/subagent.ts:471` and `crew/pi/extensions/subagent.test.mjs:486`. Cost: pi dereferences nested cost fields unconditionally, so a partial object fails inside its consumer.

## Key references

- `references/zero-dep.md` — builtin imports, module-local enforcement, and allowlists.
- `references/import-firewall.md` — daemon imports and the leaf assertions.
- `references/closed-enums.md` — data enums and the two-part drift guard.
- `references/cli-flags.md` — refusal of unknown flags and exit status.
- `references/erasable-ts.md` — the two TypeScript loaders and syntax checklist.
- `references/usage-records.md` — producer-side complete-or-absent records.
- `references/evidence.md` — enforcement gaps without a local exhibit.
