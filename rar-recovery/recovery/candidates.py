"""密码候选生成。

按"最可能命中"的顺序产出候选密码：
  用户自己的猜测 -> 常见弱密码 -> 生日/日期 -> 常见词+数字 -> 纯数字 -> 暴力小字符集
生成器逐个 yield，配合 job 显示进度与预估。
"""
from __future__ import annotations

import calendar
import datetime
import itertools
import os
from dataclasses import dataclass, field
from typing import Iterable, Iterator, List

_HERE = os.path.dirname(os.path.abspath(__file__))
_COMMON_TXT = os.path.join(_HERE, "..", "wordlists", "common.txt")

CHARSETS = {
    "none": "",
    "digits": "0123456789",
    "lower": "abcdefghijklmnopqrstuvwxyz",
    "loweralnum": "abcdefghijklmnopqrstuvwxyz0123456789",
    "alnum": "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
}


@dataclass
class Options:
    strategy: str = "standard"          # fast | standard | deep | custom
    extra_passwords: List[str] = field(default_factory=list)
    wordlist: str | None = None         # 额外字典文件（如 rockyou.txt）
    use_common: bool = True             # 是否尝试内置常见弱密码字典
    include_dates: bool = True
    year_from: int = 1940
    year_to: int = 0                    # 0 = 今年
    digits_max: int = 6                 # 纯数字最大长度
    wordcombos: bool = True             # 常见词 + 数字后缀
    brute_charset: str = "none"         # none|digits|lower|loweralnum|alnum
    brute_maxlen: int = 0

    def resolved(self) -> "Options":
        o = Options(**self.__dict__)
        if o.year_to == 0:
            o.year_to = datetime.date.today().year
        presets = {
            "fast":     dict(digits_max=4, wordcombos=False, brute_charset="none", brute_maxlen=0),
            "standard": dict(digits_max=6, wordcombos=True,  brute_charset="none", brute_maxlen=0),
            "deep":     dict(digits_max=8, wordcombos=True,  brute_charset="loweralnum", brute_maxlen=5),
        }
        if self.strategy in presets:
            for k, v in presets[self.strategy].items():
                setattr(o, k, v)
        return o


# --------------------------------------------------------------------------- 数据源
def load_common(path: str = _COMMON_TXT) -> List[str]:
    if not os.path.exists(path):
        return []
    out: List[str] = []
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            w = line.rstrip("\n").rstrip("\r")
            if w:
                out.append(w)
    return out


def _iter_wordlist_file(path: str) -> Iterator[str]:
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            w = line.rstrip("\n").rstrip("\r")
            if w:
                yield w


def _dates(year_from: int, year_to: int) -> Iterator[str]:
    # 4 位：出生年 / 年份
    for y in range(year_from, year_to + 1):
        yield f"{y:04d}"
    # 4 位：月日 MMDD
    for m in range(1, 13):
        for d in range(1, calendar.monthrange(2000, m)[1] + 1):
            yield f"{m:02d}{d:02d}"
    # 8 位：YYYYMMDD（真实有效日期）
    for y in range(year_from, year_to + 1):
        for m in range(1, 13):
            for d in range(1, calendar.monthrange(y, m)[1] + 1):
                yield f"{y:04d}{m:02d}{d:02d}"


def _dates_6(year_from: int, year_to: int) -> Iterator[str]:
    # 6 位：YYMMDD
    for y in range(year_from, year_to + 1):
        yy = y % 100
        for m in range(1, 13):
            for d in range(1, calendar.monthrange(y, m)[1] + 1):
                yield f"{yy:02d}{m:02d}{d:02d}"


def _wordcombos(words: List[str], year_from: int, year_to: int) -> Iterator[str]:
    tops = [w for w in words if w.isalpha() and len(w) >= 3][:200]
    suffixes: List[str] = [str(n) for n in range(0, 100)]
    suffixes += [str(y) for y in range(year_from, year_to + 1)]
    suffixes += ["123", "1234", "12345", "123456", "111", "000", "666", "888",
                 "!", "@", "#", "520", "1314", "521", "00", "007"]
    for w in tops:
        for s in suffixes:
            yield w + s
        cap = w.capitalize()
        for s in ("123", "1234", "123456", "!", "@"):
            yield cap + s


def _digits(max_len: int) -> Iterator[str]:
    for length in range(1, max_len + 1):
        for n in range(0, 10 ** length):
            yield str(n).zfill(length)


def _brute(charset: str, max_len: int) -> Iterator[str]:
    cs = CHARSETS.get(charset, "")
    if not cs:
        return
    for length in range(1, max_len + 1):
        for tup in itertools.product(cs, repeat=length):
            yield "".join(tup)


# --------------------------------------------------------------------------- 主入口
def iter_candidates(opts: Options) -> Iterator[str]:
    o = opts.resolved()
    common = load_common()
    seen: set[str] = set()
    SEEN_CAP = 3_000_000

    def fresh(pw: str) -> bool:
        if pw in seen:
            return False
        if len(seen) < SEEN_CAP:
            seen.add(pw)
        return True

    def stage(source: Iterable[str], dedup: bool) -> Iterator[str]:
        for pw in source:
            if dedup:
                if not fresh(pw):
                    continue
            else:
                if pw in seen:
                    continue
            yield pw

    # 1) 用户自己的猜测（最优先）
    yield from stage(o.extra_passwords, dedup=True)
    # 2) 常见弱密码
    if o.use_common:
        yield from stage(common, dedup=True)
    # 3) 生日 / 日期
    if o.include_dates:
        yield from stage(_dates(o.year_from, o.year_to), dedup=True)
        if o.digits_max >= 6 or o.strategy in ("standard", "deep"):
            yield from stage(_dates_6(o.year_from, o.year_to), dedup=True)
    # 4) 额外字典文件（如 rockyou.txt）
    if o.wordlist and os.path.exists(o.wordlist):
        yield from stage(_iter_wordlist_file(o.wordlist), dedup=False)
    # 5) 常见词 + 数字后缀
    if o.wordcombos:
        yield from stage(_wordcombos(common, o.year_from, o.year_to), dedup=True)
    # 6) 纯数字穷举
    if o.digits_max > 0:
        yield from stage(_digits(o.digits_max), dedup=False)
    # 7) 暴力小字符集（很慢，建议改用 hashcat）
    if o.brute_charset != "none" and o.brute_maxlen > 0:
        yield from stage(_brute(o.brute_charset, o.brute_maxlen), dedup=False)


def _count_lines(path: str) -> int:
    n = 0
    with open(path, "rb") as f:
        for _ in f:
            n += 1
    return n


def estimate_total(opts: Options) -> int:
    o = opts.resolved()
    total = 0
    total += len(o.extra_passwords)
    if o.use_common:
        total += len(load_common())
    if o.include_dates:
        years = max(0, o.year_to - o.year_from + 1)
        total += years + 366                     # 4 位年份 + MMDD
        total += years * 365                     # 8 位 YYYYMMDD（近似）
        if o.digits_max >= 6 or o.strategy in ("standard", "deep"):
            total += years * 365                 # 6 位 YYMMDD（近似）
    if o.wordlist and os.path.exists(o.wordlist):
        try:
            total += _count_lines(o.wordlist)
        except Exception:  # noqa: BLE001
            pass
    if o.wordcombos:
        total += 200 * (100 + max(0, o.year_to - o.year_from + 1) + 20)
    if o.digits_max > 0:
        total += sum(10 ** k for k in range(1, o.digits_max + 1))
    if o.brute_charset != "none" and o.brute_maxlen > 0:
        cs = len(CHARSETS.get(o.brute_charset, ""))
        if cs:
            total += sum(cs ** k for k in range(1, o.brute_maxlen + 1))
    return total
