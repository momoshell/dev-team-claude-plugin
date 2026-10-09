import { stripVTControlCharacters } from 'node:util'

export function vitestTitlePattern(title) {
  return '^' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'
}

export function vitestSummaryPassed(output, count) {
  const summary = stripVTControlCharacters(output).split(/\r?\n/).filter((line) => /^[ \t]*Tests\b/.test(line)).at(-1) ?? ''
  const match = summary.match(/^[ \t]*Tests[ \t]+(\d+) passed(?:[ \t]+\((\d+)\))?[ \t]*$/)
  return Number.isSafeInteger(count) && count >= 0 && !!match && Number(match[1]) === count && (match[2] === undefined || Number(match[2]) === count)
}
