"""轻量 IoU 跟踪器（零依赖）。

监控场景抽帧只有 1~3 fps，卡尔曼滤波那套运动模型意义不大，
贪心 IoU 匹配 + 容忍几帧丢失已经够用，而且完全不引入依赖。

需要跨摄像头把同一个人串起来时，再换 BoT-SORT + OSNet ReID
（见 docs/01-平台接入调研.md 第四节），本模块的接口保持不变。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .detectors import Detection, _iou


@dataclass
class Track:
    id: int
    label: str
    first_seen: float
    last_seen: float
    bbox: tuple[float, float, float, float]
    hits: int = 1
    misses: int = 0
    max_score: float = 0.0
    first_area: float = 0.0
    last_area: float = 0.0
    # 轨迹点 (时间, 中心x, 中心y)，用于判断移动方向与驻留
    trail: list[tuple[float, float, float]] = field(default_factory=list)

    @property
    def duration(self) -> float:
        return max(0.0, self.last_seen - self.first_seen)

    @property
    def displacement(self) -> tuple[float, float]:
        if len(self.trail) < 2:
            return (0.0, 0.0)
        return (self.trail[-1][1] - self.trail[0][1], self.trail[-1][2] - self.trail[0][2])

    def movement(self) -> str:
        """把轨迹翻译成人话，给剪影文案用。"""
        dx, dy = self.displacement
        distance = (dx * dx + dy * dy) ** 0.5
        growth = (self.last_area / self.first_area) if self.first_area > 0 else 1.0

        # 只出现一两帧、几乎没动的轨迹说不出方向，别硬编一个出来
        if len(self.trail) < 2 or (distance < 0.02 and abs(growth - 1.0) < 0.15):
            return "驻留" if self.duration >= 8 else "短暂出现"
        if distance < 0.06 and self.duration >= 8:
            return "驻留"
        if growth >= 1.6:
            return "走近"
        if growth <= 0.62:
            return "远离"
        if abs(dx) >= abs(dy):
            return "由左向右" if dx > 0 else "由右向左"
        return "向下移动" if dy > 0 else "向上移动"


class IouTracker:
    def __init__(self, iou_threshold: float = 0.3, max_misses: int = 4, min_hits: int = 1) -> None:
        self.iou_threshold = iou_threshold
        self.max_misses = max_misses
        self.min_hits = min_hits
        self._next_id = 1
        self.tracks: list[Track] = []

    def update(self, ts: float, detections: list[Detection]) -> tuple[list[Track], list[Track]]:
        """喂一帧，返回 (当前活跃轨迹, 本帧结束的轨迹)。"""
        unmatched = list(range(len(detections)))
        pairs: list[tuple[float, int, Track]] = []

        for track in self.tracks:
            for i in unmatched:
                score = _iou(track.bbox, detections[i].bbox)
                if score >= self.iou_threshold:
                    pairs.append((score, i, track))
        # 贪心：IoU 高的先配对
        pairs.sort(key=lambda p: p[0], reverse=True)

        used_tracks: set[int] = set()
        used_dets: set[int] = set()
        for score, det_idx, track in pairs:
            if track.id in used_tracks or det_idx in used_dets:
                continue
            self._absorb(track, ts, detections[det_idx])
            used_tracks.add(track.id)
            used_dets.add(det_idx)

        for i, det in enumerate(detections):
            if i not in used_dets:
                self.tracks.append(self._new_track(ts, det))

        finished: list[Track] = []
        alive: list[Track] = []
        for track in self.tracks:
            if track.id in used_tracks or track.last_seen == ts:
                track.misses = 0
                alive.append(track)
                continue
            track.misses += 1
            (alive if track.misses <= self.max_misses else finished).append(track)
        self.tracks = alive
        return [t for t in alive if t.hits >= self.min_hits], finished

    def flush(self) -> list[Track]:
        finished, self.tracks = self.tracks, []
        return finished

    # ---- 内部 ----

    def _new_track(self, ts: float, det: Detection) -> Track:
        cx, cy = det.center
        track = Track(
            id=self._next_id, label=det.label, first_seen=ts, last_seen=ts,
            bbox=det.bbox, max_score=det.score,
            first_area=det.area, last_area=det.area, trail=[(ts, cx, cy)],
        )
        self._next_id += 1
        return track

    @staticmethod
    def _absorb(track: Track, ts: float, det: Detection) -> None:
        cx, cy = det.center
        track.bbox = det.bbox
        track.last_seen = ts
        track.hits += 1
        track.misses = 0
        track.max_score = max(track.max_score, det.score)
        track.last_area = det.area
        track.trail.append((ts, cx, cy))
        if len(track.trail) > 240:          # 轨迹只留最近一段，防止长时间驻留吃内存
            del track.trail[:-240]


__all__ = ["Track", "IouTracker"]
