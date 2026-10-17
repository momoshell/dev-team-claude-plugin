#!/usr/bin/env node
// prose-lint — mechanical half of the prose-plain adaptation: banned filler words,
// em-dash density, and recap endings. Report-only: wired into no gate, hook, npm
// script or driver path, so a clean run is not proof the prose is good, only that
// the mechanical patterns are absent.
//
// Blind spots, stated not omitted: colon-reveal is not shipped (a line-start
// heuristic flagged 4 of 50 PR bodies, all 4 legitimate colons) and
// binary-contrast is not shipped (a heuristic hit 0 of 100 corpus items, so its
// precision is unmeasurable).
import { readFileSync } from 'node:fs'
import { stripPromptClaims } from '../../crew/prompt-claim.mjs'

// Upstream banned-outright list minus harness, this repo noun (mutation harness,
// 28 uses): flagging it would drown the signal.
export const BANNED_WORDS = Object.freeze(['delve', 'foster', 'leverage', 'utilize', 'facilitate', 'empower', 'streamline', 'robust', 'cutting-edge', 'paradigm shift', 'game changer', 'this is huge', 'this changes everything', 'tapestry', 'realm', 'beacon', 'multifaceted', 'meticulous', 'intricate', 'paramount', 'transformative', 'elevate', 'embark', 'supercharge', 'ever-evolving'])
export const EM_DASH_LIMIT = 2
export const USAGE_EXIT = 2
export const RECAP_OPENERS = Object.freeze(['In conclusion', 'Ultimately', 'Overall', 'In summary', 'To sum up'])

const DASH = String.fromCharCode(8212)
const escapeRegExp = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
const BANNED_PATTERNS = BANNED_WORDS.map((word, index) => ({ index, re: new RegExp('\\b' + escapeRegExp(word) + '\\b', 'i') }))

const stripInlineCode = (line) => line.replace(/\x60\x60.*?\x60\x60/g, '').replace(/\x60[^\x60]*?\x60/g, '')
const isPromptClaimLine = (line) => line.trim() !== '' && stripPromptClaims(line) === ''

// Pure line function: split lines (strip trailing CR); track fenced blocks (a line
// whose trimmed start is a triple backtick or triple tilde toggles, fence lines
// skipped); skip indented blocks; strip inline code (double-backtick spans first,
// then single-backtick spans) before any rule runs.
export function lintText(text, source) {
  const findings = []
  const rawLines = String(text ?? '').split('\n')
  const stripped = []
  const promptClaim = []
  let inFence = false
  for (const raw of rawLines) {
    const line = raw.replace(/\r$/, '')
    const trimmedStart = line.trimStart()
    const fence = String.fromCharCode(96, 96, 96)
    if (trimmedStart.startsWith(fence) || trimmedStart.startsWith('~~~')) {
      inFence = !inFence
      stripped.push(null)
      promptClaim.push(false)
      continue
    }
    if (inFence || /^( {4}|\t)/.test(line)) {
      stripped.push(null)
      promptClaim.push(false)
      continue
    }
    stripped.push(stripInlineCode(line))
    promptClaim.push(isPromptClaimLine(line))
  }
  stripped.forEach((line, i) => {
    if (line === null) return
    for (const entry of BANNED_PATTERNS) {
      const match = entry.re.exec(line)
      if (match) findings.push({ source, line: i + 1, rule: 'banned-word', detail: match[0], order: entry.index })
    }
  })
  const dashLines = []
  stripped.forEach((line, i) => {
    if (line === null || promptClaim[i]) return
    if (line.includes(DASH)) dashLines.push(i + 1)
  })
  if (dashLines.length > EM_DASH_LIMIT) {
    for (const line of dashLines) findings.push({ source, line, rule: 'em-dash', detail: 'document has ' + dashLines.length + ' em-dash lines (limit ' + EM_DASH_LIMIT + ')', order: 0 })
  }
  let last = -1
  stripped.forEach((line, i) => {
    if (line === null || line.trim() === '') return
    last = i
  })
  if (last !== -1) {
    const trimmed = stripped[last].trim()
    for (const opener of RECAP_OPENERS) {
      const head = trimmed.slice(0, opener.length)
      const rest = trimmed.slice(opener.length)
      if (head.toLowerCase() === opener.toLowerCase() && (rest === '' || /[^A-Za-z]/.test(rest[0]))) {
        findings.push({ source, line: last + 1, rule: 'recap-ending', detail: head, order: 0 })
        break
      }
    }
  }
  const rank = { 'banned-word': 0, 'em-dash': 1, 'recap-ending': 2 }
  findings.sort((a, b) => a.line - b.line || rank[a.rule] - rank[b.rule] || a.order - b.order)
  return findings.map(({ source, line, rule, detail }) => ({ source, line, rule, detail }))
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length > 1) {
    process.stderr.write('usage: prose-lint [file]\n')
    return USAGE_EXIT
  }
  let text
  let source
  if (argv.length === 1) {
    source = argv[0]
    try {
      text = readFileSync(source, 'utf8')
    } catch (err) {
      process.stderr.write('prose-lint: cannot read ' + source + ': ' + (err.code || err.message) + '\n')
      return USAGE_EXIT
    }
  } else {
    source = '<stdin>'
    try {
      text = readFileSync(0, 'utf8')
    } catch (err) {
      process.stderr.write('prose-lint: cannot read <stdin>: ' + (err.code || err.message) + '\n')
      return USAGE_EXIT
    }
  }
  const findings = lintText(text, source)
  for (const finding of findings) process.stdout.write(finding.source + ':' + finding.line + ': ' + finding.rule + ': ' + finding.detail + '\n')
  return findings.length > 0 ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main()
