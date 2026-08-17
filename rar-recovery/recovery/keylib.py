"""第一优先级：关键数字与字母密码库。

人们真正最常设的"关键"组合，按命中概率从高到低产出：
  短 PIN → 顺子 → 重复 → 规律串 → 吉利数字 → 键盘走位 → 顺序字母
  → 重复字母 → 高频词 → 词+数字组合。
本模块只产出"高价值有限集合"（几千条），用于最优先快速命中；
真正的海量穷举交给第三级 brute。
"""
from __future__ import annotations

from typing import Iterator, List

# 真实世界最高频的 4 位 PIN（按泄露统计排序）
TOP_PINS = [
    "1234", "1111", "0000", "1212", "7777", "1004", "2000", "4444", "2222",
    "6969", "9999", "3333", "5555", "6666", "1122", "1313", "8888", "4321",
    "2001", "1010", "1230", "1980", "1979", "1985", "0007", "1990", "1986",
    "2580", "1234", "5201", "1314",
]

# 中文语境的"吉利/含义"数字
LUCKY_NUMBERS = [
    "520", "521", "1314", "5201314", "1314520", "520520", "5211314", "13141314",
    "666", "888", "999", "168", "1688", "6666", "8888", "9999", "66666666",
    "88888888", "7758521", "5871314", "1201314", "5203344", "1392", "0755",
]

# 键盘走位（横排 / 竖排 / 斜向）
KEYBOARD_WALKS = [
    "qwerty", "qwertyuiop", "qwertyui", "qwerty123", "qwert", "werty",
    "asdf", "asdfg", "asdfgh", "asdfghjkl", "asdfjkl", "asdfasdf",
    "zxcv", "zxcvb", "zxcvbn", "zxcvbnm", "zxcvbnm123",
    "qaz", "wsx", "qazwsx", "qazwsxedc", "qazxsw", "qweasd", "qweasdzxc",
    "1qaz2wsx", "1qazxsw2", "zaq12wsx", "1q2w3e", "1q2w3e4r", "1q2w3e4r5t",
    "1q2w3e4r5t6y", "qwe123", "qweqwe", "qazqaz", "poiuy", "lkjhg", "mnbvc",
    "qwertz", "azerty", "12qwaszx", "qwas", "asdqwe",
]

# 高频英文/拼音词
TOP_WORDS = [
    "password", "passwd", "admin", "root", "love", "iloveyou", "welcome",
    "hello", "monkey", "dragon", "master", "shadow", "superman", "michael",
    "jordan", "angel", "sunshine", "princess", "flower", "google", "apple",
    "computer", "internet", "letmein", "trustno1", "starwars", "football",
    "baseball", "qwerty", "abc", "test", "guest", "system", "manager",
    "wang", "zhang", "liu", "chen", "yang", "huang", "woaini", "china",
]

# 词+数字 常用后缀
COMBO_SUFFIXES = [
    "", "1", "12", "123", "1234", "12345", "123456", "1234567", "12345678",
    "0", "00", "01", "007", "111", "666", "888", "999", "000",
    "!", "@", "#", "@123", "!23", "123!", "520", "1314", "521",
    "2020", "2021", "2022", "2023", "2024", "2025",
]

# l33t / 大小写变体（少量高价值）
LEET = ["p@ssw0rd", "passw0rd", "Passw0rd", "P@ssw0rd", "Password1",
        "Admin123", "adm1n", "r00t", "P@ssword", "Qwerty123", "Welcome1"]


def _dedup(gen: Iterator[str]) -> Iterator[str]:
    seen: set[str] = set()
    for w in gen:
        if w and w not in seen:
            seen.add(w)
            yield w


def _raw(year_from: int, year_to: int) -> Iterator[str]:
    digits = "1234567890"

    # 1) 高频短 PIN
    yield from TOP_PINS

    # 2) 顺子（升 / 降），长度 3..10
    for L in range(3, 11):
        yield digits[:L]                       # 123 ... 1234567890
    desc = "0987654321"
    for L in range(3, 11):
        yield desc[:L]                         # 098... ; 常见的 987654321
    for L in range(3, 11):
        yield "9876543210"[:L]

    # 3) 单字符重复：每个数字 × 长度 {2,3,4,6,8}
    for d in "0123456789":
        for L in (2, 3, 4, 6, 8):
            yield d * L

    # 4) 规律串
    yield from ["1212", "2121", "123123", "456456", "121212", "112233",
                "123321", "456654", "147147", "100200", "102030", "123123123",
                "0123456789", "147258369", "159357", "753951", "789456123",
                "987654321", "112358", "246810", "135790"]

    # 5) 吉利数字
    yield from LUCKY_NUMBERS

    # 6) 年份 4 位
    for y in range(year_from, year_to + 1):
        yield f"{y:04d}"

    # 7) 键盘走位
    yield from KEYBOARD_WALKS

    # 8) 顺序字母，长度 3..10（大小写各一）
    alpha = "abcdefghijklmnopqrstuvwxyz"
    for L in range(3, 11):
        yield alpha[:L]                        # abc ... abcdefghij
    yield "abcdef".upper()
    yield "abcabc"

    # 9) 字母重复：每个字母 × 长度 {3,4,6,8}
    for c in alpha:
        for L in (3, 4, 6, 8):
            yield c * L

    # 10) 高频词（原样 + 首字母大写）
    for w in TOP_WORDS:
        yield w
        yield w.capitalize()

    # 11) 词 + 数字/符号 组合（最贴近真人习惯）
    for w in TOP_WORDS:
        for suf in COMBO_SUFFIXES:
            if suf:
                yield w + suf

    # 12) l33t / 大小写变体
    yield from LEET


def key_library(year_from: int = 1950, year_to: int = 2030) -> Iterator[str]:
    """按命中概率产出关键密码，内部去重。"""
    yield from _dedup(_raw(year_from, year_to))


def estimate_count(year_from: int = 1950, year_to: int = 2030) -> int:
    """粗略计数（用于进度条），略大于真实去重后数量即可。"""
    years = max(0, year_to - year_from + 1)
    n = len(TOP_PINS) + 8 * 3 + 10 * 5 + 21 + len(LUCKY_NUMBERS) + years
    n += len(KEYBOARD_WALKS) + 8 + 2 + 26 * 4
    n += len(TOP_WORDS) * 2 + len(TOP_WORDS) * len(COMBO_SUFFIXES) + len(LEET)
    return n
