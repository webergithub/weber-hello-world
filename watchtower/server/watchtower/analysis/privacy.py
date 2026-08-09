"""隐私处理：人脸打码。

对应《公共安全视频图像信息系统管理条例》里"用于公开传播时须对人脸等敏感信息
采取严格保护措施"的要求 —— 缩略图和一日剪影是最容易被转发出去的两样东西，
默认就该打码（``privacy.blur_faces``，默认开）。

没装 opencv 时**原样返回并记一条警告**，绝不假装打过码了。
"""

from __future__ import annotations

import logging

log = logging.getLogger(__name__)

_CASCADE = None
_UNAVAILABLE = False


def _cascade():
    global _CASCADE, _UNAVAILABLE
    if _CASCADE is not None or _UNAVAILABLE:
        return _CASCADE
    try:
        import cv2

        path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        cascade = cv2.CascadeClassifier(path)
        if cascade.empty():
            raise RuntimeError(f"级联分类器加载失败：{path}")
        _CASCADE = cascade
    except Exception as exc:
        _UNAVAILABLE = True
        log.warning("人脸打码不可用（%s）；如需公开分享请自行确认合规", exc)
    return _CASCADE


def blur_faces_jpeg(jpeg: bytes, *, strength: int = 45) -> tuple[bytes, int]:
    """对 JPEG 里的人脸做马赛克。返回 (处理后的 jpeg, 打码人脸数)。

    打不了码就原样返回，计数为 -1 —— 调用方据此决定要不要拦截外发。
    """
    cascade = _cascade()
    if cascade is None:
        return jpeg, -1
    try:
        import cv2
        import numpy as np

        img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            return jpeg, -1
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        faces = cascade.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=5, minSize=(24, 24))
        for (x, y, w, h) in faces:
            roi = img[y:y + h, x:x + w]
            # 先缩到极小再放大 = 马赛克，比高斯模糊更难被还原
            small = cv2.resize(roi, (max(1, w // strength * 3 + 1), max(1, h // strength * 3 + 1)),
                               interpolation=cv2.INTER_LINEAR)
            img[y:y + h, x:x + w] = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
        return (buf.tobytes() if ok else jpeg), len(faces)
    except Exception as exc:
        log.warning("人脸打码失败：%s", exc)
        return jpeg, -1


def blur_filter_args() -> list[str]:
    """给 ffmpeg 用的整体降清晰度兜底滤镜。

    ffmpeg 没有内置人脸检测，成片打码要么逐帧走 opencv（慢），要么整体处理。
    这里提供后者：轻度像素化，能挡住可辨识度，代价是画质下降。
    仅在 ``privacy.blur_faces`` 开启且成片会外发时使用。
    """
    return ["-vf", "scale=iw/6:-2,scale=iw*6:-2:flags=neighbor"]


__all__ = ["blur_faces_jpeg", "blur_filter_args"]
