import React, { useEffect, useRef, useState } from 'react'
import { checkRollingAlert } from './alerts'

// ---- Config ----
const PAIR = 'XBT/USD'           // UI display
const WS_URL = 'wss://ws.kraken.com/'
const PAIR_ARG = 'XBT/USD'       // Kraken WS expects this format for "ticker"
const REST_TICKER = 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD'
const ALERTS_ENABLED = false
const THRESHOLD_PCT = 1
const QUIET = { start: 23, end: 7 } // 11pm–7am PT

const SPARK_MAX = 120

function Spark({ data }) {
  const w = 220, h = 44
  const n = data.length
  if (!n) return <svg className="spark" viewBox={`0 0 ${w} ${h}`} aria-hidden="true"></svg>
  const min = Math.min(...data), max = Math.max(...data)
  const range = max - min || 1
  let pts = ''
  for (let i=0; i<n; i++) {
    const x = (i/(n-1)) * (w-2) + 1
    const y = h - 1 - ((data[i] - min) / range) * (h-2)
    pts += (i? ' ' : '') + x.toFixed(1) + ',' + Math.min(h-1, Math.max(1, y)).toFixed(1)
  }
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label="sparkline">
      <polyline fill="none" stroke="currentColor" strokeWidth="1.5" points={pts} />
    </svg>
  )
}

export default function App(){
  const [status, setStatus] = useState('disconnected')
  const [price, setPrice] = useState(null)
  const [logs, setLogs] = useState([`Boot @ ${new Date().toLocaleTimeString()}`])
  const [ticks, setTicks] = useState(0)
  const [avgTickSec, setAvgTickSec] = useState('—')
  const [lastMsgAgo, setLastMsgAgo] = useState('—')

  const wsRef = useRef(null)
  const sparkRef = useRef([])
  const lastMsgAtRef = useRef(0)
  const lastTickAtRef = useRef(0)
  const backoffRef = useRef(1000) // 1s start
  const aliveIvRef = useRef(null)

  const log = (s) => setLogs(l => [s, ...l].slice(0, 400))

  // Minimal REST bootstrap for first paint
  useEffect(() => {
    fetch(REST_TICKER, { cache: 'no-store' })
      .then(r => r.json()).then(j => {
        const p = Number(j?.result?.XBTUSD?.c?.[0] || j?.result?.XXBTZUSD?.c?.[0])
        if (Number.isFinite(p)) {
          setPrice(p)
          const s = sparkRef.current; s.push(p); if (s.length > SPARK_MAX) s.shift()
          log(`REST bootstrap price ${p}`)
        }
      }).catch(()=>{})
  }, [])

  const connectWS = () => {
    if (wsRef.current) try { wsRef.current.close() } catch {}
    const ws = new WebSocket(WS_URL)
    wsRef.current = ws
    setStatus('connecting')
    log('WS connecting…')

    ws.onopen = () => {
      setStatus('open')
      backoffRef.current = 1000
      ws.send(JSON.stringify({ event: 'subscribe', pair: [PAIR_ARG], subscription: { name: 'ticker' } }))
      log('WS open → subscribed to ticker')
    }

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (Array.isArray(msg)) {
        // Ticker update: [channelID, data, pair]
        const data = msg[1]
        const last = Number(data?.c?.[0] || data?.a?.[0])
        if (Number.isFinite(last)) {
          const now = Date.now()
          setPrice(last)
          const s = sparkRef.current
          s.push(last); if (s.length > SPARK_MAX) s.shift()
          setTicks(t => t + 1)
          if (lastTickAtRef.current) {
            const dt = (now - lastTickAtRef.current) / 1000
            setAvgTickSec(prev => {
              const prevNum = prev === '—' ? dt : Number(prev)
              const smoothed = prevNum + 0.1*(dt - prevNum)
              return smoothed.toFixed(2)
            })
          }
          lastTickAtRef.current = now
          lastMsgAtRef.current = now

          // rolling baseline check (alerts off)
          checkRollingAlert({
            pairKey: 'XBT:USD',
            price: last,
            thresholdPct: THRESHOLD_PCT,
            quiet: QUIET,
            alertsEnabled: false,
            onNotify: () => {},
            log
          })
        }
        return
      }
      if (msg?.event === 'heartbeat') {
        lastMsgAtRef.current = Date.now()
        return
      }
      if (msg?.event === 'subscriptionStatus') {
        log(`subscriptionStatus: ${msg.status} (${msg.subscription?.name})`)
        return
      }
    }

    ws.onclose = (ev) => {
      setStatus('closed')
      log(`WS closed (code=${ev.code}${ev.reason ? `, reason="${ev.reason}"` : ''})`)
      const delay = Math.min(backoffRef.current *= 1.618, 30000)
      setTimeout(connectWS, delay)
      log(`Reconnecting in ${(delay/1000).toFixed(1)}s…`)
    }

    ws.onerror = () => {
      log('WS error')
    }
  }

  useEffect(() => {
    connectWS()
    return () => {
      if (aliveIvRef.current) clearInterval(aliveIvRef.current)
      if (wsRef.current) try { wsRef.current.close() } catch {}
    }
  }, [])

  // Panel heartbeat (every 1s)
  useEffect(() => {
    aliveIvRef.current = setInterval(() => {
      if (lastMsgAtRef.current) {
        const ago = ((Date.now() - lastMsgAtRef.current)/1000).toFixed(1)
        setLastMsgAgo(`${ago}s`)
      }
    }, 1000)
    return () => clearInterval(aliveIvRef.current)
  }, [])

  return (
    <div className="wrap">
      <div className="hero">
        <div>
          <div className="title">{PAIR}</div>
          <div className="row">
            <div className="val mono">{price ? price.toFixed(2) : '—'}</div>
            <Spark data={sparkRef.current} />
          </div>
          <div className="small muted">status: <span className={status === 'open' ? 'badge ok' : 'badge warn'}>{status}</span> · last msg: {lastMsgAgo}</div>
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <div className="label">Telemetry</div>
          <div className="small">Ticks: <span className="mono">{ticks}</span></div>
          <div className="small">Avg tick (s): <span className="mono">{avgTickSec}</span></div>
        </div>
        <div className="card">
          <div className="label">Controls</div>
          <div className="controls">
            <button onClick={() => { localStorage.removeItem('baseline:XBT:USD'); log('Baseline cleared'); }}>Clear baseline</button>
            <button onClick={() => { log('Manual reconnect requested'); connectWS() }} disabled={status==='connecting'}>Reconnect</button>
          </div>
        </div>
      </div>

      <div className="card" style={{marginTop: '12px'}}>
        <div className="label">Logs</div>
        <div className="logs">
          {logs.map((s,i)=>(<div key={i}>{s}</div>))}
        </div>
      </div>
    </div>
  )
}
