// bounded CLI runner (no coreutils `timeout` on this box)
import { spawn } from 'node:child_process'
export function runCli(args, { ms = 12000, cwd } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const p = spawn(process.execPath, args, { cwd, encoding: 'utf8' })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => { p.kill('SIGKILL'); }, ms)
    p.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, out: out.trim(), err: err.trim(), ms: Date.now() - t0 })
    })
  })
}
