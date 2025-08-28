// app.js — drop-in WS subscription fix for Kraken XBT/USD ticker
// No UI changes. Provides a single init function:
//    initApp({ elementIds: { price, status, logs } })
// If element IDs aren't provided, it tries defaults: 'price', 'status', 'logs'.
// Everything else (telemetry, panels) can keep using your existing wiring.

(function(){
  const WS_URL = 'wss://ws.kraken.com';
  const PAIR = 'XBT/USD'; // IMPORTANT: Kraken expects the slash here for WS
  const SUBSCRIPTION = { name: 'ticker' };

  // Backoff & health
  const INITIAL_BACKOFF_MS = 1500;
  const BACKOFF_MAX_MS = 30000;
  let backoff = INITIAL_BACKOFF_MS;

  // State
  let ws = null;
  let closedByUs = false;
  let lastTickAt = 0;
  let heartbeatAt = 0;
  let connectTimer = null;
  let watchdogTimer = null;

  // Logs (capped to keep LCP healthy)
  const LOG_CAP = 150;
  const logs = [];
  function log(s){
    const ts = new Date();
    const line = `[${ts.toLocaleTimeString()}] ${s}`;
    logs.unshift(line);
    if (logs.length > LOG_CAP) logs.length = LOG_CAP;
    // Expose to UI, if a sink was configured
    sinks.logs && sinks.logs(line, logs.slice(0));
    // Also console for debugging
    console.log(line);
  }

  // Simple UI sink registry (to avoid changing UI code)
  const sinks = {
    status: null, // (text) => void
    price:  null, // (priceNumber) => void
    logs:   null  // (newLine, allLines[]) => void
  };

  // Util
  const now = () => Date.now();
  const jitter = (ms) => {
    const span = Math.min(500, Math.floor(ms * 0.2));
    return ms + Math.floor((Math.random() * 2 - 1) * span);
  };

  function setStatus(text){
    sinks.status && sinks.status(text);
  }

  function scheduleReconnect(tag){
    clearTimeout(connectTimer);
    const delay = Math.min(BACKOFF_MAX_MS, backoff);
    log(`${tag || 'Reconnecting'} in ${(delay/1000).toFixed(1)}s…`);
    connectTimer = setTimeout(connectWS, jitter(delay));
    backoff = Math.min(BACKOFF_MAX_MS, Math.floor(backoff * 1.6));
  }

  function clearWatchdog(){
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function armWatchdog(){
    clearWatchdog();
    // If we see no real ticks for 30s, reconnect
    watchdogTimer = setTimeout(() => {
      log('No ticks in 30s — reconnecting');
      safeClose();
      scheduleReconnect('Auto-reconnect');
    }, 30000);
  }

  function safeClose(){
    try { closedByUs = true; ws && ws.close(); } catch {}
    ws = null;
    clearWatchdog();
  }

  function connectWS(){
    closedByUs = false;
    setStatus('connecting');
    log('Connecting WS for XBTUSD…');
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      log('WS ctor failed: ' + (e?.message || e));
      scheduleReconnect('Retry');
      return;
    }

    ws.onopen = () => {
      setStatus('open');
      backoff = INITIAL_BACKOFF_MS; // reset backoff on success
      log('WS → subscribe XBTUSD');
      const msg = {
        event: 'subscribe',
        pair: [PAIR],
        subscription: SUBSCRIPTION
      };
      ws.send(JSON.stringify(msg));
      armWatchdog();
    };

    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);

        // Event objects
        if (m?.event === 'systemStatus') {
          log(`WS ← systemStatus: ${m.status || 'unknown'}`);
          return;
        }
        if (m?.event === 'subscriptionStatus') {
          if (m.status === 'subscribed') {
            // Confirmed
            log(`WS ← subscriptionStatus: ${m.status} (${m.subscription?.name || 'ticker'} ${m.pair || ''})`);
            setStatus('subscribed');
          } else {
            // Often "error" when pair name is wrong or quota, etc.
            log(`WS ← subscriptionStatus: ${m.status || 'error'}${m.errorMessage ? ' — ' + m.errorMessage : ''}`);
          }
          return;
        }
        if (m?.event === 'heartbeat') {
          heartbeatAt = now();
          // don't count heartbeats as ticks for health
          return;
        }

        // Ticker array frame format: [ channelId, dataObj, "ticker", "XBT/USD" ]
        if (Array.isArray(m) && m.length >= 2 && m[2] === 'ticker') {
          const data = m[1] || {};
          // Prefer last trade price 'c'[0], fallback to ask 'a'[0] or bid 'b'[0]
          const pStr = (data.c && data.c[0]) || (data.a && data.a[0]) || (data.b && data.b[0]);
          const price = pStr ? parseFloat(pStr) : NaN;
          if (!Number.isFinite(price)) return;

          lastTickAt = now();
          armWatchdog(); // we saw a real tick
          sinks.price && sinks.price(price);
          return;
        }

        // Unknown frames are ignored
      } catch (e) {
        log('onmessage error: ' + (e?.message || e));
      }
    };

    ws.onerror = (ev) => {
      log('WS error event');
    };

    ws.onclose = (ev) => {
      const code = ev?.code || 0;
      const reason = ev?.reason || '';
      log(`WS closed (code=${code}${reason ? ', reason="' + reason + '"' : ''})`);
      setStatus('closed');
      clearWatchdog();
      if (!closedByUs) {
        scheduleReconnect('Reconnecting');
      }
    };
  }

  // Expose init with light wiring to your existing DOM
  function initApp(options = {}){
    const ids = (options.elementIds || {});
    const elPrice = document.getElementById(ids.price || 'price');
    const elStatus = document.getElementById(ids.status || 'status');
    const elLogs = document.getElementById(ids.logs || 'logs');

    // Wire sinks without changing your UI structure
    sinks.status = (text) => { if (elStatus) elStatus.textContent = text; };
    sinks.price  = (p)    => { if (elPrice)  elPrice.textContent = p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    sinks.logs   = (_line, all) => {
      if (!elLogs) return;
      // Efficient render: only repaint when the array reference changes (we always clone above)
      elLogs.innerHTML = all.map(s => `<div>${s}</div>`).join('');
    };

    log('Booting…');
    connectWS();
  }

  // UMD-ish export
  if (typeof window !== 'undefined') window.initApp = initApp;
  if (typeof module !== 'undefined') module.exports = { initApp };
})();
