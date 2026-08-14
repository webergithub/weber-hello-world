// Point the native shells at your deployed LinkTalk server, then hand off to
// the Capacitor CLI.
//
//   LINKTALK_SERVER_URL=https://talk.example.com npm run mobile:prepare
//
// The apps load the app UI from that server (so a server deploy updates both
// stores' apps instantly, and the relative /api + /ws paths keep working),
// while native NFC / camera / share still come from the Capacitor bridge. The
// service worker keeps the shell cached, so launches survive a flaky network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(__dirname, '..', 'capacitor.config.json');

const url = process.env.LINKTALK_SERVER_URL;
const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

if (url) {
  if (!/^https:\/\//.test(url) && !/^http:\/\/localhost/.test(url)) {
    console.error(
      `Refusing to use ${url}: the app needs HTTPS (microphone, share and NFC ` +
      `require a secure context). http://localhost is allowed for simulators.`
    );
    process.exit(1);
  }
  config.server = { ...config.server, url };
  if (url.startsWith('http://localhost')) config.server.cleartext = true;
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n');
  console.log(`capacitor.config.json -> server.url = ${url}`);
} else if (config.server?.url) {
  console.log(`Using existing server.url = ${config.server.url}`);
} else {
  console.error(
    'No server URL configured.\n' +
    'Set one:  LINKTALK_SERVER_URL=https://talk.example.com npm run mobile:prepare\n' +
    'The native apps need a reachable LinkTalk server — see MOBILE.md.'
  );
  process.exit(1);
}
