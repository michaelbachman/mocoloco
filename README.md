# Kraken Realtime BTC — Logs & Status (No Sparkline)

- BTC/USD (XBT/USD) live price via Kraken Public **WebSocket** ticker.
- Minimal UI: connection status, telemetry counters, and a logs panel.
- No alerts or baselines. No charts/sparkline.
- Conservative reconnect/backoff with jitter and guards to stay within Kraken limits.
- CSP-safe: no inline scripts/styles; styles in `style.css`.

## Develop
```bash
cd apps/realtime-alerts
npm ci
npm run dev
```

## Build
```bash
cd apps/realtime-alerts
npm ci
npm run build
```
