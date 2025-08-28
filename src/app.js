import { nowPTDate, inQuietHoursPT } from './time.js'
import { getBaseline, setBaseline, logBuffer } from './storage.js'

// ---- Config (can be changed at runtime via the pair <select>) ----
const DEFAULT_PAIR = 'XBTUSD'        // also supports ETHUSD, SOLUSD
const THRESHOLD = 0.01               // 1% threshold
const POLL_MS = 15000                // 15s Kraken cache-control: 2s, we keep it light

// ---- DOM ----
const el = {
  price: document.getElementById('price'),
  priceNote: document.getElementById('price_note'),
  base: document.getElementById('baseline'),
  deltaVal: document.getElementById('delta_val'),
  deltaNote: document.getElementById('delta_note'),
  status: document.getElementById('status'),
  quiet: document.getElementById('quiet'),
  next: document.getElementById('next'),
  logs: document.getElementById('logs'),
  pair: document.getElementById('pair'),
}

const logs = logBuffer()
logs.on(list => {
  // cheap render
  el.logs.textContent = list.join('\n')
  el.logs.scrollTop = 0
})

function log(s){ logs.push(`[${nowPTDate().iso}] ${s}`) }

// ---- State ----
let pair = (new URLSearchParams(location.search).get('pair') || localStorage.getItem('pair') || DEFAULT_PAIR).toUpperCase()
let timer = null
let nextAt = 0

// initialize select
el.pair.value = ['XBTUSD','ETHUSD','SOLUSD'].includes(pair) ? pair : DEFAULT_PAIR
el.pair.addEventListener('change', () => {
  pair = el.pair.value
  localStorage.setItem('pair', pair)
  start()
})

function fmtUsd(n){
  if(!isFinite(n)) return '—'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}
function pct(a){ return (a*100).toFixed(2) + '%' }

async function fetchPrice(p){
  const url = `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(p)}`
  const res = await fetch(url, { cache: 'no-cache' })
  const data = await res.json()
  if(data.error && data.error.length){
    throw new Error(data.error.join('; '))
  }
  const key = Object.keys(data.result)[0]
  const t = data.result[key]
  const last = parseFloat(t.c[0])
  if(!isFinite(last)) throw new Error('Bad price')
  return last
}

function updateQuiet(){
  const q = inQuietHoursPT()
  el.quiet.textContent = `Quiet hours: ${q ? 'ON (11pm–7am PT)' : 'OFF'}`
  el.status.className = 'badge ' + (q ? 'warn' : 'ok')
  el.status.textContent = q ? 'Quiet' : 'Active'
  return q
}

async function tick(){
  try{
    const q = updateQuiet()
    const price = await fetchPrice(pair)

    el.price.textContent = fmtUsd(price)
    el.priceNote.textContent = `${pair} last from Kraken REST`

    let base = getBaseline(pair)
    if(!base){
      const { iso } = nowPTDate()
      base = setBaseline(pair, price, iso)
      log(`Baseline initialized for ${pair} at ${fmtUsd(price)} (${iso})`)
    }

    el.base.textContent = base ? fmtUsd(base.price) : '—'

    const diff = price - base.price
    const change = diff / base.price
    const direction = diff >= 0 ? 'up' : 'down'

    el.deltaVal.textContent = `${fmtUsd(diff)} (${pct(Math.abs(change))})`
    el.deltaNote.textContent = `Direction: ${direction}`

    if(!q && Math.abs(change) >= THRESHOLD){
      const { iso } = nowPTDate()
      log(`ALERT ${pair} ${direction.toUpperCase()} ≥ ${(THRESHOLD*100).toFixed(0)}% — current ${fmtUsd(price)} vs baseline ${fmtUsd(base.price)} (${pct(Math.abs(change))}) — ${iso}`)
      setBaseline(pair, price, iso) // rolling baseline updates after alert
      el.base.textContent = fmtUsd(price)
      el.deltaVal.textContent = '—'
      el.deltaNote.textContent = 'Baseline updated'
    }
  }catch(err){
    log(`Error: ${err.message}`)
  }finally{
    schedule()
  }
}

function schedule(){
  nextAt = Date.now() + POLL_MS
  el.next.textContent = `Next check in ${(POLL_MS/1000).toFixed(0)}s`
  clearTimeout(timer)
  timer = setTimeout(tick, POLL_MS)
}

export function start(){
  clearTimeout(timer)
  logs.push('Booting…')
  tick()
}

// start immediately
start()
