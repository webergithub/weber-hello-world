#!/usr/bin/env python3
"""命令行版：破解并解压受密码保护的压缩包（RAR/ZIP/7z）。

用法示例：
    python3 recover.py 我的文件.rar
    python3 recover.py secret.rar --strategy fast
    python3 recover.py secret.rar --wordlist rockyou.txt
    python3 recover.py secret.rar --guess 我常用的密码 另一个猜测
    python3 recover.py secret.zip --digits-max 8 --out ./解压结果
"""
from __future__ import annotations

import argparse
import sys
import time

from recovery import detect
from recovery.candidates import Options
from recovery.job import JobManager


def human(n: float) -> str:
    if n is None:
        return "?"
    if n < 60:
        return f"{n:.0f}秒"
    if n < 3600:
        return f"{n/60:.1f}分"
    if n < 86400:
        return f"{n/3600:.1f}小时"
    return f"{n/86400:.1f}天"


def main() -> int:
    ap = argparse.ArgumentParser(description="压缩包密码恢复（仅用于你自己的文件）")
    ap.add_argument("archive", help="压缩包路径 (.rar/.zip/.7z)")
    ap.add_argument("--strategy", choices=["fast", "standard", "deep", "custom"],
                    default="standard", help="搜索强度（默认 standard；custom=完全按你给的参数）")
    ap.add_argument("--wordlist", help="额外字典文件（如 rockyou.txt）")
    ap.add_argument("--guess", nargs="*", default=[], help="你自己记得的候选密码，优先尝试")
    ap.add_argument("--digits-max", type=int, default=None, help="纯数字穷举最大位数")
    ap.add_argument("--workers", type=int, default=0, help="并行线程数（0=自动，按 CPU 核数）")
    ap.add_argument("--no-dates", action="store_true", help="不尝试生日/日期")
    ap.add_argument("--no-keylib", action="store_true", help="跳过第1级：关键数字字母库")
    ap.add_argument("--no-industry", action="store_true", help="跳过第2级：内置行业常用库")
    ap.add_argument("--no-combos", action="store_true", help="跳过第2级：常见词+数字组合")
    # 第 3 级：暴力生成（范围可控）
    ap.add_argument("--brute-charset", default="none",
                    choices=["none", "digits", "lower", "upper", "alpha",
                             "loweralnum", "alnum", "alnumsym", "custom"],
                    help="暴力字符集（默认 none 不暴力）")
    ap.add_argument("--brute-custom", default="", help="自定义字符集（--brute-charset custom 时用）")
    ap.add_argument("--brute-min", type=int, default=1, help="暴力最小长度")
    ap.add_argument("--brute-max", type=int, default=0, help="暴力最大长度（0=关闭暴力）")
    ap.add_argument("--out", help="解压输出目录（默认 <包名>_unlocked）")
    ap.add_argument("--no-extract", action="store_true", help="只找密码，不自动解压")
    args = ap.parse_args()

    info = detect(args.archive)
    print(f"📦 压缩包类型：{info.kind}"
          + (f" (RAR{info.rar_version})" if info.rar_version else "")
          + f"　{info.note}")
    if info.kind == "unknown":
        print("❌ 无法识别的格式。")
        return 2

    # 显式给了第3级参数时，切到 custom，以免被 fast/standard/deep 预设覆盖
    strategy = args.strategy
    if args.brute_charset != "none" or args.brute_max > 0 or args.digits_max is not None:
        if strategy in ("fast", "standard", "deep"):
            strategy = "custom"

    opts = Options(strategy=strategy, wordlist=args.wordlist,
                   extra_passwords=list(args.guess), include_dates=not args.no_dates,
                   use_key_lib=not args.no_keylib, use_industry=not args.no_industry,
                   wordcombos=not args.no_combos,
                   brute_charset=args.brute_charset, brute_custom=args.brute_custom,
                   brute_minlen=args.brute_min, brute_maxlen=args.brute_max,
                   workers=args.workers)
    if args.digits_max is not None:
        opts.digits_max = args.digits_max

    mgr = JobManager()
    job = mgr.start(args.archive, opts, auto_extract=not args.no_extract)

    # 等 job 起来读到实际线程数
    time.sleep(0.15)
    print(f"🔍 开始尝试……（{job.snapshot().get('workers', 1)} 线程并行，Ctrl+C 取消）\n")
    try:
        while True:
            s = job.snapshot()
            if s["status"] in ("running", "queued"):
                pct = (s["tried"] / s["total"] * 100) if s["total"] else 0
                sys.stdout.write(
                    f"\r已试 {s['tried']:>10,} / 约 {s['total']:>12,}"
                    f"  ({pct:5.1f}%)  {s['rate']:>7.0f}/秒"
                    f"  预计剩余 {human(s['eta']):>8}   "
                )
                sys.stdout.flush()
                time.sleep(0.4)
            elif s["status"] == "extracting":
                sys.stdout.write("\r✅ 已找到密码，正在解压……                              ")
                sys.stdout.flush()
                time.sleep(0.2)
            else:
                break
    except KeyboardInterrupt:
        job.cancel()
        time.sleep(0.5)

    s = job.snapshot()
    print("\n")
    if s["status"] == "found":
        print(f"✅ 密码是：{s['password']}")
        if s["extracted_to"]:
            print(f"📂 已解压到：{s['extracted_to']}（{len(s['extracted_files'])} 个文件）")
            for fpath in s["extracted_files"][:20]:
                print(f"    - {fpath}")
            if len(s["extracted_files"]) > 20:
                print(f"    … 还有 {len(s['extracted_files']) - 20} 个")
        return 0
    if s["status"] == "not_encrypted":
        print("ℹ️  " + s["message"])
        return 0
    if s["status"] == "error":
        print("❌ " + s["message"])
        return 1
    print("😕 " + s["message"])
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
