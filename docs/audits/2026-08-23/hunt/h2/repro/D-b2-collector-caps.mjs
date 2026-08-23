// B2: exact cap boundaries of createStreamCollector, and the cost per line of
// the two accumulators that consume it (appendOutput / appendSuite in lab.ts).
import { createStreamCollector, LAB_FRAME_QUEUE_MAX, LAB_RESIDUAL_CAP_BYTES, LAB_STREAM_CAP_BYTES, LAB_OUTPUT_CAP_BYTES, LAB_OUTPUT_CAP_LINES, boundLabText } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/pi/extensions/lab.ts'

const mk = (over = {}) => {
  const s = { lines: 0, overflow: 0 }
  const c = createStreamCollector({
    capBytes: LAB_STREAM_CAP_BYTES, residualCapBytes: LAB_RESIDUAL_CAP_BYTES, frameQueueMax: LAB_FRAME_QUEUE_MAX,
    onLine: () => { s.lines += 1 }, onOverflow: () => { s.overflow += 1 }, ...over,
  })
  return { c, s }
}
console.log('--- frame queue boundary (nothing served) ---')
for (const n of [LAB_FRAME_QUEUE_MAX - 1, LAB_FRAME_QUEUE_MAX, LAB_FRAME_QUEUE_MAX + 1, LAB_FRAME_QUEUE_MAX * 50]) {
  const { c, s } = mk()
  c.push('{}\n'.repeat(n), 'stdout')
  console.log(`  pushed ${String(n).padStart(6)} frames -> queued=${String(c.queuedFrames()).padStart(5)} overflow=${c.isOverflowed()} onOverflow calls=${s.overflow} lines delivered=${s.lines}`)
}
console.log('--- byte cap boundary ---')
for (const n of [LAB_STREAM_CAP_BYTES - 1, LAB_STREAM_CAP_BYTES, LAB_STREAM_CAP_BYTES + 1]) {
  const { c, s } = mk({ onLine: () => {} })
  c.push(Buffer.alloc(n, 0x61), 'stderr')
  console.log(`  pushed ${String(n).padStart(8)} B -> bytesSeen=${c.bytesSeen()} overflow=${c.isOverflowed()}`)
}
console.log('--- residual (a frame with NO terminator) ---')
for (const n of [LAB_RESIDUAL_CAP_BYTES, LAB_RESIDUAL_CAP_BYTES + 1]) {
  const { c, s } = mk({ onLine: () => {} })
  c.push(Buffer.alloc(n, 0x61), 'stdout')   // no '\n' anywhere
  console.log(`  unterminated ${String(n).padStart(8)} B -> overflow=${c.isOverflowed()} (residual cap ${LAB_RESIDUAL_CAP_BYTES})`)
}
console.log('--- stream cap reached with NO newline at all: how much RAM is held ---')
{
  const { c } = mk({ onLine: () => {} })
  let pushed = 0
  while (!c.isOverflowed() && pushed < LAB_STREAM_CAP_BYTES * 2) { c.push(Buffer.alloc(64 * 1024, 0x61), 'stdout'); pushed += 64 * 1024 }
  console.log(`  overflowed after ${pushed} B of newline-free stdout (bounded: residual cap fires first)`)
}
console.log('--- per-line cost of appendOutput/appendSuite (boundedTextInfo over the WHOLE accumulator) ---')
const bti = (text) => {
  const value = String(text ?? '')
  const byteTruncated = Buffer.byteLength(value, 'utf8') > LAB_OUTPUT_CAP_BYTES
  const byteText = boundLabText(value, LAB_OUTPUT_CAP_BYTES)
  const lines = byteText.split('\n')
  return { text: lines.length > LAB_OUTPUT_CAP_LINES ? lines.slice(0, LAB_OUTPUT_CAP_LINES).join('\n') : byteText, truncated: byteTruncated || lines.length > LAB_OUTPUT_CAP_LINES }
}
for (const n of [1000, 10_000, 100_000]) {
  let acc = ''
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < n; i += 1) acc = bti(`${acc}x\n`).text
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  console.log(`  ${String(n).padStart(7)} lines (${n * 2} B of child stdout) -> ${ms.toFixed(0)} ms  (${(ms / n * 1000).toFixed(0)} us/line, accumulator pinned at the ${LAB_OUTPUT_CAP_BYTES} B cap)`)
}
console.log(`  the stream cap allows ${LAB_STREAM_CAP_BYTES} B = ${LAB_STREAM_CAP_BYTES / 2} such lines before the collector stops.`)
