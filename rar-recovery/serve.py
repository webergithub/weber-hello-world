#!/usr/bin/env python3
"""压缩包密码恢复 · 本地 Web 应用（纯标准库，无第三方依赖）。

启动后在浏览器打开 http://127.0.0.1:<port>：
  - 填入本机压缩包的路径，或直接拖拽上传
  - 选择搜索强度，点击"开始破解"
  - 实时看进度；找到密码后自动解压，列出文件

只监听本机回环地址，文件不出本机。仅用于恢复你自己的文件。
"""
from __future__ import annotations

import json
import os
import socket
import tempfile
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from recovery import detect
from recovery.engines import build_engine, EngineError
from recovery.candidates import Options
from recovery.job import JobManager

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
UPLOAD_DIR = os.path.join(tempfile.gettempdir(), "rar_recovery_uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

MANAGER = JobManager()

_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "RarRecovery/1.0"

    # ------------------------------------------------------------------ 工具
    def _send(self, code: int, body: bytes, ctype: str = "application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, code: int, obj: dict):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", 0) or 0)
        return self.rfile.read(length) if length else b""

    def _read_json(self) -> dict:
        raw = self._read_body()
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def log_message(self, fmt, *args):  # 安静一点
        pass

    # ------------------------------------------------------------------ GET
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/" or path == "/index.html":
            return self._serve_file("index.html")
        if path.startswith("/static/"):
            return self._serve_file(path[len("/static/"):])
        if path in ("/app.js", "/style.css"):
            return self._serve_file(path.lstrip("/"))

        if path == "/api/status":
            qs = parse_qs(parsed.query)
            job_id = (qs.get("id") or [""])[0]
            job = MANAGER.get(job_id)
            if not job:
                return self._json(404, {"error": "任务不存在"})
            return self._json(200, job.snapshot())

        return self._json(404, {"error": "not found"})

    def _serve_file(self, rel: str):
        rel = rel.lstrip("/")
        full = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not full.startswith(WEB_DIR) or not os.path.isfile(full):
            return self._json(404, {"error": "file not found"})
        ext = os.path.splitext(full)[1]
        with open(full, "rb") as f:
            body = f.read()
        self._send(200, body, _CONTENT_TYPES.get(ext, "application/octet-stream"))

    # ------------------------------------------------------------------ POST
    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/scan":
            return self._api_scan()
        if path == "/api/upload":
            return self._api_upload()
        if path == "/api/recover":
            return self._api_recover()
        if path == "/api/cancel":
            return self._api_cancel()
        if path == "/api/extract":
            return self._api_extract()
        return self._json(404, {"error": "not found"})

    def _api_scan(self):
        data = self._read_json()
        p = (data.get("path") or "").strip()
        if not p:
            return self._json(400, {"error": "请提供压缩包路径"})
        p = os.path.expanduser(p)
        if not os.path.isfile(p):
            return self._json(400, {"error": f"文件不存在：{p}"})
        info = detect(p)
        result = {"path": p, "info": info.as_dict(), "size": os.path.getsize(p)}
        # 检查所需工具是否就绪
        try:
            build_engine(info)
            result["tool_ready"] = True
            result["tool_hint"] = ""
        except EngineError as e:
            result["tool_ready"] = False
            result["tool_hint"] = str(e)
        return self._json(200, result)

    def _api_upload(self):
        fname = self.headers.get("X-Filename", "upload.bin")
        fname = os.path.basename(fname) or "upload.bin"
        dest = os.path.join(UPLOAD_DIR, fname)
        length = int(self.headers.get("Content-Length", 0) or 0)
        remaining = length
        with open(dest, "wb") as f:
            while remaining > 0:
                chunk = self.rfile.read(min(1024 * 256, remaining))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)
        return self._json(200, {"path": dest, "size": os.path.getsize(dest)})

    def _api_recover(self):
        data = self._read_json()
        p = os.path.expanduser((data.get("path") or "").strip())
        if not os.path.isfile(p):
            return self._json(400, {"error": f"文件不存在：{p}"})
        opts = Options(
            strategy=data.get("strategy", "standard"),
            wordlist=(data.get("wordlist") or None),
            extra_passwords=[g for g in (data.get("guesses") or []) if g],
            personal=[p for p in (data.get("personal") or []) if p],
            rules=data.get("rules", "none") or "none",
            mask=data.get("mask", "") or "",
            mask_custom1=data.get("mask_custom1", "") or "",
            mask_custom2=data.get("mask_custom2", "") or "",
            include_dates=bool(data.get("include_dates", True)),
            use_key_lib=bool(data.get("use_key_lib", True)),
            use_industry=bool(data.get("use_industry", True)),
            wordcombos=bool(data.get("wordcombos", True)),
            brute_charset=data.get("brute_charset", "none") or "none",
            brute_custom=data.get("brute_custom", "") or "",
        )

        def _as_int(key, target):
            if data.get(key) is not None:
                try:
                    setattr(opts, target, int(data[key]))
                except (TypeError, ValueError):
                    pass

        _as_int("digits_max", "digits_max")
        _as_int("brute_minlen", "brute_minlen")
        _as_int("brute_maxlen", "brute_maxlen")
        _as_int("workers", "workers")
        auto = bool(data.get("auto_extract", True))
        job = MANAGER.start(p, opts, auto_extract=auto)
        return self._json(200, {"job_id": job.id})

    def _api_cancel(self):
        data = self._read_json()
        job = MANAGER.get(data.get("id", ""))
        if not job:
            return self._json(404, {"error": "任务不存在"})
        job.cancel()
        return self._json(200, {"ok": True})

    def _api_extract(self):
        data = self._read_json()
        job = MANAGER.get(data.get("id", ""))
        if not job or not job.info or not job.password:
            return self._json(400, {"error": "任务未完成或没有密码"})
        try:
            engine = build_engine(job.info)
            dest = data.get("dest") or (
                os.path.join(os.path.dirname(os.path.abspath(job.path)),
                             os.path.splitext(os.path.basename(job.path))[0] + "_unlocked"))
            files = engine.extract(job.password, dest)
            job.extracted_to = dest
            job.extracted_files = files
            return self._json(200, {"dest": dest, "files": files})
        except Exception as e:  # noqa: BLE001
            return self._json(500, {"error": str(e)})


def _find_port(preferred: int = 8765) -> int:
    for port in [preferred, 8766, 8777, 8899, 0]:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.bind(("127.0.0.1", port))
            actual = s.getsockname()[1]
            s.close()
            return actual
        except OSError:
            continue
    return preferred


def main():
    import argparse
    ap = argparse.ArgumentParser(description="压缩包密码恢复 · 本地 Web 应用")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    port = _find_port(args.port)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}"
    # flush=True 很重要：输出走管道时若不刷新，Electron 外壳读不到 URL 行
    print("=" * 56, flush=True)
    print("  压缩包密码恢复 · 本地应用已启动", flush=True)
    print(f"  请在浏览器打开： {url}", flush=True)
    print("  按 Ctrl+C 停止", flush=True)
    print("=" * 56, flush=True)
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:  # noqa: BLE001
            pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
