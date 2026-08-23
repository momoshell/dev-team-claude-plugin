// Does anything refuse --model-<role-that-is-not-seated> on the --roles boot path?
const R = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/crew.mjs'
const { assertUsage, resolveTier, resolveAdapters, ROLE_FLAG_PREFIXES } = await import(R)
const t = async (name, fn) => {
  try { const v = await fn(); console.log('OK    ', name.padEnd(52), JSON.stringify(v)?.slice(0, 120)) }
  catch (e) { console.log('THROW ', name.padEnd(52), e.message.slice(0, 160)) }
}
// 1. assertUsage: role-prefixed flags are admitted for ANY suffix
await t('assertUsage boot --model-buidler (typo role)', () => assertUsage('boot', { task: 't', 'model-buidler': 'opus' }))
await t('assertUsage boot --agent-nobody', () => assertUsage('boot', { task: 't', 'agent-nobody': 'pi' }))
await t('assertUsage boot --effort-', () => assertUsage('boot', { task: 't', 'effort-': 'high' }))
await t('assertUsage boot --model-x/../y', () => assertUsage('boot', { task: 't', 'model-x/../y': 'z' }))
await t('assertUsage boot --allow-shortfall-nobody', () => assertUsage('boot', { task: 't', 'allow-shortfall-nobody': 'subagents' }))
// 2. tier path DOES refuse (crew.mjs:578-583)
const roster = JSON.parse((await import('node:fs')).readFileSync('/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/roster.json', 'utf8'))
await t('resolveTier build --model-buidler', () => resolveTier(roster, 'build', { 'model-buidler': 'opus' }).roles)
// 3. --roles path: resolveAdapters is the ONLY role-suffix validator there
await t('resolveAdapters(--model-buidler) roles=[lead]', () => resolveAdapters(['lead'], { 'model-buidler': 'opus' }).then(a => Object.keys(a)))
await t('resolveAdapters(--agent-buidler) roles=[lead]', () => resolveAdapters(['lead'], { 'agent-buidler': 'pi' }).then(a => Object.keys(a)))
await t('resolveAdapters(--effort-buidler) roles=[lead]', () => resolveAdapters(['lead'], { 'effort-buidler': 'x' }).then(a => Object.keys(a)))
await t('resolveAdapters(--allow-shortfall-buidler)', () => resolveAdapters(['lead'], { 'allow-shortfall-buidler': 'subagents' }).then(a => Object.keys(a)))
// 4. the read that the typo silently misses (seatModel is crew.mjs:318-320)
const SEAT = (await import(R)).SEAT_DEFAULTS
const seatModel = (role, args) => args[`model-${role}`] || SEAT.builder.model
console.log('\nseatModel("builder", {"model-buidler":"opus"}) ->', seatModel('builder', { 'model-buidler': 'opus' }), '(operator asked for opus)')
