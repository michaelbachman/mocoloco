import React, { useEffect, useMemo, useRef, useState } from 'react'

const PAIR = 'XBT/USD'
const WS_URL = 'wss://ws.kraken.com'

const SUBSCRIBE_GUARD_MS = 2500
const BACKOFF_MIN_MS = 2000
const BACKOFF_MAX_MS = 60000
const JITTER_MS = 750
const STALE_TICK_MS = 20000
const PING_INTERVAL_MS = 15000
const LOG_FLUSH_MS = 10000
const LOG_MAX = 500

export default function App() {
  const [price, setPrice] = useState(null)
  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState('disconnected')
  const [logs, setLogs] = useState([])
  const [ticks, setTicks] = useState(0)

  const wsRef = useRef(null)
  const lastTickRef = useRef(0)
  const backoffRef = useRef(BACKOFF_MIN_MS)
  const lastSubAtRef = useRef(0)
  const pingIvRef = useRef(null)
  const logBufferRef = useRef([])
  const logFlushIvRef = useRef(null)
  const reconnectToRef = useRef(null)

  const nowPT = () => new Date().toLocaleTimeString('en-US', { hour12:false, timeZone:'America/Los_Angeles' })

  const pushLog = (s) => {
    const line = `[${nowPT()}] ${s}`
    logBufferRef.current.push(line)
    if (logBufferRef.current.length > LOG_MAX) {
      logBufferRef.current.splice(0, logBufferRef.current.length - LOG_MAX)
    }
  }

  useEffect(() => {
    pushLog('Booting…')
    logFlushIvRef.current = setInterval(() => {
      if (logBufferRef.current.length) {
        setLogs(prev => {
          const merged = [...logBufferRef.current, ...prev]
          logBufferRef.current = []
          return merged.slice(0, LOG_MAX)
        })
      }
    }, LOG_FLUSH_MS)
    return () => clearInterval(logFlushIvRef.current)
  }, [])

  const safeClose = () => {
    try { wsRef.current?.close() } catch {}
    wsRef.current = null
  }

  const scheduleReconnect = (why='reconnect') => {
    setConnected(false)
    setStatus('reconnecting')
    const delay = Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, backoffRef.current)) + Math.floor(Math.random()*JITTER_MS)
    pushLog(`Reconnecting in ${(delay/1000).toFixed(1)}s (${why})`)
    if (reconnectToRef.current) clearTimeout(reconnectToRef.current)
    reconnectToRef.current = setTimeout(() => {
      connectWS()
      backoffRef.current = Math.min(BACKOFF_MAX_MS, Math.round(backoffRef.current * 1.6))
    }, delay)
  }

  const resetBackoff = () => { backoffRef.current = BACKOFF_MIN_MS }

  const subscribe = () => {
    const now = Date.now()
    if (now - lastSubAtRef.current < SUBSCRIBE_GUARD_MS) {
      pushLog('Subscribe suppressed by guard window')
      return
    }
    lastSubAtRef.current = now
    const msg = { event:'subscribe', pair:[PAIR], subscription:{ name:'ticker' } }
    try {
      wsRef.current?.send(JSON.stringify(msg))
      pushLog(`WS → subscribe ${PAIR.replace('/','')}`)
    } catch (e) {
      pushLog('Send subscribe failed; will reconnect')
      scheduleReconnect('send-failed')
    }
  }

  const handleMsg = (ev) => {
    let data
    try { data = JSON.parse(ev.data) } catch { return }

    if (data.event) {
      if (data.event === 'heartbeat') return
      if (data.event === 'systemStatus') { pushLog(`WS ← systemStatus: ${data.status}`); return }
      if (data.event === 'subscriptionStatus') {
        if (data.status === 'subscribed') {
          pushLog(`WS ← subscribed ${data.subscription?.name} ${data.pair || ''}`)
          setStatus('connected'); setConnected(true); resetBackoff()
        } else {
          pushLog(`WS ← subscriptionStatus: ${data.status}${data.errorMessage ? ' — '+data.errorMessage : ''}`)
          scheduleReconnect('subscription-error')
        }
        return
      }
      return
    }

    if (Array.isArray(data) && data.length >= 4) {
      const payload = data[1]
      const last = payload?.c?.[0] || payload?.a?.[0] || payload?.b?.[0]
      const p = last ? Number(last) : NaN
      if (!Number.isFinite(p)) return
      lastTickRef.current = Date.now()
      setPrice(p)
      setTicks(t => t + 1)
    }
  }

  const connectWS = () => {
    safeClose()
    setStatus('connecting')
    pushLog(`Connecting WS for ${PAIR.replace('/','')}…`)

    try {
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        pushLog('WS open'); resetBackoff(); setConnected(true); setStatus('connected'); subscribe()
        if (pingIvRef.current) clearInterval(pingIvRef.current)
        pingIvRef.current = setInterval(() => {
          try { ws.send(JSON.stringify({ event:'ping' })) } catch {}
        }, PING_INTERVAL_MS)
      }
      ws.onmessage = handleMsg
      ws.onerror = () => { pushLog('WS error (see network tab)') }
      ws.onclose = (ev) => {
        if (pingIvRef.current) clearInterval(pingIvRef.current)
        const code = ev?.code || 1005
        pushLog(`WS closed (code=${code}${ev?.reason ? ', reason="'+ev.reason+'"' : ''})`)
        setConnected(false); setStatus('disconnected')
        scheduleReconnect('close')
      }
    } catch (e) {
      pushLog('WS init failed; scheduling reconnect')
      scheduleReconnect('init-failed')
    }
  }

  useEffect(() => {
    connectWS()
    const staleIv = setInterval(() => {
      const last = lastTickRef.current
      if (connected && last && (Date.now() - last) > STALE_TICK_MS) {
        pushLog('No ticks in 20s — reconnecting')
        scheduleReconnect('stale')
      }
    }, 5000)
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        const last = lastTickRef.current
        if (!connected || !last || (Date.now() - last) > STALE_TICK_MS) {
          pushLog('Page visible — ensuring live connection')
          scheduleReconnect('visible')
        }
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(staleIv)
      document.removeEventListener('visibilitychange', onVis)
      if (pingIvRef.current) clearInterval(pingIvRef.current)
      safeClose()
    }
  }, [])

  const statusClass = useMemo(() => {
    if (status === 'connected') return 'status ok'
    if (status === 'reconnecting' || status === 'connecting') return 'status'
    return 'status err'
  }, [status])

  return (
    <div className="wrap">
      <div className="hero">
        <div>
          <div className={statusClass}><span className="dot" /> <strong>Status:</strong>&nbsp;{status}</div>
          <div className="small">Public WS Ticker · Pair: {PAIR}</div>
        </div>
        <div className="card" aria-live="polite" aria-atomic="true">
          <div className="label">BTC/USD (last)</div>
          <div className="val">{price ? `$${price.toLocaleString(undefined, {maximumFractionDigits:2})}` : '—'}</div>
          <div className="small">ticks: {ticks}</div>
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <div className="row">
            <span className="badge ok">Connection</span>
            <span className="small">{connected ? 'Live' : 'Idle'}</span>
          </div>
          <div className="kv" style={{marginTop: '6px'}}>
            <div className="k">Endpoint</div><div className="v">{WS_URL}</div>
            <div className="k">Stale window</div><div className="v">{(STALE_TICK_MS/1000)|0}s</div>
            <div className="k">Backoff</div><div className="v">{BACKOFF_MIN_MS/1000|0}s → {BACKOFF_MAX_MS/1000|0}s (±{JITTER_MS}ms)</div>
            <div className="k">Subscribe guard</div><div className="v">{SUBSCRIBE_GUARD_MS}ms</div>
            <div className="k">Ping</div><div className="v">{PING_INTERVAL_MS/1000|0}s</div>
          </div>
        </div>

        <div className="card">
          <div className="row">
            <span className="badge warn">Telemetry</span>
            <span className="small">lightweight</span>
          </div>
          <div className="kv" style={{marginTop: '6px'}}>
            <div className="k">Ticks received</div><div className="v">{ticks}</div>
            <div className="k">Last tick (PT)</div><div className="v">{lastTickRef.current ? new Date(lastTickRef.current).toLocaleTimeString('en-US', {hour12:false, timeZone:'America/Los_Angeles'}) : '—'}</div>
            <div className="k">Price</div><div className="v">{price ? `$${price.toLocaleString(undefined,{maximumFractionDigits:2})}` : '—'}</div>
          </div>
        </div>
      </div>

      <div className="card" style={{marginTop: '12px'}}>
        <div className="row"><span className="badge">Logs</span><span className="small">flush {LOG_FLUSH_MS/1000|0}s · max {LOG_MAX}</span></div>
        <div className="logs" role="log" aria-live="polite" aria-relevant="additions text">
          {logs.map((l,i)=> <div key={i}>{l}</div>)}
        </div>
      </div>
    </div>
  )
}
