"""领域模型。刻意保持成纯 dataclass —— 不依赖 ORM，便于单测。"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


@dataclass
class Camera:
    """一路摄像头。

    ``platform`` 决定用哪个适配器；``options`` 是该平台自己的参数
    （序列号、did、账号 UID 等），结构见各 adapter 的 ``required_options``。
    """

    id: str
    name: str
    platform: str
    options: dict[str, Any] = field(default_factory=dict)
    enabled: bool = True
    zone: str = ""                     # 位置标签，如「前院」「仓库门口」
    analyze: bool = True               # 是否纳入分析流水线
    record: bool = True                # 是否常态分段录制（剪影要用）
    created_at: float = field(default_factory=time.time)

    @property
    def stream_name(self) -> str:
        """go2rtc 里的流名，也是各处路径的稳定标识。"""
        return self.id


@dataclass
class Event:
    """一次「有人」的事件。"""

    id: str
    camera_id: str
    started_at: float
    ended_at: float
    kind: str = "person"               # person | motion | face | manual
    score: float = 0.0                 # 0~1，用于推送阈值与剪影选段
    person_count: int = 0              # 事件期间出现过的不同轨迹数
    max_persons: int = 0               # 同一帧内最多几人
    thumb_path: str = ""
    clip_path: str = ""
    meta: dict[str, Any] = field(default_factory=dict)
    notified: bool = False

    @property
    def duration(self) -> float:
        return max(0.0, self.ended_at - self.started_at)


@dataclass
class Digest:
    """一日剪影。"""

    id: str
    day: str                           # YYYY-MM-DD（本地时区）
    camera_id: str = ""                # 空表示全部摄像头合成的总剪影
    video_path: str = ""
    cover_path: str = ""
    summary: str = ""
    stats: dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)


@dataclass
class Subscriber:
    """推送目标。"""

    id: str
    channel: str                       # bark | wecom | dingtalk | telegram | webhook | webpush
    target: str                        # 各通道的地址/key，具体见 push/channels.py
    label: str = ""
    enabled: bool = True
    levels: tuple[str, ...] = ("event", "digest")
    created_at: float = field(default_factory=time.time)


__all__ = ["Camera", "Event", "Digest", "Subscriber", "new_id"]
