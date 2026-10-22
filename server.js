import './env.js';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import * as store from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const PARTY_CODE = process.env.PARTY_CODE || 'mecha';           // shared link secret
const DM_PASSWORD = process.env.DM_PASSWORD || 'dungeonmaster'; // unlocks admin
const SECRET = process.env.SESSION_SECRET || 'change-me-secret';

const dmToken = () => crypto.createHmac('sha256', SECRET).update('dm-role').digest('hex').slice(0, 32);
const isDM = (auth) => auth && auth.dmToken === dmToken();
const partyOK = (auth) => auth && auth.party === PARTY_CODE;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// ---- DM login ----
app.post('/api/dm-login', (req, res) => {
  if ((req.body || {}).password === DM_PASSWORD) return res.json({ ok: true, dmToken: dmToken() });
  res.status(401).json({ ok: false, error: 'Wrong DM password.' });
});
// ---- validate a party code (used by the gate screen) ----
app.post('/api/party', (req, res) => {
  res.json({ ok: (req.body || {}).party === PARTY_CODE });
});
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---- backups: per-save history + daily snapshots + DM download/restore ----
const dmHeader = (req) => req.get('x-dm-token') || req.query.t;
const today = () => new Date().toISOString().slice(0, 10);
async function snapshot(id) {
  const st = await fullState(); delete st.rolls;
  await store.put('backups', id, { t: Date.now(), state: st });
  const all = (await store.getAll('backups')).map(b => b.id).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 30))) await store.del('backups', old);
}
async function dailySnapshot() {
  try { if (!(await store.get('backups', today()))) { await snapshot(today()); console.log('[backup] snapshot', today()); } }
  catch (e) { console.error('[backup] failed', e.message); }
}
async function keepHistory(collection, id, prev) {
  if (!prev || (collection !== 'characters' && collection !== 'mechs')) return;
  const h = (await store.get('history', collection + ':' + id))?.list || [];
  await store.put('history', collection + ':' + id, { list: [{ t: Date.now(), data: prev }, ...h].slice(0, 25) });
}
app.get('/api/backups', async (req, res) => {
  if (dmHeader(req) !== dmToken()) return res.status(401).json({ ok: false });
  const snaps = (await store.getAll('backups')).map(b => ({ id: b.id, t: b.t })).sort((a, b) => b.id.localeCompare(a.id));
  res.json({ ok: true, snapshots: snaps });
});
app.get('/api/backup', async (req, res) => {
  if (dmHeader(req) !== dmToken()) return res.status(401).send('DM only');
  const st = await fullState();
  res.setHeader('Content-Disposition', `attachment; filename="mecha-merc-backup-${today()}.json"`);
  res.json({ backupOf: 'mecha-merc', t: Date.now(), state: st });
});
app.post('/api/restore', async (req, res) => {
  if (dmHeader(req) !== dmToken()) return res.status(401).json({ ok: false });
  const b = req.body || {};
  let st = null;
  if (b.snapshot) st = (await store.get('backups', b.snapshot))?.state;
  else if (b.data) st = b.data.state || b.data;
  if (!st || !Array.isArray(st.characters)) return res.status(400).json({ ok: false, error: 'No backup data' });
  await snapshot('pre-restore-' + new Date().toISOString().replace(/[:.]/g, '-'));
  for (const c of st.characters) await store.put('characters', c.id, c);
  for (const m of st.mechs || []) await store.put('mechs', m.id, m);
  for (const l of st.library || []) await store.put('library', l.id, l);
  if (st.settings) await store.put('settings', 'settings', st.settings);
  if (st.ship) await store.put('ship', 'eugene', st.ship);
  io.to('party').emit('state', await fullState());
  res.json({ ok: true });
});

// ---- seed on first boot ----
async function seedIfEmpty() {
  if (!(await store.isEmpty())) return;
  const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', f), 'utf8'));
  for (const c of read('characters.json')) await store.put('characters', c.id, c);
  for (const m of read('mechs.json')) await store.put('mechs', m.id, m);
  const s = read('settings.json'); await store.put('settings', 'settings', s);
  console.log('[seed] planted starter roster');
}

async function fullState() {
  const rolls = (await store.get('rolls', 'feed'))?.list || [];
  return {
    characters: await store.getAll('characters'),
    mechs: await store.getAll('mechs'),
    library: await store.getAll('library'),
    settings: (await store.get('settings', 'settings')) || {},
    ship: await store.get('ship', 'eugene'),
    rolls,
  };
}

// authorize a write to a collection/id given auth + payload
async function canWrite(auth, collection, id, data) {
  if (!partyOK(auth)) return false;
  if (isDM(auth)) return true;
  if (collection === 'settings') return false;              // DM only
  if (collection === 'library' || collection === 'rolls' || collection === 'ship') return true; // any member
  if (collection === 'characters') return auth.pilotId === id;
  if (collection === 'mechs') {
    const owner = (await store.getAll('characters')).find(c => c.id === auth.pilotId);
    return owner && owner.mechRef === id;
  }
  return false;
}

io.on('connection', (socket) => {
  let authed = false;
  socket.on('hello', async (auth) => {
    if (!partyOK(auth)) { socket.emit('denied'); return; }
    authed = true;
    socket.join('party');
    socket.emit('state', await fullState());
  });

  socket.on('write', async ({ auth, collection, id, data }) => {
    if (!authed) return;
    if (!(await canWrite(auth, collection, id, data))) { socket.emit('nope', { collection, id }); return; }
    // never let a client (e.g. an older/newer UI) silently drop fields it doesn't know about
    let body = data;
    if (collection === 'characters' || collection === 'mechs') {
      const prev = await store.get(collection, id);
      if (prev) { body = { ...prev, ...data }; await keepHistory(collection, id, prev); }
    }
    const saved = await store.put(collection, id, body);
    io.to('party').emit('update', { collection, id, data: saved });
  });

  socket.on('remove', async ({ auth, collection, id }) => {
    if (!authed || !(await canWrite(auth, collection, id, {}))) return;
    await store.del(collection, id);
    io.to('party').emit('removed', { collection, id });
  });

  // split the ship bank equally across every pilot (server-side so it can credit all sheets)
  socket.on('shipDistribute', async ({ auth }) => {
    if (!authed || !partyOK(auth)) return;
    const sh = await store.get('ship', 'eugene');
    const chars = await store.getAll('characters');
    if (!sh || !chars.length) return;
    const share = Math.floor((sh.bank || 0) / chars.length);
    if (share <= 0) return;
    for (const c of chars) {
      c.credits = (c.credits || 0) + share;
      const saved = await store.put('characters', c.id, c);
      io.to('party').emit('update', { collection: 'characters', id: c.id, data: saved });
    }
    sh.bank = (sh.bank || 0) - share * chars.length;
    sh.log = [{ t: Date.now(), day: sh.day, msg: `Distributed ◈${share.toLocaleString()} to each of ${chars.length} pilots` }, ...(sh.log || [])].slice(0, 40);
    const saved = await store.put('ship', 'eugene', sh);
    io.to('party').emit('update', { collection: 'ship', id: 'eugene', data: saved });
  });

  socket.on('roll', async ({ auth, roll }) => {
    if (!authed || !partyOK(auth)) return;
    const cur = (await store.get('rolls', 'feed'))?.list || [];
    const list = [roll, ...cur].slice(0, 50);
    await store.put('rolls', 'feed', { list });
    io.to('party').emit('roll', roll);
  });
});

await store.init();
await seedIfEmpty();
await dailySnapshot();
setInterval(dailySnapshot, 60 * 60 * 1000);
server.listen(PORT, () => console.log(`Mecha Merc Terminal on :${PORT}  (party="${PARTY_CODE}")`));
