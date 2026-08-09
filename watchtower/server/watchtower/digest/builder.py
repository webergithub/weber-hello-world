"""一日剪影编排：取事件 → 选段 → 合成 → 写文案 → 落库 → 推送。

默认每天 23:30 跑一次（``digest.at``），也可以随时手工触发：

    python -m watchtower digest --day 2026-08-09
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable

from ..config import Settings
from ..db import Database
from ..models import Digest, new_id
from . import renderer
from .narrator import narrate
from .selector import Clip, select_clips, summarize_day

log = logging.getLogger(__name__)


def day_bounds(day: str) -> tuple[float, float]:
    """``YYYY-MM-DD`` → 当地时区的 [00:00, 次日00:00) 时间戳。"""
    start = datetime.strptime(day, "%Y-%m-%d")
    return start.timestamp(), (start + timedelta(days=1)).timestamp()


def today(offset_days: int = 0) -> str:
    return (datetime.now() + timedelta(days=offset_days)).strftime("%Y-%m-%d")


class DigestBuilder:
    def __init__(
        self,
        db: Database,
        settings: Settings,
        on_digest: Callable[[Digest], None] | None = None,
    ) -> None:
        self.db = db
        self.settings = settings
        self.on_digest = on_digest

    # ---- 构建 ----

    def build(self, day: str, camera_id: str = "") -> Digest | None:
        cfg = self.settings.digest
        start, end = day_bounds(day)
        events = self.db.list_events(
            since=start, until=end, camera_id=camera_id or None, limit=5000
        )
        cameras = {c.id: c for c in self.db.list_cameras()}

        stats = summarize_day(day, events, cameras)
        clips = select_clips(
            events,
            cameras,
            target_seconds=cfg.target_seconds,
            per_clip_seconds=cfg.per_clip_seconds,
            max_clips=cfg.max_clips,
        )
        log.info("剪影 %s：事件 %d 条，选中片段 %d 个", day, len(events), len(clips))

        video_path = self._render(day, camera_id, clips)
        cover_path = self._cover(day, camera_id, video_path, events)
        summary = narrate(stats, clips, cfg)

        digest = Digest(
            id=new_id("dgst"),
            day=day,
            camera_id=camera_id,
            video_path=str(video_path) if video_path else "",
            cover_path=str(cover_path) if cover_path else "",
            summary=summary,
            stats=dict(stats.to_dict(), clips=[_clip_dict(c) for c in clips]),
        )
        self.db.upsert_digest(digest)

        if self.on_digest:
            try:
                self.on_digest(digest)
            except Exception as exc:
                log.warning("剪影回调失败：%s", exc)
        return digest

    def _render(self, day: str, camera_id: str, clips: list[Clip]) -> Path | None:
        if not clips:
            return None
        out = self.settings.digest_dir / renderer.timestamp_name(day, camera_id)
        try:
            return renderer.render_digest(
                clips,
                out,
                orientation=self.settings.digest.orientation,
                blur_faces=self.settings.privacy.blur_faces,
            )
        except Exception as exc:
            log.error("剪影合成失败 %s：%s", day, exc)
            return None

    def _cover(self, day: str, camera_id: str, video: Path | None, events) -> Path | None:
        name = renderer.timestamp_name(day, camera_id).replace(".mp4", ".jpg")
        out = self.settings.digest_dir / name
        if video:
            cover = renderer.render_cover(video, out)
            if cover:
                return cover
        # 没有成片时，用事件缩略图拼一张九宫格兜底
        thumbs = [Path(e.thumb_path) for e in events if e.thumb_path]
        try:
            return renderer.fallback_contact_sheet([], thumbs, out)
        except Exception as exc:
            log.warning("封面兜底生成失败：%s", exc)
            return None

    # ---- 定时 ----

    def run_daily_loop(self, stop: threading.Event) -> None:
        """到点跑昨天的剪影。粗粒度轮询即可，不值得引入调度框架。"""
        if not self.settings.digest.enabled:
            log.info("一日剪影已关闭（digest.enabled=false）")
            return
        last_done = ""
        while not stop.is_set():
            try:
                now = datetime.now()
                if now.strftime("%H:%M") >= self.settings.digest.at:
                    day = now.strftime("%Y-%m-%d")
                    if day != last_done:
                        log.info("开始生成 %s 的一日剪影", day)
                        self.build(day)
                        last_done = day
                        self.purge()
            except Exception as exc:
                log.exception("剪影定时任务异常：%s", exc)
            stop.wait(60.0)

    # ---- 保留策略 ----

    def purge(self) -> int:
        """按 ``privacy.retention_days`` 清理过期事件与媒体文件。"""
        days = self.settings.privacy.retention_days
        cutoff = time.time() - days * 86400
        paths = self.db.purge_events_before(cutoff)
        removed = 0
        for raw in paths:
            path = Path(raw)
            if path.exists():
                path.unlink(missing_ok=True)
                removed += 1
        if removed:
            log.info("已清理 %d 个过期事件媒体文件（保留 %d 天）", removed, days)
        return removed


def _clip_dict(clip: Clip) -> dict:
    return {
        "event_id": clip.event_id,
        "camera_id": clip.camera_id,
        "camera_name": clip.camera_name,
        "started_at": clip.started_at,
        "seconds": clip.seconds,
        "score": clip.score,
        "caption": clip.caption,
    }


__all__ = ["DigestBuilder", "day_bounds", "today"]
