"""萤石 EZVIZ（海康民用）适配器 —— 国内最省事的官方接入方式。

流程：appKey/appSecret 换 accessToken（7 天有效，缓存复用）→ 用 accessToken +
设备序列号换带时效的播放地址。

两个必须知道的限制（见 docs/01-平台接入调研.md 2.3）：
- **HLS / RTMP / FLV 只支持 H.264 设备**；H.265 设备只能拿 ezopen 地址，
  而 ezopen 是萤石私有协议，服务端 ffmpeg 解不了 —— 想让分析流水线也能用，
  请到萤石 App 里把设备编码改成 H.264。
- 播放地址有 ``expireTime`` 且带防盗链，必须按需申请、过期重取，不能写死进配置。

文档：https://open.sq.ys7.com/doc/zh/book/index/live_proto.html
"""

from __future__ import annotations

import time
from typing import Any

from .. import http
from .base import AdapterError, CameraAdapter, StreamSource

TOKEN_URL = "https://open.ys7.com/api/lapp/token/get"
LIVE_URL = "https://open.ys7.com/api/lapp/v2/live/address/get"

# protocol 取值见官方文档
PROTOCOL_CODE = {"ezopen": 1, "hls": 2, "rtmp": 3, "flv": 4}
# 清晰度：1=高清(主码流) 2=流畅(子码流)
QUALITY_CODE = {"hd": 1, "sd": 2}


class EzvizAdapter(CameraAdapter):
    platform = "ezviz"
    display_name = "萤石 EZVIZ（海康民用）"
    required_options = ("app_key", "app_secret", "device_serial")
    doc_url = "https://open.ys7.com/"

    # ---- token ----

    def _access_token(self) -> str:
        app_key = self.opt("app_key", required=True)
        cache_key = f"ezviz:token:{app_key}"
        cached = self.store.kv_get(cache_key)
        if cached:
            return str(cached)

        resp = http.post_form(
            TOKEN_URL,
            {"appKey": app_key, "appSecret": self.opt("app_secret", required=True)},
        )
        data = _unwrap(resp, "获取 accessToken")
        token = data.get("accessToken")
        if not token:
            raise AdapterError(f"[ezviz] 响应里没有 accessToken：{resp}")

        # expireTime 是毫秒时间戳；提前 6 小时过期，避免边界上刚好失效
        expire_ms = float(data.get("expireTime") or 0)
        ttl = expire_ms / 1000.0 - time.time() - 6 * 3600 if expire_ms else 6 * 86400
        self.store.kv_set(cache_key, token, ttl=max(300.0, ttl))
        return str(token)

    # ---- 播放地址 ----

    def resolve(self) -> StreamSource:
        protocol = str(self.opt("protocol", "hls")).lower()
        if protocol not in PROTOCOL_CODE:
            raise AdapterError(f"[ezviz] 不支持的 protocol={protocol!r}，可选：{list(PROTOCOL_CODE)}")

        expire = int(self.opt("expire_seconds", 3600))
        payload: dict[str, Any] = {
            "accessToken": self._access_token(),
            "deviceSerial": self.opt("device_serial", required=True),
            "channelNo": int(self.opt("channel_no", 1)),
            "protocol": PROTOCOL_CODE[protocol],
            "quality": QUALITY_CODE.get(str(self.opt("quality", "hd")).lower(), 1),
            "expireTime": expire,
            "type": 1,  # 1=直播
        }
        if self.opt("stream_code"):  # 设备视频加密时的验证码
            payload["supportH265"] = 1
            payload["code"] = self.opt("stream_code")

        resp = http.post_form(LIVE_URL, payload)
        data = _unwrap(resp, "获取直播地址")
        # v2 接口正常返回对象；个别版本返回单元素数组，两种都兜住
        if isinstance(data, list):
            data = data[0] if data else {}
        url = data.get("url")
        if not url:
            raise AdapterError(f"[ezviz] 响应里没有播放地址：{resp}")

        note = ""
        if protocol != "ezopen":
            note = "HLS/RTMP/FLV 仅支持 H.264 设备；若播放失败请确认设备编码格式"
        return StreamSource(
            url=str(url),
            protocol=protocol,
            expires_at=time.time() + expire,
            note=note,
            meta={"device_serial": payload["deviceSerial"], "channel_no": payload["channelNo"]},
        )


def _unwrap(resp: Any, what: str) -> dict[str, Any]:
    """萤石统一响应：``{"code":"200","msg":"操作成功","data":{...}}``。"""
    if not isinstance(resp, dict):
        raise AdapterError(f"[ezviz] {what}失败，响应不是 JSON 对象：{resp!r}")
    code = str(resp.get("code", ""))
    if code != "200":
        raise AdapterError(f"[ezviz] {what}失败：code={code} msg={resp.get('msg')}")
    return resp.get("data") or {}


__all__ = ["EzvizAdapter"]
