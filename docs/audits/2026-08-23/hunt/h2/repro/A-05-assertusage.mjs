// assertUsage matrix -- crew/crew.mjs:2157-2184
const R = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/crew.mjs'
const { assertUsage } = await import(R)
const ESC = String.fromCharCode(27)
const NUL = String.fromCharCode(0)
const RTL = '‮'
const t = (name, verb, args) => {
  try { assertUsage(verb, args); console.log('PASSES', name.padEnd(46), JSON.stringify(args)) }
  catch (e) { console.log('REFUSE', name.padEnd(46), e.name + ': ' + e.message.slice(0, 95)) }
}
t('run empty --task', 'run', { task: '', 'brief-file': 'b' })
t('run whitespace --task', 'run', { task: '   ', 'brief-file': 'b' })
t('run bare --task', 'run', { task: true, 'brief-file': 'b' })
t('run newline in --task', 'run', { task: 'a\nb', 'brief-file': 'b' })
t('run NUL in --task', 'run', { task: 'a' + NUL + 'b', 'brief-file': 'b' })
t('run ANSI in --task', 'run', { task: ESC + '[31mred' + ESC + '[0m', 'brief-file': 'b' })
t('run RTL override --task', 'run', { task: 'a' + RTL + 'b', 'brief-file': 'b' })
t('run bare --suite', 'run', { task: 't', 'brief-file': 'b', suite: true })
t('run empty --suite', 'run', { task: 't', 'brief-file': 'b', suite: '' })
t('run --keep false', 'run', { task: 't', 'brief-file': 'b', keep: 'false' })
t('run bare --validation-lane', 'run', { task: 't', 'brief-file': 'b', 'validation-lane': true })
t('boot bare --roles', 'boot', { task: 't', roles: true })
t('boot empty --roles', 'boot', { task: 't', roles: '' })
t('boot bare --checkout', 'boot', { task: 't', checkout: true })
t('boot bare --tier', 'boot', { task: 't', tier: true })
t('boot empty flag name (from --)', 'boot', { task: 't', '': 'x' })
t('wait --timeout-s abc', 'wait', { task: 't', 'timeout-s': 'abc' })
t('wait bare --timeout-s', 'wait', { task: 't', 'timeout-s': true })
t('wait --timeout-s -1', 'wait', { task: 't', 'timeout-s': '-1' })
t('run --lane alone', 'run', { task: 't', 'brief-file': 'b', lane: 'npm test' })
t('run --fences + --lane', 'run', { task: 't', 'brief-file': 'b', fences: 'f.json', lane: 'L' })
t('status --lane', 'status', { task: 't', lane: 'L' })
t('verb toString', 'toString', { task: 't' })
t('verb constructor', 'constructor', { task: 't' })
