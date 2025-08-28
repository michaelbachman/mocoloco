import React, { useEffect, useRef, useState, useMemo } from 'react'

// ---- Config ----
const KRAKEN_WS = 'wss://ws.kraken.com'
const PAIR = 'XBT/USD'              // Kraken WS pair format
const SUB = { event: 'subscribe', pair: [PAIR], subscription: { name: 'ticker' } }

const STALE_MS = 40000              // consider stale if no WS activity for 40s
const PING_MS  = 15000              // send ping every 15s to keep intermediaries awake
const BACKOFF_MIN = 2000            // 2s
const BACKOFF_MAX = 60000           // 60s

// Visible logs cap to keep things light
const LOG_MAX = 500

function nowPT(){
  const d = new Date()
  try {
    return d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false })
  } catch {
    return d.toISOString().replace('T',' ').slice(0,19) + 'Z'
  }
}

export default function App(){
  // UI state
  const [price, setPrice] = useState(null)
  const [status, setStatus] = useState('disconnected')
  const [logs, setLogs] = useState([])
  const [lastActivityAgo, setLastActivityAgo] = useState(0)
  const [connecting, setConnecting] = useState(false)

  // refs (never trigger re-render)
  const wsRef = useRef(null)
  const lastActivityRef = useRef(0)
  const channelIdRef = useRef(null)
  const backoffRef = useRef(BACKOFF_MIN)
  const staleIvRef = useRef(null)
  const pingIvRef = useRef(null)
  const reconnectToRef = useRef(null)
  const unsubscribedRef = useRef(false)

  function log(s){
    setLogs(l => [ `[${new Date().toLocaleTimeString()}] ${s}`, ...(l||[]) ].slice(0, LOG_MAX))
  }

  function bump(){
    lastActivityRef.current = Date.now()
  }

  function safeClose(code=1000, reason=''){
    try { wsRef.current?.close(code, reason) } catch {}
    wsRef.current = null
  }

  function clearTimers(){
    if (staleIvRef.current) { clearInterval(staleIvRef.current); staleIvRef.current = null }
    if (pingIvRef.current)  { clearInterval(pingIvRef.current);  pingIvRef.current  = null }
    if (reconnectToRef.current) { clearTimeout(reconnectToRef.current); reconnectToRef.current = null }
  }

  function scheduleReconnect(){
    clearTimers()
    const jitter = Math.random() * 250
    const delay = Math.min(BACKOFF_MAX, Math.max(BACKOFF_MIN, backoffRef.current)) + jitter
    log(`Reconnecting in ${(delay/1000).toFixed(1)}s…`)
    reconnectToRef.current = setTimeout(connect, delay)
    backoffRef.current = Math.min(BACKOFF_MAX, backoffRef.current * 1.7 + 200)
  }

  function connect(){
    if (wsRef.current || connecting) return
    setConnecting(true)
    setStatus('connecting')
    unsubscribedRef.current = false
    try {
      const ws = new WebSocket(KRAKEN_WS)
      wsRef.current = ws

      ws.onopen = () => {
        setConnecting(false)
        setStatus('open')
        bump()
        log(`Connecting WS for ${PAIR}…`)
        // subscribe
        ws.send(JSON.stringify(SUB))
        log(`WS → subscribe ${PAIR}`)

        // ping loop
        pingIvRef.current = setInterval(() => {
          if (!wsRef.current) return
          try {
            wsRef.current.send(JSON.stringify({ event: 'ping' }))
          } catch {}
        }, PING_MS)

        // stale watchdog
        staleIvRef.current = setInterval(() => {
          const last = lastActivityRef.current || 0
          setLastActivityAgo(Date.now() - last)
          if (Date.now() - last > STALE_MS) {
            log('No WS activity in 40s — closing to recover')
            backoffRef.current = Math.max(BACKOFF_MIN, backoffRef.current) // keep backoff
            safeClose(4000, 'stale')
          }
        }, 1000)
      }

      ws.onmessage = (ev) => {
        let msg
        try { msg = JSON.parse(ev.data) } catch { return }
        // Any parsed message counts as activity
        bump()

        // Heartbeat keeps us alive
        if (msg?.event === 'heartbeat') return

        // System / subscription status
        if (msg?.event === 'systemStatus') {
          log(`WS ← systemStatus: ${msg.status || 'unknown'}`)
          return
        }
        if (msg?.event === 'subscriptionStatus') {
          const st = msg.status
          if (st === 'subscribed') {
            channelIdRef.current = msg.channelID
            log(`WS ← subscriptionStatus: subscribed`)
            backoffRef.current = BACKOFF_MIN // reset backoff on success
          } else if (st === 'error') {
            log(`WS ← subscriptionStatus: error`)
            backoffRef.current = Math.max(backoffRef.current * 1.5, BACKOFF_MIN + 1000)
            scheduleReconnect()
          }
          return
        }

        // Ticker array form: [channelID, data, channelName, pair]
        if (Array.isArray(msg) && msg.length >= 4) {
          const [chanId, payload, channelName, pair] = msg
          if (channelName === 'ticker' && (channelIdRef.current == null || chanId === channelIdRef.current)) {
            const lastStr = payload?.c?.[0]
            if (lastStr != null) {
              const p = Number(lastStr)
              if (!Number.isNaN(p)) {
                setPrice(p)
                return
              }
            }
          }
          return
        }
      }

      ws.onclose = (ev) => {
        clearTimers()
        const code = ev?.code || 1005
        const reason = ev?.reason || ''
        setStatus('closed')
        if (!unsubscribedRef.current) {
          log(`WS closed (code=${code}${reason?`, reason="${reason}"`:''})`)
          scheduleReconnect()
        } else {
          log(`WS closed (clean)`)
        }
      }

      ws.onerror = () => {
        // errors also cause close with some agents; rely on onclose to reconnect
        log('WS error')
      }

    } catch (err) {
      setConnecting(false)
      setStatus('error')
      log(`WS init error: ${err?.message || err}`)
      scheduleReconnect()
    }
  }

  function disconnect(){
    unsubscribedRef.current = True
    safeClose(1000, 'manual')
    clearTimers()
    setStatus('disconnected')
  }

  // Visibility handling: on resume, if closed, reconnect
  useEffect(() => {
    function onVis(){
      if (document.visibilityState === 'visible') {
        // if no WS, try reconnect quickly with a small backoff reset
        if (!wsRef.current) {
          backoffRef.current = BACKOFF_MIN
          scheduleReconnect()
        }
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // Boot once
  useEffect(() => {
    log('Booting…')
    connect()
    return () => {
      clearTimers()
      safeClose(1000, 'unmount')
    }
  }, [])

  // Derived UI bits
  const statusBadge = useMemo(() => {
    const cls = status === 'open' ? 'badge ok' : (status === 'connecting' ? 'badge warn' : 'badge')
    return <span className={cls}>{status}</span>
  }, [status])

  const lastActivitySec = Math.max(0, Math.round(lastActivityAgo / 1000))

  return (
    <div className="wrap">
      <div className="hero">
        <div className="center">
          <div className="val">{price != null ? `$${price.toLocaleString()}` : '—'}</div>
          <div className="label">BTC/USD (Kraken)</div>
        </div>
        <div className="row">
          {statusBadge}
          <button onClick={() => { backoffRef.current = BACKOFF_MIN; connect(); }} disabled={connecting || status === 'open'}>
            Reconnect
          </button>
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <div className="label">Connection</div>
          <div className="small">
            Pair: {PAIR} • Last activity: {lastActivitySec}s ago • Backoff: {(backoffRef.current/1000).toFixed(1)}s
          </div>
        </div>
        <div className="card">
          <div className="label">Notes</div>
          <div className="small">Resets stale on heartbeat / status / ticker. Exponential backoff with jitter. Single WS and subscription.</div>
        </div>
      </div>

      <div className="card" style={{marginTop:12}}>
        <div className="label" style={{marginBottom:6}}>Logs</div>
        <div className="logs">
          {(logs||[]).map((line,i) => <div key={i}>{line}</div>)}
        </div>
      </div>
    </div>
  )
}