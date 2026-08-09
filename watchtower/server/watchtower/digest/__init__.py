"""一日剪影：事件 → 选段 → 成片 → 文案。"""

from .builder import DigestBuilder, day_bounds, today
from .narrator import narrate, template_summary
from .renderer import render_cover, render_digest
from .selector import Clip, DayStats, select_clips, summarize_day

__all__ = [
    "DigestBuilder", "day_bounds", "today",
    "Clip", "DayStats", "select_clips", "summarize_day",
    "render_digest", "render_cover",
    "narrate", "template_summary",
]
