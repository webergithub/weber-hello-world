import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

const dbPath = path.join(__dirname, '../../data/tiktok.db')
fs.mkdirSync(path.dirname(dbPath), { recursive: true })

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    cover TEXT NOT NULL,
    title TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_avatar TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    duration INTEGER NOT NULL DEFAULT 30,
    likes INTEGER NOT NULL DEFAULT 0,
    comments INTEGER NOT NULL DEFAULT 0,
    shares INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    watch_ratio REAL NOT NULL DEFAULT 0,
    ts INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_video ON events(video_id);
  CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);
`)

export default db
