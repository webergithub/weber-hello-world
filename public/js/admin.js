// LinkTalk admin console.
//
// Every call carries the ADMIN_TOKEN as a bearer header. The token lives in
// sessionStorage only, so closing the tab signs you out; the page itself is
// static and holds no secrets.

const $ = (id) => document.getElementById(id);
const toast = (m) => {
  const t = $('toast');
  t.textContent = m;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
};

let token = sessionStorage.getItem('linktalk.admin') || '';
let timer = null;
let openRoom = null;

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (r.status === 401) throw new Error('unauthorized');
  if (r.status === 503) throw new Error('admin_disabled');
  if (!r.ok) throw new Error(`http_${r.status}`);
  return r.json();
}

// ---- Sign in / out --------------------------------------------------------
async function signIn(candidate) {
  token = candidate;
  try {
    await api('/api/admin/overview');
    sessionStorage.setItem('linktalk.admin', token);
    $('gate').classList.add('hidden');
    $('dash').classList.remove('hidden');
    $('signout').classList.remove('hidden');
    start();
  } catch (err) {
    token = '';
    $('gate-err').textContent =
      err.message === 'admin_disabled'
        ? 'Admin is disabled — start the server with ADMIN_TOKEN set.'
        : 'That token was rejected.';
  }
}

$('signin').addEventListener('click', () => signIn($('token').value.trim()));
$('token').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') signIn($('token').value.trim());
});
$('signout').addEventListener('click', () => {
  sessionStorage.removeItem('linktalk.admin');
  location.reload();
});

// ---- Dashboard ------------------------------------------------------------
function stat(label, value, hint = '') {
  return `<div class="stat"><div class="stat-v">${value}</div><div class="stat-l">${label}</div>${
    hint ? `<div class="stat-h">${hint}</div>` : ''
  }</div>`;
}

function fmtAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function fmtDuration(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

async function refresh() {
  try {
    const [ov, list] = await Promise.all([
      api('/api/admin/overview'),
      api('/api/admin/rooms'),
    ]);
    const m = ov.metrics;
    const hitRate = m.translate.cacheHitRate;
    $('stats').innerHTML = [
      stat('Uptime', fmtDuration(m.uptimeSec)),
      stat('Rooms', ov.rooms.current, `${m.rooms.created} created`),
      stat('People online', ov.rooms.members, `${m.ws.current} sockets`),
      stat('Messages', m.messages.relayed, `${m.messages.chars} chars`),
      stat(
        'Translations',
        m.translate.provider + m.translate.offline + m.translate.cacheHits,
        `cache ${hitRate === null ? '—' : Math.round(hitRate * 100) + '%'} · offline ${m.translate.offline} · fail ${m.translate.failures}`
      ),
      stat('Transcriptions', m.transcribe.requests, `${m.transcribe.failures} failed`),
      stat('Rate limited', m.http.rateLimited),
    ].join('');
    $('refreshed').textContent = `Updated ${new Date().toLocaleTimeString()} · auto-refreshes every 5s`;

    renderRooms(list.rooms);
    if (openRoom) loadDetail(openRoom, true);
  } catch (err) {
    if (err.message === 'unauthorized') {
      sessionStorage.removeItem('linktalk.admin');
      location.reload();
    }
  }
}

function renderRooms(list) {
  const body = $('rooms-body');
  $('rooms-empty').classList.toggle('hidden', list.length > 0);
  $('rooms-table').classList.toggle('hidden', list.length === 0);
  body.innerHTML = '';
  for (const r of list) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b class="code">${r.code}</b></td>
      <td>${r.members}</td>
      <td>${r.messages}</td>
      <td class="small">${fmtAgo(r.lastActivity)}</td>`;
    const td = document.createElement('td');
    td.style.whiteSpace = 'nowrap';

    const view = document.createElement('button');
    view.className = 'icon-btn';
    view.textContent = 'View';
    view.addEventListener('click', () => loadDetail(r.code));
    td.appendChild(view);

    const close = document.createElement('button');
    close.className = 'icon-btn danger-btn';
    close.textContent = 'Close';
    close.style.marginLeft = '6px';
    close.addEventListener('click', () => closeRoom(r.code));
    td.appendChild(close);

    tr.appendChild(td);
    body.appendChild(tr);
  }
}

async function loadDetail(code, quiet = false) {
  try {
    const d = await api(`/api/admin/rooms/${code}`);
    openRoom = code;
    $('detail-card').classList.remove('hidden');
    $('detail-title').textContent = `Room ${code}`;
    $('detail-people').innerHTML = d.people.length
      ? d.people
          .map((p) => `<span class="member${p.isHost ? ' host' : ''}">${p.name} · ${p.speakLang}</span>`)
          .join('')
      : '<span class="small">Nobody connected right now.</span>';
    $('detail-feed').innerHTML = d.recent.length
      ? d.recent
          .map(
            (msg) =>
              `<div class="msg"><div class="who">${msg.fromName}<span class="time">${new Date(
                msg.ts
              ).toLocaleTimeString()}</span></div><div class="primary">${escapeHtml(
                msg.text
              )}</div><div class="orig">${msg.srcLang}</div></div>`
          )
          .join('')
      : '<p class="small">No messages yet.</p>';
  } catch {
    if (!quiet) toast('Could not load that room');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

$('detail-close').addEventListener('click', () => {
  openRoom = null;
  $('detail-card').classList.add('hidden');
});

async function closeRoom(code) {
  if (!confirm(`Close room ${code}? Everyone in it will be disconnected.`)) return;
  try {
    const r = await api(`/api/admin/rooms/${code}`, { method: 'DELETE' });
    toast(`Closed ${code} (${r.disconnected} disconnected)`);
    if (openRoom === code) {
      openRoom = null;
      $('detail-card').classList.add('hidden');
    }
    refresh();
  } catch {
    toast('Could not close that room');
  }
}

function start() {
  refresh();
  clearInterval(timer);
  timer = setInterval(refresh, 5000);
}

// Resume an existing session on reload.
if (token) signIn(token);
