# LENS A — CLI argument parsing: crew/crew.mjs + crew/factoryctl.mjs

Scratch copy: `.../scratchpad/h2/repo` (git archive HEAD). Real checkout never written.
Node v26.5.1. No coreutils `timeout` on this box — `run.mjs` is a bounded spawn wrapper.
Every boot probe runs with `CREW_LOAD_THRESHOLD=0.0000001` + `HOME=./fakehome`, which makes
`assertHostQuiet` (crew.mjs:1430) a hard circuit breaker *before* resolveAdapters / pathsFor /
mkdir / any cmux call — no workspace, no seat, no state dir was ever created.

## The parser
`crew/crew.mjs:2127-2137` and `crew/factoryctl.mjs:13-22` are the SAME function, duplicated.
Rule: a token starting with `--` takes the next token as its value UNLESS that token also
starts with `--` or argv ends, in which case the flag is boolean `true`.
Consequences measured in `01-parseargs.mjs`:
  - no `--flag=value` support: `--task=alpha` becomes the key `task=alpha`
  - repeated flag = silent last-wins
  - `--` is not a terminator: it becomes the empty-named key `''` and EATS the next token
  - `--__proto__ x` is inert (object-literal setter swallows it) — no prototype pollution
  - all extra positionals past index 2 are silently dropped (factoryctl `send`)

## FINDINGS
See the final report. Repro scripts, in order:
  01-parseargs.mjs          parser characterisation
  02-roleflags.mjs          F2: --model-/agent-/effort-<typo> silently dropped on --roles path
  03-timeout-s.mjs          F1: --timeout-s numeric seam (no envelope on disk)
  04-timeout-wrong-answer.mjs  F1 sharp form: settled `done` envelope, wait says still-running
  05-assertusage.mjs        assertUsage matrix
  06-boot-flags.mjs         boot verb hostility (load circuit breaker)
  07-roles-empty-proof.mjs  F4: --roles "" silently seats DEFAULT_ROLES
  08-run-resolvers.mjs      resolveValidationLane / FilesInScope / Variant / Waits / Limits / memoryConfig
  09-suite-keep.mjs         F3: /bin/sh -c <boolean true> exits 0
  10-factoryctl.mjs         F5/F6: unknown flags ignored, send truncates at word 1
  11-suite-chain.mjs        F3 full chain in one file
  12-slug.mjs               slug() is clean (negative)

## Guards that DO exist (do not re-attack)
crew/limits.mjs:29-42 (`--plan/build/review-rounds`), crew/drive.mjs:74-85 (`--wait-<role>`),
crew/crew.mjs:418-439 (`--validation-lane`), :334-347 (`--variant`), :349-385 (`--files-in-scope`),
:391-405 (`--fences`/`--lane` pairing), :469-480 (transport ambiguity), :518-522 (`--allow-shortfall`),
:576-583 (role flags, TIER PATH ONLY), crew/slug.mjs:13-17, crew/seat-io.mjs:918-936 (`--claude-bin`),
crew/seat-io.mjs:2109-2119 (git commit is argv-form with `--`).

## Verified line anchors (against the real checkout, `sed -n`)
crew/crew.mjs:319   seatModel  `args[`model-${role}`] || SEAT_DEFAULTS[role].model`
crew/crew.mjs:1189-1190  the ONLY role-suffix validator on the --roles path (allow-shortfall only)
crew/crew.mjs:1407-1408  `roles = (args.roles ? args.roles.split(',') : [...DEFAULT_ROLES])...`
crew/crew.mjs:1430  assertHostQuiet(load) — the probe circuit breaker used by 06/07
crew/crew.mjs:1798  `suite: args.suite || 'node --test --test-timeout=30000'`
crew/crew.mjs:1886  `if (result.status === 'done' && !args.keep)`
crew/crew.mjs:2009  `const timeoutMs = Number(args['timeout-s'] || 3600) * 1000`
crew/crew.mjs:2127-2137  parseArgs
crew/crew.mjs:2157-2184  assertUsage
crew/crew.mjs:2186-2191  COMMANDS table + verb dispatch
crew/crew.mjs:576-583  resolveTier's loud throw for role flags (TIER PATH ONLY)
crew/drive.mjs:3226  `const suiteRes = io.run(ctx.suite)`
crew/seat-io.mjs:1799-1806  `run(cmd) { spawnSync('/bin/sh', ['-c', cmd], ...) }`
crew/factoryctl.mjs:180-195  requireRunArgs · :229-234 requireSendArgs · :262-264 requireAttachArgs
crew/factoryctl.mjs:327-334  main() — verb allowlist, NO unknown-flag check
