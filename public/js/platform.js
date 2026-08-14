// Which connection methods this device can actually offer.
//
// The important nuance: you cannot know the *other* phone's platform before
// you connect to it. So "tap to connect" is presented as the same-platform
// path (Android↔Android over NFC, iPhone↔iPhone over AirDrop/Multipeer), while
// the 4-digit code and QR always work across platforms. The UI says so rather
// than pretending it can detect the peer.

export const isNative = () => Boolean(window.Capacitor?.isNativePlatform?.());

export function platform() {
  const cap = window.Capacitor?.getPlatform?.();
  if (cap && cap !== 'web') return cap; // 'ios' | 'android'
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'web';
}

export function capabilities() {
  const p = platform();
  const nativeNfc = Boolean(window.LinkTalkNative?.nfc);      // Capacitor NFC plugin bridge
  const nativeProximity = Boolean(window.LinkTalkNative?.proximity); // iOS Multipeer bridge

  return {
    platform: p,
    // Android: Web NFC in Chrome, or the native plugin inside the app shell.
    nfc: p === 'android' && (nativeNfc || 'NDEFReader' in window),
    // iPhone-to-iPhone proximity: native shell only (no web equivalent), with
    // the AirDrop share sheet as the fallback everywhere else.
    proximity: p === 'ios' && nativeProximity,
    share: typeof navigator.share === 'function',
    // In-app QR scanning: native plugin, or Chrome's BarcodeDetector.
    scan: Boolean(window.LinkTalkNative?.scan) || 'BarcodeDetector' in window,
  };
}

/** Label for the same-platform tap option, or null if unavailable. */
export function tapLabel() {
  const c = capabilities();
  if (c.nfc) return '碰一碰 · Tap (Android ↔ Android)';
  if (c.proximity) return '碰一碰 · Tap (iPhone ↔ iPhone)';
  return null;
}
