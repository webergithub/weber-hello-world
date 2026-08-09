"""一日剪影选段。

难点不是"把片段拼起来"，而是**从几百条事件里挑出值得看的十几条**。
三条规则：

1. **按重要度排序**（``Event.score``，见 analysis/events.py）；
2. **摄像头配额**：一路门口摄像头一天能触发两百次，不能让它吃掉整个剪影；
3. **时间去重**：同一摄像头同一时间窗内只取最高分的一条，避免同一个人来回走被剪十遍。

纯函数、无 IO，可直接单测（tests/test_digest_selector.py）。
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable

from ..models import Camera, Event


@dataclass
class Clip:
    """剪影里的一段。"""

    event_id: str
    camera_id: str
    camera_name: str
    source: str                 # 事件片段文件路径
    started_at: float
    seconds: float
    score: float
    caption: str = ""


def select_clips(
    events: Iterable[Event],
    cameras: dict[str, Camera] | None = None,
    *,
    target_seconds: float = 90.0,
    per_clip_seconds: float = 6.0,
    max_clips: int = 24,
    min_score: float = 0.0,
    dedup_window: float = 300.0,
) -> list[Clip]:
    """挑出成片用的片段，按时间顺序返回。"""
    cameras = cameras or {}
    pool = [e for e in events if e.clip_path and e.score >= min_score]
    if not pool:
        return []

    camera_ids = {e.camera_id for e in pool}
    # 每路摄像头的配额：均分再放宽 60%，既保证雨露均沾又不至于卡死热点摄像头
    quota = max(1, math.ceil(max_clips / max(1, len(camera_ids)) * 1.6))

    ranked = sorted(pool, key=lambda e: (-e.score, e.started_at))
    used_quota: Counter[str] = Counter()
    used_windows: set[tuple[str, int]] = set()
    chosen: list[Clip] = []
    total = 0.0

    for event in ranked:
        if len(chosen) >= max_clips or total >= target_seconds:
            break
        if used_quota[event.camera_id] >= quota:
            continue
        window = (event.camera_id, int(event.started_at // dedup_window))
        if window in used_windows:
            continue

        seconds = min(per_clip_seconds, max(2.0, event.duration))
        camera = cameras.get(event.camera_id)
        chosen.append(Clip(
            event_id=event.id,
            camera_id=event.camera_id,
            camera_name=(camera.name if camera else event.meta.get("camera_name") or event.camera_id),
            source=event.clip_path,
            started_at=event.started_at,
            seconds=seconds,
            score=event.score,
            caption=_caption(event, camera),
        ))
        used_quota[event.camera_id] += 1
        used_windows.add(window)
        total += seconds

    chosen.sort(key=lambda c: c.started_at)
    return chosen


def _caption(event: Event, camera: Camera | None) -> str:
    when = datetime.fromtimestamp(event.started_at).strftime("%H:%M")
    where = (camera.zone or camera.name) if camera else (event.meta.get("zone") or event.camera_id)
    who = f"{event.max_persons}人" if event.max_persons > 1 else "有人"
    moves = event.meta.get("movements") or []
    tail = f"·{moves[0]}" if moves else ""
    return f"{when} {where} {who}{tail}"


@dataclass
class DayStats:
    """一天的统计画像，既进剪影文案也进推送卡片。"""

    day: str
    total_events: int = 0
    total_persons: int = 0
    peak_persons: int = 0
    busiest_hour: int | None = None
    busiest_camera: str = ""
    first_at: float | None = None
    last_at: float | None = None
    by_camera: dict[str, int] = field(default_factory=dict)
    by_hour: dict[int, int] = field(default_factory=dict)
    quiet_hours: list[int] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "day": self.day,
            "total_events": self.total_events,
            "total_persons": self.total_persons,
            "peak_persons": self.peak_persons,
            "busiest_hour": self.busiest_hour,
            "busiest_camera": self.busiest_camera,
            "first_at": self.first_at,
            "last_at": self.last_at,
            "by_camera": self.by_camera,
            "by_hour": self.by_hour,
            "quiet_hours": self.quiet_hours,
        }


def summarize_day(day: str, events: Iterable[Event], cameras: dict[str, Camera] | None = None) -> DayStats:
    cameras = cameras or {}
    items = list(events)
    stats = DayStats(day=day, total_events=len(items))
    if not items:
        stats.quiet_hours = list(range(24))
        return stats

    by_camera: Counter[str] = Counter()
    by_hour: defaultdict[int, int] = defaultdict(int)
    for event in items:
        camera = cameras.get(event.camera_id)
        label = camera.name if camera else event.camera_id
        by_camera[label] += 1
        by_hour[datetime.fromtimestamp(event.started_at).hour] += 1
        stats.total_persons += max(1, event.person_count)
        stats.peak_persons = max(stats.peak_persons, event.max_persons)

    stats.by_camera = dict(by_camera)
    stats.by_hour = dict(sorted(by_hour.items()))
    stats.busiest_camera = by_camera.most_common(1)[0][0]
    stats.busiest_hour = max(by_hour.items(), key=lambda kv: kv[1])[0]
    stats.first_at = min(e.started_at for e in items)
    stats.last_at = max(e.ended_at for e in items)
    stats.quiet_hours = [h for h in range(24) if by_hour.get(h, 0) == 0]
    return stats


__all__ = ["Clip", "DayStats", "select_clips", "summarize_day"]
