import React, { useEffect, useMemo, useRef, useState } from 'react'

const QUIET_START = 23 // 11pm PT
const QUIET_END = 7   // 7am PT
const PAIR = 'XBT/USD' // default; UI can stay the same
const KRAKEN_WS = 'wss://ws.kraken.com'
const CACHE_KEY = 'price_XBTUSD'
const CACHE_TTL_MS = 120_000
const VISIBLE_MAX = 50

function inQuietHours(date = new Date()) {
  try {
    const pt = new Date(date.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }))
    const h = pt.getHours()
    return (QUIET_START > QUIET_END) ? (h >= QUIET_START || h < QUIET_END) : (h >= QUIET_START && h < QUIET_END)
  } catch { return false }
}

function nowPT() {
  return new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: true })
}

function Sparkline({ data = [], width = 200, height = 44 }) {
  const w = 200, h = 44
  const n = data.length
  if (!n) return <svg width={width} height={height} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none"></svg>
  const min = Math.min(...data), max = Math.max(...data)
  const rng = (max - min) || 1
  let pts = ''
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * (w - 2) + 1
    const y = h - 1 - (((data[i] - min) / rng) * (h - 2))
    pts += (i ? ' ' : '') + x.toFixed(1) + ',' + Math.min(h - 1, Math.max(1, y)).toFixed(1)
  }
  return (
    <svg width={width} height={height} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline fill="none" stroke="currentColor" strokeWidth="1.5" points={pts} />
    </svg>
  )
}

export default function App(){
  const [price, setPrice] = useState(null)
  const [baseline, setBaseline] = useState(null)
  const [lastAlertAt, setLastAlertAt] = useState(null)
  const [prices, setPrices] = useState([]) // for sparkline
  const [logs, setLogs] = useState([])

  const wsRef = useRef(null)
  const connectingRef = useRef(false)
  const backoffRef = useRef(1000)
  const BACKOFF_MAX = 30000

  const log = (s) => setLogs(l => [s, ...l].slice(0, 500))

  function readCached(){ try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const obj = JSON.parse(raw)
    if (!obj || typeof obj.val !== 'number' || typeof obj.ts !== 'number') return null
    if (Date.now() - obj.ts > CACHE_TTL_MS) return null
    return obj.val
  } catch { return null }}

  function writeCached(val){ try { localStorage.setItem(CACHE_KEY, JSON.stringify({ val, ts: Date.now() })) } catch {} }

  // First-load: use cached -> fetch edge -> defer WS
  useEffect(() => {
    const cached = readCached()
    if (cached != null) {
      setPrice(cached)
      setPrices(p => [...p.slice(-199), cached])
      log(`Cached price used on load: $${cached}`)
    }
    fetch('/api/latest/XBTUSD', { cache: 'no-cache' })
      .then(r => r.json())
      .then(j => {
        if (j?.ok && typeof j.price === 'number') {
          setPrice(j.price)
          setPrices(p => [...p.slice(-199), j.price])
          writeCached(j.price)
          log(`REST fetched price: $${j.price}`)
          if (baseline == null) setBaseline(j.price)
        }
      }).catch(() => {})
    // defer WS connect
    setTimeout(() => connectWS(), 0)
    return () => { try { wsRef.current?.close() } catch {} }
  }, [])

  function connectWS() {
    if (connectingRef.current) return
    connectingRef.current = True = true
    try { wsRef.current?.close() } catch {}
    const ws = new WebSocket(KRAKEN_WS)
    wsRef.current = ws
    log(`WS connecting… (${KRAKEN_WS})`)
    ws.onopen = () => {
      connectingRef.current = false
      backoffRef.current = 1000
      const sub = { event: 'subscribe', pair: ['XBT/USD'], subscription: { name: 'ticker' } }
      ws.send(JSON.stringify(sub))
      log('WS open → subscribe ticker XBT/USD')
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (Array.isArray(msg) && msg.length > 1) {
          const payload = msg[1]
          const c = payload?.c?.[0]
          if (c) {
            const p = parseFloat(c)
            if (!Number.isNaN(p)) {
              setPrice(p)
              setPrices(arr => [...arr.slice(-199), p])
              writeCached(p)
            }
          }
        } else if (msg?.event === 'subscriptionStatus') {
          if (msg.status === 'subscribed') log('Subscribed to ticker ✔️')
        }
      } catch {}
    }
    ws.onclose = (ev) => {
      const code = ev?.code || 0
      const reason = ev?.reason || ''
      log(`WS closed (code=${code}${reason ? ', reason=' + reason : ''})`)
      // backoff + reconnect
      const delay = Math.min(backoffRef.current, BACKOFF_MAX)
      setTimeout(connectWS, delay)
      backoffRef.current = Math.min(BACKOFF_MAX, Math.round(backoffRef.current * 1.6 + 250))
    }
    ws.onerror = () => {
      log('WS error')
    }
  }

  // Render
  const visibleLogs = Array.isArray(logs) ? logs.slice(0, VISIBLE_MAX) : []

  return (
    <div className="wrap">
      <div className="hero">
        <div className="card" style={{ flex: 1 }}>
          <div className="label">Current Price (XBT/USD)</div>
          <div className="row">
            <div className="val">{price != null ? `$${price.toLocaleString()}` : '—'}</div>
            <span className={"badge " + (inQuietHours() ? "warn" : "ok")}>
              {inQuietHours() ? 'Quiet hours' : 'Live'}
            </span>
          </div>
          <div className="small">Baseline: {baseline != null ? `$${baseline.toLocaleString()}` : '—'} • {nowPT()}</div>
          <div style={{ marginTop: 8 }}><Sparkline data={prices} /></div>
        </div>
        <div className="card" style={{ width: 340 }}>
          <div className="label">Logs</div>
          <div className="logs">
            {visibleLogs.map((s,i)=>(<div key={i}>{s}</div>))}
          </div>
        </div>
      </div>
    </div>
  )
}
