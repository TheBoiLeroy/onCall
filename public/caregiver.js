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
  if (!res.ok) {
    if (res.status === 403) CareStore.remove(roomId);
    return showError('Care link not found, or this device is no longer one of its caregivers.');
  }
  room = await res.json();
  CareStore.add({ ...room, caregiverKey: key });
  if (params.has('key')) history.replaceState(null, '', location.pathname);

  document.title = `CareCall — ${room.patientName}`;
  $('title').textContent = room.patientName;
  $('subtitle').textContent = `Caregivers: ${room.caregiverName}`;
  $('qr').src = `/api/rooms/${roomId}/qr.svg?key=${encodeURIComponent(key)}&t=${Date.now()}`;
  $('inviteQr').src = `/api/rooms/${roomId}/invite.svg?key=${encodeURIComponent(key)}&t=${Date.now()}`;
  $('inviteUrl').textContent = room.inviteUrl;
  $('patientUrl').textContent = room.patientUrl;
  $('pairCode').textContent = room.pairCode;
  $('caregiverUrl').textContent = `${new URL(room.patientUrl).origin}/caregiver/${roomId}?key=${key}`;
  alerts = room.alerts;
  renderMeds();
  setPresence(room.presence);
  renderTeam();
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
  es.addEventListener('meds', (e) => { Object.assign(room, JSON.parse(e.data)); renderMeds(); });
  es.addEventListener('caregivers', (e) => {
    const r = JSON.parse(e.data);
    room.caregivers = r.caregivers;
    room.caregiverName = r.caregiverName;
    $('subtitle').textContent = `Caregivers: ${room.caregiverName}`;
    renderTeam();
  });
  es.addEventListener('removed', () => {
    es.close();
    stopRinging();
    CareStore.remove(roomId);
    showError('You were removed from this care link.');
  });
  // EventSource reconnects by itself; refresh state after a reconnect.
  es.addEventListener('open', async () => {
    const res = await api('');
    if (!res.ok) return;
    const fresh = await res.json();
    alerts = fresh.alerts;
    Object.assign(room, { caregivers: fresh.caregivers, meds: fresh.meds, medLog: fresh.medLog });
    render(); renderTeam(); renderMeds(); updateRinging();
  });
}

let onlineCaregivers = [];
function setPresence({ patients, online = [] }) {
  onlineCaregivers = online;
  if (room) renderTeam();
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
  sent: 'Waiting for someone',
  seen: 'Seen',
  coming: 'On the way',
  resolved: 'Done',
  cancelled: 'Cancelled by patient',
};

// "On the way — Alex", or "On the way — you"
function statusText(a) {
  if (!a.byName || a.status === 'sent' || a.status === 'cancelled') return STATUS_TEXT[a.status];
  const mine = a.byId === room.caregiverId;
  return `${STATUS_TEXT[a.status]} — ${mine ? 'you' : CareStore.esc(a.byName)}`;
}

function renderTeam() {
  $('teamCount').textContent = `(${room.caregivers.length})`;
  $('team').innerHTML = room.caregivers.map((c) => {
    const me = c.id === room.caregiverId;
    const on = onlineCaregivers.includes(c.id);
    return `<div class="row" style="justify-content:space-between;margin:8px 0">
      <span class="pill"><span class="dot ${on ? 'on' : ''}"></span>${CareStore.esc(c.name)}${me ? ' (you)' : ''} · ${on ? 'listening' : 'app closed'}</span>
      ${me || room.caregivers.length < 2 ? '' : `<button class="secondary" data-remove="${c.id}" style="padding:6px 12px;font-size:.85rem">Remove</button>`}
    </div>`;
  }).join('');
}

$('team').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-remove]');
  if (!b) return;
  const who = room.caregivers.find((c) => c.id === b.dataset.remove);
  if (!confirm(`Remove ${who.name}? Their phone will stop ringing for ${room.patientName}.`)) return;
  const res = await api(`/caregivers/${who.id}/remove`, { method: 'POST' });
  if (res.ok) { Object.assign(room, await res.json()); renderTeam(); }
});

$('shareInvite').onclick = async () => {
  const text = `Join me as a caregiver for ${room.patientName} on CareCall:`;
  if (navigator.share) {
    try { await navigator.share({ title: 'CareCall', text, url: room.inviteUrl }); } catch {}
  } else {
    await navigator.clipboard?.writeText(room.inviteUrl);
    $('shareInvite').textContent = 'Link copied ✓';
  }
};

$('newInvite').onclick = async () => {
  if (!confirm('The current invite link will stop working. People who already joined stay. Continue?')) return;
  const res = await api('/invite', { method: 'POST' });
  if (res.ok) load();
};

const SHOWN_CALLS = 3;
const isDone = (a) => a.status === 'resolved' || a.status === 'cancelled';
const forMe = (a) => !a.to || a.to === room.caregiverId;
const forWhom = (a) => (!a.to ? '' : forMe(a) ? ' · for you' : ` · for ${CareStore.esc(a.toName)}`);

function render() {
  if (!alerts.length) return;
  // Latest 3 calls, but an unanswered call is never hidden behind newer ones.
  let finishedRoom = SHOWN_CALLS - alerts.filter((a) => !isDone(a)).length;
  const shown = alerts.filter((a) => !isDone(a) || finishedRoom-- > 0);
  $('alerts').innerHTML = shown.map((a) => {
    const done = isDone(a);
    const actions = done ? '' : `
      <div class="actions row">
        ${a.status !== 'coming' ? `<button data-id="${a.id}" data-status="coming">On my way</button>` : ''}
        ${a.status === 'sent' ? `<button class="secondary" data-id="${a.id}" data-status="seen">Seen</button>` : ''}
        <button class="secondary" data-id="${a.id}" data-status="resolved">Done</button>
      </div>`;
    return `<div class="alert ${a.urgent ? 'urgent' : ''} ${done ? 'done' : ''}">
      <div class="title">${CareStore.esc(a.label)}${a.rings > 1 ? ` <span class="muted">(pressed ${a.rings}×)</span>` : ''}</div>
      ${a.note ? `<div>“${CareStore.esc(a.note)}”</div>` : ''}
      <div class="muted">${new Date(a.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${forWhom(a)} · ${statusText(a)}</div>
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

// ---------- medications ----------

const esc = (s) => CareStore.esc(s);
const timeOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function ago(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60 ? `${min % 60}m ` : ''}ago`;
  return new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function dayLabel(ms) {
  const d = new Date(ms).toDateString();
  if (d === new Date().toDateString()) return 'Today';
  if (d === new Date(Date.now() - 864e5).toDateString()) return 'Yesterday';
  return new Date(ms).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

// Current local time in the format <input type="datetime-local"> wants.
function nowLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function lastTaken(name) {
  return room.medLog.find((e) => e.name.toLowerCase() === name.toLowerCase());
}

let medLogShown = 30;
function renderMeds() {
  const { meds, medLog } = room;
  $('medsEmpty').classList.toggle('hidden', meds.length > 0);
  $('medButtons').innerHTML = meds.map((m) => {
    const last = lastTaken(m.name);
    return `<button class="secondary" data-log="${m.id}">
      <b>💊 ${esc(m.name)}</b>${m.dose ? ` <span>${esc(m.dose)}</span>` : ''}
      <small>${last ? `Last: ${ago(last.takenAt)}` : 'Not logged yet'}</small>
    </button>`;
  }).join('');
  $('medNames').innerHTML = meds.map((m) => `<option value="${esc(m.name)}">`).join('');
  $('medList').innerHTML = meds.length
    ? meds.map((m) => `<div class="row" style="justify-content:space-between;margin:6px 0">
        <span>${esc(m.name)}${m.dose ? ` <span class="muted">${esc(m.dose)}</span>` : ''}</span>
        <button class="secondary small" data-remove-med="${m.id}">Remove</button></div>`).join('')
    : '<p class="muted">No medications saved yet.</p>';

  if (!medLog.length) { $('medLog').innerHTML = '<p class="muted">Nothing logged yet.</p>'; return; }
  let day = '';
  let html = '';
  for (const e of medLog.slice(0, medLogShown)) {
    const d = dayLabel(e.takenAt);
    if (d !== day) { html += `<h3 class="day">${d}</h3>`; day = d; }
    html += `<div class="med-entry">
      <span class="when">${timeOf(e.takenAt)}</span>
      <span class="what"><b>${esc(e.name)}</b>${e.dose ? ` · ${esc(e.dose)}` : ''}
        ${e.note ? `<br><span class="muted">“${esc(e.note)}”</span>` : ''}
        <br><span class="muted">logged by ${e.byId === room.caregiverId ? 'you' : esc(e.byName)}</span></span>
      <button class="secondary small" data-undo="${e.id}" title="Delete this entry">✕</button>
    </div>`;
  }
  if (medLog.length > medLogShown) html += '<p><button class="secondary" id="moreLog">Show more</button></p>';
  $('medLog').innerHTML = html;
}

async function medApi(path, body) {
  const res = await api(path, { method: 'POST', body: JSON.stringify(body || {}) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Something went wrong.'); return false; }
  Object.assign(room, data);
  renderMeds();
  return true;
}

$('medButtons').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-log]');
  if (!b) return;
  const med = room.meds.find((m) => m.id === b.dataset.log);
  const last = lastTaken(med.name);
  // Guard against two caregivers (or a double tap) giving the same dose twice.
  if (last && Date.now() - last.takenAt < 3 * 3600e3 &&
      !confirm(`${med.name} was already logged ${ago(last.takenAt)} by ${last.byName}. Log another dose?`)) return;
  b.disabled = true;
  await medApi('/medlog', { medId: med.id });
  b.disabled = false;
});

$('logOther').addEventListener('toggle', () => { if ($('logOther').open) $('medTime').value = nowLocal(); });
$('medName').addEventListener('change', () => {
  const saved = room.meds.find((m) => m.name.toLowerCase() === $('medName').value.trim().toLowerCase());
  if (saved && !$('medDose').value) $('medDose').value = saved.dose;
});

$('medForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('medName').value.trim();
  const dose = $('medDose').value.trim();
  const takenAt = $('medTime').value ? new Date($('medTime').value).getTime() : Date.now();
  if ($('medSave').checked && !room.meds.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
    if (!(await medApi('/meds', { name, dose }))) return;
  }
  if (await medApi('/medlog', { name, dose, takenAt, note: $('medNote').value })) {
    $('medForm').reset();
    $('logOther').open = false;
  }
});

$('addMedForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await medApi('/meds', { name: $('newMedName').value, dose: $('newMedDose').value })) $('addMedForm').reset();
});

$('medList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-remove-med]');
  if (!b) return;
  const med = room.meds.find((m) => m.id === b.dataset.removeMed);
  if (confirm(`Remove ${med.name} from the list? Past doses stay in the log.`)) medApi(`/meds/${med.id}/remove`);
});

$('medLog').addEventListener('click', (e) => {
  if (e.target.id === 'moreLog') { medLogShown += 30; renderMeds(); return; }
  const b = e.target.closest('button[data-undo]');
  if (!b) return;
  const entry = room.medLog.find((x) => x.id === b.dataset.undo);
  if (confirm(`Delete "${entry.name}" at ${timeOf(entry.takenAt)} from the log?`)) medApi(`/medlog/${entry.id}/remove`);
});

// Keep "Last: 20 min ago" fresh.
setInterval(() => room && renderMeds(), 60000);

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

function stopRinging() {
  ringingAlertId = null;
  $('ringing').classList.add('hidden');
  clearInterval(ringTimer); ringTimer = null;
}

function updateRinging() {
  const waiting = alerts.find((a) => a.status === 'sent' && forMe(a));
  if (!waiting) return stopRinging();
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
