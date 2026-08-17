export const VIEWS = Object.freeze(['fleet', 'ops', 'roster', 'run', 'phase'])
export const RESERVED = Object.freeze(['ops', 'roster'])

function segment(value) {
  try { return decodeURIComponent(value) } catch { return value }
}

export function parseHash(hash = '') {
  const source = typeof hash === 'string' ? hash : String(hash ?? '')
  const path = source.startsWith('#') ? source.slice(1) : source
  const segments = path.split('/').filter(Boolean).map(segment)
  const first = segments[0]
  if (!first) return { view: 'fleet', adw_id: null, phase: null }
  if (RESERVED.includes(first)) return { view: first, adw_id: null, phase: null }
  return {
    view: segments[1] ? 'phase' : 'run',
    adw_id: first,
    phase: segments[1] || null,
  }
}

export function formatHash(route = {}) {
  const view = route?.view
  if (view === 'ops' || view === 'roster') return `#/${view}`
  if ((view === 'run' || view === 'phase') && route?.adw_id != null && route.adw_id !== '') {
    const id = encodeURIComponent(String(route.adw_id))
    if (view === 'phase' && route?.phase != null && route.phase !== '') return `#/${id}/${encodeURIComponent(String(route.phase))}`
    return `#/${id}`
  }
  return '#/'
}

export function subscribeHash(onroute) {
  if (typeof onroute !== 'function' || typeof window === 'undefined' || typeof location === 'undefined') return () => {}
  const emit = () => onroute(parseHash(location.hash))
  const listener = () => emit()
  emit()
  window.addEventListener('hashchange', listener)
  return () => window.removeEventListener('hashchange', listener)
}
