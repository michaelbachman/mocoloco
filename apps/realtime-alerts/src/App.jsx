import React, { useEffect, useRef, useState } from 'react'

export default function App() {
  const [price, setPrice] = useState(null)
  const [status, setStatus] = useState('disconnected')
  const [logs, setLogs] = useState([])
  const wsRef = useRef(null)
  const backoffRef = useRef(5000)

  const log = (msg) => {
    setLogs(prev => [new Date().toLocaleTimeString() + ' ' + msg, ...prev].slice(0, 50))
  }

  const connect = () => {
    if (wsRef.current) wsRef.current.close()
    log('Connecting WS for XBTUSD…')
    setStatus('connecting')

    const ws = new WebSocket('wss://ws.kraken.com/')
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('connected')
      log('WS connected, subscribing…')
      ws.send(JSON.stringify({
        event: 'subscribe',
        pair: ['XBT/USD'],
        subscription: { name: 'ticker' }
      }))
      backoffRef.current = 5000
    }

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (Array.isArray(msg) && msg[1]?.c) {
          const px = parseFloat(msg[1].c[0])
          setPrice(px)
          log(`Price update: $${px}`)
        } else if (msg.event) {
          log(`WS ← ${msg.event}: ${msg.status || ''}`)
        }
      } catch {}
    }

    ws.onclose = (ev) => {
      setStatus('disconnected')
      log(`WS closed (code=${ev.code})`)
      setTimeout(() => {
        backoffRef.current = Math.min(backoffRef.current * 2, 60000)
        log(`Reconnecting in ${backoffRef.current / 1000}s…`)
        connect()
      }, backoffRef.current + Math.random() * 1000)
    }

    ws.onerror = (err) => {
      log(`WS error: ${err.message}`)
      ws.close()
    }
  }

  useEffect(() => {
    connect()
    return () => wsRef.current?.close()
  }, [])

  return (
    <div style={{ padding: '20px', fontFamily: 'monospace' }}>
      <h2>BTC/USD Realtime</h2>
      <div>Status: {status}</div>
      <div>Price: {price ? `$${price}` : 'loading…'}</div>
      <h3>Logs</h3>
      <div style={{ maxHeight: 200, overflow: 'auto', border: '1px solid #ddd', padding: '6px' }}>
        {logs.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  )
}
