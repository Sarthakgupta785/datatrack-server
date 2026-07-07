/**
 * DataTrack Class Server v2 — accounts + cloud save
 * --------------------------------------------------
 * Express + SQLite (built-in node:sqlite, Node 22.5+ — no native builds).
 *
 * Run locally:   npm install && SECRET=long-random-string npm start
 *
 * Environment variables:
 *   SECRET            required in production — signs login tokens (any long random string)
 *   ADMIN_KEY         protects /api/admin/* endpoints
 *   GOOGLE_CLIENT_ID  optional — enables "Continue with Google"
 *   DB_PATH, PORT     optional
 *
 * Endpoints:
 *   GET  /                      health + row counts
 *   GET  /api/config            { googleClientId } — frontend reads this
 *   POST /api/auth/signup       { email, password, name }         -> { token, user }
 *   POST /api/auth/login        { email, password }               -> { token, user }
 *   POST /api/auth/google       { credential } (Google ID token)  -> { token, user }
 *   GET  /api/auth/me           (Authorization: Bearer <token>)   -> { user }
 *   GET  /api/state             (auth) -> { state, updatedAt }    — full app progress
 *   POST /api/state             (auth) { state } — saves full app progress
 *   POST /api/sync              { uid, name, stats } — leaderboard stats
 *   GET  /api/leaderboard       ranked latest snapshot per student
 *   GET  /api/admin/export      ?key=ADMIN_KEY
 *   GET  /api/admin/stats       ?key=ADMIN_KEY
 */
const express = require("express");
const cors = require("cors");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me";
const SECRET = process.env.SECRET || "dev-secret-change-me";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";

const db = new DatabaseSync(process.env.DB_PATH || "datatrack.db");
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT UNIQUE NOT NULL,
    name       TEXT NOT NULL,
    pass_hash  TEXT,
    google_sub TEXT,
    created_at TEXT NOT NULL,
    last_login TEXT
  );
  CREATE TABLE IF NOT EXISTS states (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
    state      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    uid        TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    uid           TEXT NOT NULL REFERENCES users(uid),
    ts            TEXT NOT NULL,
    xp            INTEGER, coins INTEGER, level INTEGER,
    lessons       INTEGER, total_lessons INTEGER,
    streak        INTEGER, avg_score INTEGER, quiz_attempts INTEGER,
    minutes_week  INTEGER, badges INTEGER, reviews INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_snap_uid_ts ON snapshots(uid, ts DESC);
`);

/* ---------- crypto helpers (no external deps) ---------- */
const b64u = b => Buffer.from(b).toString("base64url");
const hashPassword = pw => {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(pw, salt, 64).toString("hex");
};
const verifyPassword = (pw, stored) => {
  if (!stored) return false;
  const [salt, hex] = stored.split(":");
  const a = crypto.scryptSync(pw, salt, 64), b = Buffer.from(hex, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const signToken = user => {
  const payload = b64u(JSON.stringify({ u: user.id, e: user.email, x: Date.now() + 30 * 864e5 }));
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return payload + "." + sig;
};
const readToken = token => {
  try {
    const [payload, sig] = String(token || "").split(".");
    const good = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    const p = JSON.parse(Buffer.from(payload, "base64url").toString());
    return p.x > Date.now() ? p : null;
  } catch { return null; }
};

/* ---------- app ---------- */
const app = express();
app.use(cors());
app.use(express.json({ limit: "3mb" })); // full app state can be a few hundred KB

const clean = (s, n = 60) => String(s ?? "").replace(/[<>]/g, "").slice(0, n).trim();
const int = v => (Number.isFinite(+v) ? Math.max(0, Math.round(+v)) : null);
const publicUser = a => ({ id: a.id, email: a.email, name: a.name });

const requireAuth = (req, res, next) => {
  const t = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const p = readToken(t);
  if (!p) return res.status(401).json({ error: "not logged in" });
  req.userId = p.u;
  next();
};

app.get("/", (_req, res) => {
  res.json({
    ok: true, service: "DataTrack class server v2",
    accounts: db.prepare("SELECT COUNT(*) c FROM accounts").get().c,
    students: db.prepare("SELECT COUNT(*) c FROM users").get().c,
    snapshots: db.prepare("SELECT COUNT(*) c FROM snapshots").get().c,
  });
});

app.get("/api/config", (_req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID || null }));

/* ---------- auth ---------- */
app.post("/api/auth/signup", (req, res) => {
  const email = clean(req.body?.email, 120).toLowerCase();
  const name = clean(req.body?.name) || email.split("@")[0];
  const password = String(req.body?.password || "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "That email doesn't look valid" });
  if (password.length < 6) return res.status(400).json({ error: "Password needs at least 6 characters" });
  if (db.prepare("SELECT id FROM accounts WHERE email=?").get(email))
    return res.status(409).json({ error: "An account with this email already exists — sign in instead" });
  const now = new Date().toISOString();
  db.prepare("INSERT INTO accounts (email,name,pass_hash,created_at,last_login) VALUES (?,?,?,?,?)")
    .run(email, name, hashPassword(password), now, now);
  const user = db.prepare("SELECT * FROM accounts WHERE email=?").get(email);
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.post("/api/auth/login", (req, res) => {
  const email = clean(req.body?.email, 120).toLowerCase();
  const user = db.prepare("SELECT * FROM accounts WHERE email=?").get(email);
  if (!user || !verifyPassword(String(req.body?.password || ""), user.pass_hash))
    return res.status(401).json({ error: "Wrong email or password" });
  db.prepare("UPDATE accounts SET last_login=? WHERE id=?").run(new Date().toISOString(), user.id);
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.post("/api/auth/google", async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(400).json({ error: "Google login not configured on this server" });
  try {
    // Verify the ID token with Google (documented approach for low-volume apps)
    const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" +
      encodeURIComponent(String(req.body?.credential || "")));
    const g = await r.json();
    if (!r.ok || g.aud !== GOOGLE_CLIENT_ID || !g.email)
      return res.status(401).json({ error: "Google token invalid" });
    const email = g.email.toLowerCase(), now = new Date().toISOString();
    let user = db.prepare("SELECT * FROM accounts WHERE email=?").get(email);
    if (!user) {
      db.prepare("INSERT INTO accounts (email,name,google_sub,created_at,last_login) VALUES (?,?,?,?,?)")
        .run(email, clean(g.name) || email.split("@")[0], g.sub, now, now);
      user = db.prepare("SELECT * FROM accounts WHERE email=?").get(email);
    } else {
      db.prepare("UPDATE accounts SET google_sub=?, last_login=? WHERE id=?").run(g.sub, now, user.id);
    }
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch { res.status(500).json({ error: "Couldn't verify with Google" }); }
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT * FROM accounts WHERE id=?").get(req.userId);
  if (!user) return res.status(404).json({ error: "account gone" });
  res.json({ user: publicUser(user) });
});

/* ---------- cloud save: full app progress ---------- */
app.get("/api/state", requireAuth, (req, res) => {
  const row = db.prepare("SELECT state, updated_at FROM states WHERE account_id=?").get(req.userId);
  if (!row) return res.json({ state: null, updatedAt: null });
  res.json({ state: JSON.parse(row.state), updatedAt: row.updated_at });
});

app.post("/api/state", requireAuth, (req, res) => {
  const state = req.body?.state;
  if (!state || typeof state !== "object") return res.status(400).json({ error: "state object required" });
  const json = JSON.stringify(state);
  if (json.length > 2500000) return res.status(413).json({ error: "state too large" });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO states (account_id, state, updated_at) VALUES (?,?,?)
              ON CONFLICT(account_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at`)
    .run(req.userId, json, now);
  res.json({ ok: true, updatedAt: now });
});

/* ---------- class sync + leaderboard (same API as v1) ---------- */
app.post("/api/sync", (req, res) => {
  const { uid, name, stats } = req.body || {};
  const id = clean(uid, 64), nm = clean(name, 40);
  if (!id || !nm || typeof stats !== "object" || !stats)
    return res.status(400).json({ error: "uid, name and stats are required" });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (uid, name, first_seen, last_seen) VALUES (?,?,?,?)
              ON CONFLICT(uid) DO UPDATE SET name=excluded.name, last_seen=excluded.last_seen`)
    .run(id, nm, now, now);
  db.prepare(`INSERT INTO snapshots (uid, ts, xp, coins, level, lessons, total_lessons,
      streak, avg_score, quiz_attempts, minutes_week, badges, reviews)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, now, int(stats.xp), int(stats.coins), int(stats.level),
      int(stats.lessons), int(stats.totalLessons), int(stats.streak),
      stats.avgScore == null ? null : int(stats.avgScore),
      int(stats.quizAttempts), int(stats.minutesWeek), int(stats.badges), int(stats.reviews));
  res.json({ ok: true });
});

app.get("/api/leaderboard", (_req, res) => {
  res.json(db.prepare(`
    WITH latest AS (
      SELECT s.*, ROW_NUMBER() OVER (PARTITION BY uid ORDER BY ts DESC) AS rn FROM snapshots s)
    SELECT u.uid, u.name, l.level, l.xp, l.lessons, l.total_lessons AS totalLessons,
           l.streak, l.avg_score AS avgScore, l.badges
    FROM latest l JOIN users u ON u.uid = l.uid
    WHERE l.rn = 1 ORDER BY l.xp DESC, l.lessons DESC LIMIT 100`).all());
});

/* ---------- admin ---------- */
const requireAdmin = (req, res, next) =>
  req.query.key === ADMIN_KEY ? next() : res.status(403).json({ error: "bad admin key" });

app.get("/api/admin/export", requireAdmin, (_req, res) => {
  res.json({
    exported_at: new Date().toISOString(),
    accounts: db.prepare("SELECT id,email,name,created_at,last_login FROM accounts").all(),
    users: db.prepare("SELECT * FROM users").all(),
    snapshots: db.prepare("SELECT * FROM snapshots ORDER BY ts").all(),
  });
});

app.get("/api/admin/stats", requireAdmin, (_req, res) => {
  res.json({
    accounts: db.prepare("SELECT COUNT(*) c FROM accounts").get().c,
    students: db.prepare("SELECT COUNT(*) c FROM users").get().c,
    active_last_7d: db.prepare("SELECT COUNT(*) c FROM users WHERE last_seen >= datetime('now','-7 days')").get().c,
    class_totals: db.prepare(`
      WITH latest AS (SELECT s.*, ROW_NUMBER() OVER (PARTITION BY uid ORDER BY ts DESC) rn FROM snapshots s)
      SELECT SUM(xp) total_xp, SUM(lessons) total_lessons,
             ROUND(AVG(avg_score),1) class_avg_score, MAX(streak) longest_streak
      FROM latest WHERE rn = 1`).get(),
    daily_activity: db.prepare(`
      SELECT substr(ts,1,10) day, COUNT(DISTINCT uid) active_students
      FROM snapshots GROUP BY day ORDER BY day DESC LIMIT 30`).all(),
  });
});

app.listen(PORT, () => console.log(`DataTrack class server v2 → http://localhost:${PORT}`));
