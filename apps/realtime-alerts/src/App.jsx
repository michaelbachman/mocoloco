import React, { useEffect, useRef, useState } from 'react'

// ---- Config ----
const TOKENS = [
  { symbol: 'BTC', pair: 'XBT/USD', subscribePair: 'XBT/USD' },
]
const DEFAULT_THRESHOLD_PCT = 1 // ±5%
const QUIET_HOURS = { start: 23, end: 7, tz: 'America/Los_Angeles' } // 11pm–7am PT

// ---- Helpers ----
function pctChange(curr, base) {
  if (!base || base === 0) return 0
  return (
    <ErrorBoundary onError={(err) => setLogs(l => [`Runtime error: ${err.message}`, ...l])}>(curr - base) / base) * 100
}
function inQuietHours(date = new Date()) {
  // Quiet hours local to PT; this is a simple client-side check
  const pt = new Date(date.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }))
  const h = pt.getHours()
  // Quiet interval spans overnight
  if (QUIET_HOURS.start > QUIET_HOURS.end) {
    return (
    <ErrorBoundary onError={(err) => setLogs(l => [`Runtime error: ${err.message}`, ...l])}>h >= QUIET_HOURS.start) || (h < QUIET_HOURS.end)
  } else {
    return (
    <ErrorBoundary onError={(err) => setLogs(l => [`Runtime error: ${err.message}`, ...l])}>h >= QUIET_HOURS.start && h < QUIET_HOURS.end)
  }
}
function fmtUSD(n) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}
function nowPT() {
  return new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false })
}
function storageKey(sym) { return `baseline_${sym}` }

async function sendTelegram(message) {
  try {
    const res = await fetch('/.netlify/functions/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    })
    if (!res.ok) {
      console.warn('Telegram send failed', await res.text())
    }
  } catch (e) {
    console.warn('Telegram send error', e)
  }
}


function ErrorBoundary({ children, onError }) {
  return (
    <ErrorBoundary onError={(err) => setLogs(l => [`Runtime error: ${err.message}`, ...l])}>
    <React.ErrorBoundary
      fallbackRender={({ error }) => {
        if (onError) onError(error)
        return <div style={{ background: '#441515', color: '#fca5a5', padding: '8px', borderRadius: '6px' }}>⚠️ Runtime Error: {error.message}</div>
      }}
    >
      {children}
    </React.ErrorBoundary>
  )
}


export default function App() {
  const [prices, setPrices] = useState({})
  const [baselines, setBaselines] = useState(() => {
    const obj = {}
    TOKENS.forEach(t => {
      const v = localStorage.getItem(storageKey(t.symbol))
      obj[t.symbol] = v ? parseFloat(v) : null
    })
    return obj
  })
  const [logs, setLogs] = useState([])
  const [wsStatus, setWsStatus] = useState('disconnected')
  const [lastTick, setLastTick] = useState(null)
  const wsRef = useRef(null)

  useEffect(() => {
    // Global error listeners
    function onError(e) {
      const msg = `Runtime error: ${e.message}`
      setRuntimeError(msg)
      setLogs(l => [msg, ...l])
    }
    function onRejection(e) {
      const detail = (e && e.reason && (e.reason.message || e.reason.toString())) || 'Unknown'
      const msg = `Unhandled promise rejection: ${detail}`
      setRuntimeError(msg)
      setLogs(l => [msg, ...l])
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)


    connectWS()
    // Stale connection watchdog: if no tick for 45s, reconnect
    if (staleCheckRef.current) clearInterval(staleCheckRef.current)
    staleCheckRef.current = setInterval(() => {
      if (!lastTick) return
      const last = new Date(lastTick.replace(' PT',''))
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }))
      const diff = now - last
      if (diff > 45000) {
        setLogs(l => [`Watchdog: reconnecting after ${(diff/1000).toFixed(0)}s idle`, ...l])
        connectWS()
      }
    }, 15000)
    return (
    <ErrorBoundary onError={(err) => setLogs(l => [`Runtime error: ${err.message}`, ...l])}>) => {
      if (staleCheckRef.current) clearInterval(staleCheckRef.current)
      if (wsRef.current) try { wsRef.current.close() } catch {}
    }
  }, [])

  return (
    <ErrorBoundary onError={(err) => setLogs(l => [`Runtime error: ${err.message}`, ...l])}>
    <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: '#e5e7eb', background: '#0b0f17', minHeight: '100vh', padding: '16px' }}>
      <h1 style={{ fontSize: '20px', marginBottom: 8 }}>Kraken Real-time Alerts (WS)</h1>

      {runtimeError && (
        <div style={{ background: '#3b0d0d', border: '1px solid #7f1d1d', color: '#fecaca', padding: 10, borderRadius: 8, marginBottom: 10 }}>
          <strong>App Error:</strong> {runtimeError}
        </div>
      )}

      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 12 }}>WS Status: {wsStatus} {lastTick && `(last tick: ${lastTick})`}</div>
      <p style={{ opacity: 0.85, marginBottom: 16 }}>Live ticker via <code>wss://ws.kraken.com</code> • Threshold: ±{DEFAULT_THRESHOLD_PCT}% • Quiet hours: 11pm–7am PT • Rolling baseline per token</p>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        {TOKENS.map(t => {
          const price = prices[t.symbol]
          const base = baselines[t.symbol]
          const pct = price && base ? pctChange(price, base) : 0
          const absUsd = price && base ? (price - base) : 0
          return (
    <ErrorBoundary onError={(err) => setLogs(l => [`Runtime error: ${err.message}`, ...l])}>
            <div key={t.symbol} style={{ background: '#141a24', borderRadius: 12, padding: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.35)' }}>
              <div style={{ fontSize: 14, opacity: 0.8 }}>{t.symbol} <span style={{ opacity: 0.6 }}>({t.pair})</span></div>
              <div style={{ fontSize: 24, marginTop: 4 }}>{price ? fmtUSD(price) : '—'}</div>
              <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>Baseline: {base ? fmtUSD(base) : '—'}</div>
              <div style={{ fontSize: 12, marginTop: 6 }}>
                Change: <strong>{price && base ? pct.toFixed(2) + '%' : '—'}</strong> ({price && base ? fmtUSD(absUsd) : '—'})
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ marginTop: 16 }}>
        <button onClick={() => {
          TOKENS.forEach(t => {
            if (prices[t.symbol]) {
              localStorage.setItem(storageKey(t.symbol), String(prices[t.symbol]))
            }
          })
          setBaselines(b => {
            const copy = { ...b }
            TOKENS.forEach(t => { if (prices[t.symbol]) copy[t.symbol] = prices[t.symbol] })
            return copy
          })
          setLogs(l => [`Manual: baselines reset to current prices at ${nowPT()}`, ...l])
        }}>Reset baselines to current</button>
        <button style={{ marginLeft: 8 }} onClick={() => {
          const msgs = [];
          TOKENS.forEach(t => { localStorage.removeItem(storageKey(t.symbol)); msgs.push(`${t.symbol} baseline cleared (${nowPT()} PT)`); })
          setBaselines(() => {
            const obj = {};
            TOKENS.forEach(t => obj[t.symbol] = null);
            return obj;
          })
          setLogs(l => [...msgs, ...l])
        }}>Clear baselines</button>
        <button style={{ marginLeft: 8 }} onClick={() => { setLogs(l => [`Manual reconnect requested (${nowPT()} PT)`, ...l]); connectWS() }}>Reconnect</button>
      </div>

      <div style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 14, opacity: 0.85, marginBottom: 6 }}>Logs</h2>
        <div style={{ background: '#0f1420', borderRadius: 8, padding: 12, maxHeight: 260, overflow: 'auto', fontSize: 12, lineHeight: 1.4 }}>
          {logs.map((ln, i) => <div key={i} style={{ opacity: 0.9, whiteSpace: 'pre-wrap' }}>{ln}</div>)}
        </div>
      </div>
    </div>
    </ErrorBoundary>
  )
}
