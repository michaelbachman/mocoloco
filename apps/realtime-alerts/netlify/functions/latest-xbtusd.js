export async function handler(event, context) {
  try {
    const res = await fetch('https://api.kraken.com/0/public/Ticker?pair=XBTUSD', { cache: 'no-store' })
    const data = await res.json()
    const ticker = data?.result && Object.values(data.result)[0]
    const price = ticker?.c?.[0] ? parseFloat(ticker.c[0]) : null
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3, stale-while-revalidate=30'
      },
      body: JSON.stringify({ ok: !!price, price, ts: Date.now() })
    }
  } catch (e) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'upstream_fetch_failed' })
    }
  }
}
