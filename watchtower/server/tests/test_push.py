"""推送打扰控制单测 —— 这套逻辑决定了系统"烦不烦人"。"""

from __future__ import annotations

from datetime import datetime

import pytest

from watchtower.config import PushSettings
from watchtower.push.channels import Notification, send
from watchtower.push.dispatcher import ThrottlePolicy, in_quiet_hours, parse_quiet_hours


def ts(hour: int, minute: int = 0) -> float:
    return datetime(2026, 8, 9, hour, minute).timestamp()


# ---------------------------------------------------------------- 免打扰

def test_parse_quiet_hours():
    assert parse_quiet_hours("23:00-07:00") == (23 * 60, 7 * 60)
    assert parse_quiet_hours("") is None
    assert parse_quiet_hours("乱写") is None


def test_quiet_hours_across_midnight():
    spec = "23:00-07:00"
    assert in_quiet_hours(spec, ts(23, 30)) is True
    assert in_quiet_hours(spec, ts(2, 0)) is True
    assert in_quiet_hours(spec, ts(6, 59)) is True
    assert in_quiet_hours(spec, ts(7, 0)) is False
    assert in_quiet_hours(spec, ts(13, 0)) is False


def test_quiet_hours_same_day_range():
    spec = "12:00-14:00"
    assert in_quiet_hours(spec, ts(13, 0)) is True
    assert in_quiet_hours(spec, ts(11, 59)) is False
    assert in_quiet_hours(spec, ts(14, 0)) is False


def test_empty_spec_never_silences():
    assert in_quiet_hours("", ts(3, 0)) is False


# ---------------------------------------------------------------- 限流聚合

def cfg(**kw) -> PushSettings:
    base = PushSettings(min_score=0.5, aggregate_window=300.0)
    for key, value in kw.items():
        setattr(base, key, value)
    return base


def test_low_score_event_is_dropped():
    policy = ThrottlePolicy(cfg())
    decision = policy.decide("cam1", 0.2, now=ts(9))
    assert decision.send is False and "低于阈值" in decision.reason


def test_first_event_passes():
    assert ThrottlePolicy(cfg()).decide("cam1", 0.9, now=ts(9)).send is True


def test_second_event_within_window_is_merged_not_sent():
    policy = ThrottlePolicy(cfg())
    policy.decide("cam1", 0.9, now=ts(9, 0))
    decision = policy.decide("cam1", 0.9, now=ts(9, 2))
    assert decision.send is False and "聚合窗口" in decision.reason


def test_suppressed_count_is_reported_on_next_send():
    policy = ThrottlePolicy(cfg())
    policy.decide("cam1", 0.9, now=ts(9, 0))
    policy.decide("cam1", 0.9, now=ts(9, 1))
    policy.decide("cam1", 0.9, now=ts(9, 2))
    decision = policy.decide("cam1", 0.9, now=ts(9, 10))
    assert decision.send is True
    assert decision.merged_count == 3        # 2 条被抑制 + 本条


def test_windows_are_per_camera():
    policy = ThrottlePolicy(cfg())
    assert policy.decide("cam1", 0.9, now=ts(9)).send is True
    assert policy.decide("cam2", 0.9, now=ts(9)).send is True


# ---------------------------------------------------------------- 通道

def test_unknown_channel_is_rejected_with_options():
    with pytest.raises(ValueError) as exc:
        send("carrier-pigeon", "x", Notification(title="t", body="b"))
    assert "bark" in str(exc.value)


def test_notification_markdown_includes_link():
    note = Notification(title="前院有人", body="09:00 起", url="https://x/watch")
    markdown = note.as_markdown()
    assert "**前院有人**" in markdown and "https://x/watch" in markdown


def test_bark_target_accepts_key_or_full_url():
    from watchtower.push.channels import _split_bark

    assert _split_bark("ABC123") == ("https://api.day.app", "ABC123")
    assert _split_bark("https://bark.self/KEY9") == ("https://bark.self", "KEY9")
