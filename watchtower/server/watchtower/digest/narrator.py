"""一日剪影的中文解说文案。

两级：

1. **本地模板**（零依赖、零成本、永远可用）—— 把统计数据拼成一句人话；
2. **Claude 解说**（可选）—— 把当天的事件时间线交给模型，写一段有重点、
   会指出异常的自然语言摘要。

第 2 级失败（没装 SDK、没配 key、限流、被拒答）时**静默降级到第 1 级**，
绝不让剪影因为文案生成失败而产出不了。
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any

from ..config import DigestSettings
from .selector import Clip, DayStats

log = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "你是家庭/园区安防系统的日报助手。根据当天的监控事件统计与时间线，"
    "写一段简体中文摘要。要求：\n"
    "1. 100~180 字，先说结论（今天整体是否平静），再点出 1~3 个值得注意的时段或位置；\n"
    "2. 只陈述数据里有的事实，不要臆测人物身份、动机或做安全判断；\n"
    "3. 不要使用「根据数据」「综上所述」这类套话，不要列条目，直接写成一段话；\n"
    "4. 如果全天无事件，就直接说明当天没有检测到人员活动。"
)


def narrate(stats: DayStats, clips: list[Clip], cfg: DigestSettings) -> str:
    """生成剪影文案。永远返回一个可用的字符串。"""
    local = template_summary(stats, clips)
    if not cfg.narrate:
        return local
    try:
        generated = _narrate_with_claude(stats, clips, cfg)
        if generated:
            return generated
    except Exception as exc:
        log.warning("Claude 解说生成失败，改用本地模板：%s", exc)
    return local


# ---------------------------------------------------------------- 本地模板

def template_summary(stats: DayStats, clips: list[Clip]) -> str:
    if stats.total_events == 0:
        return f"{stats.day}：全天未检测到人员活动。"

    parts = [
        f"{stats.day}：共记录 {stats.total_events} 起活动，"
        f"覆盖 {len(stats.by_camera)} 个点位。"
    ]
    if stats.busiest_hour is not None:
        parts.append(f"最集中的时段是 {stats.busiest_hour:02d} 点，")
    parts.append(f"最活跃的点位是「{stats.busiest_camera}」。")
    if stats.peak_persons > 1:
        parts.append(f"单帧最多同时出现 {stats.peak_persons} 人。")
    if stats.first_at and stats.last_at:
        first = datetime.fromtimestamp(stats.first_at).strftime("%H:%M")
        last = datetime.fromtimestamp(stats.last_at).strftime("%H:%M")
        parts.append(f"首次活动 {first}，最后一次 {last}。")
    if clips:
        parts.append(f"剪影收录 {len(clips)} 个片段。")
    return "".join(parts)


# ---------------------------------------------------------------- Claude 解说

def _narrate_with_claude(stats: DayStats, clips: list[Clip], cfg: DigestSettings) -> str:
    from anthropic import Anthropic  # 可选依赖，见 requirements-ai.txt

    client = Anthropic()   # 凭证来自 ANTHROPIC_API_KEY 或已登录的 ant 配置档
    payload = {
        "统计": stats.to_dict(),
        "时间线": [
            {
                "时间": datetime.fromtimestamp(c.started_at).strftime("%H:%M"),
                "位置": c.camera_name,
                "说明": c.caption,
                "重要度": round(c.score, 2),
            }
            for c in clips[:40]
        ],
    }
    prompt = (
        "以下是今天的监控数据（JSON）：\n\n"
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n\n"
        "请按系统提示的要求写这段摘要。"
    )

    # max_tokens 要留足：该模型默认开启思考，思考与正文共享这个上限
    kwargs: dict[str, Any] = {
        "model": cfg.narrator_model,
        "max_tokens": 4000,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": prompt}],
    }

    response = _create_with_fallback(client, kwargs)
    if response is None:
        return ""
    # 安全分类器可能拒答（返回 200 + stop_reason=refusal），此时 content 可能为空
    if getattr(response, "stop_reason", None) == "refusal":
        log.info("解说请求被拒答，改用本地模板")
        return ""
    return _first_text(response)


def _create_with_fallback(client: Any, kwargs: dict[str, Any]) -> Any:
    """优先走带服务端拒答回退的 beta 端点；SDK 版本不支持时退回普通端点。"""
    try:
        return client.beta.messages.create(
            **kwargs,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except TypeError:
        # 旧版 SDK 不认识 fallbacks / betas 参数
        pass
    except Exception as exc:
        if "fallback" not in str(exc).lower():
            raise
        log.debug("服务端回退不可用（%s），改用普通端点", exc)
    return client.messages.create(**kwargs)


def _first_text(response: Any) -> str:
    for block in getattr(response, "content", []) or []:
        if getattr(block, "type", "") == "text":
            text = (getattr(block, "text", "") or "").strip()
            if text:
                return text
    return ""


__all__ = ["narrate", "template_summary", "SYSTEM_PROMPT"]
