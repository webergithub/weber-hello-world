// Per-IP token bucket, used to protect the endpoints that cost money
// (translation, Whisper) and the room-creation endpoint from being hammered.
//
// Buckets refill continuously, so a caller that pauses regains capacity without
// waiting for a fixed window boundary. Idle buckets are swept periodically so
// the map can't grow unbounded from one-off visitors.

import { metrics } from './metrics.js';

const ENABLED = process.env.RATE_LIMIT !== '0';

function clientKey(req) {
  // Behind a proxy the real client is in X-Forwarded-For; fall back to the
  // socket address. Only the first hop is trusted for keying.
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Build an Express middleware limiting each client to `perMin` requests/minute.
 * @param {string} name  label used in the 429 body (which endpoint tripped)
 * @param {number} perMin
 */
export function rateLimit(name, perMin) {
  const capacity = Math.max(1, perMin);
  const refillPerMs = capacity / 60000;
  /** @type {Map<string, {tokens: number, last: number}>} */
  const buckets = new Map();

  // Drop buckets untouched for 5 minutes.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [key, b] of buckets) if (b.last < cutoff) buckets.delete(key);
  }, 5 * 60 * 1000);
  sweep.unref?.();

  return function limiter(req, res, next) {
    if (!ENABLED) return next();

    const key = clientKey(req);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, last: now };
      buckets.set(key, b);
    } else {
      b.tokens = Math.min(capacity, b.tokens + (now - b.last) * refillPerMs);
      b.last = now;
    }

    if (b.tokens < 1) {
      metrics.http.rateLimited++;
      const waitSec = Math.max(1, Math.ceil((1 - b.tokens) / (refillPerMs * 1000)));
      res.set('Retry-After', String(waitSec));
      return res.status(429).json({ error: 'rate_limited', limit: name, retryAfterSec: waitSec });
    }

    b.tokens -= 1;
    next();
  };
}

export const LIMITS = {
  translate: Number(process.env.RATE_TRANSLATE_PER_MIN || 240),
  transcribe: Number(process.env.RATE_TRANSCRIBE_PER_MIN || 60),
  rooms: Number(process.env.RATE_ROOMS_PER_MIN || 60),
};
