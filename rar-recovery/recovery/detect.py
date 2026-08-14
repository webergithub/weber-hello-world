"""压缩包类型识别。

通过文件头(magic bytes)判断压缩包格式，识别 RAR4 / RAR5 / ZIP / 7z，
以及尽力判断是否加密。不依赖任何第三方库。
"""
from __future__ import annotations

import zipfile
from dataclasses import dataclass, asdict

# 文件头特征
RAR4_MAGIC = b"\x52\x61\x72\x21\x1a\x07\x00"          # "Rar!\x1a\x07\x00"
RAR5_MAGIC = b"\x52\x61\x72\x21\x1a\x07\x01\x00"       # "Rar!\x1a\x07\x01\x00"
ZIP_MAGICS = (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")
SEVENZ_MAGIC = b"\x37\x7a\xbc\xaf\x27\x1c"


@dataclass
class ArchiveInfo:
    path: str
    kind: str                       # 'rar' | 'zip' | '7z' | 'unknown'
    rar_version: int | None = None  # 4 或 5
    encrypted: bool | None = None   # True/False/None(未知)
    header_encrypted: bool = False  # 连文件名都加密了
    note: str = ""

    def as_dict(self) -> dict:
        return asdict(self)


def _zip_encryption(path: str) -> tuple[bool | None, str]:
    """返回 (是否加密, 说明)。加密标志位 = 通用位标记的最低位。"""
    try:
        with zipfile.ZipFile(path) as zf:
            infos = zf.infolist()
            if not infos:
                return False, "空压缩包"
            any_enc = any(i.flag_bits & 0x1 for i in infos)
            # 检测 AES：AES 加密使用扩展字段 0x9901，压缩方法记为 99
            aes = any(i.compress_type == 99 for i in infos)
            if any_enc:
                return True, ("ZIP AES 加密" if aes else "ZIP 传统(ZipCrypto)加密")
            return False, "ZIP 未加密"
    except Exception as e:  # noqa: BLE001
        return None, f"无法解析 ZIP: {e}"


def detect(path: str) -> ArchiveInfo:
    """识别压缩包格式。"""
    with open(path, "rb") as f:
        head = f.read(32)

    if head.startswith(RAR5_MAGIC):
        return ArchiveInfo(path, "rar", rar_version=5,
                           note="RAR5（现代 WinRAR 默认，AES-256 加密）")
    if head.startswith(RAR4_MAGIC):
        return ArchiveInfo(path, "rar", rar_version=4,
                           note="RAR4（旧版格式，AES-128 加密）")
    if head[:4] in ZIP_MAGICS:
        enc, note = _zip_encryption(path)
        return ArchiveInfo(path, "zip", encrypted=enc, note=note)
    if head.startswith(SEVENZ_MAGIC):
        return ArchiveInfo(path, "7z", note="7-Zip 压缩包（AES-256 加密）")

    return ArchiveInfo(path, "unknown",
                       note="无法识别的格式（不是 RAR/ZIP/7z），文件头: "
                            + head[:8].hex(" "))
