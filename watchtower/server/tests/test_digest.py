"""一日剪影选段与统计单测。"""

from __future__ import annotations

from datetime import datetime

from watchtower.config import DigestSettings
from watchtower.digest.narrator import template_summary
from watchtower.digest.selector import select_clips, summarize_day
from watchtower.models import Camera, Event


def at(hour: int, minute: int = 0) -> float:
    return datetime(2026, 8, 9, hour, minute).timestamp()


def event(eid: str, camera: str, when: float, score: float, *, persons: int = 1,
          clip: str = "x.mp4", duration: float = 20.0) -> Event:
    return Event(
        id=eid, camera_id=camera, started_at=when, ended_at=when + duration,
        score=score, person_count=persons, max_persons=persons,
        clip_path=clip, thumb_path="t.jpg",
    )


CAMERAS = {
    "front": Camera(id="front", name="前院", platform="ezviz", zone="前院"),
    "back": Camera(id="back", name="后门", platform="xiaomi", zone="后门"),
}


def test_events_without_clip_are_skipped():
    clips = select_clips([event("e1", "front", at(9), 0.9, clip="")], CAMERAS)
    assert clips == []


def test_selection_is_chronological_even_though_ranking_is_by_score():
    events = [
        event("late", "front", at(20), 0.95),
        event("early", "back", at(7), 0.90),
    ]
    clips = select_clips(events, CAMERAS, target_seconds=60, per_clip_seconds=6)
    assert [c.event_id for c in clips] == ["early", "late"]


def test_camera_quota_prevents_one_camera_hogging_the_reel():
    # 前院刷了 40 条高分事件，后门只有 2 条；不能让前院吃满
    events = [event(f"f{i}", "front", at(8) + i * 600, 0.99) for i in range(40)]
    events += [event(f"b{i}", "back", at(9) + i * 600, 0.50) for i in range(2)]
    clips = select_clips(events, CAMERAS, target_seconds=600, per_clip_seconds=6, max_clips=12)
    front = sum(1 for c in clips if c.camera_id == "front")
    assert front < len(clips), "至少要给其它摄像头留位置"
    assert front <= 10


def test_time_window_dedup_drops_near_duplicates():
    events = [
        event("a", "front", at(9, 0), 0.9),
        event("b", "front", at(9, 2), 0.8),      # 同一 5 分钟窗口
        event("c", "front", at(9, 30), 0.7),
    ]
    clips = select_clips(events, CAMERAS, dedup_window=300, target_seconds=600)
    assert [c.event_id for c in clips] == ["a", "c"]


def test_target_duration_caps_total_length():
    events = [event(f"e{i}", "front", at(8) + i * 3600, 0.9) for i in range(20)]
    clips = select_clips(events, CAMERAS, target_seconds=30, per_clip_seconds=6, max_clips=50)
    assert sum(c.seconds for c in clips) <= 36     # 最后一段可能刚好越过目标


def test_min_score_filter():
    events = [event("low", "front", at(9), 0.10), event("high", "front", at(10), 0.80)]
    clips = select_clips(events, CAMERAS, min_score=0.5)
    assert [c.event_id for c in clips] == ["high"]


def test_caption_contains_time_place_and_people():
    clips = select_clips([event("e", "front", at(14, 5), 0.8, persons=3)], CAMERAS)
    assert clips[0].caption.startswith("14:05 前院")
    assert "3人" in clips[0].caption


# ---------------------------------------------------------------- 统计

def test_summarize_empty_day_marks_all_hours_quiet():
    stats = summarize_day("2026-08-09", [], CAMERAS)
    assert stats.total_events == 0
    assert len(stats.quiet_hours) == 24


def test_summarize_identifies_busiest_hour_and_camera():
    events = [
        event("a", "front", at(9, 1), 0.5),
        event("b", "front", at(9, 30), 0.5),
        event("c", "back", at(15, 0), 0.5, persons=4),
    ]
    stats = summarize_day("2026-08-09", events, CAMERAS)
    assert stats.total_events == 3
    assert stats.busiest_hour == 9
    assert stats.busiest_camera == "前院"
    assert stats.peak_persons == 4
    assert 9 not in stats.quiet_hours and 3 in stats.quiet_hours


# ---------------------------------------------------------------- 文案

def test_template_summary_handles_quiet_day():
    stats = summarize_day("2026-08-09", [], CAMERAS)
    assert "未检测到人员活动" in template_summary(stats, [])


def test_template_summary_mentions_counts_and_place():
    events = [event("a", "front", at(9), 0.6), event("b", "back", at(19), 0.7)]
    stats = summarize_day("2026-08-09", events, CAMERAS)
    text = template_summary(stats, select_clips(events, CAMERAS))
    assert "2 起活动" in text
    assert "前院" in text or "后门" in text


def test_narrate_falls_back_to_template_when_disabled():
    from watchtower.digest.narrator import narrate

    stats = summarize_day("2026-08-09", [], CAMERAS)
    cfg = DigestSettings(narrate=False)
    assert narrate(stats, [], cfg) == template_summary(stats, [])
