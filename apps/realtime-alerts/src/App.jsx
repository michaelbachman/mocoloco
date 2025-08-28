
import React, { useEffect, useRef, useState } from 'react'

// ---- Config ----
const TOKENS = [
  { symbol: 'BTC', pair: 'XBT/USD', subscribePair: 'XBT/USD' },
]
const DEFAULT_THRESHOLD_PCT = 1 // ±1%
const QUIET_HOURS = { start: 23, end: 7, tz: 'America/Los_Angeles' } // 11pm–7am PT

// Kraken-friendly pacing (doubled, gentle)
const RATE_LIMIT_MS = 2400       // ≥ one action per 2.4s (connect / subscribe)
const MIN_RECONNECT_MS = 10000   // minimum reconnect spacing
const BACKOFF_START_MS = 10000   // start backoff at 10s
const BACKOFF_MAX_MS = 120000    // cap backoff at 120s

// Sliding window limits for burst protection (applies to connect/subscribe actions)
const ACTION_WINDOW_MS = 15000
const ACTION_WINDOW_MAX = 8      // at most 8 actions per 15s window

// Production toggles
const ALERT_DEDUP_MS = 180000 // 3 minutes per direction
const RECONNECT_DAILY_CAP = 500 // max reconnect schedules per day
const BROWNOUT_MODE = false
const BROWNOUT_MULTIPLIER = 2

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
function persistNumber(key, val) { try { localStorage.setItem(key, String(val)) } catch {} }
function loadNumber(key, fallback = 0) { try { const v = localStorage.getItem(key); return v ? Number(v) : fallback } catch { return fallback } }
function parseLastPrice(payload){
  const cand = [payload?.c?.[0], payload?.a?.[0], payload?.p?.[0]].map(x => x!=null ? parseFloat(x) : NaN);
  const val = cand.find(v => Number.isFinite(v));
  return Number.isFinite(val) ? val : null;
}

async function sendTelegram(message) {
  try {
    const res = await fetch('/api/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    })
    if (!res.ok) console.warn('Telegram send failed', await res.text())
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
  const [liveLogs, setLiveLogs] = useState(false)
  const [wsStatus, setWsStatus] = useState('Disconnected')
  const [lastTick, setLastTick] = useState(null) // numeric ms timestamp
  const [runtimeError, setRuntimeError] = useState(null)
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true)
  const [isVisible, setIsVisible] = useState(typeof document !== 'undefined' ? !document.hidden : true)
  const [limitsTick, setLimitsTick] = useState(0) // 1s ticker for panel
  const [renderTick, setRenderTick] = useState(0)

  // Refs
  const wsRef = useRef(null)
  const reconnectRef = useRef(null)
  const backoffRef = useRef(loadNumber('pro_backoff_ms', BACKOFF_START_MS))
  const lastActionAtRef = useRef(loadNumber('pro_last_action_at', 0))
  const actionsWindowRef = useRef([]) // timestamps of recent actions
  const connectingRef = useRef(false)
  const logsBufferRef = useRef([])
  const flushTimerRef = useRef(null)
  const pricesRef = useRef({})
  const priceUpdateTimerRef = useRef(null)
  const failCountRef = useRef(0)
  const lastFailureAtRef = useRef(0)
  const lastReconnectReasonRef = useRef('—')
  const lastAlertRef = useRef(new Map())
  const dailyCapRef = useRef({ day: null, count: 0 })
  const countersRef = useRef({
    connectAttempts: 0, subscribeSends: 0, errors: 0, closes: 0,
    watchdogResets: 0, rateDelayed: 0, queuedActions: 0,
  })
  const avgTickMsRef = useRef(null) // moving avg of tick intervals
  
  // Persist certain refs when they change (via a lightweight 1s ticker)
  useEffect(() => {
    const iv = setInterval(() => {
      setLimitsTick(t => (t + 1) % 1_000_000)
      persistNumber('pro_backoff_ms', backoffRef.current)
      persistNumber('pro_last_action_at', lastActionAtRef.current)
    }, 1000)
    return () => clearInterval(iv)
  }, [])

  // Global error listeners + network/visibility listeners
  useEffect(() => {
    function onError(e) {
      const msg = `Runtime error: ${e.message}`
      setRuntimeError(msg); log(msg)
    }
    function onRejection(e) {
      const detail = (e && e.reason && (e.reason.message || e.reason.toString())) || 'Unknown'
      const msg = `Unhandled promise rejection: ${detail}`
      setRuntimeError(msg); log(msg)
    }
    function onOnline(){ setIsOnline(true); log('Network: online') }
    function onOffline(){ setIsOnline(false); log('Network: offline') }
    function onVis(){ const v = !document.hidden; setIsVisible(v); log(`Visibility: ${v ? 'visible' : 'hidden'}`) }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  // ---- Logging (batched, flush every 10s; Live Logs bypasses batching) ----
  function forceFlush() {
    if (logsBufferRef.current.length) {
      setLogs(l => [...logsBufferRef.current, ...l].slice(0, 1000))
      logsBufferRef.current = []
    }
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
  }
  function log(msg) {
    if (liveLogs) {
      setLogs(l => [msg, ...l].slice(0, 1000))
      return
    }
    logsBufferRef.current.unshift(msg)
    if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(() => {
        setLogs(l => [...logsBufferRef.current, ...l].slice(0, 1000))
        logsBufferRef.current = []
        flushTimerRef.current = null
      }, 10000) // flush ~10s
    }
  }

  // ---- Sliding-window, rate-limited action queue ----
  function withinWindowLimit(now) {
    const arr = actionsWindowRef.current
    while (arr.length && (now - arr[0] > ACTION_WINDOW_MS)) arr.shift() // prune old
    return arr.length < ACTION_WINDOW_MAX
  }
  function noteAction(now) {
    actionsWindowRef.current.push(now)
    lastActionAtRef.current = now
  }
  function delayForLimits(name, now) {
    const since = now - lastActionAtRef.current
    let delay = Math.max(0, RATE_LIMIT_MS - since)
    const arr = actionsWindowRef.current
    if (arr.length >= ACTION_WINDOW_MAX) {
      const head = arr[0]
      const until = head + ACTION_WINDOW_MS - now
      delay = Math.max(delay, until)
    }
    if (delay > 0) {
      countersRef.current.rateDelayed++
      log(`Rate limit: delaying ${name} ${Math.ceil(delay)}ms`)
    }
    return delay
  }
  function queueAction(name, fn) {
    const now = Date.now()
    const delay = delayForLimits(name, now)
    countersRef.current.queuedActions++
    setTimeout(() => {
      const t = Date.now()
      if (!withinWindowLimit(t)) {
        const d2 = delayForLimits(name + ' (retry)', t)
        return setTimeout(() => queueAction(name, fn), d2)
      }
      noteAction(t)
      try { fn() } catch (e) { console.warn('Action error', name, e) }
    }, delay)
  }

  // ---- Decorrelated jitter backoff ----
  function nextBackoff(curr) {
    const min = BACKOFF_START_MS
    const max = Math.min(BACKOFF_MAX_MS, curr * 3)
    const ms = Math.floor(Math.random() * (max - min + 1) + min)
    return Math.min(ms, BACKOFF_MAX_MS)
  }

  // ---- Reconnect scheduler (offline/visibility aware + cooldown + daily cap + brownout) ----
  function scheduleReconnect(reason = 'unknown') {
    if (reconnectRef.current) clearTimeout(reconnectRef.current)
    // daily cap
    const today = new Date().toISOString().slice(0,10)
    if (dailyCapRef.current.day !== today) { dailyCapRef.current.day = today; dailyCapRef.current.count = 0 }
    if (dailyCapRef.current.count >= RECONNECT_DAILY_CAP) { log('Daily reconnect cap reached; pausing reconnects'); return }
    dailyCapRef.current.count++

    if (!isOnline) {
      log('Reconnect deferred: offline')
      reconnectRef.current = setTimeout(() => scheduleReconnect('offline retry'), Math.max(MIN_RECONNECT_MS, 15000))
      return
    }
    lastReconnectReasonRef.current = reason
    let extraCooldown = 0
    if (failCountRef.current >= 5) extraCooldown = 60000 // +60s after 5 consecutive failures
    const base = isVisible ? backoffRef.current : backoffRef.current * 2
    let delay = Math.max(base, MIN_RECONNECT_MS) + extraCooldown + Math.floor(Math.random() * 3000)
    if (BROWNOUT_MODE) delay = Math.floor(delay * BROWNOUT_MULTIPLIER)

    reconnectRef.current = setTimeout(() => {
      backoffRef.current = nextBackoff(backoffRef.current)
      connectWS()
    }, delay)
    log(`Reconnecting in ${(delay/1000).toFixed(1)}s (reason: ${reason})`)
  }

  // ---- Connect WS (guarded) ----
  function connectWS() {
    if (connectingRef.current) { log('Skipped connect: already connecting'); return }
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      log('Reconnect skipped: socket not CLOSED'); return
    }
    if (!isOnline) { log('Skipped connect: offline'); scheduleReconnect('offline'); return }

    const now = Date.now()
    const delay = delayForLimits('connect', now)
    connectingRef.current = true
    setTimeout(() => {
      const t = Date.now()
      if (!withinWindowLimit(t)) {
        const d2 = delayForLimits('connect (retry)', t)
        connectingRef.current = false
        return setTimeout(connectWS, d2)
      }
      noteAction(t)

      const ws = new WebSocket('wss://ws.kraken.com')
      wsRef.current = ws
      setWsStatus('Connecting')
      countersRef.current.connectAttempts++

      ws.onopen = () => {
        setWsStatus('Connected')
        const subscribe = {
          event: 'subscribe',
          pair: TOKENS.map(t => t.subscribePair),
          subscription: { name: 'ticker' },
        }
        queueAction('subscribe', () => {
          try {
            ws.send(JSON.stringify(subscribe))
            countersRef.current.subscribeSends++
            log(`Subscribed: ${TOKENS.map(t=>t.subscribePair).join(', ')}`)
          } catch (e) {
            console.warn('Subscribe send error', e)
          }
        })
      }

      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data)
          if (Array.isArray(data) && data.length >= 2) {
            const payload = data[1]
            const tail = data[data.length - 1]
            const pairStr = (typeof tail === 'string') ? tail : (tail && tail.pair) || ''
            const normMsg = pairStr.replace(/[^A-Za-z]/g, '').toUpperCase()

            const token = TOKENS.find(t => {
              const normCfg = t.pair.replace(/[^A-Za-z]/g, '').toUpperCase()
              const normSym = t.symbol.replace(/[^A-Za-z]/g, '').toUpperCase()
              return normMsg.includes(normCfg) || normMsg.includes(normSym)
            })
            if (!token) { log(`Unmapped pair in message: ${pairStr || '(empty)'} (${nowPT()} PT)`); return }

            const last = parseLastPrice(payload)
            if (last == null) return

            // tick interval tracking (for adaptive watchdog)
            const nowMs = Date.now()
            if (lastTick) {
              const diff = nowMs - lastTick
              const prev = avgTickMsRef.current
              avgTickMsRef.current = prev == null ? diff : Math.round(prev * 0.8 + diff * 0.2)
            }
            setLastTick(nowMs)
            backoffRef.current = BACKOFF_START_MS
            failCountRef.current = 0

            // Throttled price updates
            pricesRef.current = { ...pricesRef.current, [token.symbol]: last }
            if (!priceUpdateTimerRef.current) {
              priceUpdateTimerRef.current = setTimeout(() => {
                setPrices(p => ({ ...p, ...pricesRef.current }))
                priceUpdateTimerRef.current = null
              }, 250)
            }

            // Always log tick (batched)
            log(`${token.symbol} tick: ${fmtUSD(last)} (${nowPT()} PT)`)

            // Baseline init
            let base = baselines[token.symbol]
            if (!base) {
              base = last
              localStorage.setItem(storageKey(token.symbol), String(base))
              setBaselines(b => ({ ...b, [token.symbol]: base }))
              log(`${token.symbol} baseline initialized at ${fmtUSD(base)} (${nowPT()} PT)`)
              return
            }

            const pct = pctChange(last, base)
            const absUsd = last - base
            const crossed = Math.abs(pct) >= DEFAULT_THRESHOLD_PCT

            if (crossed) {
              const key = `${token.symbol}_${pct>0?'up':'down'}`
              const prev = lastAlertRef.current.get(key) || 0
              if (Date.now() - prev < ALERT_DEDUP_MS) {
                log(`(dedup) ${token.symbol} ${pct>0?'up':'down'} within ${Math.round(ALERT_DEDUP_MS/1000)}s window`)
              } else {
                lastAlertRef.current.set(key, Date.now())
                if (!inQuietHours()) {
                  const direction = pct > 0 ? 'up' : 'down'
                  const msg = `⚡ ${token.symbol} ${direction} ${pct.toFixed(2)}% (Δ ${fmtUSD(absUsd)})\nPrice: ${fmtUSD(last)}\nPrior baseline: ${fmtUSD(base)}\nTime: ${nowPT()} PT`
                  sendTelegram(msg)
                  log(msg)
                } else {
                  log(`(quiet hours) ${token.symbol} move ${pct.toFixed(2)}% (Δ ${fmtUSD(absUsd)})`)
                }
                localStorage.setItem(storageKey(token.symbol), String(last))
                setBaselines(b => ({ ...b, [token.symbol]: last }))
              }
            }
          } else if (data && data.event) {
            log(`${data.event}: ${JSON.stringify(data)}`)
          }
        } catch (e) {
          console.warn('WS parse error', e)
        }
      }

      ws.onclose = () => {
        setWsStatus('Closed')
        connectingRef.current = false
        countersRef.current.closes++
        failCountRef.current++
        lastFailureAtRef.current = Date.now()
        scheduleReconnect('close')
      }
      ws.onerror = () => {
        setWsStatus('Error')
        connectingRef.current = false
        countersRef.current.errors++
        failCountRef.current++
        lastFailureAtRef.current = Date.now()
        scheduleReconnect('error')
      }
    }, delay)
  }

  // ---- Watchdog (adaptive) ----
  useEffect(() => {
    const iv = setInterval(() => {
      if (!lastTick) return
      const diff = Date.now() - lastTick
      const avg = avgTickMsRef.current || 60000
      let threshold = 60000 // default 60s
      if (avg <= 4000) threshold = 40000
      else if (avg <= 10000) threshold = 60000
      else threshold = 90000
      if (diff > threshold) {
        countersRef.current.watchdogResets++
        log(`Watchdog: reconnecting after ${(diff/1000).toFixed(0)}s idle (avg tick ${(avg/1000).toFixed(1)}s)`)
        scheduleReconnect('watchdog idle')
      }
    }, 15000)
    return () => clearInterval(iv)
  }, [lastTick])

  // ---- Panel heartbeat (1s, setInterval — resilient) ----
  useEffect(() => {
    const snapshot = () => {
      try {
        const nextAllowed = Math.max(0, (lastActionAtRef.current || 0) + RATE_LIMIT_MS - Date.now())
// panel snapshot removed (render-driven panel)
} catch (e) {
        console.warn('Panel snapshot error', e)
      }
    }
    // Paint immediately then every second
    snapshot()
    const iv = setInterval(snapshot, 1000)
    return () => clearInterval(iv)
  }, [])

  // ---- Render heartbeat (1s) ----
  useEffect(() => {
    const iv = setInterval(() => setRenderTick(t => (t + 1) % 1000000), 1000)
    return () => clearInterval(iv)
  }, [])

  // Initial connect
  useEffect(() => { connectWS() }, [])

  // ---- UI ----
  const panel = {
    backoff: Math.min(backoffRef.current, BACKOFF_MAX_MS),
    lastActionAt: lastActionAtRef.current || 0,
    nextAllowedMs: Math.max(0, (lastActionAtRef.current || 0) + RATE_LIMIT_MS - Date.now()),
    windowCount: actionsWindowRef.current.length,
    counters: { ...countersRef.current },
    failCount: failCountRef.current,
    avgTickMs: avgTickMsRef.current,
    ts: Date.now(),
    rt: renderTick,
  }
  return (
    <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: '#e5e7eb', background: '#0b0f17', minHeight: '100vh', padding: '16px' }}>
      <h1 style={{ fontSize: '20px', marginBottom: 8 }}>Kraken Real-time Alerts (WS, Pro)</h1>

      {runtimeError && (
        <div style={{ background: '#3b0d0d', border: '1px solid #7f1d1d', color: '#fecaca', padding: 10, borderRadius: 8, marginBottom: 10 }}>
          <strong>App Error:</strong> {runtimeError}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', marginBottom: 8 }}>
        <div style={{ fontSize: 12, opacity: 0.85 }}>WS Status: <strong>{wsStatus}</strong> <span style={{ opacity: 0.6 }}>(net: {isOnline ? 'online' : 'offline'}, vis: {isVisible ? 'visible' : 'hidden'})</span></div>
        <div style={{ fontSize: 12, opacity: 0.85 }}>Last tick: <strong>{lastTick ? new Date(lastTick).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false }) + ' PT' : '—'}</strong></div>
        <div style={{ fontSize: 12, opacity: 0.85 }}>Last reconnect reason: <strong>{lastReconnectReasonRef.current}</strong></div>
        <div style={{ fontSize: 11, opacity: 0.6 }}>Panel updated: {new Date(panel.ts).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles' }) + ' PT'} • Render tick: {panel.rt}</div>
      </div>

      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', marginBottom: 12 }}>
        <div style={{ background: '#101623', borderRadius: 10, padding: 10, border: '1px solid #1f2a44' }}>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>Limits</div>
          <div style={{ fontSize: 12, lineHeight: 1.5 }}>
            <div>Rate spacing: <strong>{RATE_LIMIT_MS} ms</strong></div>
            <div>Min reconnect: <strong>{MIN_RECONNECT_MS} ms</strong></div>
            <div>Backoff now: <strong>{panel.backoff} ms</strong></div>
            <div>Next allowed action: <strong>{panel.nextAllowedMs} ms</strong></div>
            <div>Last action at: <strong>{panel.lastActionAt ? new Date(panel.lastActionAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false }) + ' PT' : '—'}</strong></div>
            <div>Action window: <strong>{panel.windowCount}/{ACTION_WINDOW_MAX}</strong> in last {ACTION_WINDOW_MS/1000}s</div>
          </div>
        </div>

        <div style={{ background: '#101623', borderRadius: 10, padding: 10, border: '1px solid #1f2a44' }}>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>Telemetry</div>
          <div style={{ fontSize: 12, lineHeight: 1.5 }}>
            <div>Connect attempts: <strong>{panel.counters.connectAttempts}</strong></div>
            <div>Subscribes sent: <strong>{panel.counters.subscribeSends}</strong></div>
            <div>Closes: <strong>{panel.counters.closes}</strong> • Errors: <strong>{panel.counters.errors}</strong></div>
            <div>Watchdog resets: <strong>{panel.counters.watchdogResets}</strong></div>
            <div>Rate-delayed actions: <strong>{panel.counters.rateDelayed}</strong> • Queued actions: <strong>{panel.counters.queuedActions}</strong></div>
            <div>Consecutive failures: <strong>{panel.failCount}</strong></div>
            <div>Avg tick: <strong>{panel.avgTickMs ? (panel.avgTickMs/1000).toFixed(1) + 's' : '—'}</strong></div>
          </div>
        </div>
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
          log(msgs.join('\\n') || 'No baselines updated (no prices yet)')
        }}>Reset baselines to current</button>

        <button style={{ marginLeft: 8 }} onClick={() => {
          const msgs = [];
          TOKENS.forEach(t => { localStorage.removeItem(storageKey(t.symbol)); msgs.push(`${t.symbol} baseline cleared (${nowPT()} PT)`); })
          setBaselines(() => { const o = {}; TOKENS.forEach(t => o[t.symbol] = null); return o; })
          log(msgs.join('\\n'))
        }}>Clear baselines</button>

        <button
          style={{ marginLeft: 8 }}
          onClick={() => { setLogs(l => ['Manual reconnect requested', ...l]); scheduleReconnect('manual') }}
          disabled={connectingRef.current}
        >
          Reconnect
        </button>

        <label style={{ marginLeft: 12, fontSize: 12 }}>
          <input type="checkbox" checked={liveLogs} onChange={e => setLiveLogs(e.target.checked)} style={{ marginRight: 6 }} />
          Live Logs (show immediately)
        </label>
        <button style={{ marginLeft: 8 }} onClick={() => forceFlush()}>Flush now</button>
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
