"""360 智能摄像机适配器。

**这是本次调研里最封闭的一家，请先读完这段再配置。**

360 有官方开放平台（https://dev.jia.360.cn/），提供 Android / iOS / JS SDK + 服务端 API，
可以脱离 360 账号体系做定制。但是：

- 视频能力集中在**客户端 SDK**里，**服务端拿不到可直接拉的流地址**；
- 设备**不支持 ONVIF / RTSP**，也没有可用的第三方固件。

所以本适配器不假装"点一下就能拉流"，而是提供两种诚实的模式：

``mode=manual``
    你自己想办法拿到了一条可播地址（例如该机型支持局域网直连、或用了采集卡），直接填。

``mode=relay``
    **端侧转推旁路**：一台常驻安卓设备跑 360 SDK 播放，并把画面推流到本系统的
    go2rtc RTSP 入口 ``rtsp://<go2rtc>:8554/<stream_name>``。
    本适配器此时返回 ``protocol="publish"`` —— 归一层会识别出"这路流由外部推进来"，
    因而**不会**去创建拉流配置，只等着流上来。

两种模式都配不了的话，本适配器会抛出带指引的 ``NotConfigured``，而不是静默失败。
详见 docs/01-平台接入调研.md 2.2。
"""

from __future__ import annotations

from .base import CameraAdapter, NotConfigured, StreamSource

GUIDE = (
    "360 摄像机没有可供服务端直接拉流的公开接口。请二选一：\n"
    "  1) mode=manual + url=<你已有的可播地址>\n"
    "  2) mode=relay  + stream_name=<推流名>，由常驻端侧设备跑 360 SDK 推流到 "
    "rtsp://<go2rtc>:8554/<stream_name>\n"
    "若需正式商务接入，申请 360 智能摄像机开放平台：https://dev.jia.360.cn/"
)


class Qihoo360Adapter(CameraAdapter):
    platform = "qihoo360"
    display_name = "360 智能摄像机"
    required_options = ("mode",)
    doc_url = "https://dev.jia.360.cn/"
    server_pullable = False

    def resolve(self) -> StreamSource:
        mode = str(self.opt("mode", "")).lower()

        if mode == "manual":
            url = str(self.opt("url", required=True)).strip()
            return StreamSource(
                url=url,
                protocol=str(self.opt("protocol", "rtsp")),
                note="360：手工提供的地址，可用性由来源保证",
            )

        if mode == "relay":
            # 由端侧推进来，服务端只负责等；URL 仅用于展示与配置校验
            name = str(self.opt("stream_name") or self.camera.stream_name)
            return StreamSource(
                url=f"rtsp://<go2rtc>:8554/{name}",
                protocol="publish",
                note="360：端侧 SDK 转推模式，本系统被动接收推流，不主动拉流",
                meta={"publish_name": name},
            )

        raise NotConfigured(f"[qihoo360] 摄像头 {self.camera.id} 未配置可用接入方式。\n{GUIDE}")

    def capabilities(self) -> dict:
        caps = super().capabilities()
        caps.update({
            "cloud_api": "仅设备/告警管理，不出流",
            "onvif_rtsp": False,
            "notes": GUIDE,
        })
        return caps


__all__ = ["Qihoo360Adapter"]
