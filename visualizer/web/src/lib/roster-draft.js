const cellKey = (cell) => cell ? `${cell.provider}/${cell.id}` : null
const sameCell = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export function replaceRosterMove(baseRail, moves, move) {
  const rest = moves.filter((entry) => entry.tier !== move.tier || entry.role !== move.role)
  const original = baseRail.find((column) => column.tier === move.tier)?.seats?.find((seat) => seat.role === move.role)?.cell
  return sameCell(original, move.cell) ? rest : [...rest, move]
}

export function rosterChanges(baseRail, moves) {
  return moves.map((move) => {
    const before = baseRail.find((column) => column.tier === move.tier)?.seats?.find((seat) => seat.role === move.role)?.cell ?? null
    return { ...move, before, beforeKey:cellKey(before), afterKey:cellKey(move.cell) }
  })
}
