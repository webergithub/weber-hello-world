"""适配器注册表。

新增一个平台的完整步骤：
1. 写一个 :class:`CameraAdapter` 子类，实现 ``resolve()``；
2. 在 :data:`REGISTRY` 里登记。

上层（归一化、分析、剪影、推送、API）一行都不用改。
"""

from __future__ import annotations

from ..models import Camera
from .base import (
    AdapterError,
    CameraAdapter,
    MemoryStore,
    NotConfigured,
    StreamSource,
    TokenStore,
)
from .ezviz import EzvizAdapter
from .generic import GenericAdapter
from .imou import ImouAdapter
from .onvif_rtsp import OnvifRtspAdapter, discover
from .qihoo360 import Qihoo360Adapter
from .tuya import TuyaAdapter
from .xiaomi import XiaomiAdapter

REGISTRY: dict[str, type[CameraAdapter]] = {
    "xiaomi": XiaomiAdapter,
    "qihoo360": Qihoo360Adapter,
    "ezviz": EzvizAdapter,
    "imou": ImouAdapter,
    "tuya": TuyaAdapter,
    "onvif": OnvifRtspAdapter,
    "generic": GenericAdapter,
}

# 常见别名，让配置写起来顺手
ALIASES = {
    "mijia": "xiaomi",
    "米家": "xiaomi",
    "小米": "xiaomi",
    "360": "qihoo360",
    "qihu": "qihoo360",
    "ys7": "ezviz",
    "萤石": "ezviz",
    "hikvision-consumer": "ezviz",
    "lechange": "imou",
    "乐橙": "imou",
    "涂鸦": "tuya",
    "rtsp": "generic",
    "hikvision": "onvif",
    "dahua": "onvif",
    "uniview": "onvif",
    "vigi": "onvif",
}


def normalize_platform(platform: str) -> str:
    key = (platform or "").strip().lower()
    return ALIASES.get(key, key)


def get_adapter(camera: Camera, store: TokenStore | None = None) -> CameraAdapter:
    key = normalize_platform(camera.platform)
    cls = REGISTRY.get(key)
    if cls is None:
        raise NotConfigured(
            f"未知平台 {camera.platform!r}；已支持：{', '.join(sorted(REGISTRY))}"
            f"（别名：{', '.join(sorted(ALIASES))}）"
        )
    return cls(camera, store)


def list_platforms() -> list[dict]:
    """给前端「新增摄像头」页用的平台清单（含各平台必填项与说明）。"""
    out = []
    for key, cls in REGISTRY.items():
        probe = cls(Camera(id="_probe", name="_probe", platform=key))
        out.append(probe.capabilities())
    return out


__all__ = [
    "REGISTRY",
    "ALIASES",
    "AdapterError",
    "CameraAdapter",
    "MemoryStore",
    "NotConfigured",
    "StreamSource",
    "TokenStore",
    "get_adapter",
    "list_platforms",
    "normalize_platform",
    "discover",
]
