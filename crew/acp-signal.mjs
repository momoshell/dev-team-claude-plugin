import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'

export const SIGNAL_REFUSAL = 'refused: this command may signal a process your own commands did not start, or the gate could not check who started it. Stop only processes your own commands started, by a pid you can read.'

export function readProcessTable() {
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 1000 })
  if (result.error || result.status !== 0) throw result.error || new Error('ps failed')
  return result.stdout
}

const SIGNAL_WORD = /(^|[^\w-])(kill|pkill|killall)(?=$|[^\w-])/
// Commands that run their arguments as a command; a signalling word there is refused, since its target is not parsed here.
const runners = new Set(['eval', 'trap', 'alias', 'find', 'watch', 'parallel', 'flock', 'doas', 'su', 'runuser', 'chroot', 'stdbuf', 'ionice', 'taskset', 'caffeinate', 'script', 'unshare', 'nsenter'])
const wrappers = new Set(['xargs', 'sudo', 'env', 'command', 'builtin', 'exec', 'nohup', 'timeout', 'nice', 'time', 'setsid'])

export function signalCommandResult(command, { root, processTable = readProcessTable, refuseNested = false } = {}) {
  const allow = { allowed: true, reason: null }
  const refuse = { allowed: false, reason: SIGNAL_REFUSAL }
  if (typeof command !== 'string') return allow
  // The shell joins a backslash-newline before it reads words, so the gate does too.
  command = command.replace(/\\\n/g, '')
  // Quotes and backslashes can split a command word ('ki''ll'), and an expansion can supply one ("$k"),
  // so only a command with neither a signalling word after unquoting nor an expansion skips the parse.
  if (!SIGNAL_WORD.test(command.replace(/['"\\]/g, '')) && !/[$`*?[]/.test(command)) return allow
  let rows
  function owned(pid) {
    const seen = new Set()
    while (pid !== root) {
      if (pid <= 1 || seen.has(pid) || !rows.has(pid)) return false
      seen.add(pid)
      pid = rows.get(pid).ppid
    }
    return true
  }
  function checkTargets(targets) {
    if (!targets.length) return true
    if (!Number.isSafeInteger(root) || root <= 1) return false
    if (!rows) {
      try {
        const text = processTable()
        if (typeof text !== 'string') return false
        rows = new Map()
        for (const line of text.trim().split('\n')) {
          const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/)
          if (!match) return false
          const [pid, ppid, pgid] = match.slice(1).map(Number)
          if (![pid, ppid, pgid].every(Number.isSafeInteger)) return false
          rows.set(pid, { ppid, pgid })
        }
      } catch { return false }
    }
    if (!rows.has(root)) return false
    return targets.every((target) => {
      const n = Number(target)
      if (!Number.isSafeInteger(n) || n === -1) return false
      if (n < 0) {
        const members = [...rows].filter(([, row]) => row.pgid === -n)
        return members.length > 0 && members.every(([pid]) => owned(pid))
      }
      return rows.has(n) && owned(n)
    })
  }
  function segment(words, piped) {
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || ['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!'].includes(words[0]))) words.shift()
    if (!words.length) return true
    // A command word that comes from an expansion or a glob, or an argument a wrapper or runner may run as one, cannot be checked.
    if (/[$`*?[]/.test(words[0])) return false
    const name = basename(words[0])
    if ((wrappers.has(name) || runners.has(name)) && words.slice(1).some((word) => /[$`]/.test(word))) return false
    if ((wrappers.has(name) || (refuseNested && runners.has(name))) && words.slice(1).some((word) => SIGNAL_WORD.test(word))) return false
    if (['sh', 'bash', 'zsh'].includes(name)) {
      const index = words.findIndex((word, i) => i > 0 && /^-[^-]*c/.test(word))
      if (index >= 0 && words[index + 1] !== undefined && !parse(words[index + 1])) return false
    }
    if (name === 'pkill' || name === 'killall') return false
    if (name !== 'kill') return true
    if (piped) return false
    let args = words.slice(1)
    if (args[0] === '-l' || args[0] === '-L') return args.length === 1
    if (args[0] === '-1' && args.length === 1) return false
    if (args[0] === '-s' || args[0] === '-n') {
      if (args.length < 2) return false
      args = args.slice(2)
    } else if (args[0] && /^-(?!-)[A-Za-z0-9]+$/.test(args[0])) args = args.slice(1)
    if (args[0] === '--') args = args.slice(1)
    const targets = []
    for (const arg of args) {
      if (arg === '0' || arg === '$!' || /^%[^\s]+$/.test(arg)) continue
      if (!/^-?\d+$/.test(arg)) return false
      targets.push(arg)
    }
    return checkTargets(targets)
  }
  function parse(text) {
    let words = [], token = '', started = false, quote = null, piped = false, redirect = false
    const heredocs = []
    const finish = () => { if (started) { if (!redirect) words.push(token); redirect = false }; token = ''; started = false }
    const close = (pipe) => { finish(); const ok = !redirect && segment(words, piped); words = []; piped = pipe; return ok }
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (c === '\\' && quote !== "'") {
        if (++i >= text.length) return false
        token += text[i]; started = true; continue
      }
      if (quote === "'") {
        if (c === "'") quote = null
        else token += c
        started = true; continue
      }
      if (c === '"') { quote = quote ? null : '"'; started = true; continue }
      if (!quote && c === "'") { quote = "'"; started = true; continue }
      if (c === '`' || (c === '$' && text[i + 1] === '(')) {
        const backtick = c === '`', start = i + (backtick ? 1 : 2)
        let j = start, depth = 1, q = null
        for (; j < text.length; j++) {
          const ch = text[j]
          if (ch === '\\' && q !== "'") { j++; continue }
          if (q) { if (ch === q) q = null; continue }
          if (ch === "'" || ch === '"') { q = ch; continue }
          if (backtick ? ch === '`' : ch === ')') { if (--depth === 0) break }
          else if (!backtick && ch === '(') depth++
        }
        if (j >= text.length || !parse(text.slice(start, j))) return false
        token += text.slice(i, j + 1); started = true; i = j; continue
      }
      if (!quote && c === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
        const match = text.slice(i).match(/^<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|([^\s;|&<>]+))/)
        if (!match) return false
        heredocs.push({ delimiter: match[2] ?? match[3] ?? match[4], tabs: !!match[1], expand: match[4] !== undefined })
        i += match[0].length - 1; continue
      }
      if (!quote && (c === '<' || c === '>')) {
        if (started && /^\d+$/.test(token)) { token = ''; started = false } else finish()
        if (redirect) return false
        redirect = true
        if (text[i + 1] === c || text[i + 1] === '&' || text[i + 1] === '|') i++
        continue
      }
      if (!quote && (c === '(' || c === ')' || c === '{' || c === '}')) {
        if (!close(false)) return false
        continue
      }
      if (!quote && (c === ';' || c === '|' || c === '&' || c === '\n')) {
        if (!close(c === '|' && text[i + 1] !== '|')) return false
        if ((c === '|' || c === '&') && text[i + 1] === c) i++
        if (c === '\n') for (const doc of heredocs.splice(0)) {
          let found = false, body = ''
          while (i + 1 < text.length) {
            const end = text.indexOf('\n', i + 1), last = end < 0 ? text.length : end
            let line = text.slice(i + 1, last)
            if (doc.tabs) line = line.replace(/^\t+/, '')
            i = last
            if (line === doc.delimiter) { found = true; break }
            body += line + '\n'
          }
          if (!found || (doc.expand && !parse(`echo "${body.replaceAll('"', '\\"')}"`))) return false
        }
        continue
      }
      if (!quote && c === '#' && !started) {
        const end = text.indexOf('\n', i)
        if (end < 0) break
        i = end - 1; continue
      }
      if (!quote && /\s/.test(c)) { finish(); continue }
      token += c; started = true
    }
    if (quote || heredocs.length) return false
    return close(false)
  }
  return parse(command) ? allow : refuse
}
