# Fence compilation and arrival

A fence is a deny-list for sibling lanes and an allow-list for this lane. Treat
the compiler's coupling check as a two-pass protocol; a register that parses is
not yet a register the driver can safely consume.

## Two-pass compile

Start with a register whose lane has the intended `files` and an empty reads
list. `make-brief` accepts and ignores an `external: true` marker, so this same
two-pass compile recipe also works unchanged on a register carrying an external
entry:

```json
{
  "lanes": [
    {
      "lane": "<lane>",
      "files": ["skills/crew-dispatch/", "skills/crew-recovery/"],
      "reads": [],
      "external": true
    }
  ]
}
```

`gatherFences` accepts exactly `lane`, `files`, `reads` and `external`; an
`external: false` marker is refused, not ignored. `make-brief` drops the marker
after validating it, while `dispatch-batch` harvests it for the external-fence
checks.

Compile pass one with the current factory CLI:

```sh
node scripts/factory/make-brief.mjs --request task/request.json --checkout "$PWD" --fences task/fences.json --lane <lane> --out task/brief.md --force
```

The pass-one refusal is the useful output: read the complete
`coupled-source-unfenced` list. For every coupled file outside this lane's
write surface, add exactly one read record with the source file and a
non-blank `why`, for example
`{"file":"crew/variants.mjs","why":"the brief reads VARIANTS to choose a closed dispatch shape"}`.
Do not acknowledge a file that is in the fence itself, and do not omit one
that the compiler reported. Compile the same command again with that exact
list. The reverse mistake—leaving a read acknowledgement for a file that is
no longer coupled outside the fence—refuses with `stale-read-ack`.

A single-lane register can have no coupled sources outside its surface. In that
case pass one has an empty coupled list and `reads: []` remains correct; do not
invent acknowledgements merely to make the list non-empty.

## Consumer-side checks

Run the same predicates the driver uses, rather than inspecting the JSON by
eye. `validateScopeEntries` rejects globs, absolute paths, dot segments, and a
too-broad directory prefix; `SCOPE_DIR_MIN_SEGMENTS` is the two-segment floor:

```sh
node --input-type=module -e "import { validateScopeEntries, SCOPE_DIR_MIN_SEGMENTS } from './crew/drive.mjs'; console.log({ errors: validateScopeEntries(['skills/crew-dispatch/']), SCOPE_DIR_MIN_SEGMENTS })"
```

`scopeMatcher` treats a trailing slash literally: its rule is
`entry.endsWith('/') ? path.startsWith(entry) : path === entry`. Thus a
subdirectory entry must end in `/`, while a file entry must not:

```sh
node --input-type=module -e "import { scopeMatcher } from './crew/drive.mjs'; const match = scopeMatcher(['skills/crew-dispatch/']); console.log({ child: match('skills/crew-dispatch/SKILL.md'), directoryWithoutSlash: match('skills/crew-dispatch') })"
```

The protected-path floor is the other consumer. Check the exact scope entries
with `protectedHitsIn` over `resolveProtectedPaths(profileAdditions)`; the
resolved-union evidence belongs in [`references/tier.md`](tier.md):

```sh
node --input-type=module -e "import { protectedHitsIn } from './crew/protected-paths.mjs'; import { checkoutProtectedPaths } from './scripts/factory/probe-repo.mjs'; const { paths, basis } = checkoutProtectedPaths({ checkout: process.cwd() }); console.log(basis); console.log(protectedHitsIn(['skills/crew-dispatch/'], paths))"
```

Print the `basis`, never a remembered count: `checkoutProtectedPaths` falls back
to the authored floor with `used: false` whenever no ratified profile is
readable, so an empty hit list alone cannot tell you which floor you were
measured against.

## Arrival, not parsing

After boot, verify the persisted `crew.json` has both `lane_name` and an array
`lane_fence` for the selected lane, then verify the run journal contains the
`lane-fence` event. The event is the driver's arrival receipt:

```sh
CREW_JSON=<state-dir>/crew.json LANE=<lane> node --input-type=module -e "import { readFileSync } from 'node:fs'; const crew = JSON.parse(readFileSync(process.env.CREW_JSON, 'utf8')); if (crew.lane_name !== process.env.LANE || !Array.isArray(crew.lane_fence)) throw new Error('lane fence did not arrive'); console.log({ lane_name: crew.lane_name, lane_fence: crew.lane_fence })"
grep -F '"event":"lane-fence"' <state-dir>/journal.jsonl
```

`laneFenceFor` returns the **other** lanes' surfaces. Consequently
`lane_fence: []` is CORRECT for a single-lane register: there are no sibling
surfaces to deny. An empty array at arrival is not evidence that the fence was
lost; the lane name plus the journal `lane-fence` event establish that it
arrived.

## The fence is a claim about the code

A requirement's **seam** is part of its specification. For every “record /
persist / durably store” clause, name the seam and verify it can hold the value
before fencing its owning module out, or cut the requirement explicitly and say
it is deferred (#356/b56: three plan rounds, zero code, and a lane forced to
invent a write). When a re-dispatch cuts an invented mechanism, add an
**anti-spiral** clause forbidding both the mechanism and the machinery it would
need. Before fencing file F out of a brief that changes contract C, grep F for
C's names: a mirrored enum or marker table is the commonest carrier (#193,
#199, and the repair-variant lane).

## Granularity, measured

Recount with no extension filter first: `--include` silently under-reports, and
one `.js` file was missed in a 20-file rename. When a brief moves a constant,
**grep the VALUE**, not only the symbol, because an import firewall can turn one
value into two declarations and only the second has its own pinning test (b161
→ `escalate:scope`, three plan rounds, zero code). A task changing a
**DETECTOR** owns whatever that detector newly flags; compute that set before
dispatch. A `where` path that does not exist refuses **`missing-path`**, so a
lane needing a new file puts its fixture in an existing home. A source-grep
tripwire is trivially spoofable: when relocating code, retarget it honestly,
not with a comment.
