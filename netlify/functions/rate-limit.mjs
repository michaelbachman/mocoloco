// Token bucket / sliding window rate limiter for Netlify Functions
// Supports Upstash Redis (if UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN are set).
// Fallback: in-memory (ephemeral) store.
//
// Usage: Call this function first in your handlers to decide allow/deny.
// Example policy: allow <= MAX_PER_WINDOW within WINDOW_MS.
//
// NOTE: This is a utility endpoint that returns the limiter status for testing.
// In production, import the limiter logic into your other functions to gate actions.

export async function handler(event, context) {
  const MAX_PER_WINDOW = parseInt(process.env.RL_MAX_PER_WINDOW || "8", 10);
  const WINDOW_MS = parseInt(process.env.RL_WINDOW_MS || "15000", 10);

  const ip = (event.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  const key = `rl:${ip}`;
  const now = Date.now();

  const res = await allow(key, now, MAX_PER_WINDOW, WINDOW_MS);
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": event.headers.origin || event.headers.host || "*", // adjust if you want strict origin
    },
    body: JSON.stringify(res),
  };
}

async function allow(key, now, max, windowMs) {
  // If Upstash is configured, use it
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    try {
      // We'll use a sorted set (timestamps) with a rolling window
      const cutoff = now - windowMs;
      const zkey = key;
      // Remove old entries
      await redisFetch(`${url}/zremrangebyscore/${encodeURIComponent(zkey)}/${-Infinity}/${cutoff}`, token, "POST");
      // Add current timestamp
      await redisFetch(`${url}/zadd/${encodeURIComponent(zkey)}/${now}/${now}`, token, "POST");
      // Count entries in window
      const count = await redisFetch(`${url}/zcount/${encodeURIComponent(zkey)}/${cutoff}/${now}`, token);
      // Set TTL
      await redisFetch(`${url}/expire/${encodeURIComponent(zkey)}/${Math.ceil(windowMs/1000)+1}`, token, "POST");
      const allowed = Number(count.result || count) <= max;
      return { allowed, count: Number(count.result || count), max, windowMs, backend: "upstash" };
    } catch (e) {
      // Fallback to memory on any error
      return memoryAllow(key, now, max, windowMs, true);
    }
  }
  // Memory fallback
  return memoryAllow(key, now, max, windowMs, false);
}

async function redisFetch(endpoint, token, method = "GET") {
  const r = await fetch(endpoint, { method, headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Upstash error: ${r.status}`);
  return await r.json();
}

// In-memory store (ephemeral across cold starts)
const MEM = new Map();
function memoryAllow(key, now, max, windowMs, viaFallback) {
  const arr = MEM.get(key) || [];
  // prune
  const cutoff = now - windowMs;
  const pruned = arr.filter(ts => ts > cutoff);
  pruned.push(now);
  MEM.set(key, pruned);
  const allowed = pruned.length <= max;
  return { allowed, count: pruned.length, max, windowMs, backend: viaFallback ? "fallback-memory" : "memory" };
}
