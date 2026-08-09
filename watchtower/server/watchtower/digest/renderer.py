"""一日剪影合成。

流程：每段截取 → 统一分辨率并烧入「时间 + 位置 + 人数」字幕 → 拼接 → 抽封面。

这里必须重编码（各路摄像头分辨率/帧率/编码都不一样，``-c copy`` 拼不起来），
所以用 ``veryfast`` 预设 + 较小分辨率控制成本 —— 剪影是拿来手机上快速过一遍的，
不是取证材料，取证请看原始录像。
"""

from __future__ import annotations

import logging
import shutil
import tempfile
from datetime import datetime
from pathlib import Path

from ..analysis.privacy import blur_filter_args
from ..media import ffmpeg
from .selector import Clip

log = logging.getLogger(__name__)

ORIENTATIONS = {
    "landscape": (1280, 720),
    "portrait": (720, 1280),
}

# 找一个能画中文的字体；找不到就不烧字幕（宁可没字幕，也不要满屏方块）
FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "C:/Windows/Fonts/msyh.ttc",
)


def find_font() -> str:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return path
    return ""


def render_digest(
    clips: list[Clip],
    out_path: Path,
    *,
    orientation: str = "landscape",
    blur_faces: bool = False,
    font: str | None = None,
) -> Path | None:
    """把选好的片段合成一条剪影。返回成片路径；没有可用片段时返回 None。"""
    usable = [c for c in clips if Path(c.source).exists()]
    if not usable:
        log.warning("没有可用片段，跳过剪影合成")
        return None
    if not ffmpeg.available():
        log.warning("未安装 ffmpeg，跳过剪影合成")
        return None

    width, height = ORIENTATIONS.get(orientation, ORIENTATIONS["landscape"])
    fontfile = font if font is not None else find_font()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        normalized: list[Path] = []
        for index, clip in enumerate(usable):
            piece = tmp_dir / f"{index:03d}.mp4"
            try:
                _normalize(clip, piece, width, height, fontfile, blur_faces)
                normalized.append(piece)
            except Exception as exc:
                log.warning("片段 %s 处理失败，跳过：%s", clip.event_id, exc)

        if not normalized:
            return None
        # 统一参数后可以直接 -c copy 拼接
        ffmpeg.concat(normalized, out_path)
    return out_path


def _normalize(clip: Clip, out: Path, width: int, height: int, fontfile: str, blur: bool) -> None:
    """截取 + 缩放补边 + 烧字幕，输出统一规格的小片段。"""
    filters = [
        f"scale={width}:{height}:force_original_aspect_ratio=decrease",
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black",
        "fps=25",
    ]
    if blur:
        # 整体像素化兜底：ffmpeg 没有内置人脸检测，成片外发时用它降低可辨识度
        filters.append("scale=iw/6:-2,scale=iw*6:-2:flags=neighbor")
    if fontfile and clip.caption:
        text = _escape_drawtext(clip.caption)
        filters.append(
            f"drawtext=fontfile='{fontfile}':text='{text}':x=24:y=h-56:"
            "fontsize=28:fontcolor=white:box=1:boxcolor=black@0.45:boxborderw=10"
        )

    ffmpeg.run([
        "-t", f"{clip.seconds:.2f}",
        "-i", str(clip.source),
        "-vf", ",".join(filters),
        "-an",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(out),
    ])


def _escape_drawtext(text: str) -> str:
    """drawtext 的转义规则很挑：冒号、单引号、反斜杠都要处理。"""
    return (text.replace("\\", r"\\\\")
                .replace(":", r"\:")
                .replace("'", r"\\'")
                .replace("%", r"\%"))


def render_cover(video: Path, out: Path, *, at: float = 1.0) -> Path | None:
    if not ffmpeg.available() or not video.exists():
        return None
    try:
        return ffmpeg.thumbnail(video, out, at=at, width=640)
    except Exception as exc:
        log.warning("剪影封面生成失败：%s", exc)
        return None


def fallback_contact_sheet(clips: list[Clip], thumbs: list[Path], out: Path) -> Path | None:
    """没装 ffmpeg 时的降级方案：把事件缩略图拼成一张"一日九宫格"。

    保证「一日剪影」这个功能在最小环境下也有产出，而不是直接空白。
    """
    usable = [p for p in thumbs if p.exists()][:9]
    if not usable:
        return None
    out.parent.mkdir(parents=True, exist_ok=True)
    if not ffmpeg.available():
        # 连 ffmpeg 都没有，只能把最有代表性的一张复制出来
        shutil.copyfile(usable[0], out)
        return out
    args: list[str] = []
    for path in usable:
        args += ["-i", str(path)]
    cols = min(3, len(usable))
    rows = (len(usable) + cols - 1) // cols
    layout = _tile_layout(len(usable), cols)
    ffmpeg.run(args + [
        "-filter_complex",
        f"{''.join(f'[{i}:v]scale=426:240[v{i}];' for i in range(len(usable)))}"
        f"{''.join(f'[v{i}]' for i in range(len(usable)))}"
        f"xstack=inputs={len(usable)}:layout={layout}[out]",
        "-map", "[out]", str(out),
    ])
    log.info("已生成 %dx%d 九宫格封面（无 ffmpeg 视频合成能力时的降级产物）", cols, rows)
    return out


def _tile_layout(count: int, cols: int) -> str:
    cells = []
    for i in range(count):
        col, row = i % cols, i // cols
        x = "0" if col == 0 else "+".join(["w0"] * col)
        y = "0" if row == 0 else "+".join(["h0"] * row)
        cells.append(f"{x}_{y}")
    return "|".join(cells)


def timestamp_name(day: str, camera_id: str = "") -> str:
    suffix = f"-{camera_id}" if camera_id else ""
    return f"digest-{day}{suffix}.mp4"


def human_time(ts: float | None) -> str:
    return datetime.fromtimestamp(ts).strftime("%H:%M") if ts else "—"


__all__ = [
    "render_digest", "render_cover", "fallback_contact_sheet",
    "timestamp_name", "human_time", "find_font",
]
