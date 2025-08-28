# Kraken Alerts Lite

Lightweight client-only app that polls Kraken public REST Ticker for spot prices (XBTUSD / ETHUSD / SOLUSD), maintains a **rolling baseline**, and emits alerts whenever absolute change vs baseline is **≥ 1%**, outside quiet hours (11pm–7am PT).

- No inline scripts/styles (CSP-friendly)
- No eval / no websockets (REST only)
- Minimal DOM updates to keep LCP & CPU low
- Baseline & selected pair stored in `localStorage`
- Built with Vite, deployable to Netlify

## Run locally
```bash
npm i
npm run dev
```
Visit http://localhost:5173

## Build
```bash
npm run build
```
Outputs to `dist/`

## Configure
- Change default pair in `src/app.js` (`DEFAULT_PAIR`)
- Change threshold (default 1%) via `THRESHOLD`
- Poll interval via `POLL_MS` (default 15s)

## Netlify
This repository includes `netlify.toml` with a strict CSP that allows requests to `https://api.kraken.com` only.
