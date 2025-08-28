import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { clockSubscribe, clockGetSnapshot } from './clockStore'

const WS_URL = 'wss://ws.kraken.com'
const PAIR = 'XBT/USD' // display label; WS uses this pair for ticker

function nowPT() {
  try { return new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false }) }
  catch { return new Date().toISOString() }
}

// Memoized inline SVG sparkline (max ~60 points recommended)
const Sparkline = React.memo(function Sparkline({ data = [], width = '100%', height = 44, stroke = '#16a34a' }) {
  const w = 200, h = 44
  const n = data.length
  if (!n) return (
    <svg width={width} height={height} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <line x1="1" y1={h/2} x2={w-1} y2={h/2} stroke="#bbb" strokeDasharray="4 3" strokeWidth="1" />
    </svg>
  )
  let min = Infinity, max = -Infinity
  for (let i=0;i<n;i++){ const v = data[i]; if (v < min) min = v; if (v > max) max = v }
  const span = (max - min) || 1
  const step = (w - 2) / Math.max(1, n - 1)
  let pts = ''
  for (let i=0;i<n;i++){
    const x = 1 + step * i
    const y = h - 2 - ((data[i] - min) / span) * (h - 4)
    pts += (i? ' ' : '') + x.toFixed(1) + ',' + Math.min(h-1, Math.max(1, y)).toFixed(1)
  }
  return (
    <svg width={width} height={height} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="2" />
    </svg>
  )
})

export default function App(){
  const renderTick = useSyncExternalStore(clockSubscribe, clockGetSnapshot)

  // ---- WS + metrics refs (no state writes in hot path) ----
  const wsRef = useRef(null)
  const connectingRef = useRef(false)
const connectedRef = useRef(false)

// timers
const reconnectTRef = useRef(null)
const pingTRef = useRef(null)
const staleTRef = useRef(null)

// backoff
const backoffMsRef = useRef(1000)         // start 1s
const BACKOFF_MAX_MS = 30_000
const BACKOFF_MIN_MS = 1_000

// last activity
const lastMsgAtRef = useRef(0)            // any inbound message (incl. heartbeat)


  const connectsRef = useRef(0)
  const disconnectsRef = useRef(0)
  const messagesRef = useRef(0)
  const ticksRef = useRef(0)
  const parseErrorsRef = useRef(0)

  const lastPriceRef = useRef(null)
  const lastTickAtRef = useRef(null)    // timestamp (ms) of last valid ticker
  const avgTickMsRef = useRef(null)     // EWMA of inter-tick interval
  const pageHiddenRef = useRef(false)      // track page visibility

  const subscribedRef = useRef(false)     // ticker subscription state

  // ---- Tick-rate second buckets (300s ring) ----
  const SEC_BUCKETS = 300
  const secBucketsRef = useRef(new Array(SEC_BUCKETS).fill(0)) // per-second tick counts
  const secIdxRef = useRef(0)                                  // index of current second bucket
  const lastSecRef = useRef(Math.floor(Date.now()/1000))       // last rolled second

  function rollSeconds(toSec){
    // advance ring to 'toSec', zeroing new buckets
    let cur = lastSecRef.current
    if (toSec <= cur) return
    const steps = Math.min(SEC_BUCKETS, toSec - cur)
    for (let s=0; s<steps; s++){
      secIdxRef.current = (secIdxRef.current + 1) % SEC_BUCKETS
      secBucketsRef.current[secIdxRef.current] = 0
    }
    lastSecRef.current = toSec
  }

  function addTickToCurrentSecond(){
    const nowSec = Math.floor(Date.now()/1000)
    if (nowSec !== lastSecRef.current) rollSeconds(nowSec)
    secBucketsRef.current[secIdxRef.current]++
  }

  function clearTimers() {
  if (reconnectTRef.current) { clearTimeout(reconnectTRef.current); reconnectTRef.current = null }
  if (pingTRef.current) { clearInterval(pingTRef.current); pingTRef.current = null }
  if (staleTRef.current) { clearInterval(staleTRef.current); staleTRef.current = null }
}

function scheduleReconnect(reason='reconnect') {
  if (reconnectTRef.current) return
  const jitter = Math.floor(Math.random() * 400)
  const delay = Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, backoffMsRef.current)) + jitter
  reconnectTRef.current = setTimeout(() => {
    reconnectTRef.current = null
    connectWS(reason)
  }, delay)
}

function resetBackoff() {
  backoffMsRef.current = BACKOFF_MIN_MS
}
function growBackoff() {
  backoffMsRef.current = Math.min(BACKOFF_MAX_MS, Math.floor(backoffMsRef.current * 1.8))
}

// ---- 60-minute 10s sampler for deltas (1/5/10/30/60m) ----
  const SAMPLE_EVERY_MS = 10_000
  const MAX_WINDOW_MS = 60 * 60 * 1000
  const SLOTS = Math.ceil(MAX_WINDOW_MS / SAMPLE_EVERY_MS) // 360
  const ringIdxRef = useRef(0)
  const ringTsRef  = useRef(new Array(SLOTS).fill(0))
  const ringPxRef  = useRef(new Array(SLOTS).fill(null))
  const lastSampleAtRef = useRef(0)

  function deltaForMinutes(mins){
    const slotsBack = Math.round((mins * 60_000) / SAMPLE_EVERY_MS)
    if (!Number.isFinite(slotsBack) || slotsBack <= 0 || slotsBack >= SLOTS) return { usd:null, pct:null, fresh:false }
    const tailIdx = (ringIdxRef.current - 1 + SLOTS) % SLOTS
    const headIdx = (tailIdx - slotsBack + SLOTS*10) % SLOTS
    const headPx = ringPxRef.current[headIdx]
    const tailPx = ringPxRef.current[tailIdx]
    const headTs = ringTsRef.current[headIdx]
    const tailTs = ringTsRef.current[tailIdx]
    if (headPx != null && tailPx != null && headTs && tailTs){
      if ((Date.now() - headTs) >= (mins * 60_000 - SAMPLE_EVERY_MS)){
        const usd = tailPx - headPx
        const pct = (usd / headPx) * 100
        const fresh = (Date.now() - tailTs) < 15_000
        return { usd, pct, fresh }
      }
    }
    return { usd:null, pct:null, fresh:false }
  }

  // ---- Logs (buffered; flush every 10s; cap 150 lines) ----
  const logsBufferRef = useRef([])
  const [logs, setLogs] = useState([])
  function log(msg){ logsBufferRef.current.push(`[${nowPT()}] ${msg}`) }

  // ---- Connect WS ----
  function connectWS(reason='manual'){
    // guard: if currently connecting or connected, don't open another
    if (connectingRef.current || connectedRef.current) return

    // clear any pending reconnect
    if (reconnectTRef.current) { clearTimeout(reconnectTRef.current); reconnectTRef.current = null }

    connectingRef.current = true
    try{ if (wsRef.current) wsRef.current.close() }catch{}
    const ws = new WebSocket(WS_URL)
    wsRef.current = ws
    connectsRef.current++
    log(`Connecting: ${PAIR} (${reason})`)

    ws.onopen = () => {
      subscribedRef.current = false
      connectingRef.current = false
      connectedRef.current = true
      resetBackoff()
      lastMsgAtRef.current = Date.now()

      // subscribe ticker
      const sub = { event:'subscribe', pair:[PAIR], subscription:{ name:'ticker' } }
      ws.send(JSON.stringify(sub))
      log(`Subscribed ticker ${PAIR}`)

      // keepalive ping ~25s
      if (!pingTRef.current) {
        pingTRef.current = setInterval(() => {
          try { ws.send(JSON.stringify({ event:'ping', reqid: Date.now() })) } catch {}
        }, 30_000)
      }
      // stale link monitor: if no msgs >35s, force reconnect
      if (!staleTRef.current) {
        staleTRef.current = setInterval(() => {
          const silentMs = Date.now() - lastMsgAtRef.current
          if (silentMs > 45_000) {
            log('Stale WS (>35s no msgs); closing to reconnect')
            try { ws.close(4000, 'stale') } catch {}
          }
        }, 5_000)
      }
    }

    ws.onmessage = (ev) => {
      messagesRef.current++
      lastMsgAtRef.current = Date.now()
      try{
        const msg = JSON.parse(ev.data)
        if (msg?.event === 'heartbeat' || msg?.event === 'pong') return
        if (msg?.event === 'subscriptionStatus') {
          const ok = msg?.status === 'subscribed' && msg?.subscription?.name === 'ticker'
          if (ok) {
            subscribedRef.current = true
            log(`✅ Subscribed to ticker (pair=${msg?.pair || PAIR})`)
          } else if (msg?.status === 'error') {
            log(`❌ Subscription error: ${msg?.errorMessage || 'unknown'}`)
          }
          return
        }

        if (Array.isArray(msg) && msg.length >= 4 && msg[2] === 'ticker'){
          const data = msg[1]
          const last = Number(data?.c?.[0]) || Number(data?.a?.[0]) || null
          if (Number.isFinite(last)){
            const now = Date.now()
            if (lastTickAtRef.current != null){
              const d = now - lastTickAtRef.current
              avgTickMsRef.current = avgTickMsRef.current == null ? d : (avgTickMsRef.current*0.9 + d*0.1)
            }
            lastTickAtRef.current = now
            lastPriceRef.current = last
            ticksRef.current++
            addTickToCurrentSecond()
          }
        }
      }catch{
        parseErrorsRef.current++
      }
    }

    ws.onerror = () => {
      log('WS error')
      // let onclose handle the reconnect
    }

    ws.onclose = (ev) => {
      subscribedRef.current = false
      connectedRef.current = false
      connectingRef.current = false
      disconnectsRef.current++

      const codes = {
        1000: 'Normal Closure',
        1001: 'Going Away',
        1002: 'Protocol Error',
        1003: 'Unsupported Data',
        1005: 'No Status Received',
        1006: 'Abnormal Closure (no close frame)',
        1007: 'Invalid Frame Payload',
        1008: 'Policy Violation',
        1009: 'Message Too Big',
        1010: 'Mandatory Extension',
        1011: 'Internal Error',
        1012: 'Service Restart',
        1013: 'Try Again Later',
        1015: 'TLS Handshake Failure'
      }
      const code = ev?.code ?? 'n/a'
      const friendly = codes[code] || 'Unknown'
      const reason = ev?.reason || ''

      const extra = reason ? `, reason="${reason}"` : ""; log(`WS closed (code=${code} — ${friendly}${extra})`)
      if (code === 1006) {
        log('ℹ️  1006 Abnormal Closure is often due to network/idle conditions; reconnecting with backoff')
      }

      clearTimers()
      growBackoff()
      scheduleReconnect('onclose')
    }
  }

  useEffect(() => {
  const id = setTimeout(() => connectWS('initial'), 150)
  return () => clearTimeout(id)
}, [])


  useEffect(() => {
  const id = setTimeout(() => connectWS('initial'), 150)
  return () => clearTimeout(id)
}, [])

  useEffect(() => {
  return () => {
    clearTimers()
    try { wsRef.current?.close(1000, 'unmount') } catch {}
    wsRef.current = null
    connectedRef.current = false
    connectingRef.current = false
  }
}, [])
  useEffect(() => {
  function onVis() {
    pageHiddenRef.current = document.visibilityState === 'hidden'
  }
  onVis()
  document.addEventListener('visibilitychange', onVis)
  return () => document.removeEventListener('visibilitychange', onVis)
}, [])
  // Lazy-mount logs shortly after first paint to avoid delaying LCP
useEffect(() => {
  const id = setTimeout(() => setShowLogs(true), 800)
  return () => clearTimeout(id)
}, [])

  // ---- Periodic snapshot (every 2s) ----
  const [ui, setUi] = useState(null)
  const sparkDataRef = useRef([]) // numbers, max 60

  useEffect(() => {
    // advance second ring to keep buckets current (even with no messages)
    const nowSec = Math.floor(Date.now()/1000)
    rollSeconds(nowSec)

    // only snapshot every 2s
    const cadence = pageHiddenRef.current ? 10 : 2;
    if ((renderTick % cadence) !== 0) return

    // sample into 10s ring if due
    const now = Date.now()
    const lastPx = lastPriceRef.current
    if (lastPx != null && (now - lastSampleAtRef.current) >= SAMPLE_EVERY_MS){
      lastSampleAtRef.current = now
      const i = ringIdxRef.current
      ringTsRef.current[i] = now
      ringPxRef.current[i] = lastPx
      ringIdxRef.current = (i + 1) % SLOTS
    }

    // compute rates with small O(60/300) loops
    let s60 = 0, s300 = 0
    const buckets = secBucketsRef.current
    for (let i=0;i<60;i++){
      const idx = (secIdxRef.current - i + SEC_BUCKETS*2) % SEC_BUCKETS
      s60 += buckets[idx]
    }
    for (let i=0;i<SEC_BUCKETS;i++){ s300 += buckets[i] }

    const rate60 = s60 / 60
    const rate300 = s300 / 300

    // update sparkline (max 60 points)
    const sd = sparkDataRef.current
    sd.push(rate60)
    if (sd.length > 60) sd.shift()

    // derive deltas
    const d1 = deltaForMinutes(1)
    const d5 = deltaForMinutes(5)
    const d10 = deltaForMinutes(10)
    const d30 = deltaForMinutes(30)
    const d60 = deltaForMinutes(60)

    // preformat strings
    const fmtUsd = (x) => (x==null? '—' : (x>=0? '+' : '-') + '$' + Math.abs(x).toFixed(2))
    const fmtPct = (x) => (x==null? '—' : (x>=0? '+' : '') + x.toFixed(2) + '%')
    const fmtChange = (d) => (d.pct==null? '—' : `${fmtPct(d.pct)} (${fmtUsd(d.usd)})${!d.fresh ? ' • stale' : ''}`)

    const panel = {
      pair: PAIR,
      subscribed: subscribedRef.current ? 'active' : 'pending',
      connects: String(connectsRef.current),
      disconnects: String(disconnectsRef.current),
      messages: String(messagesRef.current),
      ticks: String(ticksRef.current),
      avgTick: avgTickMsRef.current == null ? '—' : `${avgTickMsRef.current.toFixed(0)} ms`,
      lastPrice: lastPx == null ? '—' : `$${lastPx.toFixed(2)}`,
      t60: String(s60),
      t300: String(s300),
      rate60: `${rate60.toFixed(2)}/s`,
      rate300: `${rate300.toFixed(2)}/s`,
      ch1: fmtChange(d1),
      ch5: fmtChange(d5),
      ch10: fmtChange(d10),
      ch30: fmtChange(d30),
      ch60: fmtChange(d60),
      spark: sd.slice() // pass by value so memo sees a change only when updated
    }
    setUi(panel)

    // flush logs every 10s
    if ((renderTick % 10) === 0){
      const buf = logsBufferRef.current
      if (buf.length){
        const next = (buf.splice(0, buf.length).concat(logs)).slice(0,150)
        setLogs(next)
      }
    }
  }, [renderTick])

  if (!ui){
    return <div>Loading…</div>
  }

  return (
    <div>
      <div className="row">
        <div className="col">
          <h2>Connection</h2>
          <div className="kv"><span className="k">Pair</span><span className="mono">{ui.pair}</span></div>
<div className="kv"><span className="k">Ticker status</span><span className="mono">{ui.subscribed}</span></div>
          <div className="kv"><span className="k">Current price</span><span className="mono">{ui.lastPrice}</span></div>
          <div className="kv"><span className="k">Connects</span><span className="mono">{ui.connects}</span></div>
          <div className="kv"><span className="k">Disconnects</span><span className="mono">{ui.disconnects}</span></div>
          <div className="kv"><span className="k">Messages</span><span className="mono">{ui.messages}</span></div>
          <div className="kv"><span className="k">Ticks</span><span className="mono">{ui.ticks}</span></div>
          <div className="kv"><span className="k">Avg tick interval</span><span className="mono">{ui.avgTick}</span></div>
          <div className="kv"><span className="k">Ticks (60s / 300s)</span><span className="mono">{ui.t60} / {ui.t300}</span></div>
          <div className="kv"><span className="k">Rate (60s / 300s)</span><span className="mono">{ui.rate60} • {ui.rate300}</span></div>
          <div className="kv"><span className="k">1m change</span><span className="mono">{ui.ch1}</span></div>
          <div className="kv"><span className="k">5m change</span><span className="mono">{ui.ch5}</span></div>
          <div className="kv"><span className="k">10m change</span><span className="mono">{ui.ch10}</span></div>
          <div className="kv"><span className="k">30m change</span><span className="mono">{ui.ch30}</span></div>
          <div className="kv"><span className="k">60m change</span><span className="mono">{ui.ch60}</span></div>
          <div className="spark"><Sparkline data={ui.spark} /></div>
          <div style={{marginTop:8}}><button onClick={() => { setLogs(l => [`Manual reconnect requested (${nowPT()} PT)`, ...l]); connectWS() }} disabled={connectingRef.current}>Reconnect</button></div>
        </div>
        <div className="col">
          {showLogs && (<>
        <h2>Logs</h2>
          <div className="logs mono">
            {logs.map((s,i)=><div key={i}>{s}</div>)}
          </div>
        </>)}
      </div>
    </div>
  </div>
  )
}