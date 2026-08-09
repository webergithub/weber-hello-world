"""存储层与配置加载单测。"""

from __future__ import annotations

import json

from watchtower.config import load_settings
from watchtower.db import Database
from watchtower.models import Camera, Digest, Event, Subscriber, new_id


def make_db(tmp_path) -> Database:
    return Database(tmp_path / "t.db")


def test_camera_roundtrip(tmp_path):
    db = make_db(tmp_path)
    camera = Camera(id="cam1", name="前院", platform="ezviz",
                    options={"device_serial": "D1"}, zone="前院")
    db.upsert_camera(camera)
    loaded = db.get_camera("cam1")
    assert loaded is not None
    assert loaded.name == "前院" and loaded.options["device_serial"] == "D1"


def test_upsert_camera_updates_in_place(tmp_path):
    db = make_db(tmp_path)
    db.upsert_camera(Camera(id="cam1", name="旧名", platform="ezviz"))
    db.upsert_camera(Camera(id="cam1", name="新名", platform="ezviz"))
    assert len(db.list_cameras()) == 1
    assert db.get_camera("cam1").name == "新名"


def test_only_enabled_filter(tmp_path):
    db = make_db(tmp_path)
    db.upsert_camera(Camera(id="on", name="on", platform="generic"))
    db.upsert_camera(Camera(id="off", name="off", platform="generic", enabled=False))
    assert [c.id for c in db.list_cameras(only_enabled=True)] == ["on"]


def test_events_query_by_time_and_camera(tmp_path):
    db = make_db(tmp_path)
    for i in range(5):
        db.add_event(Event(id=f"e{i}", camera_id="cam1" if i % 2 else "cam2",
                           started_at=100 + i, ended_at=110 + i, score=0.5))
    assert len(db.list_events()) == 5
    assert len(db.list_events(camera_id="cam1")) == 2
    assert len(db.list_events(since=102)) == 3
    assert len(db.list_events(since=101, until=103)) == 2


def test_events_sorted_newest_first(tmp_path):
    db = make_db(tmp_path)
    db.add_event(Event(id="old", camera_id="c", started_at=1, ended_at=2))
    db.add_event(Event(id="new", camera_id="c", started_at=99, ended_at=100))
    assert [e.id for e in db.list_events()] == ["new", "old"]


def test_purge_returns_media_paths_and_deletes_rows(tmp_path):
    db = make_db(tmp_path)
    db.add_event(Event(id="old", camera_id="c", started_at=10, ended_at=11,
                       clip_path="/a/clip.mp4", thumb_path="/a/t.jpg"))
    db.add_event(Event(id="keep", camera_id="c", started_at=1000, ended_at=1001))
    paths = db.purge_events_before(500)
    assert set(paths) == {"/a/clip.mp4", "/a/t.jpg"}
    assert [e.id for e in db.list_events()] == ["keep"]


def test_digest_unique_per_day_and_camera(tmp_path):
    db = make_db(tmp_path)
    db.upsert_digest(Digest(id=new_id("d"), day="2026-08-09", summary="v1"))
    db.upsert_digest(Digest(id=new_id("d"), day="2026-08-09", summary="v2"))
    assert len(db.list_digests()) == 1
    assert db.get_digest("2026-08-09").summary == "v2"


def test_subscriber_level_filter(tmp_path):
    db = make_db(tmp_path)
    db.upsert_subscriber(Subscriber(id="s1", channel="bark", target="k",
                                    levels=("digest",)))
    db.upsert_subscriber(Subscriber(id="s2", channel="wecom", target="u",
                                    levels=("event", "digest")))
    assert {s.id for s in db.list_subscribers(level="event")} == {"s2"}
    assert {s.id for s in db.list_subscribers(level="digest")} == {"s1", "s2"}


def test_kv_expires(tmp_path):
    db = make_db(tmp_path)
    db.kv_set("k", "v", ttl=-1)         # 已过期
    assert db.kv_get("k") is None
    db.kv_set("k2", {"a": 1}, ttl=60)
    assert db.kv_get("k2") == {"a": 1}


def test_config_file_and_env_override(tmp_path, monkeypatch):
    path = tmp_path / "watchtower.json"
    path.write_text(json.dumps({
        "api_port": 9999,
        "analysis": {"fps": 5.0, "detector": "motion"},
        "privacy": {"blur_faces": False},
    }), encoding="utf-8")

    settings = load_settings(path)
    assert settings.api_port == 9999
    assert settings.analysis.fps == 5.0
    assert settings.analysis.detector == "motion"
    assert settings.privacy.blur_faces is False

    monkeypatch.setenv("WATCHTOWER_ANALYSIS_FPS", "1.5")
    monkeypatch.setenv("WATCHTOWER_API_TOKEN", "secret")
    settings = load_settings(path)
    assert settings.analysis.fps == 1.5          # 环境变量优先级最高
    assert settings.api_token == "secret"


def test_unknown_config_keys_are_ignored(tmp_path):
    path = tmp_path / "watchtower.json"
    path.write_text(json.dumps({"nonsense": 1, "cameras": [], "api_port": 1234}),
                    encoding="utf-8")
    assert load_settings(path).api_port == 1234
