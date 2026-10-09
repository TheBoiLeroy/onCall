const $ = (id) => document.getElementById(id);
const tok = location.pathname.split('/')[2];
let info = null;
let active = []; // open calls for this patient
let es = null;

// Remember this link so opening the installed app from the home screen comes straight back here.
localStorage.setItem('carecall.patient', location.pathname);

const QUICK = [
  ['emergency', '🚨 Emergency'],
  ['bathroom', '🚻 Bathroom'],
  ['water', '🥤 Water / food'],
  ['pain', '🤕 I\'m in pain'],
  ['company', '💬 Come see me'],
];

const api = (path, opts = {}) =>
  fetch(`/api/patient/${tok}${path}`, { ...opts, headers: { 'Content-Type': 'application/json' } });

function showError(msg) {
  $('ui').classList.add('hidden');
  $('error').classList.remove('hidden');
  $('error').innerHTML = `<b>${CareStore.esc(msg)}</b>`;
}

async function load() {
  const res = await api('');
  if (!res.ok) {
    localStorage.removeItem('carecall.patient');
    return showError((await res.json()).error);
  }
  info = await res.json();
  active = info.active;
  $('hello').textContent = `Hi ${info.patientName}`;
  $('cgName').textContent = info.caregiverName;
  $('quick').innerHTML = QUICK.map(([type, label]) =>
    `<button data-type="${type}" class="${type === 'emergency' ? 'emergency' : ''}">${label}</button>`).join('');
  $('ui').classList.remove('hidden');
  render();
  connect();
}

function connect() {
  es?.close();
  es = new EventSource(`/api/patient/${tok}/events`);
  es.addEventListener('open', () => setConn(true));
  es.addEventListener('error', () => setConn(false));
  es.addEventListener('presence', (e) => setCaregiverOnline(JSON.parse(e.data).caregivers > 0));
  es.addEventListener('alert', (e) => upsert(JSON.parse(e.data)));
  es.addEventListener('unpaired', () => { es.close(); showError('This button was unpaired. Ask your caregiver for a new QR code.'); });
}

let connected = false;
let caregiverOnline = false;
function setConn(ok) { connected = ok; paintConn(); }
function setCaregiverOnline(ok) { caregiverOnline = ok; paintConn(); }
function paintConn() {
  $('dot').classList.toggle('on', connected && caregiverOnline);
  $('conn').textContent = !connected ? 'Reconnecting…' : caregiverOnline ? `${info.caregiverName} is listening` : `${info.caregiverName}'s app is closed`;
}

function upsert(alert) {
  active = active.filter((a) => a.id !== alert.id);
  if (alert.status !== 'resolved' && alert.status !== 'cancelled') active.unshift(alert);
  render();
}

function render() {
  const latest = active[0];
  const name = info.caregiverName;
  $('callBtn').classList.toggle('sent', !!latest);
  $('cancelBtn').classList.toggle('hidden', !latest);
  $('status').className = 'status';
  if (!latest) {
    $('status').textContent = 'Press the button if you need anything.';
  } else if (latest.status === 'coming') {
    $('status').textContent = `✅ ${name} is on the way!`;
    $('status').classList.add('coming');
  } else if (latest.status === 'seen') {
    $('status').textContent = `👀 ${name} saw your call (${latest.label}).`;
  } else {
    $('status').textContent = `🔔 Calling ${name}… (${latest.label})`;
  }
}

async function call(type) {
  navigator.vibrate?.(80);
  const res = await api('/alerts', { method: 'POST', body: JSON.stringify({ type }) });
  if (res.ok) upsert(await res.json());
  else $('status').textContent = '⚠️ Could not send. Check the internet connection and try again.';
}

$('callBtn').onclick = () => call('help');
$('quick').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-type]');
  if (b) call(b.dataset.type);
});
$('cancelBtn').onclick = async () => {
  for (const a of active) await api(`/alerts/${a.id}/cancel`, { method: 'POST' });
  active = [];
  render();
};

load();
