# Kraken BTC Realtime (Logs & Status)

Lightweight React + Vite app that connects to Kraken public WebSocket (spot, ticker) for **BTC/USD**,
displays **status + logs**, and implements **robust reconnect** with exponential backoff and stale-tick
watchdog — CSP-safe (no inline JS/CSS).

## Dev
```bash
npm i
npm run dev
```

## Build
```bash
npm run build
```

Deploy the `dist/` directory.

## Notes
- Single subscribe per connection (no double-subscribe).
- Reconnects handled on `onclose` only, with capped exponential backoff.
- Stale watchdog closes connection after 30s without ticks to recover.
- No alerts / baselines. BTC only. Logs & status preserved.
