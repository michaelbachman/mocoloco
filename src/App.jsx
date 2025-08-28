import React, { useEffect, useMemo, useRef, useState } from 'react'

// --- Configs (kept small for LCP) ---
const PAIR_REST = 'XBTUSD'        // Kraken REST pair for BTC/USD
const PAIR_WS   = 'XBT/USD'       // Kraken WS pair naming
const MAX_LOG_LINES = 150
const FLUSH_INTERVAL_MS = 800
const FLUSH_MAX = 30
const STALE_MS = 30_000           // If no ticks in 30s, reconnect

function nowPT() {
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: 'America/Los_Angeles', hour12: false
    }).format(new Date())
  } catch {
    return new Date().toLocaleTimeString()
  }
}

// Lightweight REST fetch for a spot price (for UI sanity on first load)
async function fetchSpot() {
  const url = `https://api.kraken.com/0/public/Ticker?pair=${PAIR_REST}`
  const res = await fetch(url, { cache: 'no-store' })
  const json = await res.json()
  const key = Object.keys(json?.result || {})[0]
  const last = json?.result?.[key]?.c?.[0]
  const px = last ? Number(last) : NaN
  return isFinite(px) ? px : NaN
}

export default function App() {
  const [status, setStatus] = useState('Booting…')
  const [price, setPrice] = useState(null)
  const [connected, setConnected] = useState(false)
  const [ticks, setTicks] = useState(0)
  const [lastTickAt, setLastTickAt] = useState(null)
  const [logs, setLogs] = useState([])

  const wsRef = useRef(null)
  const backoffRef = useRef(2_000)
  const bufRef = useRef([])
  const staleCheckRef = useRef(null)
  const lastFlushAtRef = useRef(0)

  const log = (s) => {
    bufRef.current.push(`[${nowPT()}] ${s}`)
  }

  // Flush logs in small chunks to avoid large long tasks
  useEffect(() => {
    const iv = setInterval(() => {
      const buf = bufRef.current
      if (!buf.length) return
      const chunk = buf.splice(0, FLUSH_MAX)
      const ts = Date.now()
      if (ts - lastFlushAtRef.current < 80) return // trivial throttle
      lastFlushAtRef.current = ts
      setLogs(prev => {
        const next = [...chunk.reverse(), ...prev]
        if (next.length > MAX_LOG_LINES) next.length = MAX_LOG_LINES
        return next
      })
    }, FLUSH_INTERVAL_MS)
    return () => clearInterval(iv)
  }, [])

  // Initial fast REST hit for price (doesn't block LCP)
  useEffect(() => {
    (async () => {
      try {
        const px = await fetchSpot()
        if (isFinite(px)) {
          setPrice(px)
          log(`REST price: ${px.toFixed(2)}`)
        }
      } catch {}
    })()
  }, [])

  // Establish & maintain a single lightweight WS connection
  useEffect(() => {
    let closed = false

    const connect = () => {
      if (closed) return
      setStatus('Connecting WS…')
      log('Connecting WS for XBTUSD…')

      const ws = new WebSocket('wss://ws.kraken.com/')
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        setStatus('Subscribing…')
        backoffRef.current = 2_000
        const sub = {
          event: 'subscribe',
          pair: [PAIR_WS],
          subscription: { name: 'ticker' }
        }
        ws.send(JSON.stringify(sub))
        log('WS → subscribe XBTUSD')
      }

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (Array.isArray(msg)) {
            // ticker payload: [chanId, {...}, channelName, pair]
            const payload = msg[1]
            const last = payload?.c?.[0]
            if (last) {
              const px = Number(last)
              if (isFinite(px)) {
                setPrice(px)
                setTicks(t => t + 1)
                setLastTickAt(Date.now())
              }
            }
            return
          }
          if (msg.event === 'systemStatus') {
            log(`WS ← systemStatus: ${msg.status}`)
            return
          }
          if (msg.event === 'subscriptionStatus') {
            if (msg.status === 'subscribed') {
              setStatus('Live')
              log('WS ← subscriptionStatus: subscribed')
              return
            } else {
              setStatus('Error subscribing')
              log('WS ← subscriptionStatus: error')
            }
          }
        } catch {}
      }

      ws.onclose = (ev) => {
        setConnected(false)
        setStatus('Disconnected')
        const code = ev?.code || 1005
        log(`WS closed (code=${code})`)
        scheduleReconnect()
      }

      ws.onerror = () => {
        // Kraken WS often emits error then close; onclose handler will backoff
      }
    }

    const scheduleReconnect = () => {
      if (closed) return
      const delay = backoffRef.current
      log(`Reconnecting in ${(delay/1000).toFixed(1)}s…`)
      setTimeout(() => {
        if (backoffRef.current < 60_000) backoffRef.current *= 1.6
        connect()
      }, delay)
    }

    // Stale-tick detector
    staleCheckRef.current = setInterval(() => {
      const last = lastTickAt
      if (!last) return
      if (Date.now() - last > STALE_MS) {
        log('No ticks in 30s — reconnecting')
        try { wsRef.current?.close() } catch {}
      }
    }, 5_000)

    connect()

    return () => {
      closed = true
      clearInterval(staleCheckRef.current)
      try { wsRef.current?.close(1000, 'unload') } catch {}
    }
  }, [lastTickAt])

  const connBadge = useMemo(() => (
    <span className={`badge ${connected ? 'ok' : 'warn'}`}>
      {connected ? 'Connected' : 'Disconnected'}
    </span>
  ), [connected])

  return (
    <div className="wrap">
      <div className="hero">
        <div>
          <div className="label">Pair</div>
          <div className="val">BTC / USD</div>
          <div className="small muted">Kraken spot — ticker via WebSocket</div>
        </div>
        <div className="row">
          <div>{connBadge}</div>
          <div className="badge">{status}</div>
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <div className="label">Last price</div>
          <div className="val">{price ? `$${price.toLocaleString(undefined, {maximumFractionDigits: 2})}` : '—'}</div>
          <div className="small muted">{ticks} ticks</div>
        </div>

        <div className="card">
          <div className="label">Notes</div>
          <div className="small muted">Lightweight logs & capped DOM to improve LCP.</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="label">Logs (latest first)</div>
          <div className="small muted">Max {MAX_LOG_LINES} lines, flushed every {(FLUSH_INTERVAL_MS/1000).toFixed(1)}s</div>
        </div>
        <div className="logs">
          {logs.map((s, i) => <div key={i}>{s}</div>)}
        </div>
      </div>
    </div>
  )
}
