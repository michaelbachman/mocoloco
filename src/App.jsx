import React, { useEffect, useMemo, useRef, useState } from 'react'

// ---- Config ----
const PAIR = 'XBTUSD' // Kraken BTC/USD pair name
const API = 'https://api.kraken.com/0/public/Ticker?pair=' + PAIR
const KEY_BASELINE = 'baseline.' + PAIR
const KEY_LAST_ALERT_AT = 'lastAlertAt.' + PAIR
const CHANGE_THRESHOLD = 0.01 // 1%
const POLL_MS = 5000 // lightweight polling interval
const SPARK_MAX = 120 // keep last N prices for sparkline
const QUIET_START = 23 // 11pm
const QUIET_END = 7   // 7am
const PT = 'America/Los_Angeles'

function inQuietHours(now = new Date()){
  const pt = new Date(now.toLocaleString('en-US', { timeZone: PT }))
  const h = pt.getHours()
  return (QUIET_START > QUIET_END)
    ? (h >= QUIET_START || h < QUIET_END)
    : (h >= QUIET_START && h < QUIET_END)
}

function nowPT(){
  return new Date().toLocaleString('en-US', { timeZone: PT, hour12: false })
}

function fmtUSD(n){
  if (n == null || Number.isNaN(n)) return '—'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

function parsePriceFromKraken(json){
  // Kraken returns result like: { result: { XBTUSD: { c: ["113000.10000", "0.10000000"], ... } } }
  const key = Object.keys(json?.result || {})[0]
  const c = json?.result?.[key]?.c
  const last = c && c[0]
  const price = last ? Number(last) : NaN
  return Number.isFinite(price) ? price : NaN
}

function Spark({ data, width=220, height=44 }){
  const w = 200, h = 44
  const n = data.length
  if (!n) return <svg width={width} height={height} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none"></svg>
  const min = Math.min(...data), max = Math.max(...data)
  const span = Math.max(1e-9, max - min)
  let pts = ''
  for (let i=0;i<n;i++){
    const x = (i/(n-1))*w
    const y = h - 2 - ((data[i]-min)/span)*(h-4)
    pts += (i? ' ' : '') + x.toFixed(1) + ',' + Math.min(h-1, Math.max(1, y)).toFixed(1)
  }
  return (
    <svg width={width} height={height} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

export default function App(){
  const [price, setPrice] = useState(null)
  const [baseline, setBaseline] = useState(() => {
    const s = localStorage.getItem(KEY_BASELINE)
    return s ? Number(s) : null
  })
  const [direction, setDirection] = useState('—')
  const [pct, setPct] = useState('—')
  const [diffUSD, setDiffUSD] = useState('—')
  const [logs, setLogs] = useState([])
  const pricesRef = useRef([])
  const pollingRef = useRef(null)

  function log(s){
    setLogs(l => [ `[${nowPT()} PT] ${s}`, ...l ].slice(0, 400))
  }

  async function fetchPrice(){
    try {
      const res = await fetch(API, { cache: 'no-store' })
      if (!res.ok){
        log(`HTTP ${res.status} from Kraken`)
        return
      }
      const data = await res.json()
      const p = parsePriceFromKraken(data)
      if (!Number.isFinite(p)){
        log('Parse error: no numeric price in payload')
        return
      }
      setPrice(p)
      pricesRef.current.push(p)
      if (pricesRef.current.length > SPARK_MAX) pricesRef.current.shift()

      // Initialize baseline if needed
      let base = baseline
      if (base == null){
        base = p
        setBaseline(base)
        localStorage.setItem(KEY_BASELINE, String(base))
        log(`Baseline initialized @ ${fmtUSD(base)}`)
      }

      // Compute change
      if (base != null){
        const diff = p - base
        const absPct = Math.abs(diff) / base
        setPct((absPct*100).toFixed(2) + '%')
        setDiffUSD(fmtUSD(Math.abs(diff)))
        setDirection(diff > 0 ? 'up' : diff < 0 ? 'down' : '—')

        const quiet = inQuietHours()
        if (absPct >= CHANGE_THRESHOLD){
          if (!quiet){
            // notify (UI log) and roll the baseline
            log(`ALERT: ${fmtUSD(p)} (${(absPct*100).toFixed(2)}%, ${fmtUSD(Math.abs(diff))}, ${diff>0?'up':'down'}) vs baseline ${fmtUSD(base)} — rolling baseline`)
            setBaseline(p)
            localStorage.setItem(KEY_BASELINE, String(p))
            localStorage.setItem(KEY_LAST_ALERT_AT, String(Date.now()))
          } else {
            log(`Quiet hours — threshold met but suppressed: ${fmtUSD(p)} vs ${fmtUSD(base)} (${(absPct*100).toFixed(2)}%)`)
          }
        }
      }
    } catch (err){
      log('Fetch error: ' + (err?.message || String(err)))
    }
  }

  // Start polling
  useEffect(() => {
    log('Starting Kraken REST poll (spot XBTUSD, every ' + (POLL_MS/1000) + 's)')
    fetchPrice()
    pollingRef.current = setInterval(fetchPrice, POLL_MS)
    return () => clearInterval(pollingRef.current)
  }, [])

  const sparkData = pricesRef.current.slice()

  return (
    <div className="wrap">
      <div className="hero">
        <div>
          <div className="label">BTC / USD (Kraken Spot — {PAIR})</div>
          <div className="val">{fmtUSD(price)}</div>
          <div className="small">Baseline: {fmtUSD(baseline)} • Dir: {direction} • Δ: {pct} • |Δ| USD: {diffUSD}</div>
          <div className="small">Quiet hours: 11:00pm–7:00am PT</div>
        </div>
        <div className="card">
          <Spark data={sparkData} />
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <div className="row" style={{justifyContent:'space-between', alignItems:'center'}}>
            <div className="label">Controls</div>
            <button className="badge warn" onClick={()=>{
              localStorage.removeItem(KEY_BASELINE)
              setBaseline(null)
              log('Baseline cleared — will re-initialize on next price')
            }}>Clear baseline</button>
          </div>
          <div className="small" style={{marginTop:8}}>Polling interval: {(POLL_MS/1000).toFixed(0)}s • Threshold: {(CHANGE_THRESHOLD*100).toFixed(0)}%</div>
        </div>

        <div className="card">
          <div className="label" style={{marginBottom:6}}>Logs</div>
          <div className="logs">
            {logs.map((s,i)=><div key={i}>{s}</div>)}
          </div>
        </div>
      </div>
    </div>
  )
}