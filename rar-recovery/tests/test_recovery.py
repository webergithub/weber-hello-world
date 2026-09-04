"""压缩包密码恢复的单元/集成测试。

用极小候选集，秒级完成。缺工具的格式自动跳过。
从仓库根或 rar-recovery 目录运行：
    python3 -m pytest rar-recovery/tests -q      # 若装了 pytest
    python3 rar-recovery/tests/test_recovery.py  # 直接跑（内置 runner）
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from recovery import detect, build_engine, Options
from recovery.engines import NotEncrypted, EngineError
from recovery.candidates import iter_candidates, estimate_total
from recovery.job import JobManager
import tests.make_fixtures as fx  # noqa: E402

PW = fx.PW


def wait(job, timeout=60):
    import time
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = job.snapshot()
        if s["status"] not in ("queued", "running", "extracting"):
            return s
        time.sleep(0.05)
    job.cancel()
    return job.snapshot()


class TestDetect(unittest.TestCase):
    def test_magic_bytes(self):
        d = tempfile.mkdtemp()
        z = fx.make_plain_zip(d)
        if z:
            self.assertEqual(detect(z).kind, "zip")
        # 伪造 RAR5 / RAR4 / 7z 头部
        for magic, ver in [(b"\x52\x61\x72\x21\x1a\x07\x01\x00", 5),
                           (b"\x52\x61\x72\x21\x1a\x07\x00", 4)]:
            p = os.path.join(d, f"fake{ver}.rar")
            with open(p, "wb") as f:
                f.write(magic + b"\x00" * 20)
            info = detect(p)
            self.assertEqual(info.kind, "rar")
            self.assertEqual(info.rar_version, ver)


class TestCandidates(unittest.TestCase):
    def test_order_and_dedup(self):
        opts = Options(strategy="custom", extra_passwords=["myguess", "myguess"],
                       use_key_lib=False, use_industry=False,
                       include_dates=False, digits_max=2, wordcombos=False)
        got = list(iter_candidates(opts))
        self.assertEqual(got[0], "myguess")               # 用户猜测最优先
        self.assertEqual(got.count("myguess"), 1)         # 去重
        self.assertIn("00", got)                          # 2 位数字
        self.assertIn("99", got)

    def test_estimate_positive(self):
        self.assertGreater(estimate_total(Options(strategy="fast")), 1000)

    def test_tier_priority(self):
        # 关键库(第1级) 必须排在 行业库(第2级) 之前
        opts = Options(strategy="custom", use_key_lib=True, use_industry=True,
                       include_dates=False, wordcombos=False, digits_max=0)
        seq = []
        for i, pw in enumerate(iter_candidates(opts)):
            seq.append(pw)
            if i > 5000:
                break
        # keylib 顶部是高频 PIN "1234"；键盘走位也属于第 1 级，应出现在序列里
        self.assertEqual(seq[0], "1234")                  # 第 1 级最前是高频 PIN
        self.assertIn("1qaz2wsx", seq)                    # 键盘走位（第 1 级）确实出现

    def test_mask(self):
        from recovery.candidates import mask_iter, mask_count
        # ?l?d -> 26*10=260，均为 1 小写 + 1 数字
        got = list(mask_iter("?l?d"))
        self.assertEqual(len(got), 260)
        self.assertEqual(mask_count("?l?d"), 260)
        self.assertTrue(all(len(w) == 2 and w[0].islower() and w[1].isdigit() for w in got))
        # 字面 + 占位：ab?d?d -> ab00..ab99
        got2 = list(mask_iter("ab?d?d"))
        self.assertEqual(len(got2), 100)
        self.assertIn("ab00", got2)
        self.assertIn("ab42", got2)
        self.assertIn("ab99", got2)
        # 自定义 ?1
        self.assertEqual(sorted(mask_iter("?1?1", "ab")), ["aa", "ab", "ba", "bb"])
        # 掩码在候选流里紧跟猜测之后
        opts = Options(strategy="custom", extra_passwords=["myguess"], mask="?d?d",
                       use_key_lib=False, use_industry=False, include_dates=False,
                       wordcombos=False, digits_max=0)
        seq = list(iter_candidates(opts))
        self.assertEqual(seq[0], "myguess")
        self.assertEqual(seq[1], "00")
        self.assertIn("99", seq)

    def test_rules_mangle(self):
        from recovery import rules
        full = list(rules.mangle("password", "full"))
        for v in ("Password", "PASSWORD", "password1", "password123", "Password!",
                  "p@ssw0rd", "drowssap", "passwordpassword"):
            self.assertIn(v, full, f"缺变体 {v}")
        # light 更少、且是 full 的子集范围内
        light = list(rules.mangle("password", "light"))
        self.assertLess(len(light), len(full))
        self.assertIn("Password", light)
        self.assertIn("password123", light)
        # 每个变体唯一
        self.assertEqual(len(full), len(set(full)))

    def test_rules_dates_and_personal(self):
        from recovery import rules
        dv = rules.date_variants("19900215")
        for v in ("19900215", "900215", "1990", "0215"):
            self.assertIn(v, dv)
        pc = list(rules.personal_candidates(["zhang", "19900215", "mimi"], "full"))
        for v in ("zhang", "zhang1990", "Zhang0215", "zhangmimi", "mimi1990"):
            self.assertIn(v, pc, f"缺组合 {v}")

    def test_rules_in_stream(self):
        # personal 紧跟猜测；rules 变形出现在流里
        opts = Options(strategy="custom", extra_passwords=["admin"], personal=["zhang", "1990"],
                       rules="full", use_key_lib=False, use_industry=False,
                       include_dates=False, wordcombos=False, digits_max=0)
        seq = list(iter_candidates(opts))
        self.assertEqual(seq[0], "admin")
        self.assertIn("zhang1990", seq)      # 个人组合
        self.assertIn("Admin123", seq)       # admin 的变形
        self.assertIn("@dm1n", seq)          # leet 变形

    def test_brute_scope(self):
        # 暴力范围可控：只要 lower 长度 2..2 -> 恰好 26*26=676 个，且都是 2 位小写
        opts = Options(strategy="custom", use_key_lib=False, use_industry=False,
                       include_dates=False, wordcombos=False, digits_max=0,
                       brute_charset="lower", brute_minlen=2, brute_maxlen=2)
        got = list(iter_candidates(opts))
        self.assertEqual(len(got), 26 * 26)
        self.assertTrue(all(len(w) == 2 and w.isalpha() and w.islower() for w in got))
        self.assertIn("aa", got)
        self.assertIn("zz", got)


class _EngineCase:
    """各格式共用的引擎断言。"""
    def _check_engine(self, path):
        info = detect(path)
        try:
            eng = build_engine(info)
        except EngineError as e:
            self.skipTest(f"缺少工具：{e}")
        # 正确密码 True，错误密码 False（核心：不误报）
        self.assertTrue(eng.test(PW), "正确密码应判为 True")
        self.assertFalse(eng.test("definitely_wrong_" + "z" * 10), "错误密码应判为 False")
        # 自检应通过（加密包）
        eng.self_test()

    def _check_found(self, path):
        opts = Options(strategy="custom", extra_passwords=["nope1", "nope2", PW],
                       include_dates=False, digits_max=0, wordcombos=False)
        job = JobManager().start(path, opts, auto_extract=True)
        s = wait(job)
        self.assertEqual(s["status"], "found")
        self.assertEqual(s["password"], PW)
        self.assertTrue(s["extracted_to"] and os.path.isdir(s["extracted_to"]))
        self.assertGreaterEqual(len(s["extracted_files"]), 1)

    def _check_exhausted(self, path):
        # 候选集不含真实密码 -> 必须报 exhausted，绝不 found（关掉所有内置来源）
        opts = Options(strategy="custom", extra_passwords=["nope1", "nope2", "nope3"],
                       use_key_lib=False, use_industry=False, include_dates=False,
                       wordcombos=False, digits_max=0, brute_charset="none")
        job = JobManager().start(path, opts, auto_extract=False)
        s = wait(job)
        self.assertEqual(s["status"], "exhausted")
        self.assertIsNone(s["password"])


class TestZipCrypto(unittest.TestCase, _EngineCase):
    @classmethod
    def setUpClass(cls):
        cls.d = tempfile.mkdtemp()
        cls.path = fx.make_zipcrypto(cls.d)
        if not cls.path:
            raise unittest.SkipTest("无 zip 命令")

    def test_engine(self): self._check_engine(self.path)
    def test_found(self): self._check_found(self.path)
    def test_exhausted(self): self._check_exhausted(self.path)


class TestAesZip(unittest.TestCase, _EngineCase):
    @classmethod
    def setUpClass(cls):
        cls.d = tempfile.mkdtemp()
        cls.path = fx.make_aes_zip(cls.d)
        if not cls.path:
            raise unittest.SkipTest("无 pyzipper")

    def test_engine(self): self._check_engine(self.path)
    def test_found(self): self._check_found(self.path)
    def test_exhausted(self): self._check_exhausted(self.path)


class TestRar(unittest.TestCase, _EngineCase):
    @classmethod
    def setUpClass(cls):
        cls.d = tempfile.mkdtemp()
        cls.path = fx.make_rar(cls.d)
        if not cls.path:
            raise unittest.SkipTest("无 rar 命令（无法造测试包）")

    def test_engine(self): self._check_engine(self.path)
    def test_found(self): self._check_found(self.path)
    def test_exhausted(self): self._check_exhausted(self.path)


class TestNotEncrypted(unittest.TestCase):
    def test_plain_zip_selftest(self):
        d = tempfile.mkdtemp()
        p = fx.make_plain_zip(d)
        if not p:
            self.skipTest("无 zip 命令")
        self.assertFalse(detect(p).encrypted)
        eng = build_engine(detect(p))
        with self.assertRaises(NotEncrypted):
            eng.self_test()


if __name__ == "__main__":
    unittest.main(verbosity=2)
