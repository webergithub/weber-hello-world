"""生成测试用的加密压缩包（在有 rar/zip/pyzipper 的机器上运行）。

被 test_recovery.py 调用；缺哪个工具就跳过对应格式。
"""
from __future__ import annotations

import os
import shutil
import subprocess

PW = "hunter2"


def make_zipcrypto(dest_dir: str) -> str | None:
    if not shutil.which("zip"):
        return None
    src = os.path.join(dest_dir, "_src.txt")
    with open(src, "w", encoding="utf-8") as f:
        f.write("hello secret 机密内容\n")
    out = os.path.join(dest_dir, "zc.zip")
    if os.path.exists(out):
        os.remove(out)
    subprocess.run(["zip", "-q", "-e", "-P", PW, out, os.path.basename(src)],
                   cwd=dest_dir, check=True)
    return out


def make_aes_zip(dest_dir: str) -> str | None:
    try:
        import pyzipper
    except Exception:  # noqa: BLE001
        return None
    out = os.path.join(dest_dir, "aes.zip")
    with pyzipper.AESZipFile(out, "w", compression=pyzipper.ZIP_DEFLATED,
                             encryption=pyzipper.WZ_AES) as z:
        z.setpassword(PW.encode())
        z.writestr("secret.txt", "hello secret 机密内容\n")
    return out


def make_plain_zip(dest_dir: str) -> str | None:
    if not shutil.which("zip"):
        return None
    src = os.path.join(dest_dir, "_src2.txt")
    with open(src, "w", encoding="utf-8") as f:
        f.write("no password here\n")
    out = os.path.join(dest_dir, "plain.zip")
    if os.path.exists(out):
        os.remove(out)
    subprocess.run(["zip", "-q", out, os.path.basename(src)], cwd=dest_dir, check=True)
    return out


def make_rar(dest_dir: str) -> str | None:
    if not shutil.which("rar"):
        return None
    src = os.path.join(dest_dir, "_src3.txt")
    with open(src, "w", encoding="utf-8") as f:
        f.write("rar secret 机密\n")
    out = os.path.join(dest_dir, "data.rar")
    if os.path.exists(out):
        os.remove(out)
    subprocess.run(["rar", "a", f"-p{PW}", "-inul", out, os.path.basename(src)],
                   cwd=dest_dir, check=True)
    return out
