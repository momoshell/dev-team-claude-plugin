import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  assignmentLine, assignmentPrompt, assertSafeLine, briefIngestCommands, pickNeedles, surfaceProcessTree, sendLine,
  DELIVERY_MODES, SEND_RETRIES, SUBMIT_BLIND_SPOT, SUBMIT_ENTER_ATTEMPTS, SUBMIT_PROOF_WINDOW_MS, SUBMIT_TOTAL_BUDGET_MS,
} from './driver.mjs'
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

test('assignmentPrompt path delivery is byte-identical and modes are closed', () => {
  assert.deepEqual(DELIVERY_MODES, ['path', 'inline'])
  assert.equal(assignmentPrompt({ ...GOOD, delivery: 'path' }), assignmentLine(GOOD))
  assert.throws(() => assignmentPrompt({ ...GOOD, delivery: 'other' }), /assignmentPrompt: delivery must be one of path, inline/)
})

test('assignmentPrompt inline delivery carries a multiline brief without its path instruction', () => {
  const briefText = '# Task: inline\n## The ask\nKeep this verbatim.\n'
  const prompt = assignmentPrompt({ ...GOOD, delivery: 'inline', briefText })
  assert.match(prompt, /^ASSIGNMENT p1: your brief is inlined below, in full — nothing to read first\./)
  assert.ok(prompt.includes(briefText))
  assert.ok(prompt.includes('--- BRIEF BEGINS ---'))
  assert.ok(prompt.includes('--- BRIEF ENDS ---'))
  assert.doesNotMatch(prompt, /read your brief at/)
  assert.doesNotMatch(prompt, new RegExp(GOOD.briefFile.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')))
  assert.ok(prompt.includes(`Write your ReturnEnvelope to ${GOOD.returnPath}`))
  assert.ok(prompt.includes(`CREW-DONE ${GOOD.role} ${GOOD.id}`))
  assert.throws(() => assertSafeLine(prompt), /sendLine: line contains a character outside the allowed charset/)
  assert.throws(() => assignmentPrompt({ ...GOOD, delivery: 'inline', briefText: '' }), /assignmentPrompt: briefText must be a non-empty string/)
  for (const [field, value] of [['id', '../p1'], ['role', 'plan/ner'], ['taskDir', 'task']]) {
    assert.throws(() => assignmentPrompt({ ...GOOD, delivery: 'inline', briefText, [field]: value }), new RegExp(`assignmentLine: ${field}`))
  }
})

test('briefIngestCommands counts rows and finds absolute and basename reads', () => {
  const rows = [
    { message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `cat ${GOOD.briefFile}` } }] } },
    { message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `cat ${GOOD.briefFile.split('/').pop()}` } }] } },
    { message: { content: [{ type: 'tool_use', name: 'Read', input: { command: `cat ${GOOD.briefFile}` } }] } },
  ]
  const result = briefIngestCommands({ stream: rows.map((row) => JSON.stringify(row)).join('\n') + '\n', briefFile: GOOD.briefFile })
  assert.equal(result.rows, 3)
  assert.equal(result.unparsed, 0)
  assert.deepEqual(result.commands, [`cat ${GOOD.briefFile}`, `cat ${GOOD.briefFile.split('/').pop()}`])
  const torn = briefIngestCommands({ stream: 'not json\n', briefFile: GOOD.briefFile })
  assert.deepEqual(torn, { rows: 1, unparsed: 1, commands: [] })
  assert.throws(() => briefIngestCommands({ stream: '', briefFile: '' }), /briefIngestCommands: briefFile must be a non-empty string/)
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

// --- #759: many short needles -----------------------------------------------
const B322_LINE = assignmentLine({
  id: 'd1', role: 'planner',
  briefFile: '/private/tmp/claude-501/scratchpad/batch-b322/out/b322-closeout.brief.md',
  returnPath: '/Users/x/.crew/dt-b322-closeout/b322-closeout/returns/d1.planner.json',
  taskDir: '/Users/x/.crew/dt-b322-closeout/b322-closeout/task',
})
const B322_RETURN_PATH = '/Users/x/.crew/dt-b322-closeout/b322-closeout/returns/d1.planner.json'
const B322_BASENAME = 'd1.planner.json'
const B322_MID_START = B322_LINE.indexOf(`${B322_RETURN_PATH}`) + 30
const B322_MID_END = B322_LINE.indexOf(B322_BASENAME) + B322_BASENAME.length + 22
const b322MiddleWindow = (box) => box.slice(B322_MID_START, B322_MID_END)
const b322HeadWindow = (box) => box.slice(0, 30)
const b322TailWindow = (box) => box.slice(-34)

const SCREEN_MARKER_15_UP = 'SCREEN-MARKER-15-UP'
const SCREEN_MARKER_LAST = 'SCREEN-MARKER-LAST'

function windowCmux({ window = () => '', consume = () => true, clears = true } = {}) {
  const state = { box: '', sends: 0, enters: 0, keys: [], calls: [] }
  const frame = () => [
    'screen-line-01',
    SCREEN_MARKER_15_UP,
    ...Array.from({ length: 12 }, (_, index) => `screen-line-${String(index + 2).padStart(2, '0')}`),
    `> ${window(state.box)}`,
    '  bypass permissions on',
    SCREEN_MARKER_LAST,
  ].join('\n')
  const ok = (stdout = '') => ({ ok: true, stdout, stderr: '', error: null })
  const fn = (verb, args = []) => {
    state.calls.push({ verb, args })
    const separator = args.indexOf('--')
    const tail = separator >= 0 ? args.slice(separator + 1).join(' ') : ''
    if (verb === 'read-screen') return ok(frame())
    if (verb === 'send') { state.box += tail; state.sends += 1; return ok() }
    if (verb === 'send-key') {
      state.keys.push(tail)
      if (tail === 'enter') { state.enters += 1; if (consume(state)) state.box = '' }
      else if (clears) state.box = ''
      return ok()
    }
    return ok()
  }
  return { fn, state }
}

function sendInWindow(line, window, options = {}) {
  const { fn, state } = windowCmux({ window, ...options })
  const journal = []
  let clock = 1_700_000_000_000
  let error = null
  let report
  try {
    report = sendLine('51e89c13-956c-42f5-9787-ba8437699948', line, {
      cmux: fn, log: (row) => journal.push(row),
      now: () => clock, settle: (ms) => { clock += ms },
    })
  } catch (err) { error = err }
  return { state, journal, error, report }
}

test('pickNeedles returns unique short head, middle and tail candidates', () => {
  const needles = pickNeedles(B322_LINE)
  const flat = B322_LINE.replace(/\s+/g, '')
  assert.deepEqual(needles, ['ASSIGNMENTd1:', B322_BASENAME, 'CREW-DONEplannerd1'])
  for (const needle of needles) {
    assert.ok(needle.length <= 24)
    assert.equal(flat.split(needle).length - 1, 1)
  }
  assert.ok(!needles.includes(B322_RETURN_PATH.replace(/\s+/g, '')))
})

test('a middle-window frame lands and submits with one typed copy and one enter', () => {
  const { state, error } = sendInWindow(B322_LINE, b322MiddleWindow)
  assert.equal(error, null)
  assert.equal(state.sends, 1)
  assert.equal(state.enters, 1)
})

test('head-only and tail-only frames each land with one typed copy', () => {
  for (const window of [b322HeadWindow, b322TailWindow]) {
    const { state, error } = sendInWindow(B322_LINE, window)
    assert.equal(error, null)
    assert.equal(state.sends, 1)
    assert.equal(state.enters, 1)
  }
})

test('a frame showing nothing retries without a clear and carries its last 12 lines', () => {
  const { state, error } = sendInWindow(B322_LINE, () => '')
  assert.ok(error, 'expected a throw when no candidate is visible')
  assert.equal(state.sends, SEND_RETRIES + 1)
  assert.equal(state.keys.filter((key) => key !== 'enter').length, 0)
  assert.ok(error.message.includes(SCREEN_MARKER_LAST))
  assert.ok(!error.message.includes(SCREEN_MARKER_15_UP))
})

test('SEND_RETRIES is exported as the bounded retype budget', () => {
  assert.equal(SEND_RETRIES, 2)
})

test('a visible candidate that never submits is reported, not cleared and not retyped', () => {
  const { state, error, report } = sendInWindow(B322_LINE, b322HeadWindow, {
    consume: () => false,
    clears: false,
  })
  assert.equal(error, null)
  assert.equal(state.sends, 1)
  assert.equal(report.submitted, false)
})

test('assignmentLine keeps its verbatim template and #759 path-length decision', () => {
  const source = readFileSync(new URL('./driver.mjs', import.meta.url), 'utf8')
  assert.ok(source.includes('ASSIGNMENT ${id}: read your brief at ${briefFile}. Task dir: ${taskDir}. Write your ReturnEnvelope to ${returnPath} then print exactly: CREW-DONE ${role} ${id}'))
  assert.ok(source.includes('contract risk is not worth the characters. Both paths stay verbatim (#759).'))
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


// --- sendLine: the send/verify/enter/PROVE sequence (b305) --------------------
// A faked cmux, an in-memory input box and a virtual clock. The fake models the
// one thing measured live on 2026-08-29: a consumed line leaves the box (the
// needle leaves the frame), a swallowed one sits there unchanged.
function fakeCmux({ consume = () => true } = {}) {
  const state = { box: '', sends: 0, enters: 0, keys: [], calls: [] }
  const screen = () => `\n\n> ${state.box}\n  bypass permissions on\n`
  const fn = (verb, args) => {
    state.calls.push({ verb, args })
    const tail = args.indexOf('--') >= 0 ? args.slice(args.indexOf('--') + 1).join(' ') : ''
    if (verb === 'read-screen') return { ok: true, stdout: screen(), stderr: '', error: null }
    if (verb === 'send') { state.box += tail; state.sends += 1; return { ok: true, stdout: '', stderr: '', error: null } }
    if (verb === 'send-key') {
      state.keys.push(tail)
      if (tail === 'enter') { state.enters += 1; if (consume(state)) state.box = '' }
      else state.box = ''
      return { ok: true, stdout: '', stderr: '', error: null }
    }
    return { ok: true, stdout: '', stderr: '', error: null }
  }
  return { fn, state }
}

// The #889 pane renders its transcript and input box in one frame. Consuming
// enter moves the box contents into the transcript without changing the total
// frame count for a needle.
function transcriptCmux({ consume = () => true } = {}) {
  const state = { box: '', transcript: [], sends: 0, enters: 0, keys: [], calls: [] }
  const screen = () => [
    'screen-line-01',
    ...state.transcript,
    '─'.repeat(60),
    `❯ ${state.box}`,
    '─'.repeat(60),
    '  auto mode on',
  ].join('\n')
  const ok = (stdout = '') => ({ ok: true, stdout, stderr: '', error: null })
  const fn = (verb, args) => {
    state.calls.push({ verb, args })
    const tail = args.indexOf('--') >= 0 ? args.slice(args.indexOf('--') + 1).join(' ') : ''
    if (verb === 'read-screen') return ok(screen())
    if (verb === 'send') { state.box += tail; state.sends += 1; return ok() }
    if (verb === 'send-key') {
      state.keys.push(tail)
      if (tail === 'enter') {
        state.enters += 1
        if (consume(state) && state.box) { state.transcript.push(state.box); state.box = '' }
      }
      return ok()
    }
    return ok()
  }
  return { fn, state }
}

function sendWith(consume) {
  const { fn, state } = fakeCmux({ consume })
  const journal = []
  let clock = 1_700_000_000_000
  const start = clock
  let error = null
  let report
  try {
    report = sendLine('51e89c13-956c-42f5-9787-ba8437699948', SEND_LINE, {
      cmux: fn, log: (row) => journal.push(row),
      now: () => clock, settle: (ms) => { clock += ms },
    })
  } catch (err) { error = err }
  return { state, journal, error, report, elapsed: clock - start }
}

const SEND_LINE = assignmentLine({
  id: 'd1', role: 'builder', briefFile: '/tmp/b305/brief.md',
  returnPath: '/tmp/b305/returns/d1.builder.json', taskDir: '/tmp/b305/task',
})

function sendInTranscript(consume = () => true) {
  const { fn, state } = transcriptCmux({ consume })
  const journal = []
  let clock = 1_700_000_000_000
  let error = null
  let report
  try {
    report = sendLine('51e89c13-956c-42f5-9787-ba8437699948', SEND_LINE, {
      cmux: fn, log: (row) => journal.push(row),
      now: () => clock, settle: (ms) => { clock += ms },
    })
  } catch (err) { error = err }
  return { state, journal, error, report, elapsed: clock - 1_700_000_000_000 }
}

test('sendLine returns when the line is echoed AND consumed — one enter, no retype', () => {
  const { state, journal, error } = sendWith(() => true)
  assert.equal(error, null)
  assert.equal(state.sends, 1)
  assert.equal(state.enters, 1)
  assert.deepEqual(state.keys, ['enter'])
  assert.equal(journal.at(-1).event, 'send-submit')
  assert.equal(journal.at(-1).outcome, 'submitted')
})

test('a submitted line still visible in the transcript is reported, not fatal', () => {
  const { state, error, report } = sendInTranscript()
  assert.equal(error, null)
  assert.equal(state.sends, 1)
  assert.equal(state.enters, SUBMIT_ENTER_ATTEMPTS)
  assert.deepEqual(state.keys, ['enter', 'enter', 'enter'])
  assert.equal(report.submitted, false)
})

test('an unprovable submit returns a report the caller can act on', () => {
  const { journal, error, report } = sendInTranscript()
  assert.equal(error, null)
  assert.equal(report.submitted, false)
  assert.equal(report.enters, 3)
  assert.equal(report.needle, 'ASSIGNMENTd1:')
  assert.equal(report.blind_spot, SUBMIT_BLIND_SPOT)
  const row = journal.filter((entry) => entry.event === 'send-submit').at(-1)
  assert.equal(row.outcome, 'unproved')
  assert.equal(row.blind_spot, SUBMIT_BLIND_SPOT)
})

test('SUBMIT_BLIND_SPOT names both the box and the transcript', () => {
  assert.ok(SUBMIT_BLIND_SPOT.includes('input box'))
  assert.ok(SUBMIT_BLIND_SPOT.includes('transcript'))
})

test('no code path sends a clear key', () => {
  const source = readFileSync(new URL('./driver.mjs', import.meta.url), 'utf8')
  const keys = []
  for (const raw of source.split('\n')) {
    if (!raw.includes("'send-key'")) continue
    const quoted = raw.match(/'([^']*)'/g) || []
    const last = quoted.length ? quoted[quoted.length - 1].slice(1, -1) : null
    if (last !== null) keys.push(last)
  }
  assert.ok(keys.length > 0)
  assert.deepEqual(keys, ['enter'])
})

test('the unproved submit does not retype', () => {
  const { state, journal, error } = sendInTranscript()
  assert.equal(error, null)
  assert.equal(state.sends, 1)
  const rows = journal.filter((entry) => entry.event === 'send-retype-decision')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].outcome, 'not-baseline')
})

test('the one escalation that remains states the blind spot and never names the clear', () => {
  const { error } = sendInWindow(B322_LINE, () => '')
  assert.ok(error, 'expected an echo verification throw')
  assert.ok(error.message.includes(SUBMIT_BLIND_SPOT))
  assert.ok(!error.message.includes('could not clear the pane input back to baseline'))
})

test('the proving path is unchanged', () => {
  const { state, journal, error } = sendWith(() => true)
  assert.equal(error, null)
  assert.deepEqual(state.calls, [
    { verb: 'read-screen', args: ['--surface', '51e89c13-956c-42f5-9787-ba8437699948', '--lines', '40'] },
    { verb: 'send', args: ['--surface', '51e89c13-956c-42f5-9787-ba8437699948', '--', SEND_LINE] },
    { verb: 'read-screen', args: ['--surface', '51e89c13-956c-42f5-9787-ba8437699948', '--lines', '40'] },
    { verb: 'send-key', args: ['--surface', '51e89c13-956c-42f5-9787-ba8437699948', '--', 'enter'] },
    { verb: 'read-screen', args: ['--surface', '51e89c13-956c-42f5-9787-ba8437699948', '--lines', '40'] },
  ])
  assert.deepEqual(journal, [
    {
      at: '2023-11-14T22:13:20.250Z', event: 'send-echo-attempt', surface_id: '51e89c13-956c-42f5-9787-ba8437699948', attempt: 1,
      candidates: ['ASSIGNMENTd1:', 'd1.builder.json', 'CREW-DONEbuilderd1'], counts: [1, 1, 1],
      needle: 'ASSIGNMENTd1:', outcome: 'landed',
    },
    {
      at: '2023-11-14T22:13:20.500Z', event: 'send-submit-attempt', surface_id: '51e89c13-956c-42f5-9787-ba8437699948', attempt: 1, enter: 1,
      needle: 'ASSIGNMENTd1:', needle_count: 0, expected_in_box: 1, outcome: 'submitted',
    },
    {
      at: '2023-11-14T22:13:20.500Z', event: 'send-submit', surface_id: '51e89c13-956c-42f5-9787-ba8437699948', enters: 1,
      elapsed_ms: 500, outcome: 'submitted',
    },
  ])
})

test('a line that echoes but is NEVER consumed is reported, bounded and journalled', () => {
  const { state, journal, error, report, elapsed } = sendWith(() => false)
  assert.equal(error, null)
  assert.equal(report.submitted, false)
  assert.equal(report.enters, state.enters)
  assert.ok(state.enters >= 2 && state.enters <= 16, `bounded enters, got ${state.enters}`)
  assert.equal(journal.filter((row) => row.event === 'send-submit-attempt').length, state.enters)
  assert.equal(journal.at(-1).outcome, 'unproved')
  assert.ok(elapsed >= 60_000, `budget must cover the measured ~60s race, waited ${elapsed}ms`)
  assert.ok(elapsed <= SUBMIT_TOTAL_BUDGET_MS + SUBMIT_PROOF_WINDOW_MS, `bounded, waited ${elapsed}ms`)
})

test('a swallowed first enter is recovered by a re-press, with no second typed copy', () => {
  const { state, journal, error } = sendWith((s) => s.enters >= 2)
  assert.equal(error, null)
  assert.equal(state.enters, 2)
  assert.equal(state.sends, 1)
  assert.deepEqual(journal.filter((row) => row.event === 'send-submit-attempt').map((row) => row.outcome), ['unproved', 'submitted'])
})

test('when the re-presses are spent there is no retype and no clear', () => {
  const { state, error, report } = sendWith((s) => s.sends >= 2)
  assert.equal(error, null)
  assert.equal(state.sends, 1)
  assert.equal(state.keys.filter((key) => key !== 'enter').length, 0)
  assert.equal(state.enters, SUBMIT_ENTER_ATTEMPTS)
  assert.equal(report.submitted, false)
})

test('every enter attempt is journalled with its own outcome', () => {
  const { state, journal } = sendWith(() => false)
  const rows = journal.filter((row) => row.event === 'send-submit-attempt')
  assert.equal(rows.length, state.enters)
  for (const row of rows) {
    assert.equal(row.outcome, 'unproved')
    assert.equal(row.surface_id, '51e89c13-956c-42f5-9787-ba8437699948')
    assert.equal(typeof row.attempt, 'number')
    assert.equal(typeof row.enter, 'number')
  }
})
