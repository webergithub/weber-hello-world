// QR scanning.
//
// Two backends:
//   • Native shell  — the Capacitor plugin bridge (window.LinkTalkNative.scan),
//     which uses the platform scanner on both iOS and Android.
//   • Browser       — BarcodeDetector over a getUserMedia preview. Available in
//     Chrome/Android; Safari has no BarcodeDetector, which is exactly why the
//     4-digit code exists as the universal cross-platform path.
//
// Resolves with the decoded string, or null if the user cancelled.

export async function scanQr() {
  if (window.LinkTalkNative?.scan) return window.LinkTalkNative.scan();
  if (!('BarcodeDetector' in window)) throw new Error('unsupported');
  return scanWithCamera();
}

function scanWithCamera() {
  return new Promise(async (resolve, reject) => {
    let stream;
    const overlay = document.createElement('div');
    overlay.className = 'scan-overlay';
    overlay.innerHTML = `
      <video playsinline autoplay muted></video>
      <div class="scan-frame"></div>
      <button class="btn secondary scan-cancel">Cancel</button>`;
    document.body.appendChild(overlay);

    const video = overlay.querySelector('video');
    let stopped = false;
    const cleanup = () => {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
      overlay.remove();
    };
    overlay.querySelector('.scan-cancel').addEventListener('click', () => {
      cleanup();
      resolve(null);
    });

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      video.srcObject = stream;
      await video.play();
    } catch (err) {
      cleanup();
      return reject(err);
    }

    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    const tick = async () => {
      if (stopped) return;
      try {
        const codes = await detector.detect(video);
        if (codes.length) {
          const value = codes[0].rawValue;
          cleanup();
          return resolve(value);
        }
      } catch { /* frame not ready — try again */ }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
