"""SQLite 存储层。

用标准库 sqlite3 —— 单机/家庭/小型园区场景足够，省掉一整套 ORM 依赖。
所有 JSON 字段统一用 TEXT 存，读出来时反序列化。
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable

from .models import Camera, Digest, Event, Subscriber

SCHEMA = """
CREATE TABLE IF NOT EXISTS cameras (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    platform    TEXT NOT NULL,
    options     TEXT NOT NULL DEFAULT '{}',
    enabled     INTEGER NOT NULL DEFAULT 1,
    zone        TEXT NOT NULL DEFAULT '',
    analyze     INTEGER NOT NULL DEFAULT 1,
    record      INTEGER NOT NULL DEFAULT 1,
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    id           TEXT PRIMARY KEY,
    camera_id    TEXT NOT NULL,
    started_at   REAL NOT NULL,
    ended_at     REAL NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'person',
    score        REAL NOT NULL DEFAULT 0,
    person_count INTEGER NOT NULL DEFAULT 0,
    max_persons  INTEGER NOT NULL DEFAULT 0,
    thumb_path   TEXT NOT NULL DEFAULT '',
    clip_path    TEXT NOT NULL DEFAULT '',
    meta         TEXT NOT NULL DEFAULT '{}',
    notified     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_started ON events(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_camera  ON events(camera_id, started_at DESC);

CREATE TABLE IF NOT EXISTS digests (
    id         TEXT PRIMARY KEY,
    day        TEXT NOT NULL,
    camera_id  TEXT NOT NULL DEFAULT '',
    video_path TEXT NOT NULL DEFAULT '',
    cover_path TEXT NOT NULL DEFAULT '',
    summary    TEXT NOT NULL DEFAULT '',
    stats      TEXT NOT NULL DEFAULT '{}',
    created_at REAL NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_day ON digests(day, camera_id);

CREATE TABLE IF NOT EXISTS subscribers (
    id         TEXT PRIMARY KEY,
    channel    TEXT NOT NULL,
    target     TEXT NOT NULL,
    label      TEXT NOT NULL DEFAULT '',
    enabled    INTEGER NOT NULL DEFAULT 1,
    levels     TEXT NOT NULL DEFAULT 'event,digest',
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS push_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber TEXT NOT NULL,
    ref        TEXT NOT NULL,
    ok         INTEGER NOT NULL,
    detail     TEXT NOT NULL DEFAULT '',
    sent_at    REAL NOT NULL
);

-- 各平台 accessToken 之类的短效凭证缓存
CREATE TABLE IF NOT EXISTS kv (
    k          TEXT PRIMARY KEY,
    v          TEXT NOT NULL,
    expires_at REAL NOT NULL DEFAULT 0
);
"""


class Database:
    def __init__(self, path: Path | str) -> None:
        self.path = str(path)
        self._local = threading.local()
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self.conn:
            self.conn.executescript(SCHEMA)

    @property
    def conn(self) -> sqlite3.Connection:
        # 每线程一个连接：分析 worker、API、定时任务各跑各的
        c = getattr(self._local, "conn", None)
        if c is None:
            c = sqlite3.connect(self.path, timeout=15, check_same_thread=False)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA busy_timeout=15000")
            self._local.conn = c
        return c

    # ---------------- cameras ----------------

    def upsert_camera(self, cam: Camera) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT INTO cameras (id,name,platform,options,enabled,zone,analyze,record,created_at)
                   VALUES (?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                     name=excluded.name, platform=excluded.platform, options=excluded.options,
                     enabled=excluded.enabled, zone=excluded.zone,
                     analyze=excluded.analyze, record=excluded.record""",
                (cam.id, cam.name, cam.platform, json.dumps(cam.options, ensure_ascii=False),
                 int(cam.enabled), cam.zone, int(cam.analyze), int(cam.record), cam.created_at),
            )

    def get_camera(self, camera_id: str) -> Camera | None:
        row = self.conn.execute("SELECT * FROM cameras WHERE id=?", (camera_id,)).fetchone()
        return _camera(row) if row else None

    def list_cameras(self, *, only_enabled: bool = False) -> list[Camera]:
        sql = "SELECT * FROM cameras"
        if only_enabled:
            sql += " WHERE enabled=1"
        sql += " ORDER BY created_at"
        return [_camera(r) for r in self.conn.execute(sql)]

    def delete_camera(self, camera_id: str) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM cameras WHERE id=?", (camera_id,))

    # ---------------- events ----------------

    def add_event(self, ev: Event) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT OR REPLACE INTO events
                   (id,camera_id,started_at,ended_at,kind,score,person_count,max_persons,
                    thumb_path,clip_path,meta,notified)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (ev.id, ev.camera_id, ev.started_at, ev.ended_at, ev.kind, ev.score,
                 ev.person_count, ev.max_persons, ev.thumb_path, ev.clip_path,
                 json.dumps(ev.meta, ensure_ascii=False), int(ev.notified)),
            )

    def mark_notified(self, event_id: str) -> None:
        with self.conn:
            self.conn.execute("UPDATE events SET notified=1 WHERE id=?", (event_id,))

    def list_events(
        self,
        *,
        since: float | None = None,
        until: float | None = None,
        camera_id: str | None = None,
        limit: int = 200,
    ) -> list[Event]:
        sql = "SELECT * FROM events WHERE 1=1"
        args: list[Any] = []
        if since is not None:
            sql += " AND started_at >= ?"
            args.append(since)
        if until is not None:
            sql += " AND started_at < ?"
            args.append(until)
        if camera_id:
            sql += " AND camera_id = ?"
            args.append(camera_id)
        sql += " ORDER BY started_at DESC LIMIT ?"
        args.append(limit)
        return [_event(r) for r in self.conn.execute(sql, args)]

    def get_event(self, event_id: str) -> Event | None:
        row = self.conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
        return _event(row) if row else None

    def purge_events_before(self, ts: float) -> list[str]:
        """返回被清理事件的媒体文件路径，交给调用方删文件。"""
        rows = self.conn.execute(
            "SELECT clip_path, thumb_path FROM events WHERE started_at < ?", (ts,)
        ).fetchall()
        paths = [p for r in rows for p in (r["clip_path"], r["thumb_path"]) if p]
        with self.conn:
            self.conn.execute("DELETE FROM events WHERE started_at < ?", (ts,))
        return paths

    # ---------------- digests ----------------

    def upsert_digest(self, d: Digest) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT INTO digests (id,day,camera_id,video_path,cover_path,summary,stats,created_at)
                   VALUES (?,?,?,?,?,?,?,?)
                   ON CONFLICT(day,camera_id) DO UPDATE SET
                     video_path=excluded.video_path, cover_path=excluded.cover_path,
                     summary=excluded.summary, stats=excluded.stats, created_at=excluded.created_at""",
                (d.id, d.day, d.camera_id, d.video_path, d.cover_path, d.summary,
                 json.dumps(d.stats, ensure_ascii=False), d.created_at),
            )

    def get_digest(self, day: str, camera_id: str = "") -> Digest | None:
        row = self.conn.execute(
            "SELECT * FROM digests WHERE day=? AND camera_id=?", (day, camera_id)
        ).fetchone()
        return _digest(row) if row else None

    def list_digests(self, limit: int = 60) -> list[Digest]:
        rows = self.conn.execute("SELECT * FROM digests ORDER BY day DESC LIMIT ?", (limit,))
        return [_digest(r) for r in rows]

    # ---------------- subscribers ----------------

    def upsert_subscriber(self, s: Subscriber) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT INTO subscribers (id,channel,target,label,enabled,levels,created_at)
                   VALUES (?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                     channel=excluded.channel, target=excluded.target, label=excluded.label,
                     enabled=excluded.enabled, levels=excluded.levels""",
                (s.id, s.channel, s.target, s.label, int(s.enabled),
                 ",".join(s.levels), s.created_at),
            )

    def list_subscribers(self, *, level: str | None = None) -> list[Subscriber]:
        rows = self.conn.execute("SELECT * FROM subscribers WHERE enabled=1")
        subs = [_subscriber(r) for r in rows]
        if level:
            subs = [s for s in subs if level in s.levels]
        return subs

    def delete_subscriber(self, sub_id: str) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM subscribers WHERE id=?", (sub_id,))

    def log_push(self, subscriber: str, ref: str, ok: bool, detail: str = "") -> None:
        with self.conn:
            self.conn.execute(
                "INSERT INTO push_log (subscriber,ref,ok,detail,sent_at) VALUES (?,?,?,?,?)",
                (subscriber, ref, int(ok), detail[:500], time.time()),
            )

    # ---------------- kv（平台 token 缓存） ----------------

    def kv_get(self, key: str) -> Any | None:
        row = self.conn.execute("SELECT v, expires_at FROM kv WHERE k=?", (key,)).fetchone()
        if not row:
            return None
        if row["expires_at"] and row["expires_at"] < time.time():
            return None
        return json.loads(row["v"])

    def kv_set(self, key: str, value: Any, ttl: float = 0) -> None:
        expires = time.time() + ttl if ttl else 0
        with self.conn:
            self.conn.execute(
                "INSERT INTO kv (k,v,expires_at) VALUES (?,?,?) "
                "ON CONFLICT(k) DO UPDATE SET v=excluded.v, expires_at=excluded.expires_at",
                (key, json.dumps(value, ensure_ascii=False), expires),
            )


# ---------------- row -> dataclass ----------------

def _camera(row: sqlite3.Row) -> Camera:
    return Camera(
        id=row["id"], name=row["name"], platform=row["platform"],
        options=json.loads(row["options"]), enabled=bool(row["enabled"]), zone=row["zone"],
        analyze=bool(row["analyze"]), record=bool(row["record"]), created_at=row["created_at"],
    )


def _event(row: sqlite3.Row) -> Event:
    return Event(
        id=row["id"], camera_id=row["camera_id"], started_at=row["started_at"],
        ended_at=row["ended_at"], kind=row["kind"], score=row["score"],
        person_count=row["person_count"], max_persons=row["max_persons"],
        thumb_path=row["thumb_path"], clip_path=row["clip_path"],
        meta=json.loads(row["meta"]), notified=bool(row["notified"]),
    )


def _digest(row: sqlite3.Row) -> Digest:
    return Digest(
        id=row["id"], day=row["day"], camera_id=row["camera_id"], video_path=row["video_path"],
        cover_path=row["cover_path"], summary=row["summary"],
        stats=json.loads(row["stats"]), created_at=row["created_at"],
    )


def _subscriber(row: sqlite3.Row) -> Subscriber:
    levels: Iterable[str] = (x for x in row["levels"].split(",") if x)
    return Subscriber(
        id=row["id"], channel=row["channel"], target=row["target"], label=row["label"],
        enabled=bool(row["enabled"]), levels=tuple(levels), created_at=row["created_at"],
    )


__all__ = ["Database"]
