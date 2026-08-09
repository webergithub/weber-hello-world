"""推送通道。全部用标准库实现，装了就能用。

| channel    | target 填什么                                   | 适合谁 |
| ---------- | ----------------------------------------------- | ------ |
| `bark`     | Bark 的 device key，或完整的 `https://.../key`   | iOS 个人 |
| `wecom`    | 企业微信群机器人 webhook 完整地址                | 团队/家庭群 |
| `dingtalk` | 钉钉机器人 webhook（可选 `|secret` 加签）        | 团队 |
| `telegram` | `<bot_token>:<chat_id>`                          | 海外/自建 |
| `webhook`  | 任意 URL，收到统一结构的 JSON                    | 自己接系统 |

App 内实时消息不走这里 —— 走 SSE（见 bus.py），App 开着时零延迟。
Web Push / FCM 需要签名与加密库，作为可选扩展，见 docs/03-部署与运维.md。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import Any

from .. import http

log = logging.getLogger(__name__)

BARK_DEFAULT_HOST = "https://api.day.app"


@dataclass
class Notification:
    title: str
    body: str
    level: str = "event"            # event | digest | system
    url: str = ""                   # 点开跳到查看端的哪一页
    image_url: str = ""
    ref: str = ""                   # 事件/剪影 ID，用于去重与回查
    extra: dict[str, Any] = field(default_factory=dict)

    def as_text(self) -> str:
        return f"{self.title}\n{self.body}" if self.body else self.title

    def as_markdown(self) -> str:
        lines = [f"**{self.title}**"]
        if self.body:
            lines.append(self.body)
        if self.url:
            lines.append(f"[打开查看端]({self.url})")
        return "\n".join(lines)


class Channel:
    name = ""

    def send(self, target: str, note: Notification) -> None:
        raise NotImplementedError


class BarkChannel(Channel):
    name = "bark"

    def send(self, target: str, note: Notification) -> None:
        base, key = _split_bark(target)
        payload = {
            "device_key": key,
            "title": note.title,
            "body": note.body or note.title,
            "group": "watchtower",
            "level": "timeSensitive" if note.level == "event" else "active",
        }
        if note.url:
            payload["url"] = note.url
        if note.image_url:
            payload["icon"] = note.image_url
        http.post_json(f"{base}/push", payload)


class WecomChannel(Channel):
    """企业微信群机器人。"""

    name = "wecom"

    def send(self, target: str, note: Notification) -> None:
        http.post_json(target, {
            "msgtype": "markdown",
            "markdown": {"content": note.as_markdown()},
        })


class DingTalkChannel(Channel):
    """钉钉机器人。target 形如 ``https://oapi.dingtalk.com/robot/send?access_token=xx|加签secret``。"""

    name = "dingtalk"

    def send(self, target: str, note: Notification) -> None:
        url, _, secret = target.partition("|")
        if secret:
            timestamp = str(round(time.time() * 1000))
            sign = base64.b64encode(
                hmac.new(secret.encode(), f"{timestamp}\n{secret}".encode(), hashlib.sha256).digest()
            ).decode()
            joiner = "&" if "?" in url else "?"
            url = f"{url}{joiner}timestamp={timestamp}&sign={urllib.parse.quote_plus(sign)}"
        http.post_json(url, {
            "msgtype": "markdown",
            "markdown": {"title": note.title, "text": note.as_markdown()},
        })


class TelegramChannel(Channel):
    """target 形如 ``123456:ABC-DEF...|<chat_id>``。"""

    name = "telegram"

    def send(self, target: str, note: Notification) -> None:
        token, _, chat_id = target.rpartition("|")
        if not token or not chat_id:
            raise ValueError("telegram target 应为 <bot_token>|<chat_id>")
        http.post_json(f"https://api.telegram.org/bot{token}/sendMessage", {
            "chat_id": chat_id,
            "text": note.as_markdown(),
            "parse_mode": "Markdown",
            "disable_web_page_preview": True,
        })


class WebhookChannel(Channel):
    """通用 webhook：把通知原样投给你自己的系统。"""

    name = "webhook"

    def send(self, target: str, note: Notification) -> None:
        http.post_json(target, {
            "title": note.title,
            "body": note.body,
            "level": note.level,
            "url": note.url,
            "image_url": note.image_url,
            "ref": note.ref,
            "extra": note.extra,
            "sent_at": time.time(),
        })


CHANNELS: dict[str, Channel] = {
    c.name: c for c in (
        BarkChannel(), WecomChannel(), DingTalkChannel(), TelegramChannel(), WebhookChannel(),
    )
}


def send(channel: str, target: str, note: Notification) -> None:
    impl = CHANNELS.get(channel)
    if impl is None:
        raise ValueError(f"未知推送通道 {channel!r}，可选：{', '.join(sorted(CHANNELS))}")
    impl.send(target, note)


def _split_bark(target: str) -> tuple[str, str]:
    if target.startswith("http"):
        parsed = urllib.parse.urlsplit(target)
        key = parsed.path.strip("/").split("/")[0]
        return f"{parsed.scheme}://{parsed.netloc}", key
    return BARK_DEFAULT_HOST, target


def describe() -> list[dict[str, str]]:
    return [
        {"channel": "bark", "target": "Bark device key 或完整地址", "note": "iOS 个人推送"},
        {"channel": "wecom", "target": "企业微信群机器人 webhook", "note": "团队/家庭群"},
        {"channel": "dingtalk", "target": "webhook 或 webhook|加签secret", "note": "钉钉群"},
        {"channel": "telegram", "target": "<bot_token>|<chat_id>", "note": "Telegram"},
        {"channel": "webhook", "target": "任意 URL", "note": "接入自有系统"},
    ]


__all__ = ["Notification", "Channel", "CHANNELS", "send", "describe"]
