const $ = (id) => document.getElementById(id);
const roomId = location.pathname.split('/')[2];
const params = new URLSearchParams(location.search);
let key = params.get('key') || CareStore.get(roomId)?.caregiverKey;
let room = null;
let alerts = [];
let audioCtx = null;
let ringTimer = null;
let ringingAlertId = null;

const api = (path, opts = {}) =>
  fetch(`/api/rooms/${roomId}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Caregiver-Key': key },
  });

function showError(msg) {
  $('error').classList.remove('hidden');
  $('error').innerHTML = `<b>${CareStore.esc(msg)}</b><p><a href="/">Back to start</a></p>`;
}

async function load() {
  if (!key) return showError('This device does not have the key for this care link.');
  const res = await api('');
  if (!res.ok) return showError('Care link not found, or the key is wrong.');
  room = await res.json();
  CareStore.add({ ...room, caregiverKey: key });
  if (params.has('key')) history.replaceState(null, '', location.pathname);

  document.title = `CareCall — ${room.patientName}`;
  $('title').textContent = room.patientName;
  $('subtitle').textContent = `Caregiver: ${room.caregiverName}`;
  $('qr').src = `/api/rooms/${roomId}/qr.svg?key=${encodeURIComponent(key)}&t=${Date.now()}`;
  $('patientUrl').textContent = room.patientUrl;
  $('caregiverUrl').textContent = `${new URL(room.patientUrl).origin}/caregiver/${roomId}?key=${key}`;
  alerts = room.alerts;
  setPresence(room.presence);
  if (!alerts.length) $('pairCard').open = true;
  render();
  connect();
}

let es = null;
function connect() {
  es?.close();
  es = new EventSource(`/api/rooms/${roomId}/events?key=${encodeURIComponent(key)}`);
  es.addEventListener('presence', (e) => setPresence(JSON.parse(e.data)));
  es.addEventListener('alert', (e) => upsert(JSON.parse(e.data)));
  es.addEventListener('ring', (e) => ring(JSON.parse(e.data)));
  // EventSource reconnects by itself; refresh state after a reconnect.
  es.addEventListener('open', async () => {
    const res = await api('');
    if (res.ok) { alerts = (await res.json()).alerts; render(); updateRinging(); }
  });
}

function setPresence({ patients }) {
  $('patientDot').classList.toggle('on', patients > 0);
  $('patientPresence').textContent = patients > 0 ? 'Patient connected' : 'Patient offline';
}

function upsert(alert) {
  const i = alerts.findIndex((a) => a.id === alert.id);
  if (i >= 0) alerts[i] = alert; else alerts.unshift(alert);
  render();
  updateRinging();
}

const STATUS_TEXT = {
  sent: 'Waiting for you',
  seen: 'Seen',
  coming: 'On your way',
  resolved: 'Done',
  cancelled: 'Cancelled by patient',
};

function render() {
  if (!alerts.length) return;
  $('alerts').innerHTML = alerts.slice(0, 20).map((a) => {
    const done = a.status === 'resolved' || a.status === 'cancelled';
    const actions = done ? '' : `
      <div class="actions row">
        ${a.status !== 'coming' ? `<button data-id="${a.id}" data-status="coming">On my way</button>` : ''}
        ${a.status === 'sent' ? `<button class="secondary" data-id="${a.id}" data-status="seen">Seen</button>` : ''}
        <button class="secondary" data-id="${a.id}" data-status="resolved">Done</button>
      </div>`;
    return `<div class="alert ${a.urgent ? 'urgent' : ''} ${done ? 'done' : ''}">
      <div class="title">${CareStore.esc(a.label)}${a.rings > 1 ? ` <span class="muted">(pressed ${a.rings}×)</span>` : ''}</div>
      ${a.note ? `<div>“${CareStore.esc(a.note)}”</div>` : ''}
      <div class="muted">${new Date(a.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${STATUS_TEXT[a.status]}</div>
      ${actions}
    </div>`;
  }).join('');
}

async function setStatus(id, status) {
  const res = await api(`/alerts/${id}`, { method: 'POST', body: JSON.stringify({ status }) });
  if (res.ok) upsert(await res.json());
}

$('alerts').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (b) setStatus(b.dataset.id, b.dataset.status);
});

// ---------- ringing ----------

function ring(alert) {
  upsert(alert);
  const title = `${room.patientName}: ${alert.label}`;
  const body = alert.note || 'Tap to respond';
  if ('Notification' in window && Notification.permission === 'granted') {
    const opts = { body, tag: alert.id, renotify: true, requireInteraction: true, icon: '/icon.svg', data: { url: location.pathname } };
    navigator.serviceWorker?.ready
      .then((reg) => reg.showNotification(title, opts))
      .catch(() => new Notification(title, opts));
  }
  navigator.vibrate?.([400, 200, 400, 200, 400]);
}

function updateRinging() {
  const waiting = alerts.find((a) => a.status === 'sent');
  if (!waiting) {
    ringingAlertId = null;
    $('ringing').classList.add('hidden');
    clearInterval(ringTimer); ringTimer = null;
    return;
  }
  ringingAlertId = waiting.id;
  $('ringing').classList.remove('hidden');
  $('ringing').classList.toggle('urgent', !!waiting.urgent);
  $('ringWho').textContent = `${room.patientName} is calling`;
  $('ringWhat').textContent = waiting.label;
  $('ringNote').textContent = waiting.note || '';
  if (!ringTimer) { beep(waiting.urgent); ringTimer = setInterval(() => beep(waiting.urgent), 1600); }
}

$('ringComing').onclick = () => ringingAlertId && setStatus(ringingAlertId, 'coming');
$('ringSeen').onclick = () => ringingAlertId && setStatus(ringingAlertId, 'seen');

function beep(urgent) {
  if (!audioCtx) return;
  const notes = urgent ? [988, 740, 988, 740] : [880, 660];
  notes.forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const t = audioCtx.currentTime + i * 0.25;
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.24);
  });
}

// Browsers only allow sound / notifications after the user taps something.
$('enableBtn').onclick = async () => {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume();
  beep(false);
  if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  try { await navigator.wakeLock?.request('screen'); } catch {}
  $('enable').classList.add('hidden');
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && audioCtx) navigator.wakeLock?.request('screen').catch(() => {});
});

// ---------- pairing ----------

$('printBtn').onclick = () => {
  const w = window.open('', '_blank');
  w.document.write(`<title>CareCall QR</title><body style="font-family:sans-serif;text-align:center;padding:40px">
    <h1>Need ${CareStore.esc(room.caregiverName)}?</h1><p style="font-size:1.3rem">Scan with your phone camera to open your call button.</p>
    <img src="${$('qr').src}" style="width:70%;max-width:420px"><p>${CareStore.esc(room.patientName)}'s CareCall</p>
    <script>document.images[0].onload = () => print()<\/script>`);
  w.document.close();
};

$('rotateBtn').onclick = async () => {
  if (!confirm('The old QR code / patient link will stop working. Continue?')) return;
  const res = await api('/rotate', { method: 'POST' });
  if (res.ok) load();
};

load();
