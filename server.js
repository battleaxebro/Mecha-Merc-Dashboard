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
    rolls,
  };
}

// authorize a write to a collection/id given auth + payload
async function canWrite(auth, collection, id, data) {
  if (!partyOK(auth)) return false;
  if (isDM(auth)) return true;
  if (collection === 'settings') return false;              // DM only
  if (collection === 'library' || collection === 'rolls') return true; // any member
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
    const saved = await store.put(collection, id, data);
    io.to('party').emit('update', { collection, id, data: saved });
  });

  socket.on('remove', async ({ auth, collection, id }) => {
    if (!authed || !(await canWrite(auth, collection, id, {}))) return;
    await store.del(collection, id);
    io.to('party').emit('removed', { collection, id });
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
server.listen(PORT, () => console.log(`Mecha Merc Terminal on :${PORT}  (party="${PARTY_CODE}")`));
