"""go2rtc 归一化层。

作用：把各平台千奇百怪的流（rtsp / rtmp / hls / xiaomi:// / tapo:// …）
统一成**一路上游、多路下游**——

    上游拉一次  →  go2rtc  →  ┌ WebRTC  给 App 低延迟看
                              ├ fMP4     给浏览器 <video> 直接播
                              ├ HLS      给 iOS Safari 兜底
                              ├ JPEG     给分析流水线抽帧
                              └ RTSP     给 ffmpeg 录制

这样摄像头只被拉一次，直播/录制/分析共用，既省带宽也省云平台的并发配额
（萤石、乐橙的并发路数是要钱的）。
"""

from __future__ import annotations

import logging
import urllib.parse
from typing import Any

from .. import http
from ..config import Go2rtcSettings

log = logging.getLogger(__name__)


class Go2rtcClient:
    def __init__(self, settings: Go2rtcSettings) -> None:
        self.settings = settings
        self.base = settings.base_url.rstrip("/")

    @property
    def public_base(self) -> str:
        return (self.settings.public_base_url or self.settings.base_url).rstrip("/")

    # ---- 流管理 ----

    def list_streams(self) -> dict[str, Any]:
        try:
            data = http.get_json(f"{self.base}/api/streams")
            return data if isinstance(data, dict) else {}
        except Exception as exc:
            log.warning("go2rtc 列流失败：%s", exc)
            return {}

    def add_stream(self, name: str, src: str) -> None:
        query = urllib.parse.urlencode({"name": name, "src": src})
        http.request(f"{self.base}/api/streams?{query}", method="PUT")
        log.info("go2rtc 已注册流 %s", name)

    def delete_stream(self, name: str) -> None:
        query = urllib.parse.urlencode({"src": name})
        try:
            http.request(f"{self.base}/api/streams?{query}", method="DELETE")
        except Exception as exc:
            log.warning("go2rtc 删流 %s 失败：%s", name, exc)

    def has_stream(self, name: str) -> bool:
        return name in self.list_streams()

    # ---- 取帧（分析与缩略图都用它）----

    def frame(self, name: str, timeout: float = 8.0) -> bytes:
        query = urllib.parse.urlencode({"src": name})
        return http.get_bytes(f"{self.base}/api/frame.jpeg?{query}", timeout=timeout)

    # ---- 播放地址 ----

    def rtsp_url(self, name: str) -> str:
        s = self.settings
        return f"rtsp://{s.rtsp_host}:{s.rtsp_port}/{name}"

    def play_urls(self, name: str) -> dict[str, str]:
        """给远程查看端用的一组地址，客户端按能力挑一个。"""
        q = urllib.parse.urlencode({"src": name})
        base = self.public_base
        return {
            # 最低延迟（约 0.5s），优先用
            "webrtc": f"{base}/api/webrtc?{q}",
            # fMP4：<video> 直接 src 就能播，兼容性最好
            "mp4": f"{base}/api/stream.mp4?{q}",
            # iOS Safari / 弱网兜底
            "hls": f"{base}/api/stream.m3u8?{q}",
            # 最后的兜底：轮询单帧
            "snapshot": f"{base}/api/frame.jpeg?{q}",
            "mjpeg": f"{base}/api/stream.mjpeg?{q}",
            "rtsp": self.rtsp_url(name),
        }


def render_config(streams: dict[str, str], settings: Go2rtcSettings, *, extra: str = "") -> str:
    """生成 go2rtc.yaml 引导配置。

    运行期我们走 REST 动态加流，这份文件只用于**冷启动**：go2rtc 先起来、
    流已经在，watchtower 还没连上时也能看直播。
    """
    lines = [
        "# 由 watchtower 生成，请勿手工编辑（改动会在下次 sync 时被覆盖）",
        "api:",
        f"  listen: \"{_listen(settings.base_url)}\"",
        "rtsp:",
        f"  listen: \":{settings.rtsp_port}\"",
        "webrtc:",
        "  candidates:",
        "    - stun:8555",
        "log:",
        "  level: info",
        "streams:",
    ]
    if not streams:
        lines.append("  {}")
    for name, src in sorted(streams.items()):
        lines.append(f"  {name}: {_yaml_scalar(src)}")
    if extra:
        lines.append(extra.rstrip())
    return "\n".join(lines) + "\n"


def _listen(base_url: str) -> str:
    parsed = urllib.parse.urlparse(base_url)
    return f":{parsed.port or 1984}"


def _yaml_scalar(value: str) -> str:
    """YAML 里 URL 常含 :// 和 {}，一律加引号最省心。"""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


__all__ = ["Go2rtcClient", "render_config"]
