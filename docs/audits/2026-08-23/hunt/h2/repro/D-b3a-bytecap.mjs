// B3a (corrected): byte-cap boundary with frequent newlines so the RESIDUAL cap
// can never fire first. Expect overflow ONLY at capBytes+1.
import * as mod from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/pi/extensions/lab.ts'
const CAP = mod.LAB_STREAM_CAP_BYTES
for (const total of [CAP - 1, CAP, CAP + 1]) {
  let overflow = 0
  const c = mod.createStreamCollector({
    capBytes: CAP, residualCapBytes: mod.LAB_RESIDUAL_CAP_BYTES, frameQueueMax: mod.LAB_FRAME_QUEUE_MAX,
    onLine: () => c.served(), onOverflow: () => { overflow += 1 },
  })
  // 1 KiB newline-terminated chunks, remainder last
  let sent = 0
  while (sent < total && !c.isOverflowed()) {
    const size = Math.min(1024, total - sent)
    const b = Buffer.alloc(size, 0x61); b[size - 1] = 0x0a
    c.push(b, 'stderr'); sent += size
  }
  console.log(`total=${String(total).padStart(8)} B  bytesSeen=${String(c.bytesSeen()).padStart(8)}  overflow=${c.isOverflowed()}  onOverflow=${overflow}`)
}
