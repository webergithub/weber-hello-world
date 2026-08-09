"""分析层：抽帧 → 检测 → 跟踪 → 事件。"""

from .detectors import Detection, Detector, build_detector
from .events import EventAggregator, EventDraft, score_event
from .privacy import blur_faces_jpeg
from .tracker import IouTracker, Track
from .worker import AnalysisPool, AnalysisWorker

__all__ = [
    "Detection", "Detector", "build_detector",
    "EventAggregator", "EventDraft", "score_event",
    "IouTracker", "Track",
    "AnalysisPool", "AnalysisWorker",
    "blur_faces_jpeg",
]
