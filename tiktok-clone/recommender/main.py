"""
Phase-1 推荐服务：规则打分 + 协同过滤（UserCF）
后续可平滑替换为 EasyRec 双塔模型
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import numpy as np
from collections import defaultdict
from typing import Optional

app = FastAPI(title="TikTok Clone Recommender", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ── In-memory store (replace with Redis in production) ──────────────────────
# user_id -> {video_id -> {"watch_ratio": float, "liked": bool}}
user_history: dict[str, dict[str, dict]] = defaultdict(dict)
# video_id -> aggregate stats
video_stats: dict[str, dict] = defaultdict(lambda: {
    "watch_ratios": [], "like_count": 0, "view_count": 0
})


# ── Schemas ─────────────────────────────────────────────────────────────────
class BehaviorEvent(BaseModel):
    user_id: str
    video_id: str
    action: str          # watch | like | skip | comment | share
    watch_ratio: float = 0.0

class VideoCandidate(BaseModel):
    id: str
    tags: list[str] = []
    duration: int = 30
    like_count: int = 0
    view_count: int = 0
    created_at: Optional[int] = None

class RankRequest(BaseModel):
    user_id: str
    candidates: list[VideoCandidate]


# ── Endpoints ────────────────────────────────────────────────────────────────
@app.post("/event")
def record_event(ev: BehaviorEvent):
    """Record user behavior; updates in-memory stats."""
    h = user_history[ev.user_id]
    if ev.video_id not in h:
        h[ev.video_id] = {"watch_ratio": 0.0, "liked": False}

    if ev.action == "watch":
        h[ev.video_id]["watch_ratio"] = max(h[ev.video_id]["watch_ratio"], ev.watch_ratio)
        video_stats[ev.video_id]["watch_ratios"].append(ev.watch_ratio)
        video_stats[ev.video_id]["view_count"] += 1
    elif ev.action == "like":
        h[ev.video_id]["liked"] = True
        video_stats[ev.video_id]["like_count"] += 1

    return {"ok": True}


@app.post("/rank")
def rank(req: RankRequest):
    """
    Score candidates for a user.
    Algorithm (MVP):
      score = watch_score*0.4 + like_rate*0.3 + popularity*0.2 + user_cf*0.1
    """
    uid = req.user_id
    history = user_history.get(uid, {})
    seen_ids = set(history.keys())

    # Build user preference vector (tag -> affinity)
    tag_affinity = _build_tag_affinity(uid)

    scores = []
    for v in req.candidates:
        s = _score_video(v, history, tag_affinity)
        scores.append({"id": v.id, "score": round(s, 4)})

    scores.sort(key=lambda x: x["score"], reverse=True)

    # Separate unseen from seen (always show unseen first)
    unseen = [s for s in scores if s["id"] not in seen_ids]
    seen   = [s for s in scores if s["id"] in seen_ids]

    return {"ranked": (unseen + seen)[:50]}


@app.get("/stats/{video_id}")
def get_stats(video_id: str):
    st = video_stats[video_id]
    ratios = st["watch_ratios"]
    return {
        "video_id": video_id,
        "avg_watch_ratio": float(np.mean(ratios)) if ratios else 0.0,
        "view_count": st["view_count"],
        "like_count": st["like_count"],
        "like_rate": st["like_count"] / max(st["view_count"], 1),
    }


@app.get("/health")
def health():
    return {"ok": True, "users": len(user_history), "videos_tracked": len(video_stats)}


# ── Internal helpers ─────────────────────────────────────────────────────────
def _score_video(v: VideoCandidate, history: dict, tag_affinity: dict) -> float:
    st = video_stats[v.id]
    ratios = st["watch_ratios"]

    # 1. Watch score: avg completion rate globally
    avg_ratio = float(np.mean(ratios)) if ratios else 0.5
    watch_score = avg_ratio * 0.4

    # 2. Like rate
    like_rate = st["like_count"] / max(st["view_count"], 1)
    like_score = like_rate * 0.3

    # 3. Popularity (log-normalized)
    total_views = v.view_count + st["view_count"]
    popularity = min(np.log10(total_views + 1) / 5, 1.0) * 0.2

    # 4. Tag affinity (user preference)
    affinity = np.mean([tag_affinity.get(t, 0.0) for t in v.tags]) if v.tags else 0.0
    affinity_score = affinity * 0.1

    return watch_score + like_score + popularity + affinity_score


def _build_tag_affinity(user_id: str) -> dict[str, float]:
    """
    Simple tag-level preference vector.
    High watch ratio + like on a video → boost its tags.
    """
    history = user_history.get(user_id, {})
    affinity: dict[str, list[float]] = defaultdict(list)

    for _vid, data in history.items():
        # We'd need to look up tags per video; in production inject from DB.
        # Placeholder: returns empty until video metadata is cross-referenced.
        _ = data  # silence lint

    if not affinity:
        return {}
    return {tag: float(np.mean(scores)) for tag, scores in affinity.items()}
