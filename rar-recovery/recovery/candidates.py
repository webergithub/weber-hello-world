"""候选密码生成 —— 三级优先级。

  第 0 级：用户自己记得的候选（最优先）
  第 1 级：关键数字与字母库（keylib：顺子/重复/键盘走位/吉利数/生日…）
  第 2 级：行业常用密码库（内置高频库 common.txt + 外部字典如 rockyou）
  第 3 级：暴力生成（纯数字 + 通用字符集，长度区间可控，范围每次自定）

生成器逐个 yield，配合 job 显示进度与预估。
"""
from __future__ import annotations

import calendar
import datetime
import itertools
import os
from dataclasses import dataclass, field
from typing import Iterable, Iterator, List

from . import keylib
from . import rules as rulesmod

_HERE = os.path.dirname(os.path.abspath(__file__))
_COMMON_TXT = os.path.join(_HERE, "..", "wordlists", "common.txt")

_LOWER = "abcdefghijklmnopqrstuvwxyz"
_UPPER = _LOWER.upper()
_DIGITS = "0123456789"
CHARSETS = {
    "none": "",
    "digits": _DIGITS,
    "lower": _LOWER,
    "upper": _UPPER,
    "alpha": _LOWER + _UPPER,
    "loweralnum": _LOWER + _DIGITS,
    "alnum": _LOWER + _UPPER + _DIGITS,
    "alnumsym": _LOWER + _UPPER + _DIGITS + "!@#$%^&*",
}


@dataclass
class Options:
    strategy: str = "standard"          # fast | standard | deep | custom
    extra_passwords: List[str] = field(default_factory=list)   # 第 0 级
    # ---- 个人信息（姓名/生日/纪念词，按常见套路组合，高优先）----
    personal: List[str] = field(default_factory=list)
    # ---- 规则变形（把词扩展成真人常用变体）：none | light | full ----
    rules: str = "none"
    # ---- 掩码（知道密码"结构"时最有效，紧跟用户猜测之后优先跑）----
    mask: str = ""                      # 如 love?d?d?d?d、?u?l?l?l?d?d?d?d
    mask_custom1: str = ""              # ?1 对应的自定义字符集
    mask_custom2: str = ""              # ?2 对应的自定义字符集
    # ---- 第 1 级：关键数字与字母 ----
    use_key_lib: bool = True
    include_dates: bool = True
    year_from: int = 1940
    year_to: int = 0                    # 0 = 今年
    # ---- 第 2 级：行业常用密码库 ----
    use_industry: bool = True           # 内置 common.txt
    wordlist: str | None = None         # 外部行业字典（rockyou 等）
    wordcombos: bool = True             # 高频词 + 数字后缀
    # ---- 第 3 级：暴力生成（范围可控）----
    digits_max: int = 6                 # 纯数字长度 1..N（0=关闭）
    brute_charset: str = "none"         # none|digits|lower|upper|alpha|loweralnum|alnum|alnumsym|custom
    brute_custom: str = ""              # brute_charset=custom 时的自定义字符集
    brute_minlen: int = 1              # 暴力最小长度
    brute_maxlen: int = 0              # 暴力最大长度（0=关闭）
    # ---- 执行 ----
    workers: int = 0                    # 并行线程数，0=自动

    def resolved(self) -> "Options":
        o = Options(**self.__dict__)
        if o.year_to == 0:
            o.year_to = datetime.date.today().year
        presets = {
            "fast":     dict(wordcombos=False, digits_max=4, brute_charset="none", brute_maxlen=0),
            "standard": dict(wordcombos=True,  digits_max=6, brute_charset="none", brute_maxlen=0),
            "deep":     dict(wordcombos=True,  digits_max=8, brute_charset="loweralnum",
                             brute_minlen=1, brute_maxlen=5),
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
    for y in range(year_from, year_to + 1):          # 4 位年份
        yield f"{y:04d}"
    for m in range(1, 13):                            # 4 位月日 MMDD
        for d in range(1, calendar.monthrange(2000, m)[1] + 1):
            yield f"{m:02d}{d:02d}"
    for y in range(year_from, year_to + 1):           # 8 位 YYYYMMDD
        for m in range(1, 13):
            for d in range(1, calendar.monthrange(y, m)[1] + 1):
                yield f"{y:04d}{m:02d}{d:02d}"


def _dates_6(year_from: int, year_to: int) -> Iterator[str]:
    for y in range(year_from, year_to + 1):           # 6 位 YYMMDD
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


# --------------------------------------------------------------------------- 掩码
# 与 hashcat 一致：?d 数字 ?l 小写 ?u 大写 ?s 符号 ?a 全部 ?1/?2 自定义 ?? 字面问号
MASK_SYMBOLS = " !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"


def mask_charsets(mask: str, c1: str = "", c2: str = "") -> List[str]:
    """把掩码解析成"每个位置的字符集"列表。字面字符是长度 1 的集合。"""
    sets: List[str] = []
    i, n = 0, len(mask)
    while i < n:
        ch = mask[i]
        if ch == "?" and i + 1 < n:
            t = mask[i + 1]
            i += 2
            if t == "d":
                sets.append(_DIGITS)
            elif t == "l":
                sets.append(_LOWER)
            elif t == "u":
                sets.append(_UPPER)
            elif t == "s":
                sets.append(MASK_SYMBOLS)
            elif t == "a":
                sets.append(_LOWER + _UPPER + _DIGITS + MASK_SYMBOLS)
            elif t == "1":
                sets.append(c1)
            elif t == "2":
                sets.append(c2)
            elif t == "?":
                sets.append("?")
            else:
                sets.append(t)          # 未知占位符按字面处理
        else:
            sets.append(ch)
            i += 1
    return sets


def mask_iter(mask: str, c1: str = "", c2: str = "") -> Iterator[str]:
    sets = mask_charsets(mask, c1, c2)
    if not sets or any(len(s) == 0 for s in sets):
        return                          # 空掩码或未提供自定义字符集 -> 不产出
    for tup in itertools.product(*sets):
        yield "".join(tup)


def mask_count(mask: str, c1: str = "", c2: str = "") -> int:
    sets = mask_charsets(mask, c1, c2)
    if not sets or any(len(s) == 0 for s in sets):
        return 0
    total = 1
    for s in sets:
        total *= len(s)
    return total


def resolve_charset(o: Options) -> str:
    if o.brute_charset == "custom":
        return o.brute_custom or ""
    return CHARSETS.get(o.brute_charset, "")


def _brute(charset: str, min_len: int, max_len: int) -> Iterator[str]:
    if not charset:
        return
    min_len = max(1, min_len)
    for length in range(min_len, max_len + 1):
        for tup in itertools.product(charset, repeat=length):
            yield "".join(tup)


# --------------------------------------------------------------------------- 主入口
def iter_candidates(opts: Options) -> Iterator[str]:
    o = opts.resolved()
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
            elif pw in seen:
                continue
            yield pw

    # 第 0 级：用户自己的猜测
    yield from stage(o.extra_passwords, dedup=True)

    # 个人信息组合：姓名/生日/纪念词，按常见套路（高优先，仅在提供时）
    if o.personal:
        yield from stage(rulesmod.personal_candidates(o.personal, "full"), dedup=True)

    # 规则变形：把你的猜测扩展成真人常用变体（P@ssw0rd、xxx123!…）
    if o.rules != "none" and o.extra_passwords:
        for w in o.extra_passwords:
            yield from stage(rulesmod.mangle(w, o.rules), dedup=True)

    # 掩码：知道结构时最精准，紧跟猜测之后优先跑
    if o.mask:
        yield from stage(mask_iter(o.mask, o.mask_custom1, o.mask_custom2), dedup=False)

    # 第 1 级：关键数字与字母
    if o.use_key_lib:
        yield from stage(keylib.key_library(o.year_from, o.year_to), dedup=True)
    if o.include_dates:
        yield from stage(_dates(o.year_from, o.year_to), dedup=True)
        yield from stage(_dates_6(o.year_from, o.year_to), dedup=True)

    # 第 2 级：行业常用密码库
    if o.use_industry:
        yield from stage(load_common(), dedup=True)
    if o.wordlist and os.path.exists(o.wordlist):
        yield from stage(_iter_wordlist_file(o.wordlist), dedup=False)
    # 规则变形：把字典里的词扩展成真人常用变体
    if o.rules != "none":
        base_words = keylib.TOP_WORDS + [w for w in load_common()
                                         if any(c.isalpha() for c in w) and len(w) >= 3]
        for w in base_words:
            yield from stage(rulesmod.mangle(w, o.rules), dedup=True)
    if o.wordcombos:
        yield from stage(_wordcombos(load_common(), o.year_from, o.year_to), dedup=True)

    # 第 3 级：暴力生成（范围可控）
    if o.digits_max > 0:
        yield from stage(_digits(o.digits_max), dedup=False)
    if o.brute_charset != "none" and o.brute_maxlen > 0:
        cs = resolve_charset(o)
        yield from stage(_brute(cs, o.brute_minlen, o.brute_maxlen), dedup=False)


def _count_lines(path: str) -> int:
    n = 0
    with open(path, "rb") as f:
        for _ in f:
            n += 1
    return n


def estimate_total(opts: Options) -> int:
    o = opts.resolved()
    total = len(o.extra_passwords)
    if o.personal:
        total += len(o.personal) * 300           # 个人信息变体+组合（粗略）
    if o.rules != "none":
        per = rulesmod.mangle_count(o.rules)
        total += len(o.extra_passwords) * per     # 变形你的猜测
        common_alpha = sum(1 for w in load_common()
                           if any(c.isalpha() for c in w) and len(w) >= 3)
        total += (len(keylib.TOP_WORDS) + common_alpha) * per   # 变形字典
    if o.mask:
        total += mask_count(o.mask, o.mask_custom1, o.mask_custom2)
    if o.use_key_lib:
        total += keylib.estimate_count(o.year_from, o.year_to)
    if o.include_dates:
        years = max(0, o.year_to - o.year_from + 1)
        total += years + 366           # 4 位年份 + MMDD
        total += years * 365           # 8 位 YYYYMMDD（近似）
        total += years * 365           # 6 位 YYMMDD（近似）
    if o.use_industry:
        total += len(load_common())
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
        cs = len(resolve_charset(o))
        if cs:
            mn = max(1, o.brute_minlen)
            total += sum(cs ** k for k in range(mn, o.brute_maxlen + 1))
    return total
