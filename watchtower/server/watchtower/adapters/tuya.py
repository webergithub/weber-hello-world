"""涂鸦 Tuya 适配器 —— 覆盖面最广的一家。

很多不知名品牌的摄像头内里是涂鸦方案，接了涂鸦相当于一次接进一大片设备。

签名规则（HMAC-SHA256，结果转大写十六进制）：

    stringToSign = METHOD + "\\n" + SHA256(body) + "\\n" + headersStr + "\\n" + path
    message      = client_id + [access_token] + t + nonce + stringToSign
    sign         = HMAC-SHA256(client_secret, message).hexdigest().upper()

取 token 时 message 里不含 access_token，业务请求才含。

⚠️ ``/stream/actions/allocate`` 返回的地址**有效期很短（通常几分钟）**，
必须"随取随用"，绝不能缓存进配置文件。

文档：https://developer.tuya.com/cn/docs/cloud/19b50885a2?id=Kag2d0i8bjfh3
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from typing import Any

from .. import http
from .base import AdapterError, CameraAdapter, StreamSource

# 数据中心域名，按账号所属区域选
REGION_ENDPOINTS = {
    "cn": "https://openapi.tuyacn.com",
    "us": "https://openapi.tuyaus.com",
    "eu": "https://openapi.tuyaeu.com",
    "in": "https://openapi.tuyain.com",
}
EMPTY_BODY_SHA256 = hashlib.sha256(b"").hexdigest()


class TuyaAdapter(CameraAdapter):
    platform = "tuya"
    display_name = "涂鸦 Tuya（含大量贴牌 IPC）"
    required_options = ("client_id", "client_secret", "device_id")
    doc_url = "https://developer.tuya.com/cn/docs/cloud/"

    @property
    def endpoint(self) -> str:
        region = str(self.opt("region", "cn")).lower()
        if region.startswith("http"):
            return region.rstrip("/")
        if region not in REGION_ENDPOINTS:
            raise AdapterError(f"[tuya] 未知 region={region!r}，可选：{list(REGION_ENDPOINTS)}")
        return REGION_ENDPOINTS[region]

    # ---- 签名 ----

    def _sign(self, method: str, path: str, body: bytes, token: str = "") -> dict[str, str]:
        client_id = self.opt("client_id", required=True)
        secret = str(self.opt("client_secret", required=True))
        t = str(int(time.time() * 1000))
        nonce = uuid.uuid4().hex
        content_sha = hashlib.sha256(body).hexdigest() if body else EMPTY_BODY_SHA256
        string_to_sign = f"{method}\n{content_sha}\n\n{path}"
        message = f"{client_id}{token}{t}{nonce}{string_to_sign}"
        sign = hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest().upper()

        headers = {
            "client_id": str(client_id),
            "sign": sign,
            "t": t,
            "nonce": nonce,
            "sign_method": "HMAC-SHA256",
            "Content-Type": "application/json",
        }
        if token:
            headers["access_token"] = token
        return headers

    def _request(self, method: str, path: str, payload: Any = None, token: str = "") -> dict[str, Any]:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else b""
        headers = self._sign(method, path, body, token)
        url = f"{self.endpoint}{path}"
        raw = http.request(url, method=method, data=body or None, headers=headers)
        resp = json.loads(raw or b"null")
        if not isinstance(resp, dict):
            raise AdapterError(f"[tuya] {path} 响应不是 JSON 对象：{resp!r}")
        if not resp.get("success"):
            raise AdapterError(f"[tuya] {path} 失败：code={resp.get('code')} msg={resp.get('msg')}")
        return resp.get("result") or {}

    def _token(self) -> str:
        client_id = self.opt("client_id", required=True)
        cache_key = f"tuya:token:{client_id}"
        cached = self.store.kv_get(cache_key)
        if cached:
            return str(cached)
        result = self._request("GET", "/v1.0/token?grant_type=1")
        token = result.get("access_token")
        if not token:
            raise AdapterError(f"[tuya] 响应里没有 access_token：{result}")
        ttl = float(result.get("expire_time") or 7200) - 600
        self.store.kv_set(cache_key, token, ttl=max(300.0, ttl))
        return str(token)

    # ---- 播放地址 ----

    def resolve(self) -> StreamSource:
        protocol = str(self.opt("protocol", "rtsp")).lower()
        if protocol not in ("rtsp", "hls"):
            raise AdapterError(f"[tuya] protocol 只支持 rtsp / hls，收到 {protocol!r}")
        device_id = self.opt("device_id", required=True)
        result = self._request(
            "POST",
            f"/v1.0/devices/{device_id}/stream/actions/allocate",
            {"type": protocol.upper()},
            token=self._token(),
        )
        url = result.get("url")
        if not url:
            raise AdapterError(f"[tuya] 响应里没有播放地址：{result}")
        # 官方未在响应里给过期时间，按保守值处理：默认 4 分钟后重取
        ttl = float(self.opt("url_ttl_seconds", 240))
        return StreamSource(
            url=str(url),
            protocol=protocol,
            expires_at=time.time() + ttl,
            note="涂鸦播放地址为短效地址，切勿缓存",
            meta={"device_id": device_id},
        )


__all__ = ["TuyaAdapter"]
