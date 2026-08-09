"""ffmpeg 薄封装：分段录制、按时间裁片、拼接、抽封面。

原则：**能 ``-c copy`` 就绝不重编码**。监控场景动辄十几路，转码会把 CPU 吃光；
只有在必须叠字幕/打码/统一分辨率（剪影合成）时才转一次。
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

log = logging.getLogger(__name__)

SEGMENT_PATTERN = "%Y%m%d-%H%M%S.mp4"
SEGMENT_FMT = "%Y%m%d-%H%M%S"


class FFmpegMissing(RuntimeError):
    pass


def available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def _require() -> None:
    if not available():
        raise FFmpegMissing("未找到 ffmpeg/ffprobe，请先安装（见 docs/03-部署与运维.md）")


def run(args: list[str], *, timeout: float = 300.0) -> subprocess.CompletedProcess:
    _require()
    log.debug("ffmpeg %s", " ".join(args))
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y", *args],
        capture_output=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg 失败({proc.returncode})：{proc.stderr.decode('utf-8','replace')[:500]}")
    return proc


def duration(path: Path | str) -> float:
    _require()
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, timeout=30,
    )
    try:
        return float(proc.stdout.decode().strip())
    except (ValueError, AttributeError):
        return 0.0


# ---------------------------------------------------------------- 分段录制

def record_command(src: str, out_dir: Path, *, segment_seconds: int = 10, audio: bool = False) -> list[str]:
    """常驻分段录制命令。

    分段文件名带本地时间戳，:func:`segment_start` 能反解出起始时刻，
    事件裁片就靠这个定位（见 :func:`clip_between`）。
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    audio_args = ["-c:a", "aac", "-b:a", "64k"] if audio else ["-an"]
    return [
        "ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error",
        "-rtsp_transport", "tcp",
        "-fflags", "+genpts",
        "-i", src,
        "-c:v", "copy", *audio_args,
        "-f", "segment",
        "-segment_time", str(segment_seconds),
        "-segment_format", "mp4",
        "-reset_timestamps", "1",
        "-strftime", "1",
        str(out_dir / SEGMENT_PATTERN),
    ]


def segment_start(path: Path) -> float | None:
    """从分段文件名反解起始时刻（本地时区）。"""
    try:
        return datetime.strptime(path.stem, SEGMENT_FMT).timestamp()
    except ValueError:
        return None


@dataclass
class Segment:
    path: Path
    start: float
    length: float

    @property
    def end(self) -> float:
        return self.start + self.length


def list_segments(out_dir: Path, *, segment_seconds: int = 10) -> list[Segment]:
    if not out_dir.exists():
        return []
    items: list[Segment] = []
    for p in sorted(out_dir.glob("*.mp4")):
        start = segment_start(p)
        if start is not None:
            items.append(Segment(p, start, float(segment_seconds)))
    # 用后一段的起点校正前一段真实长度（ffmpeg 会按关键帧对齐，未必正好 N 秒）
    for i in range(len(items) - 1):
        items[i].length = max(0.1, items[i + 1].start - items[i].start)
    return items


def segments_covering(segments: list[Segment], start: float, end: float) -> list[Segment]:
    return [s for s in segments if s.end > start and s.start < end]


# ---------------------------------------------------------------- 裁剪 / 拼接

def concat(files: list[Path], out: Path, *, reencode: bool = False) -> Path:
    """concat demuxer 拼接。同源分段可以直接 ``-c copy``。"""
    _require()
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as fh:
        for f in files:
            # 单引号在 concat 列表里要转义成 '\''
            escaped = str(f.resolve()).replace("'", r"'\''")
            fh.write(f"file '{escaped}'\n")
        list_path = Path(fh.name)
    try:
        codec = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac"] \
            if reencode else ["-c", "copy"]
        run(["-f", "concat", "-safe", "0", "-i", str(list_path), *codec, str(out)])
    finally:
        list_path.unlink(missing_ok=True)
    return out


def clip_between(segments: list[Segment], start: float, end: float, out: Path) -> Path | None:
    """从分段录像里裁出 [start, end) 的片段。

    先把覆盖区间的分段 ``-c copy`` 拼起来，再按相对偏移裁剪 —— 全程不重编码。
    """
    covering = segments_covering(segments, start, end)
    if not covering:
        return None
    out.parent.mkdir(parents=True, exist_ok=True)
    offset = max(0.0, start - covering[0].start)
    length = max(1.0, end - start)

    if len(covering) == 1:
        run(["-ss", f"{offset:.2f}", "-i", str(covering[0].path),
             "-t", f"{length:.2f}", "-c", "copy", "-movflags", "+faststart", str(out)])
        return out

    with tempfile.TemporaryDirectory() as tmp:
        merged = Path(tmp) / "merged.mp4"
        concat([s.path for s in covering], merged)
        run(["-ss", f"{offset:.2f}", "-i", str(merged),
             "-t", f"{length:.2f}", "-c", "copy", "-movflags", "+faststart", str(out)])
    return out


def thumbnail(src: Path | str, out: Path, *, at: float = 0.5, width: int = 480) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    run(["-ss", f"{at:.2f}", "-i", str(src), "-frames:v", "1",
         "-vf", f"scale={width}:-2", str(out)])
    return out


def jpeg_to_file(data: bytes, out: Path) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    return out


__all__ = [
    "FFmpegMissing", "Segment", "available", "run", "duration",
    "record_command", "segment_start", "list_segments", "segments_covering",
    "concat", "clip_between", "thumbnail", "jpeg_to_file",
]
