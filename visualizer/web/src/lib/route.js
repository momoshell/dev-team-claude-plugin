const RESERVED = Object.freeze(['agents', 'skills'])

function segment(value) {
  try { return decodeURIComponent(value) } catch { return value }
}

export function parseHash(hash = '') {
  const source = typeof hash === 'string' ? hash : String(hash ?? '')
  const path = source.startsWith('#') ? source.slice(1) : source
  const segments = path.split('/').filter(Boolean).map(segment)
  const first = segments[0]
  if (!first) return { view: 'fleet', adw_id: null }
  if (RESERVED.includes(first)) return { view: first, adw_id: null }
  return { view: 'run', adw_id: first }
}

export function formatHash(route = {}) {
  const view = route?.view
  if (view === 'agents' || view === 'skills') return `#/${view}`
  if (view === 'run' && route?.adw_id != null && route.adw_id !== '') {
    const id = encodeURIComponent(String(route.adw_id))
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
