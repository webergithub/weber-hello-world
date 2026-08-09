"""Watchtower —— 多平台视频监控聚合、服务端人物分析与一日剪影。

模块划分（每层只依赖下一层，方便单测替换）：

    adapters/   各平台 → 一条可播 URL
    media/      go2rtc 归一化出流、ffmpeg 录制与剪辑
    analysis/   抽帧 → 检测 → 跟踪 → 事件
    digest/     事件 → 一日剪影 → 文案
    push/       事件/剪影 → 各推送通道
    api/        远程查看端的 REST + SSE
"""

__version__ = "0.1.0"
