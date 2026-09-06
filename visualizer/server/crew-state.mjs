// Crew state as MEASURED from the crew root. #953 — the fleet view rendered an archived lane
// as work in progress because nothing ever carried the archive fact into the row. This module
// is the measurement half: it answers three values and never two — true, false, or null with
// a stated reason.
//
// IDENTITY, NOT NAME. A directory belongs to this run only when its own ledger/run.json says
// so. journal-source.mjs:34-44 and returns-source.mjs:44-50 resolve the same way, and
// ~/.crew/dt-b313-waitextend proves why: two runs of ONE task slug, each with its own
// archive, so a slug-only reader gives the older row the newer row's archive time and states
// it to the operator as fact. Where those two modules fall back to an unverified directory
// (#718) — they must serve SOMETHING — this module answers null with a reason, because a
// fleet verdict is a claim about what is true, not a best-effort pick.
//
// NO READ FAILURE IS EVER READ AS ABSENCE. Every probe on the way to a verdict is tri-state:
// the crew-root listing, the repo-parent listing, a candidate's TYPE, and a candidate's
// identity marker. A candidate whose type or marker could not be read is UNKNOWN, never
// "not mine" — it may be this run in the opposite state. So a boolean is returned only once
// every OPPOSITE-state candidate is absent, positively another run, or positively not a
// directory. A matching archive beside a live path this module could not type or identify is
// null; so is a matching live directory beside such an archive.
//
// It opens no file it did not name, writes nothing, and never infers settlement: an archived
// state dir beside a live one carrying the SAME adw_id is UNMEASURED, not finished (#953
// ask 4).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const CREW_ROOT_UNCONFIGURED = "not measured — this feed was not configured with a crew state root, so whether this run's task directory is archived was never read"
const ARCHIVE_INSTANT_UNMEASURED = "this lane's task directory is archived, but WHEN was not measured: no archive directory carrying this run's marker has a parsable instant in its name"

// Mirrored from journal-source.mjs:6-8 rather than imported, so this module keeps its own
// door: a repo_slug or task_slug that is not a single path segment is never joined onto the
// crew state root.
function validSegment(value) {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\')
}

// `b456-fffgrant.archive-2026-09-05T22-15-38-543Z` — closeout writes the instant with its
// punctuation flattened to hyphens. A suffix that does not parse is not an error: the
// directory is still an archive, its instant is simply unmeasured.
function archiveInstant(suffix) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(suffix)
  if (!match) return null
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`
  return Number.isFinite(Date.parse(iso)) ? iso : null
}

function describe(candidates) {
  return candidates.map((candidate) => `${candidate.name} → ${candidate.adw_id ? `adw_id ${candidate.adw_id}` : candidate.error}`).join('; ')
}

// `deps` is injected so a test can COUNT reads and can make one path fail. The per-call
// listing budget below is a property of this module — /api/sessions is unbounded and
// App.svelte re-requests it every three seconds — and a claim about read counts that nothing
// counts is not a measurement. Production passes nothing and gets node:fs.
export function createCrewStateSource({ crewRoot = null, deps = {} } = {}) {
  const readdir = deps.readdirSync || readdirSync
  const stat = deps.statSync || statSync
  const readFile = deps.readFileSync || readFileSync
  const root = crewRoot ? resolve(crewRoot) : null

  // The read failure is CARRIED, not swallowed: a directory nobody could list and a directory
  // that is simply empty are different facts and the row must be able to say which.
  function listDir(path) {
    try { return { names: readdir(path), error: null } } catch (error) { return { names: null, error: error?.code || error?.message || String(error) } }
  }

  // TRI-STATE, not a boolean. A stat that threw is `unknown`, never `non-directory`: a listed
  // path this module could not type may still be a crew state directory of this very run, and
  // an unreadable type probe is no stronger evidence of absence than an unreadable marker.
  function probeType(path) {
    try { return { kind: stat(path).isDirectory() ? 'directory' : 'non-directory', error: null } }
    catch (error) { return { kind: 'unknown', error: error?.code || error?.message || String(error) } }
  }

  function markerFor(path) {
    let text
    try { text = readFile(join(path, 'ledger', 'run.json'), 'utf8') } catch (error) { return { adw_id: null, error: error?.code || error?.message || String(error) } }
    let value
    try { value = JSON.parse(text) } catch (error) { return { adw_id: null, error: `ledger/run.json is malformed: ${error?.message || String(error)}` } }
    if (!value || typeof value.adw_id !== 'string' || !value.adw_id) return { adw_id: null, error: 'ledger/run.json carries no adw_id' }
    return { adw_id: value.adw_id, error: null }
  }

  function resolveOne(session, context) {
    const { repo_slug, task_slug, adw_id } = session
    const unmeasured = (reason) => ({ archived: null, archived_at: null, archive_dir: null, reason, observed_at: context.observed_at })
    if (!root) return unmeasured(CREW_ROOT_UNCONFIGURED)
    if (!validSegment(repo_slug) || !validSegment(task_slug)) return unmeasured(`not measured — ${JSON.stringify(repo_slug ?? null)}/${JSON.stringify(task_slug ?? null)} is not a usable crew state directory name`)
    const parent = resolve(root, repo_slug)
    if (!parent.startsWith(`${root}${sep}`)) return unmeasured(`not measured — ${repo_slug} does not resolve inside the crew state root`)
    if (!context.parents.has(repo_slug)) context.parents.set(repo_slug, listDir(parent))
    const parentList = context.parents.get(repo_slug)
    const repoArchives = context.rootList.names ? context.rootList.names.filter((name) => name.startsWith(`${repo_slug}.archive-`)) : []
    if (parentList.names === null) {
      return unmeasured(repoArchives.length
        ? `not measured — ${parent} could not be read (${parentList.error}) and ${repoArchives.join(', ')} at the crew state root is an archival form this reader does not recognise`
        : `not measured — ${parent} could not be read: ${parentList.error}`)
    }
    // Every listed candidate is KEPT and classified. `untyped` and `unknown` are both unknown
    // identity — one because the path could not be typed, one because its marker could not be
    // read — and they are held apart only so each carries its own kill-mutation.
    const classify = (name) => {
      const type = context.type(join(parent, name))
      if (type.kind === 'unknown') return { name, kind: 'untyped', adw_id: null, error: `its type could not be probed (${type.error}), so it may be this run in the opposite state` }
      if (type.kind === 'non-directory') return { name, kind: 'not-a-directory', adw_id: null, error: 'not a directory' }
      const found = context.marker(join(parent, name))
      if (found.adw_id === null) return { name, kind: 'unknown', adw_id: null, error: `no usable run marker (${found.error})` }
      return { name, kind: found.adw_id === adw_id ? 'matching' : 'other-run', adw_id: found.adw_id, error: null }
    }
    const archives = parentList.names.filter((name) => name.startsWith(`${task_slug}.archive-`)).sort().map(classify)
    const live = (parentList.names.includes(task_slug) ? [task_slug] : []).map(classify)
    const matchedArchives = archives.filter((candidate) => candidate.kind === 'matching')
    const matchedLive = live.filter((candidate) => candidate.kind === 'matching')
    const unknownArchives = archives.filter((candidate) => candidate.kind === 'unknown')
    const unknownLive = live.filter((candidate) => candidate.kind === 'unknown')
    const untypedArchives = archives.filter((candidate) => candidate.kind === 'untyped')
    const untypedLive = live.filter((candidate) => candidate.kind === 'untyped')
    // #953 ask 4 — this run's marker in a live dir AND in an archive. Which one it is using
    // now cannot be told from the disk. Unmeasured, never true, and never finished.
    if (matchedLive.length && matchedArchives.length) {
      return unmeasured(`not measured — ${parent} holds both a live ${task_slug} directory and ${matchedArchives.map((candidate) => candidate.name).join(', ')} carrying this run's marker ${adw_id}, and which one it is using now cannot be told from the disk`)
    }
    // A matching archive is not enough while a live candidate cannot be identified: that
    // directory may be this same run, still going, which is the more alarming case (#953 ask 4).
    if (matchedArchives.length && unknownLive.length) {
      return unmeasured(`not measured — ${parent} holds an archive carrying this run's marker ${adw_id}, but its live ${task_slug} directory could not be identified and may be this same run: ${describe(unknownLive)}`)
    }
    // The same, one probe earlier: the live candidate's TYPE could not be read.
    if (matchedArchives.length && untypedLive.length) {
      return unmeasured(`not measured — ${parent} holds an archive carrying this run's marker ${adw_id}, but its live ${task_slug} candidate could not be typed: ${describe(untypedLive)}`)
    }
    if (matchedArchives.length) {
      const stamped = matchedArchives.map((candidate) => ({ name: candidate.name, at: archiveInstant(candidate.name.slice(`${task_slug}.archive-`.length)) }))
      // The newest PARSABLE archive of THIS run, not the newest NAME: a .recovery-copy sorts
      // last and carries no instant, and dt-b456-fffgrant on disk today is exactly that shape.
      const dated = stamped.filter((entry) => entry.at !== null).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      const chosen = dated.at(-1) ?? null
      const archived_at = chosen ? chosen.at : null
      return {
        archived: true,
        archived_at,
        archive_dir: join(parent, chosen ? chosen.name : matchedArchives.at(-1).name),
        reason: archived_at === null ? ARCHIVE_INSTANT_UNMEASURED : null,
        observed_at: context.observed_at,
      }
    }
    // The mirror image: a live directory is not a measured "not archived" while an archive
    // candidate cannot be identified, because that archive may be this same run.
    if (matchedLive.length && unknownArchives.length) {
      return unmeasured(`not measured — ${parent} holds a live ${task_slug} directory carrying this run's marker ${adw_id}, but an archive candidate could not be identified and may be this same run: ${describe(unknownArchives)}`)
    }
    // The same, one probe earlier: the archive candidate's TYPE could not be read.
    if (matchedLive.length && untypedArchives.length) {
      return unmeasured(`not measured — ${parent} holds a live ${task_slug} directory carrying this run's marker ${adw_id}, but an archive candidate could not be typed: ${describe(untypedArchives)}`)
    }
    // A crew state root that could not be LISTED cannot rule out a repo-level archive, so it
    // can never support a measured false — the same hazard the repo-slug branch below handles.
    if (context.rootList.names === null) {
      return unmeasured(`not measured — the crew state root ${root} could not be read (${context.rootList.error}), so a repo-level archive of ${repo_slug} cannot be ruled out`)
    }
    // Checked BEFORE the measured false: a live directory is not the whole story when the
    // repo itself was archived under a form this reader does not recognise.
    if (repoArchives.length) {
      return unmeasured(`not measured — ${parent} holds no ${task_slug}.archive- directory carrying this run's marker, while ${repoArchives.join(', ')} at the crew state root is an archival form this reader does not recognise`)
    }
    if (matchedLive.length) return { archived: false, archived_at: null, archive_dir: null, reason: null, observed_at: context.observed_at }
    const candidates = [...archives, ...live]
    return unmeasured(candidates.length
      ? `not measured — no directory under ${parent} carries this run's marker ${adw_id}: ${describe(candidates)}`
      : `not measured — ${parent} holds neither a ${task_slug} directory nor any ${task_slug}.archive- directory`)
  }

  function readCrewStates(sessions = []) {
    const observed_at = new Date().toISOString()
    const rows = Array.isArray(sessions) ? sessions : []
    const states = new Map()
    // ONE listing of the crew state root per call, ONE per distinct repo, and ONE type probe
    // and ONE marker read of each candidate directory — shared by every session in the call.
    const markers = new Map()
    const types = new Map()
    const context = {
      observed_at,
      rootList: root ? listDir(root) : { names: null, error: null },
      parents: new Map(),
      marker: (path) => {
        if (!markers.has(path)) markers.set(path, markerFor(path))
        return markers.get(path)
      },
      type: (path) => {
        if (!types.has(path)) types.set(path, probeType(path))
        return types.get(path)
      },
    }
    for (const session of rows) {
      if (!session || session.adw_id == null) continue
      states.set(session.adw_id, resolveOne(session, context))
    }
    return states
  }

  return { readCrewStates, health: () => ({ crew_root: root, readonly: true }) }
}
