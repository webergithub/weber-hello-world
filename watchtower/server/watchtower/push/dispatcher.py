"""推送分发与打扰控制。

监控系统最常见的失败不是"漏推"，是**推太多以致于没人看**。
这里三道闸门，全部是纯逻辑，可单测（tests/test_push_policy.py）：

1. **分数门槛** —— 低于 ``push.min_score`` 的事件不推；
2. **聚合窗口** —— 同一摄像头 N 秒内的事件合并成一条「期间共 X 起」；
3. **免打扰时段** —— 夜间只静默入库，不响铃；**一日剪影不受此限制**
   （剪影本来就是"回头看"的东西，且通常在夜里生成）。
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from datetime import datetime

from ..config import PushSettings, Settings
from ..db import Database
from ..models import Camera, Digest, Event
from .channels import Notification, describe, send

log = logging.getLogger(__name__)


@dataclass
class Decision:
    send: bool
    reason: str = ""
    merged_count: int = 1


def parse_quiet_hours(spec: str) -> tuple[int, int] | None:
    """``"23:00-07:00"`` → ``(1380, 420)``（分钟数，允许跨零点）。"""
    if not spec or "-" not in spec:
        return None
    start_s, _, end_s = spec.partition("-")
    try:
        sh, sm = (int(x) for x in start_s.strip().split(":"))
        eh, em = (int(x) for x in end_s.strip().split(":"))
    except ValueError:
        return None
    return sh * 60 + sm, eh * 60 + em


def in_quiet_hours(spec: str, when: float | None = None) -> bool:
    parsed = parse_quiet_hours(spec)
    if parsed is None:
        return False
    start, end = parsed
    moment = datetime.fromtimestamp(when if when is not None else time.time())
    minutes = moment.hour * 60 + moment.minute
    if start <= end:
        return start <= minutes < end
    return minutes >= start or minutes < end     # 跨零点


class ThrottlePolicy:
    """分数门槛 + 同摄像头聚合窗口。"""

    def __init__(self, cfg: PushSettings) -> None:
        self.cfg = cfg
        self._last_sent: dict[str, float] = {}
        self._suppressed: dict[str, int] = {}
        self._lock = threading.Lock()

    def decide(self, camera_id: str, score: float, now: float | None = None) -> Decision:
        now = now if now is not None else time.time()
        if score < self.cfg.min_score:
            return Decision(False, f"分数 {score:.2f} 低于阈值 {self.cfg.min_score}")

        with self._lock:
            last = self._last_sent.get(camera_id)
            if last is not None and now - last < self.cfg.aggregate_window:
                self._suppressed[camera_id] = self._suppressed.get(camera_id, 0) + 1
                return Decision(
                    False,
                    f"{self.cfg.aggregate_window:.0f}s 聚合窗口内已推送过（累计抑制 "
                    f"{self._suppressed[camera_id]} 条）",
                )
            merged = self._suppressed.pop(camera_id, 0) + 1
            self._last_sent[camera_id] = now
            return Decision(True, merged_count=merged)


class Notifier:
    """把事件/剪影变成通知并发给所有订阅者。"""

    def __init__(self, db: Database, settings: Settings) -> None:
        self.db = db
        self.settings = settings
        self.policy = ThrottlePolicy(settings.push)

    # ---- 事件 ----

    def on_event(self, event: Event, camera: Camera) -> None:
        cfg = self.settings.push
        if not cfg.enabled:
            return
        decision = self.policy.decide(event.camera_id, event.score, event.ended_at)
        if not decision.send:
            log.debug("事件 %s 不推送：%s", event.id, decision.reason)
            return
        if in_quiet_hours(cfg.quiet_hours, event.ended_at):
            log.debug("事件 %s 落在免打扰时段，仅入库", event.id)
            return

        where = camera.zone or camera.name
        when = datetime.fromtimestamp(event.started_at).strftime("%H:%M")
        who = f"{event.max_persons} 人" if event.max_persons > 1 else "有人"
        extra = f"（{decision.merged_count} 起合并）" if decision.merged_count > 1 else ""
        note = Notification(
            title=f"{where} {who}活动",
            body=f"{when} 起，持续 {event.duration:.0f} 秒{extra}",
            level="event",
            url=self._viewer_url(f"/watch/event/{event.id}"),
            image_url=self._media_url(event.thumb_path),
            ref=event.id,
            extra={"camera_id": event.camera_id, "score": event.score},
        )
        self._fanout(note, level="event")
        self.db.mark_notified(event.id)

    # ---- 剪影 ----

    def on_digest(self, digest: Digest) -> None:
        cfg = self.settings.push
        if not (cfg.enabled and cfg.daily_digest):
            return
        stats = digest.stats or {}
        note = Notification(
            title=f"{digest.day} 一日剪影已生成",
            body=digest.summary or f"共 {stats.get('total_events', 0)} 起活动",
            level="digest",                      # 剪影不受免打扰限制
            url=self._viewer_url(f"/watch/digest/{digest.day}"),
            image_url=self._media_url(digest.cover_path),
            ref=digest.id,
            extra={"day": digest.day, "stats": stats},
        )
        self._fanout(note, level="digest")

    # ---- 发送 ----

    def _fanout(self, note: Notification, *, level: str) -> None:
        subscribers = self.db.list_subscribers(level=level)
        if not subscribers:
            log.debug("没有订阅者，跳过推送 %s", note.ref)
            return
        for sub in subscribers:
            try:
                send(sub.channel, sub.target, note)
                self.db.log_push(sub.id, note.ref, True)
                log.info("已推送 %s → %s(%s)", note.ref, sub.channel, sub.label or sub.id)
            except Exception as exc:
                self.db.log_push(sub.id, note.ref, False, str(exc))
                log.warning("推送失败 %s → %s：%s", note.ref, sub.channel, exc)

    def test(self, channel: str, target: str) -> None:
        send(channel, target, Notification(
            title="Watchtower 测试推送",
            body="能看到这条，说明通道配置正确。",
            level="system",
            url=self._viewer_url("/watch"),
            ref="test",
        ))

    # ---- 地址 ----

    def _viewer_url(self, path: str) -> str:
        base = (self.settings.go2rtc.public_base_url or "").rstrip("/")
        return f"{base}{path}" if base else path

    def _media_url(self, path: str) -> str:
        if not path:
            return ""
        base = (self.settings.go2rtc.public_base_url or "").rstrip("/")
        return f"{base}/api/media?path={path}" if base else ""


__all__ = ["Notifier", "ThrottlePolicy", "Decision", "in_quiet_hours",
           "parse_quiet_hours", "describe"]
