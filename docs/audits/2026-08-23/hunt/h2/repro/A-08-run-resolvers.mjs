// run-verb value resolvers, hostile input.
const R = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/'
const { resolveValidationLane, resolveFilesInScope, resolveVariant, seatTransport, transportFor, memoryConfig, seatShortfalls } = await import(R + 'crew.mjs')
const { resolveWaits } = await import(R + 'drive.mjs')
const { resolveLimits } = await import(R + 'limits.mjs')
const ESC = String.fromCharCode(27), NUL = String.fromCharCode(0)
const t = (name, fn) => { try { console.log('OK    ', name.padEnd(48), JSON.stringify(fn())) } catch (e) { console.log('REFUSE', name.padEnd(48), e.message.slice(0, 95)) } }

console.log('--- resolveValidationLane (crew.mjs:418-439) ---')
t('bare --validation-lane (true)', () => resolveValidationLane({ validationLane: true }))
t('--validation-lane ""', () => resolveValidationLane({ validationLane: '' }))
t('--validation-lane "   "', () => resolveValidationLane({ validationLane: '   ' }))
t('--validation-lane newline-embedded', () => resolveValidationLane({ validationLane: 'npm test\nrm -rf /tmp/x' }))
t('--validation-lane with NUL', () => resolveValidationLane({ validationLane: 'npm test' + NUL + 'x' }))
t('--validation-lane with ANSI', () => resolveValidationLane({ validationLane: ESC + '[2Jnpm test' }))
t('--lane npm test (no fences)', () => resolveValidationLane({ lane: 'npm test' }))
t('--lane npm test + --fences true(bare)', () => resolveValidationLane({ lane: 'npm test', fences: true }))
t('--lane + --fences ""', () => resolveValidationLane({ lane: 'npm test', fences: '' }))

console.log('--- resolveFilesInScope (crew.mjs:349-385) ---')
t('--files-in-scope ",,,"', () => resolveFilesInScope({ 'files-in-scope': ',,,' }, 'default', null))
t('--files-in-scope "a.mjs, ,b.mjs"', () => resolveFilesInScope({ 'files-in-scope': 'a.mjs, ,b.mjs' }, 'default', null))
t('--files-in-scope "../../etc/passwd"', () => resolveFilesInScope({ 'files-in-scope': '../../etc/passwd' }, 'default', null))
t('--files-in-scope "/etc/passwd"', () => resolveFilesInScope({ 'files-in-scope': '/etc/passwd' }, 'default', null))
t('--files-in-scope "a.mjs\\nb.mjs"', () => resolveFilesInScope({ 'files-in-scope': 'a.mjs\nb.mjs' }, 'default', null))
t('--files-in-scope with NUL', () => resolveFilesInScope({ 'files-in-scope': 'a' + NUL + '.mjs' }, 'default', null))
t('--files-in-scope bare', () => resolveFilesInScope({ 'files-in-scope': true }, 'default', null))

console.log('--- resolveVariant (crew.mjs:334-347) ---')
for (const v of [undefined, true, '', 'DEFAULT', ' default ', 'default']) t('--variant ' + JSON.stringify(v), () => resolveVariant({ variant: v }))

console.log('--- resolveWaits (drive.mjs:74-96) ---')
for (const v of ['8080abc', '0x1f', ' 12 ', '1e3', 'Infinity', 'NaN', '-1', '0', '1.5', '21601', '+5', '007', true, ''])
  t('--wait-planner ' + JSON.stringify(v), () => resolveWaits({ planner: v }).planner)

console.log('--- resolveLimits (limits.mjs:29-64) ---')
for (const v of ['3abc', '0x2', ' 2 ', '1e1', '-1', '0', '11', true, '', '007'])
  t('--plan-rounds ' + JSON.stringify(v), () => resolveLimits({ plan_rounds: v }).plan_rounds)

console.log('--- memoryConfig budget (crew.mjs:1247-1262) ---')
for (const v of ['8080abc', '0x1f', ' 12 ', '1e3', 'Infinity', '-1', '0', '1.5', true, '9007199254740993'])
  t('--memory-budget-bytes ' + JSON.stringify(v), () => memoryConfig({ 'memory-dir': '/tmp/m', 'memory-budget-bytes': v }))

console.log('--- transportFor / seatShortfalls ---')
t('--headless " lead "', () => transportFor('lead', { headless: ' lead ' }))
t('--headless LEAD', () => transportFor('lead', { headless: 'LEAD' }))
t('--headless lead --headless-rpc lead', () => transportFor('lead', { headless: 'lead', 'headless-rpc': 'lead' }))
t('--allow-shortfall-lead bare', () => seatShortfalls('lead', { 'allow-shortfall-lead': true }))
t('--allow-shortfall-lead ""', () => seatShortfalls('lead', { 'allow-shortfall-lead': '' }))
t('--headless-all "x"', () => seatTransport({ role: 'lead', args: { 'headless-all': 'x' }, adapter: { capabilitiesFor: () => ({}) }, agentName: 'claude' }))
t('--headless-all "true"', () => seatTransport({ role: 'lead', args: { 'headless-all': 'true' }, adapter: { capabilitiesFor: () => ({}) }, agentName: 'claude' }))
t('--headless-all "false"', () => seatTransport({ role: 'lead', args: { 'headless-all': 'false' }, adapter: { capabilitiesFor: () => ({}) }, agentName: 'claude' }))
