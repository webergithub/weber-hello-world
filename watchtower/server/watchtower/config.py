"""Watchtower 配置。

配置来源优先级：环境变量 > 配置文件(JSON) > 内置默认值。
只用标准库解析，装最少的依赖也能起服务。

配置文件路径由 WATCHTOWER_CONFIG 指定，默认 ./watchtower.json。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, fields, is_dataclass
from pathlib import Path
from typing import Any

DEFAULT_CONFIG_PATH = Path(os.environ.get("WATCHTOWER_CONFIG", "watchtower.json"))


@dataclass
class Go2rtcSettings:
    """归一化出流网关（见 docs/01-平台接入调研.md 第三节）。"""

    base_url: str = "http://127.0.0.1:1984"
    rtsp_host: str = "127.0.0.1"
    rtsp_port: int = 8554
    # 对外暴露给 App 的地址；留空则用 base_url（内网调试用）
    public_base_url: str = ""


@dataclass
class AnalysisSettings:
    """人物分析流水线。"""

    enabled: bool = True
    # yolo | onnx | motion | stub —— 按可用性自动降级，见 analysis/detectors.py
    detector: str = "auto"
    model_path: str = "yolo26n.pt"
    fps: float = 2.0                 # 抽帧频率，监控场景 1~3 帧/秒足够
    min_score: float = 0.35
    person_labels: tuple[str, ...] = ("person",)
    # 事件聚合
    open_frames: int = 2             # 连续命中多少帧才算事件开始（抑制误报）
    close_seconds: float = 8.0       # 连续多少秒无人才算事件结束
    max_event_seconds: float = 300.0 # 单事件上限，超时强制切段
    pre_roll: float = 3.0            # 事件片段往前多取几秒
    post_roll: float = 3.0


@dataclass
class FaceSettings:
    """人脸识别。默认关闭 —— 见 docs/04-合规与隐私.md。"""

    enabled: bool = False
    # 人脸特征只允许落本地库，禁止随推送/剪影出公网
    local_only: bool = True
    match_threshold: float = 0.42


@dataclass
class DigestSettings:
    """一日剪影。"""

    enabled: bool = True
    at: str = "23:30"                # 每日生成时刻（本地时区）
    target_seconds: float = 90.0     # 成片时长目标
    per_clip_seconds: float = 6.0    # 单个事件最多取几秒
    max_clips: int = 24
    orientation: str = "landscape"   # landscape | portrait
    narrate: bool = True             # 是否生成自然语言摘要（需可选依赖 anthropic）
    narrator_model: str = "claude-opus-5"


@dataclass
class PrivacySettings:
    blur_faces: bool = True          # 剪影/缩略图里对人脸打码
    retention_days: int = 30         # 录像与事件保留天数（法规要求不少于 30 日）
    digest_retention_days: int = 180


@dataclass
class PushSettings:
    enabled: bool = True
    quiet_hours: str = "23:00-07:00"     # 免打扰时段，剪影推送不受此限制
    min_score: float = 0.5               # 低于此分不推
    aggregate_window: float = 300.0      # 同一摄像头 N 秒内的事件合并成一条
    daily_digest: bool = True


@dataclass
class StorageSettings:
    root: str = "./data"

    @property
    def path(self) -> Path:
        return Path(self.root).expanduser()


@dataclass
class Settings:
    # 远程查看端鉴权用的 bearer token；公网部署必须设置
    api_token: str = ""
    api_host: str = "0.0.0.0"
    api_port: int = 8900
    timezone: str = "Asia/Shanghai"
    go2rtc: Go2rtcSettings = field(default_factory=Go2rtcSettings)
    analysis: AnalysisSettings = field(default_factory=AnalysisSettings)
    face: FaceSettings = field(default_factory=FaceSettings)
    digest: DigestSettings = field(default_factory=DigestSettings)
    privacy: PrivacySettings = field(default_factory=PrivacySettings)
    push: PushSettings = field(default_factory=PushSettings)
    storage: StorageSettings = field(default_factory=StorageSettings)

    # ---- 派生路径 ----
    @property
    def db_path(self) -> Path:
        return self.storage.path / "watchtower.db"

    @property
    def clips_dir(self) -> Path:
        return self.storage.path / "clips"

    @property
    def record_dir(self) -> Path:
        return self.storage.path / "record"

    @property
    def digest_dir(self) -> Path:
        return self.storage.path / "digest"

    @property
    def thumb_dir(self) -> Path:
        return self.storage.path / "thumb"

    def ensure_dirs(self) -> None:
        for p in (self.storage.path, self.clips_dir, self.record_dir, self.digest_dir, self.thumb_dir):
            p.mkdir(parents=True, exist_ok=True)


def _coerce(target_type: Any, value: Any) -> Any:
    if target_type is bool and isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    if target_type in (int, float) and isinstance(value, str):
        return target_type(value)
    if target_type is tuple or getattr(target_type, "__origin__", None) is tuple:
        if isinstance(value, str):
            return tuple(x.strip() for x in value.split(",") if x.strip())
        return tuple(value)
    return value


def _apply(obj: Any, data: dict[str, Any]) -> None:
    """把 dict 递归套到 dataclass 实例上，忽略未知键。"""
    known = {f.name: f for f in fields(obj)}
    for key, value in data.items():
        f = known.get(key)
        if f is None:
            continue
        current = getattr(obj, f.name)
        if is_dataclass(current) and isinstance(value, dict):
            _apply(current, value)
        else:
            setattr(obj, f.name, _coerce(f.type if not isinstance(f.type, str) else type(current), value))


def _apply_env(obj: Any, prefix: str = "WATCHTOWER") -> None:
    """环境变量覆盖，形如 WATCHTOWER_ANALYSIS_FPS=3、WATCHTOWER_API_TOKEN=xxx。"""
    for f in fields(obj):
        current = getattr(obj, f.name)
        env_key = f"{prefix}_{f.name.upper()}"
        if is_dataclass(current):
            _apply_env(current, env_key)
        elif env_key in os.environ:
            setattr(obj, f.name, _coerce(type(current), os.environ[env_key]))


def load_settings(path: Path | str | None = None) -> Settings:
    settings = Settings()
    cfg_path = Path(path) if path else DEFAULT_CONFIG_PATH
    if cfg_path.exists():
        raw = json.loads(cfg_path.read_text(encoding="utf-8"))
        # cameras 单独存库，不在这里解析
        raw.pop("cameras", None)
        _apply(settings, raw)
    _apply_env(settings)
    return settings


__all__ = [
    "Settings",
    "Go2rtcSettings",
    "AnalysisSettings",
    "FaceSettings",
    "DigestSettings",
    "PrivacySettings",
    "PushSettings",
    "StorageSettings",
    "load_settings",
]
