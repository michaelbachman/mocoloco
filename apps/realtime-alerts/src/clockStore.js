// Global clock store: decoupled from React components
let __clockCount = 0
const __clockListeners = new Set()

setInterval(() => {
  __clockCount = (__clockCount + 1) % 1000000
  __clockListeners.forEach(fn => { try { fn() } catch {} })
}, 1000)

export function clockSubscribe(fn) {
  __clockListeners.add(fn)
  return () => __clockListeners.delete(fn)
}

export function clockGetSnapshot() {
  return __clockCount
}
