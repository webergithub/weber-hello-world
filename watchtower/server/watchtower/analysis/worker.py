"""每路摄像头一个分析线程。

一帧的旅程：

    go2rtc frame.jpeg  →  检测器  →  IoU 跟踪  →  事件聚合
                                                    ↓ 事件结束
                            从分段录像裁片 + 抽封面(可打码) → 落库 → 总线/推送

抽帧频率默认 2 fps —— 监控场景再高也换不来多少信息量，只会烧 CPU。
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Callable

from ..bus import EventBus
from ..config import Settings
from ..db import Database
from ..media.recorder import RecorderPool
from ..media.streams import StreamManager
from ..models import Camera, Event, new_id
from .detectors import Detector, build_detector
from .events import EventAggregator, EventDraft
from .privacy import blur_faces_jpeg
from .tracker import IouTracker

log = logging.getLogger(__name__)

FRAME_CACHE = 30          # 缓存最近 N 帧，事件结束后回头挑封面
MAX_CONSEC_ERRORS = 20


class AnalysisWorker(threading.Thread):
    def __init__(
        self,
        camera: Camera,
        db: Database,
        settings: Settings,
        streams: StreamManager,
        recorder: RecorderPool | None,
        bus: EventBus,
        detector: Detector,
        on_event: Callable[[Event, Camera], None] | None = None,
    ) -> None:
        super().__init__(name=f"analysis-{camera.id}", daemon=True)
        self.camera = camera
        self.db = db
        self.settings = settings
        self.streams = streams
        self.recorder = recorder
        self.bus = bus
        self.detector = detector
        self.on_event = on_event
        self.stop_event = threading.Event()

        self.tracker = IouTracker()
        self.aggregator = EventAggregator(camera.id, settings.analysis)
        self._frames: list[tuple[float, bytes]] = []
        self._errors = 0

    # ---- 主循环 ----

    def run(self) -> None:
        cfg = self.settings.analysis
        interval = 1.0 / max(0.2, cfg.fps)
        log.info("分析线程启动 %s（%s，%.1f fps）", self.camera.id, self.detector.name, cfg.fps)

        while not self.stop_event.is_set():
            started = time.time()
            try:
                self._tick(started)
                self._errors = 0
            except Exception as exc:
                self._errors += 1
                level = log.warning if self._errors < 3 else log.debug
                level("分析 %s 出错(%d)：%s", self.camera.id, self._errors, exc)
                if self._errors >= MAX_CONSEC_ERRORS:
                    # 连续失败多半是流断了，让流管理器重新解析一次地址
                    log.error("分析 %s 连续失败 %d 次，触发流重解析", self.camera.id, self._errors)
                    self.streams.sync(self.camera, force=True)
                    self._errors = 0
                    self.stop_event.wait(5.0)

            elapsed = time.time() - started
            self.stop_event.wait(max(0.05, interval - elapsed))

        draft = self.aggregator.flush(time.time())
        if draft:
            self._finalize(draft)
        log.info("分析线程退出 %s", self.camera.id)

    def _tick(self, ts: float) -> None:
        jpeg = self.streams.go2rtc.frame(self.camera.stream_name)
        if not jpeg:
            return
        self._frames.append((ts, jpeg))
        if len(self._frames) > FRAME_CACHE:
            del self._frames[:-FRAME_CACHE]

        detections = self.detector.detect(jpeg)
        active, finished = self.tracker.update(ts, detections)
        if finished:
            self.aggregator.note_movements(finished)
        draft = self.aggregator.feed(ts, detections, active)
        if draft:
            self._finalize(draft)

    # ---- 事件收尾 ----

    def _finalize(self, draft: EventDraft) -> None:
        cfg = self.settings.analysis
        event = Event(
            id=new_id("evt"),
            camera_id=draft.camera_id,
            started_at=draft.started_at,
            ended_at=draft.ended_at,
            kind=draft.kind,
            score=draft.score,
            person_count=draft.person_count,
            max_persons=draft.max_persons,
            meta=dict(draft.meta, camera_name=self.camera.name, zone=self.camera.zone),
        )

        thumb = self._save_thumbnail(event, draft.peak_at)
        if thumb:
            event.thumb_path = str(thumb)

        if self.recorder:
            clip_path = self.settings.clips_dir / self.camera.id / f"{event.id}.mp4"
            try:
                made = self.recorder.clip(
                    self.camera.id,
                    draft.started_at - cfg.pre_roll,
                    draft.ended_at + cfg.post_roll,
                    clip_path,
                )
                if made:
                    event.clip_path = str(made)
            except Exception as exc:
                log.warning("裁剪事件片段失败 %s：%s", event.id, exc)

        self.db.add_event(event)
        log.info("事件 %s 摄像头=%s 时长=%.1fs 人数=%d 分数=%.2f",
                 event.id, self.camera.id, event.duration, event.max_persons, event.score)

        self.bus.publish("event", _event_payload(event, self.camera))
        if self.on_event:
            try:
                self.on_event(event, self.camera)
            except Exception as exc:
                log.warning("事件回调失败 %s：%s", event.id, exc)

    def _save_thumbnail(self, event: Event, peak_at: float):
        frame = self._nearest_frame(peak_at)
        if frame is None:
            return None
        if self.settings.privacy.blur_faces:
            frame, count = blur_faces_jpeg(frame)
            event.meta["faces_blurred"] = count
        path = self.settings.thumb_dir / self.camera.id / f"{event.id}.jpg"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(frame)
        return path

    def _nearest_frame(self, ts: float) -> bytes | None:
        if not self._frames:
            return None
        return min(self._frames, key=lambda item: abs(item[0] - ts))[1]

    def shutdown(self) -> None:
        self.stop_event.set()


def _event_payload(event: Event, camera: Camera) -> dict:
    return {
        "id": event.id,
        "camera_id": event.camera_id,
        "camera_name": camera.name,
        "zone": camera.zone,
        "started_at": event.started_at,
        "ended_at": event.ended_at,
        "duration": round(event.duration, 1),
        "kind": event.kind,
        "score": event.score,
        "person_count": event.person_count,
        "max_persons": event.max_persons,
        "has_clip": bool(event.clip_path),
        "meta": event.meta,
    }


class AnalysisPool:
    """按数据库里的摄像头清单起停分析线程。"""

    def __init__(
        self,
        db: Database,
        settings: Settings,
        streams: StreamManager,
        recorder: RecorderPool | None,
        bus: EventBus,
        on_event: Callable[[Event, Camera], None] | None = None,
    ) -> None:
        self.db = db
        self.settings = settings
        self.streams = streams
        self.recorder = recorder
        self.bus = bus
        self.on_event = on_event
        self.detector, self.detector_info = build_detector(settings.analysis)
        self._workers: dict[str, AnalysisWorker] = {}
        log.info("检测器：%s%s", self.detector_info.name,
                 f"（降级自：{self.detector_info.fallbacks}）" if self.detector_info.fallbacks else "")

    def sync_once(self) -> None:
        wanted = {c.id: c for c in self.db.list_cameras(only_enabled=True) if c.analyze}
        for camera_id, worker in list(self._workers.items()):
            if camera_id not in wanted or not worker.is_alive():
                worker.shutdown()
                self._workers.pop(camera_id, None)
        for camera_id, camera in wanted.items():
            if camera_id in self._workers:
                continue
            worker = AnalysisWorker(
                camera, self.db, self.settings, self.streams,
                self.recorder, self.bus, self.detector, self.on_event,
            )
            worker.start()
            self._workers[camera_id] = worker

    def run(self, stop: threading.Event, interval: float = 10.0) -> None:
        if not self.settings.analysis.enabled:
            log.info("分析已关闭（analysis.enabled=false）")
            return
        try:
            while not stop.is_set():
                try:
                    self.sync_once()
                except Exception as exc:
                    log.exception("分析池同步异常：%s", exc)
                stop.wait(interval)
        finally:
            self.shutdown()

    def shutdown(self) -> None:
        for worker in self._workers.values():
            worker.shutdown()
        for worker in self._workers.values():
            worker.join(timeout=5)
        self._workers.clear()
        self.detector.close()


__all__ = ["AnalysisWorker", "AnalysisPool"]
