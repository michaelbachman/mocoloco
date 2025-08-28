import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react'

// ---------- Utils ----------
function nowPT() {
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour12: false,
      timeZone: 'America/Los_Angeles',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date())
  } catch {
    const d = new Date()
    const hh = String(d.getHours()).padStart(2,'0')
    const mm = String(d.getMinutes()).padStart(2,'0')
    const ss = String(d.getSeconds()).padStart(2,'0')
    return `${hh}:${mm}:${ss}`
  }
}

// ---------- Component ----------
export default function App () {
  // UI state
  const [price, setPrice] = useState(null)
  const [status, setStatus] = useState('disconnected')
  const [logs, setLogs] = useState([])
  const [ticks, setTicks] = useState(0)
  const [lastTickAgo, setLastTickAgo] = useState('--')
  const [backoff, setBackoff] = useState(0)

  // Refs
  const wsRef = useRef(null)
  const reconnectTimerRef = useRef(null)
  const staleTimerRef = useRef(null)

  const connectingRef = useRef(false)
  const subscribedRef = useRef(false)
  const lastTickAtRef = useRef(0)
  const backoffMsRef = useRef(2000)

  // Consts
  const MAX_BACKOFF_MS = 60000
  const STALE_MS = 30000
  const KRAKEN_WS = 'wss://ws.kraken.com'
  const PAIR = 'XBT/USD' // BTC/USD spot

  const log = useCallback((s) => {
    // O(1) prepend via slice
    setLogs(prev => [`[${nowPT()}] ${s}`, ...prev].slice(0, 500))
  }, [])

  function clearTimers() {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (staleTimerRef.current) {
      clearTimeout(staleTimerRef.current)
      staleTimerRef.current = null
    }
  }

  function scheduleStaleCheck() {
    if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
    staleTimerRef.current = setTimeout(() => {
      const idle = Date.now() - (lastTickAtRef.current || 0)
      if (idle >= STALE_MS && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        log(`No ticks for ${Math.round(idle/1000)}s — closing to recover`)
        try { wsRef.current.close(4000, 'stale') } catch {}
      }
    }, STALE_MS)
  }

  function scheduleReconnect() {
    if (reconnectTimerRef.current) return
    const delay = backoffMsRef.current
    setBackoff(delay)
    log(`Reconnecting in ${Math.round(delay/1000)}s…`)
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null
      connectWS()
      backoffMsRef.current = Math.min(backoffMsRef.current * 2, MAX_BACKOFF_MS)
      setBackoff(backoffMsRef.current)
    }, delay)
  }

  function connectWS() {
    if (connectingRef.current) return
    connectingRef.current = true

    clearTimers()
    subscribedRef.current = false

    setStatus('connecting')
    log(`Connecting WS for ${PAIR}…`)
    const ws = new WebSocket(KRAKEN_WS)
    wsRef.current = ws

    ws.onopen = () => {
      try {
        const msg = { event: 'subscribe', pair: [PAIR], subscription: { name: 'ticker' } }
        ws.send(JSON.stringify(msg))
        log(`WS → subscribe ${PAIR}`)
      } catch (e) {
        log(`Send error: ${e?.message || e}`)
      }
      backoffMsRef.current = 2000
      setBackoff(0)
      setStatus('open')
      scheduleStaleCheck()
      connectingRef.current = false
    }

    ws.onmessage = (ev) => {
      let data
      try { data = JSON.parse(ev.data) } catch { return }

      if (data?.event === 'systemStatus') {
        log(`WS ← systemStatus: ${data.status}`)
        return
      }
      if (data?.event === 'subscriptionStatus') {
        if (data.status === 'subscribed' && !subscribedRef.current) {
          subscribedRef.current = true
          setStatus('subscribed')
          log('WS ← subscriptionStatus: subscribed')
        } else if (data.status === 'error') {
          log(`WS ← subscriptionStatus: error (${data.errorMessage || 'unknown'})`)
        }
        return
      }
      if (data?.event === 'heartbeat') return

      // Ticker array payload
      if (Array.isArray(data) && data[1]?.c?.[0]) {
        const last = parseFloat(data[1].c[0])
        if (Number.isFinite(last)) {
          lastTickAtRef.current = Date.now()
          setPrice(last)
          setTicks(t => t + 1)
          scheduleStaleCheck()
        }
      }
    }

    ws.onclose = (ev) => {
      const { code, reason } = ev || {}
      log(`WS closed (code=${code}${reason ? `, reason="${reason}"` : ''})`)
      setStatus('closed')
      clearTimers()
      connectingRef.current = false
      subscribedRef.current = false
      scheduleReconnect()
    }

    ws.onerror = () => {
      log('WS error')
      // onclose will handle reconnect
    }
  }

  // One-time mount
  useEffect(() => {
    connectWS()
    return () => {
      clearTimers()
      try { wsRef.current?.close(1000, 'unmount') } catch {}
    }
  }, [])

  // Last tick "ago" display
  useEffect(() => {
    const iv = setInterval(() => {
      if (!lastTickAtRef.current) {
        setLastTickAgo('--')
      } else {
        const s = Math.max(0, Math.floor((Date.now() - lastTickAtRef.current) / 1000))
        setLastTickAgo(`${s}s`)
      }
    }, 1000)
    return () => clearInterval(iv)
  }, [])

  const connBadgeClass = useMemo(() => {
    return status === 'subscribed' ? 'badge ok' :
           status === 'open' ? 'badge ok' :
           status === 'connecting' ? 'badge warn' : 'badge'
  }, [status])

  return (
    <div className="wrap">
      <h1>BTC/USD — Kraken Realtime (logs & status)</h1>

      <div className="grid">
        <div className="card">
          <div className="row">
            <div className="label">Connection</div>
            <div className={connBadgeClass}>{status}</div>
          </div>
          <div className="row" style={{marginTop: 6}}>
            <div>
              <div className="label">Last price</div>
              <div className="val">{price ? `$${price.toLocaleString()}` : '—'}</div>
            </div>
            <div>
              <div className="label">Ticks</div>
              <div className="val">{ticks}</div>
            </div>
            <div>
              <div className="label">Last tick ago</div>
              <div className="val">{lastTickAgo}</div>
            </div>
            <div>
              <div className="label">Backoff</div>
              <div className="val">{backoff ? `${Math.round(backoff/1000)}s` : '—'}</div>
            </div>
          </div>
          <div className="row" style={{marginTop: 10}}>
            <button className="btn" onClick={() => {
              try { wsRef.current?.close(4001, 'manual reconnect') } catch {}
              log('Manual reconnect requested')
            }}>Reconnect</button>
            <button className="btn" onClick={() => {
              setLogs([])
              log('Logs cleared')
            }}>Clear logs</button>
          </div>
          <div className="footer">CSP-safe, no inline JS/CSS. Respects Kraken WS limits with single-subscribe and backoff.</div>
        </div>

        <div className="card">
          <div className="label">Logs (latest first)</div>
          <div className="logs" aria-live="polite" aria-atomic="false">
            {logs.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </div>
      </div>
    </div>
  )
}
