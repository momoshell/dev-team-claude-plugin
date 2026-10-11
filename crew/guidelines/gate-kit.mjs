import { stripVTControlCharacters } from 'node:util'

export function vitestTitlePattern(title) {
  return '(?:^|\\s)' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'
}

export function vitestSummaryPassed(output, count, options) {
  const summary = stripVTControlCharacters(output).split(/\r?\n/).filter((line) => /^[ \t]*Tests\b/.test(line)).at(-1) ?? ''
  if (options?.filtered === true) {
    const match = summary.match(/^[ \t]*Tests[ \t]+(\d+) passed(?:[ \t]+\|[ \t]+(\d+) skipped)?(?:[ \t]+\((\d+)\))?[ \t]*$/)
    return Number.isSafeInteger(count) && count >= 1 && !!match && Number(match[1]) === count && (match[3] === undefined || Number(match[3]) === Number(match[1]) + Number(match[2] ?? 0))
  }
  const match = summary.match(/^[ \t]*Tests[ \t]+(\d+) passed(?:[ \t]+\((\d+)\))?[ \t]*$/)
  return Number.isSafeInteger(count) && count >= 0 && !!match && Number(match[1]) === count && (match[2] === undefined || Number(match[2]) === count)
}
