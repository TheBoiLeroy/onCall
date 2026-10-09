// CareCall — a tiny "nurse call button" for in-home care.
// A caregiver creates a care link, the patient scans its QR code, and the
// patient's big button rings the caregiver's dashboard in real time (SSE).
//
// Zero framework: Node's http module + the `qrcode` package. State lives in
// memory and is persisted to data.json so restarts don't break paired phones.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 4321;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_ALERTS_KEPT = 50;
const MAX_MED_LOG_KEPT = 1000; // a few doses a day for most of a year

const ALERT_TYPES = {
  help: { label: 'Needs help', urgent: false },
  emergency: { label: 'EMERGENCY', urgent: true },
  bathroom: { label: 'Bathroom', urgent: false },
  water: { label: 'Water / food', urgent: false },
  pain: { label: 'In pain', urgent: true },
  company: { label: 'Wants company', urgent: false },
};

// ---------- storage ----------

let db = { rooms: {} };
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch { /* first run */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), () => {});
  }, 200);
}

const token = (bytes) => crypto.randomBytes(bytes).toString('base64url');

const newCaregiver = (name) => ({ id: token(6), name, key: token(18), joinedAt: Date.now() });

for (const room of Object.values(db.rooms)) {
  room.meds ||= []; // saved medication list: { id, name, dose }
  room.medLog ||= []; // doses taken, newest first: { id, name, dose, takenAt, note, byId, byName, loggedAt }
  // Care links made before multiple caregivers existed had one caregiverName/caregiverKey.
  if (room.caregivers) continue;
  room.caregivers = [{ ...newCaregiver(room.caregiverName || 'Caregiver'), key: room.caregiverKey }];
  room.inviteToken = token(12);
  delete room.caregiverName;
  delete room.caregiverKey;
}

// Short code shown under the QR so the patient can type it instead of scanning.
// No look-alike characters (0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function pairCode() {
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  } while (Object.values(db.rooms).some((r) => r.pairCode === code));
  return code;
}

function findRoomByPatientToken(t) {
  return Object.values(db.rooms).find((r) => r.patientToken === t);
}

// "Sam", "Sam & Alex", "Sam, Alex & Jo"
function joinNames(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} & ${names.at(-1)}`;
}

function publicRoom(room) {
  return {
    id: room.id,
    patientName: room.patientName,
    caregiverName: joinNames(room.caregivers.map((c) => c.name)),
    caregivers: room.caregivers.map(({ id, name }) => ({ id, name })),
    createdAt: room.createdAt,
  };
}

const caregiverByKey = (room, key) => key && room.caregivers.find((c) => c.key === key);

// A call goes to one caregiver (to/toName) or to everyone (to: null).
function setTarget(alert, caregiver) {
  alert.to = caregiver ? caregiver.id : null;
  alert.toName = caregiver ? caregiver.name : null;
}

const activeAlerts = (room) =>
  room.alerts.filter((a) => a.status !== 'resolved' && a.status !== 'cancelled');

// ---------- realtime (Server-Sent Events) ----------

// roomId -> Set of { res, role, caregiverId }
const listeners = new Map();

function subscribe(roomId, role, req, res, caregiverId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const entry = { res, role, caregiverId };
  if (!listeners.has(roomId)) listeners.set(roomId, new Set());
  listeners.get(roomId).add(entry);
  broadcastPresence(roomId);
  req.on('close', () => {
    listeners.get(roomId)?.delete(entry);
    broadcastPresence(roomId);
  });
}

// `only` is a role ('caregiver' / 'patient') or a caregiver id.
function send(roomId, event, data, only) {
  for (const { res, role, caregiverId } of listeners.get(roomId) || []) {
    if (res.writableEnded || (only && role !== only && caregiverId !== only)) continue;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

function presence(roomId) {
  const online = new Set();
  let patients = 0;
  for (const { role, caregiverId } of listeners.get(roomId) || []) {
    if (role === 'caregiver') online.add(caregiverId); else patients++;
  }
  return { caregivers: online.size, online: [...online], patients };
}

function broadcastPresence(roomId) {
  send(roomId, 'presence', presence(roomId));
}

// Every caregiver sees each call in their list, but only the ones it's for get rung.
function ringCaregivers(room, alert) {
  send(room.id, 'ring', alert, alert.to || 'caregiver');
}

// keep proxies / phones from closing idle streams
setInterval(() => {
  for (const set of listeners.values()) for (const { res } of set) if (!res.writableEnded) res.write(': ping\n\n');
}, 20000).unref();

// ---------- helpers ----------

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 10_000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

const clean = (s, max = 60) => String(s ?? '').trim().slice(0, max);

function lanAddress() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

// The URL the patient's phone should open. Override with PUBLIC_URL when
// deployed or tunnelled (e.g. https://carecall.example.com).
function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const host = req.headers.host || `localhost:${PORT}`;
  if (/^(localhost|127\.0\.0\.1)/.test(host)) return `http://${lanAddress()}:${PORT}`;
  return `http://${host}`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serveFile(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return json(res, 404, { error: 'Not found' });
  fs.readFile(full, (err, buf) => {
    if (err) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------- routes ----------

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  const key = url.searchParams.get('key') || req.headers['x-caregiver-key'];

  // Pages
  if (req.method === 'GET') {
    if (url.pathname === '/') return serveFile(res, 'index.html');
    if (parts[0] === 'caregiver' && parts.length === 2) return serveFile(res, 'caregiver.html');
    if (parts[0] === 'p' && parts.length === 2) return serveFile(res, 'patient.html');
    if (parts[0] === 'invite' && parts.length === 2) return serveFile(res, 'invite.html');
    if (parts[0] !== 'api') return serveFile(res, url.pathname.slice(1));
  }

  if (parts[0] !== 'api') return json(res, 404, { error: 'Not found' });

  // POST /api/rooms  -> create a care link
  if (req.method === 'POST' && parts[1] === 'rooms' && parts.length === 2) {
    const body = await readBody(req);
    const me = newCaregiver(clean(body.caregiverName) || 'Caregiver');
    const room = {
      id: token(6),
      caregivers: [me],
      patientToken: token(12),
      pairCode: pairCode(),
      inviteToken: token(12),
      patientName: clean(body.patientName) || 'Patient',
      createdAt: Date.now(),
      alerts: [],
      meds: [],
      medLog: [],
    };
    db.rooms[room.id] = room;
    save();
    return json(res, 201, { ...publicRoom(room), caregiverId: me.id, caregiverKey: me.key, patientToken: room.patientToken });
  }

  // /api/invite/:token  -> another caregiver joins an existing care link
  if (parts[1] === 'invite' && parts[2]) {
    const room = Object.values(db.rooms).find((r) => r.inviteToken === parts[2]);
    if (!room) return json(res, 404, { error: 'This invite link is no longer valid. Ask for a new one.' });
    if (req.method === 'GET') return json(res, 200, publicRoom(room));
    if (req.method === 'POST') {
      const body = await readBody(req);
      const me = newCaregiver(clean(body.name) || 'Caregiver');
      room.caregivers.push(me);
      save();
      send(room.id, 'caregivers', publicRoom(room));
      return json(res, 201, { ...publicRoom(room), caregiverId: me.id, caregiverKey: me.key });
    }
  }

  // /api/rooms/:id/...  (caregiver side, requires key)
  if (parts[1] === 'rooms' && parts[2]) {
    const room = db.rooms[parts[2]];
    const me = room && caregiverByKey(room, key);
    if (!me) return json(res, 403, { error: 'Unknown room or wrong key' });
    const sub = parts[3];

    if (req.method === 'GET' && !sub) {
      if (!room.pairCode) { room.pairCode = pairCode(); save(); } // rooms made before codes existed
      return json(res, 200, {
        ...publicRoom(room),
        caregiverId: me.id,
        pairCode: room.pairCode,
        patientUrl: `${baseUrl(req)}/p/${room.patientToken}`,
        inviteUrl: `${baseUrl(req)}/invite/${room.inviteToken}`,
        alerts: room.alerts,
        meds: room.meds,
        medLog: room.medLog,
        presence: presence(room.id),
      });
    }
    if (req.method === 'GET' && (sub === 'qr.svg' || sub === 'invite.svg')) {
      const target = sub === 'qr.svg' ? `p/${room.patientToken}` : `invite/${room.inviteToken}`;
      const svg = await QRCode.toString(`${baseUrl(req)}/${target}`, {
        type: 'svg', margin: 1, errorCorrectionLevel: 'M',
      });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end(svg);
    }
    if (req.method === 'GET' && sub === 'events') return subscribe(room.id, 'caregiver', req, res, me.id);

    // POST /api/rooms/:id/alerts/:alertId  {status}
    if (req.method === 'POST' && sub === 'alerts' && parts[4]) {
      const alert = room.alerts.find((a) => a.id === parts[4]);
      if (!alert) return json(res, 404, { error: 'No such alert' });
      const body = await readBody(req);
      if (!['seen', 'coming', 'resolved'].includes(body.status)) {
        return json(res, 400, { error: 'status must be seen, coming or resolved' });
      }
      alert.status = body.status;
      alert.byId = me.id;
      alert.byName = me.name;
      alert.updatedAt = Date.now();
      save();
      send(room.id, 'alert', alert);
      return json(res, 200, alert);
    }

    // POST /api/rooms/:id/rotate  -> new QR (old patient link stops working)
    if (req.method === 'POST' && sub === 'rotate') {
      room.patientToken = token(12);
      room.pairCode = pairCode();
      save();
      send(room.id, 'unpaired', {}, 'patient');
      return json(res, 200, { patientToken: room.patientToken, pairCode: room.pairCode });
    }

    // ---- medications (caregivers only) ----
    const medsChanged = () => {
      save();
      send(room.id, 'meds', { meds: room.meds, medLog: room.medLog }, 'caregiver');
      return json(res, 200, { meds: room.meds, medLog: room.medLog });
    };

    // POST /api/rooms/:id/meds  {name, dose}  -> add to the saved list
    if (req.method === 'POST' && sub === 'meds' && !parts[4]) {
      const body = await readBody(req);
      const name = clean(body.name);
      if (!name) return json(res, 400, { error: 'Medication name is required' });
      room.meds.push({ id: token(6), name, dose: clean(body.dose) });
      return medsChanged();
    }

    // POST /api/rooms/:id/meds/:medId/remove  (past log entries are kept)
    if (req.method === 'POST' && sub === 'meds' && parts[4] && parts[5] === 'remove') {
      room.meds = room.meds.filter((m) => m.id !== parts[4]);
      return medsChanged();
    }

    // POST /api/rooms/:id/medlog  {medId} or {name, dose}, optional {takenAt, note}
    if (req.method === 'POST' && sub === 'medlog' && !parts[4]) {
      const body = await readBody(req);
      const saved = room.meds.find((m) => m.id === body.medId);
      const name = saved ? saved.name : clean(body.name);
      if (!name) return json(res, 400, { error: 'Which medication?' });
      const now = Date.now();
      const takenAt = Number(body.takenAt);
      room.medLog.unshift({
        id: token(6),
        name,
        dose: saved ? saved.dose : clean(body.dose),
        // Allow back-dating ("she took it at 8"), but not into the future.
        takenAt: Number.isFinite(takenAt) && takenAt > 0 ? Math.min(takenAt, now) : now,
        note: clean(body.note, 200),
        byId: me.id,
        byName: me.name,
        loggedAt: now,
      });
      room.medLog.sort((a, b) => b.takenAt - a.takenAt);
      room.medLog.length = Math.min(room.medLog.length, MAX_MED_LOG_KEPT);
      return medsChanged();
    }

    // POST /api/rooms/:id/medlog/:entryId/remove  -> undo a mistaken entry
    if (req.method === 'POST' && sub === 'medlog' && parts[4] && parts[5] === 'remove') {
      room.medLog = room.medLog.filter((e) => e.id !== parts[4]);
      return medsChanged();
    }

    // POST /api/rooms/:id/invite  -> new invite link (old one stops working)
    if (req.method === 'POST' && sub === 'invite') {
      room.inviteToken = token(12);
      save();
      return json(res, 200, { ok: true });
    }

    // POST /api/rooms/:id/caregivers/:caregiverId/remove
    if (req.method === 'POST' && sub === 'caregivers' && parts[4] && parts[5] === 'remove') {
      const gone = room.caregivers.find((c) => c.id === parts[4]);
      if (!gone) return json(res, 404, { error: 'No such caregiver' });
      if (room.caregivers.length === 1) return json(res, 400, { error: 'A care link needs at least one caregiver' });
      room.caregivers = room.caregivers.filter((c) => c !== gone);
      save();
      send(room.id, 'removed', {}, gone.id);
      for (const l of listeners.get(room.id) || []) {
        if (l.caregiverId !== gone.id) continue;
        listeners.get(room.id).delete(l);
        l.res.end();
      }
      send(room.id, 'caregivers', publicRoom(room));
      // Open calls meant only for the removed caregiver now go to everyone.
      for (const alert of activeAlerts(room)) {
        if (alert.to !== gone.id) continue;
        setTarget(alert, null);
        send(room.id, 'alert', alert);
        if (alert.status === 'sent') ringCaregivers(room, alert);
      }
      save();
      return json(res, 200, publicRoom(room));
    }
  }

  // GET /api/pair/:code  -> the patient typed the code instead of scanning the QR
  if (req.method === 'GET' && parts[1] === 'pair' && parts[2]) {
    let code = '';
    try { code = decodeURIComponent(parts[2]).toUpperCase().replace(/[^A-Z0-9]/g, ''); } catch { /* malformed */ }
    const room = code && Object.values(db.rooms).find((r) => r.pairCode === code);
    if (!room) return json(res, 404, { error: "That code didn't work. Check it on your caregiver's screen and try again." });
    return json(res, 200, { patientToken: room.patientToken });
  }

  // /api/patient/:token/...  (patient side, the token is the QR secret)
  if (parts[1] === 'patient' && parts[2]) {
    const room = findRoomByPatientToken(parts[2]);
    if (!room) return json(res, 404, { error: 'This care link is no longer valid. Ask your caregiver for a new QR code.' });
    const sub = parts[3];

    if (req.method === 'GET' && !sub) {
      return json(res, 200, {
        ...publicRoom(room),
        types: ALERT_TYPES,
        active: activeAlerts(room),
        presence: presence(room.id),
      });
    }
    if (req.method === 'GET' && sub === 'events') return subscribe(room.id, 'patient', req, res);

    // POST /api/patient/:token/alerts  {type, note}
    if (req.method === 'POST' && sub === 'alerts' && !parts[4]) {
      const body = await readBody(req);
      const type = ALERT_TYPES[body.type] ? body.type : 'help';
      // `to` picks one caregiver; anything else (or a removed caregiver) calls everyone.
      const target = room.caregivers.find((c) => c.id === body.to);
      // Pressing the same button again re-rings the existing call instead of stacking duplicates.
      let alert = activeAlerts(room).find((a) => a.type === type);
      if (alert) {
        alert.rings = (alert.rings || 1) + 1;
        alert.status = 'sent';
        alert.updatedAt = Date.now();
        setTarget(alert, target);
      } else {
        alert = {
          id: token(6),
          type,
          label: ALERT_TYPES[type].label,
          urgent: ALERT_TYPES[type].urgent,
          note: clean(body.note, 200),
          status: 'sent',
          rings: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        setTarget(alert, target);
        room.alerts.unshift(alert);
        room.alerts.length = Math.min(room.alerts.length, MAX_ALERTS_KEPT);
      }
      save();
      send(room.id, 'alert', alert);
      ringCaregivers(room, alert);
      return json(res, 201, alert);
    }

    // POST /api/patient/:token/alerts/:alertId/cancel
    if (req.method === 'POST' && sub === 'alerts' && parts[4] && parts[5] === 'cancel') {
      const alert = room.alerts.find((a) => a.id === parts[4]);
      if (!alert) return json(res, 404, { error: 'No such alert' });
      alert.status = 'cancelled';
      alert.updatedAt = Date.now();
      save();
      send(room.id, 'alert', alert);
      return json(res, 200, alert);
    }
  }

  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'Server error' });
  });
});

if (require.main === module) {
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(`Port ${PORT} is already in use. Try: PORT=4322 npm start`);
    process.exit(1);
  });
  server.listen(PORT, () => {
    console.log(`CareCall running:`);
    console.log(`  on this computer:   http://localhost:${PORT}`);
    console.log(`  on your Wi-Fi:      http://${lanAddress()}:${PORT}`);
  });
}

module.exports = { server };
