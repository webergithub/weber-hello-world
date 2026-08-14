// Resolving whatever someone typed or scanned into a room code.
//
// Three things can arrive here:
//   • a 4-digit face-to-face PIN   -> resolved via /api/pair
//   • a 6-character room code      -> used directly
//   • a full invite URL (QR scan)  -> room code pulled out of the query string
// Keeping this in one place means the home screen, the QR scanner and the
// native deep-link handler all behave identically.

/** Pull a room code out of an invite URL, or null if it isn't one. */
export function roomFromUrl(text) {
  try {
    const u = new URL(text);
    const code = u.searchParams.get('room');
    return code ? code.toUpperCase() : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} input  PIN, room code, or invite URL
 * @returns {Promise<{ok: true, room: string} | {ok: false, reason: string}>}
 */
export async function resolveJoinInput(input) {
  const raw = (input || '').trim();
  if (!raw) return { ok: false, reason: 'empty' };

  // A scanned QR usually carries the whole invite URL.
  const fromUrl = roomFromUrl(raw);
  if (fromUrl) return verifyRoom(fromUrl);

  const cleaned = raw.toUpperCase().replace(/\s+/g, '');

  // 4 digits -> face-to-face PIN.
  if (/^\d{4}$/.test(cleaned)) {
    try {
      const r = await fetch(`/api/pair/${cleaned}`);
      if (r.status === 429) return { ok: false, reason: 'rate_limited' };
      if (!r.ok) return { ok: false, reason: 'pin_not_found' };
      const { room } = await r.json();
      return { ok: true, room };
    } catch {
      return { ok: false, reason: 'offline' };
    }
  }

  // 6 characters -> room code.
  if (/^[A-Z0-9]{6}$/.test(cleaned)) return verifyRoom(cleaned);

  return { ok: false, reason: 'unrecognised' };
}

async function verifyRoom(code) {
  try {
    const r = await fetch(`/api/rooms/${code}`);
    if (!r.ok) return { ok: false, reason: 'room_not_found' };
    return { ok: true, room: code };
  } catch {
    return { ok: false, reason: 'offline' };
  }
}

/** Human-readable message for a failure reason. */
export function joinError(reason) {
  switch (reason) {
    case 'pin_not_found': return 'That 4-digit code is wrong or has expired.';
    case 'room_not_found': return 'That room was not found.';
    case 'rate_limited': return 'Too many tries — wait a moment and retry.';
    case 'offline': return 'Could not reach the server.';
    case 'unrecognised': return 'Enter a 4-digit face-to-face code or a 6-character room code.';
    default: return 'Could not join.';
  }
}
