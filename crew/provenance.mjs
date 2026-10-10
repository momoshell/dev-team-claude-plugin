import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { repoKeyFor } from '../scripts/factory/probe-repo.mjs'

export const PLUGIN_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
export const PLUGIN_ABSENT_REASONS = Object.freeze(['not_git_checkout', 'head_unreadable', 'dirty_unreadable', 'git_failed'])
export const REPO_KEY_ABSENT_REASONS = Object.freeze(['not_git_checkout', 'origin_missing', 'origin_unparseable', 'git_failed', 'legacy_boot', 'boot_unreadable', 'boot_invalid'])

function defaultGit(args, options = {}) {
  try {
    return spawnSync('git', args, { ...options, timeout: 5000, encoding: 'utf8', env: { ...process.env, ...(options.env || {}), GIT_OPTIONAL_LOCKS: '0' } })
  } catch (error) {
    return { status: null, stdout: '', stderr: '', error }
  }
}

function samePath(a, b) {
  try { return realpathSync(a) === realpathSync(b) } catch { return null }
}

function run(git, root, args) {
  let result
  try {
    result = git(args, { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 5000, encoding: 'utf8' })
  } catch (error) {
    return { failed: true, error }
  }
  if (!result || result.error || result.signal || result.status == null) return { failed: true }
  return { status: result.status, stdout: typeof result.stdout === 'string' ? result.stdout : '', failed: false }
}

export function pluginProvenance({ root = PLUGIN_ROOT, git = defaultGit } = {}) {
  try {
    const inside = run(git, root, ['rev-parse', '--is-inside-work-tree'])
    if (inside.failed || (inside.status !== 0 && inside.stdout.trim())) return { plugin_root: root, plugin_sha: null, plugin_dirty: null, absent_reason: 'git_failed' }
    if (inside.status !== 0 || inside.stdout.trim() !== 'true') return { plugin_root: root, plugin_sha: null, plugin_dirty: null, absent_reason: 'not_git_checkout' }
    // A plugin copied inside another checkout is not its own checkout: never report the host repository's HEAD.
    const top = run(git, root, ['rev-parse', '--show-toplevel'])
    if (top.failed || top.status !== 0) return { plugin_root: root, plugin_sha: null, plugin_dirty: null, absent_reason: 'git_failed' }
    if (samePath(top.stdout.replace(/\r?\n$/, ''), root) !== true) return { plugin_root: root, plugin_sha: null, plugin_dirty: null, absent_reason: 'not_git_checkout' }
    const head = run(git, root, ['rev-parse', 'HEAD'])
    const sha = head.stdout.trim()
    if (head.failed || head.status !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) return { plugin_root: root, plugin_sha: null, plugin_dirty: null, absent_reason: head.failed ? 'git_failed' : 'head_unreadable' }
    const status = run(git, root, ['status', '--porcelain', '--untracked-files=no'])
    // An unreadable status is unmeasured dirtiness: null, never a guess from partial output.
    if (status.failed || status.status !== 0) return { plugin_root: root, plugin_sha: sha, plugin_dirty: null, absent_reason: 'dirty_unreadable' }
    return { plugin_root: root, plugin_sha: sha, plugin_dirty: status.stdout.length > 0, absent_reason: null }
  } catch {
    return { plugin_root: root, plugin_sha: null, plugin_dirty: null, absent_reason: 'git_failed' }
  }
}

export function repoKeyRecord({ checkout, git = defaultGit } = {}) {
  try {
    const inside = run(git, checkout, ['rev-parse', '--is-inside-work-tree'])
    if (inside.failed) return { repo_key: null, repo_key_absent_reason: 'git_failed' }
    if (inside.status !== 0 || inside.stdout.trim() !== 'true') return { repo_key: null, repo_key_absent_reason: 'not_git_checkout' }
    const remote = run(git, checkout, ['remote', 'get-url', 'origin'])
    if (remote.failed) return { repo_key: null, repo_key_absent_reason: 'git_failed' }
    if (remote.status !== 0) {
      // origin_missing only when the remote list is readable and has no origin; a failed probe is git_failed.
      const list = run(git, checkout, ['remote'])
      if (list.failed || list.status !== 0) return { repo_key: null, repo_key_absent_reason: 'git_failed' }
      return { repo_key: null, repo_key_absent_reason: list.stdout.split('\n').map((name) => name.trim()).includes('origin') ? 'git_failed' : 'origin_missing' }
    }
    if (!remote.stdout.trim()) return { repo_key: null, repo_key_absent_reason: 'origin_unparseable' }
    const key = repoKeyFor({ checkout, git: (root, args) => {
      // repoKeyFor's injected runner follows gitOutput's root-first convention.
      const result = git(args, { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 5000, encoding: 'utf8' })
      return result?.status === 0 ? result.stdout : ''
    } })
    if (typeof key !== 'string' || key.startsWith('local__') || !/^[a-z0-9][a-z0-9-]*__[a-z0-9][a-z0-9-]*$/.test(key)) return { repo_key: null, repo_key_absent_reason: 'origin_unparseable' }
    const measuredKey = key
    return { repo_key: measuredKey, repo_key_absent_reason: null }
  } catch {
    return { repo_key: null, repo_key_absent_reason: 'git_failed' }
  }
}
