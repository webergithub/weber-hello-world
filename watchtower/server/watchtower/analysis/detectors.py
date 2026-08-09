"""可插拔的人形检测器。

分四档，按可用性**自动降级** —— 装了什么用什么，最低档零第三方依赖也能跑通全流程：

    yolo    ultralytics YOLO26/YOLO11，精度最好，推荐生产用
    onnx    onnxruntime 跑导出的 .onnx，不绑训练栈，边缘设备友好
    motion  只有 opencv 时的兜底：MOG2 背景建模，只报"有东西在动"
    stub    完全无依赖，返回空（或单测预置脚本），保证流水线本身可测

`detector=auto` 时从上往下试第一个能用的。
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass, field
from typing import Any, Sequence

from ..config import AnalysisSettings

log = logging.getLogger(__name__)


@dataclass
class Detection:
    """一个检测框。bbox 用**归一化坐标** (x1,y1,x2,y2)，0~1，与分辨率解耦。"""

    label: str
    score: float
    bbox: tuple[float, float, float, float]

    @property
    def center(self) -> tuple[float, float]:
        x1, y1, x2, y2 = self.bbox
        return ((x1 + x2) / 2, (y1 + y2) / 2)

    @property
    def area(self) -> float:
        x1, y1, x2, y2 = self.bbox
        return max(0.0, x2 - x1) * max(0.0, y2 - y1)


class Detector:
    name = "base"

    def detect(self, jpeg: bytes) -> list[Detection]:
        raise NotImplementedError

    def close(self) -> None:
        pass


# ---------------------------------------------------------------- stub

class StubDetector(Detector):
    """无依赖兜底。``script`` 用于单测：按调用次序吐预置结果。"""

    name = "stub"

    def __init__(self, script: Sequence[list[Detection]] | None = None) -> None:
        self.script = list(script or [])
        self.calls = 0

    def detect(self, jpeg: bytes) -> list[Detection]:
        idx = self.calls
        self.calls += 1
        if idx < len(self.script):
            return list(self.script[idx])
        return []


# ---------------------------------------------------------------- motion

class MotionDetector(Detector):
    """MOG2 背景建模 —— 只回答"哪块在动"，不区分人和猫。

    单独用会误报（树影、光照跳变），但作为**一级筛选**极其划算：
    没动静的帧根本不喂给模型，CPU 能降一个数量级。
    """

    name = "motion"

    def __init__(self, min_area: float = 0.004, history: int = 300) -> None:
        import cv2  # 延迟导入：没装 opencv 时不影响其它档位

        self._cv2 = cv2
        self._bg = cv2.createBackgroundSubtractorMOG2(history=history, varThreshold=32, detectShadows=False)
        self.min_area = min_area

    def detect(self, jpeg: bytes) -> list[Detection]:
        cv2 = self._cv2
        import numpy as np

        frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            return []
        h, w = frame.shape[:2]
        mask = self._bg.apply(cv2.GaussianBlur(frame, (5, 5), 0))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        out: list[Detection] = []
        for c in contours:
            x, y, cw, ch = cv2.boundingRect(c)
            if (cw * ch) / float(w * h) < self.min_area:
                continue
            out.append(Detection(
                label="motion",
                score=min(0.95, 0.4 + (cw * ch) / float(w * h) * 4),
                bbox=(x / w, y / h, (x + cw) / w, (y + ch) / h),
            ))
        return out


# ---------------------------------------------------------------- yolo

class YoloDetector(Detector):
    """ultralytics 后端。默认只保留 person 类。"""

    name = "yolo"

    def __init__(self, model_path: str, min_score: float, labels: Sequence[str]) -> None:
        from ultralytics import YOLO  # 延迟导入

        self.model = YOLO(model_path)
        self.min_score = min_score
        self.labels = set(labels)

    def detect(self, jpeg: bytes) -> list[Detection]:
        from PIL import Image

        image = Image.open(io.BytesIO(jpeg)).convert("RGB")
        w, h = image.size
        results = self.model.predict(image, verbose=False, conf=self.min_score)
        out: list[Detection] = []
        for result in results:
            names = result.names
            for box in result.boxes:
                label = names[int(box.cls)]
                if self.labels and label not in self.labels:
                    continue
                x1, y1, x2, y2 = (float(v) for v in box.xyxy[0])
                out.append(Detection(
                    label=label,
                    score=float(box.conf),
                    bbox=(x1 / w, y1 / h, x2 / w, y2 / h),
                ))
        return out


# ---------------------------------------------------------------- onnx

COCO_PERSON = 0


class OnnxDetector(Detector):
    """onnxruntime 后端，吃导出的 YOLO .onnx。

    兼容两种常见输出布局：
    - ``(1, N, 6)``  端到端 NMS-free 导出（YOLO26 默认）：x1,y1,x2,y2,score,cls
    - ``(1, 84, M)`` 经典布局：cx,cy,w,h + 80 类分数，本类自己做阈值+NMS
    """

    name = "onnx"

    def __init__(self, model_path: str, min_score: float, size: int = 640) -> None:
        import numpy as np
        import onnxruntime as ort

        self._np = np
        providers = ort.get_available_providers()
        self.session = ort.InferenceSession(model_path, providers=providers)
        self.input_name = self.session.get_inputs()[0].name
        self.min_score = min_score
        self.size = size
        log.info("ONNX 检测器就绪：%s providers=%s", model_path, providers)

    def _preprocess(self, jpeg: bytes):
        from PIL import Image

        np = self._np
        image = Image.open(io.BytesIO(jpeg)).convert("RGB")
        w0, h0 = image.size
        scale = min(self.size / w0, self.size / h0)
        nw, nh = int(round(w0 * scale)), int(round(h0 * scale))
        canvas = Image.new("RGB", (self.size, self.size), (114, 114, 114))
        canvas.paste(image.resize((nw, nh), Image.BILINEAR), (0, 0))
        arr = np.asarray(canvas, dtype=np.float32) / 255.0
        arr = arr.transpose(2, 0, 1)[None, ...]
        return arr, scale, w0, h0

    def detect(self, jpeg: bytes) -> list[Detection]:
        np = self._np
        arr, scale, w0, h0 = self._preprocess(jpeg)
        raw = self.session.run(None, {self.input_name: arr})[0]
        pred = np.squeeze(raw, axis=0) if raw.ndim == 3 and raw.shape[0] == 1 else raw

        boxes: list[tuple[float, float, float, float, float]] = []
        if pred.ndim == 2 and pred.shape[-1] == 6:          # 端到端导出
            for x1, y1, x2, y2, score, cls in pred:
                if score >= self.min_score and int(cls) == COCO_PERSON:
                    boxes.append((float(x1), float(y1), float(x2), float(y2), float(score)))
        elif pred.ndim == 2:                                 # (84, M) 经典布局
            pred = pred.T if pred.shape[0] < pred.shape[1] else pred
            for row in pred:
                cx, cy, bw, bh = row[:4]
                score = float(row[4 + COCO_PERSON])
                if score < self.min_score:
                    continue
                boxes.append((float(cx - bw / 2), float(cy - bh / 2),
                              float(cx + bw / 2), float(cy + bh / 2), score))
            boxes = _nms(boxes, 0.45)
        else:
            log.warning("无法识别的 ONNX 输出形状 %s", raw.shape)
            return []

        out: list[Detection] = []
        for x1, y1, x2, y2, score in boxes:
            out.append(Detection(
                label="person",
                score=score,
                bbox=(
                    max(0.0, x1 / scale / w0), max(0.0, y1 / scale / h0),
                    min(1.0, x2 / scale / w0), min(1.0, y2 / scale / h0),
                ),
            ))
        return out


def _nms(boxes: list[tuple[float, float, float, float, float]], iou_thr: float):
    boxes = sorted(boxes, key=lambda b: b[4], reverse=True)
    keep: list[tuple[float, float, float, float, float]] = []
    for box in boxes:
        if all(_iou(box[:4], k[:4]) < iou_thr for k in keep):
            keep.append(box)
    return keep


def _iou(a: Sequence[float], b: Sequence[float]) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter <= 0:
        return 0.0
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


# ---------------------------------------------------------------- 工厂

@dataclass
class DetectorInfo:
    name: str
    detail: str = ""
    fallbacks: list[str] = field(default_factory=list)


def build_detector(cfg: AnalysisSettings) -> tuple[Detector, DetectorInfo]:
    """按配置构建检测器；``auto`` 时逐档降级，并把降级过程如实记进 info。"""
    order = [cfg.detector] if cfg.detector != "auto" else ["yolo", "onnx", "motion", "stub"]
    tried: list[str] = []

    for name in order:
        try:
            if name == "yolo":
                det: Detector = YoloDetector(cfg.model_path, cfg.min_score, cfg.person_labels)
            elif name == "onnx":
                det = OnnxDetector(cfg.model_path, cfg.min_score)
            elif name == "motion":
                det = MotionDetector()
            elif name == "stub":
                det = StubDetector()
            else:
                raise ValueError(f"未知检测器 {name!r}")
            return det, DetectorInfo(name=det.name, fallbacks=tried)
        except Exception as exc:
            tried.append(f"{name}: {exc}")
            log.warning("检测器 %s 不可用（%s），继续降级", name, exc)

    return StubDetector(), DetectorInfo(name="stub", detail="全部后端不可用", fallbacks=tried)


__all__ = [
    "Detection", "Detector", "DetectorInfo",
    "StubDetector", "MotionDetector", "YoloDetector", "OnnxDetector",
    "build_detector",
]
