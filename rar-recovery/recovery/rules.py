"""密码变形规则（借鉴 hashcat/john 的 rules 思想）。

把一个"基础词"扩展成真人真正会用的各种变体：
  大小写、leet 替换(a→@/4, o→0, s→$…)、前后缀数字/符号、反转、叠词、加年份。
另有个人信息组合：姓名/生日/纪念词按常见套路拼接（name+year、生日多种写法…）。

两档强度：
  light —— 只做大小写 + 少量常见后缀（每词约几十个变体，适合套在整本字典上）
  full  —— 再加 leet、前缀、反转、叠词、更多后缀（每词数百变体，适合套在少量词上）
"""
from __future__ import annotations

from typing import Iterable, Iterator, List

# 常见 leet 替换（三套方案）
_LEET_A = {"a": "@", "e": "3", "i": "1", "o": "0", "s": "$", "t": "7", "b": "8", "g": "9", "l": "1"}
_LEET_B = {"a": "4", "e": "3", "i": "!", "o": "0", "s": "5", "z": "2"}
# 只替元音、保留辅音——最常见的形式（password → p@ssw0rd）
_LEET_V = {"a": "@", "e": "3", "i": "1", "o": "0"}

_SUFFIX_LIGHT = ["", "1", "12", "123", "1234", "!", "2024", "2025", "2026"]
_SUFFIX_FULL = _SUFFIX_LIGHT + [
    "12345", "123456", "0", "01", "00", "007", "2", "3", "21", "22", "23",
    "!!", "@", "#", ".", "?", "520", "1314", "666", "888", "111", "000",
    "2020", "2021", "2022", "2023", "88", "99", "69",
]
_PREFIX_FULL = ["1", "!", "@", "#"]


def _case_variants(w: str) -> List[str]:
    out: List[str] = []
    for v in (w, w.lower(), w.upper(), w.capitalize(), w.swapcase()):
        if v not in out:
            out.append(v)
    return out


def _leet_variants(w: str) -> List[str]:
    low = w.lower()
    v1 = "".join(_LEET_A.get(c, c) for c in low)
    v2 = "".join(_LEET_B.get(c, c) for c in low)
    v3 = "".join(_LEET_V.get(c, c) for c in low)     # p@ssw0rd 形式
    out: List[str] = []
    for v in (v3, v1, v2, v3.capitalize(), v1.capitalize()):
        if v != low and v not in out:
            out.append(v)
    return out


def mangle(word: str, level: str = "light") -> Iterator[str]:
    """把一个词扩展成一串变体（内部去重）。"""
    if not word:
        return
    seen: set[str] = set()

    def emit(x: str) -> Iterator[str]:
        if x and x not in seen:
            seen.add(x)
            yield x

    bases = _case_variants(word)
    if level == "full":
        for lv in _leet_variants(word):
            if lv not in bases:
                bases.append(lv)

    suffixes = _SUFFIX_LIGHT if level == "light" else _SUFFIX_FULL
    for b in bases:
        for suf in suffixes:
            yield from emit(b + suf)
        if level == "full":
            for pre in _PREFIX_FULL:
                yield from emit(pre + b)
            yield from emit(b[::-1])        # 反转
            yield from emit(b + b)          # 叠词


def date_variants(token: str) -> List[str]:
    """把生日/日期类 token 展开成常见写法。"""
    digits = "".join(c for c in token if c.isdigit())
    out: List[str] = []

    def add(x: str):
        if x and x not in out:
            out.append(x)

    if len(digits) == 8:                     # YYYYMMDD
        y, m, d = digits[:4], digits[4:6], digits[6:8]
        for x in (digits, digits[2:], f"{m}{d}{y}", f"{d}{m}{y}", y, f"{m}{d}",
                  f"{d}{m}", f"{y[2:]}{m}{d}", f"{m}{d}{y[2:]}"):
            add(x)
    elif len(digits) == 6:                   # YYMMDD / DDMMYY
        add(digits)
        add(digits[::-1])
        add(f"19{digits}")
        add(f"20{digits}")
    elif len(digits) == 4:
        add(digits)
    return out


def personal_candidates(tokens: Iterable[str], level: str = "full") -> Iterator[str]:
    """个人信息组合：姓名/生日/纪念词 → 变体 + 常见拼接套路。"""
    tokens = [t.strip() for t in tokens if t and t.strip()]
    if not tokens:
        return
    seen: set[str] = set()

    def emit(x: str) -> Iterator[str]:
        if x and x not in seen:
            seen.add(x)
            yield x

    # 数字素材（生日各种写法、纯数字 token）
    nums: List[str] = []
    for t in tokens:
        for d in date_variants(t):
            if d not in nums:
                nums.append(d)
        if t.isdigit() and t not in nums:
            nums.append(t)

    # 1) 每个 token 本身 + 日期展开 + 变体
    for t in tokens:
        yield from emit(t)
        for d in date_variants(t):
            yield from emit(d)
        for v in mangle(t, level):
            yield from emit(v)

    # 2) 词 × 数字素材/常见尾巴（name+birthyear、name+1314…）
    words = [t for t in tokens if not t.isdigit()]
    tails = nums + ["123", "1234", "520", "1314", "521", "!", "@",
                    "2024", "2025", "2026", "666", "888"]
    for w in words:
        for cap in (w, w.capitalize(), w.upper()):
            for n in tails:
                yield from emit(cap + n)

    # 3) 词 × 词（两两拼接，规模有限）
    for i, a in enumerate(words):
        for b in words:
            if a is b:
                continue
            yield from emit(a + b)
            yield from emit(a.capitalize() + b.capitalize())


# --------------------------------------------------------------------------- 估算
def mangle_count(level: str) -> int:
    """单个词经 mangle 后的大致变体数（用于进度估算）。"""
    if level == "light":
        return len(_case_variants("ab")) * len(_SUFFIX_LIGHT)          # ~ 4 * 9
    if level == "full":
        cases = 5 + 4                                                  # 大小写 + leet
        return cases * len(_SUFFIX_FULL) + cases * (len(_PREFIX_FULL) + 2)
    return 0
