// End-to-end API test: create a care link, patient presses the button,
// caregiver's live stream rings, caregiver answers, patient sees the reply.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.DATA_FILE = path.join(os.tmpdir(), `carecall-test-${process.pid}.json`);
process.env.PUBLIC_URL = 'http://carecall.test';
const { server } = require('../server');

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
after(() => { server.closeAllConnections(); server.close(); });

const post = (url, body, headers = {}) =>
  fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });

// Collect SSE events from a stream into an array.
function listen(url) {
  const events = [];
  const ctrl = new AbortController();
  const ready = fetch(base + url, { signal: ctrl.signal }).then(async (res) => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value);
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /event: (.*)/.exec(chunk)?.[1];
            const data = /data: (.*)/.exec(chunk)?.[1];
            if (ev) events.push({ ev, data: JSON.parse(data) });
          }
        }
      } catch { /* aborted */ }
    })();
  });
  const waitFor = async (pred, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('timed out waiting for event');
  };
  return { events, ready, waitFor, close: () => ctrl.abort() };
}

test('full call flow', async () => {
  const room = await (await post('/api/rooms', { patientName: 'Rose', caregiverName: 'Sam' })).json();
  assert.ok(room.caregiverKey && room.patientToken);
  const auth = { 'X-Caregiver-Key': room.caregiverKey };

  // Caregiver info + QR
  const info = await (await fetch(`${base}/api/rooms/${room.id}`, { headers: auth })).json();
  assert.strictEqual(info.patientUrl, `http://carecall.test/p/${room.patientToken}`);
  const qr = await fetch(`${base}/api/rooms/${room.id}/qr.svg?key=${room.caregiverKey}`);
  assert.match(await qr.text(), /<svg/);

  // Wrong key is rejected
  assert.strictEqual((await fetch(`${base}/api/rooms/${room.id}?key=nope`)).status, 403);

  // Patient sees names
  const p = await (await fetch(`${base}/api/patient/${room.patientToken}`)).json();
  assert.strictEqual(p.caregiverName, 'Sam');

  const cg = listen(`/api/rooms/${room.id}/events?key=${room.caregiverKey}`);
  const pt = listen(`/api/patient/${room.patientToken}/events`);
  await Promise.all([cg.ready, pt.ready]);
  await pt.waitFor((e) => e.ev === 'presence' && e.data.caregivers === 1);

  // Patient presses the button -> caregiver rings
  const alert = await (await post(`/api/patient/${room.patientToken}/alerts`, { type: 'water' })).json();
  const ring = await cg.waitFor((e) => e.ev === 'ring');
  assert.strictEqual(ring.data.id, alert.id);
  assert.strictEqual(ring.data.label, 'Water / food');

  // Pressing again re-rings the same call instead of duplicating
  const again = await (await post(`/api/patient/${room.patientToken}/alerts`, { type: 'water' })).json();
  assert.strictEqual(again.id, alert.id);
  assert.strictEqual(again.rings, 2);

  // Caregiver answers "on my way" -> patient sees it
  const res = await post(`/api/rooms/${room.id}/alerts/${alert.id}`, { status: 'coming' }, auth);
  assert.strictEqual(res.status, 200);
  await pt.waitFor((e) => e.ev === 'alert' && e.data.status === 'coming');

  // Resolve, then patient has no active calls
  await post(`/api/rooms/${room.id}/alerts/${alert.id}`, { status: 'resolved' }, auth);
  const after = await (await fetch(`${base}/api/patient/${room.patientToken}`)).json();
  assert.strictEqual(after.active.length, 0);

  // Rotating the QR unpairs the old patient link
  await post(`/api/rooms/${room.id}/rotate`, {}, auth);
  await pt.waitFor((e) => e.ev === 'unpaired');
  assert.strictEqual((await fetch(`${base}/api/patient/${room.patientToken}`)).status, 404);

  cg.close(); pt.close();
});

test('patient can pair by typing the code', async () => {
  const room = await (await post('/api/rooms', { patientName: 'A', caregiverName: 'B' })).json();
  const auth = { 'X-Caregiver-Key': room.caregiverKey };
  const { pairCode } = await (await fetch(`${base}/api/rooms/${room.id}`, { headers: auth })).json();
  assert.match(pairCode, /^[A-Z2-9]{6}$/);

  // Lower case and stray spaces still work
  const ok = await (await fetch(`${base}/api/pair/${encodeURIComponent(` ${pairCode.toLowerCase()} `)}`)).json();
  assert.strictEqual(ok.patientToken, room.patientToken);
  assert.strictEqual((await fetch(`${base}/api/pair/NOPE99`)).status, 404);

  // A new QR also replaces the code
  const rotated = await (await post(`/api/rooms/${room.id}/rotate`, {}, auth)).json();
  assert.notStrictEqual(rotated.pairCode, pairCode);
  assert.strictEqual((await fetch(`${base}/api/pair/${pairCode}`)).status, 404);
});

test('several caregivers share one patient', async () => {
  const room = await (await post('/api/rooms', { patientName: 'Rose', caregiverName: 'Sam' })).json();
  const sam = { 'X-Caregiver-Key': room.caregiverKey };
  const { inviteUrl } = await (await fetch(`${base}/api/rooms/${room.id}`, { headers: sam })).json();
  const invite = new URL(inviteUrl).pathname.split('/')[2];

  // Alex joins with the invite link and gets their own key
  assert.strictEqual((await (await fetch(`${base}/api/invite/${invite}`)).json()).patientName, 'Rose');
  const alexRoom = await (await post(`/api/invite/${invite}`, { name: 'Alex' })).json();
  assert.notStrictEqual(alexRoom.caregiverKey, room.caregiverKey);
  const alex = { 'X-Caregiver-Key': alexRoom.caregiverKey };

  // The patient now sees both names
  const p = await (await fetch(`${base}/api/patient/${room.patientToken}`)).json();
  assert.strictEqual(p.caregiverName, 'Sam & Alex');

  // Both caregivers ring; Alex answers and the patient sees Alex's name
  const s = listen(`/api/rooms/${room.id}/events?key=${room.caregiverKey}`);
  const a = listen(`/api/rooms/${room.id}/events?key=${alexRoom.caregiverKey}`);
  const pt = listen(`/api/patient/${room.patientToken}/events`);
  await Promise.all([s.ready, a.ready, pt.ready]);
  await pt.waitFor((e) => e.ev === 'presence' && e.data.caregivers === 2);
  const call = await (await post(`/api/patient/${room.patientToken}/alerts`, { type: 'help' })).json();
  await s.waitFor((e) => e.ev === 'ring');
  await a.waitFor((e) => e.ev === 'ring');
  await post(`/api/rooms/${room.id}/alerts/${call.id}`, { status: 'coming' }, alex);
  const seen = await pt.waitFor((e) => e.ev === 'alert' && e.data.status === 'coming');
  assert.strictEqual(seen.data.byName, 'Alex');
  await s.waitFor((e) => e.ev === 'alert' && e.data.byName === 'Alex');

  // Sam removes Alex: Alex is told, and Alex's key stops working
  await post(`/api/rooms/${room.id}/caregivers/${alexRoom.caregiverId}/remove`, {}, sam);
  await a.waitFor((e) => e.ev === 'removed');
  assert.strictEqual((await fetch(`${base}/api/rooms/${room.id}`, { headers: alex })).status, 403);
  await pt.waitFor((e) => e.ev === 'caregivers' && e.data.caregivers.length === 1);

  // The last caregiver can't be removed; a new invite link retires the old one
  const solo = await post(`/api/rooms/${room.id}/caregivers/${room.caregiverId}/remove`, {}, sam);
  assert.strictEqual(solo.status, 400);
  await post(`/api/rooms/${room.id}/invite`, {}, sam);
  assert.strictEqual((await fetch(`${base}/api/invite/${invite}`)).status, 404);

  s.close(); a.close(); pt.close();
});

test('patient can call one caregiver', async () => {
  const room = await (await post('/api/rooms', { patientName: 'Rose', caregiverName: 'Sam' })).json();
  const sam = { 'X-Caregiver-Key': room.caregiverKey };
  const invite = new URL((await (await fetch(`${base}/api/rooms/${room.id}`, { headers: sam })).json()).inviteUrl).pathname.split('/')[2];
  const alex = await (await post(`/api/invite/${invite}`, { name: 'Alex' })).json();
  const s = listen(`/api/rooms/${room.id}/events?key=${room.caregiverKey}`);
  const a = listen(`/api/rooms/${room.id}/events?key=${alex.caregiverKey}`);
  await Promise.all([s.ready, a.ready]);
  await s.waitFor((e) => e.ev === 'presence' && e.data.caregivers === 2);

  // A call for Alex rings only Alex, but Sam still sees it in the list
  const call = await (await post(`/api/patient/${room.patientToken}/alerts`, { type: 'water', to: alex.caregiverId })).json();
  assert.strictEqual(call.to, alex.caregiverId);
  assert.strictEqual(call.toName, 'Alex');
  await a.waitFor((e) => e.ev === 'ring' && e.data.id === call.id);
  await s.waitFor((e) => e.ev === 'alert' && e.data.id === call.id);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!s.events.some((e) => e.ev === 'ring'));

  // Pressing it again for everyone retargets the same call and rings Sam too
  const again = await (await post(`/api/patient/${room.patientToken}/alerts`, { type: 'water' })).json();
  assert.strictEqual(again.id, call.id);
  assert.strictEqual(again.to, null);
  await s.waitFor((e) => e.ev === 'ring' && e.data.id === call.id);

  // An unknown caregiver id falls back to everyone
  const odd = await (await post(`/api/patient/${room.patientToken}/alerts`, { type: 'pain', to: 'nobody' })).json();
  assert.strictEqual(odd.to, null);

  // If the chosen caregiver is removed, their open call goes to everyone
  const forAlex = await (await post(`/api/patient/${room.patientToken}/alerts`, { type: 'bathroom', to: alex.caregiverId })).json();
  await post(`/api/rooms/${room.id}/caregivers/${alex.caregiverId}/remove`, {}, sam);
  await s.waitFor((e) => e.ev === 'ring' && e.data.id === forAlex.id && e.data.to === null);

  s.close(); a.close();
});

test('medication list and log', async () => {
  const room = await (await post('/api/rooms', { patientName: 'Rose', caregiverName: 'Sam' })).json();
  const sam = { 'X-Caregiver-Key': room.caregiverKey };
  const invite = new URL((await (await fetch(`${base}/api/rooms/${room.id}`, { headers: sam })).json()).inviteUrl).pathname.split('/')[2];
  const alex = await (await post(`/api/invite/${invite}`, { name: 'Alex' })).json();
  const a = listen(`/api/rooms/${room.id}/events?key=${alex.caregiverKey}`);
  const pt = listen(`/api/patient/${room.patientToken}/events`);
  await Promise.all([a.ready, pt.ready]);

  // Save a med, then log it with one tap
  let r = await (await post(`/api/rooms/${room.id}/meds`, { name: 'Tylenol', dose: '500 mg' }, sam)).json();
  const tylenol = r.meds[0];
  assert.strictEqual((await post(`/api/rooms/${room.id}/meds`, { name: ' ' }, sam)).status, 400);
  r = await (await post(`/api/rooms/${room.id}/medlog`, { medId: tylenol.id }, sam)).json();
  assert.strictEqual(r.medLog[0].name, 'Tylenol');
  assert.strictEqual(r.medLog[0].dose, '500 mg');
  assert.strictEqual(r.medLog[0].byName, 'Sam');

  // The other caregiver sees it live
  await a.waitFor((e) => e.ev === 'meds' && e.data.medLog.length === 1);

  // Log an unsaved med earlier in the day; the log stays newest-first and can't be in the future
  const twoHoursAgo = Date.now() - 2 * 3600e3;
  r = await (await post(`/api/rooms/${room.id}/medlog`, { name: 'Metformin', dose: '1 tablet', takenAt: twoHoursAgo, note: 'with breakfast' }, sam)).json();
  assert.deepStrictEqual(r.medLog.map((e) => e.name), ['Tylenol', 'Metformin']);
  assert.strictEqual(r.medLog[1].takenAt, twoHoursAgo);
  r = await (await post(`/api/rooms/${room.id}/medlog`, { name: 'Vitamin D', takenAt: Date.now() + 864e5 }, sam)).json();
  assert.ok(r.medLog[0].takenAt <= Date.now());

  // Undo an entry; removing a saved med keeps its history
  r = await (await post(`/api/rooms/${room.id}/medlog/${r.medLog[0].id}/remove`, {}, sam)).json();
  assert.strictEqual(r.medLog.length, 2);
  r = await (await post(`/api/rooms/${room.id}/meds/${tylenol.id}/remove`, {}, sam)).json();
  assert.strictEqual(r.meds.length, 0);
  assert.strictEqual(r.medLog.length, 2);

  // Meds are caregiver-only: the patient link can't see or write them
  assert.strictEqual((await (await fetch(`${base}/api/patient/${room.patientToken}`)).json()).medLog, undefined);
  assert.strictEqual((await post(`/api/rooms/${room.id}/medlog`, { name: 'X' }, { 'X-Caregiver-Key': 'nope' })).status, 403);
  assert.ok(!pt.events.some((e) => e.ev === 'meds'));

  a.close(); pt.close();
});

test('patient can cancel a call', async () => {
  const room = await (await post('/api/rooms', { patientName: 'A', caregiverName: 'B' })).json();
  const alert = await (await post(`/api/patient/${room.patientToken}/alerts`, { type: 'help' })).json();
  const res = await post(`/api/patient/${room.patientToken}/alerts/${alert.id}/cancel`);
  assert.strictEqual((await res.json()).status, 'cancelled');
});

test('pages are served', async () => {
  for (const url of ['/', '/caregiver/abc', '/p/xyz', '/invite/abc', '/app.css', '/manifest.webmanifest', '/sw.js']) {
    assert.strictEqual((await fetch(base + url)).status, 200, url);
  }
  assert.strictEqual((await fetch(base + '/../server.js')).status, 404);
});
