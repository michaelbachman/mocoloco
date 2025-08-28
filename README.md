# Kraken Realtime — BTC Ticker, Status & Logs (Lite)

- **No inline scripts/styles** (CSP-friendly)
- **Buffered logs** (<=30 lines per flush, every 800ms) + **hard cap** 150 lines
- **Single WS connection** to `wss://ws.kraken.com` subscribing `ticker` for `XBT/USD`
- **Stale detector**: if no ticks in 30s, close & reconnect with backoff (up to ~60s)
- **Initial REST price** fetch for quick UI fill (does not block LCP)

## Dev
```bash
npm i
npm run dev
```

## Build
```bash
npm run build
```
