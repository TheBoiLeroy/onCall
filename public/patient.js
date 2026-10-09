const $ = (id) => document.getElementById(id);
const tok = location.pathname.split('/')[2];
let info = null;
let active = []; // open calls for this patient
let es = null;
// Who the next call goes to: a caregiver id, or '' for everyone. Remembered on this device.
let to = localStorage.getItem('carecall.to') || '';

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
  paintNames();
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
  es.addEventListener('presence', (e) => setOnline(JSON.parse(e.data).online));
  es.addEventListener('caregivers', (e) => {
    Object.assign(info, JSON.parse(e.data));
    paintNames();
    paintConn();
    render();
  });
  es.addEventListener('alert', (e) => upsert(JSON.parse(e.data)));
  es.addEventListener('unpaired', () => { es.close(); showError('This button was unpaired. Ask your caregiver for a new QR code.'); });
}

// "Sam" / "Sam & Alex" / "Sam, Alex & Jo"
const joinNames = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} & ${names.at(-1)}`);

const chosen = () => info.caregivers.find((c) => c.id === to);

// The big button: "Call Sam", "Call Sam & Alex", or "Call for help" when the list gets long.
function paintNames() {
  if (!chosen()) to = ''; // that caregiver was removed
  $('cgName').textContent = chosen()?.name || (info.caregivers.length > 2 ? 'everyone' : info.caregiverName);
  paintWho();
}

function paintWho() {
  $('whoWrap').classList.toggle('hidden', info.caregivers.length < 2);
  const options = [['', 'Everyone'], ...info.caregivers.map((c) => [c.id, c.name])];
  $('who').innerHTML = options.map(([id, name]) =>
    `<button role="radio" data-to="${id}" aria-checked="${id === to}">${CareStore.esc(name)}</button>`).join('');
}

$('who').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-to]');
  if (!b) return;
  to = b.dataset.to;
  try { localStorage.setItem('carecall.to', to); } catch {}
  paintNames();
  paintConn();
});

let connected = false;
let onlineIds = [];
function setConn(ok) { connected = ok; paintConn(); }
function setOnline(ids) { onlineIds = ids || []; paintConn(); }
function paintConn() {
  const names = info.caregivers.filter((c) => onlineIds.includes(c.id)).map((c) => c.name);
  $('dot').classList.toggle('on', connected && names.length > 0);
  const pick = chosen();
  if (connected && pick) {
    const on = onlineIds.includes(pick.id);
    $('dot').classList.toggle('on', on);
    $('conn').textContent = on ? `${pick.name} is listening` : `${pick.name}'s app is closed`;
    return;
  }
  $('conn').textContent = !connected ? 'Reconnecting…'
    : names.length ? `${joinNames(names)} ${names.length > 1 ? 'are' : 'is'} listening`
    : info.caregivers.length > 1 ? "Caregivers' apps are closed" : `${info.caregiverName}'s app is closed`;
}

function upsert(alert) {
  active = active.filter((a) => a.id !== alert.id);
  if (alert.status !== 'resolved' && alert.status !== 'cancelled') active.unshift(alert);
  render();
}

function render() {
  const latest = active[0];
  const name = latest?.toName || info.caregiverName;
  $('callBtn').classList.toggle('sent', !!latest);
  $('cancelBtn').classList.toggle('hidden', !latest);
  $('status').className = 'status';
  if (!latest) {
    $('status').textContent = 'Press the button if you need anything.';
  } else if (latest.status === 'coming') {
    $('status').textContent = `✅ ${latest.byName || name} is on the way!`;
    $('status').classList.add('coming');
  } else if (latest.status === 'seen') {
    $('status').textContent = `👀 ${latest.byName || name} saw your call (${latest.label}).`;
  } else {
    $('status').textContent = `🔔 Calling ${name}… (${latest.label})`;
  }
}

async function call(type) {
  navigator.vibrate?.(80);
  const res = await api('/alerts', { method: 'POST', body: JSON.stringify({ type, to }) });
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
