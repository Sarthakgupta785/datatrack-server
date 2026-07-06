/**
 * DataTrack Class Server
 * ----------------------
 * A small Express + SQLite backend that receives progress stats from the
 * DataTrack app ("Class sync" in Tracker), stores every snapshot in SQL,
 * and serves a class leaderboard.
 *
 * Run locally:   npm install && npm start        → http://localhost:3000
 * Requires:      Node.js 22.5 or newer (uses the built-in node:sqlite)
 * Deploy free:   Render.com / Railway.app        (see README)
 *
 * Endpoints:
 *   GET  /                     health + row counts
 *   POST /api/sync             app sends {uid, name, stats}
 *   GET  /api/leaderboard      latest snapshot per student, ranked by XP
 *   GET  /api/admin/export     ?key=ADMIN_KEY → full data dump (JSON)
 *   GET  /api/admin/stats      ?key=ADMIN_KEY → aggregate class analytics
 */
const express = require("express");
const cors = require("cors");
const { DatabaseSync } = require("node:sqlite"); // built into Node 22.5+ — no native builds

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me"; // set a real one in production!

const db = new DatabaseSync(process.env.DB_PATH || "datatrack.db");
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
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

const app = express();
app.use(cors());               // the app is served from another origin (GitHub Pages etc.)
app.use(express.json({ limit: "50kb" }));

const clean = (s, n = 40) => String(s ?? "").replace(/[<>]/g, "").slice(0, n).trim();
const int = v => (Number.isFinite(+v) ? Math.max(0, Math.round(+v)) : null);

app.get("/", (_req, res) => {
  const u = db.prepare("SELECT COUNT(*) c FROM users").get().c;
  const s = db.prepare("SELECT COUNT(*) c FROM snapshots").get().c;
  res.json({ ok: true, service: "DataTrack class server", students: u, snapshots: s });
});

app.post("/api/sync", (req, res) => {
  const { uid, name, stats } = req.body || {};
  const id = clean(uid, 64), nm = clean(name);
  if (!id || !nm || typeof stats !== "object" || !stats)
    return res.status(400).json({ error: "uid, name and stats are required" });

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (uid, name, first_seen, last_seen) VALUES (?, ?, ?, ?)
    ON CONFLICT(uid) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen
  `).run(id, nm, now, now);

  db.prepare(`
    INSERT INTO snapshots (uid, ts, xp, coins, level, lessons, total_lessons,
      streak, avg_score, quiz_attempts, minutes_week, badges, reviews)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, now, int(stats.xp), int(stats.coins), int(stats.level),
    int(stats.lessons), int(stats.totalLessons), int(stats.streak),
    stats.avgScore == null ? null : int(stats.avgScore),
    int(stats.quizAttempts), int(stats.minutesWeek), int(stats.badges), int(stats.reviews));

  res.json({ ok: true });
});

app.get("/api/leaderboard", (_req, res) => {
  // latest snapshot per user, ranked by XP — a window function in the wild!
  const rows = db.prepare(`
    WITH latest AS (
      SELECT s.*, ROW_NUMBER() OVER (PARTITION BY uid ORDER BY ts DESC) AS rn
      FROM snapshots s
    )
    SELECT u.uid, u.name, l.level, l.xp, l.lessons, l.total_lessons AS totalLessons,
           l.streak, l.avg_score AS avgScore, l.badges
    FROM latest l JOIN users u ON u.uid = l.uid
    WHERE l.rn = 1
    ORDER BY l.xp DESC, l.lessons DESC
    LIMIT 100
  `).all();
  res.json(rows);
});

const requireAdmin = (req, res, next) =>
  req.query.key === ADMIN_KEY ? next() : res.status(403).json({ error: "bad admin key" });

app.get("/api/admin/export", requireAdmin, (_req, res) => {
  res.json({
    exported_at: new Date().toISOString(),
    users: db.prepare("SELECT * FROM users").all(),
    snapshots: db.prepare("SELECT * FROM snapshots ORDER BY ts").all(),
  });
});

app.get("/api/admin/stats", requireAdmin, (_req, res) => {
  res.json({
    students: db.prepare("SELECT COUNT(*) c FROM users").get().c,
    active_last_7d: db.prepare(
      "SELECT COUNT(*) c FROM users WHERE last_seen >= datetime('now','-7 days')").get().c,
    class_totals: db.prepare(`
      WITH latest AS (
        SELECT s.*, ROW_NUMBER() OVER (PARTITION BY uid ORDER BY ts DESC) rn FROM snapshots s)
      SELECT SUM(xp) total_xp, SUM(lessons) total_lessons,
             ROUND(AVG(avg_score),1) class_avg_score, MAX(streak) longest_streak
      FROM latest WHERE rn = 1`).get(),
    daily_activity: db.prepare(`
      SELECT substr(ts,1,10) day, COUNT(DISTINCT uid) active_students
      FROM snapshots GROUP BY day ORDER BY day DESC LIMIT 30`).all(),
  });
});

app.listen(PORT, () => console.log(`DataTrack class server → http://localhost:${PORT}`));
