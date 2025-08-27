# Kraken Real-time Alerts (Netlify)
A minimal Netlify + Vite + React setup that listens to Kraken's public WebSocket (spot ticker) and triggers rolling-baseline alerts with quiet hours and Telegram pushes.

## Features
- WebSocket to `wss://ws.kraken.com` (pair: XBT/USD)
- Rolling baseline per token (stored in `localStorage`)
- Threshold: ±5% (edit `DEFAULT_THRESHOLD_PCT` in `App.jsx`)
- Quiet hours: 11pm–7am PT (edit `QUIET_HOURS` in `App.jsx`)
- Telegram push via Netlify Function (`/.netlify/functions/telegram`)

## Deploy (Netlify)
1. Create a new Netlify site from this folder.
2. Set environment variables:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
3. Build settings:
   - Base directory: `apps/realtime-alerts`
   - Build command: `npm install --no-audit --no-fund && npm run build`
   - Publish directory: `apps/realtime-alerts/dist`
   - Functions directory: `netlify/functions`
4. Deploy. Open the site to see live prices. Alerts are sent to Telegram when a ±5% move occurs since the last baseline.
