import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createKrakenTicker } from './lib/kraken.js'
import { createLogger } from './lib/logger.js'

// ---- Utilities ----
function fmtUSD(n){
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}
function nowISO(){ return new Date().toLocaleTimeString() }

// tiny sparkline; guards NaN and length < 2
function Spark({ points }){
  const w = 220, h = 46, pad = 4
  const arr = Array.isArray(points) ? points.filter(v => Number.isFinite(v)) : []
  if (arr.length < 2) return <svg className="spark" width={w} height={h} aria-hidden="true" />
  const min = Math.min(...arr), max = Math.max(...arr)
  const span = max - min || 1
  const step = (w - pad*2) / (arr.length - 1)
  let d = ''
  for (let i=0;i<arr.length;i++){
    const x = pad + i*step
    const y = pad + (h - pad*2) * (1 - (arr[i] - min) / span)
    d += (i ? ' ' : '') + x.toFixed(1) + ',' + y.toFixed(1)
  }
  return (
    <svg className="spark" width={w} height={h}>
      <polyline fill="none" stroke="currentColor" strokeWidth="1.5" points={d} />
    </svg>
  )
}

export default function App(){
  const logger = useMemo(() => createLogger(), [])
  const [logs, setLogs] = useState([])
  const [status, setStatus] = useState('idle')
  const [price, setPrice] = useState(null)
  const [ticks, setTicks] = useState(0)
  const [lastTickAt, setLastTickAt] = useState(null)
  const pricesRef = useRef([]) // ring buffer for spark
  const MAX_PTS = 60

  // Batched log subscription (lightweight)
  useEffect(() => {
    const unsub = logger.subscribe(setLogs)
    return () => unsub()
  }, [logger])

  useEffect(() => {
    logger.add('Booting…')
    const kraken = createKrakenTicker({ log: logger.add })
    const offTick = kraken.onTick(({ price }) => {
      setPrice(price)
      setTicks(t => t + 1)
      setLastTickAt(Date.now())
      const arr = pricesRef.current
      arr.push(price)
      if (arr.length > MAX_PTS) arr.shift()
    })
    const offStatus = kraken.onStatus(setStatus)
    kraken.start()
    return () => { offTick(); offStatus(); kraken.stop() }
  }, [logger])

  // Telemetry derived
  const lastTickAgo = useMemo(() => {
    if (!lastTickAt) return '—'
    const sec = Math.floor((Date.now() - lastTickAt) / 1000)
    return `${sec}s ago`
  }, [lastTickAt, ticks]) // ticks ensures refresh

  const statusBadge = useMemo(() => {
    const cls = status === 'open' ? 'ok' : (status === 'reconnecting' || status === 'connecting' ? 'warn' : 'error')
    return <span className={'badge ' + cls}>{status}</span>
  }, [status])

  return (
    <div className="wrap">
      <div className="row" style={{justifyContent: 'space-between', alignItems: 'center'}}>
        <div className="h1">BTC/USD (spot via Kraken WS)</div>
        {statusBadge}
      </div>

      <div className="grid">
        <div className="card">
          <div className="label">Current price</div>
          <div className="row" style={{alignItems:'center', gap: 16}}>
            <div className="val">{fmtUSD(price)}</div>
            <Spark points={pricesRef.current} />
          </div>
          <div className="small">Last tick: {lastTickAgo}</div>
        </div>

        <div className="card">
          <div className="label">Ticker telemetry</div>
          <div className="row"><div>Ticks received:</div><strong>{ticks}</strong></div>
          <div className="row"><div>Last update:</div><span>{lastTickAt ? new Date(lastTickAt).toLocaleTimeString() : '—'}</span></div>
          <div className="row"><div>WS status:</div><span>{status}</span></div>
        </div>
      </div>

      <div className="hr"></div>

      <div className="card">
        <div className="label">Logs</div>
        <div className="logs" role="log" aria-live="polite">
          {logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </div>
    </div>
  )
}
