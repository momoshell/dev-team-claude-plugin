// factoryctl argument surface. No daemon: `call` is a stub that records params.
const F = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/factoryctl.mjs'
const { parseArgs, runVerb, sendVerb, attachVerb, lsVerb, socketPathFor } = await import(F)
const sink = () => {}
const mk = () => { const seen = []; return { seen, call: async (cmd, params) => { seen.push([cmd, params]); return { run_id: 'r1', outcome: null, state: 'done' } } } }
const t = async (name, argvTail, verb = runVerb) => {
  const args = parseArgs(argvTail)
  const { seen, call } = mk()
  try { await verb(args, { call, stdout: sink, stderr: sink, onEvent: () => () => {}, cwd: () => '/tmp/co' })
    console.log('SENT  ', name.padEnd(50), JSON.stringify(seen[0]?.[1] ?? seen[0])) }
  catch (e) { console.log('REFUSE', name.padEnd(50), e.message.slice(0, 100)) }
}
console.log('--- factoryctl run: unknown/typo flags are SILENTLY IGNORED (no assertUsage twin) ---')
await t('control: correct flags', ['run', '--tier', 'build', '--brief', '/tmp/b.md', '--files-in-scope', 'a.mjs', '--lane', 'npm test', '--variant', 'directed'])
await t('typo --files-in-scop', ['run', '--tier', 'build', '--brief', '/tmp/b.md', '--files-in-scop', 'a.mjs', '--lane', 'npm test', '--variant', 'directed'])
await t('typo --lan', ['run', '--tier', 'build', '--brief', '/tmp/b.md', '--files-in-scope', 'a.mjs', '--lan', 'npm test'])
await t('typo --varient repair', ['run', '--tier', 'build', '--brief', '/tmp/b.md', '--varient', 'repair'])
await t('crew.mjs spelling --brief-file', ['run', '--tier', 'build', '--brief-file', '/tmp/b.md'])
await t('crew.mjs spelling --validation-lane', ['run', '--tier', 'build', '--brief', '/tmp/b.md', '--validation-lane', 'npm test'])
await t('--variant bogus (forwarded unvalidated)', ['run', '--tier', 'build', '--brief', '/tmp/b.md', '--variant', 'not-a-variant'])
await t('--variant with case variance', ['run', '--tier', 'build', '--brief', '/tmp/b.md', '--variant', 'DIRECTED'])
await t('repeated --tier build then judge', ['run', '--tier', 'build', '--tier', 'judge', '--brief', '/tmp/b.md'])
await t('repeated --files-in-scope wide then narrow', ['run', '--tier', 'build', '--brief', '/tmp/b.md', '--files-in-scope', 'a.mjs,b.mjs', '--files-in-scope', 'a.mjs'])
await t('--brief followed by a flag', ['run', '--tier', 'build', '--brief', '--files-in-scope', 'a.mjs'])
await t('--tier bare', ['run', '--tier', '--brief', '/tmp/b.md'])
await t('--files-in-scope bare', ['run', '--tier', 'build', '--brief', '/tmp/b.md', '--files-in-scope'])
await t('--files-in-scope ",,"', ['run', '--tier', 'build', '--brief', '/tmp/b.md', '--files-in-scope', ',,'])
await t('--files-in-scope traversal', ['run', '--tier', 'build', '--brief', '/tmp/b.md', '--files-in-scope', '../../etc/passwd'])
await t('--task with slashes', ['run', '--tier', 'build', '--brief', '/tmp/b.md', '--task', '../../escape'])

console.log('--- factoryctl send ---')
await t('send msg starting with --', ['send', 'run-1', '--force reset'], sendVerb)
await t('send msg = "--"', ['send', 'run-1', '--'], sendVerb)
await t('send via -- terminator', ['send', '--', 'run-1', 'hello'], sendVerb)
await t('send normal', ['send', 'run-1', 'hello'], sendVerb)
await t('send extra positional (3rd) ignored', ['send', 'run-1', 'hello', 'world'], sendVerb)
await t('send --role bare', ['send', 'run-1', 'hi', '--role'], sendVerb)
await t('send --role UNKNOWNROLE', ['send', 'run-1', 'hi', '--role', 'nosuchrole'], sendVerb)
await t('send --role with newline', ['send', 'run-1', 'hi', '--role', 'builder\nx'], sendVerb)
await t('send msg with newline', ['send', 'run-1', 'line1\nline2'], sendVerb)

console.log('--- factoryctl attach ---')
await t('attach run-id starting with --', ['attach', '--run-1'], attachVerb)
await t('attach ok', ['attach', 'run-1'], attachVerb)

console.log('--- socketPathFor ---')
for (const a of [{}, { root: '/tmp/x' }, { root: true }, { root: '' }])
  { try { console.log(' ', JSON.stringify(a).padEnd(20), socketPathFor(a, {})) } catch (e) { console.log(' ', JSON.stringify(a).padEnd(20), 'THREW ' + e.message.slice(0, 70)) } }
