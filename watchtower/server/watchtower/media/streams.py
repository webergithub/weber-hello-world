"""流编排：适配器 → go2rtc。

负责三件事：
1. 调适配器把摄像头解析成一条可播 URL；
2. 把 URL 注册进 go2rtc（``publish`` 模式的除外——那种是别人往里推）；
3. **盯着短效地址**：涂鸦几分钟、萤石按 expireTime，到点自动重取并热更新 go2rtc。

第 3 点是多平台聚合里最容易翻车的地方：地址写死进配置，第二天全黑屏。
"""

from __future__ import annotations

import logging
import threading
import time

from ..adapters import AdapterError, StreamSource, get_adapter
from ..config import Settings
from ..db import Database
from ..models import Camera
from .go2rtc import Go2rtcClient

log = logging.getLogger(__name__)


class StreamManager:
    def __init__(self, db: Database, settings: Settings) -> None:
        self.db = db
        self.settings = settings
        self.go2rtc = Go2rtcClient(settings.go2rtc)
        self._sources: dict[str, StreamSource] = {}
        self._errors: dict[str, str] = {}
        self._lock = threading.Lock()

    # ---- 解析 ----

    def resolve(self, camera: Camera, *, force: bool = False) -> StreamSource:
        with self._lock:
            cached = self._sources.get(camera.id)
            if cached and not force and not cached.is_expired():
                return cached
        adapter = get_adapter(camera, self.db)
        adapter.check_options()
        source = adapter.resolve()
        with self._lock:
            self._sources[camera.id] = source
            self._errors.pop(camera.id, None)
        return source

    def source_of(self, camera_id: str) -> StreamSource | None:
        with self._lock:
            return self._sources.get(camera_id)

    def error_of(self, camera_id: str) -> str:
        with self._lock:
            return self._errors.get(camera_id, "")

    # ---- 注册进 go2rtc ----

    def sync(self, camera: Camera, *, force: bool = False) -> StreamSource | None:
        if not camera.enabled:
            self.remove(camera)
            return None
        try:
            source = self.resolve(camera, force=force)
        except Exception as exc:  # 含 AdapterError；单路失败不能拖垮整体
            with self._lock:
                self._errors[camera.id] = str(exc)
            log.error("摄像头 %s(%s) 解析失败：%s", camera.id, camera.platform, exc)
            return None

        if source.protocol == "publish":
            # 360 端侧转推这类：流由外部 ANNOUNCE 进来，我们不主动拉
            log.info("摄像头 %s 为推流模式，等待外部推流到 %s", camera.id, source.url)
            return source

        try:
            self.go2rtc.add_stream(camera.stream_name, source.url)
        except Exception as exc:
            with self._lock:
                self._errors[camera.id] = f"注册 go2rtc 失败：{exc}"
            log.error("摄像头 %s 注册 go2rtc 失败：%s", camera.id, exc)
            return None
        return source

    def sync_all(self, *, force: bool = False) -> dict[str, StreamSource]:
        out: dict[str, StreamSource] = {}
        for cam in self.db.list_cameras(only_enabled=True):
            src = self.sync(cam, force=force)
            if src:
                out[cam.id] = src
        return out

    def remove(self, camera: Camera) -> None:
        self.go2rtc.delete_stream(camera.stream_name)
        with self._lock:
            self._sources.pop(camera.id, None)
        try:
            get_adapter(camera, self.db).release()   # 例如乐橙释放直播通道配额
        except Exception:
            pass

    # ---- 短效地址续期 ----

    def refresh_expiring(self) -> list[str]:
        """把快过期的地址重新取一遍。由后台循环定期调用。"""
        refreshed: list[str] = []
        for cam in self.db.list_cameras(only_enabled=True):
            src = self.source_of(cam.id)
            # 从没成功过的也在这里重试，等于自带故障自愈
            if src is None or src.is_expired(skew=60):
                if self.sync(cam, force=True):
                    refreshed.append(cam.id)
        if refreshed:
            log.info("已续期 %d 路短效地址：%s", len(refreshed), ", ".join(refreshed))
        return refreshed

    def run_refresh_loop(self, stop: threading.Event, interval: float = 30.0) -> None:
        while not stop.is_set():
            try:
                self.refresh_expiring()
            except Exception as exc:
                log.exception("地址续期循环异常：%s", exc)
            stop.wait(interval)

    # ---- 对外地址 ----

    def play_urls(self, camera: Camera) -> dict[str, str]:
        return self.go2rtc.play_urls(camera.stream_name)

    def status(self) -> list[dict]:
        out = []
        live = self.go2rtc.list_streams()
        for cam in self.db.list_cameras():
            src = self.source_of(cam.id)
            out.append({
                "id": cam.id,
                "name": cam.name,
                "platform": cam.platform,
                "zone": cam.zone,
                "enabled": cam.enabled,
                "online": cam.stream_name in live,
                "protocol": src.protocol if src else "",
                "expires_in": round(src.expires_at - time.time(), 1)
                              if src and src.expires_at else None,
                "note": src.note if src else "",
                "error": self.error_of(cam.id),
            })
        return out


__all__ = ["StreamManager"]
