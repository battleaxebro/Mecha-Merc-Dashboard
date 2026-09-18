# Mecha Merc Terminal

A homebrew **SW5E (cyberpunk/mecha)** pilot & mech dashboard with live multiplayer sync — character sheets, drag-to-equip inventory with carry-capacity and cybernetic-overload rules, a mech builder with modification-slot overload, a 1,400+ item catalog, a shared party item library, and a live dice feed.

- **Pilots** edit their own sheet; the **DM** edits everything and sets house rules.
- Access is gated by a **party code** (in the share link); the **DM password** unlocks admin.
- Storage is **Postgres** in production, or a local `data.json` file when no database is configured.

---

## Deploy to Render (recommended, free)

You'll need a free [Render](https://render.com) account and this project pushed to a GitHub repo.

1. **Push to GitHub.** From this folder:
   ```bash
   git init && git add . && git commit -m "Mecha Merc Terminal"
   git branch -M main
   git remote add origin https://github.com/<you>/mecha-merc-web.git
   git push -u origin main
   ```
2. In Render, click **New → Blueprint**, pick your repo. Render reads `render.yaml` and creates **a web service + a free Postgres database** automatically.
3. When prompted, set the two secrets:
   - **PARTY_CODE** — the code your players will use (e.g. `mecha-mercs`)
   - **DM_PASSWORD** — your admin password
   (`SESSION_SECRET` is generated for you; `DATABASE_URL` is wired to the database automatically.)
4. Click **Apply**. First deploy takes a few minutes and **auto-seeds** your 4 pilots + 4 mechs.
5. Your app is at `https://mecha-merc.onrender.com` (or similar).

> Free web services **sleep after ~15 min idle** and take ~30s to wake on the next visit. Fine for a gaming group; upgrade to a paid instance if you want it always-on.

### Share with your players
Send them:
```
https://<your-app>.onrender.com/?party=YOUR_PARTY_CODE
```
They open it, pick their pilot, and start playing. To act as DM, click the identity chip → **Dungeon Master** → enter the DM password.

---

## Run locally

```bash
npm install
cp .env.example .env      # then edit PARTY_CODE / DM_PASSWORD
npm start
```
Open `http://localhost:3000/?party=<your PARTY_CODE>`. With no `DATABASE_URL`, data is saved to `data.json` in this folder.

---

## Editing the roster & catalog

- **Starter roster** lives in `seed/` (`characters.json`, `mechs.json`, `settings.json`) and is planted only when the database is empty. After that, edits happen live in the app.
- **Item catalog** is `public/catalog.json` (browse-and-add reference pool). Replace it to expand the catalog; the shared *party library* (items created in-app) is separate and stored in the database.

## How the rules work

- **Carry capacity** = Strength score × 15 lb (SW5E). Over capacity → warning.
- **Cybernetics** — limit equals proficiency bonus; each augment beyond that = **−1 to ability checks & saving throws** (cumulative).
- **Mech modification slots** — each mech has a slot capacity (DM-editable); each installed part beyond it triggers the overload penalty (DM-editable rule text, in **House Rules**).

## Stack
Node + Express + Socket.io, Postgres (via `pg`) or JSON-file fallback. No build step. `render.yaml` is a one-click blueprint. All data is a single `kv(collection, id, data)` table.
