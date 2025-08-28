# Kraken Realtime BTC — Lightweight Viewer (BTC only)

- **No alerts / baselines** — just a robust, lightweight BTC/USD (spot) display.
- Uses **Kraken WebSocket** for live ticker (pair **XBT/USD**).
- Bootstrap current price once via **Kraken REST** (`XBTUSD`) so first load shows data quickly.
- Respects API limits: min 1100ms between client WS frames, exponential backoff, stale detection.

## Run locally

```bash
cd apps/realtime-alerts
npm install
npm run dev
```

## Deploy to Netlify

- Root `netlify.toml` already points to this app:
  - build base: `apps/realtime-alerts`
  - publish dir: `apps/realtime-alerts/dist`
- CSP disallows inline scripts/styles. This app uses **no inline scripts/styles**.
- `connect-src` allows `https://api.kraken.com` and `wss://ws.kraken.com`.

## Notes

- WebSocket pair formatting differs:
  - WS uses **`XBT/USD`**
  - REST uses **`XBTUSD`**
- If no data for 20s, the app reconnects with capped exponential backoff.
- Logs are throttled to reduce re-renders.
