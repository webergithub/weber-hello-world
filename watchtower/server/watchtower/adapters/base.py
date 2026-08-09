"""平台适配器抽象。

一条铁律：**适配器只负责回答「这一路摄像头现在能播的 URL 是什么」**。
拿到 URL 之后的事（归一化、录制、分析、剪影、推送）全部由上层统一处理，
所以新增一个平台永远只需要新写一个 ``resolve()``，上层一行不用改。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Protocol

from ..models import Camera


class AdapterError(RuntimeError):
    """平台返回了错误码，或响应结构不符合预期。"""


class NotConfigured(AdapterError):
    """必填参数缺失 —— 属于配置问题，不该重试。"""


@dataclass
class StreamSource:
    """一条可播放的流。

    ``url`` 直接喂给 go2rtc；除了标准的 rtsp/rtmp/hls，也可以是 go2rtc 自己的
    私有协议源（如 ``xiaomi://``、``tapo://``），归一层认得。
    """

    url: str
    protocol: str = "rtsp"          # rtsp | rtmp | hls | flv | ezopen | go2rtc | publish
    expires_at: float | None = None  # 云平台地址普遍是短效的
    audio: bool = True
    note: str = ""
    meta: dict[str, Any] = field(default_factory=dict)

    def is_expired(self, skew: float = 30.0) -> bool:
        """留 skew 秒余量提前判过期 —— 别等到播放器报错才去续。"""
        return self.expires_at is not None and self.expires_at - skew <= time.time()

    @property
    def playable_by_ffmpeg(self) -> bool:
        """ezopen 是萤石私有协议，只能用萤石播放器，服务端解不了。"""
        return self.protocol not in ("ezopen", "publish")


class TokenStore(Protocol):
    """凭证缓存。``Database`` 天然满足这个协议。"""

    def kv_get(self, key: str) -> Any | None: ...
    def kv_set(self, key: str, value: Any, ttl: float = 0) -> None: ...


class MemoryStore:
    """无库运行时的兜底（单测、CLI 探活）。"""

    def __init__(self) -> None:
        self._d: dict[str, tuple[Any, float]] = {}

    def kv_get(self, key: str) -> Any | None:
        item = self._d.get(key)
        if not item:
            return None
        value, expires = item
        if expires and expires < time.time():
            self._d.pop(key, None)
            return None
        return value

    def kv_set(self, key: str, value: Any, ttl: float = 0) -> None:
        self._d[key] = (value, time.time() + ttl if ttl else 0)


class CameraAdapter:
    platform: str = ""
    display_name: str = ""
    doc_url: str = ""
    required_options: tuple[str, ...] = ()
    # 该平台能不能被服务端直接拉流做分析（360 这类只能客户端 SDK 出流的为 False）
    server_pullable: bool = True

    def __init__(self, camera: Camera, store: TokenStore | None = None) -> None:
        self.camera = camera
        self.store = store or MemoryStore()

    # ---- 参数读取 ----

    def opt(self, name: str, default: Any = None, *, required: bool = False) -> Any:
        value = self.camera.options.get(name, default)
        if required and (value is None or value == ""):
            raise NotConfigured(
                f"[{self.platform}] 摄像头 {self.camera.id} 缺少必填参数 {name!r}；"
                f"该平台必填项：{', '.join(self.required_options) or '无'}"
                + (f"；文档：{self.doc_url}" if self.doc_url else "")
            )
        return value

    def check_options(self) -> None:
        for name in self.required_options:
            self.opt(name, required=True)

    # ---- 子类实现 ----

    def resolve(self) -> StreamSource:
        raise NotImplementedError

    def release(self) -> None:
        """释放平台侧资源（如乐橙的直播通道配额）。默认无操作。"""

    def capabilities(self) -> dict[str, Any]:
        return {
            "platform": self.platform,
            "display_name": self.display_name or self.platform,
            "server_pullable": self.server_pullable,
            "required_options": list(self.required_options),
            "doc_url": self.doc_url,
        }


__all__ = [
    "AdapterError",
    "NotConfigured",
    "StreamSource",
    "TokenStore",
    "MemoryStore",
    "CameraAdapter",
]
