"""HTTP API：远程查看端的唯一入口。

设计取舍：
- **鉴权用一个 bearer token 就够**（家庭/小型园区场景），但公网部署**必须**设，
  否则等于把摄像头挂到公网上 —— 启动时没设会打醒目警告。
- **媒体文件走受控接口**而不是静态目录，防止路径穿越读到库文件。
- **实时消息走 SSE** —— 比轮询省电，比 WebSocket 简单，App 端 EventSource 一行接。
"""

from __future__ import annotations

import asyncio
import logging
import queue
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from ..adapters import discover, list_platforms
from ..analysis.worker import AnalysisPool
from ..bus import BUS, sse_format
from ..config import Settings, load_settings
from ..db import Database
from ..digest.builder import DigestBuilder, today
from ..media.recorder import RecorderPool
from ..media.streams import StreamManager
from ..models import Camera, Subscriber, new_id
from ..push import describe as describe_channels
from ..push.dispatcher import Notifier

log = logging.getLogger(__name__)


class Services:
    """把各层拼起来，并托管后台线程。"""

    def __init__(self, settings: Settings) -> None:
        settings.ensure_dirs()
        self.settings = settings
        self.db = Database(settings.db_path)
        self.streams = StreamManager(self.db, settings)
        self.recorder = RecorderPool(self.db, settings)
        self.notifier = Notifier(self.db, settings)
        self.digest = DigestBuilder(self.db, settings, on_digest=self._on_digest)
        self.analysis = AnalysisPool(
            self.db, settings, self.streams, self.recorder, BUS,
            on_event=self.notifier.on_event,
        )
        self.stop = threading.Event()
        self._threads: list[threading.Thread] = []

    def _on_digest(self, digest) -> None:
        BUS.publish("digest", {"day": digest.day, "summary": digest.summary})
        self.notifier.on_digest(digest)

    def start(self) -> None:
        self.streams.sync_all()
        targets = [
            ("streams-refresh", lambda: self.streams.run_refresh_loop(self.stop)),
            ("recorder", lambda: self.recorder.run(self.stop)),
            ("analysis", lambda: self.analysis.run(self.stop)),
            ("digest", lambda: self.digest.run_daily_loop(self.stop)),
        ]
        for name, fn in targets:
            thread = threading.Thread(target=fn, name=name, daemon=True)
            thread.start()
            self._threads.append(thread)
        log.info("后台任务已启动：%s", ", ".join(n for n, _ in targets))

    def shutdown(self) -> None:
        self.stop.set()
        for thread in self._threads:
            thread.join(timeout=8)


# ---------------------------------------------------------------- 鉴权

def make_auth(settings: Settings):
    def guard(request: Request) -> None:
        expected = settings.api_token
        if not expected:
            return                                  # 未设 token：仅限内网调试
        header = request.headers.get("authorization", "")
        token = header[7:] if header.lower().startswith("bearer ") else request.query_params.get("token", "")
        if token != expected:
            raise HTTPException(status_code=401, detail="无效的访问令牌")
    return guard


# ---------------------------------------------------------------- 请求模型

class CameraIn(BaseModel):
    id: str | None = None
    name: str
    platform: str
    options: dict[str, Any] = Field(default_factory=dict)
    zone: str = ""
    enabled: bool = True
    analyze: bool = True
    record: bool = True


class SubscriberIn(BaseModel):
    channel: str
    target: str
    label: str = ""
    levels: list[str] = Field(default_factory=lambda: ["event", "digest"])


class TestPushIn(BaseModel):
    channel: str
    target: str


# ---------------------------------------------------------------- 应用

def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    services = Services(settings)
    auth = make_auth(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if not settings.api_token:
            log.warning("未设置 api_token —— 任何人都能访问你的摄像头，公网部署务必配置！")
        services.start()
        try:
            yield
        finally:
            services.shutdown()

    app = FastAPI(title="Watchtower", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],       # 查看端是独立域名的 PWA/原生 App
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.services = services

    # ---- 健康与元信息 ----

    @app.get("/api/health")
    def health() -> dict:
        return {
            "ok": True,
            "version": "0.1.0",
            "detector": services.analysis.detector_info.name,
            "cameras": len(services.db.list_cameras()),
            "subscribers": len(services.db.list_subscribers()),
            "sse_clients": BUS.subscriber_count,
            "auth_required": bool(settings.api_token),
        }

    @app.get("/api/platforms", dependencies=[Depends(auth)])
    def platforms() -> list[dict]:
        return list_platforms()

    @app.get("/api/push/channels", dependencies=[Depends(auth)])
    def push_channels() -> list[dict]:
        return describe_channels()

    # ---- 摄像头 ----

    @app.get("/api/cameras", dependencies=[Depends(auth)])
    def list_cameras() -> list[dict]:
        return services.streams.status()

    @app.post("/api/cameras", dependencies=[Depends(auth)])
    def upsert_camera(payload: CameraIn) -> dict:
        camera = Camera(
            id=payload.id or new_id("cam"),
            name=payload.name,
            platform=payload.platform,
            options=payload.options,
            zone=payload.zone,
            enabled=payload.enabled,
            analyze=payload.analyze,
            record=payload.record,
        )
        services.db.upsert_camera(camera)
        source = services.streams.sync(camera, force=True)
        return {
            "id": camera.id,
            "ok": source is not None,
            "protocol": source.protocol if source else "",
            "note": source.note if source else "",
            "error": services.streams.error_of(camera.id),
        }

    @app.delete("/api/cameras/{camera_id}", dependencies=[Depends(auth)])
    def delete_camera(camera_id: str) -> dict:
        camera = services.db.get_camera(camera_id)
        if camera:
            services.streams.remove(camera)
            services.recorder.stop(camera_id)
            services.db.delete_camera(camera_id)
        return {"ok": True}

    @app.get("/api/cameras/{camera_id}/play", dependencies=[Depends(auth)])
    def play(camera_id: str) -> dict:
        camera = _need_camera(services, camera_id)
        source = services.streams.source_of(camera_id)
        return {
            "camera": {"id": camera.id, "name": camera.name, "zone": camera.zone},
            "urls": services.streams.play_urls(camera),
            "protocol": source.protocol if source else "",
            "expires_at": source.expires_at if source else None,
        }

    @app.post("/api/cameras/{camera_id}/sync", dependencies=[Depends(auth)])
    def sync_camera(camera_id: str) -> dict:
        camera = _need_camera(services, camera_id)
        source = services.streams.sync(camera, force=True)
        return {"ok": source is not None, "error": services.streams.error_of(camera_id)}

    @app.get("/api/discover", dependencies=[Depends(auth)])
    def discover_devices(timeout: float = Query(4.0, ge=1.0, le=15.0)) -> list[dict]:
        """局域网 ONVIF 设备发现，用来快速把海康/大华/宇视这类机器加进来。"""
        return discover(timeout=timeout)

    # ---- 事件 ----

    @app.get("/api/events", dependencies=[Depends(auth)])
    def list_events(
        since: float | None = None,
        until: float | None = None,
        camera_id: str | None = None,
        limit: int = Query(100, ge=1, le=1000),
    ) -> list[dict]:
        events = services.db.list_events(
            since=since, until=until, camera_id=camera_id, limit=limit
        )
        cameras = {c.id: c for c in services.db.list_cameras()}
        return [_event_dict(e, cameras.get(e.camera_id)) for e in events]

    @app.get("/api/events/{event_id}", dependencies=[Depends(auth)])
    def get_event(event_id: str) -> dict:
        event = services.db.get_event(event_id)
        if not event:
            raise HTTPException(404, "事件不存在")
        return _event_dict(event, services.db.get_camera(event.camera_id))

    # ---- 一日剪影 ----

    @app.get("/api/digests", dependencies=[Depends(auth)])
    def list_digests(limit: int = Query(30, ge=1, le=180)) -> list[dict]:
        return [_digest_dict(d) for d in services.db.list_digests(limit)]

    @app.get("/api/digests/{day}", dependencies=[Depends(auth)])
    def get_digest(day: str, camera_id: str = "") -> dict:
        digest = services.db.get_digest(day, camera_id)
        if not digest:
            raise HTTPException(404, "该日期还没有剪影，可 POST /api/digests/{day}/build 生成")
        return _digest_dict(digest)

    @app.post("/api/digests/{day}/build", dependencies=[Depends(auth)])
    def build_digest(day: str, camera_id: str = "") -> dict:
        digest = services.digest.build(day or today(), camera_id)
        if not digest:
            raise HTTPException(500, "剪影生成失败，详见服务端日志")
        return _digest_dict(digest)

    # ---- 推送订阅 ----

    @app.get("/api/subscribers", dependencies=[Depends(auth)])
    def list_subscribers() -> list[dict]:
        return [
            {"id": s.id, "channel": s.channel, "label": s.label,
             "levels": list(s.levels), "target": _mask(s.target)}
            for s in services.db.list_subscribers()
        ]

    @app.post("/api/subscribers", dependencies=[Depends(auth)])
    def add_subscriber(payload: SubscriberIn) -> dict:
        sub = Subscriber(
            id=new_id("sub"), channel=payload.channel, target=payload.target,
            label=payload.label, levels=tuple(payload.levels),
        )
        services.db.upsert_subscriber(sub)
        return {"id": sub.id, "ok": True}

    @app.delete("/api/subscribers/{sub_id}", dependencies=[Depends(auth)])
    def delete_subscriber(sub_id: str) -> dict:
        services.db.delete_subscriber(sub_id)
        return {"ok": True}

    @app.post("/api/subscribers/test", dependencies=[Depends(auth)])
    def test_push(payload: TestPushIn) -> dict:
        try:
            services.notifier.test(payload.channel, payload.target)
        except Exception as exc:
            raise HTTPException(400, f"推送失败：{exc}") from exc
        return {"ok": True}

    # ---- 媒体 ----

    @app.get("/api/media")
    def media(path: str, _: None = Depends(auth)) -> FileResponse:
        """受控读取存储目录下的媒体文件（防路径穿越）。"""
        root = settings.storage.path.resolve()
        target = Path(path).resolve()
        if not target.is_file() or root not in target.parents:
            raise HTTPException(404, "文件不存在或不在允许的目录内")
        return FileResponse(target)

    # ---- 实时消息 ----

    @app.get("/api/stream/events")
    async def stream_events(request: Request, _: None = Depends(auth)) -> StreamingResponse:
        q = BUS.subscribe()

        async def gen():
            try:
                yield sse_format({"kind": "hello", "at": time.time(),
                                  "data": {"ok": True}})
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        message = await asyncio.to_thread(q.get, True, 15.0)
                        yield sse_format(message)
                    except queue.Empty:
                        yield ": keepalive\n\n"      # 心跳，防中间设备掐连接
            finally:
                BUS.unsubscribe(q)

        return StreamingResponse(gen(), media_type="text/event-stream", headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        })

    @app.exception_handler(ValueError)
    async def value_error_handler(_: Request, exc: ValueError) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    return app


# ---------------------------------------------------------------- 序列化

def _need_camera(services: Services, camera_id: str) -> Camera:
    camera = services.db.get_camera(camera_id)
    if not camera:
        raise HTTPException(404, "摄像头不存在")
    return camera


def _event_dict(event, camera) -> dict:
    return {
        "id": event.id,
        "camera_id": event.camera_id,
        "camera_name": camera.name if camera else event.meta.get("camera_name", ""),
        "zone": camera.zone if camera else event.meta.get("zone", ""),
        "started_at": event.started_at,
        "ended_at": event.ended_at,
        "duration": round(event.duration, 1),
        "kind": event.kind,
        "score": event.score,
        "person_count": event.person_count,
        "max_persons": event.max_persons,
        "thumb": f"/api/media?path={event.thumb_path}" if event.thumb_path else "",
        "clip": f"/api/media?path={event.clip_path}" if event.clip_path else "",
        "meta": event.meta,
    }


def _digest_dict(digest) -> dict:
    return {
        "id": digest.id,
        "day": digest.day,
        "camera_id": digest.camera_id,
        "summary": digest.summary,
        "video": f"/api/media?path={digest.video_path}" if digest.video_path else "",
        "cover": f"/api/media?path={digest.cover_path}" if digest.cover_path else "",
        "stats": digest.stats,
        "created_at": digest.created_at,
    }


def _mask(target: str) -> str:
    """订阅目标里含密钥，列表接口只回显首尾。"""
    if len(target) <= 8:
        return "****"
    return f"{target[:4]}****{target[-4:]}"


__all__ = ["create_app", "Services"]
