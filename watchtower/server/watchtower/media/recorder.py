"""常驻分段录制。

为什么要常态录制而不是"检测到人再录"：**事件发生前的几秒才是最有价值的**
（人是从哪来的、怎么进来的）。等检测到人再启动录制，前情已经丢了。
所以这里持续切 10 秒小段，事件结束后再从段里裁出带前摇/后摇的片段。

录制统一从 go2rtc 的 RTSP 出口拉 —— 上游只被拉一次，录制不额外占用云平台并发配额。
"""

from __future__ import annotations

import logging
import subprocess
import threading
import time
from pathlib import Path

from ..config import Settings
from ..db import Database
from ..models import Camera
from . import ffmpeg
from .go2rtc import Go2rtcClient

log = logging.getLogger(__name__)

RESTART_BACKOFF = (2.0, 5.0, 10.0, 30.0, 60.0)


class _Job:
    def __init__(self, camera_id: str, proc: subprocess.Popen, started: float) -> None:
        self.camera_id = camera_id
        self.proc = proc
        self.started = started
        self.failures = 0
        self.next_retry = 0.0


class RecorderPool:
    """每路摄像头一个 ffmpeg 子进程，挂了自动按退避重启。"""

    def __init__(self, db: Database, settings: Settings, segment_seconds: int = 10) -> None:
        self.db = db
        self.settings = settings
        self.segment_seconds = segment_seconds
        self.go2rtc = Go2rtcClient(settings.go2rtc)
        self._jobs: dict[str, _Job] = {}
        self._lock = threading.Lock()

    def camera_dir(self, camera_id: str) -> Path:
        return self.settings.record_dir / camera_id

    # ---- 单路控制 ----

    def start(self, camera: Camera) -> bool:
        if not ffmpeg.available():
            log.warning("未安装 ffmpeg，跳过录制：%s", camera.id)
            return False
        with self._lock:
            job = self._jobs.get(camera.id)
            if job and job.proc.poll() is None:
                return True
            if job and time.time() < job.next_retry:
                return False

        src = self.go2rtc.rtsp_url(camera.stream_name)
        cmd = ffmpeg.record_command(
            src,
            self.camera_dir(camera.id),
            segment_seconds=self.segment_seconds,
            audio=bool(camera.options.get("record_audio", False)),
        )
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        except Exception as exc:
            log.error("启动录制失败 %s：%s", camera.id, exc)
            return False

        with self._lock:
            old = self._jobs.get(camera.id)
            failures = old.failures if old else 0
            new_job = _Job(camera.id, proc, time.time())
            new_job.failures = failures
            self._jobs[camera.id] = new_job
        log.info("开始录制 %s ← %s", camera.id, src)
        return True

    def stop(self, camera_id: str) -> None:
        with self._lock:
            job = self._jobs.pop(camera_id, None)
        if job and job.proc.poll() is None:
            job.proc.terminate()
            try:
                job.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                job.proc.kill()

    def stop_all(self) -> None:
        for camera_id in list(self._jobs):
            self.stop(camera_id)

    # ---- 监督循环 ----

    def supervise_once(self) -> None:
        wanted = {c.id: c for c in self.db.list_cameras(only_enabled=True) if c.record}

        for camera_id in list(self._jobs):
            if camera_id not in wanted:
                self.stop(camera_id)

        for camera_id, camera in wanted.items():
            with self._lock:
                job = self._jobs.get(camera_id)
            if job is None:
                self.start(camera)
                continue
            code = job.proc.poll()
            if code is None:
                continue
            # 进程退了：短命说明上游有问题，按退避重启，别把日志刷爆
            alive = time.time() - job.started
            stderr = (job.proc.stderr.read() or b"").decode("utf-8", "replace")[-300:] \
                if job.proc.stderr else ""
            job.failures = job.failures + 1 if alive < 30 else 0
            delay = RESTART_BACKOFF[min(job.failures, len(RESTART_BACKOFF) - 1)]
            job.next_retry = time.time() + delay
            log.warning("录制进程退出 %s（code=%s, 存活 %.0fs）%s；%.0fs 后重试",
                        camera_id, code, alive, stderr, delay)
            self.start(camera)

    def run(self, stop: threading.Event, interval: float = 5.0) -> None:
        try:
            while not stop.is_set():
                try:
                    self.supervise_once()
                except Exception as exc:
                    log.exception("录制监督循环异常：%s", exc)
                stop.wait(interval)
        finally:
            self.stop_all()

    # ---- 取片段 ----

    def segments(self, camera_id: str) -> list[ffmpeg.Segment]:
        return ffmpeg.list_segments(self.camera_dir(camera_id), segment_seconds=self.segment_seconds)

    def clip(self, camera_id: str, start: float, end: float, out: Path) -> Path | None:
        return ffmpeg.clip_between(self.segments(camera_id), start, end, out)

    # ---- 保留策略（法规要求不少于 30 日，见 docs/04-合规与隐私.md）----

    def purge(self, older_than_days: int) -> int:
        cutoff = time.time() - older_than_days * 86400
        removed = 0
        for camera_dir in self.settings.record_dir.glob("*"):
            if not camera_dir.is_dir():
                continue
            for seg in camera_dir.glob("*.mp4"):
                start = ffmpeg.segment_start(seg)
                if start is not None and start < cutoff:
                    seg.unlink(missing_ok=True)
                    removed += 1
        if removed:
            log.info("清理过期录像分段 %d 个（早于 %d 天）", removed, older_than_days)
        return removed


__all__ = ["RecorderPool"]
