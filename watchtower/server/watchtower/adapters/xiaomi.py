"""小米 / 米家适配器。

**先说结论**：小米没有面向第三方的摄像头视频流云 OpenAPI，别等官方接口。
能落地的是「本地桥接 → RTSP」，本适配器支持三种模式：

``mode=go2rtc``（默认，推荐）
    直接生成 go2rtc 的小米私有协议源，由 go2rtc 走 P2P 拉流，支持双向语音：

        xiaomi://<uid>:<region>@<摄像头局域网IP>?did=<设备ID>&model=<型号>&subtype=hd

    uid / did / model 从米家账号里导出（Micam、Xiaomi MIoT Auto 等工具都能导）。
    ⚠️ 每次**建连**都要向小米云换加密密钥，所以纯离线局域网跑不通；
    已建立的流可以断网续播，但重连会失败。

``mode=micam``
    先部署 Micam（https://github.com/miiot/micam，基于小米官方 Miloco + go2rtc），
    它把小米摄像头转成本地 RTSP，本适配器直接指过去。适合 go2rtc 直连不稳的机型。

``mode=rtsp``
    机型/固件本身已放开 RTSP（少数新机型），或刷了第三方固件 —— 直接填地址。

详见 docs/01-平台接入调研.md 2.1。
"""

from __future__ import annotations

import urllib.parse

from .base import CameraAdapter, NotConfigured, StreamSource

# go2rtc 的画质档位：0=自动 1=标清 2=高清（go2rtc 默认 2）
SUBTYPE_ALIASES = {"auto": "auto", "sd": "sd", "hd": "hd"}


class XiaomiAdapter(CameraAdapter):
    platform = "xiaomi"
    display_name = "小米 / 米家"
    required_options = ("mode",)
    doc_url = "https://github.com/AlexxIT/go2rtc/blob/master/internal/xiaomi/README.md"

    def resolve(self) -> StreamSource:
        mode = str(self.opt("mode", "go2rtc")).lower()
        if mode == "go2rtc":
            return self._resolve_go2rtc()
        if mode == "micam":
            return self._resolve_micam()
        if mode == "rtsp":
            return self._resolve_rtsp()
        raise NotConfigured(f"[xiaomi] 未知 mode={mode!r}，可选：go2rtc / micam / rtsp")

    # ---- go2rtc 私有协议直连 ----

    def _resolve_go2rtc(self) -> StreamSource:
        uid = self.opt("uid", required=True)          # 小米账号 UID
        region = str(self.opt("region", "cn"))        # cn / de / i2 / ru / sg / us
        ip = self.opt("ip", required=True)            # 摄像头局域网 IP
        did = self.opt("did", required=True)          # 设备 ID
        model = self.opt("model", required=True)      # 如 isa.camera.hlc7

        query = {"did": str(did), "model": str(model)}
        subtype = str(self.opt("subtype", "hd")).lower()
        # 允许直接传 0-5 的数字档位
        query["subtype"] = SUBTYPE_ALIASES.get(subtype, subtype)
        if self.opt("proto"):  # cs2+udp / cs2+tcp / tutk+udp …
            query["proto"] = str(self.opt("proto"))

        url = f"xiaomi://{uid}:{region}@{ip}?{urllib.parse.urlencode(query)}"
        return StreamSource(
            url=url,
            protocol="go2rtc",
            audio=True,
            note="建连需要公网（向小米云换密钥）；纯离线环境请改用 mode=micam 或 mode=rtsp",
            meta={"did": str(did), "model": str(model), "two_way_audio": True},
        )

    # ---- Micam 桥接 ----

    def _resolve_micam(self) -> StreamSource:
        host = self.opt("micam_host", required=True)
        port = int(self.opt("micam_port", 8554))
        stream = self.opt("micam_stream") or self.opt("did", required=True)
        return StreamSource(
            url=f"rtsp://{host}:{port}/{stream}",
            protocol="rtsp",
            note="经 Micam(Miloco+go2rtc) 桥接的本地 RTSP",
            meta={"bridge": "micam"},
        )

    # ---- 原生 RTSP ----

    def _resolve_rtsp(self) -> StreamSource:
        url = str(self.opt("url", required=True)).strip()
        if not url.startswith(("rtsp://", "rtsps://")):
            raise NotConfigured(f"[xiaomi] mode=rtsp 需要 rtsp:// 地址，收到 {url!r}")
        return StreamSource(url=url, protocol="rtsp", note="机型原生 RTSP")

    def capabilities(self) -> dict:
        caps = super().capabilities()
        caps.update({
            "cloud_api": False,
            "two_way_audio": str(self.opt("mode", "go2rtc")).lower() == "go2rtc",
            "notes": "小米无第三方视频流云 API，本适配器走本地桥接",
        })
        return caps


__all__ = ["XiaomiAdapter"]
