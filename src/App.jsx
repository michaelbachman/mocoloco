import React, { useEffect, useRef, useState } from 'react'
import Sparkline from './components/Sparkline.jsx'

export default function App() {
  const [price, setPrice] = useState(null)
  const [status, setStatus] = useState('disconnected')
  const [logs, setLogs] = useState([])
  const seriesRef = useRef([])

  const log = (s) => setLogs(prev => [s, ...prev].slice(0, 200))

  useEffect(() => {
    async function fetchPrice() {
      try {
        const r = await fetch('https://api.kraken.com/0/public/Ticker?pair=XBTUSD')
        const j = await r.json()
        const p = parseFloat(j?.result?.XBTUSD?.c?.[0])
        if (Number.isFinite(p)) {
          setPrice(p)
          seriesRef.current.push(p)
          if (seriesRef.current.length > 200) seriesRef.current.shift()
          log('Initial price ' + p)
        }
      } catch(e) {
        log('REST error ' + e.message)
      }
    }
    fetchPrice()
  }, [])

  return (
    <div className="wrap">
      <div className="hero">
        <div className="card">
          <div className="label">Status</div>
          <div className="val">{status}</div>
        </div>
        <div className="card">
          <div className="label">Price</div>
          <div className="val">{price ?? '—'}</div>
        </div>
      </div>
      <div className="grid">
        <div className="card">
          <div className="label">Sparkline</div>
          <Sparkline data={seriesRef.current} />
        </div>
        <div className="card logs">
          {logs.map((l,i)=><div key={i}>{l}</div>)}
        </div>
      </div>
    </div>
  )
}
