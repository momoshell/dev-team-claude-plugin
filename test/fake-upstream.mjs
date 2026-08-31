// A stand-in provider that always fails with a chosen status, so a refusal
// shape can be MEASURED instead of waited for. Transport-neutral: anything that
// honours ANTHROPIC_BASE_URL can be pointed at it, which is how the
// api_error_status -> provider-failure mapping in crew/headless.mjs was pinned.
//
//   node test/fake-upstream.mjs ratelimit|auth|overloaded     # prints PORT=…
//   ANTHROPIC_BASE_URL=http://127.0.0.1:<port> ANTHROPIC_API_KEY=… <command>
import { createServer } from 'node:http'
const mode = process.argv[2] || 'ratelimit'
const BODIES = {
  ratelimit: [429, { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } }],
  overloaded: [529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
  auth: [401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }],
}
const [status, body] = BODIES[mode] ?? BODIES.ratelimit
const server = createServer((req, res) => {
  let seen = ''
  req.on('data', (c) => { seen += c })
  req.on('end', () => {
    process.stderr.write(`[upstream] ${req.method} ${req.url} -> ${status}\n`)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
})
server.listen(0, '127.0.0.1', () => process.stdout.write(`PORT=${server.address().port}\n`))
