import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assignmentLine, assertSafeLine, pickNeedle, surfaceProcessTree } from './driver.mjs'
import { capabilitiesFor as claudeCapabilitiesFor } from './adapters/adapter-claude.mjs'
import { capabilitiesFor as piCapabilitiesFor } from './adapters/adapter-pi.mjs'

const GOOD = {
  id: 'p1',
  role: 'planner',
  briefFile: '/Users/x/.crew/demo/task/brief-planner.md',
  returnPath: '/Users/x/.crew/demo/returns/planner.json',
  taskDir: '/Users/x/.crew/demo/task',
}

test('assignmentLine returns the exact expected string', () => {
  assert.equal(
    assignmentLine(GOOD),
    'ASSIGNMENT p1: read your brief at /Users/x/.crew/demo/task/brief-planner.md. Task dir: /Users/x/.crew/demo/task. Write your ReturnEnvelope to /Users/x/.crew/demo/returns/planner.json then print exactly: CREW-DONE planner p1'
  )
})

test('relative briefFile throws', () => {
  assert.throws(() => assignmentLine({ ...GOOD, briefFile: 'brief-planner.md' }), /assignmentLine: briefFile/)
  assert.throws(() => assignmentLine({ ...GOOD, briefFile: './task/brief-planner.md' }), /assignmentLine: briefFile/)
})

test('disallowed character in briefFile throws', () => {
  assert.throws(() => assignmentLine({ ...GOOD, briefFile: '/Users/x/demo/brief planner.md' }), /assignmentLine: briefFile/)
  assert.throws(() => assignmentLine({ ...GOOD, briefFile: '/Users/x/demo,extra/brief.md' }), /assignmentLine: briefFile/)
})

test('every path field is guarded: taskDir', () => {
  assert.throws(() => assignmentLine({ ...GOOD, taskDir: '/Users/x/demo task' }), /assignmentLine: taskDir/)
  assert.throws(() => assignmentLine({ ...GOOD, taskDir: 'demo/task' }), /assignmentLine: taskDir/)
})

test('every path field is guarded: returnPath', () => {
  assert.throws(() => assignmentLine({ ...GOOD, returnPath: '/Users/x/demo returns/planner.json' }), /assignmentLine: returnPath/)
  assert.throws(() => assignmentLine({ ...GOOD, returnPath: 'returns/planner.json' }), /assignmentLine: returnPath/)
})

test('id and role are guarded', () => {
  assert.throws(() => assignmentLine({ ...GOOD, id: 'p 1' }), /assignmentLine: id/)
  assert.throws(() => assignmentLine({ ...GOOD, role: 'plan,ner' }), /assignmentLine: role/)
})

test('round-trip: composed line always passes assertSafeLine', () => {
  assert.doesNotThrow(() => assertSafeLine(assignmentLine(GOOD)))
  assert.doesNotThrow(() => assertSafeLine(assignmentLine({
    id: 'tech-lead',
    role: 'tech-lead',
    briefFile: '/srv/dev-team_2/.crew/v0.1.92/task/brief-tech-lead.md',
    returnPath: '/srv/dev-team_2/.crew/v0.1.92/returns/tech-lead.json',
    taskDir: '/srv/dev-team_2/.crew/v0.1.92/task',
  })))
})

test('missing field throws', () => {
  assert.throws(() => assignmentLine({}), /assignmentLine: id/)
})

test('dot-only id and role throw', () => {
  for (const bad of ['.', '..', '...']) {
    assert.throws(() => assignmentLine({ ...GOOD, id: bad }), /assignmentLine: id/)
    assert.throws(() => assignmentLine({ ...GOOD, role: bad }), /assignmentLine: role/)
  }
})

test('the thrown message names the offending token', () => {
  assert.throws(() => assignmentLine({ ...GOOD, id: '..' }), /assignmentLine: id .*: \.\.$/)
  assert.throws(() => assignmentLine({ ...GOOD, role: '...' }), /assignmentLine: role .*: \.\.\.$/)
})

test('path separators in id and role throw', () => {
  assert.throws(() => assignmentLine({ ...GOOD, id: '../x' }), /assignmentLine: id/)
  assert.throws(() => assignmentLine({ ...GOOD, role: 'a/b' }), /assignmentLine: role/)
  assert.throws(() => assignmentLine({ ...GOOD, id: 'a\\b' }), /assignmentLine: id/)
})

test('legitimate tokens still compose', () => {
  for (const id of ['a1', 'd12', 'p1', 'v0.1.97']) {
    assert.doesNotThrow(() => assignmentLine({ ...GOOD, id }))
  }
  assert.doesNotThrow(() => assignmentLine({ ...GOOD, id: 'tech-lead', role: 'tech-lead' }))
})

test('pickNeedle chooses from the line TAIL — the input-box viewport scrolls to the end, hiding the head', () => {
  const line = assignmentLine({
    id: 'd1', role: 'planner',
    briefFile: '/private/tmp/some-very-long-scratchpad-path-that-wraps-many-columns/brief-95-adapter-seam.md',
    returnPath: '/Users/x/.crew/repo/task/returns/d1.planner.json',
    taskDir: '/Users/x/.crew/repo/task/task',
  })
  const needle = pickNeedle(line)
  assert.equal(needle, '/Users/x/.crew/repo/task/returns/d1.planner.json')
  // the head-positioned brief path must NEVER be the needle, however long
  assert.notEqual(needle, line.split(/\s+/).reduce((a, b) => (b.length > a.length ? b : a), ''))
})


// surfaceProcessTree capture triple: captured 2026-08-20 as one triple
// (`tree --id-format both` -> `top --processes` -> `tree --id-format both`,
// the tree reads byte-identical for these surfaces), pruned mechanically to
// the fields the helper reads (tree surface id/ref/index_in_pane/title/tty/type;
// top surface ref/type/title/tty/index_in_pane/foreground_pgids/processes;
// process pid/pgid/ppid/name/attribution_reason/cmux_surface_id/children;
// workspace id/ref/title; pane id/index/ref) and to three surfaces. Values
// otherwise remain byte-verbatim. Every scenario built by cloning and editing is labelled
// DERIVED with its surgery below.
const TOP_CAPTURE = {
  "windows": [
    {
      "ref": "window:2",
      "workspaces": [
        {
          "id": "7A1E247C-4649-4A9F-B040-E705211D9977",
          "ref": "workspace:232",
          "title": "crew-b80-handle-r2",
          "panes": [
            {
              "index": 1,
              "ref": "pane:1107",
              "surfaces": [
                {
                  "foreground_pgids": [
                    29317
                  ],
                  "index_in_pane": 0,
                  "processes": [
                    {
                      "attribution_reason": "cmux-environment",
                      "children": [
                        {
                          "attribution_reason": "explicit-root-pid",
                          "children": [],
                          "cmux_surface_id": null,
                          "name": "caffeinate",
                          "pgid": 29317,
                          "pid": 52337,
                          "ppid": 29317
                        },
                        {
                          "attribution_reason": "cmux-environment",
                          "children": [],
                          "cmux_surface_id": "CB0EA863-17E6-4BE5-A318-AE4EB79C00ED",
                          "name": "cmux",
                          "pgid": 56143,
                          "pid": 56143,
                          "ppid": 29317
                        },
                        {
                          "attribution_reason": "child-process",
                          "children": [
                            {
                              "attribution_reason": "cmux-environment",
                              "children": [],
                              "cmux_surface_id": "CB0EA863-17E6-4BE5-A318-AE4EB79C00ED",
                              "name": "cmux",
                              "pgid": 56156,
                              "pid": 56168,
                              "ppid": 56156
                            }
                          ],
                          "cmux_surface_id": null,
                          "name": "zsh",
                          "pgid": 56156,
                          "pid": 56156,
                          "ppid": 29317
                        }
                      ],
                      "cmux_surface_id": "CB0EA863-17E6-4BE5-A318-AE4EB79C00ED",
                      "name": "2.1.237",
                      "pgid": 29317,
                      "pid": 29317,
                      "ppid": 27859
                    },
                    {
                      "attribution_reason": "explicit-root-pid",
                      "children": [],
                      "cmux_surface_id": null,
                      "name": "sleep",
                      "pgid": 29290,
                      "pid": 56159,
                      "ppid": 29290
                    },
                    {
                      "attribution_reason": "explicit-root-pid",
                      "children": [
                        {
                          "attribution_reason": "explicit-root-pid",
                          "children": [],
                          "cmux_surface_id": null,
                          "name": "zsh",
                          "pgid": 29290,
                          "pid": 29290,
                          "ppid": 27859
                        }
                      ],
                      "cmux_surface_id": null,
                      "name": "zsh",
                      "pgid": 27859,
                      "pid": 27859,
                      "ppid": 27852
                    }
                  ],
                  "ref": "surface:1957",
                  "title": "planner",
                  "tty": "ttys023",
                  "type": "terminal"
                }
              ]
            }
          ]
        },
        {
          "id": "2A2FD533-E444-4090-B109-2F17ECB6C0CA",
          "ref": "workspace:234",
          "title": "crew-b82-daemon",
          "panes": [
            {
              "index": 1,
              "ref": "pane:1116",
              "surfaces": [
                {
                  "foreground_pgids": [
                    44995
                  ],
                  "index_in_pane": 0,
                  "processes": [
                    {
                      "attribution_reason": "cmux-environment",
                      "children": [
                        {
                          "attribution_reason": "explicit-root-pid",
                          "children": [],
                          "cmux_surface_id": null,
                          "name": "caffeinate",
                          "pgid": 44995,
                          "pid": 45365,
                          "ppid": 44995
                        }
                      ],
                      "cmux_surface_id": "A9CA2547-79BD-40CF-AA43-9725B5B2BC0E",
                      "name": "2.1.237",
                      "pgid": 44995,
                      "pid": 44995,
                      "ppid": 43843
                    },
                    {
                      "attribution_reason": "explicit-root-pid",
                      "children": [],
                      "cmux_surface_id": null,
                      "name": "sleep",
                      "pgid": 44981,
                      "pid": 56162,
                      "ppid": 44981
                    },
                    {
                      "attribution_reason": "explicit-root-pid",
                      "children": [
                        {
                          "attribution_reason": "explicit-root-pid",
                          "children": [],
                          "cmux_surface_id": null,
                          "name": "zsh",
                          "pgid": 44981,
                          "pid": 44981,
                          "ppid": 43843
                        }
                      ],
                      "cmux_surface_id": null,
                      "name": "zsh",
                      "pgid": 43843,
                      "pid": 43843,
                      "ppid": 43833
                    }
                  ],
                  "ref": "surface:1974",
                  "title": "planner",
                  "tty": "ttys019",
                  "type": "terminal"
                }
              ]
            }
          ]
        },
        {
          "id": "2D9E1288-F539-4E8E-AE21-3B85FF2F4033",
          "ref": "workspace:12",
          "title": "◐ Debug plugin agent launching in cmux panes",
          "panes": [
            {
              "index": 0,
              "ref": "pane:20",
              "surfaces": [
                {
                  "foreground_pgids": [
                    7433
                  ],
                  "index_in_pane": 0,
                  "processes": [
                    {
                      "attribution_reason": "cmux-environment",
                      "children": [],
                      "cmux_surface_id": "51E89C13-956C-42F5-9787-BA8437699948",
                      "name": "2.1.231",
                      "pgid": 7433,
                      "pid": 7433,
                      "ppid": 62369
                    },
                    {
                      "attribution_reason": "cmux-environment",
                      "children": [
                        {
                          "attribution_reason": "cmux-environment",
                          "children": [
                            {
                              "attribution_reason": "cmux-environment",
                              "children": [],
                              "cmux_surface_id": "51E89C13-956C-42F5-9787-BA8437699948",
                              "name": "2.1.237",
                              "pgid": 32061,
                              "pid": 32080,
                              "ppid": 32061
                            }
                          ],
                          "cmux_surface_id": "51E89C13-956C-42F5-9787-BA8437699948",
                          "name": "2.1.237",
                          "pgid": 32061,
                          "pid": 32061,
                          "ppid": 32052
                        }
                      ],
                      "cmux_surface_id": "51E89C13-956C-42F5-9787-BA8437699948",
                      "name": "2.1.237",
                      "pgid": 32052,
                      "pid": 32052,
                      "ppid": 1
                    },
                    {
                      "attribution_reason": "explicit-root-pid",
                      "children": [],
                      "cmux_surface_id": null,
                      "name": "sleep",
                      "pgid": 7430,
                      "pid": 56164,
                      "ppid": 7430
                    },
                    {
                      "attribution_reason": "explicit-root-pid",
                      "children": [
                        {
                          "attribution_reason": "explicit-root-pid",
                          "children": [],
                          "cmux_surface_id": null,
                          "name": "zsh",
                          "pgid": 7430,
                          "pid": 7430,
                          "ppid": 62369
                        }
                      ],
                      "cmux_surface_id": null,
                      "name": "zsh",
                      "pgid": 62369,
                      "pid": 62369,
                      "ppid": 62361
                    }
                  ],
                  "ref": "surface:27",
                  "title": "✳ Boot crew on #94 and select tasks",
                  "tty": "ttys013",
                  "type": "terminal"
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
const TREE_CAPTURE = {
  "windows": [
    {
      "id": "0E9D80FF-8361-41D9-B538-D6FBF70936BA",
      "ref": "window:2",
      "workspaces": [
        {
          "id": "7A1E247C-4649-4A9F-B040-E705211D9977",
          "ref": "workspace:232",
          "title": "crew-b80-handle-r2",
          "panes": [
            {
              "id": "DF4D1EDB-B5C3-4015-9129-61503C985F0B",
              "index": 1,
              "ref": "pane:1107",
              "surfaces": [
                {
                  "id": "CB0EA863-17E6-4BE5-A318-AE4EB79C00ED",
                  "index_in_pane": 0,
                  "ref": "surface:1957",
                  "title": "planner",
                  "tty": "ttys023",
                  "type": "terminal"
                }
              ]
            }
          ]
        },
        {
          "id": "2A2FD533-E444-4090-B109-2F17ECB6C0CA",
          "ref": "workspace:234",
          "title": "crew-b82-daemon",
          "panes": [
            {
              "id": "7B1BB35C-2872-4626-AE0E-9A7ABFA13B76",
              "index": 1,
              "ref": "pane:1116",
              "surfaces": [
                {
                  "id": "A9CA2547-79BD-40CF-AA43-9725B5B2BC0E",
                  "index_in_pane": 0,
                  "ref": "surface:1974",
                  "title": "planner",
                  "tty": "ttys019",
                  "type": "terminal"
                }
              ]
            }
          ]
        },
        {
          "id": "2D9E1288-F539-4E8E-AE21-3B85FF2F4033",
          "ref": "workspace:12",
          "title": "◐ Debug plugin agent launching in cmux panes",
          "panes": [
            {
              "id": "31B1BC1E-36B2-4E37-87FA-8B83C7CE1281",
              "index": 0,
              "ref": "pane:20",
              "surfaces": [
                {
                  "id": "51E89C13-956C-42F5-9787-BA8437699948",
                  "index_in_pane": 0,
                  "ref": "surface:27",
                  "title": "✳ Boot crew on #94 and select tasks",
                  "tty": "ttys013",
                  "type": "terminal"
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}

const clone = (value) => JSON.parse(JSON.stringify(value))
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
deepFreeze(TOP_CAPTURE)
deepFreeze(TREE_CAPTURE)

const flat = (roots, out = []) => {
  for (const root of roots || []) {
    out.push(root)
    flat(root.children, out)
  }
  return out
}

function findTop(top, ref) {
  for (const window of top.windows || []) {
    for (const workspace of window.workspaces || []) {
      for (const pane of workspace.panes || []) {
        for (const surface of pane.surfaces || []) {
          if (surface.ref === ref) return { workspace, pane, surface }
        }
      }
    }
  }
  return null
}

function findTree(tree, id) {
  for (const window of tree.windows || []) {
    for (const workspace of window.workspaces || []) {
      for (const pane of workspace.panes || []) {
        for (const surface of pane.surfaces || []) {
          if (String(surface.id).toLowerCase() === id) return surface
        }
      }
    }
  }
  return null
}

const SEAT = '51e89c13-956c-42f5-9787-ba8437699948'
const CHAIN = 'cb0ea863-17e6-4be5-a318-ae4eb79c00ed'
const OTHER = 'a9ca2547-79bd-40cf-aa43-9725b5b2bc0e'
const ABSENT = '00000000-0000-4000-8000-000000000000'
const CONTRACT_KEYS = ['reason', 'roots', 'self', 'self_by', 'status', 'surface_id', 'surface_ref']

// One injected seam for the whole read path. Tree reads are answered in order
// so a mapping change between them is expressible; captures are cloned and
// frozen before each call so the production helper cannot mutate them.
function call(id, { top = TOP_CAPTURE, trees = [TREE_CAPTURE, TREE_CAPTURE], cmuxImpl } = {}) {
  const seen = []
  const topJson = deepFreeze(clone(top))
  const treeJson = trees.map((value) => deepFreeze(clone(value)))
  let treeReads = 0
  const cmux = (verb, args, opts) => {
    seen.push({ verb, args, opts })
    if (cmuxImpl) {
      const response = cmuxImpl(verb, args, opts, seen.length)
      if (response !== undefined) return response
    }
    if (verb === 'tree') {
      const json = treeJson[Math.min(treeReads, treeJson.length - 1)]
      treeReads += 1
      return { ok: true, stdout: '', stderr: '', error: null, json }
    }
    return { ok: true, stdout: '', stderr: '', error: null, json: topJson }
  }
  const out = surfaceProcessTree(id, { cmux })
  return { out, seen, verbs: seen.map(({ verb }) => verb) }
}

function assertCompleteUnknown(out) {
  assert.deepEqual(Object.keys(out).sort(), CONTRACT_KEYS)
  assert.equal(out.status, 'unknown')
  assert.equal(out.surface_ref, null)
  assert.equal(out.self, null)
  assert.equal(out.self_by, 'none')
  assert.deepEqual(out.roots, [])
  assert.equal(typeof out.reason, 'string')
  assert.ok(out.reason.length > 0)
}

test('surfaceProcessTree resolves a live pane surface to its attributed process tree', () => {
  const { out } = call(SEAT)
  assert.equal(out.status, 'measured')
  assert.equal(out.surface_id, SEAT)
  assert.equal(out.surface_ref, 'surface:27')
  assert.deepEqual(Object.keys(out).sort(), CONTRACT_KEYS)
  const nodes = flat(out.roots)
  for (const pid of [7433, 32052, 32061, 32080, 62369]) {
    assert.ok(nodes.some((node) => node.pid === pid), `expected captured pid ${pid}`)
  }
  const n32052 = nodes.find((node) => node.pid === 32052)
  const n32061 = nodes.find((node) => node.pid === 32061)
  assert.ok(n32052.children.some((child) => child.pid === 32061))
  assert.ok(n32061.children.some((child) => child.pid === 32080))
  for (const node of nodes) {
    assert.equal(typeof node.pgid, 'number')
    assert.equal(typeof node.ppid, 'number')
  }
})

test('the surface ref comes from tree --id-format both and is confirmed by a second tree read', () => {
  const resolved = call(SEAT)
  assert.deepEqual(resolved.verbs, ['tree', 'top', 'tree'])
  for (const observation of resolved.seen.filter(({ verb }) => verb === 'tree')) {
    assert.deepEqual(observation.args, ['--json', '--id-format', 'both', '--all'])
  }
  assert.equal(resolved.out.surface_ref, findTree(TREE_CAPTURE, SEAT).ref)

  // DERIVED: the confirming tree read moves SEAT to surface:31.
  const movedTree = clone(TREE_CAPTURE)
  findTree(movedTree, SEAT).ref = 'surface:31'
  const moved = call(SEAT, { trees: [TREE_CAPTURE, movedTree] }).out
  assertCompleteUnknown(moved)
  assert.match(moved.reason, /moved between snapshots/)

  // DERIVED: the confirming tree read fails.
  const failed = call(SEAT, {
    cmuxImpl: (verb, args, opts, nth) => nth === 3
      ? { ok: false, stdout: '', stderr: '', error: { message: 'exit 1' } }
      : undefined,
  }).out
  assertCompleteUnknown(failed)
})

test('surfaceProcessTree selects the foreground group leader, never a group member', () => {
  const seat = call(SEAT).out
  assert.equal(seat.self.pid, 7433)
  assert.equal(seat.self.pgid, 7433)
  assert.equal(seat.self_by, 'foreground-group-leader')

  const chain = call(CHAIN).out
  assert.equal(chain.self.pid, 29317)
  assert.ok(flat(chain.roots).some((node) => node.pid === 52337 && node.pgid === 29317))

  // DERIVED: copy the leader attribution onto member 52337 and hoist it to
  // the front of the forest, making a membership-only rule select the member.
  const memberFirst = clone(TOP_CAPTURE)
  const hit = findTop(memberFirst, 'surface:1957')
  const leader = hit.surface.processes.find((process) => process.pid === 29317)
  const member = leader.children.find((process) => process.pid === 52337)
  member.cmux_surface_id = leader.cmux_surface_id
  leader.children = leader.children.filter((process) => process.pid !== 52337)
  hit.surface.processes.unshift(member)
  const derived = call(CHAIN, { top: memberFirst }).out
  assert.equal(derived.self.pid, 29317)
  assert.equal(derived.self_by, 'foreground-group-leader')
})

test('a positively matched top node with no attributed process is a measured empty', () => {
  // DERIVED: empty surface:1974's real captured forest.
  const emptyTop = clone(TOP_CAPTURE)
  findTop(emptyTop, 'surface:1974').surface.processes = []
  const empty = call(OTHER, { top: emptyTop }).out
  assert.equal(empty.status, 'empty')
  assert.equal(empty.surface_ref, 'surface:1974')
  assert.deepEqual(empty.roots, [])
  assert.equal(empty.self, null)
  assert.equal(empty.self_by, 'none')
  assert.equal(empty.reason, null)
})

test('a matched node whose processes carry no cmux_surface_id is still a measurement', () => {
  // DERIVED: retain only surface:27 roots whose cmux_surface_id is null.
  const nullIdTop = clone(TOP_CAPTURE)
  const hit = findTop(nullIdTop, 'surface:27')
  hit.surface.processes = hit.surface.processes.filter((process) => process.cmux_surface_id === null)
  const measured = call(SEAT, { top: nullIdTop }).out
  assert.equal(measured.status, 'measured')
  assert.ok(flat(measured.roots).some((node) => node.pid === 62369))
  assert.equal(measured.self, null)
  assert.equal(measured.self_by, 'none')
})

test('an unknown result stays distinguishable from a measured empty in both directions', () => {
  // DERIVED: the matched ref is absent from top.
  const missingTop = clone(TOP_CAPTURE)
  const missing = findTop(missingTop, 'surface:27')
  missing.pane.surfaces = missing.pane.surfaces.filter((surface) => surface.ref !== 'surface:27')

  // DERIVED: the matched ref is listed twice in top.
  const duplicateTop = clone(TOP_CAPTURE)
  const duplicate = findTop(duplicateTop, 'surface:27')
  duplicate.pane.surfaces.push(clone(duplicate.surface))

  // DERIVED: a process is attributed to another surface.
  const foreignTop = clone(TOP_CAPTURE)
  findTop(foreignTop, 'surface:27').surface.processes[0].cmux_surface_id = 'A9CA2547-79BD-40CF-AA43-9725B5B2BC0E'

  const cases = [
    call(SEAT, { top: missingTop }).out,
    call(SEAT, { top: duplicateTop }).out,
    call(SEAT, { top: foreignTop }).out,
    call(SEAT, { cmuxImpl: (verb) => verb === 'top' ? { ok: false, error: { message: 'exit 1' } } : undefined }).out,
    call(SEAT, { cmuxImpl: (verb) => verb === 'top' ? { ok: false, error: { message: 'bad JSON from top: unexpected token' } } : undefined }).out,
    call(SEAT, { cmuxImpl: (verb) => verb === 'top' ? { ok: false, error: { message: 'spawnSync ETIMEDOUT' } } : undefined }).out,
    call(ABSENT).out,
    call(SEAT, { cmuxImpl: (verb, args, opts, nth) => nth === 1 ? { ok: false, error: { message: 'exit 1' } } : undefined }).out,
  ]
  for (const result of cases) assertCompleteUnknown(result)

  const emptyTop = clone(TOP_CAPTURE)
  findTop(emptyTop, 'surface:1974').surface.processes = []
  const empty = call(OTHER, { top: emptyTop }).out
  assert.equal(empty.status, 'empty')
  assert.notEqual(empty.status, cases[0].status)
  assert.equal(empty.reason, null)
})

test('every injected failure and malformed payload returns a complete unknown, never a throw', () => {
  // DERIVED: malformed process array.
  const malformedProcessTop = clone(TOP_CAPTURE)
  findTop(malformedProcessTop, 'surface:27').surface.processes = { not: 'an array' }

  // DERIVED: malformed child list.
  const malformedChildTop = clone(TOP_CAPTURE)
  findTop(malformedChildTop, 'surface:27').surface.processes[0].children = 7

  const cases = [
    ['a cmux that throws', () => call(SEAT, { cmuxImpl: () => { throw new Error('spawn exploded') } }).out],
    ['a confirming tree read that throws', () => call(SEAT, { cmuxImpl: (verb, args, opts, nth) => { if (nth === 3) throw new Error('second tree exploded') } }).out],
    ['a tree payload that is not an object', () => call(SEAT, { trees: [42, 42] }).out],
    ['processes that is not an array', () => call(SEAT, { top: malformedProcessTop }).out],
    ['children that is not an array', () => call(SEAT, { top: malformedChildTop }).out],
    ['a missing surface id', () => call('').out],
    ['a non-string surface id', () => call(null).out],
  ]
  for (const [label, run] of cases) {
    let result
    assert.doesNotThrow(() => { result = run() }, label)
    assertCompleteUnknown(result)
  }
})

test('surfaceProcessTree is read-only: it reaches only cmux tree and cmux top', () => {
  const { seen, verbs } = call(SEAT)
  assert.deepEqual(verbs, ['tree', 'top', 'tree'])
  assert.deepEqual(seen.find(({ verb }) => verb === 'top').args, ['--processes', '--json', '--all'])
  const destructive = new Set(['close-surface', 'close-workspace', 'send', 'send-key', 'kill', 'signal'])
  assert.equal(seen.some(({ verb }) => destructive.has(verb)), false)
})

test('the pane capability declarations still declare abort none', () => {
  const expected = { interjection: 'none', abort: 'none', session_resume: false, durable_cursor: 'none', reassign: true }
  const pane = (capabilitiesFor) => {
    const profile = capabilitiesFor({ transport: 'pane' })
    return {
      interjection: profile.interjection,
      abort: profile.abort,
      session_resume: profile.session_resume,
      durable_cursor: profile.durable_cursor,
      reassign: profile.reassign,
    }
  }
  assert.deepEqual(pane(claudeCapabilitiesFor), expected)
  assert.deepEqual(pane(piCapabilitiesFor), expected)
})
