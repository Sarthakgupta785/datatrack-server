# DataTrack V2 — Publish Guide & Full-Stack Setup

Two pieces, each useful on its own:

- **`DataTrack_V2.html`** — the entire app in one file. Works 100% offline with localStorage (AI features need internet). Existing V1 progress and backups load unchanged.
- **`backend/`** — an optional Express + SQLite class server. When students enable *Class sync* (Tracker page), the app sends summary stats to it, everyone sees a live leaderboard, and you get a real SQL database of class activity.

---

## 1. Publish the app for your classmates (5 minutes)

Pick either:

**Netlify Drop (fastest).** Go to https://app.netlify.com/drop, drag `DataTrack_V2.html` in, rename it to `index.html` first (or drop a folder containing it as `index.html`). You get a public URL immediately.

**GitHub Pages (better for your portfolio).** Create a repo, add the file as `index.html`, push, then Settings → Pages → deploy from `main`. Your app lives at `https://<username>.github.io/<repo>/` — and the repo itself becomes part of your portfolio.

Each classmate's progress is stored in *their own browser* (localStorage). Nothing is shared until they opt into Class sync.

## 2. Deploy the class server (free, ~10 minutes)

The server uses Node's built-in `node:sqlite` — **no native builds, no external database needed**. Requires Node **22.5+**.

Run locally first:

```bash
cd backend
npm install
ADMIN_KEY=pick-a-secret npm start     # → http://localhost:3000
```

Deploy on **Render.com** (free tier):
1. Push the `backend/` folder to a GitHub repo.
2. Render → New → Web Service → connect the repo.
3. Build command `npm install`, start command `npm start`, environment: add `ADMIN_KEY` = a secret only you know. Set the Node version to 22 (Environment → `NODE_VERSION` = `22.12.0` or use an `engines` field, already included).
4. You get a URL like `https://datatrack-api.onrender.com`.

Railway.app works the same way. **Free-tier honesty:** free instances sleep after ~15 min idle (first request takes ~30 s to wake — the app already tells users this), and on Render the free disk is *ephemeral*, so the SQLite file resets on redeploys. For a class project that's usually acceptable; when you want durability, attach a persistent disk (Render, paid) or add a Railway volume, or graduate to Postgres (see roadmap below).

## 3. Connect the app

Each student opens **Tracker → Class sync**, enters a display name and the server URL, ticks Enable, and hits Sync now. The **Analytics** page then shows the class leaderboard. Syncing also happens automatically in the background (at most every 5 minutes, only while the app is open).

## 4. Your data, in SQL

What gets collected per student, per snapshot: XP, coins, level, lessons done, streak, average score, quiz attempts, minutes this week, badges, reviews — plus a random client ID and their chosen display name. **Nothing personal is ever sent**: no notes, no job applications, no resume text, no chat content.

Query it:
- `GET /api/admin/stats?key=YOUR_KEY` — students, 7-day actives, class totals, daily activity.
- `GET /api/admin/export?key=YOUR_KEY` — full JSON dump of both tables.
- Or open `datatrack.db` directly with any SQLite client and practice your own SQL on it — every snapshot is kept, so you can chart the whole class's progress over time. (The leaderboard endpoint itself uses `ROW_NUMBER() OVER (PARTITION BY …)` — the exact pattern from your SQL track.)

**Do this:** tell your classmates exactly what's collected (the list above) before they enable sync. The app says it in the UI too, but say it out loud. Collecting even harmless data without telling people is how good projects get bad reputations.

## 5. Making this your full-stack showcase

The architecture is already the right shape: static frontend → REST API → SQL. Natural next steps, in order of impact:

1. **Auth**: replace the random UID with signup/login (JWT or session cookies) so students can log in from any device.
2. **Cloud save**: add `POST /api/state` + `GET /api/state` that store each user's full app state (the same JSON the Backup button exports) — then progress follows the account, not the browser.
3. **Postgres migration**: swap `node:sqlite` for `pg` on Neon/Supabase free tier — the SQL barely changes, and "migrated SQLite → Postgres" is a great interview line.
4. **A class dashboard page**: a separate admin frontend charting `/api/admin/stats` — your own product analytics, built with the exact skills the app teaches.
5. **Rate limiting + validation hardening** (`express-rate-limit`, `zod`) — the "I thought about abuse" signal interviewers love.

Resume bullet when you're done: *"Built and deployed a full-stack learning platform (vanilla JS SPA, Express/SQLite REST API) used by N classmates; designed a snapshot schema and window-function leaderboard queries, and analyzed class engagement from 1,000+ synced snapshots."*
