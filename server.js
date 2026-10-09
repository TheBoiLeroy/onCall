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

function findRoomByPatientToken(t) {
  return Object.values(db.rooms).find((r) => r.patientToken === t);
}

function publicRoom(room) {
  return {
    id: room.id,
    patientName: room.patientName,
    caregiverName: room.caregiverName,
    createdAt: room.createdAt,
  };
}

const activeAlerts = (room) =>
  room.alerts.filter((a) => a.status !== 'resolved' && a.status !== 'cancelled');

// ---------- realtime (Server-Sent Events) ----------

// roomId -> Set of { res, role }
const listeners = new Map();

function subscribe(roomId, role, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const entry = { res, role };
  if (!listeners.has(roomId)) listeners.set(roomId, new Set());
  listeners.get(roomId).add(entry);
  broadcastPresence(roomId);
  req.on('close', () => {
    listeners.get(roomId)?.delete(entry);
    broadcastPresence(roomId);
  });
}

function send(roomId, event, data, onlyRole) {
  for (const { res, role } of listeners.get(roomId) || []) {
    if (onlyRole && role !== onlyRole) continue;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

function presence(roomId) {
  const set = listeners.get(roomId) || new Set();
  let caregivers = 0;
  let patients = 0;
  for (const { role } of set) role === 'caregiver' ? caregivers++ : patients++;
  return { caregivers, patients };
}

function broadcastPresence(roomId) {
  send(roomId, 'presence', presence(roomId));
}

// keep proxies / phones from closing idle streams
setInterval(() => {
  for (const set of listeners.values()) for (const { res } of set) res.write(': ping\n\n');
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
    if (parts[0] !== 'api') return serveFile(res, url.pathname.slice(1));
  }

  if (parts[0] !== 'api') return json(res, 404, { error: 'Not found' });

  // POST /api/rooms  -> create a care link
  if (req.method === 'POST' && parts[1] === 'rooms' && parts.length === 2) {
    const body = await readBody(req);
    const room = {
      id: token(6),
      caregiverKey: token(18),
      patientToken: token(12),
      patientName: clean(body.patientName) || 'Patient',
      caregiverName: clean(body.caregiverName) || 'Caregiver',
      createdAt: Date.now(),
      alerts: [],
    };
    db.rooms[room.id] = room;
    save();
    return json(res, 201, { ...publicRoom(room), caregiverKey: room.caregiverKey, patientToken: room.patientToken });
  }

  // /api/rooms/:id/...  (caregiver side, requires key)
  if (parts[1] === 'rooms' && parts[2]) {
    const room = db.rooms[parts[2]];
    if (!room || room.caregiverKey !== key) return json(res, 403, { error: 'Unknown room or wrong key' });
    const sub = parts[3];

    if (req.method === 'GET' && !sub) {
      return json(res, 200, {
        ...publicRoom(room),
        patientUrl: `${baseUrl(req)}/p/${room.patientToken}`,
        alerts: room.alerts,
        presence: presence(room.id),
      });
    }
    if (req.method === 'GET' && sub === 'qr.svg') {
      const svg = await QRCode.toString(`${baseUrl(req)}/p/${room.patientToken}`, {
        type: 'svg', margin: 1, errorCorrectionLevel: 'M',
      });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end(svg);
    }
    if (req.method === 'GET' && sub === 'events') return subscribe(room.id, 'caregiver', req, res);

    // POST /api/rooms/:id/alerts/:alertId  {status}
    if (req.method === 'POST' && sub === 'alerts' && parts[4]) {
      const alert = room.alerts.find((a) => a.id === parts[4]);
      if (!alert) return json(res, 404, { error: 'No such alert' });
      const body = await readBody(req);
      if (!['seen', 'coming', 'resolved'].includes(body.status)) {
        return json(res, 400, { error: 'status must be seen, coming or resolved' });
      }
      alert.status = body.status;
      alert.updatedAt = Date.now();
      save();
      send(room.id, 'alert', alert);
      return json(res, 200, alert);
    }

    // POST /api/rooms/:id/rotate  -> new QR (old patient link stops working)
    if (req.method === 'POST' && sub === 'rotate') {
      room.patientToken = token(12);
      save();
      send(room.id, 'unpaired', {}, 'patient');
      return json(res, 200, { patientToken: room.patientToken });
    }
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
      // Pressing the same button again re-rings the existing call instead of stacking duplicates.
      let alert = activeAlerts(room).find((a) => a.type === type);
      if (alert) {
        alert.rings = (alert.rings || 1) + 1;
        alert.status = 'sent';
        alert.updatedAt = Date.now();
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
        room.alerts.unshift(alert);
        room.alerts.length = Math.min(room.alerts.length, MAX_ALERTS_KEPT);
      }
      save();
      send(room.id, 'alert', alert);
      send(room.id, 'ring', alert, 'caregiver');
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
