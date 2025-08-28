import React, { useEffect, useRef, useState } from 'react'

const KRAKEN_REST = 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD'

function nowISO(){ return new Date().toISOString() }

export default function App(){
  const [price, setPrice] = useState(null)
  const [status, setStatus] = useState('boot')
  const [logs, setLogs] = useState([])

  const log = (s) => setLogs(l => [`[${new Date().toLocaleTimeString()}] ${s}`, ...l].slice(0, 500))

  useEffect(() => {
    setStatus('loading')
    log('Booting…')
    ;(async () => {
      try {
        log('Fetching spot price (XBTUSD)…')
        const res = await fetch(KRAKEN_REST, { cache: 'no-store' })
        const json = await res.json()
        if (!json || json.error?.length) {
          log('Error from Kraken REST: ' + (json?.error?.join(', ') || 'unknown'))
          setStatus('error')
          return
        }
        const result = json.result
        const key = Object.keys(result)[0]
        const last = result[key]?.c?.[0]
        if (last) {
          const p = Number(last)
          setPrice(p)
          log('Spot price loaded: $' + p.toLocaleString())
          setStatus('ok')
        } else {
          log('Could not parse price payload')
          setStatus('error')
        }
      } catch (e) {
        log('Network error: ' + e.message)
        setStatus('error')
      }
    })()
  }, [])

  return (
    <div className="wrap">
      <div className="hero">
        <div>
          <div className="label">Status</div>
          <div className="row">
            <span className={'badge ' + (status === 'ok' ? 'ok' : 'warn')}>{status}</span>
            <span className="small">{nowISO()}</span>
          </div>
        </div>
        <div>
          <div className="label">BTC / USD</div>
          <div className="val">{price ? ('$' + price.toLocaleString()) : '—'}</div>
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <div className="label">Logs</div>
          <div className="logs">
            {logs.map((s, i) => (<div key={i}>{s}</div>))}
          </div>
        </div>
        <div className="card">
          <div className="label">Notes</div>
          <div className="small">This is a minimal scaffold to validate deploy + CSP. No inline styles, no inline scripts.</div>
        </div>
      </div>
    </div>
  )
}
