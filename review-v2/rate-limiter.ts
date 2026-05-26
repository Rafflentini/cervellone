/**
 * lib/rate-limiter.ts — SEC-003 fix
 * Sliding window rate limiter. In-memory, no external deps.
 */

const buckets = new Map<string, number[]>()

export function rateLimit(key: string, windowMs = 60_000, max = 5): boolean {
  const now = Date.now()
  const timestamps = buckets.get(key)?.filter(t => now - t < windowMs) || []
  if (timestamps.length >= max) return false
  timestamps.push(now)
  buckets.set(key, timestamps)
  return true
}

// Cleanup ogni 5 minuti per evitare memory leak
setInterval(() => {
  const now = Date.now()
  for (const [key, ts] of buckets) {
    const valid = ts.filter(t => now - t < 120_000)
    if (valid.length === 0) buckets.delete(key)
    else buckets.set(key, valid)
  }
}, 300_000)
