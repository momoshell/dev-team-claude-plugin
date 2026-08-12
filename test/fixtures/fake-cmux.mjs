#!/usr/bin/env node
// Record/replay fake for the real cmux CLI binary. This is the ONLY
// fake-binary fixture in the repo: every cmux test (this slice's and
// be-1b-E's) sets CMUX_BIN to this file's path instead of touching a live
// cmux. It is driven entirely by env vars — no test-specific branches live
// in this script, per the frozen contract in the handover spec.
//
// Env switches:
//   FAKE_CMUX_LOG              required; one JSON line { ts, argv } appended
//                               per invocation, in order, including failures.
//   FAKE_CMUX_STATE            path to a JSON file holding the in-memory
//                               topology; persisted across invocations so
//                               new-window/new-workspace/new-pane/markdown
//                               open genuinely mutate it.
//   FAKE_CMUX_FAIL             comma list of verbs that must fail (a flag-verb
//                              like `--version` is matched on argv[0] too).
//   FAKE_CMUX_MISSING_METHODS  comma list removed from capabilities.methods
//                              (dotted RPC method names, e.g. pane.create —
//                              NOT CLI verb names; see LIVE_METHODS below).
//   FAKE_CMUX_NO_CALLER        '1' -> identify returns caller: null.
//   FAKE_CMUX_EVENTS           path to a file whose lines are echoed by `events`.
//   FAKE_CMUX_TOP              path to a file whose contents are echoed by `top`
//                              (default: a verbatim live 7-column headerless
//                              capture — see LIVE_TOP_TSV below).
//   FAKE_CMUX_SCREEN           path to a file whose contents are echoed by
//                              `read-screen` (default: a small canned frame).
//   FAKE_CMUX_EXIT_CODE        overrides the exit code used on a forced failure.
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs'

const argv = process.argv.slice(2)

const logPath = process.env.FAKE_CMUX_LOG
if (!logPath) {
  // node --test's default file discovery sweeps every .mjs under a `test`
  // directory, including this fixture, and imports it with no env set up.
  // That is not a real invocation (every real one — from cmuxctl.mjs or
  // this repo's tests — always sets FAKE_CMUX_LOG) so exit clean rather
  // than fail the suite; a genuine misconfigured invocation would still be
  // caught by every downstream assertion expecting a log to exist.
  process.exit(0)
}

function logInvocation() {
  appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), argv })}\n`)
}

function fail(code, message) {
  // Logged BEFORE exit — a failing verb must never go unlogged (qa-lead
  // E-P1/E-P2's "zero dispatch" assertions would otherwise be vacuous).
  logInvocation()
  process.stderr.write(`Error: ${code}: ${message}\n`)
  process.exit(Number(process.env.FAKE_CMUX_EXIT_CODE || 1))
}

function succeed(stdout) {
  logInvocation()
  if (stdout !== undefined && stdout !== '') {
    process.stdout.write(stdout.endsWith('\n') ? stdout : `${stdout}\n`)
  }
  process.exit(0)
}

function argAfter(flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

const verb = argv[0]

const FAIL_VERBS = new Set((process.env.FAKE_CMUX_FAIL || '').split(',').map((s) => s.trim()).filter(Boolean))
if (FAIL_VERBS.has(verb)) {
  fail('forced_failure', `forced failure for verb ${verb}`)
}

// --- Persistent topology --------------------------------------------------
// Mixed-case ids on purpose: live cmux emits UPPERCASE, but a uniformly
// uppercase fixture cannot catch a normalizer that only handles one case
// class (qa-lead E-P3). These ids are deliberately mixed-case.
const ORCH_WINDOW = 'f1a063E8-ec2C-40d7-932c-F3610adfe581'
const ORCH_WORKSPACE = 'a2a063E8-ec2C-40d7-932c-F3610adfe582'
const ORCH_PANE = 'b3a063E8-ec2C-40d7-932c-F3610adfe583'
const ORCH_SURFACE = 'c4a063E8-ec2C-40d7-932c-F3610adfe584'

function freshTopology() {
  return {
    // Monotonic id-generation counter, persisted alongside the topology.
    // Four ids are already spent seeding the orchestrator's own
    // window/workspace/pane/surface below.
    _seq: 4,
    windows: [
      {
        id: ORCH_WINDOW,
        title: 'orchestrator',
        workspaces: [
          {
            id: ORCH_WORKSPACE,
            window_id: ORCH_WINDOW,
            title: 'main',
            panes: [
              {
                id: ORCH_PANE,
                workspace_id: ORCH_WORKSPACE,
                surface_ids: [ORCH_SURFACE],
                selected_surface_id: ORCH_SURFACE,
                surfaces: [
                  { id: ORCH_SURFACE, pane_id: ORCH_PANE, type: 'agent-session', tty: '/dev/ttys001', title: 'orchestrator' },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}

const statePath = process.env.FAKE_CMUX_STATE

function loadState() {
  if (statePath && existsSync(statePath)) {
    try {
      return JSON.parse(readFileSync(statePath, 'utf8'))
    } catch {
      // fall through to a fresh topology on a corrupt/empty state file
    }
  }
  return freshTopology()
}

function saveState(state) {
  if (statePath) writeFileSync(statePath, JSON.stringify(state))
}

// A monotonic counter, persisted on `state._seq`, seeds new ids. It is
// advanced on every call — including multiple calls within the SAME
// invocation (e.g. new-workspace mints a workspace, a pane, and a surface
// in one go) — so ids minted together are always pairwise distinct. Real
// cmux never emits colliding ids; a fixture that does makes every
// downstream `locate()` first-match-wins lookup unreliable.
function nextId(state) {
  state._seq = (state._seq || 0) + 1
  const first = state._seq.toString(16).padStart(8, '0')
  // Mixed-case suffix, held constant except for the varying first group.
  return `${first}-Ec2C-40d7-932c-F3610adfE581`
}

// A SEPARATE monotonic counter for `browser open`'s printed POSITIONAL refs
// (be-12-01, issue #12/D2) — `surface:<n>`/`pane:<n>` in the live capture are
// NOT uuids and never derived from nextId's uuid-shaped ids, so an
// implementation that tried to parse the printed line as an id would get a
// bare integer and fail (the frozen fixture-fidelity requirement).
function nextPos(state) {
  state._posSeq = (state._posSeq || 0) + 1
  return state._posSeq
}

function findSurfaceEntry(state, id) {
  const needle = (id || '').toLowerCase()
  for (const w of state.windows || []) {
    for (const ws of w.workspaces || []) {
      for (const p of ws.panes || []) {
        const idx = (p.surfaces || []).findIndex((s) => s.id.toLowerCase() === needle)
        if (idx >= 0) return { pane: p, surface: p.surfaces[idx], idx }
      }
    }
  }
  return null
}

function findPane(state, id) {
  const needle = (id || '').toLowerCase()
  for (const w of state.windows || []) {
    for (const ws of w.workspaces || []) {
      for (const p of ws.panes || []) {
        if (p.id.toLowerCase() === needle) return p
      }
    }
  }
  return null
}

function findWorkspaceEntry(state, id) {
  const needle = (id || '').toLowerCase()
  for (const w of state.windows || []) {
    for (const ws of w.workspaces || []) {
      if (ws.id.toLowerCase() === needle) return { window: w, workspace: ws }
    }
  }
  return null
}

function findWindow(state, id) {
  const needle = (id || '').toLowerCase()
  return (state.windows || []).find((w) => w.id.toLowerCase() === needle) || null
}

// The FROZEN live `capabilities --json` method list (cmux 0.64.20, captured
// 2026-08-02 — see live-capabilities.json in the 1b fix-plan package), NOT a
// copy of cmuxctl.mjs's VERBS. Live methods are RPC-style dotted names
// (system.ping, workspace.create, surface.send_text, ...); a fixture that
// echoed VERBS back made the verb gate tautological (qa-lead vacuity S4 —
// confirmed live-breaking).
const LIVE_METHODS = Object.freeze([
  'agent.resolve_delivery_target', 'aiAccounts.list', 'aiAccounts.remove', 'aiAccounts.upload',
  'app.focus_override.set', 'app.simulate_active', 'auth.begin_sign_in', 'auth.login', 'auth.sign_in_url',
  'auth.sign_out', 'auth.status', 'browser.addinitscript', 'browser.addscript', 'browser.addstyle',
  'browser.back', 'browser.check', 'browser.click', 'browser.console.clear', 'browser.console.list',
  'browser.console.show', 'browser.cookies.clear', 'browser.cookies.get', 'browser.cookies.set',
  'browser.dblclick', 'browser.design_mode.set', 'browser.design_mode.status', 'browser.devtools.toggle',
  'browser.dialog.accept', 'browser.dialog.dismiss', 'browser.download.wait', 'browser.errors.list',
  'browser.eval', 'browser.fill', 'browser.find.alt', 'browser.find.first', 'browser.find.label',
  'browser.find.last', 'browser.find.nth', 'browser.find.placeholder', 'browser.find.role',
  'browser.find.testid', 'browser.find.text', 'browser.find.title', 'browser.focus',
  'browser.focus_mode.set', 'browser.focus_webview', 'browser.forward', 'browser.frame.main',
  'browser.frame.select', 'browser.geolocation.set', 'browser.get.attr', 'browser.get.box',
  'browser.get.count', 'browser.get.html', 'browser.get.styles', 'browser.get.text', 'browser.get.title',
  'browser.get.value', 'browser.highlight', 'browser.history.clear', 'browser.hover',
  'browser.input_keyboard', 'browser.input_mouse', 'browser.input_touch', 'browser.is.checked',
  'browser.is.enabled', 'browser.is.visible', 'browser.is_webview_focused', 'browser.keydown',
  'browser.keyup', 'browser.navigate', 'browser.network.requests', 'browser.network.route',
  'browser.network.unroute', 'browser.offline.set', 'browser.open_split', 'browser.press',
  'browser.react_grab.toggle', 'browser.reload', 'browser.screencast.start', 'browser.screencast.stop',
  'browser.screenshot', 'browser.scroll', 'browser.scroll_into_view', 'browser.select', 'browser.snapshot',
  'browser.state.load', 'browser.state.save', 'browser.storage.clear', 'browser.storage.get',
  'browser.storage.set', 'browser.tab.close', 'browser.tab.list', 'browser.tab.new', 'browser.tab.switch',
  'browser.trace.start', 'browser.trace.stop', 'browser.type', 'browser.uncheck', 'browser.url.get',
  'browser.viewport.set', 'browser.wait', 'browser.zoom.set', 'debug.terminals',
  'extension.sidebar.snapshot', 'feed.exit_plan.reply', 'feed.jump', 'feed.list', 'feed.permission.reply',
  'feed.push', 'feed.question.reply', 'feedback.open', 'feedback.submit', 'file.open', 'markdown.open',
  'mobile.attach_ticket.create', 'mobile.events.subscribe', 'mobile.events.unsubscribe',
  'mobile.host.status', 'mobile.terminal.create', 'mobile.terminal.input', 'mobile.terminal.paste',
  'mobile.terminal.replay', 'mobile.terminal.set_font', 'mobile.terminal.viewport',
  'mobile.workspace.list', 'notification.clear', 'notification.create', 'notification.create_for_caller',
  'notification.create_for_surface', 'notification.create_for_target', 'notification.dismiss',
  'notification.jump_to_unread', 'notification.list', 'notification.mark_read', 'notification.open',
  'pane.break', 'pane.create', 'pane.focus', 'pane.join', 'pane.last', 'pane.list', 'pane.resize',
  'pane.surfaces', 'pane.swap', 'remote.tmux.attach', 'remote.tmux.detach', 'remote.tmux.mirror',
  'remote.tmux.pane_grids', 'remote.tmux.pane_surfaces', 'remote.tmux.sessions', 'remote.tmux.state',
  'remote.tmux.window', 'session.restore_previous', 'settings.open', 'sidebar.custom.open',
  'surface.action', 'surface.clear_history', 'surface.close', 'surface.create', 'surface.current',
  'surface.drag_to_split', 'surface.focus', 'surface.health', 'surface.list', 'surface.move',
  'surface.ports_kick', 'surface.read_text', 'surface.refresh', 'surface.reorder', 'surface.report_pwd',
  'surface.report_shell_state', 'surface.report_tty', 'surface.respawn', 'surface.resume.clear',
  'surface.resume.get', 'surface.resume.set', 'surface.send_key', 'surface.send_text', 'surface.split',
  'surface.split_off', 'surface.trigger_flash', 'system.capabilities', 'system.identify', 'system.memory',
  'system.ping', 'system.top', 'system.tree', 'tab.action', 'terminal.create', 'terminal.input',
  'terminal.paste', 'terminal.replay', 'terminal.viewport', 'vm.attach_info', 'vm.create', 'vm.destroy',
  'vm.exec', 'vm.list', 'vm.ssh_info', 'window.close', 'window.create', 'window.current',
  'window.display', 'window.displays', 'window.focus', 'window.list', 'workspace.action',
  'workspace.close', 'workspace.cloud_vm_open', 'workspace.cloud_vm_terminal_ready', 'workspace.create',
  'workspace.current', 'workspace.env', 'workspace.equalize_splits', 'workspace.group.add',
  'workspace.group.collapse', 'workspace.group.create', 'workspace.group.delete',
  'workspace.group.expand', 'workspace.group.focus', 'workspace.group.list', 'workspace.group.move',
  'workspace.group.new_workspace', 'workspace.group.pin', 'workspace.group.remove',
  'workspace.group.rename', 'workspace.group.set_anchor', 'workspace.group.set_color',
  'workspace.group.set_icon', 'workspace.group.ungroup', 'workspace.group.unpin', 'workspace.last',
  'workspace.list', 'workspace.move_to_window', 'workspace.next', 'workspace.previous',
  'workspace.prompt_submit', 'workspace.remote.configure', 'workspace.remote.disconnect',
  'workspace.remote.foreground_auth_ready', 'workspace.remote.pty_attach_end',
  'workspace.remote.pty_bridge', 'workspace.remote.pty_close', 'workspace.remote.pty_detach',
  'workspace.remote.pty_resize', 'workspace.remote.pty_sessions', 'workspace.remote.reconnect',
  'workspace.remote.status', 'workspace.remote.terminal_session_end', 'workspace.rename',
  'workspace.reorder', 'workspace.reorder_many', 'workspace.select', 'workspace.set_auto_title',
])

// The FROZEN live `cmux top --format tsv` output (cmux 0.64.22, captured
// 2026-08-05) — headerless, 7 positional tab-separated columns: cpu_pct,
// mem_bytes, proc_count, kind, id, parent_id, title_or_status. A real
// row's `id`/`parent_id` are positional refs (surface:1, pane:1), never
// UUIDs — `top` has no --id-format flag. This is a verbatim capture, not an
// invention (per conventions.md's fake-binary-fixture rule).
const LIVE_TOP_TSV =
  '0.0\t0\t0\ttotal\ttotal\t\t\n'
  + '0.1\t245760000\t2\twindow\twindow:1\t\torchestrator\n'
  + '18.2\t517574328\t8\tsurface\tsurface:1\tpane:1\t<spinner> Claude Code\n'

switch (verb) {
  case '--version': {
    succeed('cmux 0.64.20 (100)')
    break
  }

  case 'ping': {
    succeed('PONG')
    break
  }

  case 'identify': {
    const noCaller = process.env.FAKE_CMUX_NO_CALLER === '1'
    const caller = noCaller
      ? null
      : { window_id: ORCH_WINDOW, workspace_id: ORCH_WORKSPACE, pane_id: ORCH_PANE, surface_id: ORCH_SURFACE }
    succeed(JSON.stringify({ caller, focused: caller, socket_path: '/tmp/fake-cmux.sock' }))
    break
  }

  case 'capabilities': {
    const missing = new Set((process.env.FAKE_CMUX_MISSING_METHODS || '').split(',').map((s) => s.trim()).filter(Boolean))
    const methods = LIVE_METHODS.filter((m) => !missing.has(m))
    succeed(JSON.stringify({ access_mode: 'cmuxOnly', methods }))
    break
  }

  case 'tree': {
    // Reject an under-specified call: cmuxctl.mjs's tree() always sends
    // both flags, and a fake that answers anyway would hide a live
    // regression where they got dropped (qa-lead vacuity S3).
    if (!argv.includes('--json') || !argv.includes('--id-format')) {
      fail('bad_args', 'tree requires --json --id-format uuids')
    }
    const state = loadState()
    // be-12-01 qa hook: a PRE-SEEDED state flag (never a new env switch),
    // simulating tree() itself hanging inside a bounded caller (the
    // ensurePreviewBrowser critical-section scan/after-tree reads, be-12-02)
    // — the FAKE_CMUX_EVENTS_HANG precedent's Atomics.wait shape, reused
    // here so a bounded `tree({ timeoutMs })` caller can only ever be
    // released by its OWN spawnSync timeout, exactly like the real
    // `events` blocking behavior this precedent already models.
    if (state._simulateTreeHang) {
      logInvocation()
      const sab = new SharedArrayBuffer(4)
      Atomics.wait(new Int32Array(sab), 0, 0, 60_000) // far longer than any test's own timeoutMs
      process.exit(0)
    }
    succeed(JSON.stringify(state))
    break
  }

  case 'new-window': {
    const state = loadState()
    const id = nextId(state)
    state.windows.push({ id, title: 'window', workspaces: [] })
    saveState(state)
    succeed(id)
    break
  }

  case 'new-workspace': {
    const state = loadState()
    const windowId = argAfter('--window')
    const name = argAfter('--name')
    const cwd = argAfter('--cwd')
    const hasGroup = argv.includes('--group')
    const win = findWindow(state, windowId)
    if (!win) fail('not_found', 'Window not found')

    // be-11-02 qa should-fix hook: PRE-SEEDED state flags (never a new env
    // switch), simulating a `--group` rejection so ensureWorkspace's
    // degradation path is reachable from this deterministic fixture.
    // `_simulateGroupCreateFails` fails BEFORE creating anything.
    if (hasGroup && state._simulateGroupCreateFails) {
      fail('forced_failure', 'simulated --group rejection (no workspace created)')
    }

    const wsId = nextId(state)
    const paneId = nextId(state)
    const surfId = nextId(state)
    win.workspaces.push({
      id: wsId,
      window_id: win.id,
      title: name || 'workspace',
      cwd,
      panes: [
        {
          id: paneId,
          workspace_id: wsId,
          surface_ids: [surfId],
          selected_surface_id: surfId,
          surfaces: [{ id: surfId, pane_id: paneId, type: 'terminal', tty: '/dev/ttys002', title: 'terminal' }],
        },
      ],
    })

    // `_simulateGroupCreateFailsAfterCreating` fails AFTER the workspace
    // object already exists — the "the --group attempt had in fact created
    // the workspace" case ensureWorkspace must adopt rather than
    // blind-retry.
    if (hasGroup && state._simulateGroupCreateFailsAfterCreating) {
      saveState(state)
      fail('forced_failure', 'simulated --group rejection (workspace was created anyway)')
    }

    saveState(state)
    succeed(wsId)
    break
  }

  case 'new-pane': {
    const state = loadState()
    const wsId = argAfter('--workspace')
    const entry = findWorkspaceEntry(state, wsId)
    if (!entry) fail('not_found', 'Workspace not found')
    const paneId = nextId(state)
    const surfId = nextId(state)
    entry.workspace.panes.push({
      id: paneId,
      workspace_id: entry.workspace.id,
      surface_ids: [surfId],
      selected_surface_id: surfId,
      surfaces: [{ id: surfId, pane_id: paneId, type: 'terminal', tty: '/dev/ttys003', title: 'terminal' }],
    })
    saveState(state)
    succeed(paneId)
    break
  }

  case 'markdown': {
    if (argv[1] !== 'open') fail('bad_args', 'markdown: only "open" is supported')
    const renderPath = argv[2]
    const fromSurface = argAfter('--surface')
    const state = loadState()
    if (fromSurface) {
      const found = findSurfaceEntry(state, fromSurface)
      if (!found) fail('not_found', 'Surface not found')
      const newSurf = nextId(state)
      found.pane.surface_ids.push(newSurf)
      found.pane.surfaces.push({ id: newSurf, pane_id: found.pane.id, type: 'markdown', tty: null, title: renderPath })
      // qa should-fix test hook: a PRE-SEEDED state flag (never a new env
      // switch — this is exactly the "pre-seed FAKE_CMUX_STATE" escape
      // hatch), simulating a second, concurrent surface creation racing
      // this one so a consumer's before/after tree diff finds TWO new
      // surfaces instead of one (recoverNewId's own "expected exactly 1 new
      // surface, found 2" ambiguity path — otherwise unreachable from a
      // single synchronous fake invocation).
      if (state._simulateConcurrentCreate) {
        const raceSurf = nextId(state)
        found.pane.surface_ids.push(raceSurf)
        found.pane.surfaces.push({ id: raceSurf, pane_id: found.pane.id, type: 'markdown', tty: null, title: `${renderPath}.race` })
      }
      saveState(state)
    } else {
      // be-06-01 S7(b): `markdown open` WITHOUT --surface matches live cmux
      // (tasks/cmux-mode/spike-findings.md:228) — it creates its own new
      // pane + markdown surface rather than failing not_found. This is what
      // mountDocTab's rung 3 depends on.
      const win = state.windows[0]
      const ws = win.workspaces[0]
      const paneId = nextId(state)
      const surfId = nextId(state)
      ws.panes.push({
        id: paneId,
        workspace_id: ws.id,
        surface_ids: [surfId],
        selected_surface_id: surfId,
        surfaces: [{ id: surfId, pane_id: paneId, type: 'markdown', tty: null, title: renderPath }],
      })
      saveState(state)
    }
    // Live `markdown open` prints NOTHING — cmuxctl.mjs recovers the new
    // surface's id via tree-diff (recoverNewId), never from stdout. A fake
    // that printed the id would pass every test while breaking on the
    // first live run (qa-lead vacuity S2).
    succeed('')
    break
  }

  case 'new-surface': {
    // be-06-01 S7(a): a `new-surface` case mutating topology, env-switch-free.
    // With --pane, append a browser-type surface to that pane; without
    // --pane (i.e. with --workspace), create a new pane holding it. Prints
    // nothing — id recovery is tree-diff, exactly as `markdown open` above.
    const type = argAfter('--type') || 'browser'
    const targetPaneId = argAfter('--pane')
    const state = loadState()
    const newSurf = nextId(state)
    if (targetPaneId) {
      const targetPane = findPane(state, targetPaneId)
      if (!targetPane) fail('not_found', 'Target pane not found')
      targetPane.surfaces.push({ id: newSurf, pane_id: targetPane.id, type, tty: null, title: argAfter('--url') || '' })
      targetPane.surface_ids.push(newSurf)
    } else {
      const wsId = argAfter('--workspace')
      const entry = findWorkspaceEntry(state, wsId)
      if (!entry) fail('not_found', 'Workspace not found')
      const paneId = nextId(state)
      entry.workspace.panes.push({
        id: paneId,
        workspace_id: entry.workspace.id,
        surface_ids: [newSurf],
        selected_surface_id: newSurf,
        surfaces: [{ id: newSurf, pane_id: paneId, type, tty: null, title: argAfter('--url') || '' }],
      })
    }
    saveState(state)
    succeed('')
    break
  }

  case 'move-surface': {
    // Build 102: `[--surface <id> | <id>]` — both forms accepted, like live.
    const surfaceId = argAfter('--surface') || argv[1]
    const targetPaneId = argAfter('--pane')
    const state = loadState()
    const found = findSurfaceEntry(state, surfaceId)
    if (!found) fail('not_found', 'Surface not found')
    const targetPane = findPane(state, targetPaneId)
    if (!targetPane) fail('not_found', 'Target pane not found')
    found.pane.surfaces.splice(found.idx, 1)
    found.pane.surface_ids = found.pane.surface_ids.filter((s) => s.toLowerCase() !== surfaceId.toLowerCase())
    found.surface.pane_id = targetPane.id
    targetPane.surfaces.push(found.surface)
    targetPane.surface_ids.push(found.surface.id)
    saveState(state)
    succeed('')
    break
  }

  case 'reorder-surface': {
    // qa should-fix test hook: a PRE-SEEDED state flag (never a new env
    // switch), simulating rung 2's live-unverified file:// BROWSER surface
    // silently relocating away from the target pane between reorder-surface
    // reporting success and mountDocTab's own post-mount verification
    // re-read — otherwise unreachable from this deterministic fixture,
    // where reorder-surface itself is normally a no-op. Gated on the moved
    // surface's own type === 'browser' so this can only ever affect rung 2's
    // surface — a rung 1 (markdown) reorder-surface call must never be
    // relocated by this hook, or a future test could accidentally observe
    // rung 1 "succeeding" with a silently-relocated surface.
    const stateForVerificationFailCheck = loadState()
    if (stateForVerificationFailCheck._simulateBrowserSurfaceRelocateOnReorder) {
      const surfaceId = argAfter('--surface') || argv[1]
      const found = findSurfaceEntry(stateForVerificationFailCheck, surfaceId)
      if (found && found.surface.type === 'browser') {
        found.pane.surfaces.splice(found.idx, 1)
        found.pane.surface_ids = found.pane.surface_ids.filter((s) => s.toLowerCase() !== surfaceId.toLowerCase())
        const decoyPaneId = nextId(stateForVerificationFailCheck)
        const win = stateForVerificationFailCheck.windows[0]
        const ws = win.workspaces[0]
        found.surface.pane_id = decoyPaneId
        ws.panes.push({ id: decoyPaneId, workspace_id: ws.id, surface_ids: [surfaceId], selected_surface_id: surfaceId, surfaces: [found.surface] })
        saveState(stateForVerificationFailCheck)
      }
    }
    // Ordering itself is not asserted by any consumer of this fixture; the
    // invocation still needs to succeed and be logged.
    succeed('')
    break
  }

  case 'send': {
    // Build 102 grammar (live-verified 2026-08-12): `send [flags] [--] <text>`
    // — the surface rides a --surface FLAG. A positional surface id is NOT an
    // error on the real CLI: it silently becomes the text and the send
    // targets $CMUX_SURFACE_ID (the caller's own pane). The fixture is
    // stricter than live here on purpose — a regression to the legacy
    // positional form must FAIL tests loudly, not silently mistarget.
    const surfaceId = argAfter('--surface')
    if (!surfaceId) fail('bad_args', 'fake-cmux: send requires --surface (build-102 grammar; positional target is the legacy form)')
    const dd = argv.indexOf('--')
    const text = dd >= 0 ? argv.slice(dd + 1).join(' ') : undefined
    if (!text) fail('bad_args', 'fake-cmux: send requires -- <text>')
    const state = loadState()
    if (!findSurfaceEntry(state, surfaceId)) fail('not_found', 'Surface not found')
    // Echo state: read-screen renders the typed line so cmuxctl's
    // verified-send can confirm the echo, exactly like a live terminal.
    // APPEND, never overwrite — a real PTY concatenates a second unsubmitted
    // send onto the same input line, which is precisely the doubled-line
    // corruption the verify's exactly-once rule exists to catch; an
    // overwriting fixture would make that path structurally unmodelable
    // (deep-review Should-fix 4, 2026-08-12).
    state._typed = state._typed || {}
    const k = surfaceId.toLowerCase()
    state._typed[k] = (state._typed[k] || '') + text
    saveState(state)
    succeed('')
    break
  }

  case 'send-key': {
    // Build 102 grammar: `send-key [flags] [--] <key>` — one positional, the
    // KEY. The legacy `send-key <uuid> enter` form therefore parses the uuid
    // as the key name and fails exactly like live cmux did on 2026-08-12.
    const surfaceId = argAfter('--surface')
    if (!surfaceId) fail('bad_args', 'fake-cmux: send-key requires --surface (build-102 grammar)')
    const dd = argv.indexOf('--')
    const key = dd >= 0
      ? argv[dd + 1]
      : argv.filter((a, i) => i > 0 && a !== '--surface' && argv[i - 1] !== '--surface')[0]
    if (!key || !/^[a-z0-9+]+$/.test(key) || /^[0-9a-f-]{36}$/i.test(key)) {
      fail('bad_args', 'Unknown key')
    }
    // ctrl+u kills the current unsubmitted input line (live-verified
    // 2026-08-12) — clear the echo state so a verified-send retype starts
    // from an empty line. `enter` deliberately does NOT clear _typed: on a
    // real terminal the submitted command line stays visible in scrollback.
    if (key === 'ctrl+u') {
      const state = loadState()
      if (state._typed) {
        delete state._typed[(argAfter('--surface') || '').toLowerCase()]
        saveState(state)
      }
    }
    succeed(`OK surface:0 workspace:0`)
    break
  }

  case 'rename-tab': {
    // be-12-01 general fidelity fix (live-verified, cmux 0.64.22): rename-tab
    // is TERMINAL-surfaces-only — a browser (or any non-terminal) surface
    // fails not_found. No production caller is affected: every existing
    // caller in this repo only ever renames a terminal surface.
    // Build 102 grammar: target is a --surface flag; the title is positional
    // (after `--`).
    const surfaceId = argAfter('--surface')
    if (!surfaceId) fail('bad_args', 'fake-cmux: rename-tab requires --surface (build-102 grammar)')
    const state = loadState()
    const found = findSurfaceEntry(state, surfaceId)
    if (found && found.surface.type !== 'terminal') {
      fail('not_found', 'Tab not found')
    }
    succeed('')
    break
  }

  case 'set-status': {
    succeed('')
    break
  }

  case 'close-surface': {
    // Build 102 grammar: flags-only. A positional id on the live CLI is
    // ignored in favor of $CMUX_SURFACE_ID (the caller's own surface) —
    // live-observed closing the wrong surface on 2026-08-12. The fixture
    // hard-fails the legacy form instead of modeling the mistarget.
    // ALSO window-scoped (second live-observed quirk, same day): a UUID is
    // resolved only inside the named --window context — the fixture
    // REQUIRES the flag and validates containment, stricter than live's
    // caller-window default, so dropping --window (or passing the wrong
    // window) fails tests loudly instead of re-breaking cross-window
    // closes live (round-2 review W3).
    const id = argAfter('--surface')
    if (!id) fail('bad_args', 'fake-cmux: close-surface requires --surface (build-102 grammar; a positional id is ignored by live cmux)')
    const windowId = argAfter('--window')
    if (!windowId) fail('bad_args', 'fake-cmux: close-surface requires --window (build-102 resolves surface UUIDs window-scoped; cmuxctl must pass the containing window)')
    const state = loadState()
    const win = findWindow(state, windowId)
    if (!win) fail('not_found', 'Window not found')
    const inWindow = (win.workspaces || []).some((ws) => (ws.panes || []).some((pn) => (pn.surfaces || []).some((sf) => sf.id.toLowerCase() === id.toLowerCase())))
    if (!inWindow) fail('not_found', 'Surface not found')
    const found = findSurfaceEntry(state, id)
    if (!found) fail('not_found', 'Surface not found')
    found.pane.surfaces.splice(found.idx, 1)
    found.pane.surface_ids = found.pane.surface_ids.filter((s) => s.toLowerCase() !== id.toLowerCase())
    saveState(state)
    succeed('')
    break
  }

  case 'close-workspace': {
    // build 102 (F5, live-pass-findings.md) REFUSES a positional id — the
    // legacy verb is now an alias for `workspace close` and requires
    // `--workspace <id>`.
    const id = argAfter('--workspace')
    if (!id) fail('bad_args', 'close-workspace requires --workspace')
    const state = loadState()
    for (const w of state.windows || []) {
      const idx = (w.workspaces || []).findIndex((ws) => ws.id.toLowerCase() === (id || '').toLowerCase())
      if (idx >= 0) {
        w.workspaces.splice(idx, 1)
        saveState(state)
        succeed('')
      }
    }
    fail('not_found', 'Workspace not found')
    break
  }

  case 'top': {
    const topPath = process.env.FAKE_CMUX_TOP
    const stdout = topPath && existsSync(topPath) ? readFileSync(topPath, 'utf8') : LIVE_TOP_TSV
    succeed(stdout)
    break
  }

  case 'read-screen': {
    // FAKE_CMUX_SCREEN (triage tests) takes precedence; otherwise the frame
    // echoes whatever `send` last typed into this surface (like a real
    // terminal), so cmuxctl's verified-send finds its needle without any
    // per-test setup. Falls back to the canned frame for untouched surfaces.
    const screenPath = process.env.FAKE_CMUX_SCREEN
    if (screenPath && existsSync(screenPath)) {
      succeed(readFileSync(screenPath, 'utf8'))
    }
    const surfaceId = (argAfter('--surface') || '').toLowerCase()
    const state = loadState()
    const typed = state._typed && state._typed[surfaceId]
    succeed(typed ? `$ ${typed}\n` : '$ cmux fake screen frame\n')
    break
  }

  case 'clear-progress': {
    succeed('')
    break
  }

  case 'set-progress': {
    succeed('')
    break
  }

  case 'workspace-action': {
    succeed('')
    break
  }

  case 'events': {
    // Reject an under-specified call: a bounded read must bound itself with
    // --after and/or --limit, or it silently becomes an unbounded replay
    // (qa-lead vacuity S3).
    if (!argv.includes('--after') && !argv.includes('--limit')) {
      fail('bad_args', 'events requires --after and/or --limit')
    }
    const eventsPath = process.env.FAKE_CMUX_EVENTS
    const stdout = eventsPath && existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : ''
    // be-11-03 QA-fix test hook: models cmux's REAL live-verified behavior
    // when retained backlog cannot satisfy --limit (or --name filtering
    // narrows the match count below it) — `cmux events` BLOCKS streaming
    // live frames rather than returning early with a partial snapshot (see
    // cmuxctl.mjs's readEvents() header comment for the live capture this
    // is modeling). FAKE_CMUX_EVENTS_HANG='1' prints whatever
    // FAKE_CMUX_EVENTS holds (the "already-retained partial backlog") and
    // then hangs indefinitely — the ONLY thing that can ever terminate
    // this call is the caller's OWN spawnSync timeout, exactly like the
    // real binary's under-satisfied-limit case.
    if (process.env.FAKE_CMUX_EVENTS_HANG === '1') {
      if (stdout) {
        process.stdout.write(stdout.endsWith('\n') ? stdout : `${stdout}\n`)
      }
      logInvocation()
      const sab = new SharedArrayBuffer(4)
      Atomics.wait(new Int32Array(sab), 0, 0, 60_000) // far longer than any test's own timeoutMs
      process.exit(0)
    }
    succeed(stdout)
    break
  }

  case 'config': {
    if (argv[1] !== 'doctor') fail('bad_args', 'config: only "doctor" is supported')
    succeed('cmux config doctor: all checks passed')
    break
  }

  // be-12-01, issue #12/D1-D2, corrected fix-round-2 (F1, live-pass-findings.md):
  // the `browser` verb family's REAL grammar is surface-FIRST —
  // `browser [--surface <id>|<surface>] <subcommand> [args]`. `open` is the
  // sole surface-less sub-verb and rides directly at argv[1]; every other
  // invocation carries the surface handle at argv[1] and the sub-verb at
  // argv[2]. A sub-verb-first invocation (the pre-fix-round-2 bug) lands a
  // non-sub-verb token in the argv[2] slot, which falls through to the
  // "Unsupported browser subcommand" failure below — the SAME failure the
  // real binary produces (live-verified byte-for-byte), so a wrapper
  // regression to the old order is structurally fatal here, not merely
  // pin-dependent.
  case 'browser': {
    const state = loadState()
    const isOpen = argv[1] === 'open'
    const surfaceId = isOpen ? null : argv[1]
    const sub = isOpen ? 'open' : argv[2]

    // be-12-01 qa hooks: PRE-SEEDED state flags (never a new env switch).
    if (sub === 'open' && state._simulateBrowserOpenHang) {
      logInvocation()
      const sab = new SharedArrayBuffer(4)
      Atomics.wait(new Int32Array(sab), 0, 0, 60_000) // far longer than any test's own timeoutMs
      process.exit(0)
    }
    // Simulates a cmux-authored error code that does NOT match the
    // `^[a-z_]{1,32}$` shape guard cmuxctl.mjs's browser wrappers apply
    // before ever logging one — proves the <unparsed> fallback fires on a
    // genuinely out-of-shape code rather than being trusted blindly.
    if (state._simulateBrowserUnknownErrorCode) {
      fail('Weird Code!', 'simulated out-of-vocabulary error code')
    }

    if (sub === 'open') {
      const url = argv[2]
      const workspaceId = argAfter('--workspace')
      const entry = findWorkspaceEntry(state, workspaceId)
      if (!entry) fail('not_found', 'Workspace not found')
      let hostname = ''
      try {
        hostname = new URL(url).hostname
      } catch {
        // leave hostname blank on an unparsable url — never throws the fake
      }
      // test-engineer hook (PR-1 idempotence-check coverage gap): a
      // PRE-SEEDED state flag, never a new env switch. Models a genuine
      // concurrent topology shift the lock's spawn budget cannot prevent —
      // an EXISTING browser surface, previously excluded as a worker-pane
      // browser (e.g. a rung-2 doc-tab), silently RELOCATES out of its pane
      // into a brand-new, unclassified pane DURING this `browser open`
      // call, BEFORE the reuse-detection below runs (so this open still
      // creates a fresh split pane for OUR surface rather than stacking
      // onto the now-vacated worker pane). This must fire before
      // reuse-detection: if the pre-existing browser were still sitting in
      // its original pane at that point, `browser open` would stack onto
      // it and land OUR surface in a worker pane instead (a different,
      // already-covered outcome). Unlike `_simulateConcurrentCreate` (a
      // brand-new surface id, deliberately caught by recoverNewId's
      // before/after ambiguity check BEFORE browserOpen ever returns), a
      // RELOCATION preserves the surface's existing id, so recoverNewId
      // still finds exactly one new surface (ours) and browserOpen returns
      // successfully — the only way to drive treeAfter into showing a
      // second free browser without recoverNewId intercepting first. This
      // is what makes ensurePreviewBrowser's post-create idempotence check
      // ("a second free browser now exists elsewhere") reachable from a
      // single synchronous test process.
      if (state._simulateFreeBrowserAppearsMidCreate) {
        for (const pane of entry.workspace.panes) {
          const idx = (pane.surfaces || []).findIndex((s) => s.type === 'browser')
          if (idx >= 0) {
            const [surf] = pane.surfaces.splice(idx, 1)
            pane.surface_ids = (pane.surface_ids || []).filter((sid) => sid.toLowerCase() !== surf.id.toLowerCase())
            const relocatedPaneId = nextId(state)
            surf.pane_id = relocatedPaneId
            entry.workspace.panes.push({
              id: relocatedPaneId, workspace_id: entry.workspace.id, surface_ids: [surf.id],
              selected_surface_id: surf.id, surfaces: [surf], _pos: nextPos(state),
            })
            break
          }
        }
      }
      // `browser open --workspace` REUSES an existing browser pane rather
      // than creating a second (live-verified) — a second open in a
      // workspace already holding a browser surface prints placement=reuse
      // and STACKS a second surface into that pane.
      let targetPane = entry.workspace.panes.find((p) => (p.surfaces || []).some((s) => s.type === 'browser'))
      const placement = targetPane ? 'reuse' : 'split'
      if (!targetPane) {
        const paneId = nextId(state)
        targetPane = {
          id: paneId, workspace_id: entry.workspace.id, surface_ids: [], selected_surface_id: null,
          surfaces: [], _pos: nextPos(state),
        }
        entry.workspace.panes.push(targetPane)
      }
      const newSurf = nextId(state)
      const surfPos = nextPos(state)
      targetPane.surfaces.push({ id: newSurf, pane_id: targetPane.id, type: 'browser', tty: null, title: hostname, _pos: surfPos })
      targetPane.surface_ids.push(newSurf)
      targetPane.selected_surface_id = newSurf
      // qa should-fix test hook: a PRE-SEEDED state flag, reusing the same
      // `_simulateConcurrentCreate` key the `markdown open` case already
      // uses (fake-cmux.mjs precedent) so browserOpen's before/after tree
      // diff finds TWO new surfaces instead of one — recoverNewId's own
      // "expected exactly 1 new surface, found 2" ambiguity path.
      if (state._simulateConcurrentCreate) {
        const raceSurf = nextId(state)
        const racePos = nextPos(state)
        targetPane.surfaces.push({ id: raceSurf, pane_id: targetPane.id, type: 'browser', tty: null, title: hostname, _pos: racePos })
        targetPane.surface_ids.push(raceSurf)
      }
      saveState(state)
      succeed(`OK surface=surface:${surfPos} pane=pane:${targetPane._pos} placement=${placement}`)
      break
    }

    if (sub === 'goto') {
      // be-12-02 fix-round item 6 hook: mirrors _simulateBrowserOpenHang's
      // shape exactly — state-flag driven, no new env switch. Proves
      // browserGoto's own 20000ms spawn bound is genuinely enforced, not
      // merely typed.
      if (state._simulateBrowserGotoHang) {
        logInvocation()
        const sab = new SharedArrayBuffer(4)
        Atomics.wait(new Int32Array(sab), 0, 0, 60_000) // far longer than any test's own timeoutMs
        process.exit(0)
      }
      const url = argv[3]
      const found = findSurfaceEntry(state, surfaceId)
      if (!found) fail('not_found', 'Surface not found')
      // Simulates a dead-port navigation self-bounding at ~15.5s live —
      // modeled alongside js_error, not merged into it.
      if (state._simulateGotoNavigationTimeout) {
        fail('navigation_timeout', 'Timed out waiting for the browser document to become ready')
      }
      // A browser surface's title TRACKS THE URL HOSTNAME — set on open,
      // updated on goto (live-verified, dynamic/navigation-controlled).
      try {
        found.surface.title = new URL(url).hostname
      } catch {
        // leave the existing title alone on an unparsable url
      }
      saveState(state)
      succeed('')
      break
    }

    if (sub === 'errors') {
      const action = argv[3]
      // be-12-02 fix-round item 6 hooks: mirror _simulateBrowserOpenHang's
      // shape exactly — state-flag driven, no new env switch, one flag per
      // sub-action so clear/list never interfere with each other. Prove
      // browserErrorsClear/browserErrorsList's own 10000ms spawn bounds are
      // genuinely enforced, not merely typed.
      if (action === 'clear' && state._simulateBrowserErrorsClearHang) {
        logInvocation()
        const sab = new SharedArrayBuffer(4)
        Atomics.wait(new Int32Array(sab), 0, 0, 60_000) // far longer than any test's own timeoutMs
        process.exit(0)
      }
      if (action === 'list' && state._simulateBrowserErrorsListHang) {
        logInvocation()
        const sab = new SharedArrayBuffer(4)
        Atomics.wait(new Int32Array(sab), 0, 0, 60_000) // far longer than any test's own timeoutMs
        process.exit(0)
      }
      const found = findSurfaceEntry(state, surfaceId)
      if (!found) fail('not_found', 'Surface not found')
      // Stacked surfaces (>=2 browser-typed surfaces sharing one pane) are
      // Stacked-pair js_error rule, retained as the modeled WORST CASE:
      // live-verified pre-build-102; build 102 observed both members fully
      // drivable (live-pass-findings.md F3). The fail-closed singleton does
      // not depend on undrivability, so the fake keeps the stricter
      // behavior — errors list/clear
      // AND wait all fail identically on either one.
      const browserSiblings = (found.pane.surfaces || []).filter((s) => s.type === 'browser')
      if (browserSiblings.length >= 2) {
        fail('js_error', 'Timed out waiting for the browser document to become ready')
      }
      if (action === 'clear') {
        succeed('')
      } else if (action === 'list') {
        // be-12-03 hook: a PRE-SEEDED state flag (never a new env switch)
        // that returns an arbitrary raw payload verbatim instead of the
        // frozen clean literal — the only way to produce a dirty console
        // through this fixture. The clean literal stays the default so
        // every existing test is unaffected. `??`, never `||` (fix-round
        // panel-2 S6): an EMPTY payload (`''`) is a legitimate, distinct
        // seed a test must be able to produce — `||` would silently coerce
        // it back to the clean literal, masking the reducer's genuine
        // unrecognized-on-empty-string behaviour.
        succeed(state._simulateBrowserErrorsPayload ?? 'No browser errors')
      } else {
        fail('bad_args', `browser errors: unknown action ${action}`)
      }
      break
    }

    if (sub === 'wait') {
      // be-12-02 fix-round item 6 hook: mirrors _simulateBrowserOpenHang's
      // shape exactly — state-flag driven, no new env switch. Proves
      // browserWaitReady's own 25000ms spawn bound is genuinely enforced,
      // not merely typed.
      if (state._simulateBrowserWaitHang) {
        logInvocation()
        const sab = new SharedArrayBuffer(4)
        Atomics.wait(new Int32Array(sab), 0, 0, 60_000) // far longer than any test's own timeoutMs
        process.exit(0)
      }
      const found = findSurfaceEntry(state, surfaceId)
      if (!found) fail('not_found', 'Surface not found')
      const loadStateArg = argAfter('--load-state')
      // --load-state REJECTS wrong values — only interactive|complete
      // succeed on cmux 0.64.22 (live-verified).
      if (loadStateArg !== 'interactive' && loadStateArg !== 'complete') {
        fail('js_error', `Wait condition could not be evaluated: unsupported --load-state value ${loadStateArg}`)
      }
      const browserSiblings = (found.pane.surfaces || []).filter((s) => s.type === 'browser')
      if (browserSiblings.length >= 2) {
        fail('js_error', 'Timed out waiting for the browser document to become ready')
      }
      succeed('')
      break
    }

    if (sub === 'screenshot') {
      // be-12-02 fix-round item 6 hook: mirrors _simulateBrowserOpenHang's
      // shape exactly — state-flag driven, no new env switch. Proves
      // browserScreenshot's own 20000ms spawn bound is genuinely enforced,
      // not merely typed.
      if (state._simulateBrowserScreenshotHang) {
        logInvocation()
        const sab = new SharedArrayBuffer(4)
        Atomics.wait(new Int32Array(sab), 0, 0, 60_000) // far longer than any test's own timeoutMs
        process.exit(0)
      }
      const found = findSurfaceEntry(state, surfaceId)
      if (!found) fail('not_found', 'Surface not found')
      const outPath = argAfter('--out')
      // Models the live reality that `screenshot` still succeeds (writes a
      // full-size blank PNG) even on a stacked/never-ready surface —
      // existsSync proves a file, never a render.
      if (!state._simulateScreenshotOkNoWrite && outPath) {
        // fix-round (panel-1 S6/panel-2 S5) hook: a PRE-SEEDED state flag
        // (never a new env switch) that writes a genuinely EMPTY file
        // instead of the usual fake bytes — distinct from
        // _simulateScreenshotOkNoWrite (no file at all): this one proves
        // statSync(...).size > 0 catches a zero-byte write that a bare
        // existsSync would wrongly call a success.
        writeFileSync(outPath, state._simulateScreenshotZeroByteWrite ? '' : 'fake-png-bytes')
      }
      // `_simulateScreenshotOkNoWrite` prints OK WITHOUT writing the file —
      // proves a caller that trusts the OK line instead of existsSync fails.
      succeed(`OK ${outPath}`)
      break
    }

    // Real error shape, live-verified byte-for-byte (F1): the code segment
    // IS the message prefix — there is no separate `code:` token on this
    // failure, so `fail`'s own `code`/`message` split is deliberately used
    // here to reproduce that exact two-part line, `Error: Unsupported
    // browser subcommand: <token>`, rather than the usual `Error: <code>:
    // <message>` shape every other fixture failure uses.
    fail('Unsupported browser subcommand', sub)
    break
  }

  default: {
    fail('unknown_verb', `unknown verb: ${verb}`)
  }
}
