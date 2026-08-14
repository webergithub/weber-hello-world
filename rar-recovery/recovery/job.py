"""恢复任务管理。

一个 Job 在后台线程里跑：先自检引擎，再逐个测试候选密码，
实时更新进度/速率，找到后自动解压。线程安全，供 Web/CLI 轮询。
"""
from __future__ import annotations

import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from . import candidates as cand
from .detect import detect, ArchiveInfo
from .engines import build_engine, Engine, EngineError, NotEncrypted


@dataclass
class Job:
    id: str
    path: str
    options: cand.Options
    status: str = "queued"          # queued|running|found|exhausted|error|not_encrypted|canceled
    info: Optional[ArchiveInfo] = None
    engine_name: str = ""
    tried: int = 0
    total: int = 0
    rate: float = 0.0               # 每秒尝试次数
    started_at: float = 0.0
    finished_at: float = 0.0
    password: Optional[str] = None
    extracted_to: Optional[str] = None
    extracted_files: List[str] = field(default_factory=list)
    message: str = ""
    _cancel: threading.Event = field(default_factory=threading.Event, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def snapshot(self) -> dict:
        with self._lock:
            elapsed = (self.finished_at or time.time()) - self.started_at if self.started_at else 0
            eta = None
            if self.status == "running" and self.rate > 0 and self.total > self.tried:
                eta = (self.total - self.tried) / self.rate
            return {
                "id": self.id,
                "status": self.status,
                "archive": self.info.as_dict() if self.info else None,
                "engine": self.engine_name,
                "tried": self.tried,
                "total": self.total,
                "rate": round(self.rate, 1),
                "elapsed": round(elapsed, 1),
                "eta": round(eta, 1) if eta is not None else None,
                "password": self.password,
                "extracted_to": self.extracted_to,
                "extracted_files": self.extracted_files,
                "message": self.message,
            }

    def cancel(self):
        self._cancel.set()


class JobManager:
    def __init__(self):
        self._jobs: Dict[str, Job] = {}
        self._lock = threading.Lock()

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def start(self, path: str, options: cand.Options, auto_extract: bool = True) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], path=path, options=options)
        with self._lock:
            self._jobs[job.id] = job
        t = threading.Thread(target=self._run, args=(job, auto_extract), daemon=True)
        t.start()
        return job

    # ---------------------------------------------------------------- 内部执行
    def _run(self, job: Job, auto_extract: bool):
        job.started_at = time.time()
        job.status = "running"
        try:
            if not os.path.exists(job.path):
                raise EngineError(f"找不到文件：{job.path}")
            job.info = detect(job.path)
            if job.info.kind == "unknown":
                raise EngineError(job.info.note)
            if job.info.encrypted is False:
                # 未加密：先解压，最后才置终态，避免轮询方读到未完成状态
                job.message = "该压缩包没有加密，可直接解压。"
                if auto_extract:
                    self._do_extract(job, "")
                job.status = "not_encrypted"
                return

            engine: Engine = build_engine(job.info)
            job.engine_name = f"{engine.kind}:{engine.tool}"

            # 自检：坏工具/未加密立即暴露，绝不误报
            engine.self_test()

            job.total = cand.estimate_total(job.options)
            t0 = time.time()
            last = t0
            found_pw = None
            canceled = False
            for pw in cand.iter_candidates(job.options):
                if job._cancel.is_set():
                    canceled = True
                    break
                hit = engine.test(pw)
                with job._lock:
                    job.tried += 1
                    now = time.time()
                    if now - last >= 0.3:
                        job.rate = job.tried / max(1e-6, now - t0)
                        last = now
                if hit:
                    found_pw = pw
                    break

            with job._lock:
                job.rate = job.tried / max(1e-6, time.time() - t0)

            if canceled:
                job.status = "canceled"
                job.message = "已取消。"
            elif found_pw is not None:
                # 关键：先设 password + 解压，全部完成后才置 "found"
                job.password = found_pw
                job.message = f"找到密码：{found_pw}"
                if auto_extract:
                    job.status = "extracting"
                    self._do_extract(job, found_pw)
                job.status = "found"
            else:
                job.status = "exhausted"
                job.message = ("已试完所选范围，未找到密码。可以：换更大的字典、"
                               "提高搜索强度、或用 hashcat/john 做 GPU 加速暴力破解。")

        except NotEncrypted as e:
            job.status = "not_encrypted"
            job.message = str(e)
        except EngineError as e:
            job.status = "error"
            job.message = str(e)
        except Exception as e:  # noqa: BLE001
            job.status = "error"
            job.message = f"内部错误：{e}"
        finally:
            if not job.finished_at:
                job.finished_at = time.time()

    def _do_extract(self, job: Job, password: str):
        try:
            engine = build_engine(job.info)
            stem = os.path.splitext(os.path.basename(job.path))[0]
            dest = os.path.join(os.path.dirname(os.path.abspath(job.path)),
                                f"{stem}_unlocked")
            files = engine.extract(password, dest)
            job.extracted_to = dest
            job.extracted_files = files
            job.message += f"　已解压到：{dest}（{len(files)} 个文件）"
        except Exception as e:  # noqa: BLE001
            job.message += f"　但自动解压失败：{e}"
