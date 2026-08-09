# Watchtower 服务端。
# ffmpeg 是硬需求（分段录制与剪影合成都靠它）；AI 依赖按需在下面放开。
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY server/requirements.txt server/requirements-ai.txt ./
RUN pip install --no-cache-dir -r requirements.txt
# 想要人形检测/人脸打码就放开这一行（镜像会大不少）：
# RUN pip install --no-cache-dir -r requirements-ai.txt

COPY server/ /app/

VOLUME ["/data"]
EXPOSE 8900

ENV WATCHTOWER_STORAGE_ROOT=/data

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8900/api/health',timeout=3)" || exit 1

CMD ["python", "-m", "watchtower", "serve"]
