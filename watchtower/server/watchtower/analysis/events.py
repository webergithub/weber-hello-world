"""事件聚合：把逐帧检测结果收敛成"一次有人来过"。

设计要点：

- **开事件要迟疑，关事件要有耐心**。连续 ``open_frames`` 帧命中才开事件（滤掉一帧误检）；
  连续 ``close_seconds`` 秒没人才关事件（避免一个人被树挡两秒就切成两条）。
- 每条事件带一个 0~1 的 ``score``，推送阈值和剪影选段都用它排序 ——
  这是整套系统"少打扰、只推重要的"的关键。
- 纯计算、无 IO，可以直接单测（见 tests/test_events.py）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..config import AnalysisSettings
from .detectors import Detection
from .tracker import Track


@dataclass
class EventDraft:
    camera_id: str
    started_at: float
    ended_at: float
    kind: str = "person"
    score: float = 0.0
    person_count: int = 0
    max_persons: int = 0
    peak_at: float = 0.0            # 画面里人最多/置信度最高的时刻，拿它抽封面
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def duration(self) -> float:
        return max(0.0, self.ended_at - self.started_at)


class _Open:
    def __init__(self, camera_id: str, ts: float) -> None:
        self.camera_id = camera_id
        self.started_at = ts
        self.last_hit = ts
        self.max_score = 0.0
        self.max_persons = 0
        self.max_area = 0.0
        self.peak_at = ts
        self.peak_rank = -1.0
        self.track_ids: set[int] = set()
        self.movements: list[str] = []
        self.labels: set[str] = set()


class EventAggregator:
    """单摄像头一个实例。"""

    def __init__(self, camera_id: str, cfg: AnalysisSettings) -> None:
        self.camera_id = camera_id
        self.cfg = cfg
        self._open: _Open | None = None
        self._pending_hits = 0
        # 连续命中的第一帧时刻。事件要从这里开始，而不是从"确认开事件"的那一帧
        # 开始 —— 否则 open_frames 有几帧，事件前面就丢几帧，恰好丢掉人进画面的过程。
        self._pending_start: float | None = None

    def feed(
        self,
        ts: float,
        detections: list[Detection],
        tracks: list[Track] | None = None,
    ) -> EventDraft | None:
        """喂一帧。返回本帧**结束**的事件（没有则 None）。"""
        persons = [d for d in detections if d.label in self.cfg.person_labels]
        hit = bool(persons) if self.cfg.person_labels else bool(detections)
        subjects = persons or detections

        if hit:
            if self._pending_hits == 0:
                self._pending_start = ts
            self._pending_hits += 1
            if self._open is None and self._pending_hits >= self.cfg.open_frames:
                # 显式判空：起始时刻可能正好是 0（单测/相对时间轴），`or` 会把它吞掉
                start = self._pending_start if self._pending_start is not None else ts
                self._open = _Open(self.camera_id, start)
            if self._open is not None:
                self._accumulate(ts, subjects, tracks or [])
        else:
            self._pending_hits = 0
            self._pending_start = None

        if self._open is None:
            return None

        # 关闭条件：静默够久，或单事件超长（超长就切段，避免整天连成一条）
        idle = ts - self._open.last_hit
        too_long = ts - self._open.started_at >= self.cfg.max_event_seconds
        if idle >= self.cfg.close_seconds or too_long:
            return self._close(self._open.last_hit if idle >= self.cfg.close_seconds else ts)
        return None

    def flush(self, ts: float) -> EventDraft | None:
        """收尾（进程退出/摄像头下线时调用）。"""
        if self._open is None:
            return None
        return self._close(min(ts, self._open.last_hit))

    # ---- 内部 ----

    def _accumulate(self, ts: float, subjects: list[Detection], tracks: list[Track]) -> None:
        state = self._open
        assert state is not None
        state.last_hit = ts
        best = max((d.score for d in subjects), default=0.0)
        area = max((d.area for d in subjects), default=0.0)
        state.max_score = max(state.max_score, best)
        state.max_area = max(state.max_area, area)
        state.max_persons = max(state.max_persons, len(subjects))
        state.labels.update(d.label for d in subjects)

        # 封面挑"人最多 + 置信度最高"的那一帧
        rank = len(subjects) * 10 + best
        if rank > state.peak_rank:
            state.peak_rank = rank
            state.peak_at = ts

        for track in tracks:
            state.track_ids.add(track.id)

    def _close(self, ended_at: float) -> EventDraft:
        state = self._open
        assert state is not None
        self._open = None
        self._pending_hits = 0
        self._pending_start = None

        duration = max(0.0, ended_at - state.started_at)
        draft = EventDraft(
            camera_id=state.camera_id,
            started_at=state.started_at,
            ended_at=ended_at,
            kind="person" if "person" in state.labels else (next(iter(state.labels), "motion")),
            score=score_event(
                confidence=state.max_score,
                duration=duration,
                persons=state.max_persons,
                area=state.max_area,
            ),
            person_count=len(state.track_ids) or state.max_persons,
            max_persons=state.max_persons,
            peak_at=state.peak_at,
            meta={
                "duration": round(duration, 1),
                "labels": sorted(state.labels),
                "max_area": round(state.max_area, 4),
                "movements": state.movements,
            },
        )
        return draft

    def note_movements(self, tracks: list[Track]) -> None:
        """轨迹结束时把"由左向右/驻留/走近"记进当前事件。"""
        if self._open is None:
            return
        for track in tracks:
            move = track.movement()
            if move not in self._open.movements:
                self._open.movements.append(move)


def score_event(*, confidence: float, duration: float, persons: int, area: float) -> float:
    """事件重要度 0~1。

    四个维度加权：置信度、持续时长、人数、目标在画面里的占比
    （占比大 ≈ 离镜头近 ≈ 更值得看）。权重是经验值，可按场景调。
    """
    conf_part = 0.35 * _clamp(confidence)
    time_part = 0.25 * _clamp(duration / 30.0)
    people_part = 0.20 * _clamp(persons / 3.0)
    area_part = 0.20 * _clamp(area / 0.25)
    return round(_clamp(conf_part + time_part + people_part + area_part), 4)


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


__all__ = ["EventDraft", "EventAggregator", "score_event"]
