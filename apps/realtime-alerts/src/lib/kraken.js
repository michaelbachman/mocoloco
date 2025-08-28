const WS_URL = 'wss://ws.kraken.com'
const REST_TICKER_URL = 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD'

// Kraken: avoid flooding — keep >= 1100ms between client messages
const MIN_SEND_INTERVAL_MS = 1100
const HEARTBEAT_STALE_MS = 20000 // if nothing from server in 20s, reconnect
const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 30000

export function createKrakenTicker({ log }) {
  let ws = null
  let connecting = false
  let lastSend = 0
  let backoff = BACKOFF_MIN_MS
  let lastServerActivity = 0
  let tickListeners = new Set()
  let statusListeners = new Set()
  let staleTimer = null
  let subscribed = false

  function setStatus(s) {
    statusListeners.forEach(fn => fn(s))
  }

  async function safeSend(obj) {
    const now = Date.now()
    const elapsed = now - lastSend
    const wait = Math.max(0, MIN_SEND_INTERVAL_MS - elapsed)
    if (wait) await new Promise(r => setTimeout(r, wait))
    try {
      ws?.send(JSON.stringify(obj))
      lastSend = Date.now()
    } catch (e) {
      log(`send error: ${e.message}`)
    }
  }

  function startStaleWatch() {
    if (staleTimer) clearInterval(staleTimer)
    staleTimer = setInterval(() => {
      const silent = Date.now() - lastServerActivity
      if (silent > HEARTBEAT_STALE_MS) {
        log('No data in 20s — reconnecting')
        ws?.close()
      }
    }, 5000)
  }

  function subscribeTicker() {
    if (!ws) return
    const sub = {
      event: 'subscribe',
      pair: ['XBT/USD'], // WS uses "XBT/USD"
      subscription: { name: 'ticker' }
    }
    log('WS → subscribe XBT/USD')
    return safeSend(sub)
  }

  async function connect() {
    if (connecting) return
    connecting = true
    setStatus('connecting')
    try {
      ws = new WebSocket(WS_URL)
    } catch (e) {
      connecting = false
      setStatus('disconnected')
      log(`WS ctor failed: ${e.message}`)
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      connecting = false
      setStatus('open')
      subscribed = false
      lastServerActivity = Date.now()
      backoff = BACKOFF_MIN_MS
      startStaleWatch()
      subscribeTicker()
    }

    ws.onmessage = (ev) => {
      lastServerActivity = Date.now()
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (Array.isArray(msg)) {
        // ticker array form: [channelID, data, channelName, pair]
        const data = msg[1]
        const pair = msg[3]
        if (pair === 'XBT/USD' && data?.c?.[0]) {
          const price = Number(data.c[0])
          tickListeners.forEach(fn => fn({ price, raw: data }))
        }
        return
      }
      // object-form events
      if (msg.event === 'systemStatus') {
        log(`WS ← systemStatus: ${msg.status}`)
      } else if (msg.event === 'subscriptionStatus') {
        if (msg.status === 'subscribed' && msg.subscription?.name === 'ticker') {
          subscribed = true
          log('WS ← subscribed to ticker XBT/USD')
        } else if (msg.status === 'error') {
          log(`WS ← subscription error: ${msg.errorMessage || 'unknown'}`)
        }
      } else if (msg.event === 'heartbeat') {
        // keep alive
      }
    }

    ws.onerror = (ev) => {
       log('WS error (see network tab for details)')
    }

    ws.onclose = (ev) => {
      setStatus('disconnected')
      const code = ev.code || 1006
      const reason = ev.reason || ''
      log(`WS closed (code=${code}${reason ? ', reason=' + reason : ''})`)
      scheduleReconnect()
    }
  }

  function scheduleReconnect() {
    try { ws?.close() } catch {}
    ws = null
    if (staleTimer) { clearInterval(staleTimer); staleTimer = null }
    setStatus('reconnecting')
    const jitter = Math.random() * 0.3 + 0.85
    const delay = Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, Math.floor(backoff * jitter)))
    log(`Reconnecting in ${(delay/1000).toFixed(1)}s…`)
    setTimeout(() => connect(), delay)
    backoff = Math.min(BACKOFF_MAX_MS, Math.floor(backoff * 1.8 + 400))
  }

  async function bootstrapREST() {
    try {
      const res = await fetch(REST_TICKER_URL, { cache: 'no-store' })
      const json = await res.json()
      const key = Object.keys(json.result || {})[0]
      const p = key ? Number(json.result[key].c[0]) : NaN
      if (!Number.isFinite(p)) throw new Error('bad price')
      tickListeners.forEach(fn => fn({ price: p, raw: json.result[key] }))
      return p
    } catch (e) {
      log('REST bootstrap failed')
      return null
    }
  }

  function onTick(fn) {
    tickListeners.add(fn)
    return () => tickListeners.delete(fn)
  }

  function onStatus(fn) {
    statusListeners.add(fn)
    return () => statusListeners.delete(fn)
  }

  function start() {
    connect()
    // Also do a one-shot REST bootstrap to get initial price fast
    bootstrapREST()
  }

  function stop() {
    try { ws?.close() } catch {}
    ws = null
    if (staleTimer) { clearInterval(staleTimer); staleTimer = null }
    setStatus('disconnected')
  }

  return { start, stop, onTick, onStatus }
}
