import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { clockSubscribe, clockGetSnapshot } from './clockStore'

const WS_URL = 'wss://ws.kraken.com'
const PAIR = 'XBT/USD'

function nowPT() {
  try { return new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false }) }
  catch { return new Date().toISOString() }
}

function Sparkline({ data = [], width = '100%', height = 44, stroke = '#16a34a' }) {
  const w = 200, h = 44
  const n = data.length
  if (!n) return <svg width={width} height={height} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
    <line x1="1" y1={h/2} x2={w-1} y2={h/2} stroke="#bbb" strokeDasharray="4 3" strokeWidth="1" />
  </svg>
  const xs = data.map((d,i)=> (i/Math.max(1,n-1))*(w-2)+1)
  const vals = data.map(d => Number.isFinite(d.r)? d.r : 0)
  const min = Math.min(...vals), max = Math.max(...vals); const span = (max-min)||1
  const ys = vals.map(v => { const y = h-2 - ((v-min)/span)*(h-4); return Math.min(h-1, Math.max(1,y)) })
  const pts = xs.map((x,i)=> `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ')
  return <svg width={width} height={height} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
    <polyline points={pts} fill="none" stroke={stroke} strokeWidth="2" />
  </svg>
}

export default function App(){
  const renderTick = useSyncExternalStore(clockSubscribe, clockGetSnapshot)

  // --- Refs ---
  const wsRef = useRef(null)
  const connectingRef = useRef(false)

  const countersRef = useRef({ connects:0, disconnects:0, messages:0, ticks:0, parseErrors:0 })
  const avgTickMsRef = useRef(null)
  const lastTickRef = useRef(null)
  const ticksWindowRef = useRef([])
  const lastPriceRef = useRef(null)
  const tickRateHistoryRef = useRef([])

  // 5-minute delta ring buffer (10s sampling)
  const FIVE_MIN_MS = 5 * 60 * 1000
  const SAMPLE_EVERY_MS = 10_000
  const SLOTS = Math.ceil(FIVE_MIN_MS / SAMPLE_EVERY_MS)
  const ringIdxRef = useRef(0)
  const ringTsRef  = useRef(new Array(SLOTS).fill(0))
  const ringPxRef  = useRef(new Array(SLOTS).fill(null))
  const lastSampleAtRef = useRef(0)
  const fiveMinPctRef = useRef(null)
  const fiveMinUsdRef = useRef(null)
  const fiveMinFreshRef = useRef(false)

  const [logs, setLogs] = useState([])

  function connectWS(reason='manual'){
    if (connectingRef.current) return
    connectingRef.current = true
    try { if (wsRef.current) wsRef.current.close() } catch {}

    const ws = new WebSocket(WS_URL)
    wsRef.current = ws
    countersRef.current.connects++
    setLogs(l => [`[${nowPT()}] Connecting: ${PAIR} (${reason})`, ...l])

    ws.onopen = () => {
      connectingRef.current = false
      const sub = { event:'subscribe', pair:[PAIR], subscription:{ name:'ticker' } }
      ws.send(JSON.stringify(sub))
      setLogs(l => [`[${nowPT()}] Subscribed ticker ${PAIR}`, ...l])
    }

    ws.onmessage = (ev) => {
      countersRef.current.messages++
      try {
        const msg = JSON.parse(ev.data)
        if (Array.isArray(msg) && msg.length >= 4 && msg[2] === 'ticker') {
          const data = msg[1]
          const last = Number(data?.c?.[0]) || Number(data?.a?.[0]) || null
          if (Number.isFinite(last)) {
            const now = Date.now()
            if (lastTickRef.current != null) {
              const d = now - lastTickRef.current
              avgTickMsRef.current = avgTickMsRef.current == null ? d : (avgTickMsRef.current*0.9 + d*0.1)
            }
            lastTickRef.current = now
            ticksWindowRef.current.push(now)
            lastPriceRef.current = last
            countersRef.current.ticks++
          }
        }
      } catch { countersRef.current.parseErrors++ }
    }

    ws.onclose = () => {
      countersRef.current.disconnects++
      setLogs(l => [`[${nowPT()}] WS closed`, ...l])
      const delay = Math.min(30000, ((avgTickMsRef.current || 1000) * 2)) + Math.floor(Math.random()*500)
      setTimeout(() => connectWS('reconnect'), delay)
    }

    ws.onerror = () => setLogs(l => [`[${nowPT()}] WS error`, ...l])
  }

  useEffect(() => { connectWS('initial') }, [])

  // 5m delta sampler (every 10s) — minimal
  useEffect(() => {
    const now = Date.now()
    const lastPx = lastPriceRef.current
    if (!lastPx) return

    if (now - lastSampleAtRef.current >= SAMPLE_EVERY_MS) {
      lastSampleAtRef.current = now
      const i = ringIdxRef.current
      ringTsRef.current[i] = now
      ringPxRef.current[i] = lastPx
      ringIdxRef.current = (i + 1) % SLOTS

      const head = ringIdxRef.current
      const headTs = ringTsRef.current[head]
      const headPx = ringPxRef.current[head]

      if (headPx != null && (now - headTs) >= (FIVE_MIN_MS - SAMPLE_EVERY_MS)) {
        const usd = lastPx - headPx
        const pct = (usd / headPx) * 100
        fiveMinUsdRef.current = usd
        fiveMinPctRef.current = pct
        fiveMinFreshRef.current = (now - lastSampleAtRef.current) < 15000
      } else {
        fiveMinUsdRef.current = null
        fiveMinPctRef.current = null
        fiveMinFreshRef.current = false
      }
    }
  }, [renderTick])

  // sparkline sample (rate60) — each second
  useEffect(() => {
    const now = Date.now()
    const arr = ticksWindowRef.current
    const cutoff = now - 60000
    const kept = arr.filter(t => t >= cutoff)
    ticksWindowRef.current = kept
    const rate60 = kept.length / 60
    const hist = tickRateHistoryRef.current.concat({ t: now, r: rate60 })
    tickRateHistoryRef.current = hist.slice(-50)
  }, [renderTick])

  // derived snapshot
  const nowMs = Date.now()
  const t60 = ticksWindowRef.current.filter(t => t >= nowMs - 60000).length
  const t300 = ticksWindowRef.current.filter(t => t >= nowMs - 300000).length
  const rate60 = t60 / 60.0
  const rate300 = t300 / 300.0

  return (
    <div>
      <div className="row">
        <div className="col">
          <h2>Connection</h2>
          <div className="kv"><span className="k">Pair</span><span className="mono">{PAIR}</span></div>
          <div className="kv"><span className="k">Connects</span><span className="mono">{countersRef.current.connects}</span></div>
          <div className="kv"><span className="k">Disconnects</span><span className="mono">{countersRef.current.disconnects}</span></div>
          <div className="kv"><span className="k">Messages</span><span className="mono">{countersRef.current.messages}</span></div>
          <div className="kv"><span className="k">Ticks</span><span className="mono">{countersRef.current.ticks}</span></div>
          <div className="kv"><span className="k">Avg tick interval</span><span className="mono">{avgTickMsRef.current ? `${avgTickMsRef.current.toFixed(0)} ms` : '—'}</span></div>
          <div className="kv"><span className="k">Ticks (60s / 300s)</span><span className="mono">{t60} / {t300}</span></div>
          <div className="kv"><span className="k">Rate (60s / 300s)</span><span className="mono">{rate60.toFixed(2)}/s • {rate300.toFixed(2)}/s</span></div>
          <div className="kv"><span className="k">5m change</span><span className="mono">
            {fiveMinPctRef.current == null ? '—' :
              `${fiveMinPctRef.current >= 0 ? '+' : ''}${fiveMinPctRef.current.toFixed(2)}% (${fiveMinUsdRef.current >= 0 ? '+' : ''}$${Math.abs(fiveMinUsdRef.current).toFixed(2)})${!fiveMinFreshRef.current ? ' • stale' : ''}`}
          </span></div>
          <div className="spark"><Sparkline data={tickRateHistoryRef.current} /></div>
          <div style={{marginTop:8}}><button onClick={()=>connectWS('manual')} disabled={connectingRef.current}>Reconnect</button></div>
        </div>
        <div className="col">
          <h2>Logs</h2>
          <div className="logs mono">
            {logs.map((s,i)=><div key={i}>{s}</div>)}
          </div>
        </div>
      </div>
    </div>
  )
}
