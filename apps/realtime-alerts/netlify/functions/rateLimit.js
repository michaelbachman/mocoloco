export async function handler(event, context) {
  // Simple token bucket per-IP (demo; for production, use Redis or durable KV)
  const ip = event.headers['x-forwarded-for'] || 'unknown'
  const now = Date.now()
  globalThis._buckets = globalThis._buckets || {}
  const bucket = globalThis._buckets[ip] || { tokens: 10, last: now }
  const refill = Math.floor((now - bucket.last) / 1000)
  bucket.tokens = Math.min(10, bucket.tokens + refill)
  bucket.last = now
  if (bucket.tokens <= 0) {
    return { statusCode: 429, body: JSON.stringify({ error: 'Rate limit exceeded' }) }
  }
  bucket.tokens--
  globalThis._buckets[ip] = bucket
  return { statusCode: 200, body: JSON.stringify({ ok: true }) }
}
