// Shared fake-io harness for the h3-states reproductions.
// Adapted verbatim in shape from crew/drive.test.mjs:45-140 so a reproduction
// exercises exactly the io contract the shipped tests exercise.
// REPO is the SCRATCH copy (git archive HEAD), never the checkout.
export const REPO = process.env.H3_REPO
  || '/private/tmp/claude-501/-Users-x-Development-dt-s3-prose/9755775f-32a1-45f8-a7e9-d81e1675924f/scratchpad/repo'

export const TD = '/tmp/fake-task'
export const CTX = Object.freeze({
  task: 't1', briefFile: '/tmp/brief.md', taskDir: TD, checkout: '/tmp/repo',
  roles: ['lead', 'planner', 'builder', 'reviewer'], lane: null, suite: 'suite-cmd',
})

export async function load() {
  return await import(`${REPO}/crew/drive.mjs`)
}

export function fakeIo(drive, {
  envelopes = {}, runs = {}, changed = [], cleanRuns = null, cleanThrows = false,
  files = {}, reseat = null, gh = null, emit = false, throwOn = null, throwWrites = [],
} = {}) {
  const { gateReapOriginal, GATE_REAP_SWEEP_MARKER } = drive
  const calls = { assign: [], run: [], runClean: [], sweeps: [], reseat: [], commits: [], writes: {}, writeLog: [], logs: [], emits: [], gh: [], waits: [], stages: [], files }
  const counts = {}
  const writeCounts = {}
  const changedQueue = Array.isArray(changed[0]) ? [...changed] : [changed]
  const io = {
    calls,
    assign({ role, briefFile, note }) {
      counts[role] = (counts[role] || 0) + 1
      calls.assign.push({ role, briefFile, note, n: counts[role] })
      return { id: `${role}${counts[role]}`, returnPath: `${role}:${counts[role]}` }
    },
    wait(returnPath, timeoutS) {
      calls.waits.push({ returnPath, timeoutS })
      const env = envelopes[returnPath]
      return typeof env === 'function' ? env() : env ?? null
    },
    writeFile(path, content) {
      if (throwWrites.includes(path)) throw new Error('writeFile: report truncation failed')
      if (path.startsWith(`${CTX.checkout}/`)) {
        writeCounts[path] = (writeCounts[path] || 0) + 1
        if (throwOn === 'apply' && writeCounts[path] % 2 === 1) throw new Error('writeFile: read-only filesystem')
        if (throwOn === 'restore' && writeCounts[path] % 2 === 0) throw new Error('writeFile: the restore write failed')
      }
      calls.writes[path] = content
      calls.writeLog.push({ path, content })
      files[path] = content
    },
    readFile(p) {
      if (throwOn === 'read' && p.startsWith(`${CTX.checkout}/`)) throw new Error('readFile: permission denied')
      if (Object.prototype.hasOwnProperty.call(files, p)) return files[p]
      if (/gate-reap\.\d+\.json$/.test(p)) return '{"pgid":"4242","outcome":"already-dead","reason":"probe-dead","signals":0,"survivors":""}'
      return null
    },
    run(cmd) {
      if (String(cmd).includes(GATE_REAP_SWEEP_MARKER)) { calls.sweeps.push(cmd); return { ok: true, output: '' } }
      const original = gateReapOriginal(cmd)
      counts[original] = (counts[original] || 0) + 1
      calls.run.push({ cmd: original, n: counts[original] })
      const r = runs[`${original}:${counts[original]}`] ?? runs[original] ?? { ok: true, output: '' }
      return r
    },
    changedFiles() { return changedQueue.length > 1 ? changedQueue.shift() : changedQueue[0] },
    commit(files, message) { calls.commits.push({ files, message }); return 'abc1234' },
    status(label) { calls.stages.push(label) },
    log(obj) { calls.logs.push(obj) },
    now() { return 0 },
  }
  if (cleanRuns || cleanThrows) {
    io.runClean = function runClean(cmd) {
      const original = gateReapOriginal(cmd)
      counts[`clean:${original}`] = (counts[`clean:${original}`] || 0) + 1
      calls.runClean.push({ cmd: original, n: counts[`clean:${original}`] })
      if (cleanThrows) throw new Error('runClean: git stash pop FAILED')
      return cleanRuns[`${original}:${counts[`clean:${original}`]}`] ?? cleanRuns[original] ?? { ok: false, output: '' }
    }
  }
  if (emit) io.emit = (event) => { calls.emits.push(event) }
  if (reseat) io.reseat = (role, options) => { calls.reseat.push({ role, options }); return reseat(role, options) }
  if (gh) {
    const spec = gh === true ? {} : gh
    io.createIssue = (args) => {
      const index = calls.gh.filter((c) => c.method === 'createIssue').length + 1
      calls.gh.push({ method: 'createIssue', args, index })
      if (typeof spec.createIssue === 'function') return spec.createIssue(args, index)
      return { number: 700 + index, url: `https://example.invalid/issues/${700 + index}` }
    }
    io.createDraftPr = (args) => {
      const index = calls.gh.filter((c) => c.method === 'createDraftPr').length + 1
      calls.gh.push({ method: 'createDraftPr', args, index })
      if (typeof spec.createDraftPr === 'function') return spec.createDraftPr(args, index)
      return { number: 42, url: 'https://example.invalid/pr/42' }
    }
  }
  return io
}

export const GS = (total, failed, errored = 0) =>
  `GATE-SUMMARY {"total":${total},"failed":${failed},"errored":${errored}}`
