import React, { useEffect, useRef, useState } from 'react'

// ---- Config ----
const TOKENS = [
  { symbol: 'BTC', pair: 'XBT/USD', subscribePair: 'XBT/USD' },
  { symbol: 'ETH', pair: 'ETH/USD', subscribePair: 'ETH/USD' },
  { symbol: 'SOL', pair: 'SOL/USD', subscribePair: 'SOL/USD' },
]
const DEFAULT_THRESHOLD_PCT = 1 // ±5%
const QUIET_HOURS = { start: 23, end: 7, tz: 'America/Los_Angeles' } // 11pm–7am PT

// ---- Helpers ----
function pctChange(curr, base) {
  if (!base || base === 0) return 0
  return ((curr - base) / base) * 100
}
function inQuietHours(date = new Date()) {
  // Quiet hours local to PT; this is a simple client-side check
  const pt = new Date(date.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }))
  const h = pt.getHours()
  // Quiet interval spans overnight
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
    const ws = new WebSocket('wss://ws.kraken.com')
    wsRef.current = ws

    ws.onopen = () => {
      setWsStatus('Connected');
      setWsStatus('connected')
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

          setLastTick(nowPT())

          setPrices(prev => ({ ...prev, [token.symbol]: last }))
          // Always log the price tick
          setLogs(l => [
            `${token.symbol} tick: ${fmtUSD(last)} (${nowPT()} PT)`,
            ...l
          ])

          // Baseline init
          let base = baselines[token.symbol]
          if (!base) {
            base = last
            localStorage.setItem(storageKey(token.symbol), String(base))
            setBaselines(b => ({ ...b, [token.symbol]: base }))
            setLogs(l => [`${token.symbol} baseline initialized at ${fmtUSD(base)} (${nowPT()})`, ...l])
            return
          }

          const pct = pctChange(last, base)
          const absUsd = last - base
          const crossed = Math.abs(pct) >= DEFAULT_THRESHOLD_PCT

          if (crossed) {
            // Respect quiet hours
            if (!inQuietHours()) {
              const direction = pct > 0 ? 'up' : 'down'
              const msg = `⚡ ${token.symbol} ${direction} ${pct.toFixed(2)}% (Δ ${fmtUSD(absUsd)})
Price: ${fmtUSD(last)}
Prior baseline: ${fmtUSD(base)}
Time: ${nowPT()} PT`
              sendTelegram(msg)
              setLogs(l => [msg, ...l])
            } else {
              setLogs(l => [`(quiet hours) ${token.symbol} move ${pct.toFixed(2)}% (Δ ${fmtUSD(absUsd)})`, ...l])
            }

            // Rolling baseline
            localStorage.setItem(storageKey(token.symbol), String(last))
            setBaselines(b => ({ ...b, [token.symbol]: last }))
          }
        } else if (data?.event === 'heartbeat') {
          // ignore
        } else if (data?.event) {
          setLogs(l => [`${data.event}: ${JSON.stringify(data)}`, ...l])
        }
      } catch (e) {
        console.warn('WS parse error', e)
      }
    }

    ws.onclose = () => { setWsStatus('Closed'); setLogs(l => [`WS closed ${nowPT()}`, ...l]); };
    ws.onerror = (e) => { setWsStatus('Error'); setLogs(l => [`WS error ${nowPT()}`, ...l]); };

    return () => ws.close()
  }, [])

  return (
    <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: '#e5e7eb', background: '#0b0f17', minHeight: '100vh', padding: '16px' }}>
      <h1 style={{ fontSize: '20px', marginBottom: 8 }}>Kraken Real-time Alerts (WS)</h1>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 12 }}>WS Status: {wsStatus} {lastTick && `(last tick: ${lastTick})`}</div>
      <p style={{ opacity: 0.85, marginBottom: 16 }}>Live ticker via <code>wss://ws.kraken.com</code> • Threshold: ±{DEFAULT_THRESHOLD_PCT}% • Quiet hours: 11pm–7am PT • Rolling baseline per token</p>

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
          TOKENS.forEach(t => localStorage.removeItem(storageKey(t.symbol)))
          setBaselines({ BTC: null, ETH: null, SOL: null })
          setLogs(l => [`Manual: baselines cleared at ${nowPT()}`, ...l])
        }}>Clear baselines</button>
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
