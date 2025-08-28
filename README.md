# Kraken Realtime Alerts (Standalone)

Build-free static app for Netlify. No bundlers, no inline scripts, CSP-friendly.

## Features
- Spot-only (Kraken public) XBTUSD/ETHUSD/SOLUSD
- Rolling baseline + 1% threshold checks (UI only; alerts disabled)
- Quiet hours 11:00pm–7:00am PT
- Telemetry (ticks, avg tick, backoff, reconnects, next allowed)
- Logs with capped length and auto-scroll
- Sparkline (SVG, no external libs)

## Deploy
- Drag/drop folder (or zip) to Netlify
- Ensure Netlify serves from repo root (`publish = "."`)
- CSP already set in `netlify.toml`

## Notes
- Baselines persisted per pair in `localStorage`
- No Service Worker to avoid MIME & caching issues
