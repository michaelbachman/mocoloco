// app.js — build-free, CSP-safe
const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => Array.from(document.querySelectorAll(sel))

// ---- Elements
const el = {
  pair: $('#pair'),
  price: $('#price'),
  baseline: $('#baseline'),
  direction: $('#direction'),
  deltaPct: $('#deltaPct'),
  deltaUsd: $('#deltaUsd'),
  lastUpdate: $('#lastUpdate'),
  connBadge: $('#connBadge'),
  ticks: $('#ticks'),
  avgTick: $('#avgTick'),
  recons: $('#recons'),
  backoff: $('#backoff'),
  nextAllowed: $('#nextAllowed'),
  logs: $('#logs'),
  clearLogs: $('#clearLogs'),
  autoscroll: $('#autoscroll'),
  reconnectBtn: $('#reconnectBtn'),
  spark: $('#spark'),
}

const LOG_MAX = 400
const PRICE_WINDOW_MS = 5 * 60 * 1000 // sparkline window 5m
const QUIET_START = 23 // 11pm PT
const QUIET_END = 7   // 7am PT
const RATE_LIMIT_MS = 1200 // polite pacing for actions/log bursts
const PING_INTERVAL_MS = 15000 // Kraken recommended heartbeat rhythm
const BACKOFF_MIN = 1500
const BACKOFF_MAX = 45000

let ws = null
let backoff = BACKOFF_MIN
let reconnects = 0
let ticks = 0
let lastTickAt = 0
let lastActionAt = 0
let pingTimer = null
let staleTimer = null

const priceSeries = [] // [{t, p}]
let rollingAvgTickMs = null

function nowPT() {
  return new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false })
}
function inQuietHours(d = new Date()) {
  const pt = new Date(d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }))
  const h = pt.getHours()
  return (QUIET_START > QUIET_END) ? (h >= QUIET_START || h < QUIET_END) : (h >= QUIET_START && h < QUIET_END)
}
function canAct() {
  const wait = Math.max(0, (lastActionAt + RATE_LIMIT_MS) - Date.now())
  el.nextAllowed.textContent = wait ? `${(wait/1000).toFixed(1)}s` : 'now'
  return wait === 0
}
function markAction() {
  lastActionAt = Date.now()
  el.nextAllowed.textContent = 'just now'
}
function log(msg, cls='') {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false })
  const div = document.createElement('div')
  if (cls) div.className = cls
  div.textContent = `[${time}] ${msg}`
  el.logs.appendChild(div)
  while (el.logs.childElementCount > LOG_MAX) el.logs.removeChild(el.logs.firstChild)
  if (el.autoscroll.checked) el.logs.scrollTop = el.logs.scrollHeight
}
function setConn(status) {
  el.connBadge.textContent = status
  el.connBadge.className = 'badge ' + (status === 'connected' ? 'ok' : status === 'connecting' ? 'warn' : '')
}
function setPrice(p) {
  el.price.textContent = p ? `$${Number(p).toLocaleString(undefined, {maximumFractionDigits:2})}` : '—'
}
function setDeltas(p, baseline) {
  if (!p || !baseline) { el.deltaPct.textContent='Δ%: —'; el.deltaUsd.textContent='Δ$: —'; el.direction.textContent='—'; return }
  const diff = p - baseline
  const pct = (diff / baseline) * 100
  el.deltaPct.textContent = `Δ%: ${pct.toFixed(2)}%`
  el.deltaUsd.textContent = `Δ$: ${diff >=0 ? '+' : ''}${diff.toFixed(2)}`
  const dir = diff === 0 ? 'flat' : diff > 0 ? 'up' : 'down'
  el.direction.textContent = dir
}
function setBaselineLabel(b) {
  el.baseline.textContent = `Baseline: ${b ? '$'+Number(b).toLocaleString(undefined,{maximumFractionDigits:2}) : '—'}`
}

// ---- Baseline per pair (rolling baseline; init on first observed price)
function baselineKey(pair){ return `baseline:${pair}` }
function getBaseline(pair){ const v = localStorage.getItem(baselineKey(pair)); return v ? Number(v) : null }
function setBaseline(pair, price){ localStorage.setItem(baselineKey(pair), String(price)); setBaselineLabel(price) }

// ---- Sparkline (SVG polyline)
function drawSpark() {
  const w = 260, h = 48
  const svg = el.spark
  while (svg.firstChild) svg.removeChild(svg.firstChild)
  const now = Date.now()
  const cut = now - PRICE_WINDOW_MS
  // prune
  for (let i = priceSeries.length - 1; i >=0; i--) {
    if (priceSeries[i].t < cut) { priceSeries.splice(0, i); break }
  }
  if (priceSeries.length < 2) return

  const min = Math.min(...priceSeries.map(d => d.p))
  const max = Math.max(...priceSeries.map(d => d.p))
  const span = (max - min) || 1
  const n = priceSeries.length
  let pts = ''
  for (let i=0;i<n;i++){
    const x = (i/(n-1)) * (w-2) + 1
    const y = h - 1 - ((priceSeries[i].p - min) / span) * (h-2)
    pts += (i ? ' ' : '') + x.toFixed(1) + ',' + Math.min(h-1, Math.max(1, y)).toFixed(1)
  }
  const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
  pl.setAttribute('points', pts)
  pl.setAttribute('fill', 'none')
  pl.setAttribute('stroke', 'currentColor')
  pl.setAttribute('stroke-width', '2')
  svg.appendChild(pl)
}

// ---- Kraken REST fetch for initial price (fast LCP)
async function fetchREST(pair){
  try{
    const u = `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(pair)}`
    const res = await fetch(u, { cache: 'no-store', credentials: 'omit' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = await res.json()
    const k = Object.keys(j.result || {})[0]
    const a = j.result?.[k]?.a?.[0]
    const p = a ? Number(a) : null
    if (p){
      setPrice(p)
      el.lastUpdate.textContent = nowPT() + ' PT'
      priceSeries.push({ t: Date.now(), p })
      drawSpark()
      let b = getBaseline(pair)
      if (b == null) { setBaseline(pair, p); log(`Baseline initialized @ $${p}`, 'ok') }
      setDeltas(p, getBaseline(pair))
    } else {
      log('REST parse error', 'err')
    }
  }catch(err){
    log(`REST error: ${err.message}`, 'err')
  }
}

// ---- Kraken WebSocket ticker
function subscribeWS(socket, pair){
  const payload = { event: 'subscribe', pair: [pair], subscription: { name: 'ticker' } }
  socket.send(JSON.stringify(payload))
  log(`WS → subscribe ${pair}`)
  markAction()
}
function heartbeat(socket){
  try { socket.send(JSON.stringify({ event: 'ping' })); markAction(); } catch{}
}
function startStaleTimer(){
  if (staleTimer) clearTimeout(staleTimer)
  staleTimer = setTimeout(()=>{
    log('No ticks in 30s — reconnecting', 'warn')
    try { ws && ws.close() } catch{}
  }, 30000)
}

function connect(){
  const pair = el.pair.value
  setConn('connecting')
  log(`Connecting WS for ${pair}…`)

  if (ws) { try { ws.close() } catch{} ws = null }
  ws = new WebSocket('wss://ws.kraken.com')

  ws.onopen = () => {
    setConn('connected')
    backoff = BACKOFF_MIN
    subscribeWS(ws, pair)
    if (pingTimer) clearInterval(pingTimer)
    pingTimer = setInterval(()=> heartbeat(ws), PING_INTERVAL_MS)
    startStaleTimer()
  }

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    // Heartbeats & system events
    if (msg.event){
      if (msg.event === 'subscriptionStatus') {
        log(`WS ← subscriptionStatus: ${msg.status}`)
      } else if (msg.event === 'heartbeat') {
        // noop
      } else if (msg.event === 'systemStatus') {
        log(`WS ← systemStatus: ${msg.status}`)
      }
      return
    }
    // Ticker array message: [channelID, {a:[price,...], ...}, "ticker", "XBT/USD"]
    if (Array.isArray(msg) && msg[2] === 'ticker'){
      const a = msg[1]?.a?.[0]
      const price = a ? Number(a) : null
      if (price){
        ticks += 1
        const now = Date.now()
        if (lastTickAt){
          const dt = now - lastTickAt
          rollingAvgTickMs = rollingAvgTickMs == null ? dt : (rollingAvgTickMs*0.9 + dt*0.1)
        }
        lastTickAt = now
        setPrice(price)
        el.ticks.textContent = String(ticks)
        el.avgTick.textContent = rollingAvgTickMs ? (rollingAvgTickMs/1000).toFixed(2) : '—'
        el.lastUpdate.textContent = nowPT() + ' PT'
        priceSeries.push({ t: now, p: price })
        drawSpark()
        const b = getBaseline(el.pair.value)
        if (b == null) setBaseline(el.pair.value, price)
        setDeltas(price, getBaseline(el.pair.value))
        startStaleTimer()
      }
    }
  }

  ws.onclose = (ev) => {
    setConn('disconnected')
    const code = ev?.code || 1006
    const reason = ev?.reason || ''
    log(`WS closed (code=${code}${reason ? ', reason="'+reason+'"' : ''})`, code===1000 ? '' : 'warn')
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
    if (staleTimer) { clearTimeout(staleTimer); staleTimer = null }
    reconnects += 1
    el.recons.textContent = String(reconnects)
    // Exponential backoff (jittered)
    backoff = Math.min(BACKOFF_MAX, backoff * 1.6)
    const jitter = Math.random() * 0.25 * backoff
    const delay = Math.round(backoff + jitter)
    el.backoff.textContent = String(delay)
    setTimeout(()=>{
      if (document.visibilityState === 'hidden') {
        log('Tab hidden — delaying reconnect until visible', 'warn')
        const onVis = () => {
          if (document.visibilityState === 'visible') {
            document.removeEventListener('visibilitychange', onVis)
            log('Tab visible — reconnecting')
            connect()
          }
        }
        document.addEventListener('visibilitychange', onVis)
        return
      }
      log(`Reconnecting…`)
      connect()
    }, delay)
  }

  ws.onerror = (ev) => {
    log('WS error', 'err')
  }
}

// ---- UI bindings
el.clearLogs.addEventListener('click', () => { el.logs.textContent=''; log('Logs cleared', 'ok') })
el.reconnectBtn.addEventListener('click', () => { log('Manual reconnect requested'); try{ ws && ws.close() }catch{} })
el.pair.addEventListener('change', () => {
  // Reset telemetry for clarity
  ticks = 0; el.ticks.textContent='0'
  rollingAvgTickMs = null; el.avgTick.textContent='—'
  el.price.textContent='—'
  priceSeries.length = 0
  log(`Pair changed to ${el.pair.value}`)
  // Ensure we have a baseline
  const b = getBaseline(el.pair.value)
  setBaselineLabel(b)
  // Try a quick REST seed
  fetchREST(el.pair.value)
  // Resubscribe
  try { ws && ws.close() } catch {}
})

// ---- First load: seed price via REST for fast paint, then WS
;(async function boot(){
  log('Booting…')
  setBaselineLabel(getBaseline(el.pair.value))
  await fetchREST(el.pair.value)
  connect()
})()

// ---- Background tab hints (reduce network churn)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    // let WS handle itself; we just slow actions timer UI
  } else {
    // on visible, UI will refresh on next tick; we may send a ping soon
  }
})
