"""乐橙 Imou（大华民用）适配器。

统一网关 POST ``https://openapi.lechange.cn/openapi/<method>``，
每个请求体里带 ``system.sign = MD5("time:<time>,nonce:<nonce>,appSecret:<secret>")``。

调用顺序：``accessToken`` → ``bindDeviceLive``（建直播通道）→ ``getLiveStreamInfo``（拿地址）。
⚠️ ``bindDeviceLive`` 占用**有配额的直播通道**，用完必须 ``unbindLive`` 释放，
否则很快把配额耗光 —— 所以本适配器实现了 ``release()``，上层下线摄像头时会调。

文档：https://open.imou.com/
"""

from __future__ import annotations

import hashlib
import time
import uuid
from typing import Any

from .. import http
from .base import AdapterError, CameraAdapter, StreamSource

BASE_URL = "https://openapi.lechange.cn/openapi"
# 设备已绑定直播 —— 这不是错误，直接往下拿地址即可
ALREADY_BOUND_CODES = {"LV1001", "LV1002", "SV1006"}


class ImouAdapter(CameraAdapter):
    platform = "imou"
    display_name = "乐橙 Imou（大华民用）"
    required_options = ("app_id", "app_secret", "device_id")
    doc_url = "https://open.imou.com/"

    # ---- 底层调用 ----

    def _call(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        now = str(int(time.time()))
        nonce = uuid.uuid4().hex
        secret = self.opt("app_secret", required=True)
        raw = f"time:{now},nonce:{nonce},appSecret:{secret}"
        sign = hashlib.md5(raw.encode("utf-8")).hexdigest()

        body = {
            "system": {
                "ver": "1.0",
                "sign": sign,
                "appId": self.opt("app_id", required=True),
                "time": now,
                "nonce": nonce,
            },
            "id": nonce,
            "params": params,
        }
        resp = http.post_json(f"{BASE_URL}/{method}", body)
        if not isinstance(resp, dict):
            raise AdapterError(f"[imou] {method} 响应不是 JSON 对象：{resp!r}")
        result = resp.get("result") or {}
        code = str(result.get("code", ""))
        if code != "0":
            raise AdapterError(f"[imou] {method} 失败：code={code} msg={result.get('msg')}", )
        return result.get("data") or {}

    def _token(self) -> str:
        app_id = self.opt("app_id", required=True)
        cache_key = f"imou:token:{app_id}"
        cached = self.store.kv_get(cache_key)
        if cached:
            return str(cached)
        data = self._call("accessToken", {})
        token = data.get("accessToken")
        if not token:
            raise AdapterError(f"[imou] 响应里没有 accessToken：{data}")
        # expireTime 是秒数；提前 10 分钟过期
        ttl = float(data.get("expireTime") or 3600) - 600
        self.store.kv_set(cache_key, token, ttl=max(300.0, ttl))
        return str(token)

    # ---- 播放地址 ----

    def _live_params(self, token: str) -> dict[str, Any]:
        return {
            "token": token,
            "deviceId": self.opt("device_id", required=True),
            "channelId": str(self.opt("channel_id", "0")),
            # 0=高清主码流 1=标清子码流
            "streamId": int(self.opt("stream_id", 0)),
        }

    def resolve(self) -> StreamSource:
        token = self._token()
        params = self._live_params(token)

        try:
            self._call("bindDeviceLive", params)
        except AdapterError as exc:
            if not any(c in str(exc) for c in ALREADY_BOUND_CODES):
                raise

        data = self._call("getLiveStreamInfo", {
            "token": token,
            "deviceId": params["deviceId"],
            "channelId": params["channelId"],
        })

        protocol = str(self.opt("protocol", "hls")).lower()
        url = _pick_stream(data, protocol, params["streamId"])
        if not url:
            raise AdapterError(
                f"[imou] 没能从 getLiveStreamInfo 里取到 {protocol} 地址：{data}"
            )
        return StreamSource(
            url=url,
            protocol=protocol,
            # 乐橙地址本身长期有效，但通道绑定可能被平台回收，按小时刷新更稳
            expires_at=time.time() + float(self.opt("refresh_seconds", 3600)),
            meta={"device_id": params["deviceId"], "channel_id": params["channelId"]},
        )

    def release(self) -> None:
        """释放直播通道配额。"""
        try:
            token = self._token()
            self._call("unbindLive", {
                "token": token,
                "deviceId": self.opt("device_id", required=True),
                "channelId": str(self.opt("channel_id", "0")),
                "streamId": int(self.opt("stream_id", 0)),
            })
        except AdapterError:
            # 释放失败不该阻塞下线流程，配额会由平台按超时回收
            pass


# 各协议在 streams 元素里的候选字段名（不同版本字段名略有出入，逐个试）
_PROTOCOL_KEYS = {
    "hls": ("hls", "hlsHed", "hlsHevc"),
    "rtmp": ("rtmp", "rtmpHed"),
    "rtsp": ("rtsp", "rtspHed"),
    "flv": ("flv", "httpFlv"),
}


def _pick_stream(data: dict[str, Any], protocol: str, stream_id: int) -> str:
    streams = data.get("streams") or []
    if not isinstance(streams, list) or not streams:
        return ""
    # 优先匹配 streamId，取不到就用第一条
    chosen = next(
        (s for s in streams if isinstance(s, dict) and int(s.get("streamId", -1)) == stream_id),
        streams[0],
    )
    if not isinstance(chosen, dict):
        return ""
    for key in _PROTOCOL_KEYS.get(protocol, (protocol,)):
        value = chosen.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


__all__ = ["ImouAdapter"]
