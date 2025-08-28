import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { clockSubscribe, clockGetSnapshot } from './clockStore'

// ---------- Helpers ----------
function nowPT() {
  try {
    return new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false })
  } catch { return new Date().toISOString() }
}

function Sparkline({ data = [], width = '100%', height = 52, stroke = '#4ade80' }) {
  const w = 200, h = 52
  const n = data.length
  if (!n) return (
    <svg width={width} height={height} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <line x1="1" y1={h/2} x2={w-1} y2={h/2} stroke="#9ca3af" strokeDasharray="4 3" strokeWidth="1" />
    </svg>
  )
  const xs = data.map((d,i) => (i/Math.max(1,n-1))*(w-2)+1)
  const vals = data.map(d => (Number.isFinite(d.r) ? d.r : 0))
  const min = Math.min(...vals), max = Math.max(...vals); const span = (max-min)||1
  const ys = vals.map(v => {
    const y = h-2 - ((v - min)/span)*(h-4)
    return Math.min(h-1, Math.max(1, y))
  })
  const pts = xs.map((x,i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ')
  return (
    <svg width={width} height={height} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="2" />
    </svg>
  )
}

// ---------- Config ----------
const PAIR = 'XBT/USD'
const WS_URL = 'wss://ws.kraken.com'

// ---------- Global heartbeat (moved into component to follow Hooks rules) ----------

export default function App(){
  const renderTick = useSyncExternalStore(clockSubscribe, clockGetSnapshot)
  // ---------- refs (declare FIRST to avoid TDZ) ----------
  const wsRef = useRef(null)
  const connectingRef = useRef(false)
  const lastMessageAtRef = useRef(0)

  const countersRef = useRef({
    connects: 0, disconnects: 0, messages: 0, ticks: 0, parseErrors: 0,
    watchdogResets: 0, rateDelayed: 0, queuedActions: 0
  })

  const backoffRef = useRef(0)
  const lastActionAtRef = useRef(0)
  const actionsWindowRef = useRef([]) // timestamps of actions for coarse rate limiting

  const avgTickMsRef = useRef(null)
  const lastTickRef = useRef(null)
  const ticksWindowRef = useRef([]) // timestamps of valid ticker messages

  const lastPriceRef = useRef(null)

  // 5-min delta ring buffer (10s sampling)
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

  // ---------- state ----------
  const [logs, setLogs] = useState([])
  const [renderBump, setRenderBump] = useState(0) // manual re-render ping for UI

  // ---------- Kraken connect (function declaration is hoisted) ----------
  function connectWS(reason = 'manual'){
    if (connectingRef.current) return
    connectingRef.current = true

    try { if (wsRef.current) wsRef.current.close() } catch {}

    const ws = new WebSocket(WS_URL)
    wsRef.current = ws
    countersRef.current.connects++
    setLogs(l => [`Connecting (${reason}) @ ${nowPT()} → ${PAIR}`, ...l])

    ws.onopen = () => {
      connectingRef.current = false
      backoffRef.current = 0
      const sub = { event: 'subscribe', pair: [PAIR], subscription: { name: 'ticker' } }
      ws.send(JSON.stringify(sub))
      setLogs(l => [`Subscribed ticker ${PAIR}`, ...l])
    }

    ws.onmessage = (ev) => {
      lastMessageAtRef.current = Date.now()
      countersRef.current.messages++

      try {
        const msg = JSON.parse(ev.data)
        if (Array.isArray(msg) && msg.length >= 4 && msg[2] === 'ticker') {
          // Message: [ channelID, data, 'ticker', 'XBT/USD' ]
          const data = msg[1]
          const last = Number(data?.c?.[0]) || Number(data?.a?.[0]) || null
          if (Number.isFinite(last)) {
            const now = Date.now()
            // avg tick interval
            if (lastTickRef.current != null) {
              const d = now - lastTickRef.current
              avgTickMsRef.current = avgTickMsRef.current == null ? d : (avgTickMsRef.current * 0.9 + d * 0.1)
            }
            lastTickRef.current = now
            ticksWindowRef.current.push(now)
            // last price for 5m sampler
            lastPriceRef.current = last
            countersRef.current.ticks++
          }
        } else if (msg?.event) {
          // heartbeat/status events ignored/logged
        }
      } catch (err) {
        countersRef.current.parseErrors++
      }
    }

    ws.onclose = () => {
      countersRef.current.disconnects++
      setLogs(l => [`WS closed @ ${nowPT()}`, ...l])
      // Backoff (exponential with cap + jitter)
      const base = Math.min(30000, (backoffRef.current || 1000) * 2)
      backoffRef.current = base + Math.floor(Math.random() * 500)
      setTimeout(() => connectWS('reconnect'), backoffRef.current)
    }

    ws.onerror = () => {
      setLogs(l => [`WS error @ ${nowPT()}`, ...l])
    }
  }

  // ---------- Initial connect ----------
  useEffect(() => { connectWS('initial') }, [])

  // ---------- 5-minute delta sampler (10s) ----------
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
      // bump UI occasionally
      setRenderBump(x => (x+1) % 1_000_000)
    }
  }, [renderTick])

  // ---------- Derived panel (read refs) ----------
  const nowMs = Date.now()
  const pruneTicks = (win) => {
    const arr = ticksWindowRef.current
    if (!Array.isArray(arr)) return 0
    const cutoff = nowMs - win
    const kept = arr.filter(t => t >= cutoff)
    ticksWindowRef.current = kept
    return kept.length
  }
  const ticks60 = pruneTicks(60000)
  const ticks300 = pruneTicks(300000)
  const rate60 = ticks60 / 60.0
  const rate300 = ticks300 / 300.0

  const panel = {
    now: nowPT(),
    connects: countersRef.current.connects,
    disconnects: countersRef.current.disconnects,
    messages: countersRef.current.messages,
    ticks: countersRef.current.ticks,
    parseErrors: countersRef.current.parseErrors,
    avgTickMs: avgTickMsRef.current,
    rate60, rate300, ticks60, ticks300,
    fiveMinChangePct: fiveMinPctRef.current,
    fiveMinChangeUsd: fiveMinUsdRef.current,
    fiveMinFresh: fiveMinFreshRef.current
  }

  // ---------- UI ----------
  return (
    <div>
      <div className="row">
        <div className="col">
          <div className="card">
            <div className="title">Connection</div>
            <div className="grid2">
              <div className="kv"><span className="k">Pair</span><span className="v mono">{PAIR}</span></div>
              <div className="kv"><span className="k">Now</span><span className="v mono">{panel.now}</span></div>
              <div className="kv"><span className="k">Connects</span><span className="v mono">{panel.connects}</span></div>
              <div className="kv"><span className="k">Disconnects</span><span className="v mono">{panel.disconnects}</span></div>
              <div className="kv"><span className="k">Messages</span><span className="v mono">{panel.messages}</span></div>
              <div className="kv"><span className="k">Ticks received</span><span className="v mono">{panel.ticks}</span></div>
              <div className="kv"><span className="k">Avg tick interval</span><span className="v mono">{panel.avgTickMs ? panel.avgTickMs.toFixed(0)+' ms' : '—'}</span></div>
              <div className="kv"><span className="k">Ticks (60s/300s)</span><span className="v mono">{panel.ticks60} / {panel.ticks300}</span></div>
              <div className="kv"><span className="k">Rate (60s/300s)</span><span className="v mono">{panel.rate60.toFixed(2)}/s • {panel.rate300.toFixed(2)}/s</span></div>
              <div className="kv"><span className="k">5m change</span>
                <span className="v mono">
                  {panel.fiveMinChangePct == null ? '—' :
                    `${panel.fiveMinChangePct >= 0 ? '+' : ''}${panel.fiveMinChangePct.toFixed(2)}% (${panel.fiveMinChangeUsd >= 0 ? '+' : ''}$${Math.abs(panel.fiveMinChangeUsd).toFixed(2)})${!panel.fiveMinFresh ? ' • stale' : ''}`}
                </span>
              </div>
            </div>
            <div className="small muted">Sparkline (60s rate)</div>
            <div className="spark">
              <Sparkline data={Array.from({length: Math.min(50, ticks60)}, (_,i) => ({ t: i, r: rate60 }))} />
            </div>
            <div style={{marginTop: 8, display: 'flex', gap: 8}}>
              <button onClick={() => connectWS('manual')} disabled={connectingRef.current}>Reconnect</button>
              <button onClick={() => setLogs(l => [])}>Clear logs</button>
            </div>
          </div>
        </div>

        <div className="col">
          <div className="card">
            <div className="title">Logs</div>
            <div className="logs mono">
              {logs.map((s, i) => <div key={i}>{s}</div>)}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
