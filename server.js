'use strict';
// Streetlight backend: persistent reports, abuse protection, key-hiding proxies, real SMS alerts.
// Zero dependencies (Node 20+).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 8080;
const ORS_KEY = process.env.ORS_KEY || '';
const SALT = process.env.HASH_SALT || 'change-me';
const CONTACT = process.env.CONTACT_EMAIL || 'contact@example.com';
const TW = { sid: process.env.TWILIO_SID, token: process.env.TWILIO_TOKEN, from: process.env.TWILIO_FROM };
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'reports.json');
const PUBLIC = path.join(__dirname, 'public');
const TYPES = ['dark', 'harass', 'isolated', 'safe'];
const INDIA = { minLat: 6, maxLat: 38, minLng: 68, maxLng: 98 };
const MAX_AGE_MS = 90 * 86400000;

// ---------- storage (JSON file, atomic writes) ----------
let db = { reports: [] };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { /* first run */ }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) { console.error('save failed', e.message); }
  }, 300);
}

// ---------- helpers ----------
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr); return false;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (!v.some(t => n - t < 3600000)) hits.delete(k); }, 600000).unref();

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ttlMs) return c.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return v;
}

const clientId = req => crypto.createHash('sha256')
  .update(SALT + String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim())
  .digest('hex').slice(0, 16);

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function body(req, max = 10000) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > max) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(new Error('bad json')); } });
  });
}
const num = (v, lo, hi) => typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;
const inIndia = (lat, lng) => num(lat, INDIA.minLat, INDIA.maxLat) && num(lng, INDIA.minLng, INDIA.maxLng);
const distM = (a, b, c, d) => { const r = Math.PI / 180, x = (d - b) * r * Math.cos((a + c) * r / 2), y = (c - a) * r; return 6371000 * Math.hypot(x, y); };

const visible = r => r.flags < 3 && !(r.gone >= 3 && r.gone > r.confirms) && Date.now() - r.time < MAX_AGE_MS;
const publicView = r => ({ id: r.id, lat: r.lat, lng: r.lng, type: r.type, time: r.time, confirms: r.confirms, gone: r.gone, flags: r.flags });

async function upstream(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
  return { status: r.status, text: await r.text() };
}

// ---------- API ----------
async function api(req, res, url) {
  const p = url.pathname, id = clientId(req);

  if (p === '/api/health') return send(res, 200, { ok: true, reports: db.reports.length, routing: !!ORS_KEY, sms: !!TW.sid });

  if (p === '/api/reports' && req.method === 'GET') {
    return send(res, 200, db.reports.filter(visible).slice(-2000).map(publicView));
  }

  if (p === '/api/reports' && req.method === 'POST') {
    if (limited('rep:' + id, 10, 3600000)) return send(res, 429, { error: 'Too many reports. Please try again later.' });
    const b = await body(req);
    if (!TYPES.includes(b.type) || !inIndia(b.lat, b.lng)) return send(res, 400, { error: 'Invalid report.' });
    const dup = db.reports.find(r => r.by === id && r.type === b.type && Date.now() - r.time < 3600000 && distM(r.lat, r.lng, b.lat, b.lng) < 30);
    if (dup) return send(res, 409, { error: 'You already reported this here.' });
    const r = { id: crypto.randomUUID(), lat: +b.lat.toFixed(5), lng: +b.lng.toFixed(5), type: b.type, time: Date.now(), by: id, confirms: 0, gone: 0, flags: 0, voters: {} };
    db.reports.push(r); save();
    return send(res, 201, publicView(r));
  }

  let m = p.match(/^\/api\/reports\/([\w-]{36})\/vote$/);
  if (m && req.method === 'POST') {
    if (limited('vote:' + id, 60, 3600000)) return send(res, 429, { error: 'Too many votes.' });
    const b = await body(req), r = db.reports.find(x => x.id === m[1]);
    if (!r) return send(res, 404, { error: 'Not found.' });
    if (!['confirm', 'gone', 'flag'].includes(b.vote)) return send(res, 400, { error: 'Invalid vote.' });
    if (r.by === id || r.voters[id]) return send(res, 409, { error: 'You already responded to this report.' });
    r.voters[id] = b.vote;
    r[b.vote === 'confirm' ? 'confirms' : b.vote === 'gone' ? 'gone' : 'flags']++;
    save();
    return send(res, 200, publicView(r));
  }

  if (p === '/api/route' && req.method === 'POST') {
    if (!ORS_KEY) return send(res, 503, { error: 'Routing is not configured on the server.' });
    if (limited('route:' + id, 30, 3600000)) return send(res, 429, { error: 'Too many route requests.' });
    const b = await body(req), c = b.coordinates;
    const ok = Array.isArray(c) && c.length === 2 && c.every(x => Array.isArray(x) && inIndia(x[1], x[0]));
    if (!ok) return send(res, 400, { error: 'Invalid coordinates.' });
    const payload = { coordinates: c, radiuses: [500, 500], alternative_routes: { target_count: 3, share_factor: 0.6, weight_factor: 1.6 } };
    const out = await cached('r:' + JSON.stringify(c), 600000, () => upstream(
      'https://api.heigit.org/openrouteservice/v2/directions/foot-walking/geojson',
      { method: 'POST', headers: { Authorization: ORS_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }));
    res.writeHead(out.status, { 'Content-Type': 'application/json' }); return res.end(out.text);
  }

  if (p === '/api/geocode') {
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2 || q.length > 100) return send(res, 400, { error: 'Invalid query.' });
    if (limited('geo:' + id, 30, 60000) || limited('geo:all', 1, 1000)) return send(res, 429, { error: 'Slow down.' });
    const out = await cached('g:' + q.toLowerCase(), 3600000, () => upstream(
      'https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=in&q=' + encodeURIComponent(q),
      { headers: { 'User-Agent': 'Streetlight/1.0 (' + CONTACT + ')' } }));
    res.writeHead(out.status, { 'Content-Type': 'application/json' }); return res.end(out.text);
  }

  if (p === '/api/overpass') {
    const lat = +url.searchParams.get('lat'), lng = +url.searchParams.get('lng');
    if (!inIndia(lat, lng)) return send(res, 400, { error: 'Invalid location.' });
    if (limited('op:' + id, 20, 60000)) return send(res, 429, { error: 'Slow down.' });
    const q = `[out:json][timeout:20];(node["amenity"~"police|hospital"](around:3000,${lat},${lng});way["amenity"~"police|hospital"](around:3000,${lat},${lng}););out center 40;`;
    const out = await cached('o:' + lat.toFixed(3) + lng.toFixed(3), 600000, () => upstream(
      'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(q), { headers: { 'User-Agent': 'Streetlight/1.0 (' + CONTACT + ')' } }));
    res.writeHead(out.status, { 'Content-Type': 'application/json' }); return res.end(out.text);
  }

  if (p === '/api/alert' && req.method === 'POST') {
    // Message text is built here, never taken from the client, so this cannot be used as a spam relay.
    if (limited('alert:' + id, 3, 600000)) return send(res, 429, { error: 'Too many alerts. Call 112 if urgent.' });
    const b = await body(req);
    let phone = String(b.phone || '').replace(/[\s-]/g, '');
    if (/^\d{10}$/.test(phone)) phone = '+91' + phone;
    if (!/^\+\d{11,14}$/.test(phone) || !inIndia(b.lat, b.lng) || !['sos', 'trip'].includes(b.kind))
      return send(res, 400, { error: 'Invalid alert.' });
    if (!TW.sid || !TW.token || !TW.from) return send(res, 200, { sent: false, reason: 'sms_not_configured' });
    const link = `https://www.google.com/maps?q=${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;
    const text = b.kind === 'sos'
      ? `SOS from Streetlight: your contact needs help. Location: ${link}`
      : `Streetlight alert: your contact did not respond to a safety check-in. Last location: ${link}`;
    const out = await upstream(`https://api.twilio.com/2010-04-01/Accounts/${TW.sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(TW.sid + ':' + TW.token).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: phone, From: TW.from, Body: text }).toString()
    });
    return send(res, 200, { sent: out.status < 300 });
  }

  send(res, 404, { error: 'Not found.' });
}

// ---------- static files + server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const HEADERS = {
  'X-Content-Type-Options': 'nosniff',    'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(self)',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: https://unpkg.com https://tile.openstreetmap.org https://*.tile.openstreetmap.org; connect-src 'self'; frame-ancestors 'none'"
};

const server = http.createServer(async (req, res) => {
  for (const k in HEADERS) res.setHeader(k, HEADERS[k]);
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let f = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(f, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(data);
    });
  } catch (e) {
    console.error(e.message);
    if (!res.headersSent) send(res, e.message === 'too large' || e.message === 'bad json' ? 400 : 502, { error: 'Request failed.' });
  }
});
if (require.main === module) server.listen(PORT, () => console.log('Streetlight on :' + PORT));
module.exports = server;
