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

test('patient can cancel a call', async () => {
  const room = await (await post('/api/rooms', { patientName: 'A', caregiverName: 'B' })).json();
  const alert = await (await post(`/api/patient/${room.patientToken}/alerts`, { type: 'help' })).json();
  const res = await post(`/api/patient/${room.patientToken}/alerts/${alert.id}/cancel`);
  assert.strictEqual((await res.json()).status, 'cancelled');
});

test('pages are served', async () => {
  for (const url of ['/', '/caregiver/abc', '/p/xyz', '/app.css', '/manifest.webmanifest', '/sw.js']) {
    assert.strictEqual((await fetch(base + url)).status, 200, url);
  }
  assert.strictEqual((await fetch(base + '/../server.js')).status, 404);
});
