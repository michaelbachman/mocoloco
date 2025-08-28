const RING_MAX = 800

export function createLogger() {
  const ring = []
  let listeners = new Set()
  let lastFlush = 0

  function add(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`
    ring.push(line)
    if (ring.length > RING_MAX) ring.shift()
    // Throttle listener notify to at most every 800ms to keep light
    const now = performance.now()
    if (now - lastFlush > 800) {
      lastFlush = now
      listeners.forEach(fn => fn(ring.slice()))
    }
  }

  function subscribe(fn) {
    listeners.add(fn)
    fn(ring.slice()) // immediate
    return () => listeners.delete(fn)
  }

  return { add, subscribe, snapshot: () => ring.slice() }
}
