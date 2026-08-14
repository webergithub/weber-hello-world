// Apply LinkTalk's native requirements to the generated iOS/Android projects.
//
// `npx cap add` produces a stock shell that only asks for INTERNET. LinkTalk
// also needs the microphone (Whisper voice input), the camera (QR scanning),
// NFC (Android 碰一碰) and local networking (iPhone-to-iPhone proximity).
//
// Idempotent: safe to re-run after every `cap sync`. Missing platforms are
// skipped silently, so this works whether you generated one or both.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (m) => console.log(`  ${m}`);

// ---------------------------------------------------------------------------
// Android — permissions in AndroidManifest.xml
// ---------------------------------------------------------------------------
const ANDROID_PERMS = [
  ['android.permission.RECORD_AUDIO', 'Whisper voice input'],
  ['android.permission.CAMERA', 'QR scanning'],
  ['android.permission.NFC', '碰一碰 tap-to-join'],
];

function patchAndroid() {
  const file = path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  if (!fs.existsSync(file)) return false;

  let xml = fs.readFileSync(file, 'utf8');
  const added = [];
  for (const [perm, why] of ANDROID_PERMS) {
    if (xml.includes(perm)) continue;
    xml = xml.replace(
      '</manifest>',
      `    <uses-permission android:name="${perm}" /> <!-- ${why} -->\n</manifest>`
    );
    added.push(perm.split('.').pop());
  }
  // NFC is optional hardware: don't let Play filter out phones without it.
  if (!xml.includes('android.hardware.nfc')) {
    xml = xml.replace(
      '</manifest>',
      '    <uses-feature android:name="android.hardware.nfc" android:required="false" />\n</manifest>'
    );
    added.push('nfc-feature(optional)');
  }
  fs.writeFileSync(file, xml);
  log(added.length ? `android: added ${added.join(', ')}` : 'android: already up to date');
  return true;
}

// ---------------------------------------------------------------------------
// iOS — usage descriptions in Info.plist
// ---------------------------------------------------------------------------
const IOS_KEYS = [
  ['NSMicrophoneUsageDescription',
   'LinkTalk records what you say so it can be transcribed and translated for the room.'],
  ['NSCameraUsageDescription',
   'LinkTalk uses the camera to scan a room’s QR code so you can join it.'],
  ['NSLocalNetworkUsageDescription',
   'LinkTalk uses the local network to connect to a nearby iPhone when you tap to join.'],
];

function patchIos() {
  const file = path.join(root, 'ios', 'App', 'App', 'Info.plist');
  if (!fs.existsSync(file)) return false;

  let plist = fs.readFileSync(file, 'utf8');
  const added = [];
  for (const [key, description] of IOS_KEYS) {
    if (plist.includes(`<key>${key}</key>`)) continue;
    plist = plist.replace(
      /\n<\/dict>\n<\/plist>/,
      `\n\t<key>${key}</key>\n\t<string>${description}</string>\n</dict>\n</plist>`
    );
    added.push(key);
  }
  // Bonjour services for the iPhone-to-iPhone proximity path.
  if (!plist.includes('NSBonjourServices')) {
    plist = plist.replace(
      /\n<\/dict>\n<\/plist>/,
      '\n\t<key>NSBonjourServices</key>\n\t<array>\n\t\t<string>_linktalk._tcp</string>\n' +
      '\t\t<string>_linktalk._udp</string>\n\t</array>\n</dict>\n</plist>'
    );
    added.push('NSBonjourServices');
  }
  fs.writeFileSync(file, plist);
  log(added.length ? `ios: added ${added.join(', ')}` : 'ios: already up to date');
  return true;
}

console.log('Applying LinkTalk native requirements:');
const did = [patchAndroid(), patchIos()];
if (!did.some(Boolean)) {
  log('no native projects yet — run `npm run mobile:add:android` / `:ios` first');
}
