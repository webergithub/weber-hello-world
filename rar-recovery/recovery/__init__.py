"""压缩包密码恢复核心库。"""
from .detect import detect, ArchiveInfo
from .engines import build_engine, Engine, EngineError, NotEncrypted
from .candidates import Options, iter_candidates, estimate_total
from .job import Job, JobManager

__all__ = [
    "detect", "ArchiveInfo",
    "build_engine", "Engine", "EngineError", "NotEncrypted",
    "Options", "iter_candidates", "estimate_total",
    "Job", "JobManager",
]
