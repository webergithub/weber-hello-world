// In-process counters for /api/metrics and the admin console.
//
// Deliberately dependency-free and non-persistent: these reset on restart and
// are meant for "is the service healthy / what is it costing me" answers, not
// for long-term analytics. Scrape them into Prometheus/Datadog if you need
// history.

export const metrics = {
  startedAt: Date.now(),

  rooms: { created: 0, pruned: 0, closedByAdmin: 0 },
  ws: { opened: 0, closed: 0, joins: 0 },
  messages: { relayed: 0, chars: 0 },

  // Translation is the main cost/reliability surface, so break it down by how
  // each request was actually satisfied.
  translate: {
    requests: 0,
    sameLanguage: 0, // short-circuited, no work done
    cacheHits: 0,
    provider: 0, // served by the live provider
    offline: 0, // served by the built-in phrasebook
    untranslated: 0, // fell through, original text returned
    failures: 0, // provider threw / timed out
  },

  transcribe: { requests: 0, ok: 0, mock: 0, failures: 0, bytes: 0 },

  // Face-to-face 4-digit pairing. `missed` counts lookups for a PIN that isn't
  // live — a spike there is what a brute-force attempt looks like.
  pins: { minted: 0, resolved: 0, missed: 0 },

  http: { rateLimited: 0 },
};

export function uptimeSec() {
  return Math.round((Date.now() - metrics.startedAt) / 1000);
}

/** Snapshot for JSON responses; adds derived values that are handy at a glance. */
export function snapshotMetrics(extra = {}) {
  const t = metrics.translate;
  const served = t.cacheHits + t.provider + t.offline;
  return {
    uptimeSec: uptimeSec(),
    ...extra,
    rooms: { ...metrics.rooms },
    ws: { ...metrics.ws, current: Math.max(0, metrics.ws.opened - metrics.ws.closed) },
    messages: { ...metrics.messages },
    translate: {
      ...t,
      cacheHitRate: served ? Number((t.cacheHits / served).toFixed(3)) : null,
    },
    transcribe: { ...metrics.transcribe },
    pins: { ...metrics.pins },
    http: { ...metrics.http },
  };
}
