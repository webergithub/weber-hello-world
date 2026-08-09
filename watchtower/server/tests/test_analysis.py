"""分析流水线单测：跟踪器与事件聚合的行为契约。"""

from __future__ import annotations

from watchtower.analysis.detectors import Detection, StubDetector
from watchtower.analysis.events import EventAggregator, score_event
from watchtower.analysis.tracker import IouTracker
from watchtower.config import AnalysisSettings


def person(x1: float, y1: float, x2: float, y2: float, score: float = 0.9) -> Detection:
    return Detection(label="person", score=score, bbox=(x1, y1, x2, y2))


# ---------------------------------------------------------------- 跟踪器

def test_tracker_keeps_id_across_frames():
    tracker = IouTracker()
    active, _ = tracker.update(0.0, [person(0.1, 0.1, 0.3, 0.6)])
    first_id = active[0].id
    active, _ = tracker.update(0.5, [person(0.12, 0.1, 0.32, 0.6)])
    assert active[0].id == first_id
    assert active[0].hits == 2


def test_tracker_assigns_new_id_when_box_jumps_away():
    tracker = IouTracker()
    tracker.update(0.0, [person(0.0, 0.0, 0.2, 0.4)])
    active, _ = tracker.update(0.5, [person(0.7, 0.5, 0.95, 0.95)])
    assert len(active) == 2          # 旧轨迹仍在容忍期内，新目标另起一条


def test_tracker_retires_track_after_max_misses():
    tracker = IouTracker(max_misses=2)
    tracker.update(0.0, [person(0.1, 0.1, 0.3, 0.6)])
    for i in range(1, 5):
        _, finished = tracker.update(float(i), [])
        if finished:
            break
    assert finished, "连续丢失后轨迹应当结束"


def test_movement_reads_as_chinese_phrase():
    # 逐帧小步平移，保证前后帧 IoU 能配上 —— 这才是真实抽帧下的轨迹形态
    tracker = IouTracker()
    active = []
    for i in range(5):
        x = 0.05 + i * 0.08
        active, _ = tracker.update(float(i), [person(x, 0.4, x + 0.2, 0.8)])
    assert active[0].hits == 5
    assert active[0].movement() == "由左向右"


def test_movement_detects_approaching_by_growth():
    tracker = IouTracker()
    boxes = [
        (0.40, 0.40, 0.50, 0.60),
        (0.37, 0.35, 0.55, 0.68),
        (0.32, 0.28, 0.62, 0.78),
        (0.28, 0.22, 0.70, 0.90),
    ]
    active = []
    for i, box in enumerate(boxes):
        active, _ = tracker.update(float(i), [person(*box)])
    assert active[0].movement() == "走近"


def test_movement_of_a_blip_is_not_a_fabricated_direction():
    tracker = IouTracker()
    active, _ = tracker.update(0.0, [person(0.4, 0.4, 0.5, 0.6)])
    # 只出现一帧，说不出方向就不要瞎说
    assert active[0].movement() == "短暂出现"


# ---------------------------------------------------------------- 事件聚合

def cfg(**kw) -> AnalysisSettings:
    base = AnalysisSettings(open_frames=2, close_seconds=5.0, max_event_seconds=60.0)
    for key, value in kw.items():
        setattr(base, key, value)
    return base


def test_single_frame_blip_does_not_open_event():
    agg = EventAggregator("cam1", cfg())
    assert agg.feed(0.0, [person(0.1, 0.1, 0.3, 0.6)]) is None
    assert agg.feed(1.0, []) is None
    assert agg.flush(2.0) is None, "只命中一帧不应产生事件"


def test_event_opens_and_closes_with_expected_shape():
    agg = EventAggregator("cam1", cfg())
    for t in (0.0, 0.5, 1.0, 1.5):
        assert agg.feed(t, [person(0.1, 0.1, 0.3, 0.6)]) is None
    # 静默超过 close_seconds 才收
    assert agg.feed(3.0, []) is None
    draft = agg.feed(8.0, [])
    assert draft is not None
    assert draft.camera_id == "cam1"
    assert draft.started_at == 0.0
    assert draft.ended_at == 1.5           # 以最后一次命中为准，不含静默期
    assert draft.kind == "person"
    assert 0.0 < draft.score <= 1.0


def test_brief_gap_does_not_split_event():
    agg = EventAggregator("cam1", cfg())
    for t in (0.0, 0.5):
        agg.feed(t, [person(0.1, 0.1, 0.3, 0.6)])
    assert agg.feed(3.0, []) is None            # 3 秒空档 < close_seconds
    assert agg.feed(4.0, [person(0.1, 0.1, 0.3, 0.6)]) is None
    draft = agg.feed(12.0, [])
    assert draft is not None and draft.ended_at == 4.0


def test_long_event_is_force_split():
    agg = EventAggregator("cam1", cfg(max_event_seconds=10.0))
    draft = None
    t = 0.0
    while t <= 12.0 and draft is None:
        draft = agg.feed(t, [person(0.1, 0.1, 0.3, 0.6)])
        t += 1.0
    assert draft is not None, "超过 max_event_seconds 必须强制切段"
    assert draft.duration <= 12.0


def test_max_persons_tracked():
    agg = EventAggregator("cam1", cfg())
    agg.feed(0.0, [person(0.1, 0.1, 0.2, 0.5)])
    agg.feed(0.5, [person(0.1, 0.1, 0.2, 0.5), person(0.6, 0.1, 0.7, 0.5)])
    agg.feed(1.0, [person(0.1, 0.1, 0.2, 0.5)])
    draft = agg.flush(1.0)
    assert draft is not None and draft.max_persons == 2


# ---------------------------------------------------------------- 评分

def test_score_is_bounded_and_monotonic():
    low = score_event(confidence=0.4, duration=1, persons=1, area=0.01)
    high = score_event(confidence=0.99, duration=60, persons=4, area=0.4)
    assert 0.0 <= low < high <= 1.0


def test_score_rewards_longer_presence():
    short = score_event(confidence=0.8, duration=2, persons=1, area=0.05)
    long = score_event(confidence=0.8, duration=40, persons=1, area=0.05)
    assert long > short


# ---------------------------------------------------------------- 检测器

def test_stub_detector_replays_script():
    scripted = [[person(0.1, 0.1, 0.2, 0.4)], []]
    detector = StubDetector(scripted)
    assert len(detector.detect(b"")) == 1
    assert detector.detect(b"") == []
    assert detector.detect(b"") == []          # 脚本用完后返回空
