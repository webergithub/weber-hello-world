"""直通适配器：已经知道 URL 就别绕弯。

适用两类情况：
1. 手上已有 ``rtsp://`` / ``rtmp://`` / ``http://...m3u8`` 地址（海康、大华、宇视、杂牌 NVR）；
2. 想直接用 go2rtc 内置的私有协议源（``tapo://`` ``vigi://`` ``ring://`` ``nest://``
   ``wyze://`` ``homekit://`` ``kasa://`` ``hass://`` ``onvif://`` …），
   本适配器原样透传，由 go2rtc 去解。
"""

from __future__ import annotations

from .base import CameraAdapter, NotConfigured, StreamSource

# go2rtc 认得的源前缀（透传即可，不必逐个写适配器）
GO2RTC_SCHEMES = (
    "rtsp://", "rtsps://", "rtmp://", "rtmps://", "http://", "https://",
    "onvif://", "tapo://", "vigi://", "kasa://", "ring://", "nest://", "wyze://",
    "homekit://", "doorbird://", "dvrip://", "eseecloud://", "gopro://", "hass://",
    "mjpeg://", "roborock://", "tuya://", "xiaomi://", "webrtc://", "ffmpeg:", "exec:",
)


class GenericAdapter(CameraAdapter):
    platform = "generic"
    display_name = "通用 / 已知地址"
    required_options = ("url",)
    doc_url = "https://github.com/AlexxIT/go2rtc#module-streams"

    def resolve(self) -> StreamSource:
        url = str(self.opt("url", required=True)).strip()
        if not url.startswith(GO2RTC_SCHEMES):
            raise NotConfigured(
                f"[generic] {url!r} 不是 go2rtc 认得的源；"
                f"支持的前缀：{', '.join(GO2RTC_SCHEMES)}"
            )
        protocol = self.opt("protocol") or _guess_protocol(url)
        return StreamSource(
            url=url,
            protocol=protocol,
            audio=bool(self.opt("audio", True)),
            note=str(self.opt("note", "")),
        )


def _guess_protocol(url: str) -> str:
    if url.startswith(("rtsp://", "rtsps://")):
        return "rtsp"
    if url.startswith(("rtmp://", "rtmps://")):
        return "rtmp"
    if ".m3u8" in url:
        return "hls"
    if ".flv" in url:
        return "flv"
    return "go2rtc"


__all__ = ["GenericAdapter", "GO2RTC_SCHEMES"]
