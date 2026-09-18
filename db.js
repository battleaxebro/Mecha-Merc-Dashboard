// Storage abstraction: Postgres when DATABASE_URL is set, else a local JSON file.
// One logical table: kv(collection, id, data). Simple and portable.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USE_PG = !!process.env.DATABASE_URL;

let pg = null;
if (USE_PG) {
  const { default: Pg } = await import('pg');
  pg = new Pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  });
}

// ---- JSON fallback (dev / no DB) ----
const FILE = path.join(__dirname, 'data.json');
let mem = { characters: {}, mechs: {}, library: {}, settings: {}, rolls: {} };
function loadFile() {
  try { mem = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* fresh */ }
}
let saveTimer = null;
function saveFile() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(FILE, JSON.stringify(mem)), 120);
}
if (!USE_PG) loadFile();

export async function init() {
  if (USE_PG) {
    await pg.query(`CREATE TABLE IF NOT EXISTS kv (
      collection text NOT NULL,
      id text NOT NULL,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (collection, id)
    )`);
  }
}

export async function getAll(collection) {
  if (USE_PG) {
    const r = await pg.query('SELECT id, data FROM kv WHERE collection=$1 ORDER BY id', [collection]);
    return r.rows.map(row => ({ ...row.data, id: row.id }));
  }
  return Object.values(mem[collection] || {});
}

export async function get(collection, id) {
  if (USE_PG) {
    const r = await pg.query('SELECT data FROM kv WHERE collection=$1 AND id=$2', [collection, id]);
    return r.rows[0] ? { ...r.rows[0].data, id } : null;
  }
  return (mem[collection] || {})[id] || null;
}

export async function put(collection, id, data) {
  const body = { ...data, id };
  if (USE_PG) {
    await pg.query(
      `INSERT INTO kv (collection,id,data,updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (collection,id) DO UPDATE SET data=$3, updated_at=now()`,
      [collection, id, body]
    );
  } else {
    (mem[collection] = mem[collection] || {})[id] = body;
    saveFile();
  }
  return body;
}

export async function del(collection, id) {
  if (USE_PG) await pg.query('DELETE FROM kv WHERE collection=$1 AND id=$2', [collection, id]);
  else { delete (mem[collection] || {})[id]; saveFile(); }
}

export async function isEmpty() {
  if (USE_PG) {
    const r = await pg.query("SELECT 1 FROM kv WHERE collection='characters' LIMIT 1");
    return r.rowCount === 0;
  }
  return Object.keys(mem.characters || {}).length === 0;
}
