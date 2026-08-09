"""极简 HTTP 客户端（标准库实现）。

各平台适配器只需要 POST JSON / POST 表单 / GET，用不着为此引入 requests，
少一个依赖就少一份供应链风险。
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

DEFAULT_TIMEOUT = 12.0
USER_AGENT = "Watchtower/0.1 (+https://github.com/webergithub/weber-hello-world)"


class HttpError(RuntimeError):
    def __init__(self, status: int, url: str, body: str) -> None:
        super().__init__(f"HTTP {status} {url}: {body[:400]}")
        self.status = status
        self.url = url
        self.body = body


def request(
    url: str,
    *,
    method: str = "GET",
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> bytes:
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", USER_AGENT)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as exc:  # 4xx/5xx 带响应体，平台错误码都在里面
        body = exc.read().decode("utf-8", "replace")
        raise HttpError(exc.code, url, body) from exc


def get_bytes(url: str, *, headers: dict[str, str] | None = None, timeout: float = DEFAULT_TIMEOUT) -> bytes:
    return request(url, headers=headers, timeout=timeout)


def get_json(url: str, *, headers: dict[str, str] | None = None, timeout: float = DEFAULT_TIMEOUT) -> Any:
    return json.loads(get_bytes(url, headers=headers, timeout=timeout) or b"null")


def post_json(
    url: str,
    payload: Any,
    *,
    headers: dict[str, str] | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> Any:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    hdrs = {"Content-Type": "application/json"}
    hdrs.update(headers or {})
    raw = request(url, method="POST", data=body, headers=hdrs, timeout=timeout)
    return json.loads(raw or b"null")


def post_form(
    url: str,
    payload: dict[str, Any],
    *,
    headers: dict[str, str] | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> Any:
    body = urllib.parse.urlencode({k: v for k, v in payload.items() if v is not None}).encode("utf-8")
    hdrs = {"Content-Type": "application/x-www-form-urlencoded"}
    hdrs.update(headers or {})
    raw = request(url, method="POST", data=body, headers=hdrs, timeout=timeout)
    return json.loads(raw or b"null")


__all__ = ["HttpError", "request", "get_bytes", "get_json", "post_json", "post_form"]
