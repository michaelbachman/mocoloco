import React, { useEffect, useRef, useState } from 'react'

// ---- Config ----
const TOKENS = [
  { symbol: 'BTC', pair: 'XBT/USD', subscribePair: 'XBT/USD' },
]
const DEFAULT_THRESHOLD_PCT = 1 // ±1%
const QUIET_HOURS = { start: 23, end: 7, tz: 'America/Los_Angeles' } // 11pm–7am PT

// ---- Helpers ----
function pctChange(curr, base) {
  if (!base || base === 0) return 0
  return ((curr - base) / base) * 100
}
function inQuietHours(date = new Date()) {
  const pt = new Date(date.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }))
  const h = pt.getHours()
  if (QUIET_HOURS.start > QUIET_HOURS.end) {
    return (h >= QUIET_HOURS.start) || (h < QUIET_HOURS.end)
  } else {
    return (h >= QUIET_HOURS.start && h < QUIET_HOURS.end)
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
    const res = await fetch('/api/telegram', {
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
  const [wsStatus, setWsStatus] = useState('Disconnected')
  const [lastTick, setLastTick] = useState(null)
  const [runtimeError, setRuntimeError] = useState(null)
  const wsRef = useRef(null)
  const reconnectRef = useRef(null)
  const staleCheckRef = useRef(null)
  const backoffRef = useRef(2000)

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
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  function scheduleReconnect() {
    if (reconnectRef.current) clearTimeout(reconnectRef.current)
    const delay = Math.min(backoffRef.current, 60000)
    reconnectRef.current = setTimeout(() => {
      backoffRef.current = Math.min(backoffRef.current * 2, 60000)
      connectWS()
    }, delay)
    setLogs(l => [`Reconnecting in ${(delay/1000).toFixed(0)}s...`, ...l])
  }

  function connectWS() {
    if (wsRef.current) { try { wsRef.current.close() } catch {} }
    const ws = new WebSocket('wss://ws.kraken.com')
    wsRef.current = ws
    setWsStatus('Connecting')

    ws.onopen = () => {
      setWsStatus('Connected')
      backoffRef.current = 2000
      const subscribe = {
        event: 'subscribe',
        pair: TOKENS.map(t => t.subscribePair),
        subscription: { name: 'ticker' },
      }
      ws.send(JSON.stringify(subscribe))
      setLogs(l => [`WS connected ${nowPT()}`, ...l])
    }

    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data)
        if (Array.isArray(data) && data.length >= 2) {
          const payload = data[1]
          const channelInfo = data[data.length - 1]
          const pair = channelInfo?.pair || ''
          const token = TOKENS.find(t => pair.includes(t.pair.replace('/', '')) || pair.includes(t.pair) || pair.includes(t.symbol))
          if (!token) return
          const last = parseFloat(payload?.c?.[0] || payload?.p?.[0])
          if (!isFinite(last)) return

          setPrices(prev => ({ ...prev, [token.symbol]: last }))

          // Always log the price tick
          setLogs(l => [`${token.symbol} tick: ${fmtUSD(last)} (${nowPT()} PT)`, ...l])

          // update last tick timestamp
          setLastTick(nowPT())

          // Baseline init
          let base = baselines[token.symbol]
          if (!base) {
            base = last
            localStorage.setItem(storageKey(token.symbol), String(base))
            setBaselines(b => ({ ...b, [token.symbol]: base }))
            setLogs(l => [`${token.symbol} baseline initialized at ${fmtUSD(base)} (${nowPT()} PT)`, ...l])
            return
          }

          const pct = pctChange(last, base)
          const absUsd = last - base
          const crossed = Math.abs(pct) >= DEFAULT_THRESHOLD_PCT

          if (crossed) {
            if (!inQuietHours()) {
              const direction = pct > 0 ? 'up' : 'down'
              const msg = `⚡ ${token.symbol} ${direction} ${pct.toFixed(2)}% (Δ ${fmtUSD(absUsd)})\nPrice: ${fmtUSD(last)}\nPrior baseline: ${fmtUSD(base)}\nTime: ${nowPT()} PT`
              sendTelegram(msg)
              setLogs(l => [msg, ...l])
            } else {
              setLogs(l => [`(quiet hours) ${token.symbol} move ${pct.toFixed(2)}% (Δ ${fmtUSD(absUsd)})`, ...l])
            }
            localStorage.setItem(storageKey(token.symbol), String(last))
            setBaselines(b => ({ ...b, [token.symbol]: last }))
          }
        } else if (data?.event) {
          setLogs(l => [`${data.event}: ${JSON.stringify(data)}`, ...l])
        }
      } catch (e) {
        console.warn('WS parse error', e)
      }
    }

    ws.onclose = () => {
      setWsStatus('Closed')
      setLogs(l => [`WS closed ${nowPT()}`, ...l])
      scheduleReconnect()
    }
    ws.onerror = () => {
      setWsStatus('Error')
      setLogs(l => [`WS error ${nowPT()}`, ...l])
      scheduleReconnect()
    }
  }

  useEffect(() => {
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
    return () => {
      if (staleCheckRef.current) clearInterval(staleCheckRef.current)
      if (wsRef.current) try { wsRef.current.close() } catch {}
    }
  }, [lastTick])

  return (
    <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: '#e5e7eb', background: '#0b0f17', minHeight: '100vh', padding: '16px' }}>
      <h1 style={{ fontSize: '20px', marginBottom: 8 }}>Kraken Real-time Alerts (WS)</h1>

      {runtimeError && (
        <div style={{ background: '#3b0d0d', border: '1px solid #7f1d1d', color: '#fecaca', padding: 10, borderRadius: 8, marginBottom: 10 }}>
          <strong>App Error:</strong> {runtimeError}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', marginBottom: 8 }}>
        <div style={{ fontSize: 12, opacity: 0.85 }}>WS Status: <strong>{wsStatus}</strong></div>
        <div style={{ fontSize: 12, opacity: 0.85 }}>Last tick: <strong>{lastTick ? lastTick + ' PT' : '—'}</strong></div>
      </div>

      <p style={{ opacity: 0.85, marginBottom: 16 }}>
        Live ticker via <code>wss://ws.kraken.com</code> • Threshold: ±{DEFAULT_THRESHOLD_PCT}% • Quiet hours: 11pm–7am PT • Rolling baseline per token
      </p>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        {TOKENS.map(t => {
          const price = prices[t.symbol]
          const base = baselines[t.symbol]
          const pct = price && base ? pctChange(price, base) : 0
          const absUsd = price && base ? (price - base) : 0
          return (
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
          const msgs = [];
          TOKENS.forEach(t => {
            const p = prices[t.symbol];
            if (p) {
              localStorage.setItem(storageKey(t.symbol), String(p));
              msgs.push(`${t.symbol} baseline reset to ${fmtUSD(p)} (${nowPT()} PT)`);
            }
          });
          setBaselines(b => {
            const copy = { ...b };
            TOKENS.forEach(t => { if (prices[t.symbol]) copy[t.symbol] = prices[t.symbol]; });
            return copy;
          });
          setLogs(l => [...msgs, ...l]);
        }}>Reset baselines to current</button>

        <button style={{ marginLeft: 8 }} onClick={() => {
          const msgs = [];
          TOKENS.forEach(t => { localStorage.removeItem(storageKey(t.symbol)); msgs.push(`${t.symbol} baseline cleared (${nowPT()} PT)`); })
          setBaselines(() => { const o = {}; TOKENS.forEach(t => o[t.symbol] = null); return o; })
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
  )
}
