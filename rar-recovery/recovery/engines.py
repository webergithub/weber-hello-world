"""密码测试引擎。

针对不同格式提供统一接口：
    engine.test(password) -> bool        # 密码是否正确
    engine.self_test()                   # 启动前自检，坏了就抛错，绝不误报
    engine.extract(password, dest) -> [files]

RAR：调用系统 `unrar`（最可靠），退出码 0=正确、11/3=密码错、其它=错误。
ZIP：纯 Python（pyzipper 支持 AES，缺失时退回标准库/7z）。
7z ：调用系统 `7z`。
"""
from __future__ import annotations

import os
import secrets
import shutil
import subprocess
from typing import List

try:
    import pyzipper  # 支持 AES 加密的 ZIP
    _HAVE_PYZIPPER = True
except Exception:  # noqa: BLE001
    import zipfile as pyzipper  # 退化：仅支持传统 ZipCrypto
    _HAVE_PYZIPPER = False


class EngineError(Exception):
    """引擎无法处理（工具缺失 / 压缩包损坏 / 未加密等）。"""


class NotEncrypted(EngineError):
    """压缩包根本没设密码。"""


class Engine:
    kind = "?"
    tool = "?"

    def test(self, password: str) -> bool:
        raise NotImplementedError

    def self_test(self) -> None:
        """用一个随机错误密码验证引擎行为正常。

        - 若随机密码被判为"正确" -> 压缩包没加密（或工具异常），抛 NotEncrypted。
        - 若抛错 -> 工具/压缩包有问题，向上传递。
        """
        wrong = "zZ9_" + secrets.token_hex(20)
        if self.test(wrong):
            raise NotEncrypted(
                "该压缩包用任意密码都能通过，说明它并没有设置密码，可以直接解压。"
            )

    def extract(self, password: str, dest: str) -> List[str]:
        raise NotImplementedError


def _walk(dest: str) -> List[str]:
    out: List[str] = []
    for root, _dirs, files in os.walk(dest):
        for name in files:
            full = os.path.join(root, name)
            out.append(os.path.relpath(full, dest))
    return sorted(out)


# --------------------------------------------------------------------------- RAR
class UnrarEngine(Engine):
    kind = "rar"

    def __init__(self, path: str, binary: str = "unrar"):
        self.path = path
        self.tool = binary

    def _run(self, args: List[str], timeout: int = 120) -> subprocess.CompletedProcess:
        return subprocess.run(
            [self.tool, *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )

    def test(self, password: str) -> bool:
        # -inul 静默；-p<pw> 内联密码；-- 结束参数解析，避免路径/密码被当开关
        p = self._run(["t", f"-p{password}", "-inul", "--", self.path])
        rc = p.returncode
        if rc == 0:
            return True
        if rc in (3, 11):        # 11=密码错误(RAR5)，3=CRC错误(RAR4 密码错)
            return False
        err = (p.stderr or b"").decode("utf-8", "replace").strip()
        raise EngineError(f"unrar 退出码 {rc}: {err or '未知错误'}")

    def extract(self, password: str, dest: str) -> List[str]:
        os.makedirs(dest, exist_ok=True)
        p = self._run(
            ["x", "-y", "-o+", f"-p{password}", "--", self.path, dest + os.sep],
            timeout=3600,
        )
        if p.returncode != 0:
            err = (p.stderr or b"").decode("utf-8", "replace").strip()
            raise EngineError(f"解压失败 (unrar 退出码 {p.returncode}): {err}")
        return _walk(dest)


# --------------------------------------------------------------------------- 7z
class SevenZipEngine(Engine):
    kind = "7z"

    def __init__(self, path: str, binary: str = "7z", kind: str = "7z"):
        self.path = path
        self.tool = binary
        self.kind = kind

    def _run(self, args: List[str], timeout: int = 120) -> subprocess.CompletedProcess:
        return subprocess.run(
            [self.tool, *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )

    def test(self, password: str) -> bool:
        p = self._run(["t", f"-p{password}", "-y", "--", self.path])
        rc = p.returncode
        if rc == 0:
            return True
        if rc == 2:              # 7z: 2 = 致命错误（含密码错误）
            return False
        err = (p.stderr or b"").decode("utf-8", "replace").strip()
        raise EngineError(f"7z 退出码 {rc}: {err or '未知错误'}")

    def extract(self, password: str, dest: str) -> List[str]:
        os.makedirs(dest, exist_ok=True)
        p = self._run(
            ["x", "-y", f"-p{password}", f"-o{dest}", "--", self.path],
            timeout=3600,
        )
        if p.returncode != 0:
            err = (p.stderr or b"").decode("utf-8", "replace").strip()
            raise EngineError(f"解压失败 (7z 退出码 {p.returncode}): {err}")
        return _walk(dest)


# --------------------------------------------------------------------------- ZIP
class ZipEngine(Engine):
    kind = "zip"
    tool = "python:pyzipper" if _HAVE_PYZIPPER else "python:zipfile"

    def __init__(self, path: str):
        self.path = path
        self._first = self._pick_entry()

    def _open(self):
        if _HAVE_PYZIPPER:
            return pyzipper.AESZipFile(self.path)
        return pyzipper.ZipFile(self.path)

    def _pick_entry(self) -> str:
        # 选最小的非空文件：完整读它做 CRC/HMAC 校验既可靠又最省时。
        with self._open() as zf:
            files = [i for i in zf.infolist() if not i.is_dir() and i.file_size > 0]
            if not files:
                files = [i for i in zf.infolist() if not i.is_dir()]
            if not files:
                raise EngineError("ZIP 内没有可用于校验密码的文件。")
            files.sort(key=lambda i: i.file_size)
            return files[0].filename

    def test(self, password: str) -> bool:
        # 关键：必须读完整个条目，触发 CRC(传统) / HMAC(AES) 校验。
        # 只读 1 字节会被 ZipCrypto 的 1/256 头部碰撞骗过而误报。
        pwd = password.encode("utf-8", "surrogatepass")
        try:
            with self._open() as zf:
                zf.setpassword(pwd)
                with zf.open(self._first) as fp:
                    while fp.read(65536):
                        pass
            return True
        except Exception:  # noqa: BLE001
            # 任何异常（错误密码/坏 CRC/坏 MAC）都当作"密码不对"
            return False

    def extract(self, password: str, dest: str) -> List[str]:
        os.makedirs(dest, exist_ok=True)
        pwd = password.encode("utf-8", "surrogatepass")
        with self._open() as zf:
            zf.setpassword(pwd)
            zf.extractall(dest)
        return _walk(dest)


# --------------------------------------------------------------------------- 工厂
def which(*names: str) -> str | None:
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    return None


def build_engine(info) -> Engine:
    """根据识别结果选择引擎；工具缺失时给出可操作的中文提示。"""
    if info.kind == "rar":
        unrar = which("unrar")
        if unrar:
            return UnrarEngine(info.path, unrar)
        sevenz = which("7z", "7zz")
        if sevenz:
            return SevenZipEngine(info.path, sevenz, kind="rar")
        raise EngineError(
            "未找到 RAR 解压工具。请先安装：\n"
            "  macOS:  brew install unrar   （或 brew install sevenzip）\n"
            "  Ubuntu: sudo apt install unrar"
        )
    if info.kind == "7z":
        sevenz = which("7z", "7zz")
        if sevenz:
            return SevenZipEngine(info.path, sevenz, kind="7z")
        raise EngineError(
            "未找到 7z 工具。请安装：macOS  brew install sevenzip；"
            "Ubuntu  sudo apt install p7zip-full"
        )
    if info.kind == "zip":
        return ZipEngine(info.path)
    raise EngineError("无法识别的压缩包格式，暂不支持。")
