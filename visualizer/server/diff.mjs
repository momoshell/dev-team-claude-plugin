// Line diff helper for the agents editor proposals (moved out of the removed roster editor).
function lines(text) {
  if (text === '') return { values: [], newline: false }
  const newline = text.endsWith('\n')
  const values = text.split('\n')
  if (newline) values.pop()
  return { values, newline }
}

function rangeStart(index, count) {
  return count === 0 ? index : index + 1
}

function terminated(source, index) {
  return index < source.values.length - 1 || source.newline
}

function bodyLine(prefix, value, noNewline = false) {
  return [{ text: `${prefix}${value}` }, ...(noNewline ? [{ text: '\\ No newline at end of file', marker: true }] : [])]
}

export function unifiedDiff(beforeText, afterText, { path = 'crew/roster.json' } = {}) {
  if (beforeText === afterText) return ''
  const before = lines(beforeText), after = lines(afterText)
  const oldCount = before.values.length
  const newCount = after.values.length
  const equal = (oldIndex, newIndex) => before.values[oldIndex] === after.values[newIndex]
    && terminated(before, oldIndex) === terminated(after, newIndex)

  // Keep unchanged regions out of the patch body. Besides producing a useful
  // review diff, this prevents a schema migration from echoing the unchanged
  // model-price catalog into a proposal's API response.
  const lcs = Array.from({ length: oldCount + 1 }, () => new Uint32Array(newCount + 1))
  for (let oldIndex = oldCount - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newCount - 1; newIndex >= 0; newIndex -= 1) {
      lcs[oldIndex][newIndex] = equal(oldIndex, newIndex)
        ? lcs[oldIndex + 1][newIndex + 1] + 1
        : Math.max(lcs[oldIndex + 1][newIndex], lcs[oldIndex][newIndex + 1])
    }
  }

  const operations = []
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < oldCount || newIndex < newCount) {
    if (oldIndex < oldCount && newIndex < newCount && equal(oldIndex, newIndex)) {
      operations.push({ type: 'equal', oldIndex, newIndex })
      oldIndex += 1
      newIndex += 1
    } else if (oldIndex < oldCount && (newIndex === newCount || lcs[oldIndex + 1][newIndex] >= lcs[oldIndex][newIndex + 1])) {
      operations.push({ type: 'delete', oldIndex, newIndex })
      oldIndex += 1
    } else {
      operations.push({ type: 'add', oldIndex, newIndex })
      newIndex += 1
    }
  }

  const changed = operations.map((operation, index) => ({ operation, index })).filter(({ operation }) => operation.type !== 'equal')
  if (!changed.length) return ''
  const context = 3
  const ranges = []
  for (const { index } of changed) {
    const start = Math.max(0, index - context)
    const end = Math.min(operations.length - 1, index + context)
    const previous = ranges.at(-1)
    if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end)
    else ranges.push({ start, end })
  }

  const output = [`--- a/${path}`, `+++ b/${path}`]
  for (const { start, end } of ranges) {
    const selected = operations.slice(start, end + 1)
    const first = selected[0]
    const beforeStart = first.oldIndex
    const afterStart = first.newIndex
    const beforeLines = selected.filter((operation) => operation.type !== 'add')
    const afterLines = selected.filter((operation) => operation.type !== 'delete')
    output.push(`@@ -${rangeStart(beforeStart, beforeLines.length)},${beforeLines.length} +${rangeStart(afterStart, afterLines.length)},${afterLines.length} @@`)
    for (const operation of selected) {
      if (operation.type === 'equal') {
        const noNewline = (operation.oldIndex === oldCount - 1 && !before.newline)
          || (operation.newIndex === newCount - 1 && !after.newline)
        output.push(...bodyLine(' ', before.values[operation.oldIndex], noNewline))
      } else if (operation.type === 'delete') {
        output.push(...bodyLine('-', before.values[operation.oldIndex], operation.oldIndex === oldCount - 1 && !before.newline))
      } else {
        output.push(...bodyLine('+', after.values[operation.newIndex], operation.newIndex === newCount - 1 && !after.newline))
      }
    }
  }
  return `${output.map((entry) => typeof entry === 'string' ? entry : entry.text).join('\n')}\n`
}
