// Simple global heartbeat using useSyncExternalStore
let tick = 0
const subs = new Set()
setInterval(() => { tick = (tick + 1) % 1_000_000; subs.forEach((f) => { try { f() } catch {} }) }, 1000)

export function clockSubscribe(fn){ subs.add(fn); return () => subs.delete(fn) }
export function clockGetSnapshot(){ return tick }
