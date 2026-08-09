"""媒体层：归一化出流（go2rtc）、常驻录制与剪辑（ffmpeg）。"""

from .ffmpeg import Segment
from .go2rtc import Go2rtcClient, render_config
from .recorder import RecorderPool
from .streams import StreamManager

__all__ = ["Go2rtcClient", "render_config", "RecorderPool", "StreamManager", "Segment"]
