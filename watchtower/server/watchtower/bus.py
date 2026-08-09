"""进程内事件总线 —— 给 SSE 推实时消息用。

分析线程产出事件后往这里 publish，API 层每个 SSE 连接持有一个队列。
队列满了就丢最旧的：**宁可让慢客户端漏几条，也不能把分析线程堵住**。
"""

from __future__ import annotations

import json
import queue
import threading
import time
from typing import Any

MAX_QUEUE = 64


class EventBus:
    def __init__(self) -> None:
        self._subscribers: set[queue.Queue] = set()
        self._lock = threading.Lock()

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=MAX_QUEUE)
        with self._lock:
            self._subscribers.add(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            self._subscribers.discard(q)

    def publish(self, kind: str, payload: Any) -> None:
        message = {"kind": kind, "at": time.time(), "data": payload}
        with self._lock:
            targets = list(self._subscribers)
        for q in targets:
            try:
                q.put_nowait(message)
            except queue.Full:
                try:
                    q.get_nowait()        # 丢最旧的，给新消息腾位
                    q.put_nowait(message)
                except (queue.Empty, queue.Full):
                    pass

    @property
    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subscribers)


def sse_format(message: dict[str, Any]) -> str:
    body = json.dumps(message, ensure_ascii=False)
    return f"event: {message.get('kind', 'message')}\ndata: {body}\n\n"


BUS = EventBus()

__all__ = ["EventBus", "BUS", "sse_format"]
